import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { audit, type Actor } from '../audit/audit.js';
import { emit } from '../notifications/service.js';

export async function openClarification(db: Db, actor: Actor, input: { facilityId: string; taskId?: string | null; subject: string; message: string; toUserId?: string; toCustomer?: boolean }) {
  if (!input.toUserId && !input.toCustomer) throw unprocessable('RECIPIENT', 'Choose who the clarification is for.');
  if (input.toUserId && !(await maybe(db, `SELECT 1 FROM app_user WHERE id=$1 AND status='ACTIVE'`, [input.toUserId]))) throw unprocessable('RECIPIENT', 'The selected recipient is not available.');
  const pausesSla = input.taskId ? !!(await maybe(db, `SELECT 1 FROM workflow_task t JOIN config_item c ON c.id=t.sla_policy_config_id WHERE t.id=$1 AND (c.payload->>'pauseOnClarification')::boolean`, [input.taskId])) : false;
  const t = await one<any>(db, `INSERT INTO thread(facility_id, task_id, subject, audience, pauses_sla, created_by_type, created_by_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.facilityId, input.taskId ?? null, input.subject.slice(0, 200), input.toCustomer ? 'CUSTOMER' : 'INTERNAL', pausesSla, actor.type, actor.id]);
  await q(db, 'INSERT INTO thread_participant VALUES ($1,$2,$3)', [t.id, actor.type, actor.id]);
  const recipients: string[] = [];
  if (input.toUserId) { await q(db, 'INSERT INTO thread_participant VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, 'STAFF', input.toUserId]); recipients.push(input.toUserId); }
  if (input.toCustomer) {
    const users = await q<{ id: string }>(db, `SELECT cu.id FROM customer_user cu JOIN facility_request f ON f.customer_id=cu.customer_id WHERE f.id=$1 AND cu.status='ACTIVE'`, [input.facilityId]);
    for (const u of users) await q(db, 'INSERT INTO thread_participant VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, 'CUSTOMER', u.id]);
  }
  await postMessage(db, actor, t.id, input.message, { recipientType: input.toCustomer ? 'CUSTOMER' : 'STAFF', recipientId: input.toUserId ?? null, notify: false });
  if (pausesSla && input.taskId) await q(db, `UPDATE workflow_task SET sla_paused_at=now() WHERE id=$1 AND sla_paused_at IS NULL`, [input.taskId]);
  await emit(db, 'CLARIFICATION_REQUESTED', { facilityId: input.facilityId, assigneeIds: recipients, vars: { subject: input.subject, actorName: actor.label ?? '' }, staffLink: `/work/facilities/${input.facilityId}?thread=${t.id}`, customerLink: `/portal/facilities/${input.facilityId}?thread=${t.id}` });
  if (input.toCustomer) {
    const cus = await q<{ id: string }>(db, 'SELECT participant_id AS id FROM thread_participant WHERE thread_id=$1 AND participant_type=$2', [t.id, 'CUSTOMER']);
    for (const c of cus) await q(db, `INSERT INTO notification(recipient_type, recipient_id, event_code, title, body, link, facility_id, severity) VALUES ('CUSTOMER',$1,'CLARIFICATION_REQUESTED',$2,$3,$4,$5,'ACTION')`, [c.id, 'The Bank has a question about your request', input.subject, `/portal/facilities/${input.facilityId}?thread=${t.id}`, input.facilityId]);
  }
  await audit(db, actor, { action: 'CLARIFICATION_OPENED', entityType: 'thread', entityId: t.id, facilityId: input.facilityId, metadata: { audience: t.audience } });
  return t;
}

export async function postMessage(db: Db, actor: Actor, threadId: string, body: string, opts: { recipientType?: string; recipientId?: string | null; attachmentId?: string | null; notify?: boolean } = {}) {
  const t = await one<any>(db, 'SELECT * FROM thread WHERE id=$1', [threadId]);
  const m = await one<any>(db, `INSERT INTO thread_message(thread_id, facility_id, sender_type, sender_id, sender_name, recipient_type, recipient_id, body, attachment_document_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [threadId, t.facility_id, actor.type, actor.id, actor.label ?? 'User', opts.recipientType ?? null, opts.recipientId ?? null, body, opts.attachmentId ?? null]);
  await q(db, 'INSERT INTO thread_read(message_id, reader_type, reader_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [m.id, actor.type, actor.id]);
  if (opts.notify !== false) {
    const others = await q<any>(db, 'SELECT participant_type, participant_id FROM thread_participant WHERE thread_id=$1 AND NOT (participant_type=$2 AND participant_id=$3)', [threadId, actor.type, actor.id]);
    await emit(db, 'CLARIFICATION_ANSWERED', { facilityId: t.facility_id, assigneeIds: others.filter((o) => o.participant_type === 'STAFF').map((o) => o.participant_id), vars: { subject: t.subject, actorName: actor.label ?? '' }, staffLink: `/work/facilities/${t.facility_id}?thread=${threadId}` });
    // A customer reply resumes any paused SLA clock.
    if (actor.type === 'CUSTOMER' && t.pauses_sla && t.task_id) {
      await q(db, `UPDATE workflow_task SET sla_paused_ms = sla_paused_ms + (extract(epoch from now() - sla_paused_at)*1000)::bigint, due_at = due_at + (now() - sla_paused_at), sla_paused_at=NULL WHERE id=$1 AND sla_paused_at IS NOT NULL`, [t.task_id]);
    }
  }
  return m;
}

export async function threadIsVisible(db: Db, threadId: string, who: { type: 'CUSTOMER' | 'STAFF'; id: string; facilityAccessible: boolean }) {
  const t = await maybe<any>(db, 'SELECT * FROM thread WHERE id=$1', [threadId]);
  if (!t) throw notFound('Thread');
  if (who.type === 'CUSTOMER') {
    const p = await maybe(db, 'SELECT 1 FROM thread_participant WHERE thread_id=$1 AND participant_type=$2 AND participant_id=$3', [threadId, 'CUSTOMER', who.id]);
    if (!p || t.audience !== 'CUSTOMER') throw notFound('Thread');
  } else if (!who.facilityAccessible) throw notFound('Thread');
  return t;
}
