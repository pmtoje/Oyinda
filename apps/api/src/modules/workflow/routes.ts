import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WORKFLOW_ACTION_LABEL } from '@gazelle/shared';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { formatMoney } from '../../lib/money.js';
import { loadFacility } from '../facilities/access.js';
import { actionsFor, claimTask, effectiveRoles, performAction, reassignTask, releaseTask } from './engine.js';
import { prerequisiteStatus } from './prerequisites.js';

const BUSINESS_ROLES = ['RM', 'BM', 'RBE', 'DH'];

function slaState(t: any, now = Date.now()) {
  if (!t.due_at) return { state: 'NONE' as const };
  const due = new Date(t.due_at).getTime();
  const done = t.completed_at ? new Date(t.completed_at).getTime() : now;
  const state = t.breached_at || done > due ? 'BREACHED' : t.warn_at && done >= new Date(t.warn_at).getTime() ? 'WARNING' : 'ON_TRACK';
  return { state, dueAt: t.due_at, remainingMs: due - done, paused: !!t.sla_paused_at, escalationLevel: t.escalation_level };
}

export const taskView = (t: any) => ({
  id: t.id, facilityId: t.facility_id, facilityRef: t.facility_ref, customerName: t.legal_name, productName: t.product_name, amountText: t.amount_minor ? formatMoney(t.amount_minor, t.currency) : null,
  stageKey: t.stage_key, stageName: t.stage_name, branchKey: t.branch_key, taskType: t.task_type, role: t.role_code, status: t.status, outcome: t.outcome,
  assignedTo: t.assigned_name ?? null, claimedBy: t.claimed_name ?? null, claimedAt: t.claimed_at, createdAt: t.created_at, completedAt: t.completed_at, rowVersion: t.row_version, sla: slaState(t),
});

const TASK_SELECT = `SELECT t.*, f.facility_ref, f.amount_minor, f.currency, c.legal_name, ci.payload->>'name' AS product_name, au.display_name AS assigned_name, cu.display_name AS claimed_name
  FROM workflow_task t JOIN facility_request f ON f.id=t.facility_id JOIN customer c ON c.id=f.customer_id JOIN config_item ci ON ci.id=f.product_config_id
  LEFT JOIN app_user au ON au.id=t.assigned_user_id LEFT JOIN app_user cu ON cu.id=t.claimed_by`;

export async function workflowRoutes(app: FastifyInstance) {
  const db = getPool();

  app.get('/api/tasks', async (req, reply) => {
    const s = requireStaff(req, 'task.work');
    const { scope } = parse(z.object({ scope: z.enum(['mine', 'queue', 'completed']).default('mine') }), req.query);
    const roles = await effectiveRoles(db, s);
    const allRoles = [...roles.own, ...roles.delegated.keys()];
    let rows: any[];
    if (scope === 'mine') {
      rows = await q(db, `${TASK_SELECT} WHERE t.status IN ('OPEN','CLAIMED') AND (t.claimed_by=$1 OR (t.status='OPEN' AND t.assigned_user_id=$1)
        OR (t.task_type='COMMITTEE' AND EXISTS (SELECT 1 FROM committee_session cs WHERE cs.task_id=t.id AND $1 = ANY(cs.members) AND NOT EXISTS (SELECT 1 FROM committee_vote v WHERE v.session_id=cs.id AND v.member_id=$1))))
        ORDER BY t.due_at NULLS LAST`, [s.id]);
    } else if (scope === 'queue') {
      rows = await q(db, `${TASK_SELECT} WHERE t.status='OPEN' AND t.task_type <> 'COMMITTEE' AND t.role_code = ANY($1) AND (t.assigned_user_id IS NULL OR t.assigned_user_id=$2)
        AND (NOT (t.role_code = ANY($3)) OR c.business_unit_code IS NOT DISTINCT FROM $4) ORDER BY t.due_at NULLS LAST`, [allRoles, s.id, BUSINESS_ROLES, s.businessUnit]);
    } else {
      rows = await q(db, `${TASK_SELECT} WHERE t.completed_by=$1 ORDER BY t.completed_at DESC LIMIT 100`, [s.id]);
    }
    return ok(reply, rows.map(taskView));
  });

  app.get('/api/tasks/:taskId', async (req, reply) => {
    const s = requireStaff(req, 'task.work');
    const { taskId } = parse(z.object({ taskId: z.uuid() }), req.params);
    const t = await maybe<any>(db, `${TASK_SELECT} WHERE t.id=$1`, [taskId]);
    if (!t) throw notFound('Task');
    await loadFacility(db, req, t.facility_id);
    const inst = await one<any>(db, 'SELECT * FROM workflow_instance WHERE id=$1', [t.instance_id]);
    const stage = inst.route.stages[t.stage_index];
    const branch = t.branch_key ? stage?.branches?.find((b: any) => b.key === t.branch_key) : undefined;
    const avail = await actionsFor(db, s, t);
    const committee = t.task_type === 'COMMITTEE' ? await maybe<any>(db, 'SELECT * FROM committee_session WHERE task_id=$1', [t.id]) : null;
    const votes = committee ? await q(db, `SELECT v.vote, v.comment, v.member_role AS role, v.created_at AS at, u.display_name AS member FROM committee_vote v JOIN app_user u ON u.id=v.member_id WHERE v.session_id=$1 ORDER BY v.sequence_no`, [committee.id]) : [];
    const returnTargets = branch ? ['PREVIOUS', 'RM', 'CUSTOMER'] : stage?.type === 'APPROVAL_LEVEL' ? ['PREVIOUS', 'RM'] : stage?.returnTargets ?? ['PREVIOUS'];
    return ok(reply, {
      ...taskView(t),
      availableActions: avail.actions.map((a) => ({ code: a, label: WORKFLOW_ACTION_LABEL[a] ?? (a === 'CLAIM' ? 'Claim task' : a === 'RELEASE' ? 'Release task' : a) })),
      notes: avail.notes, onBehalfOf: avail.onBehalfOf, returnTargets,
      authority: t.authority,
      prerequisites: await prerequisiteStatus(db, (branch?.prerequisites ?? stage?.prerequisites ?? []) as string[], t.facility_id),
      committee: committee ? { key: committee.committee_key, rules: committee.rules, memberCount: committee.members.length, status: committee.status, decision: committee.decision, votes } : null,
    });
  });

  app.post('/api/tasks/:taskId/claim', async (req, reply) => {
    const s = requireStaff(req, 'task.work');
    const { taskId } = parse(z.object({ taskId: z.uuid() }), req.params);
    const t = await maybe<any>(db, 'SELECT facility_id FROM workflow_task WHERE id=$1', [taskId]);
    if (!t) throw notFound('Task');
    await loadFacility(db, req, t.facility_id);
    const r = await tx((c) => claimTask(c, s, actorOf(req), taskId));
    return ok(reply, { claimed: true, rowVersion: r.row_version });
  });

  app.post('/api/tasks/:taskId/release', async (req, reply) => {
    const s = requireStaff(req, 'task.work');
    const { taskId } = parse(z.object({ taskId: z.uuid() }), req.params);
    await tx((c) => releaseTask(c, s, actorOf(req), taskId));
    return ok(reply, { released: true });
  });

  app.post('/api/tasks/:taskId/reassign', async (req, reply) => {
    requireStaff(req, 'task.reassign');
    const { taskId } = parse(z.object({ taskId: z.uuid() }), req.params);
    const body = parse(z.object({ toUserId: z.uuid(), reason: z.string().trim().min(5).max(500) }), req.body);
    await tx((c) => reassignTask(c, actorOf(req), taskId, body.toUserId, body.reason));
    return ok(reply, { reassigned: true });
  });

  app.get('/api/tasks/:taskId/eligible-assignees', async (req, reply) => {
    requireStaff(req, 'task.reassign');
    const { taskId } = parse(z.object({ taskId: z.uuid() }), req.params);
    const t = await maybe<any>(db, 'SELECT role_code FROM workflow_task WHERE id=$1', [taskId]);
    if (!t) throw notFound('Task');
    return ok(reply, await q(db, `SELECT u.id, u.display_name AS name, u.business_unit_code AS "businessUnit" FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code=$1 AND u.status='ACTIVE' ORDER BY u.display_name`, [t.role_code]));
  });

  app.post('/api/tasks/:taskId/actions', async (req, reply) => {
    const s = requireStaff(req, 'task.work');
    const { taskId } = parse(z.object({ taskId: z.uuid() }), req.params);
    const body = parse(z.object({
      action: z.enum(['APPROVE', 'RECOMMEND', 'DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'VOTE', 'COMPLETE', 'RECORD_DECISION']),
      minutesReference: z.string().trim().max(120).optional(),
      comment: z.string().trim().max(5000).optional(),
      idempotencyKey: z.string().min(8).max(100),
      rowVersion: z.number().int().optional(),
      returnTarget: z.enum(['CUSTOMER', 'RM', 'PREVIOUS']).optional(),
      reworkItems: z.array(z.object({ section: z.string().max(60), message: z.string().trim().min(5).max(1000), targetRef: z.string().max(100).optional() })).max(30).optional(),
      vote: z.enum(['APPROVE', 'DECLINE', 'ABSTAIN']).optional(),
      conditions: z.array(z.string().trim().min(5).max(500)).max(30).optional(),
      clarification: z.object({ toUserId: z.uuid().optional(), toCustomer: z.boolean().optional(), subject: z.string().trim().min(3).max(200), message: z.string().max(5000).optional() }).optional(),
    }), req.body);
    const t = await maybe<any>(db, 'SELECT facility_id FROM workflow_task WHERE id=$1', [taskId]);
    if (!t) throw notFound('Task');
    await loadFacility(db, req, t.facility_id);
    const r = await tx((c) => performAction(c, s, actorOf(req), taskId, body));
    return ok(reply, r);
  });

  /** Internal operational timeline: route explanation, every task and every action. Staff only. */
  app.get('/api/facilities/:id/workflow', async (req, reply) => {
    requireStaff(req);
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const f = await loadFacility(db, req, id);
    const instances = await q<any>(db, `SELECT w.*, ci.title AS definition_title, ci.version AS definition_version FROM workflow_instance w JOIN config_item ci ON ci.id=w.definition_config_id WHERE w.facility_id=$1 ORDER BY w.started_at`, [f.id]);
    const tasks = await q(db, `${TASK_SELECT} WHERE t.facility_id=$1 ORDER BY t.created_at`, [f.id]);
    const actions = await q(db, `SELECT a.id, a.instance_id AS "instanceId", a.task_id AS "taskId", a.actor_name AS actor, a.actor_role AS role, a.actor_type AS "actorType", a.action, a.comment, a.payload, a.created_at AS at, ob.display_name AS "onBehalfOf"
      FROM workflow_action a LEFT JOIN app_user ob ON ob.id=a.on_behalf_of WHERE a.facility_id=$1 ORDER BY a.created_at`, [f.id]);
    const sla = await q(db, `SELECT task_id AS "taskId", kind, level, detail, created_at AS at FROM sla_event WHERE facility_id=$1 ORDER BY created_at`, [f.id]);
    return ok(reply, {
      instances: instances.map((i) => ({ id: i.id, kind: i.kind, status: i.status, outcome: i.outcome, definition: `${i.definition_title} v${i.definition_version}`, startedAt: i.started_at, completedAt: i.completed_at, currentStageIndex: i.current_stage_index, route: i.route })),
      tasks: tasks.map(taskView), actions, slaEvents: sla,
    });
  });
}
