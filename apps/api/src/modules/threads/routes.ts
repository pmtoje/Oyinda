import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { loadFacility } from '../facilities/access.js';
import { openClarification, postMessage, threadIsVisible } from './service.js';

export async function threadRoutes(app: FastifyInstance) {
  const db = getPool();
  app.get('/api/facilities/:id/threads', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const f = await loadFacility(db, req, id);
    const a = req.auth!;
    const rows = await q(db, `SELECT t.*, (SELECT count(*)::int FROM thread_message m WHERE m.thread_id=t.id AND NOT EXISTS (SELECT 1 FROM thread_read r WHERE r.message_id=m.id AND r.reader_type=$2 AND r.reader_id=$3)) AS unread,
        (SELECT max(created_at) FROM thread_message m WHERE m.thread_id=t.id) AS last_message_at
      FROM thread t WHERE t.facility_id=$1 ${a.subjectType === 'CUSTOMER' ? `AND t.audience='CUSTOMER' AND EXISTS (SELECT 1 FROM thread_participant p WHERE p.thread_id=t.id AND p.participant_type='CUSTOMER' AND p.participant_id=$3)` : ''} ORDER BY last_message_at DESC NULLS LAST`, [f.id, a.subjectType, a.subjectId]);
    return ok(reply, rows.map((t: any) => ({ id: t.id, subject: t.subject, audience: t.audience, status: t.status, taskId: t.task_id, unread: t.unread, lastMessageAt: t.last_message_at, createdAt: t.created_at })));
  });

  app.post('/api/facilities/:id/threads', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ subject: z.string().trim().min(3).max(200), message: z.string().trim().min(1).max(10000), toUserId: z.uuid().optional(), toCustomer: z.boolean().optional() }), req.body);
    requireStaff(req, 'thread.participate');
    const f = await loadFacility(db, req, id);
    const t = await tx((c) => openClarification(c, actorOf(req), { facilityId: f.id, subject: body.subject, message: body.message, toUserId: body.toUserId, toCustomer: body.toCustomer }));
    return ok(reply, { id: t.id }, 201);
  });

  app.get('/api/threads/:threadId', async (req, reply) => {
    const { threadId } = parse(z.object({ threadId: z.uuid() }), req.params);
    const a = req.auth;
    const t0 = await q<any>(db, 'SELECT facility_id FROM thread WHERE id=$1', [threadId]);
    if (!t0[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Thread was not found.' } });
    await loadFacility(db, req, t0[0].facility_id);
    const t = await threadIsVisible(db, threadId, { type: a!.subjectType, id: a!.subjectId, facilityAccessible: true });
    const msgs = await q<any>(db, `SELECT m.*, EXISTS(SELECT 1 FROM thread_read r WHERE r.message_id=m.id AND r.reader_type=$2 AND r.reader_id=$3) AS read_by_me,
        (SELECT json_agg(json_build_object('readerType', r.reader_type, 'readAt', r.read_at)) FROM thread_read r WHERE r.message_id=m.id) AS reads
      FROM thread_message m WHERE m.thread_id=$1 ORDER BY m.created_at`, [threadId, a!.subjectType, a!.subjectId]);
    for (const m of msgs) if (!m.read_by_me) await q(db, 'INSERT INTO thread_read(message_id, reader_type, reader_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [m.id, a!.subjectType, a!.subjectId]);
    return ok(reply, { id: t.id, subject: t.subject, audience: t.audience, status: t.status, facilityId: t.facility_id, taskId: t.task_id,
      messages: msgs.map((m) => ({ id: m.id, sender: m.sender_name, senderType: m.sender_type, mine: m.sender_type === a!.subjectType && m.sender_id === a!.subjectId, body: m.body, attachmentId: m.attachment_document_id, at: m.created_at, readByOthers: (m.reads ?? []).length > 1 })) });
  });

  app.post('/api/threads/:threadId/messages', async (req, reply) => {
    const { threadId } = parse(z.object({ threadId: z.uuid() }), req.params);
    const body = parse(z.object({ body: z.string().trim().min(1).max(10000), attachmentId: z.uuid().optional() }), req.body);
    const t0 = await q<any>(db, 'SELECT facility_id FROM thread WHERE id=$1', [threadId]);
    if (!t0[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Thread was not found.' } });
    const f = await loadFacility(db, req, t0[0].facility_id);
    const a = req.auth!;
    if (a.subjectType === 'STAFF') requireStaff(req, 'thread.participate');
    await threadIsVisible(db, threadId, { type: a.subjectType, id: a.subjectId, facilityAccessible: true });
    if (body.attachmentId) {
      const d = await q(db, 'SELECT 1 FROM document WHERE id=$1 AND facility_id=$2 AND deleted_at IS NULL', [body.attachmentId, f.id]);
      if (!d.length) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment was not found.' } });
    }
    const m = await tx(async (c) => {
      if (a.subjectType === 'STAFF') await q(c, 'INSERT INTO thread_participant VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [threadId, 'STAFF', a.subjectId]);
      return postMessage(c, actorOf(req), threadId, body.body, { attachmentId: body.attachmentId ?? null });
    });
    return ok(reply, { id: m.id, at: m.created_at }, 201);
  });

  app.post('/api/threads/:threadId/resolve', async (req, reply) => {
    const { threadId } = parse(z.object({ threadId: z.uuid() }), req.params);
    requireStaff(req, 'thread.participate');
    const t0 = await q<any>(db, 'SELECT facility_id FROM thread WHERE id=$1', [threadId]);
    if (!t0[0]) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Thread was not found.' } });
    await loadFacility(db, req, t0[0].facility_id);
    await q(db, `UPDATE thread SET status='RESOLVED', resolved_at=now() WHERE id=$1`, [threadId]);
    return ok(reply, { resolved: true });
  });
}
