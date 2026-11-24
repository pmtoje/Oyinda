import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { actorOf, ok, parse, requireCustomerRight, requireStaff } from '../../http/context.js';
import { resolveCustomer } from '../facilities/access.js';
import { decideReview, identityOverview, openReview, proposeReview, revealRecords, reviewDetail, verifyParty } from './verification.js';

/**
 * Promoter identity verification. Identifiers travel only in request bodies (never URLs), are never echoed back,
 * and are masked to their last four digits in every response.
 */
export async function identityVerificationRoutes(app: FastifyInstance) {
  const db = getPool();
  const LIMIT = { rateLimit: { max: 30, timeWindow: '15 minutes' } };
  const ids = z.object({ customerId: z.string(), partyId: z.uuid() });
  // Validation messages never repeat the submitted value.
  const identifier = z.string().regex(/^[0-9]{11}$/, 'Enter the 11 digits.');

  app.get('/api/customers/:customerId/identity', async (req, reply) => {
    const cid = await resolveCustomer(db, req, parse(z.object({ customerId: z.string() }), req.params).customerId);
    return ok(reply, await identityOverview(db, cid));
  });

  /** "Verify your identity": BVN and/or NIN with date of birth and consent; runs the checks server-side. */
  app.post('/api/customers/:customerId/parties/:partyId/identity/verify', { config: LIMIT }, async (req, reply) => {
    const p = parse(ids, req.params);
    const cid = await resolveCustomer(db, req, p.customerId, true);
    if (req.auth?.subjectType === 'CUSTOMER') requireCustomerRight(req, 'SUBMIT_REQUESTS');
    const b = parse(z.object({
      bvn: identifier.optional(), nin: identifier.optional(),
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth.'),
      consent: z.literal(true, { error: 'Confirm the consent statement to continue.' }),
    }), req.body);
    const r = await verifyParty(db, actorOf(req), cid, p.partyId, b);
    return ok(reply, { state: r.state, checks: r.perKind.map((x) => ({ kind: x.kind, state: x.state, source: x.row?.provider_mode ?? null, results: x.row?.checks ?? [] })) });
  });

  /** Customer asks the Bank to review a difference (e.g. a known name change) instead of re-entering details. */
  app.post('/api/customers/:customerId/parties/:partyId/identity/review', async (req, reply) => {
    const p = parse(ids, req.params);
    const cid = await resolveCustomer(db, req, p.customerId, true);
    if (req.auth?.subjectType === 'CUSTOMER') requireCustomerRight(req, 'SUBMIT_REQUESTS');
    const b = parse(z.object({ note: z.string().trim().min(5, 'Tell us briefly why the details differ.').max(1000) }), req.body);
    const r = await openReview(db, actorOf(req), cid, p.partyId, b.note);
    return ok(reply, { status: r.status, requestedAt: r.created_at }, 201);
  });

  // ---- Staff review queue (KYC / Compliance): maker proposes, a different checker decides ----
  app.get('/api/identity-reviews', async (req, reply) => {
    requireStaff(req, 'identity.review');
    const { status } = parse(z.object({ status: z.enum(['open', 'closed']).default('open') }), req.query);
    const rows = await db.query(`SELECT r.id, r.status, r.created_at, r.proposal, r.proposed_by, c.legal_name, bp.full_name, bp.party_type, pu.display_name AS proposed_by_name
      FROM identity_review r JOIN customer c ON c.id=r.customer_id JOIN business_party bp ON bp.id=r.party_id LEFT JOIN app_user pu ON pu.id=r.proposed_by
      WHERE ${status === 'open' ? "r.status IN ('OPEN','PROPOSED','ESCALATED')" : "r.status IN ('CLEARED','REJECTED')"} ORDER BY r.created_at LIMIT 200`);
    return ok(reply, rows.rows.map((r: any) => ({ id: r.id, status: r.status, createdAt: r.created_at, customer: r.legal_name, person: r.full_name, partyType: r.party_type, proposal: r.proposal, proposedBy: r.proposed_by_name, proposedById: r.proposed_by })));
  });

  app.get('/api/identity-reviews/:id', async (req, reply) => {
    requireStaff(req, 'identity.review');
    return ok(reply, await reviewDetail(db, parse(z.object({ id: z.uuid() }), req.params).id));
  });

  app.post('/api/identity-reviews/:id/reveal', async (req, reply) => {
    requireStaff(req, 'identity.review');
    return ok(reply, await revealRecords(db, actorOf(req), parse(z.object({ id: z.uuid() }), req.params).id));
  });

  app.post('/api/identity-reviews/:id/propose', async (req, reply) => {
    requireStaff(req, 'identity.review');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ proposal: z.enum(['CLEAR', 'REJECT', 'ESCALATE']), reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(2000) }), req.body);
    await proposeReview(db, actorOf(req), id, b.proposal, b.reason);
    return ok(reply, await reviewDetail(db, id));
  });

  app.post('/api/identity-reviews/:id/decide', async (req, reply) => {
    requireStaff(req, 'identity.review');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'RETURN']), reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(2000) }), req.body);
    await decideReview(db, actorOf(req), id, b.decision, b.reason);
    return ok(reply, await reviewDetail(db, id));
  });
}
