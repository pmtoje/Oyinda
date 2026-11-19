import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { formatMoney } from '../../lib/money.js';
import { maskAccount } from '../../lib/mask.js';
import { integrations } from '../../integrations/index.js';
import { IntegrationError } from '../../integrations/types.js';
import { audit, SYSTEM } from '../audit/audit.js';
import { getById } from '../config/service.js';
import { loadFacility } from '../facilities/access.js';
import { emit } from '../notifications/service.js';
import { setFacilityStatus } from '../workflow/engine.js';
import { addMonths, buildSchedule } from './schedule.js';

export async function activateFacility(db: Db, actor: any, facilityId: string) {
  const f = await one<any>(db, 'SELECT f.*, c.cba_customer_id FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1 FOR UPDATE OF f', [facilityId]);
  if (f.status !== 'READY_FOR_ACTIVATION') throw conflict('NOT_READY', 'The facility is not ready for activation. Documentation must be completed first.');
  const terms = await one<any>(db, 'SELECT * FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1', [facilityId]);
  // Backend enforcement: no activation while any mandatory condition precedent is open.
  const open = await q<any>(db, `SELECT description FROM condition_item WHERE terms_id=$1 AND mandatory AND category='PRECEDENT' AND status='PENDING'`, [terms.id]);
  if (open.length) throw unprocessable('CONDITIONS_OUTSTANDING', 'Mandatory conditions precedent are outstanding.', open.map((o) => o.description));
  const accepted = await maybe(db, `SELECT 1 FROM offer_letter WHERE facility_id=$1 AND terms_id=$2 AND status='ACCEPTED'`, [facilityId, terms.id]);
  if (!accepted) throw conflict('NOT_ACCEPTED', 'The current terms have not been accepted by the customer.');
  const product = await getById<any>(db, f.product_config_id);
  let booking;
  try { booking = await integrations().cba.bookFacility({ idempotencyKey: `book:${facilityId}:${terms.id}`, cbaCustomerId: f.cba_customer_id, product: f.product_code, amountMinor: terms.amount_minor, currency: terms.currency, tenorMonths: terms.tenor_months, profitRatePct: Number(terms.profit_rate_pct) }); }
  catch (e) { throw unprocessable('CBA_UNAVAILABLE', e instanceof IntegrationError ? 'Core banking is unavailable; the facility was not booked. Retry later.' : 'Booking failed.'); }
  const start = new Date().toISOString().slice(0, 10);
  const sched = buildSchedule({ principalMinor: terms.amount_minor, profitRatePct: Number(terms.profit_rate_pct), tenorMonths: terms.tenor_months, frequency: terms.payment_frequency, startDate: start, moratoriumMonths: terms.moratorium_months, pricingBasis: product.payload.pricingBasis });
  const acct = await one<any>(db, `INSERT INTO facility_account(facility_id, terms_id, cba_reference, cba_mode, currency, approved_minor, profit_rate_pct, tenor_months, start_date, maturity_date, next_review_date, activated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [facilityId, terms.id, booking.reference, integrations().cba.mode, terms.currency, terms.amount_minor, terms.profit_rate_pct, terms.tenor_months, start, sched.maturityDate, addMonths(start, 12), actor.id]);
  if (product.payload.category !== 'CONTINGENT') for (const it of sched.items) await q(db, 'INSERT INTO payment_schedule_item(account_id, seq, due_date, principal_minor, profit_minor, total_minor) VALUES ($1,$2,$3,$4,$5,$6)', [acct.id, it.seq, it.dueDate, it.principalMinor, it.profitMinor, it.totalMinor]);
  for (const cov of await q<any>(db, `SELECT * FROM condition_item WHERE terms_id=$1 AND category='COVENANT' AND next_due_date IS NULL`, [terms.id])) {
    await q(db, 'UPDATE condition_item SET next_due_date=$2 WHERE id=$1', [cov.id, addMonths(start, cov.frequency === 'QUARTERLY' ? 3 : cov.frequency === 'MONTHLY' ? 1 : 12)]);
  }
  await setFacilityStatus(db, facilityId, 'ACTIVE', actor, { customerNote: 'Facility active' });
  await audit(db, actor, { action: 'FACILITY_ACTIVATED', entityType: 'facility_account', entityId: acct.id, facilityId, metadata: { cbaReference: booking.reference, cbaMode: integrations().cba.mode, maturity: sched.maturityDate, totalProfitMinor: sched.totalProfit } });
  await emit(db, 'FACILITY_ACTIVATED', { facilityId });
  return acct;
}

/** Daily monitoring sweep: overdue payments, maturity, reviews, covenants, security expiry, financials refresh. */
export async function monitoringSweep(db: Db, today = new Date().toISOString().slice(0, 10)) {
  let created = 0;
  const add = async (facilityId: string, accountId: string | null, kind: string, refId: string | null, due: string, severity: string, detail: string) => {
    const r = await q(db, `INSERT INTO monitoring_item(facility_id, account_id, kind, ref_id, due_date, severity, detail) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`, [facilityId, accountId, kind, refId, due, severity, detail]);
    if (r.length) { created++; await emit(db, 'MONITORING_ALERT', { facilityId, vars: { detail } }); }
  };
  await q(db, `UPDATE payment_schedule_item SET status='OVERDUE' WHERE due_date < $1 AND status IN ('DUE','PARTIAL')`, [today]);
  for (const s of await q<any>(db, `SELECT s.*, a.facility_id, a.currency FROM payment_schedule_item s JOIN facility_account a ON a.id=s.account_id WHERE s.status='OVERDUE'`)) {
    await add(s.facility_id, s.account_id, 'PAYMENT_OVERDUE', s.id, s.due_date, 'CRITICAL', `Instalment ${s.seq} of ${formatMoney(s.total_minor - s.paid_minor, s.currency)} was due on ${s.due_date}.`);
  }
  for (const a of await q<any>(db, `SELECT * FROM facility_account WHERE status IN ('ACTIVE','WATCHLIST')`)) {
    const days = (d: string) => (new Date(d).getTime() - new Date(today).getTime()) / 86400_000;
    if (days(a.maturity_date) <= 60) await add(a.facility_id, a.id, 'MATURITY', a.id, a.maturity_date, days(a.maturity_date) <= 14 ? 'WARNING' : 'INFO', `Facility matures on ${a.maturity_date}. Consider renewal, top-up or closure.`);
    if (a.next_review_date && days(a.next_review_date) <= 30) await add(a.facility_id, a.id, 'REVIEW_DUE', a.id, a.next_review_date, 'WARNING', `Annual facility review due by ${a.next_review_date}.`);
    if (a.maturity_date < today && a.status === 'ACTIVE') await q(db, `UPDATE facility_account SET status='MATURED' WHERE id=$1`, [a.id]);
  }
  for (const c of await q<any>(db, `SELECT ci.* FROM condition_item ci JOIN facility_account a ON a.facility_id=ci.facility_id WHERE ci.category='COVENANT' AND ci.next_due_date IS NOT NULL AND ci.next_due_date <= ($1::date + 30)`, [today])) {
    await add(c.facility_id, null, 'COVENANT_DUE', c.id, c.next_due_date, c.next_due_date < today ? 'CRITICAL' : 'WARNING', `Covenant due ${c.next_due_date}: ${c.description}`);
  }
  for (const c of await q<any>(db, `SELECT co.* FROM collateral co JOIN facility_account a ON a.facility_id=co.facility_id WHERE co.deleted_at IS NULL AND co.expiry_date IS NOT NULL AND co.expiry_date <= ($1::date + 60)`, [today])) {
    await add(c.facility_id, null, 'SECURITY_EXPIRY', c.id, c.expiry_date, c.expiry_date < today ? 'CRITICAL' : 'WARNING', `Security "${c.description.slice(0, 80)}" expires on ${c.expiry_date}.`);
  }
  for (const r of await q<any>(db, `SELECT a.facility_id, a.id, max(fs.period_end) AS last FROM facility_account a JOIN facility_request f ON f.id=a.facility_id LEFT JOIN financial_statement fs ON fs.customer_id=f.customer_id AND fs.statement_type='AUDITED' AND fs.deleted_at IS NULL WHERE a.status IN ('ACTIVE','WATCHLIST') GROUP BY a.facility_id, a.id`)) {
    const due = r.last ? addMonths(r.last, 18) : today;
    if (due <= today) await add(r.facility_id, r.id, 'FINANCIALS_REFRESH', r.id, due, 'WARNING', `Updated audited financial statements are due (latest on file: ${r.last ?? 'none'}).`);
  }
  return created;
}

export async function servicingRoutes(app: FastifyInstance) {
  const db = getPool();
  const idParam = z.object({ id: z.string() });

  app.post('/api/facilities/:id/activate', async (req, reply) => {
    requireStaff(req, 'facility.activate');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const a = await tx((c) => activateFacility(c, actorOf(req), f.id));
    return ok(reply, { accountId: a.id, cbaReference: a.cba_reference, maturityDate: a.maturity_date }, 201);
  });

  app.get('/api/facilities/:id/account', async (req, reply) => {
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const a = await maybe<any>(db, 'SELECT * FROM facility_account WHERE facility_id=$1', [f.id]);
    if (!a) return ok(reply, null);
    const cust = req.auth!.subjectType === 'CUSTOMER';
    const schedule = await q(db, 'SELECT seq, due_date AS "dueDate", principal_minor AS "principalMinor", profit_minor AS "profitMinor", total_minor AS "totalMinor", paid_minor AS "paidMinor", status FROM payment_schedule_item WHERE account_id=$1 ORDER BY seq', [a.id]);
    const disb = await q<any>(db, `SELECT d.*, m.display_name AS maker, c.display_name AS checker FROM disbursement d JOIN app_user m ON m.id=d.maker_id LEFT JOIN app_user c ON c.id=d.checker_id WHERE account_id=$1 ORDER BY requested_at DESC`, [a.id]);
    const payments = await q(db, 'SELECT amount_minor AS "amountMinor", value_date AS "valueDate", reference, source FROM facility_payment WHERE account_id=$1 ORDER BY value_date DESC', [a.id]);
    const monitoring = cust ? [] : await q(db, `SELECT id, kind, due_date AS "dueDate", status, severity, detail, resolution_note AS "resolutionNote" FROM monitoring_item WHERE facility_id=$1 ORDER BY status, due_date`, [f.id]);
    return ok(reply, {
      id: a.id, status: a.status, currency: a.currency, approvedMinor: a.approved_minor, utilisedMinor: a.utilised_minor, outstandingMinor: a.outstanding_minor, availableMinor: a.approved_minor - a.utilised_minor,
      profitRatePct: a.profit_rate_pct, tenorMonths: a.tenor_months, startDate: a.start_date, maturityDate: a.maturity_date, nextReviewDate: a.next_review_date, ...(cust ? {} : { cbaReference: a.cba_reference, cbaMode: a.cba_mode }),
      schedule, payments, monitoring,
      disbursements: disb.map((d) => ({ id: d.id, amount: formatMoney(d.amount_minor, a.currency), amountMinor: d.amount_minor, beneficiary: `${d.beneficiary_name} ${maskAccount(d.beneficiary_account)}`, narrative: d.narrative, status: d.status, requestedAt: d.requested_at, postedAt: d.posted_at, ...(cust ? {} : { maker: d.maker, checker: d.checker, cbaReference: d.cba_reference, failureReason: d.failure_reason }) })),
    });
  });

  app.post('/api/facilities/:id/disbursements', async (req, reply) => {
    const s = requireStaff(req, 'disbursement.make');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const b = parse(z.object({ amountMinor: z.number().int().positive(), beneficiaryAccount: z.string().regex(/^[0-9]{10}$/), beneficiaryName: z.string().trim().min(2).max(200), narrative: z.string().trim().min(5).max(200), idempotencyKey: z.string().min(8).max(100) }), req.body);
    const out = await tx(async (c) => {
      const prior = await maybe<any>(c, 'SELECT * FROM disbursement WHERE idempotency_key=$1', [b.idempotencyKey]);
      if (prior) { if (prior.facility_id !== f.id) throw conflict('IDEMPOTENCY_REUSED', 'This request key has already been used.'); return prior; }
      const a = await maybe<any>(c, `SELECT * FROM facility_account WHERE facility_id=$1 AND status='ACTIVE' FOR UPDATE`, [f.id]);
      if (!a) throw conflict('NOT_ACTIVE', 'The facility must be active before disbursement.');
      const pending = await one<{ s: number }>(c, `SELECT COALESCE(sum(amount_minor),0)::bigint AS s FROM disbursement WHERE account_id=$1 AND status IN ('PENDING_APPROVAL','APPROVED')`, [a.id]);
      if (b.amountMinor > a.approved_minor - a.utilised_minor - pending.s) throw unprocessable('EXCEEDS_LIMIT', `The amount exceeds the available limit of ${formatMoney(a.approved_minor - a.utilised_minor - pending.s, a.currency)}.`);
      const d = await one<any>(c, `INSERT INTO disbursement(account_id, facility_id, amount_minor, beneficiary_account, beneficiary_name, narrative, idempotency_key, maker_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [a.id, f.id, b.amountMinor, b.beneficiaryAccount, b.beneficiaryName, b.narrative, b.idempotencyKey, s.id]);
      await audit(c, actorOf(req), { action: 'DISBURSEMENT_REQUESTED', entityType: 'disbursement', entityId: d.id, facilityId: f.id, metadata: { amountMinor: b.amountMinor, beneficiary: maskAccount(b.beneficiaryAccount) } });
      return d;
    });
    return ok(reply, { id: out.id, status: out.status }, 201);
  });

  app.post('/api/disbursements/:did/decide', async (req, reply) => {
    const s = requireStaff(req, 'disbursement.check');
    const { did } = parse(z.object({ did: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(500).optional() }), req.body);
    const d0 = await maybe<any>(db, 'SELECT facility_id FROM disbursement WHERE id=$1', [did]);
    if (!d0) throw notFound('Disbursement');
    await loadFacility(db, req, d0.facility_id);
    const res = await tx(async (c) => {
      const d = await one<any>(c, 'SELECT * FROM disbursement WHERE id=$1 FOR UPDATE', [did]);
      if (d.status !== 'PENDING_APPROVAL') throw conflict('STATE', 'This disbursement has already been decided.');
      if (d.maker_id === s.id) throw forbidden('Maker-checker: you initiated this disbursement and cannot approve it.');
      if (b.decision === 'REJECT') {
        await q(c, `UPDATE disbursement SET status='REJECTED', checker_id=$2, failure_reason=$3 WHERE id=$1`, [did, s.id, b.note ?? 'Rejected by checker']);
        await audit(c, actorOf(req), { action: 'DISBURSEMENT_REJECTED', entityType: 'disbursement', entityId: did, facilityId: d.facility_id });
        return { status: 'REJECTED' };
      }
      const a = await one<any>(c, 'SELECT * FROM facility_account WHERE id=$1 FOR UPDATE', [d.account_id]);
      if (d.amount_minor > a.approved_minor - a.utilised_minor) throw unprocessable('EXCEEDS_LIMIT', 'Insufficient available limit.');
      let posted;
      try { posted = await integrations().cba.postDisbursement({ idempotencyKey: `dsb:${d.id}`, facilityReference: a.cba_reference, amountMinor: d.amount_minor, beneficiaryAccount: d.beneficiary_account, narrative: d.narrative }); }
      catch (e) {
        await q(c, `UPDATE disbursement SET status='FAILED', checker_id=$2, approved_at=now(), failure_reason=$3 WHERE id=$1`, [did, s.id, e instanceof IntegrationError ? e.message : 'posting failed']);
        await audit(c, actorOf(req), { action: 'DISBURSEMENT_FAILED', entityType: 'disbursement', entityId: did, facilityId: d.facility_id, outcome: 'FAILURE' });
        return { status: 'FAILED' };
      }
      await q(c, `UPDATE disbursement SET status='POSTED', checker_id=$2, approved_at=now(), posted_at=now(), cba_reference=$3 WHERE id=$1`, [did, s.id, posted.reference]);
      await q(c, `UPDATE facility_account SET utilised_minor=utilised_minor+$2, outstanding_minor=outstanding_minor+$2 WHERE id=$1`, [a.id, d.amount_minor]);
      await audit(c, actorOf(req), { action: 'DISBURSEMENT_POSTED', entityType: 'disbursement', entityId: did, facilityId: d.facility_id, metadata: { amountMinor: d.amount_minor, cbaReference: posted.reference, mode: integrations().cba.mode } });
      await emit(c, 'DISBURSEMENT_POSTED', { facilityId: d.facility_id, vars: { amount: formatMoney(d.amount_minor, a.currency) } });
      return { status: 'POSTED', cbaReference: posted.reference };
    });
    return ok(reply, res);
  });

  /** Record a payment (from CBA reconciliation). Duplicate references are rejected (idempotent). */
  app.post('/api/facility-accounts/:aid/payments', async (req, reply) => {
    requireStaff(req, 'monitoring.manage');
    const { aid } = parse(z.object({ aid: z.uuid() }), req.params);
    const b = parse(z.object({ amountMinor: z.number().int().positive(), valueDate: z.iso.date(), reference: z.string().trim().min(4).max(100) }), req.body);
    const a0 = await maybe<any>(db, 'SELECT facility_id FROM facility_account WHERE id=$1', [aid]);
    if (!a0) throw notFound('Account');
    await loadFacility(db, req, a0.facility_id);
    await tx(async (c) => {
      if (await maybe(c, 'SELECT 1 FROM facility_payment WHERE reference=$1', [b.reference])) throw conflict('DUPLICATE_PAYMENT', 'A payment with this reference has already been recorded.');
      await q(c, 'INSERT INTO facility_payment(account_id, amount_minor, value_date, reference, source) VALUES ($1,$2,$3,$4,$5)', [aid, b.amountMinor, b.valueDate, b.reference, 'MANUAL_RECONCILIATION']);
      let left = b.amountMinor, principalPaid = 0;
      for (const it of await q<any>(c, `SELECT * FROM payment_schedule_item WHERE account_id=$1 AND status <> 'PAID' ORDER BY seq FOR UPDATE`, [aid])) {
        if (left <= 0) break;
        const due = it.total_minor - it.paid_minor;
        const pay = Math.min(due, left);
        // Allocate profit first, then principal (cost) — consistent with the sale-price structure.
        const profitDue = Math.max(0, it.profit_minor - it.paid_minor);
        principalPaid += Math.max(0, pay - profitDue);
        left -= pay;
        await q(c, `UPDATE payment_schedule_item SET paid_minor=paid_minor+$2, status = CASE WHEN paid_minor+$2 >= total_minor THEN 'PAID' ELSE 'PARTIAL' END, paid_at = CASE WHEN paid_minor+$2 >= total_minor THEN now() END WHERE id=$1`, [it.id, pay]);
      }
      await q(c, 'UPDATE facility_account SET outstanding_minor=GREATEST(0, outstanding_minor-$2) WHERE id=$1', [aid, principalPaid]);
      await q(c, `UPDATE monitoring_item SET status='RESOLVED', resolved_at=now(), resolution_note='Paid' WHERE kind='PAYMENT_OVERDUE' AND ref_id IN (SELECT id FROM payment_schedule_item WHERE account_id=$1 AND status='PAID') AND status='OPEN'`, [aid]);
      await audit(c, actorOf(req), { action: 'PAYMENT_RECORDED', entityType: 'facility_payment', entityId: b.reference, facilityId: a0.facility_id, metadata: b });
    });
    return ok(reply, { recorded: true }, 201);
  });

  app.get('/api/monitoring', async (req, reply) => {
    const s = requireStaff(req);
    const { status } = parse(z.object({ status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') }), req.query);
    const scoped = !s.permissions.has('facility.view.all');
    const rows = await q(db, `SELECT m.id, m.kind, m.due_date AS "dueDate", m.status, m.severity, m.detail, f.id AS "facilityId", f.facility_ref AS "facilityRef", c.legal_name AS customer
      FROM monitoring_item m JOIN facility_request f ON f.id=m.facility_id JOIN customer c ON c.id=f.customer_id WHERE m.status=$1 ${scoped ? 'AND (c.relationship_manager_id=$2 OR c.business_unit_code=$3)' : ''} ORDER BY CASE m.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, m.due_date LIMIT 500`, scoped ? [status, s.id, s.businessUnit] : [status]);
    return ok(reply, rows);
  });

  app.post('/api/monitoring/:mid/resolve', async (req, reply) => {
    requireStaff(req, 'monitoring.manage');
    const { mid } = parse(z.object({ mid: z.uuid() }), req.params);
    const b = parse(z.object({ note: z.string().trim().min(5).max(1000) }), req.body);
    const m = await maybe<any>(db, 'SELECT facility_id FROM monitoring_item WHERE id=$1', [mid]);
    if (!m) throw notFound('Monitoring item');
    await loadFacility(db, req, m.facility_id);
    await q(db, `UPDATE monitoring_item SET status='RESOLVED', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1`, [mid, req.auth!.subjectId, b.note]);
    await audit(db, actorOf(req), { action: 'MONITORING_RESOLVED', entityType: 'monitoring_item', entityId: mid, facilityId: m.facility_id, metadata: { note: b.note } });
    return ok(reply, { resolved: true });
  });
  void SYSTEM;
}
