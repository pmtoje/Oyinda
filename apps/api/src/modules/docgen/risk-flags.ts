import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { formatMoney } from '../../lib/money.js';
import { buildFacts, collateralSummary } from '../facilities/facts.js';

export interface Evidence { source: string; ref: string; label: string; value: string }
export interface RiskFlag { code: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; statement: string; mitigantHint?: string; evidence: Evidence[] }

const pct = (v: number) => `${Math.round(v * 100) / 100}%`;

/**
 * Deterministic, evidence-backed risk flags. Every statement carries the data points it is based on, so neither
 * humans nor the AI layer can present an unsupported assertion.
 */
export async function riskFlags(db: Db, facilityId: string): Promise<RiskFlag[]> {
  const flags: RiskFlag[] = [];
  const f = await one<any>(db, 'SELECT * FROM facility_request WHERE id=$1', [facilityId]);
  const { facts } = await buildFacts(db, facilityId);
  const sa = await maybe<any>(db, 'SELECT * FROM statement_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  if (sa) {
    const s = sa.summary;
    const totals: any[] = sa.monthly?.totals ?? [];
    if (s.creditTrendPct !== null && s.creditTrendPct <= -10) {
      const first = totals.slice(0, 3), last = totals.slice(-3);
      flags.push({ code: 'TURNOVER_WEAKENING', severity: s.creditTrendPct <= -25 ? 'HIGH' : 'MEDIUM', statement: `Credit turnover has weakened by ${pct(Math.abs(s.creditTrendPct))} (average of the last three months against the first three).`, mitigantHint: 'Confirm seasonality or contract timing with the customer.',
        evidence: [...first, ...last].map((t) => ({ source: 'statement_analysis', ref: sa.id, label: `Adjusted credit turnover ${t.month}`, value: formatMoney(t.adjustedCreditNgnMinor) })) });
    }
    if (s.walletSharePct !== null && s.walletSharePct < 30) flags.push({ code: 'LOW_WALLET_SHARE', severity: 'LOW', statement: `Only ${pct(s.walletSharePct)} of the customer's credit turnover passes through Alternative Bank.`, mitigantHint: 'Require domiciliation of contract proceeds.', evidence: [{ source: 'statement_analysis', ref: sa.id, label: 'Wallet share', value: pct(s.walletSharePct) }] });
    if (s.creditVolatilityPct !== null && s.creditVolatilityPct > 50) flags.push({ code: 'VOLATILE_TURNOVER', severity: 'MEDIUM', statement: `Monthly credit turnover is volatile (coefficient of variation ${pct(s.creditVolatilityPct)}).`, evidence: [{ source: 'statement_analysis', ref: sa.id, label: 'Volatility', value: pct(s.creditVolatilityPct) }] });
    if (s.uncertainTransactions > 0) flags.push({ code: 'UNVALIDATED_STATEMENT_DATA', severity: 'MEDIUM', statement: `${s.uncertainTransactions} bank statement transaction(s) are unvalidated; turnover figures are provisional.`, evidence: [{ source: 'statement_analysis', ref: sa.id, label: 'Uncertain transactions', value: String(s.uncertainTransactions) }] });
  }
  const fa = await maybe<any>(db, 'SELECT * FROM financial_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  if (fa) {
    const latestId = fa.summary.periods?.[0]?.statementId;
    const rr = await q<any>(db, 'SELECT * FROM ratio_result WHERE analysis_id=$1 AND statement_id=$2', [fa.id, latestId]);
    const r = (k: string) => rr.find((x) => x.ratio_key === k);
    const lev = r('LEVERAGE');
    if (lev?.value != null && lev.value > 2) flags.push({ code: 'HIGH_LEVERAGE', severity: lev.value > 3.5 ? 'HIGH' : 'MEDIUM', statement: `Leverage is ${lev.value.toFixed(2)}× (total liabilities to equity).`, mitigantHint: 'Consider additional security or a reduced amount.', evidence: [{ source: 'ratio_result', ref: lev.id, label: 'Leverage', value: `${lev.value.toFixed(2)}×` }] });
    const cr = r('CURRENT_RATIO');
    if (cr?.value != null && cr.value < 1) flags.push({ code: 'WEAK_LIQUIDITY', severity: 'HIGH', statement: `Current liabilities exceed current assets (current ratio ${cr.value.toFixed(2)}×).`, evidence: [{ source: 'ratio_result', ref: cr.id, label: 'Current ratio', value: `${cr.value.toFixed(2)}×` }] });
    const nm = r('NET_MARGIN');
    if (nm?.value != null && nm.value < 0) flags.push({ code: 'LOSS_MAKING', severity: 'HIGH', statement: `The business was loss-making in the latest period (net margin ${pct(nm.value)}).`, evidence: [{ source: 'ratio_result', ref: nm.id, label: 'Net margin', value: pct(nm.value) }] });
    const fc = r('FINANCE_COST_COVER');
    if (fc?.value != null && fc.value < 1.5) flags.push({ code: 'THIN_COVER', severity: 'HIGH', statement: `EBITDA covers existing finance cost only ${fc.value.toFixed(2)}×.`, evidence: [{ source: 'ratio_result', ref: fc.id, label: 'Finance cost cover', value: `${fc.value.toFixed(2)}×` }] });
    const rg = r('REVENUE_GROWTH');
    if (rg?.value != null && rg.value < -10) flags.push({ code: 'REVENUE_DECLINE', severity: 'MEDIUM', statement: `Revenue fell ${pct(Math.abs(rg.value))} year on year.`, evidence: [{ source: 'ratio_result', ref: rg.id, label: 'Revenue growth', value: pct(rg.value) }] });
    for (const qi of (fa.summary.quality ?? []).filter((x: any) => x.severity === 'ERROR')) flags.push({ code: 'FINANCIAL_DATA_QUALITY', severity: 'MEDIUM', statement: qi.message, evidence: [{ source: 'financial_analysis', ref: fa.id, label: 'Data quality check', value: qi.message }] });
  }
  const ex = await maybe<any>(db, 'SELECT * FROM exposure_snapshot WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  if (ex?.sol_breached) flags.push({ code: 'SOL_BREACH', severity: 'HIGH', statement: `Aggregate exposure of ${formatMoney(ex.aggregate_minor)} exceeds the Single Obligor Limit of ${formatMoney(ex.sol_limit_minor)}.`, mitigantHint: `Reduce to a maximum of ${formatMoney(ex.lines?.maxSupportableMinor ?? 0)} or obtain Board approval.`, evidence: [{ source: 'exposure_snapshot', ref: ex.id, label: 'Aggregate exposure', value: formatMoney(ex.aggregate_minor) }, { source: 'exposure_snapshot', ref: ex.id, label: 'SOL', value: formatMoney(ex.sol_limit_minor) }] });
  if (ex?.sector_breached) flags.push({ code: 'SECTOR_LIMIT', severity: 'MEDIUM', statement: `Sector exposure would exceed the ${ex.sector_code} sector limit.`, evidence: [{ source: 'exposure_snapshot', ref: ex.id, label: 'Sector exposure', value: formatMoney(ex.sector_exposure_minor) }] });
  const col = await collateralSummary(db, facilityId, f.amount_minor ?? 0, f.currency);
  if (col.count && col.coveragePct < 100) flags.push({ code: 'SECURITY_SHORTFALL', severity: col.coveragePct < 50 ? 'HIGH' : 'MEDIUM', statement: `Eligible security covers ${pct(col.coveragePct)} of the facility.`, evidence: [{ source: 'collateral', ref: facilityId, label: 'Eligible collateral', value: formatMoney(col.eligibleNgnMinor) }] });
  const rar = await maybe<any>(db, `SELECT * FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  if (rar?.exception_required) flags.push({ code: 'PRICING_EXCEPTION', severity: 'MEDIUM', statement: `RARORAC of ${pct(rar.rarorac_pct)} is below the ${pct(rar.hurdle_pct)} hurdle (or pricing below the minimum).`, mitigantHint: rar.justification ? 'Exception justified by the analyst.' : 'Justification required.', evidence: [{ source: 'rarorac_computation', ref: rar.id, label: `RARORAC (${rar.mode})`, value: pct(rar.rarorac_pct) }] });
  const es = await maybe<any>(db, `SELECT * FROM es_assessment WHERE facility_id=$1 AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [facilityId]);
  if (es?.category === 'A') flags.push({ code: 'ES_CATEGORY_A', severity: 'HIGH', statement: 'The transaction is E&S Category A (significant adverse impact potential).', evidence: [{ source: 'es_assessment', ref: es.id, label: 'E&S category', value: 'A' }] });
  if (es?.recommendation === 'DO_NOT_PROCEED') flags.push({ code: 'ES_DO_NOT_PROCEED', severity: 'HIGH', statement: 'The E&S review recommends not proceeding.', evidence: [{ source: 'es_assessment', ref: es.id, label: 'Recommendation', value: 'Do not proceed' }] });
  const bur = await q<any>(db, `SELECT * FROM bureau_check WHERE facility_id=$1 AND status='COMPLETED' AND delinquent_facilities > 0`, [facilityId]);
  for (const b of bur) flags.push({ code: 'BUREAU_DELINQUENCY', severity: 'HIGH', statement: `${b.subject_name} has ${b.delinquent_facilities} delinquent facility(ies) on bureau (${b.worst_classification}).`, evidence: [{ source: 'bureau_check', ref: b.id, label: `${b.provider} report ${b.report_reference ?? ''}`.trim(), value: b.worst_classification }] });
  if (facts.customer.isPep) flags.push({ code: 'PEP', severity: 'MEDIUM', statement: 'A politically exposed person is linked to the customer; the PEP approval route applies.', evidence: [{ source: 'business_party', ref: f.customer_id, label: 'PEP indicator', value: 'Yes' }] });
  if (facts.customer.isInsider) flags.push({ code: 'INSIDER', severity: 'MEDIUM', statement: 'The customer is insider-related; Board approval is required.', evidence: [{ source: 'business_party', ref: f.customer_id, label: 'Insider indicator', value: 'Yes' }] });
  if (f.currency !== 'NGN') flags.push({ code: 'FX_RISK', severity: 'MEDIUM', statement: `The facility is denominated in ${f.currency}; confirm the customer's foreign currency earnings.`, evidence: [{ source: 'facility_request', ref: f.id, label: 'Currency', value: f.currency }] });
  return flags.sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[a.severity] - ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[b.severity]);
}
