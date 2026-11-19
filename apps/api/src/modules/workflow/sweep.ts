import type { Db } from '../../db/pool.js';
import { maybe, q } from '../../db/pool.js';
import { getById } from '../config/service.js';
import { audit, SYSTEM } from '../audit/audit.js';
import { emit } from '../notifications/service.js';

/** SLA sweep: warnings, breaches and multi-level escalation. Idempotent; safe to run every minute. */
export async function slaSweep(db: Db, now = new Date()) {
  const out = { warned: 0, breached: 0, escalated: 0 };
  const open = await q<any>(db, `SELECT * FROM workflow_task WHERE status IN ('OPEN','CLAIMED') AND due_at IS NOT NULL AND sla_paused_at IS NULL`);
  for (const t of open) {
    const who = t.claimed_by ?? t.assigned_user_id;
    const assignees = who ? [who] : (await q<{ id: string }>(db, `SELECT u.id FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code=$1 AND u.status='ACTIVE'`, [t.role_code])).map((r) => r.id);
    if (!t.warned_at && t.warn_at && new Date(t.warn_at) <= now && new Date(t.due_at) > now) {
      const r = await q(db, `UPDATE workflow_task SET warned_at=$2 WHERE id=$1 AND warned_at IS NULL RETURNING id`, [t.id, now]);
      if (r.length) {
        await q(db, `INSERT INTO sla_event(task_id, facility_id, kind) VALUES ($1,$2,'WARNING')`, [t.id, t.facility_id]);
        await emit(db, 'SLA_WARNING', { facilityId: t.facility_id, taskId: t.id, assigneeIds: assignees, vars: { stageName: t.stage_name, dueAt: new Date(t.due_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) } });
        out.warned++;
      }
    }
    if (!t.breached_at && new Date(t.due_at) <= now) {
      const r = await q(db, `UPDATE workflow_task SET breached_at=$2 WHERE id=$1 AND breached_at IS NULL RETURNING id`, [t.id, now]);
      if (r.length) {
        await q(db, `INSERT INTO sla_event(task_id, facility_id, kind) VALUES ($1,$2,'BREACHED')`, [t.id, t.facility_id]);
        await emit(db, 'SLA_BREACHED', { facilityId: t.facility_id, taskId: t.id, assigneeIds: assignees, vars: { stageName: t.stage_name } });
        await audit(db, SYSTEM, { action: 'SLA_BREACHED', entityType: 'workflow_task', entityId: t.id, facilityId: t.facility_id, metadata: { stage: t.stage_key, dueAt: t.due_at } });
        out.breached++;
        t.breached_at = now;
      }
    }
    if (t.breached_at && t.sla_policy_config_id) {
      const policy = await getById<any>(db, t.sla_policy_config_id);
      const hoursOver = (now.getTime() - new Date(t.due_at).getTime()) / 3600_000;
      const escalations = policy.payload.escalations ?? [];
      for (let level = t.escalation_level; level < escalations.length; level++) {
        const e = escalations[level];
        if (hoursOver < e.afterBreachHours) break;
        const r = await maybe(db, `UPDATE workflow_task SET escalation_level=$2 WHERE id=$1 AND escalation_level=$3 RETURNING id`, [t.id, level + 1, level]);
        if (!r) break;
        const targets = (await q<{ id: string }>(db, `SELECT DISTINCT u.id FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code = ANY($1) AND u.status='ACTIVE'`, [e.notifyRoles])).map((x) => x.id);
        await q(db, `INSERT INTO sla_event(task_id, facility_id, kind, level, detail) VALUES ($1,$2,'ESCALATED',$3,$4)`, [t.id, t.facility_id, level + 1, JSON.stringify({ label: e.label, roles: e.notifyRoles })]);
        await emit(db, 'SLA_ESCALATED', { facilityId: t.facility_id, taskId: t.id, assigneeIds: [...targets, ...assignees], vars: { stageName: t.stage_name, escalation: e.label } });
        out.escalated++;
      }
    }
  }
  return out;
}
