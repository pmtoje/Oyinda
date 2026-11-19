import type { Db } from '../../db/pool.js';
import { maybe, q } from '../../db/pool.js';
import { formatMoney } from '../../lib/money.js';
import type { DocSection } from './docx.js';
import type { gatherFacility } from './service.js';

const M = (v: number | null | undefined, ccy = 'NGN') => (v === null || v === undefined ? '—' : formatMoney(v, ccy));
const K = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(Number(v) / 100_000).toLocaleString('en-NG')); // ₦'000
const P = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(Number(v) * 100) / 100}%`);
const X = (v: number | null | undefined, unit = 'x') => (v === null || v === undefined ? '—' : `${Number(v).toFixed(2)}${unit === 'x' ? '×' : unit === 'days' ? ' days' : unit === '%' ? '%' : ''}`);
const ts = (d: string | Date) => new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
const AWAITING = (what: string) => `[${what} — to be completed by the Relationship Manager / Credit Analyst in the editable term sheet]`;

/** Editable narrative fields of the CAM (stored as overrides on each term-sheet version and carried forward). */
export const CAM_EDITABLE = ['natureOfBusiness', 'operations', 'strategy', 'milestones', 'creditStatusOtherBanks', 'corporateStructure', 'boardProfile', 'managementProfile', 'industryAnalysis', 'environment', 'swot', 'financialAnalysisComment', 'projectedCashflow', 'valueChain', 'raroacComment', 'remarks', 'criticalIssues', 'transactionDynamics', 'facilityEfficiencyRatio', 'justification', 'decisionNote', 'purpose'] as const;

/**
 * The combined term sheet in the format of the Bank's Credit Approval Memo (PRD "Term sheet formatting"):
 * 27 numbered sections, ORR + FRR + collateral + E&S + the approval workflow with names and timestamps,
 * and every officer who commented or decided listed at the end.
 */
export async function camSections(db: Db, g: Awaited<ReturnType<typeof gatherFacility>>, o: Record<string, string>): Promise<DocSection[]> {
  const f = g.f;
  const pf = g.profile ?? {};
  const actions = await q<any>(db, `SELECT a.*, ob.display_name AS on_behalf, t.stage_name FROM workflow_action a LEFT JOIN app_user ob ON ob.id=a.on_behalf_of LEFT JOIN workflow_task t ON t.id=a.task_id
    WHERE a.facility_id=$1 AND a.action IN ('SUBMIT','RESUBMIT','RECOMMEND','APPROVE','DECLINE','RETURN','COMPLETE','VOTE','COMMENT','ESCALATE','RECORD_DECISION') ORDER BY a.created_at`, [f.id]);
  const votes = await q<any>(db, `SELECT v.*, u.display_name, cs.committee_key FROM committee_vote v JOIN committee_session cs ON cs.id=v.session_id JOIN app_user u ON u.id=v.member_id WHERE cs.facility_id=$1 ORDER BY v.created_at`, [f.id]);
  const terms = await maybe<any>(db, 'SELECT * FROM approved_terms WHERE facility_id=$1 ORDER BY version_no DESC LIMIT 1', [f.id]);
  const memo = await maybe<any>(db, `SELECT content FROM generated_document WHERE facility_id=$1 AND kind='CREDIT_MEMO' ORDER BY version_no DESC LIMIT 1`, [f.id]);
  const bu = await maybe<any>(db, `SELECT bu.name FROM customer c LEFT JOIN business_unit bu ON bu.code=c.business_unit_code WHERE c.id=$1`, [f.customer_id]);
  const extFac = await q<any>(db, 'SELECT * FROM business_external_facility WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY lender', [f.customer_id]);
  const counterparties = await q<any>(db, 'SELECT * FROM business_counterparty WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY kind, name', [f.customer_id]);
  const statements = await q<any>(db, 'SELECT id, statement_type, period_end, months, auditor, audit_opinion, currency FROM financial_statement WHERE customer_id=$1 ORDER BY period_end DESC', [f.customer_id]).catch(() => [] as any[]);
  const byKind = (k: string) => g.risk.find((r: any) => r.kind === k);
  const actorOf = (stage: string) => actions.find((a: any) => a.task_id && (a.stage_name ?? '').startsWith(stage) && ['RECOMMEND', 'APPROVE', 'DECLINE'].includes(a.action))?.actor_name;
  const memoInput = memo?.content?.input ?? {};
  const directors = g.parties.filter((p: any) => p.party_type === 'DIRECTOR');
  const shareholders = g.parties.filter((p: any) => p.party_type === 'SHAREHOLDER');
  const executives = g.parties.filter((p: any) => p.party_type === 'KEY_EXECUTIVE');
  const pep = g.parties.some((p: any) => p.is_pep), insider = g.parties.some((p: any) => p.is_insider);

  // 9. Historical financial analysis, grouped as in the CAM (₦'000).
  const periods = (g.fa?.summary?.periods ?? []).filter((p: any) => p.type !== 'PROJECTED').slice(0, 3);
  const head = ['Item', ...periods.map((p: any) => `${String(p.periodEnd).slice(0, 4)} (${p.type === 'AUDITED' ? 'A' : `M${p.months}`})`)];
  const ratio = (key: string, p: any) => g.ratios.find((r: any) => r.ratio_key === key && r.statement_id === p.statementId);
  const rv = (key: string, unit: string) => periods.map((p: any) => { const r = ratio(key, p); return r ? (r.value === null ? '—' : X(r.value, unit)) : '—'; });
  const line = (k: string) => periods.map((p: any) => K(p.keyLines?.[k]));
  const finTables: DocSection[] = periods.length ? [
    { heading: '9. Historical financial analysis & outlook', table: { headers: ['Item', 'Detail'], rows: [['Company’s name', f.legal_name], ['Auditors', statements.find((s: any) => s.statement_type === 'AUDITED')?.auditor ?? '—'], ['Financial year end', statements[0]?.period_end ? String(statements[0].period_end).slice(5) : '—'], ['Auditor’s opinion', statements.find((s: any) => s.statement_type === 'AUDITED')?.audit_opinion ?? '—'], ['Currency', 'NGN (₦’000)']] } },
    { heading: 'Sales and profitability', table: { headers: head, rows: [['Sales (₦’000)', ...line('REVENUE')], ['Gross profit (₦’000)', ...line('GROSS_PROFIT')], ['Gross profit margin', ...rv('GROSS_MARGIN', '%')], ['EBITDA margin', ...rv('EBITDA_MARGIN', '%')], ['Return on equity', ...rv('RETURN_ON_EQUITY', '%')], ['NPAT (₦’000)', ...line('PROFIT_AFTER_TAX')], ['Net profit margin', ...rv('NET_MARGIN', '%')], ['Revenue growth', ...rv('REVENUE_GROWTH', '%')]] } },
    { heading: 'Asset management', table: { headers: head, rows: [['Working capital (₦’000)', ...line('WORKING_CAPITAL')], ['Inventory days', ...rv('INVENTORY_DAYS', 'days')], ['Debtor days', ...rv('DEBTOR_DAYS', 'days')], ['Total assets (₦’000)', ...line('TOTAL_ASSETS')]] } },
    { heading: 'Liquidity and leverage', table: { headers: head, rows: [['Current ratio', ...rv('CURRENT_RATIO', 'x')], ['Quick ratio', ...rv('QUICK_RATIO', 'x')], ['Leverage (total liabilities / equity)', ...rv('LEVERAGE', 'x')], ['Finance cost cover', ...rv('FINANCE_COST_COVER', 'x')], ['Total equity (₦’000)', ...line('TOTAL_EQUITY')]] } },
    { heading: 'Cash flow', table: { headers: head, rows: [['Operating cash flow (₦’000)', ...line('OPERATING_CASH_FLOW')], ['EBITDA (₦’000)', ...line('EBITDA')], ['Total financing (₦’000)', ...line('TOTAL_FINANCING')], ['Total financing / EBITDA', ...rv('FINANCING_TO_EBITDA', 'x')]] }, paragraphs: [o.financialAnalysisComment ?? (g.fa?.summary?.commentary ?? AWAITING('Analysis of financial performance'))] },
  ] : [{ heading: '9. Historical financial analysis & outlook', paragraphs: ['Financial statements have not yet been analysed.'] }];

  // 12–14. Account turnover — Alternative Bank, other banks, consolidated.
  const byAccount: any[] = g.sa?.monthly?.byAccount ?? [];
  const months = [...new Set(byAccount.map((r) => r.month))].sort().slice(-12);
  const sumBy = (rs: any[], k: string) => rs.reduce((a, r) => a + (r[k] ?? 0), 0);
  const alt = months.map((m) => { const rs = byAccount.filter((r) => r.month === m && r.isAltBank); return [m, M(sumBy(rs, 'creditNgnMinor')), M(sumBy(rs, 'debitNgnMinor')), rs.some((r) => r.closingBalanceNgnMinor != null) ? M(sumBy(rs, 'closingBalanceNgnMinor')) : '—']; });
  const others = byAccount.filter((r) => !r.isAltBank && months.includes(r.month)).sort((a, b) => a.bank.localeCompare(b.bank) || a.month.localeCompare(b.month)).map((r) => [r.bank, r.month, M(r.creditNgnMinor), M(r.debitNgnMinor), r.closingBalanceNgnMinor == null ? '—' : M(r.closingBalanceNgnMinor)]);
  const banks = [...new Set(byAccount.map((r) => r.bank))];
  const totalCredit = sumBy(byAccount.filter((r) => months.includes(r.month)), 'creditNgnMinor');
  const consolidated = banks.map((b) => { const rs = byAccount.filter((r) => r.bank === b && months.includes(r.month)); const c = sumBy(rs, 'creditNgnMinor'); return [b, months.length ? `${months[0]} – ${months.at(-1)}` : '—', M(c), M(sumBy(rs, 'debitNgnMinor')), totalCredit ? P((c / totalCredit) * 100) : '—']; });

  // 2. Group facility summary: existing lines from core banking plus this request.
  const exLines = g.exposure?.lines ?? {};
  const existing = [...(exLines.own ?? []), ...(exLines.group ?? [])];
  const proposedAmt = terms?.amount_minor ?? f.amount_minor;
  const sol = g.exposure?.sol_limit_minor;
  const lll = (v: number) => (sol ? P((v / sol) * 100) : '—');
  const groupRows = [
    ...existing.map((l: any) => [l.kind === 'CONTINGENT' ? 'Contingent' : 'Direct', `${l.product}${l.relatedParty ? ` (${l.relatedParty})` : ''}`, lll(l.outstandingMinor), 'NGN', M(l.outstandingMinor), M(l.outstandingMinor), '—', l.maturityDate ?? '—']),
    [g.product.payload.category === 'CONTINGENT' ? 'Contingent' : 'Direct', `${g.product.payload.name} (this request)`, lll(proposedAmt), f.currency, M(0, f.currency), M(proposedAmt, f.currency), M(proposedAmt, f.currency), `${terms?.tenor_months ?? f.tenor_months}`],
  ];

  // 19. Risks and mitigants.
  const mitigants: string[] = memoInput.mitigants ?? [];
  const risks = g.flags.map((fl: any) => fl.statement);

  // Signatories: everyone who commented or decided (PRD: names aligned at the bottom).
  const signers = new Map<string, { name: string; roles: Set<string>; last: Date }>();
  for (const a of actions) if (a.actor_type === 'STAFF' && a.actor_name) { const k = a.actor_id; const s = signers.get(k) ?? { name: a.actor_name, roles: new Set<string>(), last: new Date(a.created_at) }; if (a.actor_role) s.roles.add(a.actor_role); s.last = new Date(a.created_at); signers.set(k, s); }
  for (const v of votes) { const s = signers.get(v.member_id) ?? { name: v.display_name, roles: new Set<string>(), last: new Date(v.created_at) }; s.roles.add(`${v.committee_key} member`); s.last = new Date(v.created_at); signers.set(v.member_id, s); }

  return [
    { heading: '1. Executive summary', table: { headers: ['Item', 'Detail', 'Item', 'Detail'], rows: [
      ['From RM', f.rm_name ?? '—', 'SBU', bu?.name ?? '—'],
      ['TL', actorOf('Team Lead review') ?? '—', 'BE / RBE', actorOf('Regional Business Executive') ?? '—'],
      ['Economic sector', pf.sector_name ?? '—', 'Industry', pf.industry ?? '—'],
    ] }, paragraphs: [`${f.legal_name} requests ${/^[AEIOU]/i.test(g.product.payload.name) ? 'an' : 'a'} ${g.product.payload.name} facility of ${M(proposedAmt, f.currency)} for ${terms?.tenor_months ?? f.tenor_months} months. Purpose: ${o.purpose ?? f.purpose ?? '—'}. Combined risk grade ${byKind('COMBINED')?.grade ?? '—'}; RARORAC ${g.rar ? P(g.rar.rarorac_pct) : '—'}; collateral cover ${P(g.col.coveragePct)}.`] },
    { heading: '2. Group facility summary', table: { headers: ['Direct / contingent', 'Facility type', 'SOL impact', 'Ccy', 'Current amount', 'Proposed amount', 'Change', 'Tenor (months / maturity)'], rows: groupRows }, paragraphs: [`PEP: ${pep ? 'YES' : 'No'}    Insider-related: ${insider ? 'YES' : 'No'}`] },
    { heading: '3. Significant exposure details — the customer’s exposure in the Bank', paragraphs: g.exposure ? [`Direct ${M(g.exposure.direct_exposure_minor)}; contingent (CCF-weighted) ${M(g.exposure.contingent_exposure_minor)}; related parties ${M(g.exposure.group_exposure_minor)}; this request ${M(g.exposure.proposed_minor)}. Aggregate ${M(g.exposure.aggregate_minor)} against the Single Obligor Limit of ${M(g.exposure.sol_limit_minor)} — ${g.exposure.sol_breached ? 'SOL BREACHED: recommend a reduced amount' : `headroom ${M(g.exposure.headroom_minor)}`}.${g.exposure.source_mode === 'MOCK' ? ' (Core banking in MOCK mode.)' : ''}`] : ['Exposure not yet computed.'] },
    { heading: '4. Company background', table: { headers: ['Item', 'Detail'], rows: [
      ['Nature of business', o.natureOfBusiness ?? pf.business_description ?? AWAITING('Nature of business')],
      ['Products, production processes, development & operations', o.operations ?? pf.products_services ?? AWAITING('Products and operations')],
      ['Operational, marketing / distribution strategies & industry position', o.strategy ?? pf.geographic_footprint ?? AWAITING('Strategy and position')],
      ['Competitive strategies, advantage and financial strategies', o.strategy ?? AWAITING('Competitive strategy')],
      ['Past successes and other milestones', o.milestones ?? AWAITING('Milestones')],
      ['Customer credit status from other banks, suppliers and competitors', o.creditStatusOtherBanks ?? (extFac.length ? `${extFac.length} facility(ies) with other lenders; ${extFac.filter((e: any) => !e.performing).length} non-performing.` : 'No facilities with other banks declared.')],
    ] } },
    { heading: '5. Corporate structure and organisation', paragraphs: [o.corporateStructure ?? `${pf.registered_name ?? f.legal_name}; ${String(pf.business_type ?? '—').replace(/_/g, ' ').toLowerCase()}; RC ${pf.rc_number ?? '—'}; incorporated ${pf.incorporation_date ? String(pf.incorporation_date).slice(0, 10) : '—'}; ${pf.employee_count ?? '—'} employees.`] },
    { heading: '6. Board and management profile / exposures', table: { headers: ['Shareholders', 'Percentage'], rows: shareholders.map((p: any) => [p.full_name + (p.is_pep ? ' (PEP)' : '') + (p.is_insider ? ' (Insider)' : ''), p.ownership_pct !== null ? `${p.ownership_pct}%` : '—']) },
      paragraphs: [`Board of directors: ${o.boardProfile ?? (directors.map((d: any) => `${d.full_name}${d.designation ? ` (${d.designation})` : ''}`).join('; ') || '—')}`, `Key management: ${o.managementProfile ?? (executives.map((d: any) => `${d.full_name}${d.designation ? ` (${d.designation})` : ''}`).join('; ') || '—')}`] },
    { heading: '7. Industry analysis', table: { headers: ['Item', 'Detail'], rows: [['Industry analysis / background / relationship update', o.industryAnalysis ?? `Industry scorecard ${byKind('INDUSTRY')?.grade ?? '—'} (score ${byKind('INDUSTRY')?.normalised_score ?? '—'}).`], ['Analysis of the environment in which the company operates', o.environment ?? AWAITING('Operating environment')]] } },
    { heading: '8. SWOT analysis of the company', paragraphs: [o.swot ?? AWAITING('Strengths, weaknesses, opportunities and threats')] },
    ...finTables,
    { heading: '10. Projected cash flow', paragraphs: [o.projectedCashflow ?? AWAITING('Projected cash flow and comment')] },
    { heading: '11. Obligations to other banks', table: { headers: ['S/N', 'Bank', 'Facility type', 'Approved amount', 'Current exposure', 'Tenor / maturity', 'Pricing', 'Remarks'], rows: extFac.map((e: any, i: number) => [i + 1, e.lender, e.facility_type, M(e.amount_minor, e.currency), M(e.outstanding_minor, e.currency), e.maturity_date ? String(e.maturity_date).slice(0, 10) : '—', '—', e.performing ? 'Performing' : 'NON-PERFORMING']) }, paragraphs: extFac.length ? [] : ['None declared by the customer.'] },
    { heading: '12. Summary of transactions with Alternative Bank — last twelve months', table: { headers: ['Month', 'Deposits', 'Withdrawals', 'End-of-month balance'], rows: [...alt, ['Totals', M(sumBy(byAccount.filter((r) => r.isAltBank && months.includes(r.month)), 'creditNgnMinor')), M(sumBy(byAccount.filter((r) => r.isAltBank && months.includes(r.month)), 'debitNgnMinor')), '']] }, paragraphs: byAccount.length ? [] : ['Bank statements not yet analysed.'] },
    { heading: '13. Summary of transactions with other banks — last twelve months', table: { headers: ['Bank', 'Month', 'Deposits', 'Withdrawals', 'End-of-month balance'], rows: others }, paragraphs: others.length ? [] : ['No statements from other banks.'] },
    { heading: '14. Consolidated transaction history — last twelve months', table: { headers: ['Bank', 'Period', 'Total deposits', 'Total withdrawals', '% of wallet'], rows: [...consolidated, ['Totals', '', M(totalCredit), M(sumBy(byAccount.filter((r) => months.includes(r.month)), 'debitNgnMinor')), consolidated.length ? '100%' : '']] } },
    { heading: '15. Customer value chain eco-conversion', table: { headers: ['Counterparty', 'Type', 'Share', 'Relationship (years)'], rows: counterparties.map((c: any) => [c.name, c.kind === 'SUPPLIER' ? 'Vendor' : 'Distributor / customer', c.share_pct !== null ? `${c.share_pct}%` : '—', c.relationship_years ?? '—']) }, paragraphs: [o.valueChain ?? (pf.value_chain ? `Value chain: ${pf.value_chain}` : AWAITING('Value-chain conversion (vendors, distributors, staff salaries, principal officers’ accounts, cards, corporate solutions, key promoters)'))] },
    { heading: '16. Request', table: { headers: ['Term', 'Proposed'], rows: [['Facility', `${g.product.payload.name}${g.product.payload.descriptor ? ` (${g.product.payload.descriptor})` : ''}`], ['Amount', M(proposedAmt, f.currency)], ['Tenor', `${terms?.tenor_months ?? f.tenor_months} months`], ['Pricing', terms ? (g.product.payload.pricingBasis === 'FEE' ? `Commission ${P(terms.profit_rate_pct)}` : `Profit rate ${P(terms.profit_rate_pct)} p.a.`) : g.rar ? (g.product.payload.pricingBasis === 'FEE' ? `Commission ${P(g.rar.pricing_rate_pct)}` : `Profit rate ${P(g.rar.pricing_rate_pct)} p.a.`) : '—'], ['Purpose', o.purpose ?? f.purpose], ['Payment', `${String(terms?.payment_frequency ?? f.payment_frequency ?? '').toLowerCase()}${f.payment_structure ? ` — ${f.payment_structure}` : ''}`], ['Source of payment', f.source_of_payment], ['Security', f.proposed_security], ['Shariah structure', g.product.payload.shariahStructure]] } },
    { heading: '17. Risk rating and comment', paragraphs: [`The obligor was rated using the configured combined risk rating model (ORR ${byKind('ORR') ? `${byKind('ORR').card_key} v${byKind('ORR').card_version}` : '—'}).`], table: { headers: ['Rating', 'Grade', 'Score', 'Remarks'], rows: [['Obligor Risk Rating (ORR)', byKind('ORR')?.grade ?? '—', byKind('ORR')?.normalised_score ?? '—', ''], ['Facility Risk Rating (FRR)', byKind('FRR')?.grade ?? '—', byKind('FRR')?.normalised_score ?? '—', ''], ['Industry', byKind('INDUSTRY')?.grade ?? '—', byKind('INDUSTRY')?.normalised_score ?? '—', ''], ['Collateral', byKind('COLLATERAL')?.grade ?? '—', byKind('COLLATERAL')?.normalised_score ?? '—', ''], ['Combined', byKind('COMBINED')?.grade ?? '—', byKind('COMBINED')?.normalised_score ?? '—', '']] } },
    { heading: '18. Risk / return and relationship strategy (RAROC computation & comments)', paragraphs: g.rar ? [`Proposed ${g.product.payload.pricingBasis === 'FEE' ? 'commission' : 'profit rate'} ${P(g.rar.pricing_rate_pct)}; RARORAC ${P(g.rar.rarorac_pct)} against hurdle ${P(g.rar.hurdle_pct)} — ${g.rar.within_threshold ? 'within threshold' : 'PRICING EXCEPTION'}.${g.rar.mode === 'MOCK' ? ' Computed by the MOCK pricing adapter — not a production RARORAC result.' : ''}`, ...(g.rar.justification ? [`Exception justification (${g.rar.justified_by_name}): ${g.rar.justification}`] : []), ...(o.raroacComment ? [o.raroacComment] : [])] : ['Not computed.'] },
    { heading: '19. Risk analysis', table: { headers: ['Risks', 'Mitigants'], rows: Array.from({ length: Math.max(risks.length, mitigants.length) }, (_, i) => [risks[i] ?? '', mitigants[i] ?? '']) },
      paragraphs: [g.es ? `Environmental & social: category ${g.es.category ?? 'pending'}; ${String(g.es.recommendation ?? 'pending').replace(/_/g, ' ').toLowerCase()}. ${g.es.findings ?? ''}` : 'Environmental & social: review not required under the configured trigger.'] },
    { heading: '20. Distribution of financing portfolio', table: { headers: ['Sector', 'Approved limit', 'Utilisation', 'Remarks'], rows: g.exposure?.sector_code ? [[pf.sector_name ?? g.exposure.sector_code, M(g.exposure.sector_limit_minor), M(g.exposure.sector_exposure_minor), g.exposure.sector_breached ? 'Sector limit exceeded' : 'Within limit']] : [] }, paragraphs: g.exposure?.sector_code ? [] : ['No sector limit configured for this sector.'] },
    { heading: '21. Assigned collateral', table: { headers: ['Owner (if another client)', 'Collateral', 'OMV / FSV / pledged value', 'Coverage amount', 'Coverage %'], rows: g.col.items.map((c: any) => [c.owner_name === f.legal_name ? '—' : c.owner_name, `${g.colTypes.get(c.type_key) ?? c.type_key}: ${c.description}`, M(c.market_value_minor, c.currency), M(c.eligible_value_ngn_minor), proposedAmt ? P((Number(c.eligible_value_ngn_minor) / proposedAmt) * 100) : '—']) }, paragraphs: [`Total eligible cover ${P(g.col.coveragePct)}${g.col.isCashBacked ? ' — qualifies as cash-backed' : ''}.`] },
    { heading: '22. Remarks', paragraphs: [o.remarks ?? memoInput.commentary ?? AWAITING('Remarks')] },
    { heading: '23. Critical credit issues — for Credit Risk', bullets: o.criticalIssues ? o.criticalIssues.split('\n') : g.flags.filter((fl: any) => fl.severity === 'HIGH').map((fl: any) => fl.statement), paragraphs: g.flags.some((fl: any) => fl.severity === 'HIGH') || o.criticalIssues ? [] : ['No critical issues flagged.'] },
    { heading: '24. Transaction dynamics', paragraphs: [o.transactionDynamics ?? `${g.product.payload.shariahStructure} Supplier / asset: ${f.supplier_name ?? '—'} / ${f.underlying_asset ?? '—'}. Payment from ${f.source_of_payment ?? '—'}.`] },
    { heading: '25. Facility efficiency ratio', paragraphs: [o.facilityEfficiencyRatio ?? 'Not computed: the definition of the facility efficiency ratio is awaited from Credit Risk (open question).'] },
    { heading: '26. Justification for the request / credit consideration', paragraphs: [o.justification ?? memoInput.commentary ?? AWAITING('Justification')] },
    { heading: '27. Approval recommendations and conditions — for Credit Risk', paragraphs: [memoInput.recommendation ? `Credit analyst recommendation: ${String(memoInput.recommendation).replace(/_/g, ' ').toLowerCase()}.` : 'Credit analyst recommendation pending.', terms ? `Approved (terms version ${terms.version_no}) by: ${terms.approved_by_names.join(', ')}.` : `Status: ${String(f.status).replace(/_/g, ' ').toLowerCase()}.`, ...(o.decisionNote ? [o.decisionNote] : [])], bullets: (terms?.conditions ?? memoInput.conditions ?? []).map((c: any) => (typeof c === 'string' ? c : `${c.description}${c.mandatory ? '' : ' (non-mandatory)'}`)) },
    { heading: 'Approval workflow — comments and decisions', table: { headers: ['Date & time', 'Name', 'Role / stage', 'Action', 'Comment'], rows: actions.map((a: any) => [ts(a.created_at), (a.actor_name ?? 'Gazelle system') + (a.on_behalf ? ` (for ${a.on_behalf})` : ''), a.stage_name ?? a.actor_role ?? '—', a.action.replace(/_/g, ' '), a.comment]) } },
    { heading: 'Committee votes', table: { headers: ['Committee', 'Member', 'Vote', 'Date & time', 'Comment'], rows: votes.map((v: any) => [v.committee_key, v.display_name, v.vote, ts(v.created_at), v.comment]) }, paragraphs: votes.length ? [] : ['No committee votes recorded.'] },
    { heading: 'Officers who commented or decided', table: { headers: ['Name', 'Role(s)', 'Last action'], rows: [...signers.values()].map((s) => [s.name, [...s.roles].join(', ') || '—', ts(s.last)]) } },
  ];
}
