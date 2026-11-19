import { evaluate, type Condition } from '@gazelle/shared';
import type { Db } from '../../db/pool.js';
import { one, q } from '../../db/pool.js';
import { listActive } from '../config/service.js';
import { buildFacts } from '../facilities/facts.js';

export type Outcome = 'ELIGIBLE' | 'INELIGIBLE' | 'REFER' | 'EXCEPTION_REQUIRED';

const fmt = (v: unknown) => (v === undefined ? 'Not yet available' : typeof v === 'number' ? (Math.abs(v) >= 1000 ? v.toLocaleString('en-NG', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100)) : String(v));

/** Pure evaluation of FIPG rules against facts. Exported for unit tests and admin previews. */
export function evaluateRules(rules: { id: string; key: string; version: number; payload: any }[], facts: Record<string, any>) {
  const results = rules.map((r) => {
    const p = r.payload;
    const scoped =
      (!p.productCodes?.length || p.productCodes.includes(facts.facility?.productCode)) &&
      (!p.sectorCodes?.length || p.sectorCodes.includes(facts.customer?.sector)) &&
      (!p.customerTypes?.length || p.customerTypes.includes(facts.customer?.category));
    const applies = scoped && evaluate(p.appliesWhen as Condition, facts).result;
    if (!applies) return { rule: r, applicable: false, passed: null as boolean | null, incomplete: false, actual: undefined as unknown };
    const ev = evaluate(p.passWhen as Condition, facts);
    const actual = ev.trace.length === 1 ? ev.trace[0]!.actual : ev.trace.map((t) => `${t.fact}=${fmt(t.actual)}`).join('; ');
    return { rule: r, applicable: true, passed: ev.incomplete ? null : ev.result, incomplete: ev.incomplete, actual };
  });
  let outcome = 'ELIGIBLE' as Outcome;
  const rank: Record<Outcome, number> = { ELIGIBLE: 0, REFER: 1, EXCEPTION_REQUIRED: 2, INELIGIBLE: 3 };
  const bump = (o: Outcome) => { if (rank[o] > rank[outcome]) outcome = o; };
  for (const r of results) {
    if (!r.applicable) continue;
    if (r.passed === null) { bump('REFER'); continue; }
    if (r.passed) continue;
    const a = r.rule.payload.action;
    bump(a === 'DECLINE' ? 'INELIGIBLE' : a === 'EXCEPTION' ? 'EXCEPTION_REQUIRED' : a === 'REFER' ? 'REFER' : 'ELIGIBLE');
  }
  return { outcome, results };
}

/** Evaluate and persist an immutable eligibility run. */
export async function runEligibility(db: Db, facilityId: string, by: { type: string; id?: string | null }) {
  const { facts } = await buildFacts(db, facilityId);
  const rules = await listActive(db, 'fipg_rule');
  const { outcome, results } = evaluateRules(rules, facts);
  const ev = await one<{ id: string; created_at: string }>(db, `INSERT INTO eligibility_evaluation(facility_id, outcome, facts, evaluated_by_type, evaluated_by_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`, [facilityId, outcome, JSON.stringify(facts), by.type, by.id ?? null]);
  for (const r of results) {
    const p = r.rule.payload;
    await q(db, `INSERT INTO eligibility_result(evaluation_id, rule_config_id, rule_key, rule_version, applicable, passed, severity, action, actual_value, required_value, customer_message, internal_message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ev.id, r.rule.id, r.rule.key, r.rule.version, r.applicable, r.passed, p.severity, p.action, r.applicable ? fmt(r.actual) : null, p.requiredValue, p.customerMessage, r.incomplete ? `${p.internalMessage} (Not yet determinable — input data missing.)` : p.internalMessage]);
  }
  return { id: ev.id, outcome, evaluatedAt: ev.created_at };
}

/** Customer-safe view: only failed/pending items, customer wording, no thresholds or internal notes. */
export async function eligibilityView(db: Db, evaluationId: string, audience: 'CUSTOMER' | 'STAFF') {
  const ev = await one<any>(db, 'SELECT id, outcome, created_at FROM eligibility_evaluation WHERE id=$1', [evaluationId]);
  const rows = await q<any>(db, 'SELECT * FROM eligibility_result WHERE evaluation_id=$1 ORDER BY severity, rule_key', [evaluationId]);
  if (audience === 'CUSTOMER') {
    return {
      status: ev.outcome === 'ELIGIBLE' ? 'MEETS_INITIAL_CRITERIA' : ev.outcome === 'INELIGIBLE' ? 'DOES_NOT_MEET_CRITERIA' : 'FURTHER_REVIEW',
      evaluatedAt: ev.created_at,
      points: rows.filter((r) => r.applicable && r.passed !== true && r.action !== 'WARN').map((r) => r.customer_message),
    };
  }
  return { id: ev.id, outcome: ev.outcome, evaluatedAt: ev.created_at, results: rows.map((r) => ({ rule: r.rule_key, version: r.rule_version, applicable: r.applicable, passed: r.passed, severity: r.severity, action: r.action, actual: r.actual_value, required: r.required_value, explanation: r.internal_message })) };
}
