import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';
import { listActive, requireActive } from '../config/service.js';
import { loadFacility, resolveCustomer } from '../facilities/access.js';
import { analyse, type Statement } from './financial-engine.js';

const stmtSchema = z.object({
  statementType: z.enum(['AUDITED', 'MANAGEMENT', 'PROJECTED']),
  periodStart: z.iso.date(), periodEnd: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('NGN'),
  auditor: z.string().trim().max(200).nullable().optional(),
  auditOpinion: z.enum(['UNQUALIFIED', 'QUALIFIED', 'ADVERSE', 'DISCLAIMER']).nullable().optional(),
  sourceDocumentId: z.uuid().nullable().optional(),
  lines: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), z.number().int().min(-9e15).max(9e15)),
  uncertainLines: z.array(z.string()).default([]),
}).refine((s) => s.periodEnd > s.periodStart, { message: 'Period end must be after the start.', path: ['periodEnd'] });

/** Months in a period, rounded to whole months (e.g. 1 Jan–30 Jun = 6). Management accounts keep their true length. */
export const periodMonths = (start: string, end: string) => {
  const s = new Date(start), e = new Date(end);
  const m = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + (e.getUTCDate() >= s.getUTCDate() - 1 ? 1 : 0);
  return Math.max(1, Math.min(24, m));
};

async function loadStatements(db: ReturnType<typeof getPool>, customerId: string) {
  return q<any>(db, `SELECT fs.*, COALESCE((SELECT json_object_agg(line_code, amount_minor) FROM financial_line_item WHERE statement_id=fs.id), '{}') AS lines,
      COALESCE((SELECT json_agg(line_code) FROM financial_line_item WHERE statement_id=fs.id AND uncertain), '[]') AS uncertain_lines
    FROM financial_statement fs WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY period_end DESC`, [customerId]);
}

export async function financialRoutes(app: FastifyInstance) {
  const db = getPool();

  app.get('/api/financial-template', async (req, reply) => {
    if (!req.auth) return reply.status(401).send();
    const t = await requireActive(db, 'financial_template', 'STANDARD');
    return ok(reply, t.payload);
  });

  app.get('/api/customers/:customerId/financial-statements', async (req, reply) => {
    const cid = await resolveCustomer(db, req, parse(z.object({ customerId: z.string() }), req.params).customerId);
    const rows = await loadStatements(db, cid);
    return ok(reply, rows.map((s) => ({ id: s.id, statementType: s.statement_type, periodStart: s.period_start, periodEnd: s.period_end, months: s.months, currency: s.currency, auditor: s.auditor, auditOpinion: s.audit_opinion, status: s.status, entryMethod: s.entry_method, lines: s.lines, uncertainLines: s.uncertain_lines, sourceDocumentId: s.source_document_id, validatedAt: s.validated_at })));
  });

  app.post('/api/customers/:customerId/financial-statements', async (req, reply) => {
    const isStaff = req.auth?.subjectType === 'STAFF';
    if (isStaff) requireStaff(req, 'financials.edit');
    const cid = await resolveCustomer(db, req, parse(z.object({ customerId: z.string() }), req.params).customerId);
    const b = parse(stmtSchema, req.body);
    const template = await requireActive(db, 'financial_template', 'STANDARD');
    const codes = new Set((template.payload as any).lines.map((l: any) => l.code));
    const unknown = Object.keys(b.lines).filter((k) => !codes.has(k));
    if (unknown.length) throw unprocessable('UNKNOWN_LINES', `Unknown line items: ${unknown.join(', ')}`);
    const months = periodMonths(b.periodStart, b.periodEnd);
    if (b.statementType === 'AUDITED' && (months < 11 || months > 13)) throw unprocessable('AUDITED_PERIOD', 'Audited statements normally cover 12 months. Record shorter periods as management accounts.');
    if (b.sourceDocumentId && !(await maybe(db, 'SELECT 1 FROM document WHERE id=$1 AND customer_id=$2', [b.sourceDocumentId, cid]))) throw notFound('Source document');
    const actor = actorOf(req);
    const s = await tx(async (c) => {
      const row = await one<any>(c, `INSERT INTO financial_statement(customer_id, statement_type, period_start, period_end, months, currency, auditor, audit_opinion, source_document_id, status, entered_by_type, entered_by_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [cid, b.statementType, b.periodStart, b.periodEnd, months, b.currency, b.auditor ?? null, b.auditOpinion ?? null, b.sourceDocumentId ?? null, isStaff ? 'DRAFT' : 'SUBMITTED', actor.type, actor.id]);
      for (const [code, amt] of Object.entries(b.lines)) await q(c, 'INSERT INTO financial_line_item(statement_id, line_code, amount_minor, uncertain) VALUES ($1,$2,$3,$4)', [row.id, code, amt, b.uncertainLines.includes(code)]);
      await audit(c, actor, { action: 'FINANCIAL_STATEMENT_CREATED', entityType: 'financial_statement', entityId: row.id, customerId: cid, after: { type: b.statementType, periodEnd: b.periodEnd, months, lines: Object.keys(b.lines).length } });
      return row;
    });
    return ok(reply, { id: s.id, months }, 201);
  });

  app.put('/api/financial-statements/:id/lines', async (req, reply) => {
    requireStaff(req, 'financials.edit');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ lines: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), z.number().int()), reason: z.string().trim().min(5).max(500) }), req.body);
    const s = await maybe<any>(db, 'SELECT * FROM financial_statement WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!s) throw notFound('Financial statement');
    await resolveCustomer(db, req, s.customer_id);
    if (s.status === 'VALIDATED') throw conflict('VALIDATED', 'Validated statements cannot be edited. Record a corrected statement instead.');
    const actor = actorOf(req);
    await tx(async (c) => {
      const before = Object.fromEntries((await q<any>(c, 'SELECT line_code, amount_minor FROM financial_line_item WHERE statement_id=$1', [id])).map((r) => [r.line_code, r.amount_minor]));
      for (const [code, amt] of Object.entries(b.lines)) await q(c, `INSERT INTO financial_line_item(statement_id, line_code, amount_minor, source_ref) VALUES ($1,$2,$3,'corrected') ON CONFLICT (statement_id, line_code) DO UPDATE SET amount_minor=EXCLUDED.amount_minor, uncertain=false, source_ref='corrected'`, [id, code, amt]);
      await audit(c, actor, { action: 'FINANCIAL_LINES_EDITED', entityType: 'financial_statement', entityId: id, customerId: s.customer_id, before: Object.fromEntries(Object.keys(b.lines).map((k) => [k, before[k]])), after: b.lines, metadata: { reason: b.reason } });
    });
    return ok(reply, { updated: true });
  });

  app.post('/api/financial-statements/:id/validate', async (req, reply) => {
    requireStaff(req, 'financials.validate');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const s = await maybe<any>(db, 'SELECT * FROM financial_statement WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!s) throw notFound('Financial statement');
    await resolveCustomer(db, req, s.customer_id);
    const unc = await maybe(db, 'SELECT 1 FROM financial_line_item WHERE statement_id=$1 AND uncertain', [id]);
    if (unc) throw unprocessable('UNCERTAIN_LINES', 'Resolve the line items flagged as uncertain before validating.');
    await q(db, `UPDATE financial_statement SET status='VALIDATED', validated_by=$2, validated_at=now() WHERE id=$1`, [id, req.auth!.subjectId]);
    await audit(db, actorOf(req), { action: 'FINANCIAL_STATEMENT_VALIDATED', entityType: 'financial_statement', entityId: id, customerId: s.customer_id });
    return ok(reply, { validated: true });
  });

  /** Run (and freeze) the financial analysis for a facility using current ratio configuration. */
  app.post('/api/facilities/:id/financial-analysis', async (req, reply) => {
    requireStaff(req, 'financials.validate');
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    const stmts = (await loadStatements(db, f.customer_id)).filter((s) => s.status !== 'REJECTED' && s.statement_type !== 'PROJECTED');
    if (!stmts.length) throw unprocessable('NO_STATEMENTS', 'Capture at least one financial statement first.');
    const template = await requireActive(db, 'financial_template', 'STANDARD');
    const ratios = await listActive(db, 'ratio');
    const prof = await maybe<any>(db, 'SELECT sector_code FROM business_profile WHERE customer_id=$1', [f.customer_id]);
    const res = analyse(stmts as Statement[], (template.payload as any).lines, ratios as any, prof?.sector_code);
    const summary = {
      frrScore: res.frrScore, quality: res.quality, templateVersion: template.version,
      periods: res.periods.map((p) => ({ statementId: p.statement.id, type: p.statement.statement_type, periodEnd: p.statement.period_end, months: p.statement.months, keyLines: Object.fromEntries(['REVENUE', 'GROSS_PROFIT', 'EBITDA', 'OPERATING_PROFIT', 'PROFIT_BEFORE_TAX', 'PROFIT_AFTER_TAX', 'TOTAL_ASSETS', 'TOTAL_LIABILITIES', 'TOTAL_EQUITY', 'TOTAL_FINANCING', 'WORKING_CAPITAL', 'OPERATING_CASH_FLOW'].map((k) => [k, p.lines[k] ?? null])) })),
    };
    const actor = actorOf(req);
    const out = await tx(async (c) => {
      const a = await one<any>(c, `INSERT INTO financial_analysis(facility_id, statement_ids, ratio_config_ids, summary, total_score, run_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [f.id, stmts.map((s) => s.id), ratios.map((r) => r.id), JSON.stringify(summary), res.frrScore, actor.id]);
      for (const p of res.periods) for (const r of p.results) {
        await q(c, `INSERT INTO ratio_result(analysis_id, statement_id, ratio_key, ratio_config_id, value, error, band, score, weight, implication) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [a.id, p.statement.id, r.ratio.key, r.ratio.id, r.value, r.error, r.band?.label ?? null, r.band?.score ?? null, r.ratio.payload.weight, r.band?.implication ?? null]);
      }
      await audit(c, actor, { action: 'FINANCIAL_ANALYSIS_RUN', entityType: 'financial_analysis', entityId: a.id, facilityId: f.id, metadata: { frrScore: res.frrScore, statements: stmts.length } });
      return a;
    });
    return ok(reply, await analysisView(db, out.id), 201);
  });

  app.get('/api/facilities/:id/financial-analysis', async (req, reply) => {
    requireStaff(req);
    const f = await loadFacility(db, req, parse(z.object({ id: z.string() }), req.params).id);
    const a = await maybe<any>(db, 'SELECT id FROM financial_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [f.id]);
    return ok(reply, a ? await analysisView(db, a.id) : null);
  });
}

export async function analysisView(db: ReturnType<typeof getPool>, id: string) {
  const a = await one<any>(db, 'SELECT * FROM financial_analysis WHERE id=$1', [id]);
  const rr = await q<any>(db, `SELECT r.*, ci.payload->>'name' AS name, ci.payload->>'unit' AS unit, ci.payload->>'category' AS category, ci.version FROM ratio_result r JOIN config_item ci ON ci.id=r.ratio_config_id WHERE r.analysis_id=$1`, [id]);
  return { id: a.id, runAt: a.created_at, frrScore: a.total_score, ...a.summary, ratios: rr.map((r) => ({ statementId: r.statement_id, key: r.ratio_key, name: r.name, unit: r.unit, category: r.category, configVersion: r.version, value: r.value, error: r.error, band: r.band, score: r.score, weight: r.weight, implication: r.implication })) };
}
