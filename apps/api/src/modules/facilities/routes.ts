import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APPLICATION_STEPS, FACILITY_STATUS_LABEL } from '@gazelle/shared';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { conflict, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { nextRef } from '../../lib/ids.js';
import { formatMoney } from '../../lib/money.js';
import { audit } from '../audit/audit.js';
import { recordStep } from '../analytics/journey.js';
import { getActive, getById, listActive } from '../config/service.js';
import { DOC_SELECT, documentView, syncRequirements } from '../documents/service.js';
import { eligibilityView, runEligibility } from '../fipg/service.js';
import { emit } from '../notifications/service.js';
import { resumeCreditWorkflow, startCreditWorkflow } from '../workflow/engine.js';
import { loadFacility, resolveCustomer, staffCanSeeCustomer } from './access.js';
import { validateFacility } from './validation.js';

const STEP_KEYS = APPLICATION_STEPS.map((s) => s.key) as [string, ...string[]];
const EDITABLE = new Set(['DRAFT', 'RETURNED']);

const patchSchema = z.object({
  rowVersion: z.number().int().positive(),
  step: z.enum(STEP_KEYS).optional(),
  completeStep: z.boolean().default(false),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  amountMinor: z.number().int().positive().max(9_000_000_000_000_000).nullable().optional(),
  tenorMonths: z.number().int().positive().max(360).nullable().optional(),
  purpose: z.string().trim().max(2000).nullable().optional(),
  paymentStructure: z.string().trim().max(1000).nullable().optional(),
  paymentFrequency: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', 'BULLET']).nullable().optional(),
  sourceOfPayment: z.string().trim().max(2000).nullable().optional(),
  supplierName: z.string().trim().max(300).nullable().optional(),
  underlyingAsset: z.string().trim().max(2000).nullable().optional(),
  projectDetails: z.string().trim().max(4000).nullable().optional(),
  proposedSecurity: z.string().trim().max(2000).nullable().optional(),
  productFields: z.record(z.string().max(60), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])).optional(),
});
const COLS: Record<string, string> = { currency: 'currency', amountMinor: 'amount_minor', tenorMonths: 'tenor_months', purpose: 'purpose', paymentStructure: 'payment_structure', paymentFrequency: 'payment_frequency', sourceOfPayment: 'source_of_payment', supplierName: 'supplier_name', underlyingAsset: 'underlying_asset', projectDetails: 'project_details', proposedSecurity: 'proposed_security' };

export function facilitySummary(f: any) {
  return {
    id: f.id, ref: f.facility_ref, customerId: f.customer_id, customerName: f.legal_name, productCode: f.product_code, productName: f.product_name,
    origin: f.origin, status: f.status, statusLabel: FACILITY_STATUS_LABEL[f.status] ?? f.status, currency: f.currency, amountMinor: f.amount_minor,
    amountText: f.amount_minor ? formatMoney(f.amount_minor, f.currency) : null, tenorMonths: f.tenor_months, currentStep: f.current_step, completedSteps: f.completed_steps,
    submittedAt: f.submitted_at, decidedAt: f.decided_at, createdAt: f.created_at, updatedAt: f.updated_at, rowVersion: f.row_version, isDemo: f.is_demo,
  };
}

/** Who currently has the application, and what happens next — in customer-safe language. */
async function customerProgress(db: ReturnType<typeof getPool>, f: any) {
  const stage = await maybe<any>(db, `SELECT stage_key, stage_name FROM workflow_task WHERE facility_id=$1 AND status IN ('OPEN','CLAIMED') ORDER BY created_at LIMIT 1`, [f.id]);
  const map: Record<string, [string, string]> = {
    DRAFT: ['You', 'Complete each section and submit your request.'],
    RETURNED: ['You', 'Review the items flagged by the Bank, update them, and resubmit.'],
    SUBMITTED: ['Relationship Manager', 'Your relationship manager will review your request.'],
    IN_REVIEW: [stage ? (stage.stage_key.startsWith('RM') ? 'Relationship Manager' : stage.stage_key.startsWith('BM') || stage.stage_key.startsWith('RBE') || stage.stage_key.startsWith('DH') ? 'Business banking team' : stage.stage_key === 'APPROVAL' || /^(CRO|ED|MD|MIC|BCC|BOARD)/.test(stage.stage_key) ? 'Approving authority' : 'Credit Risk team') : 'Alternative Bank', 'The Bank is assessing your request. You will be notified if anything is needed from you.'],
    APPROVED: ['Alternative Bank', 'Your offer letter is being prepared.'],
    OFFER_ISSUED: ['You', 'Review the offer letter and accept, reject or request changes.'],
    IN_NEGOTIATION: ['Alternative Bank', 'The Bank is considering the changes you requested.'],
    OFFER_ACCEPTED: ['Alternative Bank', 'Legal and Shariah documentation is being prepared.'],
    FULFILMENT: ['Alternative Bank', 'Documentation and conditions precedent are being completed.'],
    READY_FOR_ACTIVATION: ['Credit Operations', 'Your facility is being set up.'],
    ACTIVE: ['—', 'Your facility is active.'],
    DECLINED: ['—', 'Your relationship manager will contact you to discuss the outcome.'],
  };
  const [holder, next] = map[f.status] ?? ['Alternative Bank', 'The Bank is processing your request.'];
  return { currentlyWith: holder, nextStep: next };
}

export async function facilityRoutes(app: FastifyInstance) {
  const db = getPool();

  app.get('/api/products', async (req, reply) => {
    const isCustomer = req.auth?.subjectType === 'CUSTOMER';
    if (!req.auth) throw unauthorized();
    if (!isCustomer) requireStaff(req);
    const rows = await listActive(db, 'product');
    return ok(reply, rows.filter((r) => !isCustomer || r.payload.customerSelectable).map((r) => ({ configId: r.id, version: r.version, ...r.payload })));
  });

  app.post('/api/facilities', async (req, reply) => {
    const body = parse(z.object({ productCode: z.string().max(60), idempotencyKey: z.string().min(8).max(100), customerId: z.uuid().optional() }), req.body);
    const isStaff = req.auth?.subjectType === 'STAFF';
    if (isStaff) requireStaff(req, 'facility.initiate');
    const cid = await resolveCustomer(db, req, isStaff ? body.customerId : undefined, isStaff);
    const product = await getActive(db, 'product', body.productCode);
    if (!product || (!isStaff && !product.payload.customerSelectable)) throw unprocessable('PRODUCT', 'This product is not available.');
    const actor = actorOf(req);
    const res = await tx(async (c) => {
      const existing = await maybe<any>(c, 'SELECT id FROM facility_request WHERE customer_id=$1 AND idempotency_key=$2', [cid, body.idempotencyKey]);
      if (existing) return { id: existing.id, created: false };
      const cust = await one<any>(c, 'SELECT * FROM customer WHERE id=$1', [cid]);
      const prof = await maybe<any>(c, 'SELECT version FROM business_profile WHERE customer_id=$1', [cid]);
      const f = await one<any>(c, `INSERT INTO facility_request(facility_ref, customer_id, product_code, product_config_id, origin, currency, initiated_by_type, initiated_by_id, idempotency_key, current_step, completed_steps, is_contingent, profile_version, is_demo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DETAILS','{PRODUCT}',$10,$11,$12) RETURNING *`,
        [await nextRef(c, 'FAC'), cid, product.key, product.id, isStaff ? 'RM' : 'CUSTOMER', product.payload.currencies[0], actor.type, actor.id, body.idempotencyKey, product.payload.category === 'CONTINGENT', prof?.version ?? null, cust.is_demo]);
      await q(c, `INSERT INTO facility_status_history(facility_id, to_status, actor_type, actor_id, customer_visible_note) VALUES ($1,'DRAFT',$2,$3,'Facility request started')`, [f.id, actor.type, actor.id]);
      await recordStep(c, 'FACILITY_APPLICATION', f.id, cid, 'PRODUCT', 'COMPLETED');
      await recordStep(c, 'FACILITY_APPLICATION', f.id, cid, 'DETAILS', 'ENTERED');
      await audit(c, actor, { action: 'FACILITY_CREATED', entityType: 'facility_request', entityId: f.id, facilityId: f.id, customerId: cid, after: { ref: f.facility_ref, product: product.key, productVersion: product.version, origin: f.origin } });
      await emit(c, 'APPLICATION_CREATED', { facilityId: f.id, vars: { productName: product.payload.name } });
      return { id: f.id, created: true };
    });
    const f = await one<any>(db, 'SELECT f.*, c.legal_name FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [res.id]);
    return ok(reply, { ...facilitySummary({ ...f, product_name: product.payload.name }), created: res.created }, res.created ? 201 : 200);
  });

  app.get('/api/facilities', async (req, reply) => {
    const qs = parse(z.object({ status: z.string().max(40).optional(), customerId: z.uuid().optional(), search: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const a = req.auth;
    if (!a) throw unauthorized();
    const where: string[] = []; const vals: unknown[] = [];
    if (a.subjectType === 'CUSTOMER') { vals.push(a.customer!.customerId); where.push(`f.customer_id=$${vals.length}`); }
    else {
      const s = requireStaff(req);
      if (qs.customerId) { if (!(await staffCanSeeCustomer(db, s, qs.customerId))) throw notFound('Customer'); vals.push(qs.customerId); where.push(`f.customer_id=$${vals.length}`); }
      if (!s.permissions.has('facility.view.all')) {
        vals.push(s.id); const me = vals.length; vals.push(s.businessUnit);
        where.push(s.roles.every((r) => r === 'RM') ? `c.relationship_manager_id=$${me}` : `(c.relationship_manager_id=$${me} OR c.business_unit_code=$${vals.length})`);
      } else { vals.push(s.id); where.push(`(f.status <> 'DRAFT' OR c.relationship_manager_id=$${vals.length})`); }
    }
    if (qs.status) { vals.push(qs.status.split(',')); where.push(`f.status = ANY($${vals.length})`); }
    if (qs.search) { vals.push(`%${qs.search.replace(/[%_\\]/g, (m) => '\\' + m)}%`); where.push(`(f.facility_ref ILIKE $${vals.length} OR c.legal_name ILIKE $${vals.length})`); }
    vals.push(qs.limit);
    const rows = await q(db, `SELECT f.*, c.legal_name, ci.payload->>'name' AS product_name FROM facility_request f JOIN customer c ON c.id=f.customer_id JOIN config_item ci ON ci.id=f.product_config_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.updated_at DESC LIMIT $${vals.length}`, vals);
    return ok(reply, rows.map(facilitySummary));
  });

  app.get('/api/facilities/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const f0 = await loadFacility(db, req, id);
    const isCustomer = req.auth!.subjectType === 'CUSTOMER';
    const f = await one<any>(db, 'SELECT f.*, c.legal_name FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [f0.id]);
    const product = await getById<any>(db, f.product_config_id);
    const docs = await q(db, `${DOC_SELECT} WHERE d.facility_id=$1 AND d.deleted_at IS NULL ${isCustomer ? 'AND d.customer_visible' : ''} ORDER BY d.mandatory DESC, d.created_at`, [f.id]);
    const ev = await maybe<{ id: string }>(db, 'SELECT id FROM eligibility_evaluation WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [f.id]);
    const rework = await q(db, `SELECT id, section, target_ref AS "targetRef", message, customer_response AS "customerResponse", raised_at AS "raisedAt", resolved_at AS "resolvedAt" FROM rework_item WHERE facility_id=$1 ORDER BY raised_at DESC`, [f.id]);
    const history = await q(db, `SELECT h.from_status, h.to_status, h.created_at, h.customer_visible_note, h.reason, h.actor_type, COALESCE(u.display_name, cu.full_name, 'Gazelle') AS actor_name
      FROM facility_status_history h LEFT JOIN app_user u ON u.id=h.actor_id LEFT JOIN customer_user cu ON cu.id=h.actor_id WHERE h.facility_id=$1 ORDER BY h.created_at`, [f.id]);
    const issues = EDITABLE.has(f.status) ? validateFacility(product.payload, f) : [];
    return ok(reply, {
      facility: { ...facilitySummary({ ...f, product_name: product.payload.name }), purpose: f.purpose, paymentStructure: f.payment_structure, paymentFrequency: f.payment_frequency, sourceOfPayment: f.source_of_payment, supplierName: f.supplier_name, underlyingAsset: f.underlying_asset, projectDetails: f.project_details, proposedSecurity: f.proposed_security, productFields: f.product_fields },
      product: { configId: product.id, version: product.version, ...product.payload },
      steps: APPLICATION_STEPS.map((s) => ({ ...s, completed: f.completed_steps.includes(s.key), issues: issues.filter((i) => i.step === s.key).length })),
      issues,
      documents: docs.map((d) => documentView(d, isCustomer ? 'CUSTOMER' : 'STAFF')),
      eligibility: ev ? await eligibilityView(db, ev.id, isCustomer ? 'CUSTOMER' : 'STAFF') : null,
      rework,
      progress: await customerProgress(db, f),
      timeline: history.map((h: any) => isCustomer
        ? { status: FACILITY_STATUS_LABEL[h.to_status] ?? h.to_status, at: h.created_at, note: h.customer_visible_note }
        : { from: h.from_status, to: h.to_status, at: h.created_at, actor: h.actor_name, actorType: h.actor_type, reason: h.reason, customerNote: h.customer_visible_note }),
    });
  });

  app.patch('/api/facilities/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(patchSchema, req.body);
    const actor = actorOf(req);
    if (req.auth?.subjectType === 'STAFF') requireStaff(req, 'facility.initiate');
    const out = await tx(async (c) => {
      const f = await loadFacility(c, req, id, { forUpdate: true });
      if (!EDITABLE.has(f.status)) throw conflict('NOT_EDITABLE', 'This request can no longer be edited.');
      if (f.row_version !== body.rowVersion) throw conflict('STALE', 'This request was changed elsewhere. Reload to see the latest version.');
      const product = await getById<any>(c, f.product_config_id);
      const sets: string[] = []; const vals: unknown[] = [f.id];
      const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COLS)) {
        const v = (body as any)[k];
        if (v === undefined) continue;
        if (String(f[col]) !== String(v)) { before[k] = f[col]; after[k] = v; }
        vals.push(v); sets.push(`${col}=$${vals.length}`);
      }
      if (body.productFields) {
        const merged = { ...f.product_fields, ...body.productFields };
        for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
        vals.push(JSON.stringify(merged)); sets.push(`product_fields=$${vals.length}`);
        after.productFields = Object.keys(body.productFields);
      }
      const steps = new Set<string>(f.completed_steps);
      if (body.step) {
        if (body.completeStep) {
          const stepIssues = validateFacility(product.payload, { ...f, ...Object.fromEntries(Object.entries(COLS).filter(([k]) => (body as any)[k] !== undefined).map(([k, col]) => [col, (body as any)[k]])), product_fields: body.productFields ? { ...f.product_fields, ...body.productFields } : f.product_fields }).filter((i) => i.step === body.step);
          if (stepIssues.length) throw unprocessable('STEP_INCOMPLETE', 'Some fields in this section need attention.', stepIssues);
          if (!steps.has(body.step)) { steps.add(body.step); await recordStep(c, 'FACILITY_APPLICATION', f.id, f.customer_id, body.step, 'COMPLETED'); }
          const next = STEP_KEYS[STEP_KEYS.indexOf(body.step) + 1];
          if (next && next !== f.current_step) { await recordStep(c, 'FACILITY_APPLICATION', f.id, f.customer_id, next, 'ENTERED'); vals.push(next); sets.push(`current_step=$${vals.length}`); }
        } else if (body.step !== f.current_step) { vals.push(body.step); sets.push(`current_step=$${vals.length}`); }
      }
      vals.push([...steps]); sets.push(`completed_steps=$${vals.length}`);
      const updated = await one<any>(c, `UPDATE facility_request SET ${sets.join(', ')}, row_version=row_version+1 WHERE id=$1 RETURNING *`, vals);
      if (Object.keys(after).length) await audit(c, actor, { action: 'FACILITY_UPDATED', entityType: 'facility_request', entityId: f.id, facilityId: f.id, customerId: f.customer_id, before, after });
      if (after.amountMinor !== undefined || after.currency !== undefined) await syncRequirements(c, f.id);
      if (body.step === 'DOCUMENTS' || body.step === 'SECURITY') await syncRequirements(c, f.id);
      return updated;
    });
    return ok(reply, { rowVersion: out.row_version, currentStep: out.current_step, completedSteps: out.completed_steps });
  });

  app.post('/api/facilities/:id/eligibility', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const f = await loadFacility(db, req, id);
    const actor = actorOf(req);
    const r = await tx(async (c) => {
      const res = await runEligibility(c, f.id, { type: actor.type, id: actor.id });
      await audit(c, actor, { action: 'ELIGIBILITY_EVALUATED', entityType: 'eligibility_evaluation', entityId: res.id, facilityId: f.id, customerId: f.customer_id, metadata: { outcome: res.outcome } });
      return res;
    });
    return ok(reply, await eligibilityView(db, r.id, req.auth!.subjectType === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF'));
  });

  app.post('/api/facilities/:id/submit', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ rowVersion: z.number().int(), declaration: z.literal(true, { error: 'Confirm the declaration to submit.' }) }), req.body);
    const actor = actorOf(req);
    if (req.auth?.subjectType === 'CUSTOMER' && !req.auth.customer!.emailVerified) throw unprocessable('EMAIL_UNVERIFIED', 'Verify your email address before submitting a request.');
    if (req.auth?.subjectType === 'STAFF') requireStaff(req, 'facility.initiate');
    const result = await tx(async (c) => {
      const f = await loadFacility(c, req, id, { forUpdate: true });
      if (!EDITABLE.has(f.status)) throw conflict('ALREADY_SUBMITTED', 'This request has already been submitted.');
      if (f.row_version !== body.rowVersion) throw conflict('STALE', 'This request was changed elsewhere. Reload to see the latest version.');
      const product = await getById<any>(c, f.product_config_id);
      const issues = validateFacility(product.payload, f);
      await syncRequirements(c, f.id);
      const missing = await q<any>(c, `SELECT title FROM document WHERE facility_id=$1 AND deleted_at IS NULL AND mandatory AND status IN ('REQUIRED','REJECTED','EXPIRED')`, [f.id]);
      for (const m of missing) issues.push({ step: 'DOCUMENTS', field: 'documents', message: `${m.title} is required.` });
      const openRework = await q<any>(c, 'SELECT section, message FROM rework_item WHERE facility_id=$1 AND resolved_at IS NULL AND customer_response IS NULL', [f.id]);
      if (f.status === 'RETURNED' && openRework.length) issues.push(...openRework.map((r) => ({ step: 'REVIEW', field: 'rework', message: `Respond to: ${r.message}` })));
      if (issues.length) throw unprocessable('INCOMPLETE', 'Your request is not yet complete.', issues);
      const elig = await runEligibility(c, f.id, { type: actor.type, id: actor.id });
      if (elig.outcome === 'INELIGIBLE') {
        await audit(c, actor, { action: 'SUBMISSION_BLOCKED_INELIGIBLE', entityType: 'facility_request', entityId: f.id, facilityId: f.id, customerId: f.customer_id, outcome: 'DENIED' });
        return { blocked: true as const, evaluationId: elig.id };
      }
      const resubmission = f.status === 'RETURNED';
      await q(c, `UPDATE facility_request SET status=$2, submitted_at=COALESCE(submitted_at, now()), row_version=row_version+1, completed_steps = array(SELECT DISTINCT unnest(completed_steps || '{REVIEW}'::text[])) WHERE id=$1`, [f.id, resubmission ? 'IN_REVIEW' : 'SUBMITTED']);
      await q(c, `INSERT INTO facility_status_history(facility_id, from_status, to_status, actor_type, actor_id, customer_visible_note) VALUES ($1,$2,$3,$4,$5,$6)`, [f.id, f.status, resubmission ? 'IN_REVIEW' : 'SUBMITTED', actor.type, actor.id, resubmission ? 'Request resubmitted after rework' : 'Request submitted']);
      await recordStep(c, 'FACILITY_APPLICATION', f.id, f.customer_id, 'REVIEW', 'COMPLETED');
      await audit(c, actor, { action: resubmission ? 'FACILITY_RESUBMITTED' : 'FACILITY_SUBMITTED', entityType: 'facility_request', entityId: f.id, facilityId: f.id, customerId: f.customer_id, metadata: { eligibility: elig.outcome, amountMinor: f.amount_minor } });
      if (resubmission) await resumeCreditWorkflow(c, f.id, actor);
      else await startCreditWorkflow(c, f.id, actor);
      await emit(c, 'APPLICATION_SUBMITTED', { facilityId: f.id, vars: { amount: formatMoney(f.amount_minor, f.currency) } });
      return { blocked: false as const, eligibility: elig.outcome };
    });
    if (result.blocked) {
      const view = await eligibilityView(db, result.evaluationId, req.auth!.subjectType === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF');
      throw unprocessable('INELIGIBLE', 'This request does not meet the Bank’s eligibility criteria.', view);
    }
    return ok(reply, { submitted: true, eligibility: result.eligibility });
  });

  app.post('/api/facilities/:id/withdraw', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    const actor = actorOf(req);
    await tx(async (c) => {
      const f = await loadFacility(c, req, id, { forUpdate: true });
      if (!['DRAFT', 'RETURNED', 'SUBMITTED', 'IN_REVIEW'].includes(f.status)) throw conflict('NOT_WITHDRAWABLE', 'This request can no longer be withdrawn.');
      await q(c, `UPDATE facility_request SET status='WITHDRAWN', row_version=row_version+1 WHERE id=$1`, [f.id]);
      await q(c, `UPDATE workflow_instance SET status='CANCELLED', outcome='WITHDRAWN', completed_at=now() WHERE facility_id=$1 AND status='ACTIVE'`, [f.id]);
      await q(c, `UPDATE workflow_task SET status='CANCELLED', completed_at=now() WHERE facility_id=$1 AND status IN ('OPEN','CLAIMED','WAITING')`, [f.id]);
      await q(c, `INSERT INTO facility_status_history(facility_id, from_status, to_status, actor_type, actor_id, reason, customer_visible_note) VALUES ($1,$2,'WITHDRAWN',$3,$4,$5,'Request withdrawn')`, [f.id, f.status, actor.type, actor.id, body.reason]);
      await audit(c, actor, { action: 'FACILITY_WITHDRAWN', entityType: 'facility_request', entityId: f.id, facilityId: f.id, customerId: f.customer_id, metadata: { reason: body.reason } });
    });
    return ok(reply, { withdrawn: true });
  });

  app.post('/api/facilities/:id/rework/:itemId/respond', async (req, reply) => {
    const { id, itemId } = parse(z.object({ id: z.string(), itemId: z.uuid() }), req.params);
    const body = parse(z.object({ response: z.string().trim().min(3).max(3000) }), req.body);
    const actor = actorOf(req);
    await tx(async (c) => {
      const f = await loadFacility(c, req, id, { forUpdate: true });
      if (f.status !== 'RETURNED') throw conflict('NOT_RETURNED', 'This request is not awaiting rework.');
      const r = await q(c, 'UPDATE rework_item SET customer_response=$3 WHERE id=$1 AND facility_id=$2 AND resolved_at IS NULL RETURNING id', [itemId, f.id, body.response]);
      if (!r.length) throw notFound('Rework item');
      await audit(c, actor, { action: 'REWORK_RESPONDED', entityType: 'rework_item', entityId: itemId, facilityId: f.id, customerId: f.customer_id });
    });
    return ok(reply, { responded: true });
  });
}
