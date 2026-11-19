import { evaluate } from '@gazelle/shared';
import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { audit, type Actor } from '../audit/audit.js';
import { getById, listActive } from '../config/service.js';
import { buildFacts, collateralSummary } from '../facilities/facts.js';
import { formatMoney } from '../../lib/money.js';

/** Build security summary text from recorded collateral. */
export async function securityText(db: Db, facilityId: string, amountMinor: number, ccy: string) {
  const col = await collateralSummary(db, facilityId, amountMinor, ccy);
  const types = new Map((await listActive(db, 'collateral_type')).map((t) => [t.key, t.payload.name]));
  if (!col.items.length) return 'No security recorded.';
  return col.items.map((c: any) => `${types.get(c.type_key) ?? c.type_key}: ${c.description} — market value ${formatMoney(c.market_value_minor, c.currency)}, eligible value ${formatMoney(c.eligible_value_ngn_minor)} (${c.perfection_status.replace(/_/g, ' ').toLowerCase()})`).join('\n') + `\nEligible cover: ${col.coveragePct}% of the facility amount.`;
}

/**
 * Called inside the approval transaction. Freezes the approved terms (immutable, version 1+) and generates
 * the conditions checklist from configured condition templates plus approver/E&S conditions.
 */
export async function onCreditApproved(db: Db, facilityId: string, actor: Actor) {
  const f = await one<any>(db, 'SELECT * FROM facility_request WHERE id=$1', [facilityId]);
  const product = await getById<any>(db, f.product_config_id);
  const rar = await maybe<any>(db, `SELECT * FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const finalAction = await maybe<any>(db, `SELECT * FROM workflow_action WHERE facility_id=$1 AND action='APPROVE' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const approvers = await q<{ actor_name: string }>(db, `SELECT DISTINCT ON (actor_name) actor_name FROM workflow_action WHERE facility_id=$1 AND action IN ('APPROVE','RECOMMEND','VOTE') AND actor_type='STAFF'`, [facilityId]);
  const approverConditions = (await q<{ payload: any }>(db, `SELECT payload FROM workflow_action WHERE facility_id=$1 AND payload ? 'conditions' AND payload->'conditions' IS NOT NULL AND jsonb_typeof(payload->'conditions')='array'`, [facilityId])).flatMap((r) => r.payload.conditions as string[]);
  const es = await maybe<any>(db, `SELECT conditions FROM es_assessment WHERE facility_id=$1 AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [facilityId]);
  const { facts } = await buildFacts(db, facilityId);
  const templates = (await listActive(db, 'condition_template')).filter((t) => evaluate(t.payload.appliesWhen as any, facts).result);
  const items = templates.flatMap((t) => t.payload.items);
  approverConditions.forEach((c, i) => items.push({ code: `APPROVAL_COND_${i + 1}`, description: c, category: 'PRECEDENT', ownerTeam: 'CREDIT_OPS', mandatory: true }));
  (es?.conditions ?? []).forEach((c: string, i: number) => items.push({ code: `ES_COND_${i + 1}`, description: c, category: 'SUBSEQUENT', ownerTeam: 'CREDIT_OPS', mandatory: true }));
  const n = await one<{ n: number }>(db, 'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM approved_terms WHERE facility_id=$1', [facilityId]);
  const rate = rar?.request?.proposedProfitRatePct ?? product.payload.indicativeProfitRatePct ?? 0;
  const terms = await one<any>(db, `INSERT INTO approved_terms(facility_id, version_no, source, source_action_id, product_code, currency, amount_minor, tenor_months, profit_rate_pct, management_fee_pct, payment_frequency, moratorium_months, security_summary, conditions, approved_by_names)
     VALUES ($1,$2,'CREDIT_APPROVAL',$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13) RETURNING *`,
    [facilityId, n.n, finalAction?.id ?? null, f.product_code, f.currency, f.amount_minor, f.tenor_months, rate, rar?.request?.managementFeePct ?? 1, f.payment_frequency, await securityText(db, facilityId, f.amount_minor, f.currency), JSON.stringify(items), approvers.map((a) => a.actor_name)]);
  for (const it of items) {
    await q(db, `INSERT INTO condition_item(facility_id, terms_id, code, description, category, owner_team, mandatory, frequency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [facilityId, terms.id, it.code, it.description, it.category, it.ownerTeam, it.mandatory, it.frequency ?? null]);
  }
  await audit(db, actor, { action: 'TERMS_APPROVED', entityType: 'approved_terms', entityId: terms.id, facilityId, after: { version: terms.version_no, amountMinor: terms.amount_minor, tenor: terms.tenor_months, rate: terms.profit_rate_pct, conditions: items.length } });
  return terms;
}

// ---------------------------------------------------------------------------
// Offer letters
// ---------------------------------------------------------------------------
import { conflict as _conflict, forbidden as _forbidden, unprocessable as _unprocessable } from '../../lib/errors.js';
import { requireActive as _requireActive } from '../config/service.js';
import { fill } from '../notifications/service.js';
import { renderDocx } from '../docgen/docx.js';
import { storeGenerated } from '../docgen/service.js';
import { emit } from '../notifications/service.js';
import { setFacilityStatus, startFulfilmentWorkflow } from '../workflow/engine.js';

const FREQ: Record<string, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', SEMI_ANNUAL: 'Semi-annually', ANNUAL: 'Annually', BULLET: 'Bullet (at maturity)' };

export function pricingText(product: any, terms: any) {
  const rate = Number(terms.profit_rate_pct);
  switch (product.pricingBasis) {
    case 'PROFIT_RATE': return `Profit rate: ${rate}% per annum, fixed at contract and embedded in the sale price.`;
    case 'RENTAL': return `Rental rate: ${rate}% per annum of the asset cost, payable as lease rentals.`;
    case 'PROFIT_SHARING_RATIO': return `Expected profit rate: ${rate}% per annum, distributed according to the agreed profit-sharing ratio; returns are not guaranteed.`;
    case 'FEE': return `Commission: ${rate}% of the guaranteed amount (Kafalah service fee).`;
    default: return 'No profit is charged on this facility.';
  }
}

export async function offerVars(db: Db, facilityId: string, terms: any) {
  const f = await one<any>(db, 'SELECT f.*, c.legal_name FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [facilityId]);
  const product = await getById<any>(db, f.product_config_id);
  const cps = (terms.conditions as any[]).filter((c) => c.category === 'PRECEDENT');
  const others = (terms.conditions as any[]).filter((c) => c.category !== 'PRECEDENT');
  return {
    customer: { name: f.legal_name },
    facility: { ref: f.facility_ref, purpose: f.purpose, sourceOfPayment: f.source_of_payment ?? '—' },
    terms: {
      productName: product.payload.name, amount: formatMoney(terms.amount_minor, terms.currency), tenor: `${terms.tenor_months} months`, pricingText: pricingText(product.payload, terms),
      managementFee: `${Number(terms.management_fee_pct)}% flat`, paymentFrequency: FREQ[terms.payment_frequency] ?? terms.payment_frequency, moratorium: terms.moratorium_months ? `${terms.moratorium_months} months` : 'None',
      security: terms.security_summary, conditionsPrecedent: cps.map((c, i) => `${i + 1}. ${c.description}`).join('\n') || 'None', otherConditions: others.map((c, i) => `${i + 1}. ${c.description}`).join('\n') || 'None',
    },
    date: new Date().toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' }),
  };
}

/** Maker: generate the offer letter from the configured template and the current approved terms. */
export async function prepareOffer(db: Db, actor: Actor, facilityId: string) {
  const f = await one<any>(db, 'SELECT * FROM facility_request WHERE id=$1 FOR UPDATE', [facilityId]);
  if (f.status !== 'APPROVED') throw _conflict('NOT_APPROVED', 'An offer can be prepared only for an approved facility awaiting its offer.');
  if (await maybe(db, `SELECT 1 FROM offer_letter WHERE facility_id=$1 AND status IN ('PENDING_CHECK','ISSUED','NEGOTIATING')`, [facilityId])) throw _conflict('OFFER_EXISTS', 'An offer is already in progress.');
  const terms = await one<any>(db, 'SELECT * FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1', [facilityId]);
  const tpl = await _requireActive(db, 'template', 'OFFER_LETTER_STANDARD');
  const vars = await offerVars(db, facilityId, terms);
  const sections = (tpl.payload as any).sections.map((s: any) => ({ heading: s.heading, paragraphs: [fill(s.body, vars)] }));
  const title = fill((tpl.payload as any).title, vars);
  const docx = await renderDocx({ title, subtitle: vars.customer.name, reference: f.facility_ref, classification: 'CONFIDENTIAL', sections, footerNote: `Terms version ${terms.version_no}` });
  const g = await storeGenerated(db, actor, facilityId, 'OFFER_LETTER', { title, sections, termsVersion: terms.version_no }, docx, { templateConfigId: tpl.id, customerVisible: false });
  const o = await one<any>(db, `INSERT INTO offer_letter(facility_id, terms_id, generated_document_id, status, maker_id) VALUES ($1,$2,$3,'PENDING_CHECK',$4) RETURNING *`, [facilityId, terms.id, g.id, actor.id]);
  await audit(db, actor, { action: 'OFFER_PREPARED', entityType: 'offer_letter', entityId: o.id, facilityId, metadata: { termsVersion: terms.version_no, template: tpl.key, templateVersion: tpl.version } });
  return o;
}

/** Checker: issue to the customer, or return to the maker. Maker and checker must differ. */
export async function checkOffer(db: Db, actor: Actor, offerId: string, decision: 'ISSUE' | 'RETURN', note?: string) {
  const o = await maybe<any>(db, 'SELECT * FROM offer_letter WHERE id=$1 FOR UPDATE', [offerId]);
  if (!o || o.status !== 'PENDING_CHECK') throw _conflict('STATE', 'This offer is not awaiting a check.');
  if (o.maker_id === actor.id) throw _forbidden('Maker-checker: you prepared this offer and cannot also check it.');
  if (decision === 'RETURN') {
    await q(db, `UPDATE offer_letter SET status='RETURNED_TO_MAKER', checker_id=$2, checked_at=now(), response_note=$3 WHERE id=$1`, [offerId, actor.id, note ?? null]);
    await audit(db, actor, { action: 'OFFER_RETURNED_TO_MAKER', entityType: 'offer_letter', entityId: offerId, facilityId: o.facility_id, metadata: { note } });
    return;
  }
  await q(db, `UPDATE offer_letter SET status='ISSUED', checker_id=$2, checked_at=now(), issued_at=now(), expires_at=now() + interval '30 days', row_version=row_version+1 WHERE id=$1`, [offerId, actor.id]);
  const g = await one<any>(db, 'SELECT rendered_document_id FROM generated_document WHERE id=$1', [o.generated_document_id]);
  await q(db, 'UPDATE document SET customer_visible=true WHERE id=$1', [g.rendered_document_id]);
  await setFacilityStatus(db, o.facility_id, 'OFFER_ISSUED', actor, { customerNote: 'Offer letter issued' });
  await audit(db, actor, { action: 'OFFER_ISSUED', entityType: 'offer_letter', entityId: offerId, facilityId: o.facility_id });
  await emit(db, 'OFFER_ISSUED', { facilityId: o.facility_id, customerLink: `/portal/facilities/${o.facility_id}/offer` });
}

export interface OfferResponse { decision: 'ACCEPT' | 'REJECT' | 'NEGOTIATE'; note?: string; rowVersion: number; negotiation?: { amountMinor?: number; tenorMonths?: number; profitRatePct?: number; other?: string; justification: string } }

export async function respondToOffer(db: Db, actor: Actor, customerUserId: string, customerId: string, offerId: string, r: OfferResponse, ip?: string | null) {
  const o = await maybe<any>(db, `SELECT o.*, f.customer_id FROM offer_letter o JOIN facility_request f ON f.id=o.facility_id WHERE o.id=$1 FOR UPDATE OF o`, [offerId]);
  if (!o || o.customer_id !== customerId) throw _conflict('NOT_FOUND', 'Offer not found.');
  if (o.status !== 'ISSUED') throw _conflict('STATE', 'This offer is not open for a response.');
  if (o.row_version !== r.rowVersion) throw _conflict('STALE', 'This offer has changed. Reload to see the latest version.');
  if (o.expires_at && new Date(o.expires_at) < new Date()) { await q(db, `UPDATE offer_letter SET status='EXPIRED' WHERE id=$1`, [offerId]); throw _conflict('EXPIRED', 'This offer has expired. Contact your relationship manager.'); }
  const set = (status: string) => q(db, `UPDATE offer_letter SET status=$2, responded_by=$3, responded_at=now(), response_note=$4, acceptance_ip=$5, row_version=row_version+1 WHERE id=$1`, [offerId, status, customerUserId, r.note ?? null, ip ?? null]);
  if (r.decision === 'ACCEPT') {
    await set('ACCEPTED');
    await setFacilityStatus(db, o.facility_id, 'OFFER_ACCEPTED', actor, { customerNote: 'Offer accepted' });
    await audit(db, actor, { action: 'OFFER_ACCEPTED', entityType: 'offer_letter', entityId: offerId, facilityId: o.facility_id, customerId, metadata: { termsId: o.terms_id, ip } });
    await emit(db, 'OFFER_ACCEPTED', { facilityId: o.facility_id });
    await startFulfilmentWorkflow(db, o.facility_id, actor);
    await setFacilityStatus(db, o.facility_id, 'FULFILMENT', actor, { customerNote: 'Legal, Shariah and credit operations documentation in progress' });
    const custConds = await q(db, `SELECT 1 FROM condition_item WHERE facility_id=$1 AND terms_id=$2 AND owner_team='CUSTOMER' AND status='PENDING'`, [o.facility_id, o.terms_id]);
    if (custConds.length) await emit(db, 'DOCUMENTATION_PENDING', { facilityId: o.facility_id, customerLink: `/portal/facilities/${o.facility_id}/conditions` });
  } else if (r.decision === 'REJECT') {
    if (!r.note || r.note.length < 5) throw _unprocessable('REASON', 'Tell us briefly why you are rejecting the offer.');
    await set('REJECTED');
    await setFacilityStatus(db, o.facility_id, 'OFFER_REJECTED', actor, { customerNote: 'Offer rejected', reason: r.note });
    await audit(db, actor, { action: 'OFFER_REJECTED', entityType: 'offer_letter', entityId: offerId, facilityId: o.facility_id, customerId, metadata: { note: r.note } });
    await emit(db, 'OFFER_REJECTED', { facilityId: o.facility_id });
  } else {
    const n = r.negotiation;
    if (!n || (!n.amountMinor && !n.tenorMonths && n.profitRatePct === undefined && !n.other)) throw _unprocessable('NEGOTIATION', 'State the change you are requesting.');
    await set('NEGOTIATING');
    // Approved terms are never modified: the request is recorded separately for review.
    const nr = await one<any>(db, `INSERT INTO negotiation_request(facility_id, offer_id, requested_by, requested_amount_minor, requested_tenor_months, requested_profit_rate_pct, requested_other, justification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [o.facility_id, offerId, customerUserId, n.amountMinor ?? null, n.tenorMonths ?? null, n.profitRatePct ?? null, n.other ?? null, n.justification]);
    await setFacilityStatus(db, o.facility_id, 'IN_NEGOTIATION', actor, { customerNote: 'Your requested changes are under consideration' });
    await audit(db, actor, { action: 'OFFER_NEGOTIATION_REQUESTED', entityType: 'negotiation_request', entityId: nr.id, facilityId: o.facility_id, customerId, after: n });
    await emit(db, 'OFFER_NEGOTIATION', { facilityId: o.facility_id, staffLink: `/work/facilities/${o.facility_id}?tab=offer` });
  }
}

/** Review a customer's negotiation request. Approval creates a NEW terms version; the original remains intact. */
export async function decideNegotiation(db: Db, actor: Actor, negotiationId: string, d: { decision: 'APPROVE' | 'DECLINE'; note: string; amountMinor?: number; tenorMonths?: number; profitRatePct?: number }) {
  const n = await maybe<any>(db, 'SELECT * FROM negotiation_request WHERE id=$1 FOR UPDATE', [negotiationId]);
  if (!n || n.status !== 'OPEN') throw _conflict('STATE', 'This negotiation request is not open.');
  const offer = await one<any>(db, 'SELECT * FROM offer_letter WHERE id=$1 FOR UPDATE', [n.offer_id]);
  const terms = await one<any>(db, 'SELECT * FROM approved_terms WHERE id=$1', [offer.terms_id]);
  if (d.decision === 'DECLINE') {
    await q(db, `UPDATE negotiation_request SET status='DECLINED', reviewer_id=$2, decision_note=$3, decided_at=now() WHERE id=$1`, [negotiationId, actor.id, d.note]);
    await q(db, `UPDATE offer_letter SET status='ISSUED', row_version=row_version+1 WHERE id=$1`, [offer.id]);
    await setFacilityStatus(db, n.facility_id, 'OFFER_ISSUED', actor, { customerNote: 'Requested changes not agreed; original offer remains open', reason: d.note });
    await audit(db, actor, { action: 'NEGOTIATION_DECLINED', entityType: 'negotiation_request', entityId: negotiationId, facilityId: n.facility_id, metadata: { note: d.note } });
    await emit(db, 'OFFER_ISSUED', { facilityId: n.facility_id });
    return null;
  }
  const amount = d.amountMinor ?? n.requested_amount_minor ?? terms.amount_minor;
  if (amount > terms.amount_minor) throw _unprocessable('REAPPROVAL_REQUIRED', 'An increase above the approved amount requires a fresh credit approval.');
  const rate = d.profitRatePct ?? n.requested_profit_rate_pct ?? terms.profit_rate_pct;
  const th = await _requireActive(db, 'rarorac_threshold', 'STANDARD');
  if (Number(rate) < (th.payload as any).minProfitRatePct) throw _unprocessable('BELOW_MIN_RATE', `The profit rate cannot be agreed below the ${(th.payload as any).minProfitRatePct}% minimum without a new pricing approval.`);
  const tenor = d.tenorMonths ?? n.requested_tenor_months ?? terms.tenor_months;
  const v = (await one<{ n: number }>(db, 'SELECT MAX(version_no)+1 AS n FROM approved_terms WHERE facility_id=$1', [n.facility_id])).n;
  const nt = await one<any>(db, `INSERT INTO approved_terms(facility_id, version_no, source, product_code, currency, amount_minor, tenor_months, profit_rate_pct, management_fee_pct, payment_frequency, moratorium_months, security_summary, conditions, approved_by_names)
    VALUES ($1,$2,'NEGOTIATION_APPROVAL',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [n.facility_id, v, terms.product_code, terms.currency, amount, tenor, rate, terms.management_fee_pct, terms.payment_frequency, terms.moratorium_months, terms.security_summary, JSON.stringify(terms.conditions), [...terms.approved_by_names, `${actor.label} (negotiation)`]]);
  for (const c of await q<any>(db, 'SELECT * FROM condition_item WHERE terms_id=$1', [terms.id])) {
    await q(db, `INSERT INTO condition_item(facility_id, terms_id, code, description, category, owner_team, mandatory, frequency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [c.facility_id, nt.id, c.code, c.description, c.category, c.owner_team, c.mandatory, c.frequency]);
  }
  await q(db, `UPDATE negotiation_request SET status='APPROVED', reviewer_id=$2, decision_note=$3, decided_at=now(), resulting_terms_id=$4 WHERE id=$1`, [negotiationId, actor.id, d.note, nt.id]);
  await q(db, `UPDATE offer_letter SET status='SUPERSEDED', row_version=row_version+1 WHERE id=$1`, [offer.id]);
  await setFacilityStatus(db, n.facility_id, 'APPROVED', actor, { customerNote: 'Revised terms agreed; a new offer letter will follow', reason: d.note });
  await audit(db, actor, { action: 'NEGOTIATION_APPROVED', entityType: 'approved_terms', entityId: nt.id, facilityId: n.facility_id, before: { version: terms.version_no, amount: terms.amount_minor, tenor: terms.tenor_months, rate: terms.profit_rate_pct }, after: { version: v, amount, tenor, rate } });
  return nt;
}

export const CONDITION_PERMS: Record<string, string> = { LEGAL: 'condition.legal', SHARIAH: 'condition.shariah', CREDIT_OPS: 'condition.creditops', CUSTOMER: 'condition.creditops', RM: 'condition.creditops' };
