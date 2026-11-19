import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { evaluate } from '@gazelle/shared';
import { getActive, getById, listActive } from '../config/service.js';
import { toNgn } from '../fx/service.js';

const yearsBetween = (from?: string | Date | null, to = new Date()) => (from ? (to.getTime() - new Date(from).getTime()) / (365.25 * 86400_000) : undefined);

/**
 * Assemble the fact set used by every rule (FIPG, document requirements, E&S trigger, workflow routing).
 * Facts are derived from persisted, server-side data only. Values that are not yet known are left undefined
 * so rules report them as incomplete rather than guessing.
 */
export async function buildFacts(db: Db, facilityId: string) {
  const f = await one<any>(db, 'SELECT * FROM facility_request WHERE id=$1', [facilityId]);
  const product = await getById<any>(db, f.product_config_id);
  const customer = await one<any>(db, 'SELECT * FROM customer WHERE id=$1', [f.customer_id]);
  const profile = await maybe<any>(db, 'SELECT * FROM business_profile WHERE customer_id=$1', [f.customer_id]);
  const parties = await q<any>(db, 'SELECT is_pep, is_insider FROM business_party WHERE customer_id=$1 AND deleted_at IS NULL', [f.customer_id]);
  const fs = await q<any>(db, `SELECT fs.*, (SELECT json_object_agg(line_code, amount_minor) FROM financial_line_item WHERE statement_id=fs.id) AS lines
     FROM financial_statement fs WHERE customer_id=$1 AND deleted_at IS NULL AND status <> 'REJECTED' ORDER BY period_end DESC`, [f.customer_id]);
  const audited = fs.filter((s) => s.statement_type === 'AUDITED');
  const latest = audited[0];
  const bureau = await q<any>(db, `SELECT delinquent_facilities FROM bureau_check WHERE facility_id=$1 AND status='COMPLETED'`, [facilityId]);
  const sa = await maybe<any>(db, 'SELECT summary FROM statement_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const exposure = await maybe<any>(db, 'SELECT sol_breached FROM exposure_snapshot WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const rar = await maybe<any>(db, `SELECT within_threshold FROM rarorac_computation WHERE facility_id=$1 AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const combined = await maybe<any>(db, `SELECT grade FROM risk_assessment WHERE facility_id=$1 AND kind='COMBINED' AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [facilityId]);
  const es = await maybe<any>(db, `SELECT category FROM es_assessment WHERE facility_id=$1 AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [facilityId]);
  const col = await collateralSummary(db, facilityId, f.amount_minor ?? 0, f.currency);

  let amountNgnMinor: number | undefined;
  if (f.amount_minor) {
    try { amountNgnMinor = (await toNgn(db, f.amount_minor, f.currency)).minor; } catch { amountNgnMinor = undefined; }
  }
  const avgCredit = sa?.summary?.avgMonthlyCreditTurnoverNgnMinor as number | undefined;
  const months = latest?.months ?? 12;
  const revenue = latest?.lines?.REVENUE;
  const pat = latest?.lines?.PROFIT_AFTER_TAX;

  const facts: Record<string, any> = {
    facility: {
      amount: f.amount_minor ? f.amount_minor / 100 : undefined,
      amountNgn: amountNgnMinor !== undefined ? amountNgnMinor / 100 : undefined,
      currency: f.currency,
      tenorMonths: f.tenor_months ?? undefined,
      productCode: f.product_code,
      productFamily: product.payload.family,
      category: product.payload.category,
      origin: f.origin,
      isContingent: product.payload.category === 'CONTINGENT',
      isProductPaper: !!product.payload.isProductPaper,
      collateralCoveragePct: col.coveragePct,
      isCashBacked: col.isCashBacked,
      creditTurnoverCoverX: avgCredit && amountNgnMinor ? (avgCredit * 12) / amountNgnMinor : undefined,
    },
    customer: {
      category: customer.customer_category,
      sector: profile?.sector_code ?? undefined,
      yearsInOperation: yearsBetween(profile?.incorporation_date),
      yearsWithBank: yearsBetween(customer.created_at) !== undefined ? Math.max(yearsBetween(customer.created_at)!, 0) : undefined,
      hasRcNumber: !!profile?.rc_number,
      hasTin: !!profile?.tin,
      hasLitigation: profile?.has_litigation ?? undefined,
      hasRegulatoryMatters: profile?.has_regulatory_matters ?? undefined,
      isPep: parties.some((p) => p.is_pep),
      isInsider: parties.some((p) => p.is_insider),
      auditedYears: audited.length,
      latestRevenueNgn: revenue !== undefined ? (revenue / 100) * (12 / months) : undefined,
      latestPatNgn: pat !== undefined ? pat / 100 : undefined,
      hasDelinquentBureau: bureau.length ? bureau.some((b) => (b.delinquent_facilities ?? 0) > 0) : undefined,
      avgMonthlyCreditTurnoverNgn: avgCredit !== undefined ? avgCredit / 100 : undefined,
    },
    risk: {
      combinedGrade: combined?.grade ?? undefined,
      esRequired: false,
      esCategory: es?.category ?? undefined,
      solBreached: exposure ? exposure.sol_breached : undefined,
      raroracWithinThreshold: rar ? rar.within_threshold : undefined,
    },
  };
  // Customer years-with-bank: prefer the CBA relationship start date captured at onboarding.
  const trig = await getActive(db, 'es_trigger', 'STANDARD');
  if (trig) facts.risk.esRequired = evaluate(trig.payload.triggerWhen as any, facts).result;
  return { facts, facility: f, product, esTriggerConfigId: trig?.id };
}

export async function collateralSummary(db: Db, facilityId: string, amountMinor: number, _ccy: string) {
  const rows = await q<any>(db, 'SELECT * FROM collateral WHERE facility_id=$1 AND deleted_at IS NULL', [facilityId]);
  const types = new Map((await listActive(db, 'collateral_type')).map((t) => [t.key, t.payload]));
  const policy = await getActive(db, 'policy_cash_backed', 'STANDARD');
  let eligible = 0, cash = 0;
  for (const r of rows) {
    const t = types.get(r.type_key);
    if (t?.countsTowardsCoverage === false) continue;
    eligible += r.eligible_value_ngn_minor;
    if (policy?.payload.eligibleTypeCodes.includes(r.type_key)) cash += r.eligible_value_ngn_minor;
  }
  const coveragePct = amountMinor > 0 ? Math.round((eligible / amountMinor) * 10000) / 100 : 0;
  const cashPct = amountMinor > 0 ? (cash / amountMinor) * 100 : 0;
  return { count: rows.length, eligibleNgnMinor: eligible, coveragePct, isCashBacked: !!policy && rows.length > 0 && cashPct >= policy.payload.minCashCoveragePct, cashCoveragePct: Math.round(cashPct * 100) / 100, items: rows };
}
