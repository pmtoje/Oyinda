/**
 * Promoter identity verification (Credit360 prompt §13).
 *
 * A controlled subsystem, not two text fields:
 *  - consent is recorded before any provider call;
 *  - BVN and NIN are checked server-side through the configured providers (sandbox in non-production, never
 *    presented as a live check), retrieving only name and date of birth;
 *  - results are compared with what the customer gave, with each other, and with the Bank's own record;
 *  - every check is a row with an explicit state, source, provider reference and timestamp;
 *  - a discrepancy is never overridden silently: it needs an authorised reviewer and a second, different approver;
 *  - identifiers are never returned, logged or put in URLs: only the last four digits are shown.
 */
import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { decryptField, encryptField, hmac } from '../../lib/crypto.js';
import { conflict, notFound, tooMany, unprocessable } from '../../lib/errors.js';
import { integrations } from '../../integrations/index.js';
import { IntegrationError, type IdentityRecord } from '../../integrations/types.js';
import { audit, type Actor } from '../audit/audit.js';
import { getActive } from '../config/service.js';

export type IdentityState = 'NOT_STARTED' | 'IN_PROGRESS' | 'VERIFIED' | 'DISCREPANCY' | 'REVIEW_REQUIRED' | 'PROVIDER_UNAVAILABLE' | 'UNSUCCESSFUL';
type Kind = 'BVN' | 'NIN';
type AttrResult = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'NOT_AVAILABLE';
export interface Check { attribute: 'fullName' | 'dateOfBirth'; against: 'PROVIDED' | 'BVN_RECORD' | 'BANK_RECORD'; result: AttrResult }

export interface IdentityPolicy {
  requiredPartyTypes: string[]; shareholderMinOwnershipPct: number; requireBvn: boolean; requireNin: boolean;
  acceptPartialNameWhenDobMatches: boolean; compareWithBankRecord: boolean; blockSubmissionUntilVerified: boolean;
  maxChecksPerPartyPerDay: number; reuseVerifiedWithinDays: number; consentWordingVersion: string; consentText: string;
}

export async function identityPolicy(db: Db): Promise<IdentityPolicy> {
  const row = await getActive(db, 'identity_policy', 'STANDARD');
  if (!row) throw conflict('CONFIG_MISSING', 'No approved identity verification policy. An administrator must configure it.');
  return row.payload as IdentityPolicy;
}

// ---------------------------------------------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------------------------------------------
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'chief', 'alhaji', 'alhaja', 'hon', 'engr', 'sir', 'mallam', 'barr', 'pastor', 'otunba']);
export function nameTokens(name: string): string[] {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter((t) => t && !TITLES.has(t));
}
/** MATCH: same names in any order. PARTIAL: one name set (≥ 2 names) contained in the other, e.g. a missing middle name. */
export function compareNames(a: string, b: string): AttrResult {
  const x = [...new Set(nameTokens(a))], y = [...new Set(nameTokens(b))];
  if (!x.length || !y.length) return 'NOT_AVAILABLE';
  const [small, large] = x.length <= y.length ? [x, y] : [y, x];
  const contained = small.every((t) => large.includes(t));
  if (contained && small.length === large.length) return 'MATCH';
  if (contained && small.length >= 2) return 'PARTIAL';
  return 'MISMATCH';
}
export function compareDates(a?: string | null, b?: string | null): AttrResult {
  if (!a || !b) return 'NOT_AVAILABLE';
  return a.slice(0, 10) === b.slice(0, 10) ? 'MATCH' : 'MISMATCH';
}
/** Outcome of one identifier's checks under the policy. */
export function outcomeOf(checks: Check[], policy: Pick<IdentityPolicy, 'acceptPartialNameWhenDobMatches'>): IdentityState {
  if (checks.some((c) => c.result === 'MISMATCH')) return 'DISCREPANCY';
  const provided = checks.filter((c) => c.against === 'PROVIDED');
  const name = provided.find((c) => c.attribute === 'fullName')?.result;
  const dob = provided.find((c) => c.attribute === 'dateOfBirth')?.result;
  if (dob !== 'MATCH') return 'REVIEW_REQUIRED'; // the provider did not return a date of birth to compare
  if (name === 'MATCH') return checks.some((c) => c.result === 'PARTIAL') && !policy.acceptPartialNameWhenDobMatches ? 'DISCREPANCY' : 'VERIFIED';
  if (name === 'PARTIAL') return policy.acceptPartialNameWhenDobMatches ? 'VERIFIED' : 'DISCREPANCY';
  return 'REVIEW_REQUIRED';
}

const subjectHash = (name: string, dob: string | null) => hmac(`${nameTokens(name).sort().join(' ')}|${dob ?? ''}`, 'identity-subject');
const isoDate = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const validId = (v: string) => /^[0-9]{11}$/.test(v) && !/^(\d)\1{10}$/.test(v);

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------
export function isRequired(p: any, policy: IdentityPolicy): boolean {
  if (p.entity_kind !== 'INDIVIDUAL' || !policy.requiredPartyTypes.includes(p.party_type)) return false;
  if (p.party_type === 'SHAREHOLDER') return Number(p.ownership_pct ?? 0) >= policy.shareholderMinOwnershipPct;
  return true;
}

const PRIORITY: IdentityState[] = ['REVIEW_REQUIRED', 'DISCREPANCY', 'UNSUCCESSFUL', 'PROVIDER_UNAVAILABLE', 'IN_PROGRESS', 'NOT_STARTED', 'VERIFIED'];

/** Current identity state of one person, considering stale results (details changed since the check). */
export async function partyIdentity(db: Db, p: any, policy: IdentityPolicy) {
  const kinds: Kind[] = [...(policy.requireBvn ? ['BVN' as const] : []), ...(policy.requireNin ? ['NIN' as const] : [])];
  const subject = subjectHash(p.full_name, isoDate(p.date_of_birth));
  const rows = await q<any>(db, `SELECT DISTINCT ON (kind) * FROM identity_verification WHERE party_id=$1 ORDER BY kind, created_at DESC`, [p.id]);
  const review = await maybe<any>(db, `SELECT * FROM identity_review WHERE party_id=$1 ORDER BY created_at DESC LIMIT 1`, [p.id]);
  const perKind = kinds.map((k) => {
    const r = rows.find((x) => x.kind === k);
    const currentHash = k === 'BVN' ? p.bvn_hash : p.nin_hash;
    const stale = !!r && (r.subject_hash !== subject || (currentHash && r.identifier_hash !== currentHash));
    const state: IdentityState = !r || stale ? 'NOT_STARTED' : r.status;
    return { kind: k, state, stale, row: r && !stale ? r : null };
  });
  let state = PRIORITY.find((s) => perKind.some((x) => x.state === s)) ?? 'VERIFIED';
  const latestCheck = Math.max(0, ...perKind.map((x) => (x.row ? new Date(x.row.created_at).getTime() : 0)));
  const reviewCurrent = review && new Date(review.created_at).getTime() >= latestCheck && perKind.every((x) => !x.stale);
  if (reviewCurrent && ['OPEN', 'PROPOSED', 'ESCALATED'].includes(review.status)) state = 'REVIEW_REQUIRED';
  else if (reviewCurrent && review.status === 'CLEARED' && perKind.every((x) => x.row)) state = 'VERIFIED';
  else if (reviewCurrent && review.status === 'REJECTED') state = 'UNSUCCESSFUL';
  return { state, perKind, review: reviewCurrent ? review : null };
}

/** Customer-safe view: no identifiers beyond last four digits, no provider attributes. */
export async function identityOverview(db: Db, customerId: string) {
  const policy = await identityPolicy(db);
  const parties = await q<any>(db, `SELECT * FROM business_party WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY created_at`, [customerId]);
  const people = [];
  for (const p of parties) {
    if (p.entity_kind !== 'INDIVIDUAL') continue;
    const required = isRequired(p, policy);
    const s = await partyIdentity(db, p, policy);
    people.push({
      partyId: p.id, name: p.full_name, partyType: p.party_type, ownershipPct: p.ownership_pct, required,
      state: s.state, dateOfBirthProvided: !!p.date_of_birth, bvnLast4: p.bvn_last4, ninLast4: p.nin_last4,
      checks: s.perKind.map((x) => ({ kind: x.kind, state: x.state, stale: x.stale, source: x.row?.provider_mode ?? null, method: x.row?.method ?? null, checkedAt: x.row?.completed_at ?? null, results: x.row?.checks ?? [], bankRecord: x.row?.bank_record ?? null })),
      review: s.review ? { status: s.review.status, requestedAt: s.review.created_at, decidedAt: s.review.decided_at } : null,
      canRequestReview: (s.state === 'DISCREPANCY') && !s.review,
    });
  }
  const required = people.filter((x) => x.required);
  return {
    policy: { requireBvn: policy.requireBvn, requireNin: policy.requireNin, blockSubmission: policy.blockSubmissionUntilVerified, consentText: policy.consentText, consentVersion: policy.consentWordingVersion, shareholderMinOwnershipPct: policy.shareholderMinOwnershipPct, requiredPartyTypes: policy.requiredPartyTypes },
    people,
    requiredCount: required.length,
    verifiedCount: required.filter((x) => x.state === 'VERIFIED').length,
    allVerified: required.length > 0 && required.every((x) => x.state === 'VERIFIED'),
  };
}

/** Submission gate issues for a customer (empty when all required promoters are verified or policy does not block). */
export async function identityIssues(db: Db, customerId: string) {
  const policy = await identityPolicy(db);
  if (!policy.blockSubmissionUntilVerified) return [];
  const o = await identityOverview(db, customerId);
  if (!o.requiredCount) return [{ step: 'IDENTITY', field: 'identity', message: 'Add the business’s directors and promoters to your business profile so their identity can be verified.' }];
  return o.people.filter((x) => x.required && x.state !== 'VERIFIED').map((x) => ({ step: 'IDENTITY', field: 'identity', message: `Verify the identity of ${x.name}.` }));
}

// ---------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new IntegrationError('Identity', 'provider timed out')), ms); })]); }
  finally { clearTimeout(t); }
}

export async function verifyParty(db: Db, actor: Actor, customerId: string, partyId: string, input: { bvn?: string; nin?: string; dateOfBirth: string; consent: true }) {
  const policy = await identityPolicy(db);
  const p = await maybe<any>(db, `SELECT * FROM business_party WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL`, [partyId, customerId]);
  if (!p) throw notFound('Person');
  if (p.entity_kind !== 'INDIVIDUAL') throw unprocessable('NOT_AN_INDIVIDUAL', 'Identity verification applies to individuals, not companies.');
  if (input.bvn && !validId(input.bvn)) throw unprocessable('BVN_INVALID', 'Enter the 11-digit BVN.');
  if (input.nin && !validId(input.nin)) throw unprocessable('NIN_INVALID', 'Enter the 11-digit NIN.');
  const today = new Date().toISOString().slice(0, 10);
  if (input.dateOfBirth >= today || input.dateOfBirth < '1900-01-01') throw unprocessable('DOB_INVALID', 'Enter a valid date of birth.');
  const recent = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM identity_verification WHERE party_id=$1 AND method='PROVIDER' AND created_at > now() - interval '24 hours'`, [partyId]);
  if (recent.n >= policy.maxChecksPerPartyPerDay) throw tooMany('This person has reached the limit of identity checks for today. Try again tomorrow, or ask the Bank to review.');

  const bvn = input.bvn ?? (p.bvn_enc ? decryptField(p.bvn_enc) : undefined);
  if (policy.requireBvn && !bvn) throw unprocessable('BVN_REQUIRED', 'Enter the BVN.');
  const prevNin = await maybe<any>(db, `SELECT * FROM identity_verification WHERE party_id=$1 AND kind='NIN' ORDER BY created_at DESC LIMIT 1`, [partyId]);
  if (policy.requireNin && !input.nin && !prevNin) throw unprocessable('NIN_REQUIRED', 'Enter the NIN.');

  // Duplicate prevention: the same identifier verified for a different person in this business
  for (const [kind, value] of [['BVN', bvn], ['NIN', input.nin]] as const) {
    if (!value) continue;
    const clash = await maybe<any>(db, `SELECT bp.full_name FROM identity_verification v JOIN business_party bp ON bp.id=v.party_id
      WHERE v.customer_id=$1 AND v.kind=$2 AND v.identifier_hash=$3 AND v.status='VERIFIED' AND v.party_id<>$4 AND bp.deleted_at IS NULL LIMIT 1`, [customerId, kind, hmac(value, kind.toLowerCase()), partyId]);
    if (clash && compareNames(clash.full_name, p.full_name) === 'MISMATCH') throw conflict('IDENTIFIER_IN_USE', `This ${kind} is already verified for another person in this business.`);
  }

  const consent = await one<any>(db, `INSERT INTO identity_consent(customer_id, party_id, given_by_type, given_by_id, wording_version) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [customerId, partyId, actor.type === 'STAFF' ? 'STAFF' : 'CUSTOMER', actor.id, policy.consentWordingVersion]);
  await audit(db, actor, { action: 'IDENTITY_CONSENT_GIVEN', entityType: 'business_party', entityId: partyId, customerId, metadata: { wordingVersion: policy.consentWordingVersion } });

  const updated = await one<any>(db, `UPDATE business_party SET date_of_birth=$2,
      bvn_enc=COALESCE($3,bvn_enc), bvn_hash=COALESCE($4,bvn_hash), bvn_last4=COALESCE($5,bvn_last4),
      nin_hash=COALESCE($6,nin_hash), nin_last4=COALESCE($7,nin_last4) WHERE id=$1 RETURNING *`,
    [partyId, input.dateOfBirth, input.bvn ? encryptField(input.bvn) : null, input.bvn ? hmac(input.bvn, 'bvn') : null, input.bvn ? input.bvn.slice(-4) : null,
      input.nin ? hmac(input.nin, 'nin') : null, input.nin ? input.nin.slice(-4) : null]);

  const provided = { fullName: updated.full_name as string, dateOfBirth: input.dateOfBirth };
  const subject = subjectHash(provided.fullName, provided.dateOfBirth);
  let bvnRecord: IdentityRecord | undefined;
  const run = async (kind: Kind, value: string) => {
    const idHash = hmac(value, kind.toLowerCase());
    // Reuse: the same identifier already verified for this same person within the reuse window
    const reusable = policy.reuseVerifiedWithinDays > 0 ? await maybe<any>(db, `SELECT * FROM identity_verification WHERE customer_id=$1 AND kind=$2 AND identifier_hash=$3 AND status='VERIFIED' AND method<>'REUSED'
        AND subject_hash=$4 AND completed_at > now() - make_interval(days => $5) ORDER BY completed_at DESC LIMIT 1`, [customerId, kind, idHash, subject, policy.reuseVerifiedWithinDays]) : null;
    if (reusable) {
      if (kind === 'BVN' && reusable.record_enc) bvnRecord = JSON.parse(decryptField(reusable.record_enc));
      await q(db, `INSERT INTO identity_verification(customer_id, party_id, kind, status, method, provider, provider_mode, provider_ref, identifier_hash, identifier_last4, subject_hash, checks, bank_record, record_enc, consent_id, requested_by_type, requested_by_id, completed_at)
        VALUES ($1,$2,$3,'VERIFIED','REUSED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
        [customerId, partyId, kind, reusable.provider, reusable.provider_mode, reusable.provider_ref, idHash, value.slice(-4), subject, JSON.stringify(reusable.checks), reusable.bank_record, reusable.record_enc, consent.id, actor.type, actor.id ?? null]);
      return 'VERIFIED' as IdentityState;
    }
    const ad = integrations().identity;
    const row = await one<any>(db, `INSERT INTO identity_verification(customer_id, party_id, kind, status, provider, provider_mode, identifier_hash, identifier_last4, subject_hash, consent_id, requested_by_type, requested_by_id)
      VALUES ($1,$2,$3,'IN_PROGRESS',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [customerId, partyId, kind, ad.provider, ad.mode === 'MOCK' ? 'SANDBOX' : 'LIVE', idHash, value.slice(-4), subject, consent.id, actor.type, actor.id ?? null]);
    let status: IdentityState; let checks: Check[] = []; let bank: string = 'NOT_CHECKED'; let record: IdentityRecord | undefined; let providerRef: string | null = null; let error: string | null = null;
    try {
      const r = await withTimeout(kind === 'BVN' ? ad.lookupBvn(value) : ad.lookupNin(value), 10_000);
      providerRef = r.providerRef;
      if (!r.found || !r.record) { status = 'UNSUCCESSFUL'; error = 'NOT_FOUND'; }
      else {
        record = r.record;
        checks.push({ attribute: 'fullName', against: 'PROVIDED', result: compareNames(record.fullName, provided.fullName) });
        checks.push({ attribute: 'dateOfBirth', against: 'PROVIDED', result: compareDates(record.dateOfBirth, provided.dateOfBirth) });
        if (kind === 'NIN' && bvnRecord) {
          checks.push({ attribute: 'fullName', against: 'BVN_RECORD', result: compareNames(record.fullName, bvnRecord.fullName) });
          checks.push({ attribute: 'dateOfBirth', against: 'BVN_RECORD', result: compareDates(record.dateOfBirth, bvnRecord.dateOfBirth) });
        }
        if (kind === 'BVN') {
          bvnRecord = record;
          if (policy.compareWithBankRecord) {
            const bankPerson = await withTimeout(integrations().cba.findPersonByBvn(value), 10_000).catch(() => undefined);
            if (bankPerson === undefined) bank = 'NOT_CHECKED';
            else if (!bankPerson) bank = 'NO_RECORD';
            else {
              const bc: Check[] = [{ attribute: 'fullName', against: 'BANK_RECORD', result: compareNames(bankPerson.fullName, record.fullName) }, { attribute: 'dateOfBirth', against: 'BANK_RECORD', result: compareDates(bankPerson.dateOfBirth, record.dateOfBirth) }];
              checks = checks.concat(bc);
              bank = bc.some((c) => c.result === 'MISMATCH') ? 'MISMATCH' : 'MATCH';
            }
          }
        }
        status = outcomeOf(checks, policy);
      }
    } catch (e) {
      status = 'PROVIDER_UNAVAILABLE'; error = e instanceof IntegrationError && !e.retryable ? 'NOT_PROVISIONED' : 'UNAVAILABLE';
    }
    await q(db, `UPDATE identity_verification SET status=$2, provider_ref=$3, checks=$4, bank_record=$5, record_enc=$6, error_code=$7, completed_at=now() WHERE id=$1`,
      [row.id, status, providerRef, JSON.stringify(checks), bank, record ? encryptField(JSON.stringify(record)) : null, error]);
    await audit(db, actor, { action: 'IDENTITY_CHECK_COMPLETED', entityType: 'identity_verification', entityId: row.id, customerId, outcome: status === 'VERIFIED' ? 'SUCCESS' : 'FAILURE',
      metadata: { partyId, kind, status, providerMode: ad.mode === 'MOCK' ? 'SANDBOX' : 'LIVE', bankRecord: bank } });
    if (status === 'REVIEW_REQUIRED') await openReview(db, actor, customerId, partyId, null, true);
    return status;
  };
  if (bvn) await run('BVN', bvn);
  if (input.nin) await run('NIN', input.nin);
  const fresh = await one<any>(db, `SELECT * FROM business_party WHERE id=$1`, [partyId]);
  return partyIdentity(db, fresh, policy);
}

// ---------------------------------------------------------------------------------------------------------------
// Review (maker-checker)
// ---------------------------------------------------------------------------------------------------------------
export async function openReview(db: Db, actor: Actor, customerId: string, partyId: string, note: string | null, automatic = false) {
  const policy = await identityPolicy(db);
  const p = await maybe<any>(db, `SELECT * FROM business_party WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL`, [partyId, customerId]);
  if (!p) throw notFound('Person');
  const s = await partyIdentity(db, p, policy);
  if (!automatic && s.state !== 'DISCREPANCY') throw conflict('NOTHING_TO_REVIEW', 'A review can be requested only when a difference was found.');
  if (s.review && ['OPEN', 'PROPOSED', 'ESCALATED'].includes(s.review.status)) return s.review;
  const ids = s.perKind.filter((x) => x.row).map((x) => x.row.id);
  const r = await one<any>(db, `INSERT INTO identity_review(customer_id, party_id, verification_ids, customer_note) VALUES ($1,$2,$3,$4) RETURNING *`, [customerId, partyId, ids, note]);
  await audit(db, actor, { action: 'IDENTITY_REVIEW_OPENED', entityType: 'identity_review', entityId: r.id, customerId, metadata: { partyId, automatic } });
  return r;
}

const mask = (last4: string | null) => (last4 ? `•••••••${last4}` : null);

export async function reviewDetail(db: Db, id: string) {
  const r = await maybe<any>(db, `SELECT r.*, c.legal_name, bp.full_name, bp.party_type, bp.ownership_pct, bp.date_of_birth, bp.bvn_last4, bp.nin_last4,
      pu.display_name AS proposed_by_name, du.display_name AS decided_by_name
    FROM identity_review r JOIN customer c ON c.id=r.customer_id JOIN business_party bp ON bp.id=r.party_id
    LEFT JOIN app_user pu ON pu.id=r.proposed_by LEFT JOIN app_user du ON du.id=r.decided_by WHERE r.id=$1`, [id]);
  if (!r) throw notFound('Review');
  const checks = await q<any>(db, `SELECT id, kind, status, method, provider, provider_mode, provider_ref, identifier_last4, checks, bank_record, error_code, created_at, completed_at
    FROM identity_verification WHERE id = ANY($1) ORDER BY kind`, [r.verification_ids]);
  return {
    id: r.id, status: r.status, customer: { id: r.customer_id, name: r.legal_name },
    person: { partyId: r.party_id, name: r.full_name, partyType: r.party_type, ownershipPct: r.ownership_pct, dateOfBirthProvided: isoDate(r.date_of_birth), bvn: mask(r.bvn_last4), nin: mask(r.nin_last4) },
    customerNote: r.customer_note,
    checks: checks.map((c) => ({ id: c.id, kind: c.kind, status: c.status, method: c.method, provider: c.provider, source: c.provider_mode, providerRef: c.provider_ref, identifier: mask(c.identifier_last4), results: c.checks, bankRecord: c.bank_record, error: c.error_code, checkedAt: c.completed_at })),
    proposal: r.proposal ? { decision: r.proposal, reason: r.proposal_reason, by: r.proposed_by_name, byId: r.proposed_by, at: r.proposed_at } : null,
    decision: r.decided_at ? { reason: r.decision_reason, by: r.decided_by_name, at: r.decided_at } : null,
    createdAt: r.created_at,
  };
}

/** Reveals the provider's name and date of birth to an authorised reviewer. Every viewing is audited. */
export async function revealRecords(db: Db, actor: Actor, id: string) {
  const r = await maybe<any>(db, 'SELECT * FROM identity_review WHERE id=$1', [id]);
  if (!r) throw notFound('Review');
  const rows = await q<any>(db, 'SELECT id, kind, record_enc FROM identity_verification WHERE id = ANY($1)', [r.verification_ids]);
  await audit(db, actor, { action: 'IDENTITY_RECORD_VIEWED', entityType: 'identity_review', entityId: id, customerId: r.customer_id, metadata: { verificationIds: rows.map((x) => x.id) } });
  return rows.map((x) => ({ kind: x.kind, record: x.record_enc ? JSON.parse(decryptField(x.record_enc)) as IdentityRecord : null }));
}

export async function proposeReview(db: Db, actor: Actor, id: string, proposal: 'CLEAR' | 'REJECT' | 'ESCALATE', reason: string) {
  const r = await maybe<any>(db, 'SELECT * FROM identity_review WHERE id=$1 FOR UPDATE', [id]);
  if (!r) throw notFound('Review');
  if (!['OPEN', 'ESCALATED'].includes(r.status)) throw conflict('REVIEW_NOT_OPEN', 'This review is not awaiting a proposal.');
  await q(db, `UPDATE identity_review SET status='PROPOSED', proposal=$2, proposal_reason=$3, proposed_by=$4, proposed_at=now() WHERE id=$1`, [id, proposal, reason, actor.id]);
  await audit(db, actor, { action: 'IDENTITY_REVIEW_PROPOSED', entityType: 'identity_review', entityId: id, customerId: r.customer_id, metadata: { proposal } });
}

export async function decideReview(db: Db, actor: Actor, id: string, decision: 'APPROVE' | 'RETURN', reason: string) {
  const r = await maybe<any>(db, 'SELECT * FROM identity_review WHERE id=$1 FOR UPDATE', [id]);
  if (!r) throw notFound('Review');
  if (r.status !== 'PROPOSED') throw conflict('REVIEW_NOT_PROPOSED', 'There is no proposal to decide.');
  if (r.proposed_by === actor.id) throw conflict('SAME_PERSON', 'A second reviewer must decide; you made the proposal.');
  if (decision === 'RETURN') {
    await q(db, `UPDATE identity_review SET status='OPEN', proposal=NULL, proposal_reason=NULL, proposed_by=NULL, proposed_at=NULL, decision_reason=$2 WHERE id=$1`, [id, reason]);
  } else if (r.proposal === 'ESCALATE') {
    // Escalation agreed: the case goes back for a fresh proposal by a senior reviewer (no final decision yet).
    await q(db, `UPDATE identity_review SET status='ESCALATED', proposal=NULL, proposal_reason=NULL, proposed_by=NULL, proposed_at=NULL, decision_reason=$2 WHERE id=$1`, [id, reason]);
  } else {
    const status = r.proposal === 'CLEAR' ? 'CLEARED' : 'REJECTED';
    await q(db, `UPDATE identity_review SET status=$2, decided_by=$3, decision_reason=$4, decided_at=now() WHERE id=$1`, [id, status, actor.id, reason]);
  }
  await audit(db, actor, { action: 'IDENTITY_REVIEW_DECIDED', entityType: 'identity_review', entityId: id, customerId: r.customer_id, metadata: { decision, proposal: r.proposal } });
}
