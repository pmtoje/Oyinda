import { evalFormula, parseFormula, variablesOf } from '@gazelle/shared';
import type { Db } from '../../db/pool.js';
import { maybe } from '../../db/pool.js';
import { getActive } from '../config/service.js';
import { EFFICIENCY_VARIABLES } from '../config/schemas.js';
import { collateralSummary } from '../facilities/facts.js';
import { toNgn } from '../fx/service.js';

/**
 * Facility efficiency ratio (CAM section 25). The Bank's sources do not define it, so its definition is configuration
 * (`facility_efficiency_ratio`), set and changed from time to time on management's or the Board's direction under
 * maker-checker. The formula may use only the variables below; amounts are in Naira (not kobo).
 */
export { EFFICIENCY_VARIABLES };

export { efficiencyFormulaError as validateEfficiencyFormula } from '../config/schemas.js';
function collectVars(n: any): Set<string> { return variablesOf(n); }

/** The inputs for a facility, from the latest recorded analyses. Unknown inputs stay undefined (never guessed). */
export async function efficiencyInputs(db: Db, facilityId: string): Promise<Record<string, number | undefined>> {
  const f = await maybe<any>(db, 'SELECT id, amount_minor, currency, tenor_months FROM facility_request WHERE id=$1', [facilityId]);
  if (!f) return {};
  const N = (minor: unknown) => (minor === null || minor === undefined ? undefined : Number(minor) / 100);
  const request = f.amount_minor ? (await toNgn(db, f.amount_minor, f.currency)).minor : null;
  const fa = await maybe<any>(db, 'SELECT summary FROM financial_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const latest = (fa?.summary?.periods ?? []).filter((p: any) => p.type !== 'PROJECTED')[0];
  const annual = (k: string) => (latest?.keyLines?.[k] === null || latest?.keyLines?.[k] === undefined ? undefined : (Number(latest.keyLines[k]) / 100) * (12 / (latest.months || 12)));
  const point = (k: string) => N(latest?.keyLines?.[k]);
  const sa = await maybe<any>(db, 'SELECT summary FROM statement_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const ex = await maybe<any>(db, 'SELECT direct_exposure_minor, contingent_exposure_minor, aggregate_minor FROM exposure_snapshot WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const col = f.amount_minor ? await collateralSummary(db, facilityId, f.amount_minor, f.currency) : null;
  const rar = await maybe<any>(db, `SELECT pricing_rate_pct, rarorac_pct FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const avgCredit = N(sa?.summary?.avgMonthlyCreditTurnoverNgnMinor);
  return {
    REQUEST_AMOUNT: N(request), TENOR_MONTHS: f.tenor_months ?? undefined,
    OUTSTANDING_EXPOSURE: ex ? N(Number(ex.direct_exposure_minor) + Number(ex.contingent_exposure_minor)) : undefined,
    AGGREGATE_EXPOSURE: ex ? N(ex.aggregate_minor) : undefined,
    ANNUAL_REVENUE: annual('REVENUE'), EBITDA: annual('EBITDA'), PROFIT_AFTER_TAX: annual('PROFIT_AFTER_TAX'), OPERATING_CASH_FLOW: annual('OPERATING_CASH_FLOW'),
    TOTAL_EQUITY: point('TOTAL_EQUITY'), TOTAL_FINANCING: point('TOTAL_FINANCING'),
    AVG_MONTHLY_CREDIT_TURNOVER: avgCredit, ANNUAL_CREDIT_TURNOVER: avgCredit === undefined ? undefined : avgCredit * 12,
    ALTBANK_WALLET_SHARE: sa?.summary?.walletSharePct ?? undefined,
    ELIGIBLE_COLLATERAL: col && col.count ? N(col.eligibleNgnMinor) : undefined, COLLATERAL_COVERAGE: col && col.count ? col.coveragePct : undefined,
    PRICING_RATE: rar ? Number(rar.pricing_rate_pct) : undefined, RARORAC: rar ? Number(rar.rarorac_pct) : undefined,
  };
}

export type EfficiencyResult =
  | { configured: false }
  | { configured: true; name: string; formula: string; unit: string; version: number; directedBy: string; directionReference: string; effectiveFrom: string | null; description: string;
      value: number | null; band: { label: string; assessment: string } | null; missing: string[]; error?: string; inputs: Record<string, number | undefined> };

/** Compute the ratio for a facility under the definition in force. */
export async function facilityEfficiency(db: Db, facilityId: string): Promise<EfficiencyResult> {
  const cfg = await getActive(db, 'facility_efficiency_ratio', 'STANDARD');
  if (!cfg) return { configured: false };
  const p = cfg.payload as any;
  const all = await efficiencyInputs(db, facilityId);
  const ast = parseFormula(p.formula);
  const used = [...collectVars(ast)];
  const inputs = Object.fromEntries(used.map((k) => [k, all[k]]));
  const r = evalFormula(ast, all);
  const value = r.ok ? Math.round(r.value * 10000) / 10000 : null;
  const band = value === null ? null : (p.bands as any[]).find((b) => (b.min === undefined || b.min === null || value >= b.min) && (b.max === undefined || b.max === null || value < b.max)) ?? null;
  return {
    configured: true, name: p.name, formula: p.formula, unit: p.unit, version: cfg.version, directedBy: p.directedBy, directionReference: p.directionReference, effectiveFrom: cfg.effective_from ? String(cfg.effective_from) : null, description: p.description,
    value, band: band ? { label: band.label, assessment: band.assessment } : null, missing: r.ok ? [] : (r as any).missing ?? [], ...(r.ok ? {} : { error: (r as any).error }), inputs,
  };
}

export const fmtEfficiency = (v: number | null, unit: string) => (v === null ? '—' : unit === '%' ? `${v.toFixed(2)}%` : unit === 'x' ? `${v.toFixed(2)}×` : unit === 'days' ? `${Math.round(v)} days` : unit === 'NGN' ? `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 2 })}` : v.toFixed(4));
