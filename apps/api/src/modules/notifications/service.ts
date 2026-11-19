import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { getActive } from '../config/service.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { getPool } from '../../db/pool.js';
import { integrations } from '../../integrations/index.js';
import { maskEmail } from '../../lib/mask.js';

export interface EmitContext {
  facilityId?: string;
  taskId?: string;
  assigneeIds?: string[];
  vars?: Record<string, string | number | undefined>;
  /** override link for staff/customer */
  staffLink?: string;
  customerLink?: string;
}

/** Plain-text placeholder substitution. Values are text; rendering layers escape on output. */
export const fill = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k) => {
    const v = k.split('.').reduce((o: any, p: string) => (o == null ? undefined : o[p]), vars);
    return v === undefined || v === null ? '' : String(v);
  });

/** Event-driven notification: resolves audiences from configuration and records in-app + channel deliveries. */
export async function emit(db: Db, event: string, ctx: EmitContext = {}) {
  const rule = await getActive(db, 'notification_rule', event);
  if (!rule) return 0;
  const p = rule.payload;
  let facility: any;
  if (ctx.facilityId) facility = await maybe(db, `SELECT f.*, c.legal_name, c.relationship_manager_id, c.business_unit_code FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1`, [ctx.facilityId]);
  const vars: Record<string, unknown> = { facilityRef: facility?.facility_ref, customerName: facility?.legal_name, ...ctx.vars };
  const recipients = new Map<string, { type: 'CUSTOMER' | 'STAFF'; id: string }>();
  const add = (type: 'CUSTOMER' | 'STAFF', id: string | null | undefined) => { if (id) recipients.set(`${type}:${id}`, { type, id }); };
  for (const aud of p.audiences) {
    if (aud === 'ASSIGNEES') (ctx.assigneeIds ?? []).forEach((id) => add('STAFF', id));
    else if (aud === 'CUSTOMER' && facility) (await q<{ id: string }>(db, `SELECT id FROM customer_user WHERE customer_id=$1 AND status='ACTIVE'`, [facility.customer_id])).forEach((u) => add('CUSTOMER', u.id));
    else if (aud === 'RM' && facility) add('STAFF', facility.relationship_manager_id);
    else if (aud === 'BM' && facility) (await q<{ id: string }>(db, `SELECT u.id FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code='BM' AND u.business_unit_code=$1 AND u.status='ACTIVE'`, [facility.business_unit_code])).forEach((u) => add('STAFF', u.id));
    else if (aud.startsWith('ROLE:')) (await q<{ id: string }>(db, `SELECT u.id FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code=$1 AND u.status='ACTIVE'`, [aud.slice(5)])).forEach((u) => add('STAFF', u.id));
  }
  const title = fill(p.title, vars).slice(0, 200);
  const body = fill(p.body, vars).slice(0, 2000);
  for (const r of recipients.values()) {
    const link = r.type === 'CUSTOMER' ? ctx.customerLink ?? (ctx.facilityId ? `/portal/facilities/${ctx.facilityId}` : '/portal') : ctx.staffLink ?? (ctx.taskId ? `/work/tasks/${ctx.taskId}` : ctx.facilityId ? `/work/facilities/${ctx.facilityId}` : '/work');
    const n = await one<{ id: string }>(db, `INSERT INTO notification(recipient_type, recipient_id, event_code, title, body, link, facility_id, task_id, severity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [r.type, r.id, event, title, body, link, ctx.facilityId ?? null, ctx.taskId ?? null, p.severity]);
    await q(db, `INSERT INTO notification_delivery(notification_id, channel, status, sent_at) VALUES ($1,'IN_APP','SENT',now())`, [n.id]);
    for (const ch of p.channels.filter((c) => c !== 'IN_APP')) {
      const d = await one<{ id: string }>(db, `INSERT INTO notification_delivery(notification_id, channel) VALUES ($1,$2) RETURNING id`, [n.id, ch]);
      await enqueue(db, 'notification.deliver', { deliveryId: d.id }, { idempotencyKey: `deliver:${d.id}` });
    }
  }
  return recipients.size;
}

registerJob('notification.deliver', async ({ deliveryId }) => {
  const db = getPool();
  const d = await maybe<any>(db, `SELECT d.*, n.recipient_type, n.recipient_id, n.title, n.body FROM notification_delivery d JOIN notification n ON n.id=d.notification_id WHERE d.id=$1`, [deliveryId]);
  if (!d || d.status === 'SENT') return { skipped: true };
  const who = d.recipient_type === 'STAFF'
    ? await maybe<any>(db, 'SELECT email, phone FROM app_user WHERE id=$1', [d.recipient_id])
    : await maybe<any>(db, 'SELECT email, phone FROM customer_user WHERE id=$1', [d.recipient_id]);
  if (!who) { await q(db, `UPDATE notification_delivery SET status='SKIPPED', last_error='recipient missing' WHERE id=$1`, [deliveryId]); return { skipped: true }; }
  try {
    const m = integrations().messaging;
    const text = `${d.body}\n\nSign in to Gazelle by Alternative Bank to view details. This message does not contain confidential information.`;
    const r = d.channel === 'EMAIL' ? await m.sendEmail(who.email, d.title, text) : await m.sendSms(who.phone, `${d.title}. Sign in to Gazelle for details.`);
    await q(db, `UPDATE notification_delivery SET status='SENT', provider=$2, provider_ref=$3, destination_masked=$4, attempts=attempts+1, sent_at=now() WHERE id=$1`, [deliveryId, m.mode, r.providerRef, maskEmail(who.email)]);
  } catch (e) {
    await q(db, `UPDATE notification_delivery SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [deliveryId, (e as Error).message.slice(0, 500)]);
    throw e;
  }
  return { sent: true };
});
