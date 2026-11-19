import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse } from '../../http/context.js';
import { encryptField, hmac } from '../../lib/crypto.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { maskBvn } from '../../lib/mask.js';
import { integrations } from '../../integrations/index.js';
import { audit } from '../audit/audit.js';
import { resolveCustomer } from '../facilities/access.js';

const txt = (max = 500) => z.string().trim().max(max);
const profileSchema = z.object({
  tradingName: txt(200).nullable().optional(),
  tin: z.string().trim().regex(/^[0-9]{8}-?[0-9]{4}$/, 'TIN format is 12345678-0001').nullable().optional(),
  businessType: z.enum(['LIMITED_LIABILITY', 'PUBLIC_LIMITED', 'PARTNERSHIP', 'SOLE_PROPRIETORSHIP', 'INCORPORATED_TRUSTEES', 'GOVERNMENT_AGENCY']).nullable().optional(),
  addressLine: txt(300).nullable().optional(),
  city: txt(100).nullable().optional(),
  state: txt(100).nullable().optional(),
  sectorCode: z.string().max(60).nullable().optional(),
  industry: txt(200).nullable().optional(),
  businessDescription: txt(3000).nullable().optional(),
  productsServices: txt(2000).nullable().optional(),
  valueChain: txt(2000).nullable().optional(),
  geographicFootprint: txt(1000).nullable().optional(),
  employeeCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  hasLitigation: z.boolean().nullable().optional(),
  litigationDetails: txt(3000).nullable().optional(),
  hasRegulatoryMatters: z.boolean().nullable().optional(),
  regulatoryDetails: txt(3000).nullable().optional(),
  sectorRiskNotes: txt(2000).nullable().optional(),
}).refine((p) => !(p.hasLitigation && !p.litigationDetails), { message: 'Describe the litigation.', path: ['litigationDetails'] })
  .refine((p) => !(p.hasRegulatoryMatters && !p.regulatoryDetails), { message: 'Describe the regulatory matters.', path: ['regulatoryDetails'] });

const COLS: Record<string, string> = {
  tradingName: 'trading_name', tin: 'tin', businessType: 'business_type', addressLine: 'address_line', city: 'city', state: 'state', sectorCode: 'sector_code',
  industry: 'industry', businessDescription: 'business_description', productsServices: 'products_services', valueChain: 'value_chain', geographicFootprint: 'geographic_footprint',
  employeeCount: 'employee_count', hasLitigation: 'has_litigation', litigationDetails: 'litigation_details', hasRegulatoryMatters: 'has_regulatory_matters', regulatoryDetails: 'regulatory_details', sectorRiskNotes: 'sector_risk_notes',
};

const partySchema = z.object({
  partyType: z.enum(['SHAREHOLDER', 'DIRECTOR', 'PROMOTER', 'PRINCIPAL_OFFICER', 'BOARD_MEMBER', 'KEY_EXECUTIVE']),
  entityKind: z.enum(['INDIVIDUAL', 'CORPORATE']).default('INDIVIDUAL'),
  fullName: z.string().trim().min(2).max(200),
  designation: txt(120).nullable().optional(),
  ownershipPct: z.number().min(0).max(100).nullable().optional(),
  nationality: txt(60).nullable().optional(),
  bvn: z.string().regex(/^[0-9]{11}$/, 'BVN must be 11 digits').optional(),
  isPep: z.boolean().default(false),
  pepDetails: txt(1000).nullable().optional(),
  isInsider: z.boolean().default(false),
  insiderRelationship: txt(500).nullable().optional(),
  yearsExperience: z.number().int().min(0).max(80).nullable().optional(),
}).refine((p) => !(p.isPep && !p.pepDetails), { message: 'Describe the PEP connection.', path: ['pepDetails'] })
  .refine((p) => !(p.isInsider && !p.insiderRelationship), { message: 'Describe the insider relationship.', path: ['insiderRelationship'] });

const bankSchema = z.object({ bankName: z.string().trim().min(2).max(120), accountNumberLast4: z.string().regex(/^[0-9]{4}$/).nullable().optional(), accountType: txt(60).nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).default('NGN'), relationshipSince: z.iso.date().nullable().optional() });
const extFacilitySchema = z.object({ lender: z.string().trim().min(2).max(120), facilityType: z.string().trim().min(2).max(120), currency: z.string().regex(/^[A-Z]{3}$/).default('NGN'), amountMinor: z.number().int().min(0), outstandingMinor: z.number().int().min(0), maturityDate: z.iso.date().nullable().optional(), performing: z.boolean().default(true) });
const counterpartySchema = z.object({ kind: z.enum(['SUPPLIER', 'CUSTOMER']), name: z.string().trim().min(2).max(200), sharePct: z.number().min(0).max(100).nullable().optional(), relationshipYears: z.number().int().min(0).max(100).nullable().optional() });

/** Weighted profile completeness, shown to customers and RMs. */
export async function computeCompleteness(db: Db, customerId: string) {
  const p = await one<any>(db, 'SELECT * FROM business_profile WHERE customer_id=$1', [customerId]);
  const parties = await q<any>(db, 'SELECT party_type FROM business_party WHERE customer_id=$1 AND deleted_at IS NULL', [customerId]);
  const checks: [string, boolean][] = [
    ['Registration details', !!(p.rc_number && p.incorporation_date && p.business_type)],
    ['Tax identification', !!p.tin],
    ['Registered address', !!(p.address_line && p.city && p.state)],
    ['Sector & industry', !!(p.sector_code && p.industry)],
    ['Business description', !!(p.business_description && p.products_services)],
    ['Directors', parties.some((x) => x.party_type === 'DIRECTOR')],
    ['Shareholders', parties.some((x) => x.party_type === 'SHAREHOLDER')],
    ['Management team', parties.some((x) => x.party_type === 'KEY_EXECUTIVE' || x.party_type === 'PRINCIPAL_OFFICER')],
    ['Risk declarations', p.has_litigation !== null && p.has_regulatory_matters !== null],
    ['Value chain', !!p.value_chain],
  ];
  const pct = Math.round((checks.filter((c) => c[1]).length / checks.length) * 100);
  await q(db, 'UPDATE business_profile SET completeness_pct=$2 WHERE customer_id=$1 AND completeness_pct<>$2', [customerId, pct]);
  return { pct, sections: checks.map(([name, done]) => ({ name, done })) };
}

/** Capture an immutable snapshot of the full profile (parties included) at the new version. */
async function snapshot(db: Db, customerId: string, by: { type: string; id: string | null }) {
  const p = await one<any>(db, 'UPDATE business_profile SET version=version+1, updated_by_type=$2, updated_by_id=$3 WHERE customer_id=$1 RETURNING *', [customerId, by.type, by.id]);
  const parties = await q(db, 'SELECT id, party_type, full_name, designation, ownership_pct, bvn_last4, is_pep, is_insider FROM business_party WHERE customer_id=$1 AND deleted_at IS NULL', [customerId]);
  await q(db, 'INSERT INTO business_profile_version(customer_id, version, snapshot, changed_by_type, changed_by_id) VALUES ($1,$2,$3,$4,$5)', [customerId, p.version, JSON.stringify({ profile: p, parties }), by.type, by.id]);
  return p.version;
}

const partyView = (r: any) => ({ id: r.id, partyType: r.party_type, entityKind: r.entity_kind, fullName: r.full_name, designation: r.designation, ownershipPct: r.ownership_pct, nationality: r.nationality, bvn: maskBvn(r.bvn_last4), bvnProvided: !!r.bvn_last4, isPep: r.is_pep, pepDetails: r.pep_details, isInsider: r.is_insider, insiderRelationship: r.insider_relationship, yearsExperience: r.years_experience });

export async function profileView(db: Db, customerId: string) {
  const p = await maybe<any>(db, 'SELECT bp.*, s.name AS sector_name FROM business_profile bp LEFT JOIN sector s ON s.code=bp.sector_code WHERE bp.customer_id=$1', [customerId]);
  if (!p) throw notFound('Business profile');
  const c = await one<any>(db, `SELECT c.*, u.display_name AS rm_name, u.email AS rm_email FROM customer c LEFT JOIN app_user u ON u.id=c.relationship_manager_id WHERE c.id=$1`, [customerId]);
  return {
    customer: { id: c.id, ref: c.customer_ref, name: c.legal_name, category: c.customer_category, relationshipManager: c.rm_name ? { name: c.rm_name, email: c.rm_email } : null, isDemo: c.is_demo },
    profile: {
      registeredName: p.registered_name, rcNumber: p.rc_number, incorporationDate: p.incorporation_date, lockedFromCoreBanking: ['registeredName', 'rcNumber', 'incorporationDate'],
      ...Object.fromEntries(Object.entries(COLS).map(([k, col]) => [k, p[col]])), sectorName: p.sector_name, version: p.version, updatedAt: p.updated_at,
    },
    completeness: await computeCompleteness(db, customerId),
    parties: (await q(db, 'SELECT * FROM business_party WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY party_type, full_name', [customerId])).map(partyView),
    banks: (await q(db, 'SELECT id, bank_name AS "bankName", account_number_last4 AS "accountNumberLast4", account_type AS "accountType", currency, relationship_since AS "relationshipSince" FROM business_bank_relationship WHERE customer_id=$1 AND deleted_at IS NULL', [customerId])),
    externalFacilities: (await q(db, 'SELECT id, lender, facility_type AS "facilityType", currency, amount_minor AS "amountMinor", outstanding_minor AS "outstandingMinor", maturity_date AS "maturityDate", performing FROM business_external_facility WHERE customer_id=$1 AND deleted_at IS NULL', [customerId])),
    counterparties: (await q(db, 'SELECT id, kind, name, share_pct AS "sharePct", relationship_years AS "relationshipYears" FROM business_counterparty WHERE customer_id=$1 AND deleted_at IS NULL', [customerId])),
    alternativeBankAccounts: (await q(db, `SELECT '••••••' || right(account_number,4) AS account, currency, product_name AS product FROM customer_account WHERE customer_id=$1`, [customerId])),
  };
}

export async function profileRoutes(app: FastifyInstance) {
  const db = getPool();
  const idParam = z.object({ customerId: z.string() });

  app.get('/api/customers/:customerId/profile', async (req, reply) => {
    const cid = await resolveCustomer(db, req, parse(idParam, req.params).customerId);
    return ok(reply, await profileView(db, cid));
  });

  app.put('/api/customers/:customerId/profile', async (req, reply) => {
    const cid = await resolveCustomer(db, req, parse(idParam, req.params).customerId, true);
    const body = parse(profileSchema, req.body);
    if (body.sectorCode && !(await maybe(db, 'SELECT 1 FROM sector WHERE code=$1 AND active', [body.sectorCode]))) throw unprocessable('SECTOR', 'Select a valid sector.');
    const actor = actorOf(req);
    await tx(async (c) => {
      const before = await one<any>(c, 'SELECT * FROM business_profile WHERE customer_id=$1 FOR UPDATE', [cid]);
      const sets: string[] = []; const vals: unknown[] = [cid];
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        vals.push(k === 'tin' && v ? String(v).replace(/^(\d{8})(\d{4})$/, '$1-$2') : v);
        sets.push(`${COLS[k]}=$${vals.length}`);
      }
      if (!sets.length) return;
      const after = await one<any>(c, `UPDATE business_profile SET ${sets.join(', ')} WHERE customer_id=$1 RETURNING *`, vals);
      const changed = Object.keys(body).filter((k) => String(before[COLS[k]!]) !== String(after[COLS[k]!]));
      if (!changed.length) return;
      await snapshot(c, cid, { type: actor.type, id: actor.id ?? null });
      await audit(c, actor, { action: 'PROFILE_UPDATED', entityType: 'business_profile', entityId: cid, customerId: cid, before: Object.fromEntries(changed.map((k) => [k, before[COLS[k]!]])), after: Object.fromEntries(changed.map((k) => [k, after[COLS[k]!]])) });
    });
    return ok(reply, await profileView(db, cid));
  });

  // Parties
  app.post('/api/customers/:customerId/parties', async (req, reply) => {
    const cid = await resolveCustomer(db, req, parse(idParam, req.params).customerId, true);
    const b = parse(partySchema, req.body);
    const actor = actorOf(req);
    if (b.bvn) {
      const v = await integrations().identity.verifyBvn(b.bvn, b.fullName);
      if (!v.valid) throw unprocessable('BVN_INVALID', 'The BVN could not be verified. Check the number and try again.');
      if (v.nameMatch === 'MISMATCH') throw unprocessable('BVN_NAME_MISMATCH', 'The name does not match the BVN record.');
    }
    const row = await tx(async (c) => {
      if (b.bvn && (await maybe(c, 'SELECT 1 FROM business_party WHERE customer_id=$1 AND bvn_hash=$2 AND party_type=$3 AND deleted_at IS NULL', [cid, hmac(b.bvn, 'bvn'), b.partyType]))) throw unprocessable('DUPLICATE_PARTY', 'This person is already recorded in this capacity.');
      const r = await one<any>(c, `INSERT INTO business_party(customer_id, party_type, entity_kind, full_name, designation, ownership_pct, nationality, bvn_enc, bvn_hash, bvn_last4, is_pep, pep_details, is_insider, insider_relationship, years_experience)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [cid, b.partyType, b.entityKind, b.fullName, b.designation ?? null, b.ownershipPct ?? null, b.nationality ?? null, b.bvn ? encryptField(b.bvn) : null, b.bvn ? hmac(b.bvn, 'bvn') : null, b.bvn ? b.bvn.slice(-4) : null, b.isPep, b.pepDetails ?? null, b.isInsider, b.insiderRelationship ?? null, b.yearsExperience ?? null]);
      if (b.partyType === 'SHAREHOLDER') {
        const tot = await one<{ s: number }>(c, `SELECT COALESCE(sum(ownership_pct),0) AS s FROM business_party WHERE customer_id=$1 AND party_type='SHAREHOLDER' AND deleted_at IS NULL`, [cid]);
        if (tot.s > 100.0001) throw unprocessable('OWNERSHIP_OVER_100', 'Total shareholding cannot exceed 100%.');
      }
      await snapshot(c, cid, { type: actor.type, id: actor.id ?? null });
      await audit(c, actor, { action: 'PARTY_ADDED', entityType: 'business_party', entityId: r.id, customerId: cid, after: partyView(r) });
      return r;
    });
    return ok(reply, partyView(row), 201);
  });

  app.put('/api/customers/:customerId/parties/:partyId', async (req, reply) => {
    const { customerId, partyId } = parse(z.object({ customerId: z.string(), partyId: z.uuid() }), req.params);
    const cid = await resolveCustomer(db, req, customerId, true);
    const b = parse(partySchema, req.body);
    const actor = actorOf(req);
    const row = await tx(async (c) => {
      const before = await maybe<any>(c, 'SELECT * FROM business_party WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL FOR UPDATE', [partyId, cid]);
      if (!before) throw notFound('Party');
      const r = await one<any>(c, `UPDATE business_party SET party_type=$2, entity_kind=$3, full_name=$4, designation=$5, ownership_pct=$6, nationality=$7, is_pep=$8, pep_details=$9, is_insider=$10, insider_relationship=$11, years_experience=$12,
          bvn_enc=COALESCE($13,bvn_enc), bvn_hash=COALESCE($14,bvn_hash), bvn_last4=COALESCE($15,bvn_last4) WHERE id=$1 RETURNING *`,
        [partyId, b.partyType, b.entityKind, b.fullName, b.designation ?? null, b.ownershipPct ?? null, b.nationality ?? null, b.isPep, b.pepDetails ?? null, b.isInsider, b.insiderRelationship ?? null, b.yearsExperience ?? null, b.bvn ? encryptField(b.bvn) : null, b.bvn ? hmac(b.bvn, 'bvn') : null, b.bvn ? b.bvn.slice(-4) : null]);
      await snapshot(c, cid, { type: actor.type, id: actor.id ?? null });
      await audit(c, actor, { action: 'PARTY_UPDATED', entityType: 'business_party', entityId: partyId, customerId: cid, before: partyView(before), after: partyView(r) });
      return r;
    });
    return ok(reply, partyView(row));
  });

  app.delete('/api/customers/:customerId/parties/:partyId', async (req, reply) => {
    const { customerId, partyId } = parse(z.object({ customerId: z.string(), partyId: z.uuid() }), req.params);
    const cid = await resolveCustomer(db, req, customerId, true);
    const actor = actorOf(req);
    await tx(async (c) => {
      const r = await q(c, 'UPDATE business_party SET deleted_at=now() WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL RETURNING id', [partyId, cid]);
      if (!r.length) throw notFound('Party');
      await snapshot(c, cid, { type: actor.type, id: actor.id ?? null });
      await audit(c, actor, { action: 'PARTY_REMOVED', entityType: 'business_party', entityId: partyId, customerId: cid });
    });
    return ok(reply, { removed: true });
  });

  // Simple sub-collections (bank relationships, external facilities, counterparties)
  const sub = [
    { path: 'banks', table: 'business_bank_relationship', schema: bankSchema, cols: { bankName: 'bank_name', accountNumberLast4: 'account_number_last4', accountType: 'account_type', currency: 'currency', relationshipSince: 'relationship_since' } },
    { path: 'external-facilities', table: 'business_external_facility', schema: extFacilitySchema, cols: { lender: 'lender', facilityType: 'facility_type', currency: 'currency', amountMinor: 'amount_minor', outstandingMinor: 'outstanding_minor', maturityDate: 'maturity_date', performing: 'performing' } },
    { path: 'counterparties', table: 'business_counterparty', schema: counterpartySchema, cols: { kind: 'kind', name: 'name', sharePct: 'share_pct', relationshipYears: 'relationship_years' } },
  ] as const;
  for (const s of sub) {
    app.post(`/api/customers/:customerId/${s.path}`, async (req, reply) => {
      const cid = await resolveCustomer(db, req, parse(idParam, req.params).customerId, true);
      const b = parse(s.schema as z.ZodTypeAny, req.body) as Record<string, unknown>;
      const keys = Object.keys(s.cols) as (keyof typeof s.cols)[];
      const r = await tx(async (c) => {
        const row = await one<any>(c, `INSERT INTO ${s.table}(customer_id, ${keys.map((k) => s.cols[k]).join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`, [cid, ...keys.map((k) => b[k] ?? null)]);
        await audit(c, actorOf(req), { action: 'PROFILE_ITEM_ADDED', entityType: s.table, entityId: row.id, customerId: cid, after: b });
        return row;
      });
      return ok(reply, { id: r.id }, 201);
    });
    app.delete(`/api/customers/:customerId/${s.path}/:itemId`, async (req, reply) => {
      const { customerId, itemId } = parse(z.object({ customerId: z.string(), itemId: z.uuid() }), req.params);
      const cid = await resolveCustomer(db, req, customerId, true);
      const r = await q(db, `UPDATE ${s.table} SET deleted_at=now() WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL RETURNING id`, [itemId, cid]);
      if (!r.length) throw notFound('Record');
      await audit(db, actorOf(req), { action: 'PROFILE_ITEM_REMOVED', entityType: s.table, entityId: itemId, customerId: cid });
      return ok(reply, { removed: true });
    });
  }

  app.get('/api/reference/sectors', async (_req, reply) => ok(reply, await q(db, `SELECT code, name FROM sector WHERE active AND code NOT LIKE 'EXCLUDED_%' ORDER BY name`)));
}
