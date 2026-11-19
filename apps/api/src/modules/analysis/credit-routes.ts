import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireAnyPerm, requireStaff } from '../../http/context.js';
import { decryptField, hmac } from '../../lib/crypto.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { maskTail } from '../../lib/mask.js';
import { formatMoney } from '../../lib/money.js';
import { integrations } from '../../integrations/index.js';
import { IntegrationError } from '../../integrations/types.js';
import { audit } from '../audit/audit.js';
import { getActive, getById, listActive, requireActive } from '../config/service.js';
import { loadFacility } from '../facilities/access.js';
import { buildFacts, collateralSummary } from '../facilities/facts.js';
import { toNgn } from '../fx/service.js';
import { aggregateExposure, combinedRating, coverageOption, scoreQuestionnaire, type ExposureLine } from './risk-engine.js';

const idParam = z.object({ id: z.string() });

export async function creditRoutes(app: FastifyInstance) {
  const db = getPool();

  // -------------------------------------------------------------------------
  // Credit bureau
  // -------------------------------------------------------------------------
  app.post('/api/facilities/:id/bureau-checks', async (req, reply) => {
    requireStaff(req, 'bureau.request');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const b = parse(z.object({ subject: z.enum(['BUSINESS', 'PARTY']), partyId: z.uuid().optional() }), req.body);
    const bureau = integrations().bureau;
    const actor = actorOf(req);
    let subject: { kind: 'BUSINESS' | 'INDIVIDUAL'; name: string; idType: 'RC' | 'TIN' | 'BVN'; idValue: string; partyId?: string };
    if (b.subject === 'BUSINESS') {
      const p = await one<any>(db, 'SELECT registered_name, rc_number, tin FROM business_profile WHERE customer_id=$1', [f.customer_id]);
      if (!p.rc_number && !p.tin) throw unprocessable('NO_IDENTIFIER', 'The business profile has no RC number or TIN.');
      subject = { kind: 'BUSINESS', name: p.registered_name, idType: p.rc_number ? 'RC' : 'TIN', idValue: p.rc_number ?? p.tin };
    } else {
      const p = await maybe<any>(db, 'SELECT * FROM business_party WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL', [b.partyId, f.customer_id]);
      if (!p) throw notFound('Party');
      if (!p.bvn_enc) throw unprocessable('NO_BVN', 'This person has no BVN recorded.');
      subject = { kind: 'INDIVIDUAL', name: p.full_name, idType: 'BVN', idValue: decryptField(p.bvn_enc), partyId: p.id };
    }
    let report; let error: string | null = null;
    try {
      report = subject.kind === 'BUSINESS'
        ? await bureau.businessReport(subject.idType === 'RC' ? { rcNumber: subject.idValue, name: subject.name } : { tin: subject.idValue, name: subject.name })
        : await bureau.individualReport({ bvn: subject.idValue, name: subject.name });
    } catch (e) { error = e instanceof IntegrationError ? e.message : 'Bureau request failed'; }
    const row = await one<any>(db, `INSERT INTO bureau_check(facility_id, customer_id, subject_kind, party_id, subject_name, identifier_type, identifier_masked, provider, mode, status, provider_request_ref, report_reference, score, total_facilities, total_outstanding_minor, delinquent_facilities, worst_classification, summary, error, requested_by, responded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now()) RETURNING *`,
      [f.id, f.customer_id, subject.kind, subject.partyId ?? null, subject.name, subject.idType, maskTail(subject.idValue, 4), bureau.provider, bureau.mode, error ? 'FAILED' : report!.status, report?.providerRef ?? null, report?.reportReference ?? null, report?.score ?? null, report?.totalFacilities ?? null, report?.totalOutstandingMinor ?? null, report?.delinquentFacilities ?? null, report?.worstClassification ?? null, JSON.stringify(report?.summary ?? {}), error, actor.id]);
    void hmac;
    await audit(db, actor, { action: 'BUREAU_REQUESTED', entityType: 'bureau_check', entityId: row.id, facilityId: f.id, customerId: f.customer_id, outcome: error ? 'FAILURE' : 'SUCCESS', metadata: { provider: bureau.provider, mode: bureau.mode, identifierType: subject.idType, identifier: row.identifier_masked } });
    if (error) throw unprocessable('BUREAU_UNAVAILABLE', 'The credit bureau could not be reached. The request has been logged; try again later.');
    return ok(reply, bureauView(row), 201);
  });

  app.get('/api/facilities/:id/bureau-checks', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    return ok(reply, (await q(db, 'SELECT * FROM bureau_check WHERE facility_id=$1 ORDER BY requested_at DESC', [f.id])).map(bureauView));
  });

  // -------------------------------------------------------------------------
  // Exposure & Single Obligor Limit (backend-computed and enforced)
  // -------------------------------------------------------------------------
  app.post('/api/facilities/:id/exposure', async (req, reply) => {
    requireStaff(req, 'exposure.compute');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    return ok(reply, exposureView(await tx((c) => computeExposure(c, f.id, actorOf(req)))), 201);
  });

  app.get('/api/facilities/:id/exposure', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const e = await maybe(db, 'SELECT * FROM exposure_snapshot WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [f.id]);
    return ok(reply, e ? exposureView(e) : null);
  });

  // -------------------------------------------------------------------------
  // Collateral
  // -------------------------------------------------------------------------
  const colSchema = z.object({
    typeKey: z.string().max(60), ownerName: z.string().trim().min(2).max(200), description: z.string().trim().min(5).max(2000),
    currency: z.string().regex(/^[A-Z]{3}$/).default('NGN'), marketValueMinor: z.number().int().min(0),
    valuationDate: z.iso.date().nullable().optional(), valuationSource: z.string().trim().max(200).nullable().optional(),
    haircutPct: z.number().min(0).max(100).optional(), haircutOverrideReason: z.string().trim().min(10).max(500).optional(),
    expiryDate: z.iso.date().nullable().optional(), perfectionStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'PERFECTED', 'NOT_REQUIRED']).default('NOT_STARTED'),
    documentIds: z.array(z.uuid()).max(20).default([]),
  });

  async function saveCollateral(c: any, f: any, b: z.infer<typeof colSchema>, actor: any, existingId?: string) {
    const type = await getActive(c, 'collateral_type', b.typeKey);
    if (!type) throw unprocessable('COLLATERAL_TYPE', 'Select a valid collateral type.');
    const tp = type.payload as any;
    const haircut = b.haircutPct ?? tp.defaultHaircutPct;
    if (b.haircutPct !== undefined && b.haircutPct < tp.defaultHaircutPct && !b.haircutOverrideReason) throw unprocessable('HAIRCUT_REASON', `Reducing the haircut below the policy ${tp.defaultHaircutPct}% requires a justification.`);
    if (tp.requiresValuation && (!b.valuationDate || !b.valuationSource)) throw unprocessable('VALUATION', `${tp.name} requires a valuation date and source.`);
    for (const d of b.documentIds) if (!(await maybe(c, 'SELECT 1 FROM document WHERE id=$1 AND customer_id=$2', [d, f.customer_id]))) throw notFound('Document');
    const eligible = Math.round(b.marketValueMinor * (1 - haircut / 100));
    const conv = await toNgn(c, eligible, b.currency);
    const vals = [f.customer_id, f.id, b.typeKey, type.id, b.ownerName, b.description, b.currency, b.marketValueMinor, b.valuationDate ?? null, b.valuationSource ?? null, haircut, b.haircutOverrideReason ?? null, eligible, conv.rate?.id ?? null, conv.minor, b.expiryDate ?? null, b.perfectionStatus, b.documentIds, actor.type, actor.id];
    const row = existingId
      ? await one<any>(c, `UPDATE collateral SET type_key=$3, type_config_id=$4, owner_name=$5, description=$6, currency=$7, market_value_minor=$8, valuation_date=$9, valuation_source=$10, haircut_pct=$11, haircut_override_reason=$12, eligible_value_minor=$13, fx_rate_id=$14, eligible_value_ngn_minor=$15, expiry_date=$16, perfection_status=$17, document_ids=$18 WHERE id=$21 AND facility_id=$2 AND customer_id=$1 AND $19::text IS NOT NULL AND $20::uuid IS NOT NULL RETURNING *`, [...vals, existingId])
      : await one<any>(c, `INSERT INTO collateral(customer_id, facility_id, type_key, type_config_id, owner_name, description, currency, market_value_minor, valuation_date, valuation_source, haircut_pct, haircut_override_reason, eligible_value_minor, fx_rate_id, eligible_value_ngn_minor, expiry_date, perfection_status, document_ids, created_by_type, created_by_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, vals);
    await audit(c, actor, { action: existingId ? 'COLLATERAL_UPDATED' : 'COLLATERAL_ADDED', entityType: 'collateral', entityId: row.id, facilityId: f.id, customerId: f.customer_id, after: { type: b.typeKey, market: b.marketValueMinor, haircut, eligibleNgn: conv.minor, fxRateId: conv.rate?.id } });
    return row;
  }

  app.get('/api/collateral-types', async (req, reply) => {
    if (!req.auth) return reply.status(401).send();
    return ok(reply, (await listActive(db, 'collateral_type')).map((t) => ({ key: t.key, version: t.version, ...t.payload })));
  });

  app.get('/api/facilities/:id/collateral', async (req, reply) => {
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const s = await collateralSummary(db, f.id, f.amount_minor ?? 0, f.currency);
    const types = new Map((await listActive(db, 'collateral_type')).map((t) => [t.key, t.payload as any]));
    const now = new Date();
    return ok(reply, {
      coveragePct: s.coveragePct, eligibleNgnMinor: s.eligibleNgnMinor, isCashBacked: s.isCashBacked, cashCoveragePct: s.cashCoveragePct,
      items: s.items.map((r: any) => {
        const t = types.get(r.type_key);
        const stale = t?.valuationValidityMonths && r.valuation_date ? (now.getTime() - new Date(r.valuation_date).getTime()) / (30.44 * 86400_000) > t.valuationValidityMonths : false;
        return { id: r.id, typeKey: r.type_key, typeName: t?.name ?? r.type_key, ownerName: r.owner_name, description: r.description, currency: r.currency, marketValueMinor: r.market_value_minor, valuationDate: r.valuation_date, valuationSource: r.valuation_source, haircutPct: r.haircut_pct, haircutOverrideReason: r.haircut_override_reason, eligibleValueMinor: r.eligible_value_minor, eligibleValueNgnMinor: r.eligible_value_ngn_minor, expiryDate: r.expiry_date, perfectionStatus: r.perfection_status, documentIds: r.document_ids, valuationStale: stale, countsTowardsCoverage: t?.countsTowardsCoverage !== false };
      }),
    });
  });

  app.post('/api/facilities/:id/collateral', async (req, reply) => {
    requireStaff(req, 'collateral.edit');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const b = parse(colSchema, req.body);
    const row = await tx((c) => saveCollateral(c, f, b, actorOf(req)));
    return ok(reply, { id: row.id }, 201);
  });

  app.put('/api/facilities/:id/collateral/:cid', async (req, reply) => {
    requireStaff(req, 'collateral.edit');
    const { id, cid } = parse(z.object({ id: z.string(), cid: z.uuid() }), req.params);
    const f = await loadFacility(db, req, id);
    const b = parse(colSchema, req.body);
    if (!(await maybe(db, 'SELECT 1 FROM collateral WHERE id=$1 AND facility_id=$2 AND deleted_at IS NULL', [cid, f.id]))) throw notFound('Collateral');
    await tx((c) => saveCollateral(c, f, b, actorOf(req), cid));
    return ok(reply, { updated: true });
  });

  app.delete('/api/facilities/:id/collateral/:cid', async (req, reply) => {
    requireStaff(req, 'collateral.edit');
    const { id, cid } = parse(z.object({ id: z.string(), cid: z.uuid() }), req.params);
    const f = await loadFacility(db, req, id);
    const r = await q(db, 'UPDATE collateral SET deleted_at=now() WHERE id=$1 AND facility_id=$2 AND deleted_at IS NULL RETURNING id', [cid, f.id]);
    if (!r.length) throw notFound('Collateral');
    await audit(db, actorOf(req), { action: 'COLLATERAL_REMOVED', entityType: 'collateral', entityId: cid, facilityId: f.id });
    return ok(reply, { removed: true });
  });

  // -------------------------------------------------------------------------
  // Risk ratings (ORR / FRR / industry / collateral / combined) — versioned and immutable once submitted
  // -------------------------------------------------------------------------
  app.get('/api/facilities/:id/risk', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const prof = await maybe<any>(db, 'SELECT sector_code FROM business_profile WHERE customer_id=$1', [f.customer_id]);
    const cards = (await listActive(db, 'scorecard')).filter((c) => !(c.payload as any).sectors.length || (c.payload as any).sectors.includes(prof?.sector_code));
    const rows = await q<any>(db, `SELECT r.*, ci.key AS card_key, ci.version AS card_version, u.display_name AS assessed_by_name FROM risk_assessment r JOIN config_item ci ON ci.id=r.scorecard_config_id JOIN app_user u ON u.id=r.assessed_by WHERE r.facility_id=$1 AND r.status <> 'SUPERSEDED' ORDER BY r.created_at`, [f.id]);
    const col = await collateralSummary(db, f.id, f.amount_minor ?? 0, f.currency);
    return ok(reply, {
      scorecards: cards.map((c) => ({ configId: c.id, key: c.key, version: c.version, ...(c.payload as any) })),
      assessments: rows.map(riskView),
      suggestions: { COVERAGE: coverageOption(col.coveragePct), coveragePct: col.coveragePct },
    });
  });

  app.post('/api/facilities/:id/risk/:kind', async (req, reply) => {
    const s = requireStaff(req, 'risk.assess');
    const { id, kind } = parse(z.object({ id: z.string(), kind: z.enum(['ORR', 'INDUSTRY', 'COLLATERAL']) }), req.params);
    const b = parse(z.object({ scorecardConfigId: z.uuid(), answers: z.record(z.string().max(60), z.string().max(60)), submit: z.boolean().default(false) }), req.body);
    const f = await loadFacility(db, req, id);
    const card = await getById<any>(db, b.scorecardConfigId);
    if (card.kind !== 'scorecard' || card.payload.kind !== kind || !['ACTIVE', 'RETIRED'].includes(card.status)) throw unprocessable('SCORECARD', 'Select a valid scorecard.');
    const r = scoreQuestionnaire(card.payload, b.answers);
    if (b.submit && r.missing.length) throw unprocessable('INCOMPLETE', `Answer every question before submitting (${r.missing.length} outstanding).`, r.missing);
    const actor = actorOf(req);
    const row = await tx(async (c) => {
      await q(c, `DELETE FROM risk_assessment WHERE facility_id=$1 AND kind=$2 AND status='DRAFT'`, [f.id, kind]);
      if (b.submit) await q(c, `UPDATE risk_assessment SET status='SUPERSEDED' WHERE facility_id=$1 AND kind=$2 AND status='SUBMITTED'`, [f.id, kind]);
      const a = await one<any>(c, `INSERT INTO risk_assessment(facility_id, kind, scorecard_config_id, status, raw_score, normalised_score, grade, grade_description, inputs, breakdown, assessed_by, submitted_at)
        VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [f.id, kind, card.id, b.submit ? 'SUBMITTED' : 'DRAFT', r.score, r.grade, r.gradeDescription, JSON.stringify(b.answers), JSON.stringify(r.breakdown), s.id, b.submit ? new Date() : null]);
      if (b.submit) {
        await q(c, `UPDATE risk_assessment SET status='SUPERSEDED' WHERE facility_id=$1 AND kind='COMBINED' AND status='SUBMITTED'`, [f.id]);
        await audit(c, actor, { action: 'RISK_ASSESSMENT_SUBMITTED', entityType: 'risk_assessment', entityId: a.id, facilityId: f.id, metadata: { kind, scorecard: card.key, version: card.version, score: r.score, grade: r.grade } });
      }
      return a;
    });
    return ok(reply, riskView({ ...row, card_key: card.key, card_version: card.version }), 201);
  });

  /** FRR from the latest frozen financial analysis. */
  app.post('/api/facilities/:id/risk-frr', async (req, reply) => {
    const s = requireStaff(req, 'risk.assess');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const fa = await maybe<any>(db, 'SELECT * FROM financial_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [f.id]);
    if (!fa || fa.total_score === null) throw unprocessable('NO_ANALYSIS', 'Run the financial analysis first.');
    const model = await requireActive(db, 'rating_model', 'COMBINED');
    const { gradeFor } = await import('./risk-engine.js');
    const g = gradeFor(fa.total_score, (model.payload as any).frrGrades as { grade: string; minScore: number; description: string }[]);
    const row = await tx(async (c) => {
      await q(c, `UPDATE risk_assessment SET status='SUPERSEDED' WHERE facility_id=$1 AND kind IN ('FRR','COMBINED') AND status='SUBMITTED'`, [f.id]);
      const a = await one<any>(c, `INSERT INTO risk_assessment(facility_id, kind, scorecard_config_id, status, raw_score, normalised_score, grade, grade_description, inputs, breakdown, assessed_by, submitted_at)
        VALUES ($1,'FRR',$2,'SUBMITTED',$3,$3,$4,$5,$6,$7,$8, now()) RETURNING *`, [f.id, model.id, fa.total_score, g.grade, g.description, JSON.stringify({ financialAnalysisId: fa.id }), JSON.stringify(fa.summary.quality ?? []), s.id]);
      await audit(c, actorOf(req), { action: 'RISK_ASSESSMENT_SUBMITTED', entityType: 'risk_assessment', entityId: a.id, facilityId: f.id, metadata: { kind: 'FRR', score: fa.total_score, grade: g.grade, analysisId: fa.id } });
      return a;
    });
    return ok(reply, riskView({ ...row, card_key: model.key, card_version: model.version }), 201);
  });

  app.post('/api/facilities/:id/risk-combined', async (req, reply) => {
    const s = requireStaff(req, 'risk.assess');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const model = await requireActive(db, 'rating_model', 'COMBINED');
    const subs = await q<any>(db, `SELECT kind, normalised_score, id FROM risk_assessment WHERE facility_id=$1 AND status='SUBMITTED' AND kind <> 'COMBINED'`, [f.id]);
    const scores = Object.fromEntries(subs.map((x) => [x.kind, x.normalised_score]));
    const r = combinedRating(model.payload as any, scores);
    if (r.missing.length) throw unprocessable('COMPONENTS_MISSING', `Submit the ${r.missing.join(', ')} assessment(s) first.`, r.missing);
    const row = await tx(async (c) => {
      await q(c, `UPDATE risk_assessment SET status='SUPERSEDED' WHERE facility_id=$1 AND kind='COMBINED' AND status='SUBMITTED'`, [f.id]);
      const a = await one<any>(c, `INSERT INTO risk_assessment(facility_id, kind, scorecard_config_id, status, raw_score, normalised_score, grade, grade_description, inputs, breakdown, assessed_by, submitted_at)
        VALUES ($1,'COMBINED',$2,'SUBMITTED',$3,$3,$4,$5,$6,$7,$8, now()) RETURNING *`, [f.id, model.id, r.score, r.grade, `${r.description} — ${r.riskLevel.toLowerCase()} risk`, JSON.stringify({ componentAssessmentIds: subs.map((x) => x.id) }), JSON.stringify(r.components), s.id]);
      await audit(c, actorOf(req), { action: 'RISK_ASSESSMENT_SUBMITTED', entityType: 'risk_assessment', entityId: a.id, facilityId: f.id, metadata: { kind: 'COMBINED', score: r.score, grade: r.grade, modelVersion: model.version } });
      return a;
    });
    return ok(reply, riskView({ ...row, card_key: model.key, card_version: model.version }), 201);
  });

  // -------------------------------------------------------------------------
  // RARORAC
  // -------------------------------------------------------------------------
  app.post('/api/facilities/:id/rarorac', async (req, reply) => {
    const s = requireStaff(req, 'rarorac.compute');
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const b = parse(z.object({ proposedProfitRatePct: z.number().min(0).max(100), managementFeePct: z.number().min(0).max(10).default(1) }), req.body);
    const combined = await maybe<any>(db, `SELECT grade FROM risk_assessment WHERE facility_id=$1 AND kind='COMBINED' AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [f.id]);
    if (!combined) throw unprocessable('NO_RATING', 'Submit the combined risk rating before computing RARORAC.');
    const threshold = await requireActive(db, 'rarorac_threshold', 'STANDARD');
    const col = await collateralSummary(db, f.id, f.amount_minor, f.currency);
    const prof = await maybe<any>(db, 'SELECT sector_code FROM business_profile WHERE customer_id=$1', [f.customer_id]);
    const request = { facilityRef: f.facility_ref, product: f.product_code, amountMinor: f.amount_minor, currency: f.currency, tenorMonths: f.tenor_months, proposedProfitRatePct: b.proposedProfitRatePct, managementFeePct: b.managementFeePct, riskGrade: combined.grade, collateralCoveragePct: col.coveragePct, customerSector: prof?.sector_code ?? 'UNKNOWN', productCategory: (await getById<any>(db, f.product_config_id)).payload.category };
    const adapter = integrations().rarorac;
    let resp; let error: string | null = null;
    try { resp = await adapter.compute(request); } catch (e) { error = e instanceof IntegrationError ? e.message : 'RARORAC service error'; }
    const tp = threshold.payload as any;
    const basis = (await getById<any>(db, f.product_config_id)).payload.pricingBasis;
    // Rate floor depends on the pricing basis: fee floor for Kafalah, none for Qard, profit-rate floor otherwise.
    const rateOk = basis === 'FEE' ? b.proposedProfitRatePct >= (tp.minFeePct ?? 1) : basis === 'NONE' ? true : b.proposedProfitRatePct >= tp.minProfitRatePct;
    const within = resp ? resp.raroracPct >= tp.hurdlePct && rateOk : null;
    const row = await one<any>(db, `INSERT INTO rarorac_computation(facility_id, mode, provider, request, response, status, pricing_rate_pct, rarorac_pct, hurdle_pct, threshold_config_id, within_threshold, exception_required, provider_ref, error, requested_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [f.id, adapter.mode, adapter.provider, JSON.stringify(request), resp ? JSON.stringify(resp) : null, error ? 'FAILED' : 'COMPLETED', b.proposedProfitRatePct, resp?.raroracPct ?? null, tp.hurdlePct, threshold.id, within, within === false, resp?.providerRef ?? null, error, s.id]);
    await audit(db, actorOf(req), { action: 'RARORAC_COMPUTED', entityType: 'rarorac_computation', entityId: row.id, facilityId: f.id, outcome: error ? 'FAILURE' : 'SUCCESS', metadata: { mode: adapter.mode, rarorac: resp?.raroracPct, within } });
    if (error) throw unprocessable('RARORAC_UNAVAILABLE', 'The Risk Asset & Pricing Portal could not be reached. Try again later.');
    return ok(reply, raroracView(row), 201);
  });

  app.post('/api/rarorac/:rid/justify', async (req, reply) => {
    const s = requireStaff(req, 'rarorac.justify');
    const { rid } = parse(z.object({ rid: z.uuid() }), req.params);
    const b = parse(z.object({ justification: z.string().trim().max(3000) }), req.body);
    const r = await maybe<any>(db, 'SELECT * FROM rarorac_computation WHERE id=$1', [rid]);
    if (!r) throw notFound('RARORAC computation');
    await loadFacility(db, req, r.facility_id);
    if (!r.exception_required) throw conflict('NO_EXCEPTION', 'This computation is within threshold; no justification is needed.');
    if (r.justification) throw conflict('JUSTIFIED', 'A justification has already been recorded for this computation.');
    const t = await getById<any>(db, r.threshold_config_id);
    if (b.justification.length < t.payload.justificationMinLength) throw unprocessable('TOO_SHORT', `Provide at least ${t.payload.justificationMinLength} characters explaining the pricing exception.`);
    await q(db, 'UPDATE rarorac_computation SET justification=$2, justified_by=$3, justified_at=now() WHERE id=$1', [rid, b.justification, s.id]);
    await audit(db, actorOf(req), { action: 'RARORAC_EXCEPTION_JUSTIFIED', entityType: 'rarorac_computation', entityId: rid, facilityId: r.facility_id });
    return ok(reply, { justified: true });
  });

  app.get('/api/facilities/:id/rarorac', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    return ok(reply, (await q(db, `SELECT r.*, u.display_name AS justified_by_name FROM rarorac_computation r LEFT JOIN app_user u ON u.id=r.justified_by WHERE r.facility_id=$1 ORDER BY r.created_at DESC`, [f.id])).map(raroracView));
  });

  // -------------------------------------------------------------------------
  // Environmental & Social
  // -------------------------------------------------------------------------
  app.get('/api/facilities/:id/es', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const { facts, esTriggerConfigId } = await buildFacts(db, f.id);
    const trig = await getActive(db, 'es_trigger', 'STANDARD');
    let a = await maybe<any>(db, `SELECT * FROM es_assessment WHERE facility_id=$1 AND status IN ('PENDING','IN_PROGRESS','SUBMITTED')`, [f.id]);
    if (!a && facts.risk.esRequired) {
      a = await one(db, `INSERT INTO es_assessment(facility_id, trigger_config_id, trigger_reasons) VALUES ($1,$2,$3) RETURNING *`, [f.id, esTriggerConfigId, JSON.stringify([`Amount ${formatMoney((facts.facility.amountNgn ?? 0) * 100)} in sector ${facts.customer.sector}`])]);
    }
    return ok(reply, { required: facts.risk.esRequired, trigger: trig ? { description: (trig.payload as any).description, version: trig.version, questionnaire: (trig.payload as any).questionnaire, thresholds: (trig.payload as any).categoryThresholds } : null, assessment: a ? esView(a) : null });
  });

  app.put('/api/facilities/:id/es', async (req, reply) => {
    // SWR §10 / E&S checklist form: the RM completes the checklist with the customer; the E&S analyst reviews, categorises and submits.
    const s = requireAnyPerm(req, ['es.assess', 'es.checklist']);
    const f = await loadFacility(db, req, parse(idParam, req.params).id);
    const analyst = s.permissions.has('es.assess');
    const b = parse(z.object({ answers: z.record(z.string().max(60), z.string().max(60)), findings: z.string().trim().max(5000).optional(), recommendation: z.enum(['PROCEED', 'PROCEED_WITH_CONDITIONS', 'DO_NOT_PROCEED']).optional(), conditions: z.array(z.string().trim().min(5).max(500)).max(20).default([]), submit: z.boolean().default(false) }), req.body);
    const a = await maybe<any>(db, `SELECT * FROM es_assessment WHERE facility_id=$1 AND status IN ('PENDING','IN_PROGRESS')`, [f.id]);
    if (!a) throw conflict('NO_OPEN_ASSESSMENT', 'There is no open E&S assessment for this facility.');
    const trig = await getById<any>(db, a.trigger_config_id ?? (await requireActive(db, 'es_trigger', 'STANDARD')).id);
    const qn = trig.payload.questionnaire as any[];
    let total = 0; const missing: string[] = [];
    for (const qq of qn) { const o = qq.options.find((x: any) => x.code === b.answers[qq.code]); if (!o) missing.push(qq.code); else total += o.weight; }
    const category = total >= trig.payload.categoryThresholds.A ? 'A' : total >= trig.payload.categoryThresholds.B ? 'B' : 'C';
    if (b.submit && !analyst) throw forbidden('Only the E&S risk analyst can submit the assessment. Save the checklist for review.');
    if (b.submit) {
      if (missing.length) throw unprocessable('INCOMPLETE', 'Answer every E&S question before submitting.', missing);
      if (!b.recommendation || !b.findings || b.findings.length < 20) throw unprocessable('FINDINGS', 'Record findings (at least 20 characters) and a recommendation before submitting.');
      if (b.recommendation === 'PROCEED_WITH_CONDITIONS' && !b.conditions.length) throw unprocessable('CONDITIONS', 'List the E&S conditions.');
    }
    const row = await one<any>(db, `UPDATE es_assessment SET answers=$2, findings=$3, recommendation=$4, conditions=$5, category=$6, status=$7, analyst_id=$8, submitted_at = CASE WHEN $7='SUBMITTED' THEN now() END WHERE id=$1 RETURNING *`,
      [a.id, JSON.stringify(b.answers), analyst ? b.findings ?? null : a.findings, analyst ? b.recommendation ?? null : a.recommendation, analyst ? b.conditions : a.conditions, category, b.submit ? 'SUBMITTED' : 'IN_PROGRESS', analyst ? s.id : a.analyst_id]);
    if (!analyst) await audit(db, actorOf(req), { action: 'ES_CHECKLIST_SAVED', entityType: 'es_assessment', entityId: a.id, facilityId: f.id, metadata: { answered: qn.length - missing.length, of: qn.length } });
    if (b.submit) await audit(db, actorOf(req), { action: 'ES_ASSESSMENT_SUBMITTED', entityType: 'es_assessment', entityId: a.id, facilityId: f.id, metadata: { category, recommendation: b.recommendation, score: total } });
    return ok(reply, esView(row));
  });
}

// ---------------------------------------------------------------------------
export async function computeExposure(c: any, facilityId: string, actor: any) {
  const f = await one<any>(c, 'SELECT f.*, cu.cba_customer_id FROM facility_request f JOIN customer cu ON cu.id=f.customer_id WHERE f.id=$1', [facilityId]);
  const sol = await requireActive(c, 'sol_limit', 'STANDARD');
  const sp = sol.payload as any;
  const cba = integrations().cba;
  const ex = await cba.getExposure(f.cba_customer_id);
  const conv = async (l: any, source: string): Promise<ExposureLine> => ({ reference: l.reference, product: l.product, kind: l.kind, outstandingMinor: (await toNgn(c, l.outstandingMinor, l.currency)).minor, approvedMinor: (await toNgn(c, l.approvedMinor, l.currency)).minor, relatedParty: l.relatedParty, source });
  const own = await Promise.all(ex.lines.map((l: any) => conv(l, `CBA (${cba.mode})`)));
  const group = await Promise.all(ex.groupLines.map((l: any) => conv(l, `CBA (${cba.mode})`)));
  // Gazelle pipeline: other approved-but-not-yet-booked requests for the same customer
  const pipelineRows = await q<any>(c, `SELECT f.facility_ref, f.amount_minor, f.currency, f.is_contingent, ci.payload->>'name' AS name FROM facility_request f JOIN config_item ci ON ci.id=f.product_config_id
     WHERE f.customer_id=$1 AND f.id<>$2 AND f.status IN ('APPROVED','OFFER_ISSUED','IN_NEGOTIATION','OFFER_ACCEPTED','FULFILMENT','READY_FOR_ACTIVATION')`, [f.customer_id, f.id]);
  const pipeline: ExposureLine[] = [];
  for (const p of pipelineRows) pipeline.push({ reference: p.facility_ref, product: p.name, kind: p.is_contingent ? 'CONTINGENT' : 'DIRECT', outstandingMinor: (await toNgn(c, p.amount_minor, p.currency)).minor, approvedMinor: p.amount_minor, source: 'Gazelle (approved, not booked)' });
  const proposed = (await toNgn(c, f.amount_minor, f.currency)).minor;
  const agg = aggregateExposure({ own, group, pipeline, proposedMinor: proposed, proposedIsContingent: f.is_contingent, ccfPct: sp.contingentConversionPct, solLimitMinor: sp.singleObligorLimitMinor });
  const prof = await maybe<any>(c, 'SELECT sector_code FROM business_profile WHERE customer_id=$1', [f.customer_id]);
  const sectorLimit = prof?.sector_code ? sp.sectorLimitsMinor?.[prof.sector_code] : undefined;
  const sectorExp = prof?.sector_code ? (await one<any>(c, `SELECT COALESCE(sum(fa.outstanding_minor),0)::bigint AS s FROM facility_account fa JOIN facility_request f ON f.id=fa.facility_id JOIN business_profile bp ON bp.customer_id=f.customer_id WHERE bp.sector_code=$1 AND fa.status IN ('ACTIVE','WATCHLIST')`, [prof.sector_code])).s + proposed : null;
  const row = await one<any>(c, `INSERT INTO exposure_snapshot(facility_id, source_mode, direct_exposure_minor, contingent_exposure_minor, group_exposure_minor, proposed_minor, aggregate_minor, sol_limit_minor, sol_config_id, sol_breached, headroom_minor, sector_code, sector_exposure_minor, sector_limit_minor, sector_breached, lines, computed_by_type, computed_by_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [facilityId, cba.mode, agg.direct, agg.contingent, agg.group, agg.proposed, agg.aggregate, agg.solLimit, sol.id, agg.breached, agg.headroom, prof?.sector_code ?? null, sectorExp, sectorLimit ?? null, sectorLimit !== undefined && sectorExp !== null && sectorExp > sectorLimit, JSON.stringify({ own, group, pipeline, ccfPct: sp.contingentConversionPct, maxSupportableMinor: agg.maxSupportableMinor }), actor.type, actor.id]);
  await audit(c, actor, { action: 'EXPOSURE_COMPUTED', entityType: 'exposure_snapshot', entityId: row.id, facilityId, metadata: { aggregate: agg.aggregate, sol: agg.solLimit, breached: agg.breached, mode: cba.mode } });
  return row;
}

export const exposureView = (e: any) => ({
  id: e.id, computedAt: e.created_at, sourceMode: e.source_mode, directMinor: e.direct_exposure_minor, contingentMinor: e.contingent_exposure_minor, groupMinor: e.group_exposure_minor, proposedMinor: e.proposed_minor,
  aggregateMinor: e.aggregate_minor, solLimitMinor: e.sol_limit_minor, solBreached: e.sol_breached, headroomMinor: e.headroom_minor, sector: e.sector_code, sectorExposureMinor: e.sector_exposure_minor, sectorLimitMinor: e.sector_limit_minor, sectorBreached: e.sector_breached, lines: e.lines,
  warning: e.sol_breached ? `Customer's existing aggregate exposure plus the proposed facility (${formatMoney(e.aggregate_minor)}) exceeds the configured Single Obligor Limit of ${formatMoney(e.sol_limit_minor)}. Review or recommend a reduced facility amount (maximum supportable: ${formatMoney(e.lines.maxSupportableMinor ?? 0)}).` : null,
});
const bureauView = (r: any) => ({ id: r.id, subjectKind: r.subject_kind, subjectName: r.subject_name, identifierType: r.identifier_type, identifier: r.identifier_masked, provider: r.provider, mode: r.mode, status: r.status, reportReference: r.report_reference, score: r.score, totalFacilities: r.total_facilities, totalOutstandingMinor: r.total_outstanding_minor, delinquentFacilities: r.delinquent_facilities, worstClassification: r.worst_classification, error: r.error, requestedAt: r.requested_at });
const riskView = (r: any) => ({ id: r.id, kind: r.kind, status: r.status, scorecard: r.card_key, scorecardVersion: r.card_version, scorecardConfigId: r.scorecard_config_id, score: r.normalised_score, grade: r.grade, gradeDescription: r.grade_description, inputs: r.inputs, breakdown: r.breakdown, assessedBy: r.assessed_by_name, submittedAt: r.submitted_at });
export const raroracView = (r: any) => ({ id: r.id, mode: r.mode, provider: r.provider, status: r.status, proposedProfitRatePct: r.pricing_rate_pct, raroracPct: r.rarorac_pct, hurdlePct: r.hurdle_pct, withinThreshold: r.within_threshold, exceptionRequired: r.exception_required, justification: r.justification, justifiedBy: r.justified_by_name ?? null, recommendedProfitRatePct: r.response?.recommendedProfitRatePct ?? null, notes: r.response?.notes ?? [], computedAt: r.created_at, request: r.request });
const esView = (a: any) => ({ id: a.id, status: a.status, category: a.category, answers: a.answers, findings: a.findings, recommendation: a.recommendation, conditions: a.conditions, triggerReasons: a.trigger_reasons, submittedAt: a.submitted_at });
