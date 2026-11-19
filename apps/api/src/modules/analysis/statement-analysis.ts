export interface StmtInput { id: string; bank_name: string; is_alternative_bank: boolean; account_number: string; currency: string; period_start: string; period_end: string }
export interface TxnInput { statement_id: string; txn_date: string | null; debit_minor: number; credit_minor: number; balance_minor: number | null; category: string; txn_fingerprint: string; uncertain: boolean }
export interface Rate { id: string; base_ccy: string; rate: number; rate_date: string }

const monthKey = (d: string) => d.slice(0, 7);
function monthsBetween(start: string, end: string) {
  const out: string[] = [];
  let y = +start.slice(0, 4), m = +start.slice(5, 7);
  const ey = +end.slice(0, 4), em = +end.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

/**
 * Bank statement analysis across multiple banks, accounts and currencies.
 * FCY is converted to NGN with the latest approved rate on or before each month end; every rate used is returned for audit.
 */
export function analyseStatements(stmts: StmtInput[], txns: TxnInput[], rateFor: (ccy: string, monthEnd: string) => Rate | null) {
  const issues: { severity: 'ERROR' | 'WARNING'; message: string }[] = [];
  const ratesUsed = new Map<string, Rate>();
  const byAccount = new Map<string, StmtInput[]>();
  for (const s of stmts) byAccount.set(`${s.bank_name}|${s.account_number}|${s.currency}`, [...(byAccount.get(`${s.bank_name}|${s.account_number}|${s.currency}`) ?? []), s]);
  // Overlaps and missing months per account
  for (const [key, list] of byAccount) {
    const sorted = [...list].sort((a, b) => a.period_start.localeCompare(b.period_start));
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.period_start <= sorted[i - 1]!.period_end) issues.push({ severity: 'WARNING', message: `Overlapping statements for ${key.split('|')[0]} account ••••${key.split('|')[1]!.slice(-4)} (${sorted[i - 1]!.period_end} / ${sorted[i]!.period_start}). Duplicate transactions are counted once.` });
  }
  // Transaction-level de-duplication across overlapping statements of the same account
  const stmtById = new Map(stmts.map((s) => [s.id, s]));
  const seen = new Set<string>();
  let dupCount = 0;
  const unique = txns.filter((t) => {
    const s = stmtById.get(t.statement_id)!;
    const k = `${s.bank_name}|${s.account_number}|${t.txn_fingerprint}`;
    if (seen.has(k)) { dupCount++; return false; }
    seen.add(k); return true;
  });
  if (dupCount) issues.push({ severity: 'WARNING', message: `${dupCount} duplicate transaction(s) found across overlapping statements and excluded.` });
  const uncertain = unique.filter((t) => t.uncertain).length;
  if (uncertain) issues.push({ severity: 'WARNING', message: `${uncertain} transaction(s) are flagged as uncertain and await validation; figures that depend on them are provisional.` });

  type Row = { account: string; bank: string; isAltBank: boolean; currency: string; month: string; debitMinor: number; creditMinor: number; adjustedCreditMinor: number; closingBalanceMinor: number | null; txnCount: number; debitNgnMinor: number | null; creditNgnMinor: number | null; adjustedCreditNgnMinor: number | null; closingBalanceNgnMinor: number | null; fxRateId: string | null };
  const monthly: Row[] = [];
  for (const [key, list] of byAccount) {
    const [bank, account, ccy] = key.split('|') as [string, string, string];
    const ids = new Set(list.map((s) => s.id));
    const start = list.map((s) => s.period_start).sort()[0]!;
    const end = list.map((s) => s.period_end).sort().at(-1)!;
    const covered = new Set(list.flatMap((s) => monthsBetween(s.period_start, s.period_end)));
    const range = monthsBetween(start, end);
    const missing = range.filter((m) => !covered.has(m));
    if (missing.length) issues.push({ severity: 'WARNING', message: `Missing statement months for ${bank} ••••${account.slice(-4)}: ${missing.join(', ')}.` });
    const at = unique.filter((t) => ids.has(t.statement_id) && t.txn_date);
    for (const m of range.filter((x) => covered.has(x))) {
      const mt = at.filter((t) => monthKey(t.txn_date!) === m).sort((a, b) => a.txn_date!.localeCompare(b.txn_date!));
      const debit = mt.reduce((a, t) => a + t.debit_minor, 0);
      const credit = mt.reduce((a, t) => a + t.credit_minor, 0);
      const adjusted = mt.filter((t) => t.category !== 'REVERSAL').reduce((a, t) => a + t.credit_minor, 0);
      const closing = [...mt].reverse().find((t) => t.balance_minor !== null)?.balance_minor ?? null;
      let rate: Rate | null = null;
      if (ccy !== 'NGN') {
        const monthEnd = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
        rate = rateFor(ccy, monthEnd);
        if (!rate) issues.push({ severity: 'ERROR', message: `No approved ${ccy}/NGN rate for ${m}; ${ccy} turnover for that month is excluded from NGN totals.` });
        else ratesUsed.set(rate.id, rate);
      }
      const conv = (v: number) => (ccy === 'NGN' ? v : rate ? Math.round(v * rate.rate) : null);
      monthly.push({ account, bank, isAltBank: list[0]!.is_alternative_bank, currency: ccy, month: m, debitMinor: debit, creditMinor: credit, adjustedCreditMinor: adjusted, closingBalanceMinor: closing, txnCount: mt.length, debitNgnMinor: conv(debit), creditNgnMinor: conv(credit), adjustedCreditNgnMinor: conv(adjusted), closingBalanceNgnMinor: closing === null ? null : conv(closing), fxRateId: rate?.id ?? null });
    }
  }
  const months = [...new Set(monthly.map((r) => r.month))].sort();
  const totals = months.map((m) => {
    const rs = monthly.filter((r) => r.month === m);
    const sum = (f: (r: Row) => number | null) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
    const credit = sum((r) => r.creditNgnMinor);
    const altCredit = rs.filter((r) => r.isAltBank).reduce((a, r) => a + (r.creditNgnMinor ?? 0), 0);
    // SWR: MONTHS | DEBIT | CREDIT | CLOSING BALANCES | WALLET SHARE (%) — all in NGN; FCY converted at the recorded rate.
    return { month: m, creditNgnMinor: credit, adjustedCreditNgnMinor: sum((r) => r.adjustedCreditNgnMinor), debitNgnMinor: sum((r) => r.debitNgnMinor), altBankCreditNgnMinor: altCredit,
      closingBalanceNgnMinor: rs.some((r) => r.closingBalanceNgnMinor !== null) ? sum((r) => r.closingBalanceNgnMinor) : null,
      walletSharePct: credit > 0 ? Math.round((altCredit / credit) * 10000) / 100 : null };
  });
  const n = totals.length || 1;
  const totalCredit = totals.reduce((a, t) => a + t.creditNgnMinor, 0);
  const totalAdjusted = totals.reduce((a, t) => a + t.adjustedCreditNgnMinor, 0);
  const altCredit = totals.reduce((a, t) => a + t.altBankCreditNgnMinor, 0);
  const first3 = totals.slice(0, 3), last3 = totals.slice(-3);
  const avg = (xs: typeof totals) => (xs.length ? xs.reduce((a, t) => a + t.adjustedCreditNgnMinor, 0) / xs.length : 0);
  const trendPct = totals.length >= 6 && avg(first3) > 0 ? Math.round(((avg(last3) - avg(first3)) / avg(first3)) * 10000) / 100 : null;
  const mean = totalAdjusted / n;
  const sd = Math.sqrt(totals.reduce((a, t) => a + (t.adjustedCreditNgnMinor - mean) ** 2, 0) / n);
  const summary = {
    monthsCovered: totals.length, firstMonth: months[0] ?? null, lastMonth: months.at(-1) ?? null, accounts: byAccount.size, banks: new Set(stmts.map((s) => s.bank_name)).size,
    totalCreditNgnMinor: totalCredit, totalAdjustedCreditNgnMinor: totalAdjusted, totalDebitNgnMinor: totals.reduce((a, t) => a + t.debitNgnMinor, 0),
    avgMonthlyCreditTurnoverNgnMinor: Math.round(totalAdjusted / n), avgMonthlyDebitTurnoverNgnMinor: Math.round(totals.reduce((a, t) => a + t.debitNgnMinor, 0) / n),
    walletSharePct: totalCredit > 0 ? Math.round((altCredit / totalCredit) * 10000) / 100 : null,
    creditTrendPct: trendPct, creditVolatilityPct: mean > 0 ? Math.round((sd / mean) * 10000) / 100 : null,
    reversalsNgnMinor: totalCredit - totalAdjusted, duplicateTransactionsExcluded: dupCount, uncertainTransactions: uncertain,
  };
  return { summary, monthly, totals, issues, fxRates: [...ratesUsed.values()] };
}
