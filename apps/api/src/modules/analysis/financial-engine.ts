import { evalFormula, parseFormula } from '@gazelle/shared';

export interface TemplateLine { code: string; label: string; section: string; isFlow: boolean; required: boolean; derived?: string }
export interface Statement { id: string; statement_type: string; period_start: string; period_end: string; months: number; currency: string; lines: Record<string, number> }
export interface RatioDef { id: string; key: string; payload: { code: string; name: string; formula: string; unit: string; category: string; direction: string; weight: number; sectors: string[]; bands: { min?: number; max?: number; score: number; label: string; implication: string }[] } }

/** Fill derived lines (e.g. GROSS_PROFIT) where not captured. Captured values always win. */
export function withDerived(lines: Record<string, number>, template: TemplateLine[]) {
  const out = { ...lines };
  for (let pass = 0; pass < 3; pass++) {
    for (const t of template) {
      if (!t.derived || out[t.code] !== undefined) continue;
      const r = evalFormula(parseFormula(t.derived), out);
      if (r.ok) out[t.code] = Math.round(r.value);
    }
  }
  return out;
}

/** Annualise flow items of a partial-period statement (management accounts are not forced into 12 months). */
export function annualised(lines: Record<string, number>, months: number, template: TemplateLine[]) {
  if (months === 12) return { ...lines };
  const flow = new Set(template.filter((t) => t.isFlow).map((t) => t.code));
  return Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, flow.has(k) ? Math.round((v * 12) / months) : v]));
}

export function bandFor(value: number, bands: RatioDef['payload']['bands']) {
  return bands.find((b) => (b.min === undefined || value >= b.min) && (b.max === undefined || value < b.max)) ?? null;
}

export interface QualityIssue { severity: 'ERROR' | 'WARNING'; statementId?: string; message: string }

export function dataQuality(statements: Statement[], template: TemplateLine[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const audited = statements.filter((s) => s.statement_type === 'AUDITED').sort((a, b) => b.period_end.localeCompare(a.period_end));
  if (audited.length < 3) issues.push({ severity: 'WARNING', message: `Only ${audited.length} audited financial year(s) on file; three are expected.` });
  for (let i = 0; i + 1 < audited.length; i++) {
    const gapDays = (new Date(audited[i]!.period_start).getTime() - new Date(audited[i + 1]!.period_end).getTime()) / 86400_000;
    if (gapDays > 2) issues.push({ severity: 'WARNING', message: `Gap between audited periods ending ${audited[i + 1]!.period_end} and starting ${audited[i]!.period_start} (missing financial year).` });
  }
  const ccys = new Set(statements.map((s) => s.currency));
  if (ccys.size > 1) issues.push({ severity: 'ERROR', message: `Statements are in different currencies (${[...ccys].join(', ')}). Convert before comparing.` });
  for (const s of statements) {
    const l = withDerived(s.lines, template);
    for (const t of template.filter((x) => x.required)) if (l[t.code] === undefined) issues.push({ severity: 'ERROR', statementId: s.id, message: `${t.label} missing for period ending ${s.period_end}.` });
    if (l.TOTAL_ASSETS !== undefined && l.TOTAL_LIABILITIES !== undefined && l.TOTAL_EQUITY !== undefined) {
      const diff = Math.abs(l.TOTAL_ASSETS - (l.TOTAL_LIABILITIES + l.TOTAL_EQUITY));
      if (diff > Math.abs(l.TOTAL_ASSETS) * 0.01) issues.push({ severity: 'ERROR', statementId: s.id, message: `Balance sheet does not balance for period ending ${s.period_end} (assets differ from liabilities + equity by more than 1%).` });
    }
    if (l.GROSS_PROFIT !== undefined && l.REVENUE !== undefined && l.GROSS_PROFIT > l.REVENUE) issues.push({ severity: 'WARNING', statementId: s.id, message: `Gross profit exceeds revenue for period ending ${s.period_end}.` });
  }
  return issues;
}

/**
 * Compute every applicable ratio for every statement and a weighted FRR score (0–100) on the latest period.
 * Ratio inputs are line items in minor units; ratios are unit-free so minor units cancel.
 */
export function analyse(statements: Statement[], template: TemplateLine[], ratios: RatioDef[], sector?: string) {
  const sorted = [...statements].sort((a, b) => b.period_end.localeCompare(a.period_end));
  const applicable = ratios.filter((r) => !r.payload.sectors.length || (sector && r.payload.sectors.includes(sector)));
  const periods = sorted.map((s, i) => {
    const cur = annualised(withDerived(s.lines, template), s.months, template);
    const prevStmt = sorted.slice(i + 1).find((p) => p.statement_type === s.statement_type || p.statement_type === 'AUDITED');
    const prev = prevStmt ? annualised(withDerived(prevStmt.lines, template), prevStmt.months, template) : {};
    const vars: Record<string, number> = { ...cur };
    for (const [k, v] of Object.entries(prev)) vars[`PREV.${k}`] = v;
    const results = applicable.map((r) => {
      const res = evalFormula(parseFormula(r.payload.formula), vars);
      if (!res.ok) return { ratio: r, value: null as number | null, error: res.missing?.length ? `Missing: ${res.missing.join(', ')}` : res.error, band: null as ReturnType<typeof bandFor> };
      return { ratio: r, value: res.value, error: null as string | null, band: bandFor(res.value, r.payload.bands) };
    });
    return { statement: s, lines: withDerived(s.lines, template), results };
  });
  const latest = periods[0];
  let frrScore: number | null = null;
  if (latest) {
    const scored = latest.results.filter((r) => r.band);
    const w = scored.reduce((a, r) => a + r.ratio.payload.weight, 0);
    frrScore = w > 0 ? Math.round((scored.reduce((a, r) => a + r.band!.score * r.ratio.payload.weight, 0) / w) * 10 * 100) / 100 : null;
  }
  return { periods, frrScore, quality: dataQuality(statements, template) };
}
