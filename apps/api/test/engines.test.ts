import { describe, expect, it } from 'vitest';
import { analyse, annualised, withDerived } from '../src/modules/analysis/financial-engine.js';
import { parseAmount, parseDate, parseRows, splitCsv, categorise, normaliseDescription } from '../src/modules/analysis/statement-parser.js';
import { analyseStatements } from '../src/modules/analysis/statement-analysis.js';
import { aggregateExposure, combinedRating, scoreQuestionnaire } from '../src/modules/analysis/risk-engine.js';
import { committeeDecision, resolveChain } from '../src/modules/workflow/authority.js';
import { addBusinessHours, businessMsBetween, computeDue } from '../src/modules/workflow/sla.js';
import { evaluateRules } from '../src/modules/fipg/service.js';
import { validateFacility } from '../src/modules/facilities/validation.js';
import { hasFormulaCell, checkFile } from '../src/modules/documents/mime.js';
import { BASELINE } from '../src/seed/baseline-config.js';

const cfg = (kind: string, key?: string) => BASELINE.filter((b) => b.kind === kind && (!key || b.key === key));
const template = (cfg('financial_template')[0]!.payload as any).lines;
const ratios = cfg('ratio').map((r, i) => ({ id: `r${i}`, key: r.key, payload: r.payload as any }));
const N = (n: number) => n * 100;

const fy = (year: number, rev: number, pat: number) => ({
  id: `fs${year}`, statement_type: 'AUDITED', period_start: `${year}-01-01`, period_end: `${year}-12-31`, months: 12, currency: 'NGN',
  lines: { REVENUE: N(rev), COST_OF_SALES: N(rev * 0.7), OPERATING_EXPENSES: N(rev * 0.15), DEPRECIATION: N(rev * 0.03), FINANCE_COST: N(rev * 0.02), PROFIT_BEFORE_TAX: N(pat * 1.3), PROFIT_AFTER_TAX: N(pat), NON_CURRENT_ASSETS: N(900), CURRENT_ASSETS: N(600), INVENTORY: N(200), TRADE_RECEIVABLES: N(150), TOTAL_ASSETS: N(1500), CURRENT_LIABILITIES: N(400), TOTAL_LIABILITIES: N(800), TOTAL_EQUITY: N(700), SHORT_TERM_FINANCING: N(150), LONG_TERM_FINANCING: N(250) },
});

describe('financial statement engine', () => {
  it('derives gross profit, operating profit, EBITDA and working capital', () => {
    const l = withDerived(fy(2025, 2000, 120).lines, template);
    expect(l.GROSS_PROFIT).toBe(N(600));
    expect(l.OPERATING_PROFIT).toBe(N(300));
    expect(l.EBITDA).toBe(N(360));
    expect(l.WORKING_CAPITAL).toBe(N(200));
    expect(l.TOTAL_FINANCING).toBe(N(400));
  });
  it('annualises flows for a 6-month management account but not balances', () => {
    const a = annualised({ REVENUE: N(1000), TOTAL_ASSETS: N(5000) }, 6, template);
    expect(a.REVENUE).toBe(N(2000));
    expect(a.TOTAL_ASSETS).toBe(N(5000));
  });
  it('computes configured ratios, growth vs prior year, bands and an FRR score', () => {
    const r = analyse([fy(2025, 2200, 140), fy(2024, 2000, 120), fy(2023, 1800, 100)], template, ratios);
    const latest = r.periods[0]!;
    const get = (k: string) => latest.results.find((x) => x.ratio.key === k)!;
    expect(get('CURRENT_RATIO').value).toBeCloseTo(1.5);
    expect(get('CURRENT_RATIO').band!.label).toBe('Adequate');
    expect(get('GROSS_MARGIN').value).toBeCloseTo(30);
    expect(get('REVENUE_GROWTH').value).toBeCloseTo(10);
    expect(get('LEVERAGE').value).toBeCloseTo(800 / 700);
    expect(r.frrScore).toBeGreaterThan(0);
    expect(r.frrScore).toBeLessThanOrEqual(100);
    expect(r.periods[2]!.results.find((x) => x.ratio.key === 'REVENUE_GROWTH')!.error).toMatch(/Missing/);
  });
  it('flags missing years, unbalanced balance sheets and mixed currencies', () => {
    const bad = { ...fy(2025, 1000, 50), lines: { ...fy(2025, 1000, 50).lines, TOTAL_ASSETS: N(9999) } };
    const r = analyse([bad, { ...fy(2023, 900, 40), currency: 'USD' }], template, ratios);
    const msgs = r.quality.map((q) => q.message).join('\n');
    expect(msgs).toMatch(/Only 2 audited/);
    expect(msgs).toMatch(/does not balance/);
    expect(msgs).toMatch(/missing financial year/);
    expect(msgs).toMatch(/different currencies/);
  });
});

describe('bank statement parser', () => {
  it('parses Nigerian date formats and refuses ambiguous ones', () => {
    expect(parseDate('05/03/2026')).toBe('2026-03-05');
    expect(parseDate('5-Mar-26')).toBe('2026-03-05');
    expect(parseDate('2026-03-05')).toBe('2026-03-05');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
  });
  it('parses amounts without guessing', () => {
    expect(parseAmount('1,250,000.50')).toBe(125000050);
    expect(parseAmount('(2,000.00)')).toBe(-200000);
    expect(parseAmount('3,000.00DR')).toBe(-300000);
    expect(parseAmount('₦4,500')).toBe(450000);
    expect(parseAmount('12,34,5')).toBeNull();
    expect(parseAmount('1.2.3')).toBeNull();
  });
  it('normalises and categorises descriptions', () => {
    const n = normaliseDescription('NIP TRF FROM DANGOTE BOTTLING REF 000123456789');
    expect(n).toBe('NIP TRF FROM DANGOTE BOTTLING REF #');
    expect(categorise(n, 100)).toBe('TRANSFER_IN');
    expect(categorise('SMS ALERT CHARGES', 0)).toBe('CHARGES');
    expect(categorise('REVERSAL OF TRF', 100)).toBe('REVERSAL');
  });
  it('detects columns, account number, and flags unreconciled balances as uncertain', () => {
    const csv = `Account Number: 0100000001\nTrans Date,Value Date,Narration,Debit,Credit,Balance\n01/01/2026,01/01/2026,Opening,,,"1,000.00"\n02/01/2026,02/01/2026,NIP TRF FROM CUSTOMER A,,"500.00","1,500.00"\n03/01/2026,03/01/2026,POS PURCHASE,"200.00",,"1,300.00"\n04/01/2026,04/01/2026,TRANSFER,"100.00",,"9,999.00"\nbad-date,,SOMETHING,"10.00",,"9,989.00"\n`;
    const r = parseRows(splitCsv(csv), 'csv-v1');
    expect(r.ok).toBe(true);
    expect(r.detectedAccountNumber).toBe('0100000001');
    expect(r.transactions).toHaveLength(5);
    const t4 = r.transactions[3]!;
    expect(t4.uncertain).toBe(true);
    expect(t4.uncertainReason).toMatch(/does not reconcile/);
    expect(r.transactions[4]!.uncertainReason).toMatch(/Unreadable transaction date/);
    expect(r.issues.join(' ')).toMatch(/2 transaction\(s\) could not be read/);
  });
  it('fails honestly when columns cannot be identified', () => {
    const r = parseRows(splitCsv('foo,bar\n1,2\n'), 'csv-v1');
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/manual capture or OCR/);
  });
});

describe('bank statement analysis', () => {
  const stmts = [
    { id: 's1', bank_name: 'Alternative Bank', is_alternative_bank: true, account_number: '0100000001', currency: 'NGN', period_start: '2026-01-01', period_end: '2026-03-31' },
    { id: 's2', bank_name: 'Alternative Bank', is_alternative_bank: true, account_number: '0100000001', currency: 'NGN', period_start: '2026-03-01', period_end: '2026-04-30' },
    { id: 's3', bank_name: 'Other Bank', is_alternative_bank: false, account_number: '2200000001', currency: 'USD', period_start: '2026-01-01', period_end: '2026-02-28' },
    { id: 's4', bank_name: 'Alternative Bank', is_alternative_bank: true, account_number: '0100000009', currency: 'NGN', period_start: '2026-01-01', period_end: '2026-01-31' },
  ];
  const t = (statement_id: string, d: string, credit: number, debit = 0, fp?: string, category = 'TRANSFER_IN') => ({ statement_id, txn_date: d, credit_minor: credit, debit_minor: debit, balance_minor: null, category, txn_fingerprint: fp ?? `${statement_id}${d}${credit}${debit}`, uncertain: false });
  const txns = [
    t('s1', '2026-01-10', N(1000)), t('s1', '2026-02-10', N(1000)), t('s1', '2026-03-10', N(1000), 0, 'dup'), t('s1', '2026-03-12', N(50), 0, undefined, 'REVERSAL'),
    t('s2', '2026-03-10', N(1000), 0, 'dup'), t('s2', '2026-04-10', N(1000), N(300)),
    t('s3', '2026-01-15', N(10)), t('s3', '2026-02-15', N(10)),
  ];
  const rate = { id: 'fx1', base_ccy: 'USD', rate: 1500, rate_date: '2026-01-01' };
  it('computes turnover, wallet share, overlaps, duplicates and FX with auditable rates', () => {
    const r = analyseStatements(stmts, txns, (ccy) => (ccy === 'USD' ? rate : null));
    expect(r.summary.duplicateTransactionsExcluded).toBe(1);
    expect(r.issues.some((i) => /Overlapping/.test(i.message))).toBe(true);
    const jan = r.totals.find((x) => x.month === '2026-01')!;
    expect(jan.creditNgnMinor).toBe(N(1000) + N(10) * 1500);
    expect(r.summary.reversalsNgnMinor).toBe(N(50));
    expect(r.fxRates.map((x) => x.id)).toEqual(['fx1']);
    expect(r.summary.walletSharePct).toBeGreaterThan(0);
    expect(r.summary.walletSharePct).toBeLessThan(100);
  });
  it('never invents an FX rate', () => {
    const r = analyseStatements(stmts, txns, () => null);
    expect(r.issues.some((i) => i.severity === 'ERROR' && /No approved USD\/NGN rate/.test(i.message))).toBe(true);
    expect(r.monthly.filter((m) => m.currency === 'USD').every((m) => m.creditNgnMinor === null)).toBe(true);
  });
  it('identifies missing months', () => {
    const gap = [{ ...stmts[0]!, period_end: '2026-01-31' }, { ...stmts[1]!, id: 'sx', period_start: '2026-03-01' }];
    const r = analyseStatements(gap, [], () => null);
    expect(r.issues.some((i) => /Missing statement months .*2026-02/.test(i.message))).toBe(true);
  });
});

describe('approval authority', () => {
  const authority = cfg('approval_authority', 'STANDARD')[0]!.payload as any;
  const facts = (o: Record<string, any> = {}) => ({ facility: { isCashBacked: false, ...o.facility }, customer: { isInsider: false, isPep: false, ...o.customer }, risk: { solBreached: false, raroracWithinThreshold: true, ...o.risk } });
  it('routes by amount: ₦150m → CRO recommends, ED approves', () => {
    const r = resolveChain(authority, facts(), N(150_000_000));
    expect(r.chain.map((l) => l.code)).toEqual(['CRO', 'ED']);
    expect(r.chain[1]!.isFinal).toBe(true);
  });
  it('routes small amounts to the CRO alone and very large amounts to the Board', () => {
    expect(resolveChain(authority, facts(), N(50_000_000)).finalLevel.code).toBe('CRO');
    expect(resolveChain(authority, facts(), N(3_000_000_000)).finalLevel.code).toBe('BCC');
    expect(resolveChain(authority, facts(), N(9_000_000_000)).finalLevel.code).toBe('BOARD');
  });
  it('applies cash-backed limits', () => {
    expect(resolveChain(authority, facts({ facility: { isCashBacked: true } }), N(200_000_000)).finalLevel.code).toBe('CRO');
  });
  it('sends insider-related facilities to the Board irrespective of amount', () => {
    const r = resolveChain(authority, facts({ customer: { isInsider: true } }), N(10_000_000));
    expect(r.finalLevel.code).toBe('BOARD');
    expect(r.reasons.join(' ')).toMatch(/INSIDER_RELATED/);
  });
  it('routes PEP to at least MD, and pricing exceptions to at least ED', () => {
    expect(resolveChain(authority, facts({ customer: { isPep: true } }), N(10_000_000)).finalLevel.code).toBe('MD');
    expect(resolveChain(authority, facts({ risk: { raroracWithinThreshold: false } }), N(10_000_000)).finalLevel.code).toBe('ED');
    expect(resolveChain(authority, facts({ risk: { solBreached: true } }), N(10_000_000)).finalLevel.code).toBe('BOARD');
  });
});

describe('committee decisions', () => {
  const rules = { quorum: 3, requiredApprovals: 3, requiredRoles: ['MD'], voting: 'PARALLEL' as const, serialOrder: [] };
  const members = [{ id: 'md', roles: ['MD'] }, { id: 'ed', roles: ['ED'] }, { id: 'cro', roles: ['CRO'] }, { id: 'm1', roles: ['MIC_MEMBER'] }];
  it('approves only with quorum, required approvals and required roles', () => {
    expect(committeeDecision(rules, members, [{ member_id: 'ed', member_role: 'ED', vote: 'APPROVE' }, { member_id: 'cro', member_role: 'CRO', vote: 'APPROVE' }])).toBe('PENDING');
    expect(committeeDecision(rules, members, [{ member_id: 'ed', member_role: 'ED', vote: 'APPROVE' }, { member_id: 'cro', member_role: 'CRO', vote: 'APPROVE' }, { member_id: 'm1', member_role: 'MIC_MEMBER', vote: 'APPROVE' }])).toBe('PENDING');
    expect(committeeDecision(rules, members, [{ member_id: 'ed', member_role: 'ED', vote: 'APPROVE' }, { member_id: 'cro', member_role: 'CRO', vote: 'APPROVE' }, { member_id: 'md', member_role: 'MD', vote: 'APPROVE' }])).toBe('APPROVED');
  });
  it('declines when approval becomes impossible', () => {
    expect(committeeDecision(rules, members, [{ member_id: 'md', member_role: 'MD', vote: 'DECLINE' }])).toBe('DECLINED');
    expect(committeeDecision(rules, members, [{ member_id: 'ed', member_role: 'ED', vote: 'DECLINE' }, { member_id: 'cro', member_role: 'CRO', vote: 'DECLINE' }])).toBe('DECLINED');
  });
});

describe('SLA business hours', () => {
  const cal = { timezoneOffsetMinutes: 60, workdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 17, holidays: ['2026-12-25'] };
  it('skips nights, weekends and holidays', () => {
    // Thu 24 Dec 2026 16:00 WAT (15:00Z) + 2h → Mon 28 Dec 09:00 WAT (25th holiday, 26/27 weekend)
    expect(addBusinessHours(new Date('2026-12-24T15:00:00Z'), 2, cal).toISOString()).toBe('2026-12-28T08:00:00.000Z');
    // Mon 08:00 WAT + 9h = Mon 17:00 WAT
    expect(addBusinessHours(new Date('2026-11-16T07:00:00Z'), 9, cal).toISOString()).toBe('2026-11-16T16:00:00.000Z');
    expect(businessMsBetween(new Date('2026-11-16T07:00:00Z'), new Date('2026-11-17T16:00:00Z'), cal)).toBe(18 * 3600_000);
  });
  it('computes warning thresholds and calendar SLAs', () => {
    const d = computeDue(new Date('2026-11-16T07:00:00Z'), { durationHours: 16, calendar: 'BUSINESS', warnAtPct: 75 }, cal);
    expect(d.warnAt.toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(d.dueAt.toISOString()).toBe('2026-11-17T14:00:00.000Z');
    const c = computeDue(new Date('2026-11-16T07:00:00Z'), { durationHours: 24, calendar: 'CALENDAR', warnAtPct: 50 }, cal);
    expect(c.dueAt.toISOString()).toBe('2026-11-17T07:00:00.000Z');
  });
});

describe('FIPG rules', () => {
  const rules = cfg('fipg_rule').map((r, i) => ({ id: `f${i}`, key: r.key, version: 1, payload: r.payload as any }));
  const base = { facility: { amountNgn: 150_000_000, category: 'DIRECT', productCode: 'MURABAHA', creditTurnoverCoverX: 3 }, customer: { hasRcNumber: true, hasTin: true, yearsInOperation: 15, sector: 'MANUFACTURING', auditedYears: 3, latestPatNgn: 50_000_000, hasDelinquentBureau: false, yearsWithBank: 8 } };
  it('passes a well-documented customer', () => expect(evaluateRules(rules, base).outcome).toBe('ELIGIBLE'));
  it('declines Shariah-excluded sectors', () => expect(evaluateRules(rules, { ...base, customer: { ...base.customer, sector: 'EXCLUDED_ALCOHOL' } }).outcome).toBe('INELIGIBLE'));
  it('requires an exception for short operating history', () => expect(evaluateRules(rules, { ...base, customer: { ...base.customer, yearsInOperation: 1 } }).outcome).toBe('EXCEPTION_REQUIRED'));
  it('does not treat missing bureau data as a clean record', () => {
    const r = evaluateRules(rules, { ...base, customer: { ...base.customer, hasDelinquentBureau: undefined } });
    const bureau = r.results.find((x) => x.rule.key === 'FIPG_CLEAN_BUREAU')!;
    expect(bureau.applicable).toBe(false);
    expect(bureau.passed).not.toBe(true);
    expect(evaluateRules(rules, { ...base, customer: { ...base.customer, hasDelinquentBureau: true } }).outcome).toBe('REFER');
  });
  it('treats unknown facts as incomplete for every operator except exists', async () => {
    const { evaluate } = await import('@gazelle/shared');
    expect(evaluate({ fact: 'x.y', op: 'falsy' }, {}).incomplete).toBe(true);
    expect(evaluate({ fact: 'x.y', op: 'falsy' }, {}).result).toBe(false);
    expect(evaluate({ fact: 'x.y', op: 'exists' }, {}).incomplete).toBe(false);
  });
  it('treats audited-year rule as not applicable below ₦50m', () => {
    const r = evaluateRules(rules, { ...base, facility: { ...base.facility, amountNgn: 20_000_000 }, customer: { ...base.customer, auditedYears: 0 } });
    expect(r.results.find((x) => x.rule.key === 'FIPG_AUDITED_FINANCIALS')!.applicable).toBe(false);
  });
});

describe('scorecards and exposure', () => {
  const orr = cfg('scorecard', 'ORR_STANDARD')[0]!.payload as any;
  it('scores a questionnaire and reports unanswered questions', () => {
    const best = Object.fromEntries(orr.sections.flatMap((s: any) => s.questions.map((q: any) => [q.code, q.options.at(-1).code])));
    const r = scoreQuestionnaire(orr, best);
    expect(r.score).toBe(100);
    expect(r.grade).toBe('ORR1');
    const partial = scoreQuestionnaire(orr, { MGMT_EXPERIENCE: 'GT10' });
    expect(partial.missing.length).toBeGreaterThan(5);
  });
  it('combines component scores by configured weights', () => {
    const model = cfg('rating_model')[0]!.payload as any;
    const r = combinedRating(model, { ORR: 80, FRR: 70, INDUSTRY: 60, COLLATERAL: 70 });
    expect(r.score).toBeCloseTo(80 * 0.35 + 70 * 0.35 + 60 * 0.15 + 70 * 0.15);
    expect(r.grade).toBe('A');
    expect(combinedRating(model, { ORR: 80 }).missing).toEqual(['FRR', 'INDUSTRY', 'COLLATERAL']);
  });
  it('aggregates exposure with CCF and detects SOL breach', () => {
    const e = aggregateExposure({ own: [{ reference: 'a', product: 'M', kind: 'DIRECT', outstandingMinor: N(180_000_000), approvedMinor: 0, source: 'x' }, { reference: 'b', product: 'APG', kind: 'CONTINGENT', outstandingMinor: N(60_000_000), approvedMinor: 0, source: 'x' }], group: [{ reference: 'c', product: 'I', kind: 'DIRECT', outstandingMinor: N(22_500_000), approvedMinor: 0, source: 'x' }], pipeline: [], proposedMinor: N(150_000_000), proposedIsContingent: false, ccfPct: 50, solLimitMinor: N(300_000_000) });
    expect(e.aggregate).toBe(N(180_000_000 + 30_000_000 + 22_500_000 + 150_000_000));
    expect(e.breached).toBe(true);
    expect(e.maxSupportableMinor).toBe(N(300_000_000 - 232_500_000));
  });
});

describe('validation helpers', () => {
  it('detects CSV formula injection but allows negative numbers', () => {
    expect(hasFormulaCell('Date,Amount\n01/01/2026,-1200.00')).toBe(false);
    expect(hasFormulaCell('Date,Desc\n01/01/2026,=HYPERLINK("http://x")')).toBe(true);
    expect(hasFormulaCell('a,@SUM(1)')).toBe(true);
    expect(hasFormulaCell('a,-cmd|calc')).toBe(true);
  });
  it('rejects oversized and empty files', () => {
    expect(checkFile(Buffer.alloc(0), 'a.pdf', ['application/pdf'], 10).ok).toBe(false);
    expect(checkFile(Buffer.from('%PDF-1.4 ' + 'x'.repeat(100)), 'a.pdf', ['application/pdf'], 10).reason).toMatch(/exceeds/);
  });
  it('validates product-specific fields', () => {
    const product = (cfg('product', 'MURABAHA')[0]!.payload) as any;
    const issues = validateFacility(product, { amount_minor: N(150_000_000), currency: 'NGN', tenor_months: 36, purpose: 'Raw materials purchase', payment_frequency: 'MONTHLY', source_of_payment: 'Sales proceeds domiciled', supplier_name: 'X', underlying_asset: 'Y', proposed_security: 'Z', product_fields: { assetDescription: 'resin', supplierQuoteRef: 'Q', assetCostMinor: 'lots', deliveryLocation: 'Lagos', rogue: 1 } });
    expect(issues.map((i) => i.field)).toEqual(['assetCostMinor', 'rogue']);
  });
});

describe('XLSX statement parsing', () => {
  it('parses an Excel internet-banking export', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { parseStatementFile } = await import('../src/modules/analysis/statement-parser.js');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Account No: 0100000001']);
    ws.addRow(['Trans Date', 'Narration', 'Debit', 'Credit', 'Balance']);
    ws.addRow([new Date(Date.UTC(2026, 0, 5)), 'NIP TRF FROM CUSTOMER', null, 1500.5, 11500.5]);
    ws.addRow(['10/01/2026', 'POS PURCHASE', 500, null, 11000.5]);
    const r = await parseStatementFile(Buffer.from(await wb.xlsx.writeBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(r.ok).toBe(true);
    expect(r.detectedAccountNumber).toBe('0100000001');
    expect(r.transactions.map((t) => [t.txnDate, t.creditMinor, t.debitMinor])).toEqual([['2026-01-05', 150050, 0], ['2026-01-10', 0, 50000]]);
  });
});
