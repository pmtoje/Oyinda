import { evaluate } from '@gazelle/shared';
import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { formatMoney } from '../../lib/money.js';
import { audit, SYSTEM, type Actor } from '../audit/audit.js';
import { getActive, getById, listActive, requireActive } from '../config/service.js';
import { buildFacts } from '../facilities/facts.js';
import { toNgn } from '../fx/service.js';
import { emit } from '../notifications/service.js';
import type { StaffPrincipal } from '../identity/session.js';
import { committeeDecision, resolveChain } from './authority.js';
import { unmetPrerequisites } from './prerequisites.js';
import { computeDue } from './sla.js';

export interface Branch { key: string; name: string; role: string; taskType: string; actions: string[]; slaPolicyKey: string; prerequisites?: string[]; onDecline?: 'TERMINATE' | 'CONTINUE'; included: boolean; reason?: string }
export interface RouteStage {
  index: number; key: string; name: string; type: 'TASK' | 'PARALLEL' | 'APPROVAL_CHAIN' | 'APPROVAL_LEVEL';
  role?: string; taskType?: string; actions?: string[]; slaPolicyKey?: string; assignTo?: string; returnTargets?: string[]; prerequisites?: string[]; onDecline?: 'TERMINATE' | 'CONTINUE';
  branches?: Branch[]; authorityKey?: string;
  level?: { code: string; name: string; kind: 'INDIVIDUAL' | 'COMMITTEE'; role?: string; committeeKey?: string; effectiveLimitMinor: number; isFinal: boolean };
  skipped?: boolean; reason?: string;
}
export interface Route { stages: RouteStage[]; explanation: string[]; returnedAtIndex?: number | null }

const BUSINESS_ROLES = new Set(['RM', 'BM', 'RBE', 'DH']);
const DECISION_ACTIONS = new Set(['APPROVE', 'RECOMMEND', 'COMPLETE', 'VOTE', 'RECORD_DECISION']);

// ---------------------------------------------------------------------------
// Facility status
// ---------------------------------------------------------------------------
export async function setFacilityStatus(db: Db, facilityId: string, to: string, actor: Actor, opts: { reason?: string; customerNote?: string } = {}) {
  const f = await one<any>(db, 'SELECT status FROM facility_request WHERE id=$1', [facilityId]);
  if (f.status === to) return;
  await q(db, `UPDATE facility_request SET status=$2, row_version=row_version+1, decided_at = CASE WHEN $2 IN ('APPROVED','DECLINED') THEN now() ELSE decided_at END WHERE id=$1`, [facilityId, to]);
  await q(db, `INSERT INTO facility_status_history(facility_id, from_status, to_status, actor_type, actor_id, reason, customer_visible_note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [facilityId, f.status, to, actor.type, actor.id ?? null, opts.reason ?? null, opts.customerNote ?? null]);
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------
async function chooseDefinition(db: Db, kind: string, facts: Record<string, any>) {
  const defs = (await listActive(db, 'workflow_definition')).filter((d) => d.payload.kind === kind && evaluate(d.payload.appliesWhen as any, facts).result);
  if (!defs.length) throw conflict('NO_WORKFLOW', `No active ${kind} workflow applies to this facility. An administrator must configure one.`);
  return defs.sort((a, b) => b.payload.priority - a.payload.priority)[0]!;
}

export function resolveStages(def: any, facts: Record<string, any>): Route {
  const explanation: string[] = [];
  const stages: RouteStage[] = def.stages.map((s: any, index: number) => {
    if (s.type === 'TASK') {
      const included = !s.when || evaluate(s.when, facts).result;
      if (!included) explanation.push(`${s.name} skipped: condition not met.`);
      return { index, key: s.key, name: s.name, type: 'TASK', role: s.role, taskType: s.taskType, actions: s.actions, slaPolicyKey: s.slaPolicyKey, assignTo: s.assignTo, returnTargets: s.returnTargets, prerequisites: s.prerequisites ?? [], onDecline: s.onDecline ?? 'TERMINATE', skipped: !included, reason: included ? undefined : 'Condition not met' };
    }
    if (s.type === 'PARALLEL') {
      const branches: Branch[] = s.branches.map((b: any) => {
        const inc = !b.when || evaluate(b.when, facts).result;
        explanation.push(inc ? `${b.name} included${b.when ? ' (condition met)' : ''}.` : `${b.name} not required (condition not met).`);
        return { ...b, prerequisites: b.prerequisites ?? [], included: inc };
      });
      return { index, key: s.key, name: s.name, type: 'PARALLEL', branches };
    }
    return { index, key: s.key, name: s.name, type: 'APPROVAL_CHAIN', authorityKey: s.authorityKey };
  });
  return { stages, explanation };
}

async function amountNgnMinor(db: Db, f: any) {
  return (await toNgn(db, f.amount_minor, f.currency)).minor;
}

/** Select the authority matrix: a pinned key, or the active matrix for the workflow type that matches the facts. */
export async function chooseAuthority(db: Db, facts: Record<string, any>, key?: string) {
  if (key) return requireActive(db, 'approval_authority', key);
  const all = (await listActive(db, 'approval_authority')).filter((a) => !a.payload.appliesWhen || evaluate(a.payload.appliesWhen as any, facts).result);
  if (!all.length) throw conflict('NO_AUTHORITY', 'No approval authority matrix applies to this facility. An administrator must configure one.');
  return all.sort((a, b) => (b.payload.priority ?? 0) - (a.payload.priority ?? 0))[0]!;
}

/** Amount that determines approval authority: the request, or (PRD) the request plus the obligor's outstanding exposure. */
export async function authorityAmount(db: Db, facility: any, basis: string | undefined) {
  const request = await amountNgnMinor(db, facility);
  if (basis !== 'AGGREGATE_EXPOSURE') return { amount: request, request, outstanding: 0 };
  const e = await maybe<any>(db, 'SELECT direct_exposure_minor, contingent_exposure_minor FROM exposure_snapshot WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facility.id]);
  const outstanding = e ? Number(e.direct_exposure_minor) + Number(e.contingent_exposure_minor) : 0;
  return { amount: request + outstanding, request, outstanding };
}

/** Expand an APPROVAL_CHAIN placeholder into concrete levels using the facts at that moment. */
async function expandChain(db: Db, instance: any, route: Route, idx: number) {
  const chainStage = route.stages[idx]!;
  const { facts, facility } = await buildFacts(db, instance.facility_id);
  const authority = await chooseAuthority(db, facts, chainStage.authorityKey);
  const amt = await authorityAmount(db, facility, (authority.payload as any).amountBasis);
  const amount = amt.amount;
  const r = resolveChain(authority.payload as any, facts, amount);
  if (amt.outstanding) r.reasons.unshift(`Authority amount ${formatMoney(amount)} = request ${formatMoney(amt.request)} + outstanding exposure ${formatMoney(amt.outstanding)}.`);
  r.reasons.unshift(`Authority matrix: ${authority.title}.`);
  const levels: RouteStage[] = r.chain.map((l, i) => ({
    index: idx + i, key: l.code, name: l.name, type: 'APPROVAL_LEVEL', slaPolicyKey: l.slaPolicyKey,
    level: { code: l.code, name: l.name, kind: l.kind, role: l.role, committeeKey: l.committeeKey, effectiveLimitMinor: l.effectiveLimitMinor, isFinal: l.isFinal },
  }));
  const tail = route.stages.slice(idx + 1).map((s, i) => ({ ...s, index: idx + levels.length + i }));
  const newRoute: Route = { ...route, stages: [...route.stages.slice(0, idx), ...levels, ...tail], explanation: [...route.explanation, ...r.reasons, `Final approving authority: ${r.finalLevel.name}.`] };
  await q(db, `UPDATE workflow_instance SET route=$2, facts=$3, authority_config_id=$4 WHERE id=$1`, [instance.id, JSON.stringify(newRoute), JSON.stringify(facts), authority.id]);
  await recordAction(db, instance, null, SYSTEM, 'ROUTE', `Approval route determined: ${levels.map((l) => l.name).join(' → ')}`, { reasons: r.reasons, amountNgnMinor: amount, authorityVersion: authority.version });
  return newRoute;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
async function slaFor(db: Db, key: string | undefined, start: Date) {
  if (!key) return { policyId: null, dueAt: null, warnAt: null };
  const p = await getActive(db, 'sla_policy', key);
  const cal = await getActive(db, 'business_calendar', 'NG_HEAD_OFFICE');
  if (!p || !cal) return { policyId: null, dueAt: null, warnAt: null };
  const { dueAt, warnAt } = computeDue(start, p.payload as any, cal.payload as any);
  return { policyId: p.id, dueAt, warnAt };
}

async function recipientsForRole(db: Db, role: string, facilityId: string) {
  const f = await one<any>(db, 'SELECT c.business_unit_code FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [facilityId]);
  const scoped = BUSINESS_ROLES.has(role) && f.business_unit_code;
  return (await q<{ id: string }>(db, `SELECT u.id FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code=$1 AND u.status='ACTIVE' ${scoped ? 'AND u.business_unit_code=$2' : ''}`, scoped ? [role, f.business_unit_code] : [role])).map((r) => r.id);
}

async function createTask(db: Db, instance: any, stage: RouteStage, spec: { branchKey?: string | null; name: string; role: string; taskType: string; actions: string[]; slaPolicyKey?: string; assignedUserId?: string | null; authority?: Record<string, unknown> }) {
  const now = new Date();
  const sla = await slaFor(db, spec.slaPolicyKey, now);
  const t = await one<any>(db, `INSERT INTO workflow_task(instance_id, facility_id, stage_index, stage_key, stage_name, branch_key, task_type, role_code, assigned_user_id, permitted_actions, authority, sla_policy_config_id, sla_started_at, due_at, warn_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [instance.id, instance.facility_id, stage.index, spec.branchKey ? spec.branchKey : stage.key, spec.name, spec.branchKey ?? null, spec.taskType, spec.role, spec.assignedUserId ?? null, spec.actions, JSON.stringify(spec.authority ?? {}), sla.policyId, now, sla.dueAt, sla.warnAt]);
  await q(db, `INSERT INTO sla_event(task_id, facility_id, kind, detail) VALUES ($1,$2,'STARTED',$3)`, [t.id, t.facility_id, JSON.stringify({ dueAt: sla.dueAt, policy: spec.slaPolicyKey })]);
  if (spec.assignedUserId) await q(db, `INSERT INTO task_assignment_history(task_id, to_user_id, kind, reason) VALUES ($1,$2,'AUTO_ASSIGN','Assigned by workflow configuration')`, [t.id, spec.assignedUserId]);
  const f = await one<any>(db, 'SELECT amount_minor, currency FROM facility_request WHERE id=$1', [instance.facility_id]);
  const assignees = spec.assignedUserId ? [spec.assignedUserId] : spec.taskType === 'COMMITTEE' ? (spec.authority?.members as string[]) ?? [] : await recipientsForRole(db, spec.role, instance.facility_id);
  await emit(db, 'TASK_ASSIGNED', { facilityId: instance.facility_id, taskId: t.id, assigneeIds: assignees, vars: { stageName: spec.name, amount: formatMoney(f.amount_minor, f.currency) } });
  return t;
}

async function openStage(db: Db, instance: any, route: Route, idx: number, actor: Actor): Promise<void> {
  if (idx >= route.stages.length) return completeInstance(db, instance, 'COMPLETED', actor);
  let stage = route.stages[idx]!;
  if (stage.type === 'APPROVAL_CHAIN') { route = await expandChain(db, instance, route, idx); stage = route.stages[idx]!; }
  await q(db, 'UPDATE workflow_instance SET current_stage_index=$2, row_version=row_version+1 WHERE id=$1', [instance.id, idx]);
  if (stage.skipped) return openStage(db, instance, route, idx + 1, actor);
  if (stage.type === 'TASK') {
    let assigned: string | null = null;
    if (stage.assignTo === 'RELATIONSHIP_MANAGER') {
      const c = await one<any>(db, 'SELECT c.relationship_manager_id FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [instance.facility_id]);
      assigned = c.relationship_manager_id;
    }
    await createTask(db, instance, stage, { name: stage.name, role: stage.role!, taskType: stage.taskType!, actions: stage.actions!, slaPolicyKey: stage.slaPolicyKey, assignedUserId: assigned });
  } else if (stage.type === 'PARALLEL') {
    const inc = stage.branches!.filter((b) => b.included);
    if (!inc.length) return openStage(db, instance, route, idx + 1, actor);
    for (const b of inc) await createTask(db, instance, stage, { branchKey: b.key, name: b.name, role: b.role, taskType: b.taskType, actions: b.actions, slaPolicyKey: b.slaPolicyKey });
  } else if (stage.type === 'APPROVAL_LEVEL') {
    const l = stage.level!;
    const common = ['DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT'];
    if (l.kind === 'INDIVIDUAL') {
      await createTask(db, instance, stage, { name: `${l.name} ${l.isFinal ? 'approval' : 'recommendation'}`, role: l.role!, taskType: 'APPROVAL', actions: [l.isFinal ? 'APPROVE' : 'RECOMMEND', ...common], slaPolicyKey: stage.slaPolicyKey, authority: { level: l.code, limitMinor: l.effectiveLimitMinor, isFinal: l.isFinal } });
    } else {
      const com = await requireActive(db, 'committee', l.committeeKey!);
      const cp = com.payload as any;
      const members = await q<{ id: string }>(db, `SELECT DISTINCT u.id FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE r.role_code = ANY($1) AND u.status='ACTIVE' ORDER BY u.id`, [cp.memberRoles]);
      const t = await createTask(db, instance, stage, { name: `${cp.name} ${l.isFinal ? 'decision' : 'recommendation'}`, role: cp.memberRoles[0], taskType: 'COMMITTEE', actions: ['VOTE', 'REQUEST_CLARIFICATION', 'COMMENT'], slaPolicyKey: stage.slaPolicyKey, authority: { level: l.code, isFinal: l.isFinal, limitMinor: l.effectiveLimitMinor, members: members.map((m) => m.id) } });
      await q(db, `INSERT INTO committee_session(task_id, facility_id, committee_key, committee_config_id, rules, members) VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.id, instance.facility_id, cp.code, com.id, JSON.stringify({ quorum: cp.quorum, requiredApprovals: cp.requiredApprovals, requiredRoles: cp.requiredRoles, requiredRoleCounts: cp.requiredRoleCounts ?? {}, voting: cp.voting, serialOrder: cp.serialOrder, memberRoles: cp.memberRoles, recordedByRole: cp.recordedByRole ?? null }), members.map((m) => m.id)]);
      if (members.length < cp.quorum) await recordAction(db, instance, t.id, SYSTEM, 'COMMENT', `Warning: only ${members.length} eligible members are configured; quorum is ${cp.quorum}.`);
    }
  }
}

async function completeInstance(db: Db, instance: any, outcome: 'APPROVED' | 'DECLINED' | 'COMPLETED', actor: Actor, comment?: string) {
  await q(db, `UPDATE workflow_instance SET status=$2, outcome=$3, completed_at=now(), row_version=row_version+1 WHERE id=$1`, [instance.id, outcome === 'DECLINED' ? 'TERMINATED' : 'COMPLETED', outcome]);
  await q(db, `UPDATE workflow_task SET status='CANCELLED', completed_at=now() WHERE instance_id=$1 AND status IN ('OPEN','CLAIMED','WAITING')`, [instance.id]);
  if (instance.kind === 'CREDIT_APPROVAL') {
    if (outcome === 'DECLINED') {
      await setFacilityStatus(db, instance.facility_id, 'DECLINED', actor, { reason: comment, customerNote: 'Facility request not approved' });
      await emit(db, 'FACILITY_DECLINED', { facilityId: instance.facility_id });
    } else {
      await setFacilityStatus(db, instance.facility_id, 'APPROVED', actor, { customerNote: 'Facility approved' });
      const { onCreditApproved } = await import('../offers/service.js');
      await onCreditApproved(db, instance.facility_id, actor);
      await emit(db, 'FACILITY_APPROVED', { facilityId: instance.facility_id });
    }
  } else if (instance.kind === 'FULFILMENT' && outcome === 'COMPLETED') {
    await setFacilityStatus(db, instance.facility_id, 'READY_FOR_ACTIVATION', actor, { customerNote: 'Documentation complete; facility being set up' });
    await emit(db, 'FACILITY_READY', { facilityId: instance.facility_id });
  }
}

export async function recordAction(db: Db, instance: any, taskId: string | null, actor: Actor, action: string, comment?: string | null, payload: Record<string, unknown> = {}, extra: { idempotencyKey?: string; actorRole?: string; onBehalfOf?: string | null } = {}) {
  const f = await one<any>(db, 'SELECT amount_minor FROM facility_request WHERE id=$1', [instance.facility_id]);
  return one<any>(db, `INSERT INTO workflow_action(instance_id, task_id, facility_id, actor_type, actor_id, actor_name, actor_role, on_behalf_of, action, comment, payload, amount_minor_at_action, idempotency_key, ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [instance.id, taskId, instance.facility_id, actor.type === 'ANONYMOUS' ? 'SYSTEM' : actor.type, actor.id ?? null, actor.label ?? 'Gazelle system', extra.actorRole ?? null, extra.onBehalfOf ?? null, action, comment ?? null, JSON.stringify(payload), f.amount_minor, extra.idempotencyKey ?? null, actor.ip ?? null]);
}

// ---------------------------------------------------------------------------
// Start / resume
// ---------------------------------------------------------------------------
async function start(db: Db, facilityId: string, kind: 'CREDIT_APPROVAL' | 'FULFILMENT', actor: Actor) {
  const { facts } = await buildFacts(db, facilityId);
  const def = await chooseDefinition(db, kind, facts);
  const route = resolveStages(def.payload, facts);
  route.explanation.unshift(`Workflow "${def.title}" (version ${def.version}) selected.`);
  const instance = await one<any>(db, `INSERT INTO workflow_instance(facility_id, kind, definition_config_id, facts, route) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [facilityId, kind, def.id, JSON.stringify(facts), JSON.stringify(route)]);
  await recordAction(db, instance, null, actor, 'SUBMIT', null, { definition: def.key, version: def.version, explanation: route.explanation });
  await audit(db, actor, { action: 'WORKFLOW_STARTED', entityType: 'workflow_instance', entityId: instance.id, facilityId, metadata: { kind, definition: def.key, version: def.version } });
  if (kind === 'CREDIT_APPROVAL') await setFacilityStatus(db, facilityId, 'IN_REVIEW', actor, { customerNote: 'Under review by the Bank' });
  await openStage(db, instance, route, 0, actor);
  return instance;
}

export const startCreditWorkflow = (db: Db, facilityId: string, actor: Actor) => start(db, facilityId, 'CREDIT_APPROVAL', actor);
export const startFulfilmentWorkflow = (db: Db, facilityId: string, actor: Actor) => start(db, facilityId, 'FULFILMENT', actor);

/** Customer resubmitted after a return: resume at the returning stage (or restart), per definition. */
export async function resumeCreditWorkflow(db: Db, facilityId: string, actor: Actor) {
  const instance = await maybe<any>(db, `SELECT * FROM workflow_instance WHERE facility_id=$1 AND kind='CREDIT_APPROVAL' AND status='ACTIVE' FOR UPDATE`, [facilityId]);
  if (!instance) return startCreditWorkflow(db, facilityId, actor);
  const def = await getById<any>(db, instance.definition_config_id);
  const route: Route = instance.route;
  const at = def.payload.resumeAfterReturn === 'START' ? 0 : route.returnedAtIndex ?? instance.current_stage_index;
  route.returnedAtIndex = null;
  await q(db, 'UPDATE workflow_instance SET route=$2 WHERE id=$1', [instance.id, JSON.stringify(route)]);
  await q(db, `UPDATE rework_item SET resolved_at=now(), resolved_by_type=$2, resolved_by_id=$3 WHERE facility_id=$1 AND resolved_at IS NULL`, [facilityId, actor.type, actor.id ?? null]);
  await recordAction(db, instance, null, actor, 'RESUBMIT', null, { resumeAt: at });
  await openStage(db, instance, route, at, actor);
}

// ---------------------------------------------------------------------------
// Permissions on tasks
// ---------------------------------------------------------------------------
export async function effectiveRoles(db: Db, user: StaffPrincipal) {
  const dels = await q<{ role_code: string; from_user_id: string }>(db, `SELECT role_code, from_user_id FROM delegation WHERE to_user_id=$1 AND status='ACTIVE' AND now() BETWEEN starts_at AND ends_at`, [user.id]);
  return { own: new Set(user.roles), delegated: new Map(dels.map((d) => [d.role_code, d.from_user_id])) };
}

async function personalLimit(db: Db, userId: string, role: string) {
  const r = await maybe<{ limit_minor: number }>(db, `SELECT limit_minor FROM user_approval_limit WHERE user_id=$1 AND role_code=$2 AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now()) ORDER BY effective_from DESC LIMIT 1`, [userId, role]);
  return r?.limit_minor;
}

/** Actions this user may take on this task right now. Approve only appears within authority. */
export async function actionsFor(db: Db, user: StaffPrincipal, task: any): Promise<{ actions: string[]; onBehalfOf: string | null; notes: string[] }> {
  const notes: string[] = [];
  if (!['OPEN', 'CLAIMED'].includes(task.status)) return { actions: [], onBehalfOf: null, notes: ['This task is closed.'] };
  const roles = await effectiveRoles(db, user);
  const onBehalfOf = !roles.own.has(task.role_code) && roles.delegated.has(task.role_code) ? roles.delegated.get(task.role_code)! : null;
  if (task.task_type === 'COMMITTEE') {
    const s = await one<any>(db, 'SELECT * FROM committee_session WHERE task_id=$1', [task.id]);
    if (s.rules.recordedByRole && user.roles.includes(s.rules.recordedByRole) && !s.members.includes(user.id)) {
      return { actions: ['RECORD_DECISION', 'COMMENT'], onBehalfOf: null, notes: ['You may record the committee decision taken at its meeting, citing the minutes reference.'] };
    }
    if (!s.members.includes(user.id)) return { actions: [], onBehalfOf: null, notes: ['You are not a member of this committee.'] };
    const voted = await maybe(db, 'SELECT 1 FROM committee_vote WHERE session_id=$1 AND member_id=$2', [s.id, user.id]);
    return { actions: voted ? ['COMMENT', 'REQUEST_CLARIFICATION'] : task.permitted_actions, onBehalfOf: null, notes: voted ? ['You have voted.'] : [] };
  }
  if (!roles.own.has(task.role_code) && !onBehalfOf) return { actions: [], onBehalfOf: null, notes: ['This task requires a role you do not hold.'] };
  if (task.assigned_user_id && task.assigned_user_id !== user.id && task.assigned_user_id !== onBehalfOf) return { actions: [], onBehalfOf: null, notes: ['This task is assigned to another officer.'] };
  if (task.status === 'OPEN') return { actions: ['CLAIM'], onBehalfOf, notes: ['Claim the task to work on it.'] };
  if (task.claimed_by !== user.id) return { actions: [], onBehalfOf: null, notes: ['Another officer is working on this task.'] };
  let actions: string[] = [...task.permitted_actions, 'RELEASE'];
  if (actions.includes('APPROVE')) {
    const f = await one<any>(db, 'SELECT amount_minor, currency FROM facility_request WHERE id=$1', [task.facility_id]);
    const amount = await amountNgnMinor(db, f);
    const lim = await personalLimit(db, onBehalfOf ?? user.id, task.role_code);
    if (lim !== undefined && lim < amount) {
      actions = actions.map((a) => (a === 'APPROVE' ? 'RECOMMEND' : a));
      notes.push(`This facility exceeds your personal approval limit of ${formatMoney(lim)}. You may recommend it to the next authority or decline.`);
    }
  }
  // Segregation of duties: one person cannot make decisions at two stages of the same workflow.
  const prior = await maybe<any>(db, `SELECT stage_name FROM workflow_task WHERE instance_id=$1 AND completed_by=$2 AND id<>$3 AND outcome IN ('APPROVE','RECOMMEND','COMPLETE') AND stage_index<>$4 LIMIT 1`, [task.instance_id, user.id, task.id, task.stage_index]);
  if (prior) {
    actions = actions.filter((a) => !DECISION_ACTIONS.has(a));
    notes.push(`You already acted at "${prior.stage_name}". Segregation of duties prevents you deciding this stage.`);
  }
  return { actions, onBehalfOf, notes };
}

// ---------------------------------------------------------------------------
// Claiming (concurrency-safe)
// ---------------------------------------------------------------------------
export async function claimTask(db: Db, user: StaffPrincipal, actor: Actor, taskId: string) {
  const task = await maybe<any>(db, 'SELECT * FROM workflow_task WHERE id=$1', [taskId]);
  if (!task) throw notFound('Task');
  const { actions, onBehalfOf } = await actionsFor(db, user, task);
  if (!actions.includes('CLAIM')) {
    if (task.status === 'CLAIMED' && task.claimed_by !== user.id) throw conflict('ALREADY_CLAIMED', 'Another officer has already claimed this task.');
    throw forbidden('You cannot claim this task.');
  }
  // Atomic compare-and-set: only one concurrent claimant can win.
  const won = await maybe<any>(db, `UPDATE workflow_task SET status='CLAIMED', claimed_by=$2, claimed_at=now(), row_version=row_version+1 WHERE id=$1 AND status='OPEN' RETURNING *`, [taskId, user.id]);
  if (!won) throw conflict('ALREADY_CLAIMED', 'Another officer has already claimed this task.');
  await q(db, `INSERT INTO task_assignment_history(task_id, to_user_id, kind, actor_id, reason) VALUES ($1,$2,$3,$2,$4)`, [taskId, user.id, onBehalfOf ? 'DELEGATE' : 'CLAIM', onBehalfOf ? 'Claimed under delegated authority' : null]);
  const inst = await one<any>(db, 'SELECT * FROM workflow_instance WHERE id=$1', [task.instance_id]);
  await recordAction(db, inst, taskId, actor, 'CLAIM', null, {}, { actorRole: task.role_code, onBehalfOf });
  return won;
}

export async function releaseTask(db: Db, user: StaffPrincipal, actor: Actor, taskId: string) {
  const t = await maybe<any>(db, `UPDATE workflow_task SET status='OPEN', claimed_by=NULL, claimed_at=NULL, row_version=row_version+1 WHERE id=$1 AND status='CLAIMED' AND claimed_by=$2 RETURNING *`, [taskId, user.id]);
  if (!t) throw conflict('NOT_CLAIMED', 'You do not hold this task.');
  await q(db, `INSERT INTO task_assignment_history(task_id, from_user_id, kind, actor_id) VALUES ($1,$2,'RELEASE',$2)`, [taskId, user.id]);
  await recordAction(db, await one(db, 'SELECT * FROM workflow_instance WHERE id=$1', [t.instance_id]), taskId, actor, 'RELEASE');
  return t;
}

export async function reassignTask(db: Db, actor: Actor, taskId: string, toUserId: string, reason: string) {
  const t = await maybe<any>(db, 'SELECT * FROM workflow_task WHERE id=$1 FOR UPDATE', [taskId]);
  if (!t || !['OPEN', 'CLAIMED'].includes(t.status)) throw notFound('Task');
  if (t.task_type === 'COMMITTEE') throw conflict('COMMITTEE', 'Committee tasks cannot be reassigned.');
  const holder = await maybe(db, `SELECT 1 FROM app_user u JOIN user_role r ON r.user_id=u.id WHERE u.id=$1 AND r.role_code=$2 AND u.status='ACTIVE'`, [toUserId, t.role_code]);
  if (!holder) throw unprocessable('NOT_ELIGIBLE', 'The selected officer does not hold the role required for this task.');
  await q(db, `UPDATE workflow_task SET assigned_user_id=$2, claimed_by=$2, claimed_at=now(), status='CLAIMED', row_version=row_version+1 WHERE id=$1`, [taskId, toUserId]);
  await q(db, `INSERT INTO task_assignment_history(task_id, from_user_id, to_user_id, kind, reason, actor_id) VALUES ($1,$2,$3,'REASSIGN',$4,$5)`, [taskId, t.claimed_by ?? t.assigned_user_id, toUserId, reason, actor.id]);
  const inst = await one<any>(db, 'SELECT * FROM workflow_instance WHERE id=$1', [t.instance_id]);
  await recordAction(db, inst, taskId, actor, 'REASSIGN', reason, { toUserId });
  await audit(db, actor, { action: 'TASK_REASSIGNED', entityType: 'workflow_task', entityId: taskId, facilityId: t.facility_id, metadata: { from: t.claimed_by ?? t.assigned_user_id, to: toUserId, reason } });
  await emit(db, 'TASK_REASSIGNED', { facilityId: t.facility_id, taskId, assigneeIds: [toUserId], vars: { stageName: t.stage_name } });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export interface ActionInput {
  action: 'APPROVE' | 'RECOMMEND' | 'DECLINE' | 'RETURN' | 'REQUEST_CLARIFICATION' | 'COMMENT' | 'VOTE' | 'COMPLETE' | 'RECORD_DECISION';
  /** RECORD_DECISION: reference of the signed committee minutes. */
  minutesReference?: string;
  comment?: string;
  idempotencyKey: string;
  rowVersion?: number;
  returnTarget?: 'CUSTOMER' | 'RM' | 'PREVIOUS';
  reworkItems?: { section: string; message: string; targetRef?: string }[];
  vote?: 'APPROVE' | 'DECLINE' | 'ABSTAIN';
  conditions?: string[];
  clarification?: { toUserId?: string; toCustomer?: boolean; subject: string; message?: string };
}

export async function performAction(db: Db, user: StaffPrincipal, actor: Actor, taskId: string, input: ActionInput) {
  // Replay / double-submit protection.
  const prior = await maybe<any>(db, 'SELECT * FROM workflow_action WHERE idempotency_key=$1', [input.idempotencyKey]);
  if (prior) {
    if (prior.task_id !== taskId || prior.actor_id !== actor.id) throw conflict('IDEMPOTENCY_REUSED', 'This request key has already been used.');
    return { replayed: true, actionId: prior.id };
  }
  const task = await maybe<any>(db, 'SELECT * FROM workflow_task WHERE id=$1 FOR UPDATE', [taskId]);
  if (!task) throw notFound('Task');
  const instance = await one<any>(db, 'SELECT * FROM workflow_instance WHERE id=$1 FOR UPDATE', [task.instance_id]);
  if (instance.status !== 'ACTIVE') throw conflict('WORKFLOW_CLOSED', 'This workflow is no longer active.');
  if (input.rowVersion !== undefined && input.rowVersion !== task.row_version) throw conflict('STALE', 'This task has changed. Reload and try again.');
  const { actions, onBehalfOf } = await actionsFor(db, user, task);
  if (!actions.includes(input.action)) throw forbidden(`"${input.action}" is not available to you on this task.`);
  const needsComment = ['DECLINE', 'RETURN', 'REQUEST_CLARIFICATION', 'COMMENT', 'RECORD_DECISION'].includes(input.action) || (input.action === 'VOTE' && input.vote === 'DECLINE');
  if (needsComment && (!input.comment || input.comment.trim().length < 5)) throw unprocessable('COMMENT_REQUIRED', 'A comment of at least 5 characters is required for this action.');
  const route: Route = instance.route;
  const stage = route.stages[task.stage_index]!;
  const branch = task.branch_key ? stage.branches?.find((b) => b.key === task.branch_key) : undefined;

  const onDecline = (branch?.onDecline ?? stage.onDecline ?? 'TERMINATE') as string;
  if (['COMPLETE', 'RECOMMEND', 'APPROVE'].includes(input.action) || (input.action === 'DECLINE' && onDecline === 'CONTINUE')) {
    const pre = (branch?.prerequisites ?? stage.prerequisites ?? []) as string[];
    const unmet = await unmetPrerequisites(db, pre, task.facility_id);
    if (unmet.length) throw unprocessable('PREREQUISITES', 'Complete the required items before finishing this task.', unmet);
  }
  const action = await recordAction(db, instance, taskId, actor, input.action, input.comment, { returnTarget: input.returnTarget, reworkItems: input.reworkItems, vote: input.vote, conditions: input.conditions, clarification: input.clarification ? { subject: input.clarification.subject, toUserId: input.clarification.toUserId, toCustomer: input.clarification.toCustomer } : undefined }, { idempotencyKey: input.idempotencyKey, actorRole: task.role_code, onBehalfOf });
  await audit(db, actor, { action: `WORKFLOW_${input.action}`, entityType: 'workflow_task', entityId: taskId, facilityId: task.facility_id, metadata: { stage: task.stage_key, actionId: action.id, onBehalfOf } });

  const closeTask = async (outcome: string) => {
    await q(db, `UPDATE workflow_task SET status='COMPLETED', outcome=$2, completed_at=now(), completed_by=$3, row_version=row_version+1 WHERE id=$1`, [taskId, outcome, user.id]);
    await q(db, `INSERT INTO sla_event(task_id, facility_id, kind, detail) VALUES ($1,$2,'COMPLETED',$3)`, [taskId, task.facility_id, JSON.stringify({ outcome, breached: !!task.breached_at })]);
  };

  switch (input.action) {
    case 'COMMENT':
      return { actionId: action.id };
    case 'REQUEST_CLARIFICATION': {
      const { openClarification } = await import('../threads/service.js');
      const thread = await openClarification(db, actor, { facilityId: task.facility_id, taskId, subject: input.clarification?.subject ?? 'Clarification requested', message: input.comment!, toUserId: input.clarification?.toUserId, toCustomer: input.clarification?.toCustomer });
      return { actionId: action.id, threadId: thread.id };
    }
    case 'DECLINE': {
      await closeTask('DECLINE');
      const def = await getById<any>(db, instance.definition_config_id);
      // A "not recommended" at a stage configured to continue (e.g. RM, E&S, credit analyst) is recorded and the request moves on.
      if (onDecline === 'CONTINUE' || (def.payload.declineBehaviour === 'CONTINUE_TO_FINAL' && !(stage.level?.isFinal))) {
        await advanceAfterTask(db, instance, route, task, actor);
      } else await completeInstance(db, instance, 'DECLINED', actor, input.comment);
      return { actionId: action.id };
    }
    case 'RETURN': {
      const targets = branch ? ['PREVIOUS', 'RM', 'CUSTOMER'] : stage.type === 'APPROVAL_LEVEL' ? ['PREVIOUS', 'RM'] : stage.returnTargets ?? ['PREVIOUS'];
      const target = input.returnTarget ?? targets[0];
      if (!target || !targets.includes(target)) throw unprocessable('RETURN_TARGET', `This stage can return to: ${targets.join(', ')}.`);
      await closeTask('RETURN');
      await q(db, `UPDATE workflow_task SET status='CANCELLED', completed_at=now() WHERE instance_id=$1 AND status IN ('OPEN','CLAIMED','WAITING') AND id<>$2`, [instance.id, taskId]);
      if (target === 'CUSTOMER') {
        if (!input.reworkItems?.length) throw unprocessable('REWORK_ITEMS', 'List exactly what the customer needs to address.');
        for (const it of input.reworkItems) await q(db, 'INSERT INTO rework_item(facility_id, task_id, section, target_ref, message, raised_by) VALUES ($1,$2,$3,$4,$5,$6)', [task.facility_id, taskId, it.section, it.targetRef ?? null, it.message, user.id]);
        route.returnedAtIndex = task.stage_index;
        await q(db, 'UPDATE workflow_instance SET route=$2 WHERE id=$1', [instance.id, JSON.stringify(route)]);
        await setFacilityStatus(db, task.facility_id, 'RETURNED', actor, { reason: input.comment, customerNote: 'Returned for your attention' });
        await emit(db, 'APPLICATION_RETURNED', { facilityId: task.facility_id });
      } else if (target === 'RM') {
        const c = await one<any>(db, 'SELECT c.relationship_manager_id FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [task.facility_id]);
        await createTask(db, instance, stage, { branchKey: 'REWORK', name: `Rework requested by ${task.stage_name}`, role: 'RM', taskType: 'REVIEW', actions: ['COMPLETE', 'COMMENT', 'REQUEST_CLARIFICATION'], slaPolicyKey: 'RM_REVIEW', assignedUserId: c.relationship_manager_id, authority: { reworkFor: task.stage_index, reason: input.comment } });
      } else {
        let prev = task.stage_index - 1;
        while (prev >= 0 && route.stages[prev]!.skipped) prev--;
        if (prev < 0) throw unprocessable('RETURN_TARGET', 'There is no earlier stage to return to.');
        await openStage(db, instance, route, prev, actor);
      }
      return { actionId: action.id };
    }
    case 'VOTE': {
      if (!input.vote) throw unprocessable('VOTE_REQUIRED', 'Select your vote.');
      const s = await one<any>(db, 'SELECT * FROM committee_session WHERE task_id=$1 FOR UPDATE', [taskId]);
      const votes = await q<any>(db, 'SELECT * FROM committee_vote WHERE session_id=$1 ORDER BY sequence_no', [s.id]);
      const memberRoles = await q<{ user_id: string; role_code: string }>(db, 'SELECT user_id, role_code FROM user_role WHERE user_id = ANY($1) AND role_code = ANY($2)', [s.members, s.rules.memberRoles]);
      const rolesOf = (id: string) => memberRoles.filter((m) => m.user_id === id).map((m) => m.role_code);
      const myRoles = rolesOf(user.id);
      // Record the most significant committee role the voter holds (required roles first).
      const myRole = myRoles.find((r) => s.rules.requiredRoles.includes(r)) ?? myRoles[0]!;
      if (s.rules.voting === 'SERIAL') {
        const order = [...s.members].sort((a: string, b: string) => {
          const ia = Math.min(...rolesOf(a).map((r) => { const i = s.rules.serialOrder.indexOf(r); return i < 0 ? 99 : i; }));
          const ib = Math.min(...rolesOf(b).map((r) => { const i = s.rules.serialOrder.indexOf(r); return i < 0 ? 99 : i; }));
          return ia - ib;
        });
        const next = order.find((m: string) => !votes.some((v) => v.member_id === m));
        if (next !== user.id) throw conflict('NOT_YOUR_TURN', 'Serial voting: it is not yet your turn to vote.');
      }
      await q(db, 'INSERT INTO committee_vote(session_id, member_id, member_role, vote, comment, sequence_no) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, user.id, myRole, input.vote, input.comment ?? null, votes.length + 1]);
      const all = [...votes, { member_id: user.id, member_role: myRole, vote: input.vote }];
      const decision = committeeDecision(s.rules, s.members.map((id: string) => ({ id, roles: rolesOf(id) })), all);
      if (decision === 'PENDING') return { actionId: action.id, committee: 'PENDING' };
      await q(db, `UPDATE committee_session SET status='DECIDED', decision=$2, decided_at=now() WHERE id=$1`, [s.id, decision]);
      await q(db, `UPDATE workflow_task SET status='COMPLETED', outcome=$2, completed_at=now(), completed_by=$3, row_version=row_version+1 WHERE id=$1`, [taskId, decision === 'APPROVED' ? (stage.level?.isFinal ? 'APPROVE' : 'RECOMMEND') : 'DECLINE', user.id]);
      await recordAction(db, instance, taskId, SYSTEM, decision === 'APPROVED' ? (stage.level?.isFinal ? 'APPROVE' : 'RECOMMEND') : 'DECLINE', `${s.committee_key} decision: ${decision} (${all.filter((v) => v.vote === 'APPROVE').length} approve / ${all.filter((v) => v.vote === 'DECLINE').length} decline / ${all.filter((v) => v.vote === 'ABSTAIN').length} abstain)`, { committee: s.committee_key });
      if (decision === 'DECLINED') await completeInstance(db, instance, 'DECLINED', actor, `${s.committee_key} declined`);
      else if (stage.level?.isFinal) await completeInstance(db, instance, 'APPROVED', actor);
      else await advanceAfterTask(db, instance, route, task, actor);
      return { actionId: action.id, committee: decision };
    }
    case 'RECORD_DECISION': {
      if (!input.vote || !['APPROVE', 'DECLINE'].includes(input.vote)) throw unprocessable('VOTE_REQUIRED', 'Record whether the committee approved or declined.');
      if (!input.minutesReference || input.minutesReference.trim().length < 3) throw unprocessable('MINUTES_REQUIRED', 'Cite the reference of the signed committee minutes.');
      const s = await one<any>(db, 'SELECT * FROM committee_session WHERE task_id=$1 FOR UPDATE', [taskId]);
      if (s.status === 'DECIDED') throw conflict('DECIDED', 'This committee decision has already been recorded.');
      const decision = input.vote === 'APPROVE' ? 'APPROVED' : 'DECLINED';
      const outcome = decision === 'APPROVED' ? (stage.level?.isFinal ? 'APPROVE' : 'RECOMMEND') : 'DECLINE';
      await q(db, `UPDATE committee_session SET status='DECIDED', decision=$2, decided_at=now() WHERE id=$1`, [s.id, decision]);
      await q(db, `UPDATE workflow_task SET status='COMPLETED', outcome=$2, completed_at=now(), completed_by=$3, row_version=row_version+1 WHERE id=$1`, [taskId, outcome, user.id]);
      await recordAction(db, instance, taskId, SYSTEM, outcome, `${s.committee_key} decision recorded by ${actor.label ?? 'Credit Operations'} from minutes ${input.minutesReference.trim()}: ${decision}`, { committee: s.committee_key, recorded: true, minutesReference: input.minutesReference.trim() });
      if (decision === 'DECLINED') await completeInstance(db, instance, 'DECLINED', actor, `${s.committee_key} declined`);
      else if (stage.level?.isFinal) await completeInstance(db, instance, 'APPROVED', actor);
      else await advanceAfterTask(db, instance, route, task, actor);
      return { actionId: action.id, committee: decision };
    }
    case 'APPROVE': {
      await closeTask('APPROVE');
      await completeInstance(db, instance, 'APPROVED', actor);
      return { actionId: action.id };
    }
    case 'RECOMMEND':
    case 'COMPLETE': {
      await closeTask(input.action);
      if (stage.type === 'APPROVAL_LEVEL' && stage.level?.isFinal && input.action === 'RECOMMEND') {
        // Final-level officer lacks personal authority: escalate to the next level in the matrix.
        await escalateBeyondFinal(db, instance, route, task, actor);
        return { actionId: action.id };
      }
      if (task.branch_key === 'REWORK') { await openStage(db, instance, route, task.stage_index, actor); return { actionId: action.id }; }
      await advanceAfterTask(db, instance, route, task, actor);
      return { actionId: action.id };
    }
  }
  return { actionId: action.id };
}

async function advanceAfterTask(db: Db, instance: any, route: Route, task: any, actor: Actor) {
  const stage = route.stages[task.stage_index]!;
  if (stage.type === 'PARALLEL') {
    const open = await maybe(db, `SELECT 1 FROM workflow_task WHERE instance_id=$1 AND stage_index=$2 AND status IN ('OPEN','CLAIMED','WAITING')`, [instance.id, task.stage_index]);
    if (open) return; // wait for the concurrent branch(es)
  }
  await openStage(db, instance, route, task.stage_index + 1, actor);
}

async function escalateBeyondFinal(db: Db, instance: any, route: Route, task: any, actor: Actor) {
  const authority = await getById<any>(db, instance.authority_config_id);
  const levels = authority.payload.levels;
  const cur = levels.findIndex((l: any) => l.code === route.stages[task.stage_index]!.level!.code);
  const next = levels.slice(cur + 1).find((l: any) => l.canBeFinal !== false);
  if (!next) throw unprocessable('NO_HIGHER_AUTHORITY', 'There is no higher approving authority configured.');
  route.stages[task.stage_index]!.level!.isFinal = false;
  const add: RouteStage = { index: task.stage_index + 1, key: next.code, name: next.name, type: 'APPROVAL_LEVEL', slaPolicyKey: next.slaPolicyKey, level: { code: next.code, name: next.name, kind: next.kind, role: next.role, committeeKey: next.committeeKey, effectiveLimitMinor: next.limitMinor, isFinal: true } };
  route.stages.splice(task.stage_index + 1, 0, add);
  route.stages.forEach((s, i) => (s.index = i));
  route.explanation.push(`Escalated to ${next.name}: the officer at ${levels[cur].name} recommended beyond their personal limit.`);
  await q(db, 'UPDATE workflow_instance SET route=$2 WHERE id=$1', [instance.id, JSON.stringify(route)]);
  await recordAction(db, instance, task.id, SYSTEM, 'ESCALATE', `Escalated to ${next.name} (authority)`);
  await openStage(db, instance, route, task.stage_index + 1, actor);
}
