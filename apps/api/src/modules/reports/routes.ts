import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, one, q } from '../../db/pool.js';
import { actorOf, ok, parse, requireStaff } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.js';

const filterSchema = z.object({
  from: z.iso.date().optional(), to: z.iso.date().optional(), product: z.string().max(60).optional(), sector: z.string().max(60).optional(),
  directorate: z.string().max(40).optional(), officer: z.uuid().optional(), status: z.string().max(200).optional(),
  minAmount: z.coerce.number().int().min(0).optional(), maxAmount: z.coerce.number().int().min(0).optional(),
});
type Filters = z.infer<typeof filterSchema>;

/** Parameterised WHERE clause over facility_request f / customer c / business_profile bp. */
function where(fl: Filters, vals: unknown[], alias = 'f') {
  const w: string[] = [`${alias}.status <> 'DRAFT'`];
  const add = (sql: string, v: unknown) => { vals.push(v); w.push(sql.replace(/\?/g, `$${vals.length}`)); };
  if (fl.from) add(`${alias}.submitted_at >= ?::date`, fl.from);
  if (fl.to) add(`${alias}.submitted_at < (?::date + 1)`, fl.to);
  if (fl.product) add(`${alias}.product_code = ?`, fl.product);
  if (fl.sector) add('bp.sector_code = ?', fl.sector);
  if (fl.directorate) add('bu.directorate_code = ?', fl.directorate);
  if (fl.officer) add(`(c.relationship_manager_id = ? OR EXISTS (SELECT 1 FROM workflow_task t WHERE t.facility_id=${alias}.id AND t.completed_by = ?))`, fl.officer);
  if (fl.status) add(`${alias}.status = ANY(?)`, fl.status.split(','));
  if (fl.minAmount !== undefined) add(`${alias}.amount_minor >= ?`, fl.minAmount);
  if (fl.maxAmount !== undefined) add(`${alias}.amount_minor <= ?`, fl.maxAmount);
  return w.join(' AND ');
}
const BASE = `FROM facility_request f JOIN customer c ON c.id=f.customer_id LEFT JOIN business_profile bp ON bp.customer_id=c.id LEFT JOIN business_unit bu ON bu.code=c.business_unit_code LEFT JOIN config_item ci ON ci.id=f.product_config_id`;
const APPROVED = `('APPROVED','OFFER_ISSUED','IN_NEGOTIATION','OFFER_ACCEPTED','OFFER_REJECTED','FULFILMENT','READY_FOR_ACTIVATION','ACTIVE','CLOSED')`;

/** CSV with spreadsheet formula-injection protection. */
export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

const REPORTS: Record<string, { title: string; sql: (fl: Filters, vals: unknown[]) => string }> = {
  facilities: { title: 'Facility requests', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, ci.payload->>'name' AS product, bp.sector_code AS sector, bu.directorate_code AS directorate, f.status, f.currency, f.amount_minor/100.0 AS amount, f.tenor_months AS tenor_months, f.submitted_at, f.decided_at, round(extract(epoch from (f.decided_at - f.submitted_at))/3600, 1) AS tat_hours ${BASE} WHERE ${where(fl, v)} ORDER BY f.submitted_at DESC` },
  approvals: { title: 'Approvals', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, t.amount_minor/100.0 AS approved_amount, t.profit_rate_pct, t.tenor_months, t.version_no AS terms_version, array_to_string(t.approved_by_names, '; ') AS approved_by, t.created_at AS approved_at ${BASE} JOIN approved_terms t ON t.facility_id=f.id WHERE ${where(fl, v)} ORDER BY t.created_at DESC` },
  declines: { title: 'Declines', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, f.amount_minor/100.0 AS amount, a.actor_name AS declined_by, a.actor_role AS role, a.comment AS reason, a.created_at AS declined_at ${BASE} JOIN workflow_action a ON a.facility_id=f.id AND a.action='DECLINE' WHERE ${where({ ...fl, status: 'DECLINED' }, v)} ORDER BY a.created_at DESC` },
  returned: { title: 'Returned for rework', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, r.section, r.message, r.raised_at, r.resolved_at ${BASE} JOIN rework_item r ON r.facility_id=f.id WHERE ${where(fl, v)} ORDER BY r.raised_at DESC` },
  pending: { title: 'Pending tasks', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, t.stage_name, t.role_code, u.display_name AS holder, t.created_at, t.due_at, t.breached_at IS NOT NULL AS breached ${BASE} JOIN workflow_task t ON t.facility_id=f.id AND t.status IN ('OPEN','CLAIMED') LEFT JOIN app_user u ON u.id=COALESCE(t.claimed_by, t.assigned_user_id) WHERE ${where(fl, v)} ORDER BY t.due_at` },
  sla: { title: 'SLA performance by stage', sql: (fl, v) => `SELECT t.stage_name, count(*)::int AS tasks, count(*) FILTER (WHERE t.breached_at IS NOT NULL)::int AS breached, round(100.0 * count(*) FILTER (WHERE t.breached_at IS NULL) / NULLIF(count(*),0), 1) AS compliance_pct, round(avg(extract(epoch from (COALESCE(t.completed_at, now()) - t.created_at))/3600)::numeric, 1) AS avg_hours ${BASE} JOIN workflow_task t ON t.facility_id=f.id WHERE ${where(fl, v)} GROUP BY t.stage_name ORDER BY breached DESC` },
  disbursements: { title: 'Disbursements', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, d.amount_minor/100.0 AS amount, d.status, d.requested_at, d.posted_at, d.cba_reference ${BASE} JOIN disbursement d ON d.facility_id=f.id WHERE ${where(fl, v)} ORDER BY d.requested_at DESC` },
  outstanding: { title: 'Outstanding facilities', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, ci.payload->>'name' AS product, a.approved_minor/100.0 AS approved, a.utilised_minor/100.0 AS utilised, a.outstanding_minor/100.0 AS outstanding, a.maturity_date, a.status, (SELECT count(*) FROM payment_schedule_item s WHERE s.account_id=a.id AND s.status='OVERDUE')::int AS overdue_instalments ${BASE} JOIN facility_account a ON a.facility_id=f.id WHERE ${where(fl, v)} ORDER BY a.outstanding_minor DESC` },
  collateral: { title: 'Collateral register', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, co.type_key, co.description, co.market_value_minor/100.0 AS market_value, co.haircut_pct, co.eligible_value_ngn_minor/100.0 AS eligible_ngn, co.perfection_status, co.valuation_date, co.expiry_date ${BASE} JOIN collateral co ON co.facility_id=f.id AND co.deleted_at IS NULL WHERE ${where(fl, v)}` },
  exceptions: { title: 'Exceptions (eligibility, pricing, SOL)', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, 'PRICING' AS kind, r.rarorac_pct::text AS detail, r.justification AS justification FROM rarorac_computation r JOIN facility_request f ON f.id=r.facility_id JOIN customer c ON c.id=f.customer_id LEFT JOIN business_profile bp ON bp.customer_id=c.id LEFT JOIN business_unit bu ON bu.code=c.business_unit_code WHERE r.exception_required AND ${where(fl, v)}
      UNION ALL SELECT f.facility_ref, c.legal_name, 'SOL', e.aggregate_minor::text, NULL FROM exposure_snapshot e JOIN facility_request f ON f.id=e.facility_id JOIN customer c ON c.id=f.customer_id LEFT JOIN business_profile bp ON bp.customer_id=c.id LEFT JOIN business_unit bu ON bu.code=c.business_unit_code WHERE e.sol_breached AND ${where(fl, v)}
      UNION ALL SELECT f.facility_ref, c.legal_name, 'ELIGIBILITY', ev.outcome, NULL FROM eligibility_evaluation ev JOIN facility_request f ON f.id=ev.facility_id JOIN customer c ON c.id=f.customer_id LEFT JOIN business_profile bp ON bp.customer_id=c.id LEFT JOIN business_unit bu ON bu.code=c.business_unit_code WHERE ev.outcome IN ('EXCEPTION_REQUIRED','REFER') AND ${where(fl, v)}` },
  onboarding: { title: 'Customer onboarding', sql: () => `SELECT c.customer_ref AS reference, c.legal_name AS customer, c.status, bp.completeness_pct AS profile_completeness, c.created_at AS onboarded_at, u.display_name AS rm FROM customer c LEFT JOIN business_profile bp ON bp.customer_id=c.id LEFT JOIN app_user u ON u.id=c.relationship_manager_id ORDER BY c.created_at DESC` },
  'facility-review': { title: 'Facilities due for review', sql: (fl, v) => `SELECT f.facility_ref AS reference, c.legal_name AS customer, a.next_review_date, a.maturity_date, (SELECT count(*) FROM monitoring_item m WHERE m.facility_id=f.id AND m.status='OPEN')::int AS open_alerts ${BASE} JOIN facility_account a ON a.facility_id=f.id WHERE ${where(fl, v)} ORDER BY a.next_review_date` },
};

export async function reportRoutes(app: FastifyInstance) {
  const db = getPool();

  /** Service Level Management dashboard. */
  app.get('/api/reports/slm', async (req, reply) => {
    requireStaff(req, 'report.view');
    const fl = parse(filterSchema, req.query);
    const v: unknown[] = [];
    const w = where(fl, v);
    const totals = await one<any>(db, `SELECT count(*)::int AS received,
        count(*) FILTER (WHERE f.status IN ${APPROVED})::int AS approved, count(*) FILTER (WHERE f.status='DECLINED')::int AS declined,
        count(*) FILTER (WHERE f.status='RETURNED')::int AS returned, count(*) FILTER (WHERE f.status IN ('SUBMITTED','IN_REVIEW'))::int AS pending,
        COALESCE(sum(f.amount_minor),0)::bigint AS requested_minor,
        COALESCE(sum((SELECT t.amount_minor FROM approved_terms t WHERE t.facility_id=f.id ORDER BY version_no DESC LIMIT 1)),0)::bigint AS approved_minor,
        COALESCE(sum((SELECT sum(d.amount_minor) FROM disbursement d WHERE d.facility_id=f.id AND d.status='POSTED')),0)::bigint AS disbursed_minor,
        round(avg(extract(epoch from (f.decided_at - f.submitted_at))/3600)::numeric, 1) AS avg_tat_hours,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (f.decided_at - f.submitted_at))/3600))::numeric, 1) AS median_tat_hours
      ${BASE} WHERE ${w}`, v);
    const v2: unknown[] = []; const w2 = where(fl, v2);
    const sla = await one<any>(db, `SELECT count(*)::int AS tasks, count(*) FILTER (WHERE t.breached_at IS NOT NULL)::int AS breaches, round(100.0 * count(*) FILTER (WHERE t.breached_at IS NULL)/NULLIF(count(*),0), 1) AS compliance_pct ${BASE} JOIN workflow_task t ON t.facility_id=f.id WHERE ${w2}`, v2);
    const by = async (expr: string, label: string, extraJoin = '') => { const vv: unknown[] = []; return q(db, `SELECT ${expr} AS ${label}, count(*)::int AS count, COALESCE(sum(f.amount_minor),0)::bigint AS amount_minor, count(*) FILTER (WHERE f.status IN ${APPROVED})::int AS approved ${BASE} ${extraJoin} WHERE ${where(fl, vv)} GROUP BY 1 ORDER BY count DESC`, vv); };
    const byAnalyst = await (async () => { const vv: unknown[] = []; return q(db, `SELECT u.display_name AS analyst, count(DISTINCT f.id)::int AS count, round(avg(extract(epoch from (t.completed_at - t.created_at))/3600)::numeric,1) AS avg_hours ${BASE} JOIN workflow_task t ON t.facility_id=f.id AND t.stage_key='CREDIT_ANALYSIS' AND t.completed_by IS NOT NULL JOIN app_user u ON u.id=t.completed_by WHERE ${where(fl, vv)} GROUP BY 1 ORDER BY count DESC`, vv); })();
    const byStage = await (async () => { const vv: unknown[] = []; return q(db, `SELECT t.stage_name AS stage, count(*)::int AS count, count(*) FILTER (WHERE t.breached_at IS NOT NULL)::int AS breached ${BASE} JOIN workflow_task t ON t.facility_id=f.id AND t.status IN ('OPEN','CLAIMED') WHERE ${where(fl, vv)} GROUP BY 1 ORDER BY count DESC`, vv); })();
    return ok(reply, {
      totals, sla, byStage, byAnalyst,
      bySector: await by(`COALESCE((SELECT name FROM sector WHERE code=bp.sector_code),'Unspecified')`, 'sector'),
      byProduct: await by(`ci.payload->>'name'`, 'product'),
      byDirectorate: await by(`COALESCE((SELECT name FROM directorate WHERE code=bu.directorate_code),'Unassigned')`, 'directorate'),
      byRm: await by(`COALESCE(rm.display_name,'Unassigned')`, 'rm', 'LEFT JOIN app_user rm ON rm.id=c.relationship_manager_id'),
      bySize: await by(`CASE WHEN f.amount_minor < 5000000000 THEN 'Below ₦50m' WHEN f.amount_minor < 25000000000 THEN '₦50m–₦250m' WHEN f.amount_minor < 100000000000 THEN '₦250m–₦1bn' ELSE '₦1bn and above' END`, 'band'),
    });
  });

  /** Where customers abandon the application journey. */
  app.get('/api/reports/dropoff', async (req, reply) => {
    requireStaff(req, 'report.view');
    const { journey, from, to } = parse(z.object({ journey: z.enum(['FACILITY_APPLICATION', 'ONBOARDING']).default('FACILITY_APPLICATION'), from: z.iso.date().optional(), to: z.iso.date().optional() }), req.query);
    const rows = await q<any>(db, `SELECT step, count(DISTINCT journey_id) FILTER (WHERE event='ENTERED')::int AS entered, count(DISTINCT journey_id) FILTER (WHERE event='COMPLETED')::int AS completed
      FROM journey_step_event WHERE journey=$1 AND ($2::date IS NULL OR created_at >= $2::date) AND ($3::date IS NULL OR created_at < $3::date + 1) GROUP BY step`, [journey, from ?? null, to ?? null]);
    const order = journey === 'ONBOARDING' ? ['ACCOUNT', 'OTP', 'PROFILE', 'COMPLETE'] : ['PRODUCT', 'DETAILS', 'PRODUCT_INFO', 'SECURITY', 'FINANCIALS', 'BANK_STATEMENTS', 'DOCUMENTS', 'REVIEW'];
    const steps = order.map((s) => {
      const r = rows.find((x) => x.step === s) ?? { entered: 0, completed: 0 };
      const entered = Math.max(r.entered, r.completed);
      return { step: s, entered, completed: r.completed, dropped: entered - r.completed, dropOffPct: entered ? Math.round(((entered - r.completed) / entered) * 1000) / 10 : 0 };
    });
    const worst = [...steps].filter((s) => s.entered > 0).sort((a, b) => b.dropped - a.dropped)[0];
    return ok(reply, { journey, steps, highestDropOff: worst && worst.dropped > 0 ? worst : null });
  });

  app.get('/api/reports', async (req, reply) => { requireStaff(req, 'report.view'); return ok(reply, Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title }))); });

  app.get('/api/reports/:key', async (req, reply) => {
    requireStaff(req, 'report.view');
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z-]+(\.csv)?$/) }), req.params);
    const csv = key.endsWith('.csv');
    const r = REPORTS[key.replace(/\.csv$/, '')];
    if (!r) throw notFound('Report');
    const fl = parse(filterSchema, req.query);
    const vals: unknown[] = [];
    const rows = await q<Record<string, unknown>>(db, `${r.sql(fl, vals)} LIMIT 10000`, vals);
    await audit(db, actorOf(req), { action: csv ? 'REPORT_EXPORTED' : 'REPORT_VIEWED', entityType: 'report', entityId: key, metadata: { filters: fl, rows: rows.length } });
    if (csv) {
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="gazelle-${key.replace(/\.csv$/, '')}-${new Date().toISOString().slice(0, 10)}.csv"`);
      return reply.send('﻿' + toCsv(rows));
    }
    return ok(reply, { title: r.title, rows });
  });
}
