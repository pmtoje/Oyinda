import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireCustomer, requireStaff } from '../../http/context.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { formatMoney } from '../../lib/money.js';
import { audit } from '../audit/audit.js';
import { loadFacility } from '../facilities/access.js';
import { emit } from '../notifications/service.js';
import { CONDITION_PERMS, checkOffer, decideNegotiation, prepareOffer, respondToOffer } from './service.js';

export async function offerRoutes(app: FastifyInstance) {
  const db = getPool();
  const idParam = z.object({ id: z.string() });

  app.get('/api/facilities/:id/offer', async (req, reply) => {
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const cust = req.auth!.subjectType === 'CUSTOMER';
    const offers = await q<any>(db, `SELECT o.*, g.content, g.rendered_document_id, t.version_no AS terms_version, t.amount_minor, t.currency, t.tenor_months, t.profit_rate_pct, t.payment_frequency, mk.display_name AS maker_name, ck.display_name AS checker_name
      FROM offer_letter o JOIN generated_document g ON g.id=o.generated_document_id JOIN approved_terms t ON t.id=o.terms_id LEFT JOIN app_user mk ON mk.id=o.maker_id LEFT JOIN app_user ck ON ck.id=o.checker_id
      WHERE o.facility_id=$1 ${cust ? `AND o.status IN ('ISSUED','ACCEPTED','REJECTED','NEGOTIATING','SUPERSEDED','EXPIRED')` : ''} ORDER BY o.created_at DESC`, [f.id]);
    const negotiations = await q<any>(db, `SELECT n.*, u.display_name AS reviewer FROM negotiation_request n LEFT JOIN app_user u ON u.id=n.reviewer_id WHERE n.facility_id=$1 ORDER BY n.created_at DESC`, [f.id]);
    const terms = cust ? [] : await q(db, 'SELECT id, version_no AS version, source, amount_minor AS "amountMinor", tenor_months AS "tenorMonths", profit_rate_pct AS "profitRatePct", approved_by_names AS "approvedBy", created_at AS "createdAt" FROM approved_terms WHERE facility_id=$1 ORDER BY version_no', [f.id]);
    return ok(reply, {
      offers: offers.map((o) => ({ id: o.id, status: o.status, termsVersion: o.terms_version, amount: formatMoney(o.amount_minor, o.currency), tenorMonths: o.tenor_months, profitRatePct: o.profit_rate_pct, paymentFrequency: o.payment_frequency, title: o.content.title, sections: o.content.sections, documentId: o.rendered_document_id, issuedAt: o.issued_at, expiresAt: o.expires_at, respondedAt: o.responded_at, responseNote: o.response_note, rowVersion: o.row_version, ...(cust ? {} : { maker: o.maker_name, checker: o.checker_name }) })),
      negotiations: negotiations.map((n) => ({ id: n.id, status: n.status, requestedAmount: n.requested_amount_minor ? formatMoney(n.requested_amount_minor) : null, requestedTenorMonths: n.requested_tenor_months, requestedProfitRatePct: n.requested_profit_rate_pct, requestedOther: n.requested_other, justification: n.justification, decisionNote: n.decision_note, createdAt: n.created_at, decidedAt: n.decided_at, ...(cust ? {} : { reviewer: n.reviewer }) })),
      termsVersions: terms,
    });
  });

  app.post('/api/facilities/:id/offer', async (req, reply) => {
    requireStaff(req, 'offer.make');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const o = await tx((c) => prepareOffer(c, actorOf(req), f.id));
    return ok(reply, { id: o.id, status: o.status }, 201);
  });

  app.post('/api/offers/:offerId/check', async (req, reply) => {
    requireStaff(req, 'offer.check');
    const { offerId } = parse(z.object({ offerId: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['ISSUE', 'RETURN']), note: z.string().trim().max(1000).optional() }), req.body);
    const o = await maybe<any>(db, 'SELECT facility_id FROM offer_letter WHERE id=$1', [offerId]);
    if (!o) throw notFound('Offer');
    await loadFacility(db, req, o.facility_id);
    await tx((c) => checkOffer(c, actorOf(req), offerId, b.decision, b.note));
    return ok(reply, { done: true });
  });

  app.post('/api/offers/:offerId/respond', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const cu = requireCustomer(req);
    const { offerId } = parse(z.object({ offerId: z.uuid() }), req.params);
    const b = parse(z.object({
      decision: z.enum(['ACCEPT', 'REJECT', 'NEGOTIATE']), note: z.string().trim().max(2000).optional(), rowVersion: z.number().int(),
      acknowledgement: z.boolean().optional(),
      negotiation: z.object({ amountMinor: z.number().int().positive().optional(), tenorMonths: z.number().int().positive().max(360).optional(), profitRatePct: z.number().min(0).max(100).optional(), other: z.string().trim().max(2000).optional(), justification: z.string().trim().min(10).max(3000) }).optional(),
    }).refine((x) => x.decision !== 'ACCEPT' || x.acknowledgement === true, { message: 'Confirm that you have read and accept the terms.', path: ['acknowledgement'] }), req.body);
    await tx((c) => respondToOffer(c, actorOf(req), cu.userId, cu.customerId, offerId, b, req.ip));
    return ok(reply, { recorded: true });
  });

  app.post('/api/negotiations/:nid/decide', async (req, reply) => {
    requireStaff(req, 'negotiation.review');
    const { nid } = parse(z.object({ nid: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'DECLINE']), note: z.string().trim().min(5).max(2000), amountMinor: z.number().int().positive().optional(), tenorMonths: z.number().int().positive().optional(), profitRatePct: z.number().min(0).max(100).optional() }), req.body);
    const n = await maybe<any>(db, 'SELECT facility_id FROM negotiation_request WHERE id=$1', [nid]);
    if (!n) throw notFound('Negotiation');
    await loadFacility(db, req, n.facility_id);
    const r = await tx((c) => decideNegotiation(c, actorOf(req), nid, b));
    return ok(reply, { decided: true, newTermsVersion: r?.version_no ?? null });
  });

  // -------------------------------------------------------------------------
  // Conditions precedent / subsequent / covenants
  // -------------------------------------------------------------------------
  app.get('/api/facilities/:id/conditions', async (req, reply) => {
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const cust = req.auth!.subjectType === 'CUSTOMER';
    const terms = await maybe<any>(db, 'SELECT id, version_no FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1', [f.id]);
    if (!terms) return ok(reply, { termsVersion: null, items: [], blocking: 0 });
    const rows = await q<any>(db, `SELECT ci.*, u.display_name AS actioned_by_name, w.display_name AS waiver_by_name FROM condition_item ci LEFT JOIN app_user u ON u.id=ci.actioned_by LEFT JOIN app_user w ON w.id=ci.waiver_approved_by WHERE ci.terms_id=$1 ${cust ? `AND ci.owner_team='CUSTOMER'` : ''} ORDER BY ci.category, ci.owner_team, ci.code`, [terms.id]);
    const blocking = rows.filter((r) => r.mandatory && r.category === 'PRECEDENT' && r.status === 'PENDING').length;
    return ok(reply, { termsVersion: terms.version_no, blocking, items: rows.map((r) => ({ id: r.id, code: r.code, description: r.description, category: r.category, ownerTeam: r.owner_team, mandatory: r.mandatory, status: r.status, evidenceDocumentId: r.evidence_document_id, frequency: r.frequency, nextDueDate: r.next_due_date, comment: r.comment, ...(cust ? {} : { actionedBy: r.actioned_by_name, actionedAt: r.actioned_at, waiverApprovedBy: r.waiver_by_name }) })) });
  });

  app.patch('/api/conditions/:cid', async (req, reply) => {
    const s = requireStaff(req);
    const { cid } = parse(z.object({ cid: z.uuid() }), req.params);
    const b = parse(z.object({ status: z.enum(['SATISFIED', 'WAIVED', 'NOT_APPLICABLE', 'PENDING']), evidenceDocumentId: z.uuid().nullable().optional(), comment: z.string().trim().min(5).max(2000), nextDueDate: z.iso.date().optional() }), req.body);
    const c0 = await maybe<any>(db, 'SELECT * FROM condition_item WHERE id=$1', [cid]);
    if (!c0) throw notFound('Condition');
    const f = await loadFacility(db, req, c0.facility_id);
    if (!['OFFER_ACCEPTED', 'FULFILMENT', 'READY_FOR_ACTIVATION', 'ACTIVE'].includes(f.status)) throw conflict('STATE', 'Conditions can be actioned after the offer is accepted.');
    if (!s.permissions.has(CONDITION_PERMS[c0.owner_team]!)) throw forbidden(`Only the ${c0.owner_team.replace('_', ' ')} team can action this condition.`);
    if ((b.status === 'WAIVED' || (b.status === 'NOT_APPLICABLE' && c0.mandatory)) && !s.permissions.has('condition.waive')) throw forbidden('Waiving a mandatory condition requires waiver authority.');
    if (b.status === 'SATISFIED' && c0.category === 'PRECEDENT' && c0.mandatory && !b.evidenceDocumentId) throw conflict('EVIDENCE', 'Attach the evidence document for this condition precedent.');
    if (b.evidenceDocumentId && !(await maybe(db, 'SELECT 1 FROM document WHERE id=$1 AND facility_id=$2 AND deleted_at IS NULL', [b.evidenceDocumentId, f.id]))) throw notFound('Evidence document');
    await tx(async (c) => {
      await q(c, `UPDATE condition_item SET status=$2::text, evidence_document_id=COALESCE($3::uuid, evidence_document_id), comment=$4, actioned_by=$5::uuid, actioned_at=now(), waiver_approved_by = CASE WHEN $2::text IN ('WAIVED','NOT_APPLICABLE') THEN $5::uuid ELSE NULL END, next_due_date=COALESCE($6::date, next_due_date) WHERE id=$1`, [cid, b.status, b.evidenceDocumentId ?? null, b.comment, s.id, b.nextDueDate ?? null]);
      await audit(c, actorOf(req), { action: `CONDITION_${b.status}`, entityType: 'condition_item', entityId: cid, facilityId: f.id, before: { status: c0.status }, after: { status: b.status }, metadata: { code: c0.code, comment: b.comment } });
    });
    return ok(reply, { updated: true });
  });

  /** Customer uploads evidence for a customer-owned condition (Credit Ops then marks it satisfied). */
  app.post('/api/conditions/:cid/evidence', async (req, reply) => {
    requireCustomer(req);
    const { cid } = parse(z.object({ cid: z.uuid() }), req.params);
    const c0 = await maybe<any>(db, 'SELECT * FROM condition_item WHERE id=$1', [cid]);
    if (!c0 || c0.owner_team !== 'CUSTOMER') throw notFound('Condition');
    const f = await loadFacility(db, req, c0.facility_id);
    const d = await one<any>(db, `INSERT INTO document(customer_id, facility_id, doc_type, title, status, mandatory) VALUES ($1,$2,'CONDITION_EVIDENCE',$3,'REQUIRED',false) RETURNING id`, [f.customer_id, f.id, `Evidence: ${c0.description.slice(0, 150)}`]);
    await q(db, 'UPDATE condition_item SET evidence_document_id=$2 WHERE id=$1', [cid, d.id]);
    await emit(db, 'DOCUMENTATION_PENDING', { facilityId: f.id });
    return ok(reply, { documentId: d.id }, 201);
  });
}
