import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, q } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { loadFacility } from '../facilities/access.js';
import { listInteractions, runAssist, USE_CASES, type UseCase } from './service.js';

export async function aiRoutes(app: FastifyInstance) {
  const db = getPool();
  app.post('/api/facilities/:id/ai/:useCase', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    requireStaff(req, 'ai.use');
    const { id, useCase } = parse(z.object({ id: z.string(), useCase: z.enum(Object.keys(USE_CASES) as [UseCase, ...UseCase[]]) }), req.params);
    const f = await loadFacility(db, req, id); // access-controlled retrieval
    return ok(reply, await runAssist(db, actorOf(req), f.id, useCase), 201);
  });
  app.get('/api/facilities/:id/ai', async (req, reply) => {
    requireStaff(req, 'ai.use');
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    return ok(reply, await listInteractions(db, f.id));
  });
  app.post('/api/ai/:iid/review', async (req, reply) => {
    requireStaff(req, 'ai.use');
    const { iid } = parse(z.object({ iid: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['ACCEPTED', 'REJECTED', 'EDITED']), note: z.string().trim().max(2000).optional() }), req.body);
    const r = await maybe<any>(db, 'SELECT * FROM ai_interaction WHERE id=$1', [iid]);
    if (!r) throw notFound('AI output');
    await loadFacility(db, req, r.facility_id);
    if (r.review_status !== 'PENDING_REVIEW') throw conflict('REVIEWED', 'This output has already been reviewed.');
    await q(db, 'UPDATE ai_interaction SET review_status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1', [iid, b.decision, req.auth!.subjectId, b.note ?? null]);
    await audit(db, actorOf(req), { action: 'AI_OUTPUT_REVIEWED', entityType: 'ai_interaction', entityId: iid, facilityId: r.facility_id, metadata: { decision: b.decision } });
    return ok(reply, { reviewed: true });
  });
}
