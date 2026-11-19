import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, one, q } from '../../db/pool.js';
import { ok, parse } from '../../http/context.js';
import { unauthorized } from '../../lib/errors.js';

export async function notificationRoutes(app: FastifyInstance) {
  const db = getPool();
  const who = (req: any) => {
    const a = req.auth;
    if (!a || (a.subjectType === 'STAFF' && !a.mfaSatisfied)) throw unauthorized();
    return a;
  };
  app.get('/api/notifications', async (req, reply) => {
    const a = who(req);
    const qs = parse(z.object({ unreadOnly: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const rows = await q(db, `SELECT n.id, n.event_code AS event, n.title, n.body, n.link, n.severity, n.facility_id AS "facilityId", n.created_at AS "createdAt", n.read_at AS "readAt", f.facility_ref AS "facilityRef"
      FROM notification n LEFT JOIN facility_request f ON f.id=n.facility_id WHERE n.recipient_type=$1 AND n.recipient_id=$2 ${qs.unreadOnly ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC LIMIT $3`, [a.subjectType, a.subjectId, qs.limit]);
    const c = await one<any>(db, 'SELECT count(*)::int AS n FROM notification WHERE recipient_type=$1 AND recipient_id=$2 AND read_at IS NULL', [a.subjectType, a.subjectId]);
    return ok(reply, { unread: c.n, items: rows });
  });
  app.post('/api/notifications/:nid/read', async (req, reply) => {
    const a = who(req);
    const { nid } = parse(z.object({ nid: z.uuid() }), req.params);
    await q(db, 'UPDATE notification SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND recipient_type=$2 AND recipient_id=$3', [nid, a.subjectType, a.subjectId]);
    return ok(reply, { read: true });
  });
  app.post('/api/notifications/read-all', async (req, reply) => {
    const a = who(req);
    await q(db, 'UPDATE notification SET read_at=now() WHERE recipient_type=$1 AND recipient_id=$2 AND read_at IS NULL', [a.subjectType, a.subjectId]);
    return ok(reply, { read: true });
  });
}
