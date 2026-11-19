import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { evaluate, validateCondition } from '@gazelle/shared';
import { env, integrationModes } from '../../config/env.js';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireAnyPerm, requireStaff } from '../../http/context.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { metrics } from '../../lib/metrics.js';
import { audit, verifyAuditChain } from '../audit/audit.js';
import { approve, createDraft, deactivate, getById, reject, submitDraft } from '../config/service.js';
import { CONFIG_KINDS, FACT_CATALOGUE, FACT_KEYS, KIND_LABEL, type ConfigKind } from '../config/schemas.js';
import { revokeAllFor } from '../identity/session.js';
import { issueStaffLink, localStaffAuth } from '../identity/staff-credentials.js';
import { loadFacility } from '../facilities/access.js';
import { buildFacts } from '../facilities/facts.js';

const configView = (r: any) => ({ id: r.id, kind: r.kind, key: r.key, version: r.version, status: r.status, title: r.title, payload: r.payload, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, changeReason: r.change_reason, createdBy: r.created_by_name ?? null, createdById: r.created_by ?? null, approvedBy: r.approved_by_name ?? null, approvedAt: r.approved_at, createdAt: r.created_at, rejectedReason: r.rejected_reason });
const CFG_SELECT = `SELECT ci.*, cu.display_name AS created_by_name, au.display_name AS approved_by_name FROM config_item ci LEFT JOIN app_user cu ON cu.id=ci.created_by LEFT JOIN app_user au ON au.id=ci.approved_by`;

export async function adminRoutes(app: FastifyInstance) {
  const db = getPool();

  // ---------------------------------------------------------------- configuration
  app.get('/api/admin/config/kinds', async (req, reply) => {
    requireStaff(req, 'config.view');
    const counts = await q<any>(db, `SELECT kind, count(*) FILTER (WHERE status='ACTIVE')::int AS active, count(*) FILTER (WHERE status='PENDING_APPROVAL')::int AS pending, count(*) FILTER (WHERE status='DRAFT')::int AS drafts FROM config_item GROUP BY kind`);
    return ok(reply, CONFIG_KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k], ...(counts.find((c) => c.kind === k) ?? { active: 0, pending: 0, drafts: 0 }) })));
  });
  app.get('/api/admin/config', async (req, reply) => {
    requireStaff(req, 'config.view');
    const qs = parse(z.object({ kind: z.enum(CONFIG_KINDS as [ConfigKind, ...ConfigKind[]]).optional(), status: z.string().max(40).optional(), key: z.string().max(80).optional() }), req.query);
    const where: string[] = []; const vals: unknown[] = [];
    if (qs.kind) { vals.push(qs.kind); where.push(`ci.kind=$${vals.length}`); }
    if (qs.key) { vals.push(qs.key); where.push(`ci.key=$${vals.length}`); }
    if (qs.status) { vals.push(qs.status.split(',')); where.push(`ci.status = ANY($${vals.length})`); }
    const rows = await q(db, `${CFG_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ci.kind, ci.key, ci.version DESC LIMIT 500`, vals);
    return ok(reply, rows.map(configView));
  });
  app.get('/api/admin/config/facts', async (req, reply) => { requireStaff(req, 'config.view'); return ok(reply, Object.entries(FACT_CATALOGUE).map(([fact, description]) => ({ fact, description }))); });
  app.get('/api/admin/config/:id', async (req, reply) => {
    requireStaff(req, 'config.view');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const r = await maybe(db, `${CFG_SELECT} WHERE ci.id=$1`, [id]);
    if (!r) throw notFound('Configuration');
    return ok(reply, configView(r));
  });
  app.post('/api/admin/config', async (req, reply) => {
    requireStaff(req, 'config.edit');
    const b = parse(z.object({ kind: z.enum(CONFIG_KINDS as [ConfigKind, ...ConfigKind[]]), key: z.string().min(2).max(80), title: z.string().trim().min(3).max(200), payload: z.unknown(), changeReason: z.string().trim().min(10).max(1000), effectiveFrom: z.iso.datetime().optional() }), req.body);
    const r = await tx((c) => createDraft(c, actorOf(req), b));
    return ok(reply, configView(r), 201);
  });
  for (const [path, perm, fn] of [
    ['submit', 'config.edit', (c: any, a: any, id: string) => submitDraft(c, a, id)],
    ['approve', 'config.approve', (c: any, a: any, id: string) => approve(c, a, id)],
  ] as const) {
    app.post(`/api/admin/config/:id/${path}`, async (req, reply) => {
      requireStaff(req, perm);
      const { id } = parse(z.object({ id: z.uuid() }), req.params);
      return ok(reply, configView(await tx((c) => fn(c, actorOf(req), id))));
    });
  }
  app.post('/api/admin/config/:id/reject', async (req, reply) => {
    requireStaff(req, 'config.approve');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(1000) }), req.body);
    return ok(reply, configView(await tx((c) => reject(c, actorOf(req), id, reason))));
  });
  app.post('/api/admin/config/:id/deactivate', async (req, reply) => {
    requireStaff(req, 'config.approve');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(1000) }), req.body);
    return ok(reply, configView(await tx((c) => deactivate(c, actorOf(req), id, reason))));
  });
  app.delete('/api/admin/config/:id', async (req, reply) => {
    requireStaff(req, 'config.edit');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const r = await getById(db, id);
    if (r.status !== 'DRAFT' || r.created_by !== req.auth!.subjectId) throw forbidden('Only your own drafts can be discarded.');
    await q(db, 'DELETE FROM config_item WHERE id=$1', [id]);
    await audit(db, actorOf(req), { action: 'CONFIG_DRAFT_DISCARDED', entityType: 'config_item', entityId: id });
    return ok(reply, { discarded: true });
  });
  /** Preview a condition against a real facility's facts before submitting a rule change. */
  app.post('/api/admin/config/preview-condition', async (req, reply) => {
    requireStaff(req, 'config.view');
    const b = parse(z.object({ condition: z.unknown(), facilityId: z.uuid().optional(), facts: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).refine((x) => x.facilityId || x.facts, 'Provide a facility or sample facts.'), req.body);
    const errs = validateCondition(b.condition, FACT_KEYS);
    if (errs.length) throw unprocessable('CONDITION_INVALID', 'The condition is not valid.', errs);
    // Against a real facility only if the administrator may see it; otherwise against supplied sample facts.
    const facts = b.facilityId ? (await buildFacts(db, (await loadFacility(db, req, b.facilityId)).id)).facts : b.facts!;
    return ok(reply, evaluate(b.condition as any, facts));
  });

  // ---------------------------------------------------------------- users & access
  app.get('/api/admin/users', async (req, reply) => {
    requireAnyPerm(req, ['user.manage', 'task.reassign']);
    const rows = await q(db, `SELECT u.id, u.ad_username AS username, u.display_name AS name, u.email, u.staff_number AS "staffNumber", u.directorate_code AS directorate, u.business_unit_code AS "businessUnit", u.status, u.mfa_enrolled_at IS NOT NULL AS "mfaEnrolled", u.last_login_at AS "lastLoginAt", u.is_demo AS "isDemo",
      COALESCE((SELECT array_agg(role_code ORDER BY role_code) FROM user_role WHERE user_id=u.id), '{}') AS roles,
      COALESCE((SELECT json_agg(json_build_object('role', role_code, 'limitMinor', limit_minor)) FROM user_approval_limit l WHERE l.user_id=u.id AND (effective_to IS NULL OR effective_to > now())), '[]') AS limits,
      COALESCE((SELECT array_agg(sector_code ORDER BY sector_code) FROM user_sector WHERE user_id=u.id), '{}') AS sectors
      FROM app_user u ORDER BY u.display_name`);
    return ok(reply, rows);
  });
  app.get('/api/admin/roles', async (req, reply) => {
    requireStaff(req, 'user.manage');
    return ok(reply, await q(db, `SELECT r.code, r.name, r.is_privileged AS privileged, COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions FROM role r LEFT JOIN role_permission rp ON rp.role_code=r.code GROUP BY r.code ORDER BY r.name`));
  });
  app.get('/api/admin/reference', async (req, reply) => {
    requireStaff(req);
    return ok(reply, { directorates: await q(db, 'SELECT code, name FROM directorate WHERE active ORDER BY name'), businessUnits: await q(db, 'SELECT code, name, directorate_code AS directorate FROM business_unit WHERE active ORDER BY name'), sectors: await q(db, 'SELECT code, name FROM sector WHERE active ORDER BY name') });
  });
  const userSchema = z.object({ username: z.string().trim().regex(/^[a-z0-9._-]{3,60}$/i), name: z.string().trim().min(3).max(120), email: z.email(), staffNumber: z.string().trim().max(40).optional(), directorate: z.string().max(40), businessUnit: z.string().max(40) });
  app.post('/api/admin/users', async (req, reply) => {
    requireStaff(req, 'user.manage');
    const b = parse(userSchema, req.body);
    const u = await tx(async (c) => {
      const r = await one<any>(c, `INSERT INTO app_user(ad_username, display_name, email, staff_number, directorate_code, business_unit_code, is_demo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [b.username, b.name, b.email.toLowerCase(), b.staffNumber ?? null, b.directorate, b.businessUnit, env().APP_ENV !== 'production']);
      await audit(c, actorOf(req), { action: 'USER_CREATED', entityType: 'app_user', entityId: r.id, after: b });
      return { ...r, link: localStaffAuth() ? await issueStaffLink(c, actorOf(req), r.id, 'ACTIVATE') : null };
    });
    if (u.link) await u.link.send();
    return ok(reply, { id: u.id, activationLinkSentTo: u.link?.sentTo ?? null }, 201);
  });
  app.patch('/api/admin/users/:uid', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { uid } = parse(z.object({ uid: z.uuid() }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(3).max(120).optional(), directorate: z.string().max(40).optional(), businessUnit: z.string().max(40).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(), reason: z.string().trim().min(5).max(500) }), req.body);
    if (uid === s.id && b.status && b.status !== 'ACTIVE') throw forbidden('You cannot deactivate your own account.');
    await tx(async (c) => {
      const before = await maybe<any>(c, 'SELECT display_name, directorate_code, business_unit_code, status FROM app_user WHERE id=$1 FOR UPDATE', [uid]);
      if (!before) throw notFound('User');
      await q(c, `UPDATE app_user SET display_name=COALESCE($2,display_name), directorate_code=COALESCE($3,directorate_code), business_unit_code=COALESCE($4,business_unit_code), status=COALESCE($5,status) WHERE id=$1`, [uid, b.name ?? null, b.directorate ?? null, b.businessUnit ?? null, b.status ?? null]);
      if (b.status && b.status !== 'ACTIVE') await revokeAllFor(c, 'STAFF', uid, 'user_deactivated');
      await audit(c, actorOf(req), { action: 'USER_UPDATED', entityType: 'app_user', entityId: uid, before, after: b });
    });
    return ok(reply, { updated: true });
  });
  /** Interim local sign-in: send an activation or reset link to the user's work e-mail. Administrators never see or set passwords. */
  app.post('/api/admin/users/:uid/credential-link', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    if (!localStaffAuth()) throw conflict('DIRECTORY_AUTH', 'Staff sign in with Active Directory; Gazelle passwords are not in use.');
    const { uid } = parse(z.object({ uid: z.uuid() }), req.params);
    const b = parse(z.object({ purpose: z.enum(['ACTIVATE', 'RESET']) }), req.body);
    if (uid === s.id) throw forbidden('Use “Change password” or the sign-in page for your own account.');
    if (!(await maybe(db, 'SELECT 1 FROM app_user WHERE id=$1', [uid]))) throw notFound('User');
    const link = await tx(async (c) => {
      const l = await issueStaffLink(c, actorOf(req), uid, b.purpose);
      if (b.purpose === 'RESET') { await q(c, 'UPDATE app_user SET password_hash=NULL WHERE id=$1', [uid]); await revokeAllFor(c, 'STAFF', uid, 'password_reset_by_admin'); }
      return l;
    });
    await link.send();
    return ok(reply, { sentTo: link.sentTo });
  });

  /** Role changes. Privileged roles need a second administrator (maker-checker). */
  app.post('/api/admin/users/:uid/roles', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { uid } = parse(z.object({ uid: z.uuid() }), req.params);
    const b = parse(z.object({ change: z.enum(['GRANT_ROLE', 'REVOKE_ROLE']), role: z.string().max(40), reason: z.string().trim().min(10).max(500) }), req.body);
    if (uid === s.id) throw forbidden('You cannot change your own roles.');
    const role = await maybe<any>(db, 'SELECT * FROM role WHERE code=$1', [b.role]);
    if (!role) throw notFound('Role');
    const r = await tx(async (c) => {
      if (role.is_privileged) {
        const cr = await one<any>(c, `INSERT INTO access_change_request(target_user_id, change, role_code, reason, maker_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [uid, b.change, b.role, b.reason, s.id]);
        await audit(c, actorOf(req), { action: 'PRIVILEGED_ACCESS_REQUESTED', entityType: 'access_change_request', entityId: cr.id, metadata: b });
        return { pendingApproval: true, requestId: cr.id };
      }
      if (b.change === 'GRANT_ROLE') await q(c, 'INSERT INTO user_role(user_id, role_code, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [uid, b.role, s.id]);
      else await q(c, 'DELETE FROM user_role WHERE user_id=$1 AND role_code=$2', [uid, b.role]);
      await revokeAllFor(c, 'STAFF', uid, 'roles_changed');
      await audit(c, actorOf(req), { action: b.change === 'GRANT_ROLE' ? 'ROLE_GRANTED' : 'ROLE_REVOKED', entityType: 'app_user', entityId: uid, metadata: b });
      return { pendingApproval: false };
    });
    return ok(reply, r);
  });
  app.get('/api/admin/access-requests', async (req, reply) => {
    requireStaff(req, 'user.manage');
    return ok(reply, await q(db, `SELECT a.id, a.change, a.role_code AS role, a.reason, a.status, a.created_at AS "createdAt", t.display_name AS target, m.display_name AS maker FROM access_change_request a JOIN app_user t ON t.id=a.target_user_id JOIN app_user m ON m.id=a.maker_id ORDER BY a.created_at DESC LIMIT 100`));
  });
  app.post('/api/admin/access-requests/:rid/decide', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { rid } = parse(z.object({ rid: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']) }), req.body);
    await tx(async (c) => {
      const r = await maybe<any>(c, 'SELECT * FROM access_change_request WHERE id=$1 FOR UPDATE', [rid]);
      if (!r || r.status !== 'PENDING') throw conflict('STATE', 'This request is not pending.');
      if (r.maker_id === s.id) throw forbidden('Maker-checker: you raised this request and cannot approve it.');
      if (r.target_user_id === s.id) throw forbidden('You cannot approve changes to your own access.');
      await q(c, `UPDATE access_change_request SET status=$2, checker_id=$3, decided_at=now() WHERE id=$1`, [rid, b.decision, s.id]);
      if (b.decision === 'APPROVED') {
        if (r.change === 'GRANT_ROLE') await q(c, 'INSERT INTO user_role(user_id, role_code, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.target_user_id, r.role_code, s.id]);
        else await q(c, 'DELETE FROM user_role WHERE user_id=$1 AND role_code=$2', [r.target_user_id, r.role_code]);
        await revokeAllFor(c, 'STAFF', r.target_user_id, 'roles_changed');
      }
      await audit(c, actorOf(req), { action: `PRIVILEGED_ACCESS_${b.decision}`, entityType: 'access_change_request', entityId: rid, metadata: { target: r.target_user_id, role: r.role_code, change: r.change } });
    });
    return ok(reply, { decided: true });
  });
  app.post('/api/admin/users/:uid/limits', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { uid } = parse(z.object({ uid: z.uuid() }), req.params);
    const b = parse(z.object({ role: z.string().max(40), limitMinor: z.number().int().min(0), reason: z.string().trim().min(10).max(500) }), req.body);
    if (uid === s.id) throw forbidden('You cannot set your own approval limit.');
    await tx(async (c) => {
      if (!(await maybe(c, 'SELECT 1 FROM user_role WHERE user_id=$1 AND role_code=$2', [uid, b.role]))) throw unprocessable('ROLE', 'The user does not hold this role.');
      await q(c, `UPDATE user_approval_limit SET effective_to=now() WHERE user_id=$1 AND role_code=$2 AND effective_to IS NULL`, [uid, b.role]);
      await q(c, `INSERT INTO user_approval_limit(user_id, role_code, limit_minor, set_by) VALUES ($1,$2,$3,$4)`, [uid, b.role, b.limitMinor, s.id]);
      await audit(c, actorOf(req), { action: 'APPROVAL_LIMIT_SET', entityType: 'app_user', entityId: uid, metadata: b });
    });
    return ok(reply, { set: true });
  });
  app.post('/api/admin/users/:uid/sectors', async (req, reply) => {
    requireStaff(req, 'user.manage');
    const { uid } = parse(z.object({ uid: z.uuid() }), req.params);
    const b = parse(z.object({ sectors: z.array(z.string().max(60)).max(50) }), req.body);
    await tx(async (c) => {
      await q(c, 'DELETE FROM user_sector WHERE user_id=$1', [uid]);
      for (const sc of b.sectors) await q(c, 'INSERT INTO user_sector(user_id, sector_code) VALUES ($1,$2)', [uid, sc]);
      await audit(c, actorOf(req), { action: 'USER_SECTORS_SET', entityType: 'app_user', entityId: uid, metadata: b });
    });
    return ok(reply, { set: true });
  });
  /** Assign a customer portfolio to an RM. */
  app.post('/api/admin/customers/:cid/relationship-manager', async (req, reply) => {
    requireStaff(req, 'user.manage');
    const { cid } = parse(z.object({ cid: z.uuid() }), req.params);
    const b = parse(z.object({ userId: z.uuid(), reason: z.string().trim().min(5).max(500) }), req.body);
    if (!(await maybe(db, `SELECT 1 FROM user_role WHERE user_id=$1 AND role_code='RM'`, [b.userId]))) throw unprocessable('NOT_RM', 'The selected user is not a Relationship Manager.');
    const before = await maybe<any>(db, 'SELECT relationship_manager_id FROM customer WHERE id=$1', [cid]);
    if (!before) throw notFound('Customer');
    await q(db, 'UPDATE customer SET relationship_manager_id=$2 WHERE id=$1', [cid, b.userId]);
    await audit(db, actorOf(req), { action: 'RM_ASSIGNED', entityType: 'customer', entityId: cid, customerId: cid, before, after: b });
    return ok(reply, { assigned: true });
  });
  app.get('/api/admin/customers', async (req, reply) => {
    requireAnyPerm(req, ['user.manage', 'customer.view.all']);
    return ok(reply, await q(db, `SELECT c.id, c.customer_ref AS ref, c.legal_name AS name, c.status, c.is_demo AS "isDemo", u.display_name AS rm, c.business_unit_code AS "businessUnit", (SELECT count(*)::int FROM facility_request f WHERE f.customer_id=c.id) AS facilities FROM customer c LEFT JOIN app_user u ON u.id=c.relationship_manager_id ORDER BY c.legal_name`));
  });

  // ---------------------------------------------------------------------------
  // PRD: block / unblock customers. Blocking applies at once (and ends live sessions); unblocking needs a checker.
  // ---------------------------------------------------------------------------
  app.post('/api/admin/customers/:cid/block', async (req, reply) => {
    const s = requireStaff(req, 'customer.block');
    const { cid } = parse(z.object({ cid: z.uuid() }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(10).max(500) }), req.body);
    const out = await tx(async (c) => {
      const cu = await maybe<any>(c, 'SELECT id, status FROM customer WHERE id=$1 FOR UPDATE', [cid]);
      if (!cu) throw notFound('Customer');
      if (cu.status === 'SUSPENDED') throw conflict('ALREADY_BLOCKED', 'This customer is already blocked.');
      await q(c, `UPDATE customer SET status='SUSPENDED' WHERE id=$1`, [cid]);
      const r = await one<any>(c, `INSERT INTO customer_block_request(customer_id, action, reason, status, requested_by) VALUES ($1,'BLOCK',$2,'APPLIED',$3) RETURNING id`, [cid, b.reason, s.id]);
      for (const u of await q<{ id: string }>(c, 'SELECT id FROM customer_user WHERE customer_id=$1', [cid])) await revokeAllFor(c, 'CUSTOMER', u.id, 'customer_blocked');
      await audit(c, actorOf(req), { action: 'CUSTOMER_BLOCKED', entityType: 'customer', entityId: cid, customerId: cid, metadata: { reason: b.reason, requestId: r.id } });
      return r;
    });
    return ok(reply, { blocked: true, requestId: out.id });
  });

  app.post('/api/admin/customers/:cid/unblock', async (req, reply) => {
    const s = requireStaff(req, 'customer.block');
    const { cid } = parse(z.object({ cid: z.uuid() }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(10).max(500) }), req.body);
    const cu = await maybe<any>(db, 'SELECT status FROM customer WHERE id=$1', [cid]);
    if (!cu) throw notFound('Customer');
    if (cu.status !== 'SUSPENDED') throw conflict('NOT_BLOCKED', 'This customer is not blocked.');
    const r = await one<any>(db, `INSERT INTO customer_block_request(customer_id, action, reason, status, requested_by) VALUES ($1,'UNBLOCK',$2,'PENDING',$3) RETURNING id`, [cid, b.reason, s.id]);
    await audit(db, actorOf(req), { action: 'CUSTOMER_UNBLOCK_REQUESTED', entityType: 'customer', entityId: cid, customerId: cid, metadata: { reason: b.reason, requestId: r.id } });
    return ok(reply, { requestId: r.id, status: 'PENDING' }, 201);
  });

  app.get('/api/admin/customer-block-requests', async (req, reply) => {
    requireStaff(req, 'customer.block');
    return ok(reply, await q(db, `SELECT r.id, r.customer_id AS "customerId", c.legal_name AS "customerName", r.action, r.reason, r.status, r.created_at AS "createdAt", u.display_name AS "requestedBy", d.display_name AS "decidedBy", r.decided_at AS "decidedAt"
      FROM customer_block_request r JOIN customer c ON c.id=r.customer_id JOIN app_user u ON u.id=r.requested_by LEFT JOIN app_user d ON d.id=r.decided_by ORDER BY r.created_at DESC LIMIT 200`));
  });

  app.post('/api/admin/customer-block-requests/:rid/decide', async (req, reply) => {
    const s = requireStaff(req, 'customer.block');
    const { rid } = parse(z.object({ rid: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(500).optional() }), req.body);
    await tx(async (c) => {
      const r = await maybe<any>(c, `SELECT * FROM customer_block_request WHERE id=$1 FOR UPDATE`, [rid]);
      if (!r || r.status !== 'PENDING') throw notFound('Pending request');
      if (r.requested_by === s.id) throw forbidden('Maker-checker: you cannot approve your own unblock request.');
      await q(c, `UPDATE customer_block_request SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [rid, b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', s.id]);
      if (b.decision === 'APPROVE') await q(c, `UPDATE customer SET status='ACTIVE' WHERE id=$1`, [r.customer_id]);
      await audit(c, actorOf(req), { action: b.decision === 'APPROVE' ? 'CUSTOMER_UNBLOCKED' : 'CUSTOMER_UNBLOCK_REJECTED', entityType: 'customer', entityId: r.customer_id, customerId: r.customer_id, metadata: { requestId: rid, note: b.note } });
    });
    return ok(reply, { decided: true });
  });

  /** PRD: export the list of users in Excel format for access review. */
  app.get('/api/admin/users/export.xlsx', async (req, reply) => {
    requireStaff(req, 'user.manage');
    const rows = await q<any>(db, `SELECT u.ad_username, u.display_name, u.email, u.staff_number, u.directorate_code, u.business_unit_code, u.status, u.mfa_enrolled_at IS NOT NULL AS mfa, u.last_login_at, u.is_demo,
      COALESCE((SELECT string_agg(role_code, ', ' ORDER BY role_code) FROM user_role WHERE user_id=u.id), '') AS roles,
      COALESCE((SELECT string_agg(role_code || ': ' || limit_minor/100, '; ') FROM user_approval_limit l WHERE l.user_id=u.id AND (effective_to IS NULL OR effective_to > now())), '') AS limits
      FROM app_user u ORDER BY u.display_name`);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Gazelle by Alternative Bank';
    const ws = wb.addWorksheet('Users');
    ws.columns = [
      { header: 'Username (AD)', key: 'ad_username', width: 22 }, { header: 'Name', key: 'display_name', width: 32 }, { header: 'E-mail', key: 'email', width: 30 },
      { header: 'Staff number', key: 'staff_number', width: 14 }, { header: 'Directorate', key: 'directorate_code', width: 12 }, { header: 'Business unit', key: 'business_unit_code', width: 16 },
      { header: 'Roles', key: 'roles', width: 36 }, { header: 'Personal approval limits (₦)', key: 'limits', width: 30 }, { header: 'Status', key: 'status', width: 10 },
      { header: 'MFA enrolled', key: 'mfa', width: 12 }, { header: 'Last sign-in', key: 'last_login_at', width: 20 }, { header: 'DEMO user', key: 'is_demo', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    // Cells are written as values, never formulas; text that looks like a formula is prefixed (CSV/Excel injection defence).
    const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    for (const r of rows) ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safe(v)])));
    await audit(db, actorOf(req), { action: 'USERS_EXPORTED', entityType: 'app_user', metadata: { rows: rows.length } });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="gazelle-users-${new Date().toISOString().slice(0, 10)}.xlsx"`).header('Cache-Control', 'no-store');
    return reply.send(buf);
  });

  /** Read-only staff directory for choosing colleagues (clarifications, delegations). No contact or access data. */
  app.get('/api/staff/directory', async (req, reply) => {
    requireAnyPerm(req, ['task.work', 'thread.participate']);
    return ok(reply, await q(db, `SELECT u.id, u.display_name AS name, u.business_unit_code AS "businessUnit", 'ACTIVE' AS status, COALESCE((SELECT array_agg(role_code ORDER BY role_code) FROM user_role WHERE user_id=u.id), '{}') AS roles FROM app_user u WHERE u.status='ACTIVE' ORDER BY u.display_name`));
  });

  /** Portfolio-scoped customer list (RM: own customers; BM/RBE/DH: business unit; bank-wide roles: all). */
  app.get('/api/customers', async (req, reply) => {
    const s = requireAnyPerm(req, ['customer.view.assigned', 'customer.view.all']);
    const all = s.permissions.has('customer.view.all');
    const onlyOwn = s.roles.every((r) => r === 'RM');
    const where = all ? '' : onlyOwn ? 'WHERE c.relationship_manager_id=$1' : 'WHERE (c.relationship_manager_id=$1 OR c.business_unit_code=$2)';
    return ok(reply, await q(db, `SELECT c.id, c.customer_ref AS ref, c.legal_name AS name, c.status, c.is_demo AS "isDemo", u.display_name AS rm, c.business_unit_code AS "businessUnit", (SELECT count(*)::int FROM facility_request f WHERE f.customer_id=c.id) AS facilities FROM customer c LEFT JOIN app_user u ON u.id=c.relationship_manager_id ${where} ORDER BY c.legal_name`, all ? [] : onlyOwn ? [s.id] : [s.id, s.businessUnit]));
  });

  // ---------------------------------------------------------------- delegation
  app.post('/api/delegations', async (req, reply) => {
    const s = requireStaff(req, 'task.work');
    const b = parse(z.object({ toUserId: z.uuid(), role: z.string().max(40), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), reason: z.string().trim().min(10).max(500) }), req.body);
    if (!s.roles.includes(b.role)) throw forbidden('You can delegate only a role you hold.');
    if (new Date(b.endsAt).getTime() - new Date(b.startsAt).getTime() > 31 * 86400_000) throw unprocessable('TOO_LONG', 'Delegations cannot exceed 31 days.');
    const r = await one<any>(db, `INSERT INTO delegation(from_user_id, to_user_id, role_code, starts_at, ends_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$1) RETURNING id`, [s.id, b.toUserId, b.role, b.startsAt, b.endsAt, b.reason]);
    await audit(db, actorOf(req), { action: 'DELEGATION_REQUESTED', entityType: 'delegation', entityId: r.id, metadata: b });
    return ok(reply, { id: r.id, status: 'PENDING' }, 201);
  });
  app.get('/api/delegations', async (req, reply) => {
    const s = requireStaff(req);
    const all = s.permissions.has('user.manage');
    return ok(reply, await q(db, `SELECT d.id, d.role_code AS role, d.starts_at AS "startsAt", d.ends_at AS "endsAt", d.reason, d.status, f.display_name AS "from", t.display_name AS "to" FROM delegation d JOIN app_user f ON f.id=d.from_user_id JOIN app_user t ON t.id=d.to_user_id ${all ? '' : 'WHERE d.from_user_id=$1 OR d.to_user_id=$1'} ORDER BY d.created_at DESC LIMIT 100`, all ? [] : [s.id]));
  });
  app.post('/api/delegations/:did/decide', async (req, reply) => {
    const s = requireStaff(req, 'user.manage');
    const { did } = parse(z.object({ did: z.uuid() }), req.params);
    const b = parse(z.object({ decision: z.enum(['ACTIVE', 'REJECTED', 'REVOKED']) }), req.body);
    const d = await maybe<any>(db, 'SELECT * FROM delegation WHERE id=$1', [did]);
    if (!d) throw notFound('Delegation');
    if (d.from_user_id === s.id || d.to_user_id === s.id) throw forbidden('You cannot approve a delegation involving yourself.');
    await q(db, 'UPDATE delegation SET status=$2, approved_by=$3 WHERE id=$1', [did, b.decision, s.id]);
    await audit(db, actorOf(req), { action: `DELEGATION_${b.decision}`, entityType: 'delegation', entityId: did });
    return ok(reply, { status: b.decision });
  });

  // ---------------------------------------------------------------- FX rates
  app.get('/api/admin/fx-rates', async (req, reply) => {
    requireStaff(req);
    return ok(reply, await q(db, `SELECT r.id, r.base_ccy AS base, r.quote_ccy AS quote, r.rate, r.rate_date AS "rateDate", r.source, u.display_name AS "enteredBy", r.created_at AS "createdAt" FROM fx_rate r LEFT JOIN app_user u ON u.id=r.entered_by ORDER BY rate_date DESC LIMIT 200`));
  });
  app.post('/api/admin/fx-rates', async (req, reply) => {
    requireStaff(req, 'config.edit');
    const b = parse(z.object({ base: z.string().regex(/^[A-Z]{3}$/), quote: z.literal('NGN').default('NGN'), rate: z.number().positive().max(1_000_000), rateDate: z.iso.date(), source: z.string().trim().min(3).max(120) }), req.body);
    if (b.base === 'NGN') throw badRequest('FX', 'Base currency must not be NGN.');
    const r = await one<any>(db, 'INSERT INTO fx_rate(base_ccy, quote_ccy, rate, rate_date, source, entered_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [b.base, b.quote, b.rate, b.rateDate, b.source, req.auth!.subjectId]);
    await audit(db, actorOf(req), { action: 'FX_RATE_RECORDED', entityType: 'fx_rate', entityId: r.id, after: b });
    return ok(reply, { id: r.id }, 201);
  });

  // ---------------------------------------------------------------- audit
  app.get('/api/admin/audit', async (req, reply) => {
    requireStaff(req, 'audit.view');
    const qs = parse(z.object({ facilityId: z.uuid().optional(), actorId: z.uuid().optional(), action: z.string().max(80).optional(), entityType: z.string().max(80).optional(), from: z.iso.date().optional(), to: z.iso.date().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const where: string[] = []; const vals: unknown[] = [];
    const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (qs.facilityId) add('facility_id=?', qs.facilityId);
    if (qs.actorId) add('actor_id=?', qs.actorId);
    if (qs.action) add('action=?', qs.action);
    if (qs.entityType) add('entity_type=?', qs.entityType);
    if (qs.from) add('occurred_at >= ?::date', qs.from);
    if (qs.to) add(`occurred_at < (?::date + 1)`, qs.to);
    vals.push(qs.limit);
    const rows = await q(db, `SELECT id, occurred_at AS at, actor_type AS "actorType", actor_label AS actor, action, entity_type AS "entityType", entity_id AS "entityId", facility_id AS "facilityId", outcome, ip::text AS ip, before_data AS before, after_data AS after, metadata, hash FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${vals.length}`, vals);
    await audit(db, actorOf(req), { action: 'AUDIT_LOG_VIEWED', entityType: 'audit_log', metadata: qs });
    return ok(reply, rows);
  });
  app.get('/api/admin/audit/verify', async (req, reply) => { requireStaff(req, 'audit.view'); return ok(reply, await verifyAuditChain(db)); });

  // ---------------------------------------------------------------- health & observability
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try { await q(db, 'SELECT 1'); return { status: 'ready' }; } catch { return reply.status(503).send({ status: 'unavailable' }); }
  });
  app.get('/internal/metrics', async (req, reply) => { requireStaff(req, 'system.health'); reply.header('Content-Type', 'text/plain; version=0.0.4'); return metrics.render(); });
  app.get('/api/admin/health', async (req, reply) => {
    requireStaff(req, 'system.health');
    const t0 = Date.now();
    await q(db, 'SELECT 1');
    const dbMs = Date.now() - t0;
    const jobs = await q(db, `SELECT queue, status, count(*)::int AS n FROM job GROUP BY queue, status ORDER BY queue`);
    const dead = await q(db, `SELECT id, queue, attempts, last_error AS "lastError", created_at AS "createdAt" FROM job WHERE status='DEAD' ORDER BY created_at DESC LIMIT 20`);
    const sla = await one(db, `SELECT count(*) FILTER (WHERE breached_at IS NOT NULL)::int AS breached, count(*) FILTER (WHERE warned_at IS NOT NULL AND breached_at IS NULL)::int AS warning, count(*)::int AS open FROM workflow_task WHERE status IN ('OPEN','CLAIMED')`);
    const migrations = await q(db, 'SELECT name, applied_at AS "appliedAt" FROM schema_migration ORDER BY name');
    const deliveries = await one(db, `SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending, count(*) FILTER (WHERE status='FAILED')::int AS failed FROM notification_delivery`);
    const lastStatement = await maybe(db, `SELECT max(updated_at) AS at FROM bank_statement WHERE status IN ('PARSED','NEEDS_REVIEW','VALIDATED')`);
    const ai = await one(db, `SELECT count(*)::int AS n, count(*) FILTER (WHERE review_status='PENDING_REVIEW')::int AS pending FROM ai_interaction WHERE created_at > now() - interval '7 days'`);
    const modes = integrationModes();
    return ok(reply, {
      environment: env().APP_ENV, checkedAt: new Date(), database: { ok: true, latencyMs: dbMs, migrations },
      integrations: Object.entries(modes).map(([name, mode]) => ({ name, mode, status: mode === 'mock' || mode === 'local' ? 'MOCK' : mode === 'off' ? 'DISABLED' : 'LIVE' })),
      jobs, deadLetters: dead, sla, notifications: deliveries, lastStatementProcessedAt: lastStatement?.at ?? null, ai,
      audit: await verifyAuditChain(db), http: metrics.snapshot(),
    });
  });
  app.post('/api/admin/jobs/:jid/retry', async (req, reply) => {
    requireStaff(req, 'system.health');
    const { jid } = parse(z.object({ jid: z.uuid() }), req.params);
    const r = await q(db, `UPDATE job SET status='QUEUED', attempts=0, run_after=now(), last_error=NULL WHERE id=$1 AND status='DEAD' RETURNING id`, [jid]);
    if (!r.length) throw notFound('Dead-letter job');
    await audit(db, actorOf(req), { action: 'JOB_RETRIED', entityType: 'job', entityId: jid });
    return ok(reply, { requeued: true });
  });

  // ---------------------------------------------------------------- data quality & reconciliation
  app.get('/api/admin/data-quality', async (req, reply) => {
    requireAnyPerm(req, ['system.health', 'report.view']);
    const checks: { code: string; title: string; severity: string; rows: any[] }[] = [];
    const add = async (code: string, title: string, severity: string, sql: string) => checks.push({ code, title, severity, rows: await q(db, sql) });
    await add('DUPLICATE_CUSTOMER', 'Possible duplicate customers (same TIN)', 'HIGH', `SELECT bp.tin AS key, array_agg(c.legal_name) AS customers FROM business_profile bp JOIN customer c ON c.id=bp.customer_id WHERE bp.tin IS NOT NULL GROUP BY bp.tin HAVING count(*) > 1`);
    await add('DUPLICATE_FACILITY', 'Possible duplicate facility requests (same customer, product and amount within 7 days)', 'MEDIUM', `SELECT a.facility_ref AS first, b.facility_ref AS second, c.legal_name AS customer FROM facility_request a JOIN facility_request b ON a.customer_id=b.customer_id AND a.product_code=b.product_code AND a.amount_minor=b.amount_minor AND a.id < b.id AND abs(extract(epoch from b.created_at-a.created_at)) < 604800 JOIN customer c ON c.id=a.customer_id WHERE a.status NOT IN ('WITHDRAWN','CANCELLED','DECLINED') AND b.status NOT IN ('WITHDRAWN','CANCELLED','DECLINED')`);
    await add('DUPLICATE_DOCUMENT', 'Identical files uploaded against different documents', 'LOW', `SELECT v.sha256 AS key, count(DISTINCT v.document_id)::int AS documents FROM document_version v GROUP BY v.sha256 HAVING count(DISTINCT v.document_id) > 1`);
    await add('MISSING_FINANCIAL_PERIOD', 'Customers with active requests and fewer than 3 audited years', 'MEDIUM', `SELECT c.legal_name AS customer, count(fs.id)::int AS audited_years FROM customer c JOIN facility_request f ON f.customer_id=c.id AND f.status IN ('SUBMITTED','IN_REVIEW') LEFT JOIN financial_statement fs ON fs.customer_id=c.id AND fs.statement_type='AUDITED' AND fs.deleted_at IS NULL GROUP BY c.legal_name HAVING count(fs.id) < 3`);
    await add('INCONSISTENT_CURRENCY', 'Facilities whose currency differs from all customer accounts', 'LOW', `SELECT f.facility_ref, f.currency FROM facility_request f WHERE f.status NOT IN ('DRAFT','WITHDRAWN') AND NOT EXISTS (SELECT 1 FROM customer_account a WHERE a.customer_id=f.customer_id AND a.currency=f.currency)`);
    await add('INVALID_AMOUNT', 'Submitted facilities outside their product amount limits', 'HIGH', `SELECT f.facility_ref, f.amount_minor FROM facility_request f JOIN config_item ci ON ci.id=f.product_config_id WHERE f.status <> 'DRAFT' AND (f.amount_minor < (ci.payload->>'minAmountMinor')::bigint OR f.amount_minor > (ci.payload->>'maxAmountMinor')::bigint)`);
    await add('STALE_DRAFT', 'Draft applications untouched for 30 days', 'LOW', `SELECT f.facility_ref, c.legal_name AS customer, f.updated_at FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.status='DRAFT' AND f.updated_at < now() - interval '30 days'`);
    await add('ORPHANED_TASK', 'Open tasks whose workflow is closed or facility is terminal', 'HIGH', `SELECT t.id, t.stage_key, f.facility_ref, w.status AS workflow_status FROM workflow_task t JOIN workflow_instance w ON w.id=t.instance_id JOIN facility_request f ON f.id=t.facility_id WHERE t.status IN ('OPEN','CLAIMED') AND (w.status <> 'ACTIVE' OR f.status IN ('DECLINED','WITHDRAWN','CANCELLED','CLOSED'))`);
    await add('ACCOUNT_RECONCILIATION', 'Facility accounts where outstanding exceeds disbursed', 'HIGH', `SELECT f.facility_ref, a.outstanding_minor, a.utilised_minor FROM facility_account a JOIN facility_request f ON f.id=a.facility_id WHERE a.outstanding_minor > a.utilised_minor`);
    await add('ACTIVE_WITHOUT_ACCOUNT', 'Active facilities without a booked account', 'HIGH', `SELECT f.facility_ref FROM facility_request f LEFT JOIN facility_account a ON a.facility_id=f.id WHERE f.status='ACTIVE' AND a.id IS NULL`);
    return ok(reply, checks.map((c) => ({ ...c, count: c.rows.length, rows: c.rows.slice(0, 50) })));
  });
}
