import type { Db } from '../../db/pool.js';
import { one, q } from '../../db/pool.js';
import { sha256Hex } from '../../lib/crypto.js';
import { formatMoney } from '../../lib/money.js';
import { unavailable } from '../../lib/errors.js';
import { audit, type Actor } from '../audit/audit.js';
import { gatherFacility } from '../docgen/service.js';
import { sanitiseUntrusted, validateClaims, type Source } from './guard.js';
import { aiProvider, type AiProvider } from './providers.js';

export const USE_CASES = {
  EXECUTIVE_SUMMARY: 'Write a concise executive summary of the facility for an approving executive: purpose, key metrics, key risks and security. Do not recommend a decision.',
  RISK_EXPLANATION: 'Explain each risk flag in one or two sentences, citing the evidence.',
  MEMO_COMMENTARY_DRAFT: 'Draft analyst commentary for the credit memo describing the business, financial performance and transaction structure. The analyst will edit it.',
} as const;
export type UseCase = keyof typeof USE_CASES;

/** Build the grounded source set. Only data the requesting user is already authorised to see is included. */
export async function buildSources(db: Db, facilityId: string) {
  const g = await gatherFacility(db, facilityId);
  const sources: Source[] = [];
  const injection: string[] = [];
  const add = (s: Source) => sources.push(s);
  add({ id: 'metric:amount', label: 'Requested amount', value: formatMoney(g.f.amount_minor, g.f.currency), ref: { table: 'facility_request', id: g.f.id } });
  add({ id: 'metric:tenor', label: 'Tenor (months)', value: String(g.f.tenor_months), ref: { table: 'facility_request', id: g.f.id } });
  add({ id: 'metric:product', label: 'Product', value: g.product.payload.name, ref: { table: 'config_item', id: g.product.id } });
  const latest = g.fa?.summary?.periods?.[0];
  if (latest) for (const k of ['REVENUE', 'PROFIT_AFTER_TAX', 'EBITDA']) if (latest.keyLines[k] != null) add({ id: `metric:${k.toLowerCase()}`, label: `${k.replace(/_/g, ' ').toLowerCase()} (period ending ${latest.periodEnd})`, value: formatMoney(latest.keyLines[k]), ref: { table: 'financial_analysis', id: g.fa.id } });
  if (g.sa) add({ id: 'metric:turnover', label: 'Average monthly credit turnover', value: formatMoney(g.sa.summary.avgMonthlyCreditTurnoverNgnMinor), ref: { table: 'statement_analysis', id: g.sa.id } });
  if (g.col.count) add({ id: 'metric:coverage', label: 'Eligible collateral cover', value: `${g.col.coveragePct}%`, ref: { table: 'collateral', id: facilityId } });
  g.flags.forEach((f, i) => {
    add({ id: `flag:${i}`, label: `Risk flag ${f.code} (${f.severity})`, value: f.statement, ref: { table: 'risk_flag', id: f.code } });
    f.evidence.forEach((e, j) => add({ id: `ev:${i}:${j}`, label: e.label, value: e.value, ref: { table: e.source, id: e.ref } }));
  });
  for (const [id, label, raw] of [['text:purpose', 'Customer-stated purpose', g.f.purpose], ['text:description', 'Customer business description', g.profile?.business_description]] as const) {
    if (!raw) continue;
    const s = sanitiseUntrusted(raw);
    injection.push(...s.flags.map((fl) => `${label}: ${fl}`));
    add({ id, label, value: s.text, ref: { table: 'facility_request', id: g.f.id }, untrusted: true });
  }
  return { sources, injection };
}

/** Run an AI-assisted use case. Output is advisory, logged, validated and awaits human review. */
export async function runAssist(db: Db, actor: Actor, facilityId: string, useCase: UseCase, provider: AiProvider | null = aiProvider()) {
  if (!provider) throw unavailable('AI_OFF', 'AI assistance is switched off in this environment.');
  const { sources, injection } = await buildSources(db, facilityId);
  const instructions = USE_CASES[useCase];
  const promptHash = sha256Hex(JSON.stringify({ useCase, instructions, sources }));
  const started = Date.now();
  const out = await provider.generate({ useCase, instructions, sources });
  const validation = out.refused ? { accepted: [], rejected: [], ok: false, refused: true } : validateClaims(out.claims, sources);
  const row = await one<any>(db, `INSERT INTO ai_interaction(use_case, facility_id, actor_id, provider, model, model_version, prompt_template, prompt_sha256, sources, injection_flags, output, validation, latency_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [useCase, facilityId, actor.id, provider.name, out.model, out.modelVersion, `${useCase}@v1`, promptHash, JSON.stringify(sources.map((s) => ({ id: s.id, label: s.label, ref: s.ref, untrusted: !!s.untrusted }))), JSON.stringify(injection), JSON.stringify({ summary: out.summary, claims: validation.accepted }), JSON.stringify({ rejected: validation.rejected, ok: validation.ok, refused: !!out.refused }), Date.now() - started]);
  await audit(db, actor, { action: 'AI_ASSIST', entityType: 'ai_interaction', entityId: row.id, facilityId, metadata: { useCase, provider: provider.name, model: out.model, accepted: validation.accepted.length, rejected: validation.rejected.length, injectionFlags: injection.length } });
  return aiView(row, sources);
}

export function aiView(r: any, sources?: Source[]) {
  const src = new Map((sources ?? []).map((s) => [s.id, s]));
  return {
    id: r.id, useCase: r.use_case, provider: r.provider, model: r.model, modelVersion: r.model_version, createdAt: r.created_at,
    summary: r.output.summary,
    claims: r.output.claims.map((c: any) => ({ text: c.text, sources: c.sourceIds.map((id: string) => { const s = src.get(id) ?? r.sources.find((x: any) => x.id === id); return { id, label: s?.label, value: (s as any)?.value, ref: s?.ref }; }) })),
    rejectedClaims: r.validation.rejected, refused: r.validation.refused, injectionFlags: r.injection_flags,
    reviewStatus: r.review_status, reviewNote: r.review_note,
    disclaimer: 'AI-assisted draft for human review. It is not a credit decision and must be verified against the cited sources.',
  };
}

export async function listInteractions(db: Db, facilityId: string) {
  return (await q<any>(db, 'SELECT * FROM ai_interaction WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 50', [facilityId])).map((r) => aiView(r));
}
