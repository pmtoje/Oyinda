import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { formatMoney } from '../../lib/money.js';
import { audit, type Actor } from '../audit/audit.js';
import { getById } from '../config/service.js';
import { collateralSummary } from '../facilities/facts.js';
import { storeVersion } from '../documents/service.js';
import { MIME } from '../documents/mime.js';
import { renderDocx, type DocSection } from './docx.js';
import { riskFlags, type RiskFlag } from './risk-flags.js';
import { camSections } from './cam.js';
import { facilityEfficiency, fmtEfficiency } from '../analysis/efficiency.js';
import { registerJob } from '../../jobs/queue.js';
import { getPool, tx } from '../../db/pool.js';
import { SYSTEM } from '../audit/audit.js';

const M = (v: number | null | undefined, ccy = 'NGN') => (v === null || v === undefined ? '—' : formatMoney(v, ccy));
const P = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100) / 100}%`);

/** Gather everything the memo, term sheet and executive view need. */
export async function gatherFacility(db: Db, facilityId: string) {
  const f = await one<any>(db, `SELECT f.*, c.legal_name, c.customer_ref, c.customer_category, u.display_name AS rm_name FROM facility_request f JOIN customer c ON c.id=f.customer_id LEFT JOIN app_user u ON u.id=c.relationship_manager_id WHERE f.id=$1`, [facilityId]);
  const product = await getById<any>(db, f.product_config_id);
  const profile = await maybe<any>(db, 'SELECT bp.*, s.name AS sector_name FROM business_profile bp LEFT JOIN sector s ON s.code=bp.sector_code WHERE customer_id=$1', [f.customer_id]);
  const parties = await q<any>(db, 'SELECT party_type, full_name, designation, ownership_pct, is_pep, is_insider FROM business_party WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY party_type', [f.customer_id]);
  const fa = await maybe<any>(db, 'SELECT * FROM financial_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const ratios = fa ? await q<any>(db, `SELECT r.*, ci.payload->>'name' AS name, ci.payload->>'unit' AS unit FROM ratio_result r JOIN config_item ci ON ci.id=r.ratio_config_id WHERE analysis_id=$1`, [fa.id]) : [];
  const sa = await maybe<any>(db, 'SELECT * FROM statement_analysis WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const bureau = await q<any>(db, `SELECT * FROM bureau_check WHERE facility_id=$1 ORDER BY requested_at DESC`, [facilityId]);
  const exposure = await maybe<any>(db, 'SELECT * FROM exposure_snapshot WHERE facility_id=$1 ORDER BY created_at DESC LIMIT 1', [facilityId]);
  const col = await collateralSummary(db, facilityId, f.amount_minor ?? 0, f.currency);
  const colTypes = new Map((await q<any>(db, `SELECT DISTINCT ON (key) key, payload->>'name' AS name FROM config_item WHERE kind='collateral_type' ORDER BY key, version DESC`)).map((r) => [r.key, r.name]));
  const es = await maybe<any>(db, `SELECT * FROM es_assessment WHERE facility_id=$1 AND status <> 'SUPERSEDED' ORDER BY created_at DESC LIMIT 1`, [facilityId]);
  const rar = await maybe<any>(db, `SELECT r.*, u.display_name AS justified_by_name FROM rarorac_computation r LEFT JOIN app_user u ON u.id=r.justified_by WHERE r.facility_id=$1 AND r.status='COMPLETED' ORDER BY r.created_at DESC LIMIT 1`, [facilityId]);
  const risk = await q<any>(db, `SELECT r.*, ci.key AS card_key, ci.version AS card_version FROM risk_assessment r JOIN config_item ci ON ci.id=r.scorecard_config_id WHERE r.facility_id=$1 AND r.status='SUBMITTED'`, [facilityId]);
  const flags = await riskFlags(db, facilityId);
  return { f, product, profile, parties, fa, ratios, sa, bureau, exposure, col, colTypes, es, rar, risk, flags };
}

export interface MemoInput { recommendation: 'APPROVE' | 'APPROVE_WITH_CONDITIONS' | 'DECLINE'; commentary: string; mitigants: string[]; conditions: string[]; additionalRisks: string[] }

export async function buildMemoContent(db: Db, facilityId: string, input: MemoInput) {
  const g = await gatherFacility(db, facilityId);
  const { f, fa, ratios, sa, exposure, col, es, rar, risk, flags } = g;
  const eff = await facilityEfficiency(db, facilityId);
  const latest = fa?.summary?.periods?.[0];
  const ratio = (k: string) => ratios.find((r: any) => r.ratio_key === k && r.statement_id === latest?.statementId);
  const combined = risk.find((r: any) => r.kind === 'COMBINED');
  const keyMetrics = [
    { label: 'Revenue (latest)', value: M(latest?.keyLines?.REVENUE) },
    { label: 'Profit after tax', value: M(latest?.keyLines?.PROFIT_AFTER_TAX) },
    { label: 'EBITDA margin', value: P(ratio('EBITDA_MARGIN')?.value) },
    { label: 'Leverage', value: ratio('LEVERAGE')?.value != null ? `${ratio('LEVERAGE').value.toFixed(2)}×` : '—' },
    { label: 'Current ratio', value: ratio('CURRENT_RATIO')?.value != null ? `${ratio('CURRENT_RATIO').value.toFixed(2)}×` : '—' },
    { label: 'Avg. monthly credit turnover', value: M(sa?.summary?.avgMonthlyCreditTurnoverNgnMinor) },
  ];
  const keyRisks = [...flags.map((x: RiskFlag) => x.statement), ...input.additionalRisks];
  const executiveSummary = {
    customer: f.legal_name, product: g.product.payload.name, requestedAmount: M(f.amount_minor, f.currency), tenor: `${f.tenor_months} months`, purpose: f.purpose,
    keyMetrics, keyRisks: keyRisks.slice(0, 6), security: col.count ? `${P(col.coveragePct)} eligible cover${col.isCashBacked ? ' (cash-backed)' : ''}` : 'No security recorded',
    rarorac: rar ? `${P(rar.rarorac_pct)} vs hurdle ${P(rar.hurdle_pct)}${rar.mode === 'MOCK' ? ' [MOCK — not a production result]' : ''}` : 'Not computed',
    riskGrade: combined ? `${combined.grade} (${combined.grade_description})` : 'Not rated', esCategory: es?.category ?? (es ? 'Pending' : 'Not required'),
    recommendation: input.recommendation, conditions: input.conditions,
  };
  const sections: DocSection[] = [
    { heading: 'Executive summary', table: { headers: ['Item', 'Detail'], rows: [['Customer', f.legal_name], ['Facility', `${g.product.payload.name} — ${M(f.amount_minor, f.currency)} over ${f.tenor_months} months`], ['Purpose', f.purpose], ['Risk grade', executiveSummary.riskGrade], ['Security', executiveSummary.security], ['RARORAC', executiveSummary.rarorac], ['E&S', executiveSummary.esCategory], ['Recommendation', input.recommendation.replace(/_/g, ' ')]] } },
    { heading: 'Key risks and mitigants', bullets: [...keyRisks.map((r) => `Risk: ${r}`), ...input.mitigants.map((m) => `Mitigant: ${m}`)] },
    { heading: 'Customer profile', paragraphs: [`${f.legal_name} (${f.customer_ref}), ${g.profile?.sector_name ?? 'sector not stated'}; incorporated ${g.profile?.incorporation_date ?? '—'}; RC ${g.profile?.rc_number ?? '—'}. Relationship Manager: ${f.rm_name ?? '—'}.`, g.profile?.business_description ?? ''], table: { headers: ['Role', 'Name', 'Designation', 'Ownership'], rows: g.parties.map((p: any) => [p.party_type.replace(/_/g, ' '), p.full_name + (p.is_pep ? ' (PEP)' : '') + (p.is_insider ? ' (Insider)' : ''), p.designation, p.ownership_pct !== null ? `${p.ownership_pct}%` : null]) } },
    { heading: 'Facility', table: { headers: ['Term', 'Proposed'], rows: [['Product', `${g.product.payload.name} (${g.product.payload.family})`], ['Amount', M(f.amount_minor, f.currency)], ['Tenor', `${f.tenor_months} months`], ['Payment', `${(f.payment_frequency ?? '').toLowerCase()} — ${f.payment_structure ?? ''}`], ['Source of payment', f.source_of_payment], ['Supplier / asset', `${f.supplier_name ?? '—'} / ${f.underlying_asset ?? '—'}`], ['Proposed security', f.proposed_security]] } },
    { heading: 'Shariah structure', paragraphs: [g.product.payload.shariahStructure] },
    { heading: 'Financial performance', table: { headers: ['Period', 'Revenue', 'EBITDA', 'PAT', 'Total equity', 'Total financing'], rows: (fa?.summary?.periods ?? []).map((p: any) => [`${p.type === 'AUDITED' ? 'FY' : p.type} ${p.periodEnd} (${p.months}m)`, M(p.keyLines.REVENUE), M(p.keyLines.EBITDA), M(p.keyLines.PROFIT_AFTER_TAX), M(p.keyLines.TOTAL_EQUITY), M(p.keyLines.TOTAL_FINANCING)]) } },
    { heading: 'Ratio analysis (latest period)', table: { headers: ['Ratio', 'Value', 'Assessment', 'Implication'], rows: ratios.filter((r: any) => r.statement_id === latest?.statementId).map((r: any) => [r.name, r.value === null ? r.error : r.unit === '%' ? P(r.value) : `${Number(r.value).toFixed(2)}${r.unit === 'x' ? '×' : r.unit === 'days' ? ' days' : ''}`, r.band, r.implication]) } },
    { heading: 'Bank statement analysis', paragraphs: sa ? [`${sa.summary.monthsCovered} months across ${sa.summary.accounts} account(s) at ${sa.summary.banks} bank(s). Average monthly credit turnover ${M(sa.summary.avgMonthlyCreditTurnoverNgnMinor)}; Alternative Bank wallet share ${P(sa.summary.walletSharePct)}; trend ${P(sa.summary.creditTrendPct)}.`, ...(sa.issues ?? []).map((i: any) => `Note: ${i.message}`)] : ['Not yet analysed.'] },
    { heading: 'Credit checks', table: { headers: ['Subject', 'Identifier', 'Provider', 'Result'], rows: g.bureau.map((b: any) => [b.subject_name, `${b.identifier_type} ${b.identifier_masked}`, `${b.provider}${b.mode === 'MOCK' ? ' (MOCK)' : ''}`, b.status === 'COMPLETED' ? `Score ${b.score ?? '—'}; ${b.delinquent_facilities ?? 0} delinquent; ${b.worst_classification ?? ''}` : b.status]) } },
    { heading: 'Exposure', paragraphs: exposure ? [`Direct ${M(exposure.direct_exposure_minor)}, contingent (CCF-weighted) ${M(exposure.contingent_exposure_minor)}, related-party ${M(exposure.group_exposure_minor)}, proposed ${M(exposure.proposed_minor)}. Aggregate ${M(exposure.aggregate_minor)} against SOL of ${M(exposure.sol_limit_minor)} — ${exposure.sol_breached ? 'BREACHED' : `headroom ${M(exposure.headroom_minor)}`}.${exposure.source_mode === 'MOCK' ? ' (Core banking in MOCK mode.)' : ''}`] : ['Not computed.'] },
    { heading: 'Security', table: { headers: ['Type', 'Description', 'Market value', 'Haircut', 'Eligible (NGN)', 'Perfection'], rows: col.items.map((c: any) => [g.colTypes.get(c.type_key) ?? c.type_key, c.description, M(c.market_value_minor, c.currency), `${c.haircut_pct}%`, M(c.eligible_value_ngn_minor), c.perfection_status.replace(/_/g, ' ')]) }, paragraphs: [`Eligible cover: ${P(col.coveragePct)}${col.isCashBacked ? ' — qualifies as cash-backed' : ''}.`] },
    { heading: 'Environmental & social', paragraphs: es ? [`Category ${es.category ?? 'pending'}; recommendation: ${(es.recommendation ?? 'pending').replace(/_/g, ' ').toLowerCase()}.`, es.findings ?? ''] : ['E&S review not required under the configured trigger.'] },
    { heading: 'Pricing & RARORAC', paragraphs: rar ? [`Proposed profit rate ${P(rar.pricing_rate_pct)}; RARORAC ${P(rar.rarorac_pct)} against hurdle ${P(rar.hurdle_pct)} — ${rar.within_threshold ? 'within threshold' : 'PRICING EXCEPTION'}.${rar.mode === 'MOCK' ? ' Computed by the MOCK pricing adapter — not a production RARORAC result.' : ''}`, ...(rar.justification ? [`Exception justification (${rar.justified_by_name}): ${rar.justification}`] : [])] : ['Not computed.'] },
    ...(eff.configured ? [{ heading: 'Facility efficiency ratio', paragraphs: [`${eff.name}: ${fmtEfficiency(eff.value, eff.unit)}${eff.band ? ` — ${eff.band.label}: ${eff.band.assessment}` : ''}${eff.value === null ? ` (not computed: ${eff.missing.join(', ') || eff.error})` : ''}. Definition v${eff.version}: ${eff.formula}, per ${eff.directedBy === 'BOARD' ? 'Board' : 'management'} direction ${eff.directionReference}.`] }] : []),
    { heading: 'Risk rating', table: { headers: ['Component', 'Scorecard (version)', 'Score', 'Grade'], rows: risk.map((r: any) => [r.kind, `${r.card_key} v${r.card_version}`, r.normalised_score, r.grade]) } },
    { heading: 'Recommendation & conditions', paragraphs: [`Recommendation: ${input.recommendation.replace(/_/g, ' ')}.`, input.commentary], bullets: input.conditions },
  ];
  return { executiveSummary, sections, flags, input };
}

async function nextVersion(db: Db, facilityId: string, kind: string) {
  return (await one<{ n: number }>(db, 'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM generated_document WHERE facility_id=$1 AND kind=$2', [facilityId, kind])).n;
}

/** Store a generated document as an immutable version, with a rendered .docx in the encrypted document store. */
export async function storeGenerated(db: Db, actor: Actor, facilityId: string, kind: 'CREDIT_MEMO' | 'TERM_SHEET' | 'OFFER_LETTER', content: any, docx: Buffer, opts: { templateConfigId?: string; basedOn?: number; editReason?: string; customerVisible?: boolean } = {}) {
  const f = await one<any>(db, 'SELECT customer_id, facility_ref FROM facility_request WHERE id=$1', [facilityId]);
  const v = await nextVersion(db, facilityId, kind);
  const doc = await one<any>(db, `INSERT INTO document(customer_id, facility_id, doc_type, title, status, mandatory, customer_visible) VALUES ($1,$2,$3,$4,'VERIFIED',false,$5) RETURNING id`, [f.customer_id, facilityId, kind, `${kind.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())} v${v} — ${f.facility_ref}`, !!opts.customerVisible]);
  const { version } = await storeVersion(db, actor, { documentId: doc.id, buffer: docx, filename: `${f.facility_ref}-${kind.toLowerCase()}-v${v}.docx`, acceptedMime: [MIME.DOCX], maxSizeMb: 20, facilityId, customerId: f.customer_id, metadata: { generated: true, kind, version: v } });
  await q(db, 'UPDATE document SET current_version_id=$2 WHERE id=$1', [doc.id, version.id]);
  const g = await one<any>(db, `INSERT INTO generated_document(facility_id, kind, version_no, template_config_id, content, rendered_document_id, rendered_version_id, based_on_version, edit_reason, generated_by_type, generated_by_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [facilityId, kind, v, opts.templateConfigId ?? null, JSON.stringify(content), doc.id, version.id, opts.basedOn ?? null, opts.editReason ?? null, actor.type, actor.id]);
  await audit(db, actor, { action: `${kind}_GENERATED`, entityType: 'generated_document', entityId: g.id, facilityId, metadata: { version: v, basedOn: opts.basedOn, editReason: opts.editReason } });
  return g;
}

export async function generateMemo(db: Db, actor: Actor, facilityId: string, input: MemoInput) {
  const content = await buildMemoContent(db, facilityId, input);
  const f = await one<any>(db, 'SELECT facility_ref, legal_name FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE f.id=$1', [facilityId]);
  const docx = await renderDocx({ title: 'Credit Memorandum', subtitle: `${f.legal_name} — prepared by ${actor.label}`, reference: f.facility_ref, classification: 'CONFIDENTIAL — INTERNAL', sections: content.sections });
  return storeGenerated(db, actor, facilityId, 'CREDIT_MEMO', content, docx);
}

/**
 * Combined term sheet in the Bank's Credit Approval Memo format (PRD): ORR, FRR, financial analysis, collateral,
 * E&S and the approval workflow with each officer's name and timestamp. Word format (PRD: not PDF).
 * Narrative overrides from the previous version are carried forward so automatic refreshes never lose edits.
 */
export async function generateTermSheet(db: Db, actor: Actor, facilityId: string, edits?: { overrides: Record<string, string>; reason: string; basedOn: number }, opts: { automatic?: string } = {}) {
  const g = await gatherFacility(db, facilityId);
  const prev = await maybe<any>(db, `SELECT content, version_no FROM generated_document WHERE facility_id=$1 AND kind='TERM_SHEET' ORDER BY version_no DESC LIMIT 1`, [facilityId]);
  const memo = await maybe<any>(db, `SELECT version_no FROM generated_document WHERE facility_id=$1 AND kind='CREDIT_MEMO' ORDER BY version_no DESC LIMIT 1`, [facilityId]);
  const o: Record<string, string> = { ...(prev?.content?.overrides ?? {}), ...(edits?.overrides ?? {}) };
  const sections = await camSections(db, g, o);
  const subtitle = `${g.f.legal_name} — ${g.product.payload.name} ${M(g.f.amount_minor, g.f.currency)}${edits ? ` — revised: ${edits.reason}` : opts.automatic ? ` — updated: ${opts.automatic}` : ''}`;
  const docx = await renderDocx({ title: 'Credit Approval Memo — Combined Term Sheet', subtitle, reference: g.f.facility_ref, classification: 'CONFIDENTIAL — INTERNAL', sections, footerNote: `Generated by Credit360 ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}` });
  return storeGenerated(db, actor, facilityId, 'TERM_SHEET', { format: 'CAM', sections, overrides: o, memoVersion: memo?.version_no ?? null }, docx, edits ? { basedOn: edits.basedOn, editReason: edits.reason } : prev ? { basedOn: prev.version_no, editReason: opts.automatic ?? 'Regenerated' } : {});
}

/** Executive decision view: one screen, under two minutes. */
export async function decisionView(db: Db, facilityId: string) {
  const g = await gatherFacility(db, facilityId);
  const memo = await maybe<any>(db, `SELECT * FROM generated_document WHERE facility_id=$1 AND kind='CREDIT_MEMO' ORDER BY version_no DESC LIMIT 1`, [facilityId]);
  const inst = await maybe<any>(db, `SELECT * FROM workflow_instance WHERE facility_id=$1 AND kind='CREDIT_APPROVAL' ORDER BY started_at DESC LIMIT 1`, [facilityId]);
  const chain = await q<any>(db, `SELECT a.actor_name, COALESCE(ro.name, a.actor_role) AS actor_role, a.action, a.comment, a.created_at, t.stage_name FROM workflow_action a LEFT JOIN workflow_task t ON t.id=a.task_id LEFT JOIN role ro ON ro.code=a.actor_role WHERE a.facility_id=$1 AND a.action IN ('RECOMMEND','APPROVE','DECLINE','COMPLETE','RETURN') ORDER BY a.created_at`, [facilityId]);
  const sa = g.sa?.summary;
  return {
    facility: { id: g.f.id, ref: g.f.facility_ref, customer: g.f.legal_name, product: g.product.payload.name, amount: M(g.f.amount_minor, g.f.currency), amountMinor: g.f.amount_minor, tenor: g.f.tenor_months, purpose: g.f.purpose, status: g.f.status, sector: g.profile?.sector_name, rm: g.f.rm_name },
    summary: memo?.content?.executiveSummary ?? null, memoVersion: memo?.version_no ?? null, memoDocumentId: memo?.rendered_document_id ?? null,
    flags: g.flags,
    indicators: {
      riskGrade: g.risk.find((r: any) => r.kind === 'COMBINED')?.grade ?? null,
      collateralCoveragePct: g.col.coveragePct, cashBacked: g.col.isCashBacked,
      rarorac: g.rar ? { pct: g.rar.rarorac_pct, hurdle: g.rar.hurdle_pct, within: g.rar.within_threshold, mode: g.rar.mode, profitRate: g.rar.pricing_rate_pct } : null,
      exposure: g.exposure ? { aggregate: M(g.exposure.aggregate_minor), sol: M(g.exposure.sol_limit_minor), breached: g.exposure.sol_breached, headroom: M(g.exposure.headroom_minor), mode: g.exposure.source_mode } : null,
      es: g.es ? { category: g.es.category, recommendation: g.es.recommendation } : null,
      turnover: sa ? { avgMonthly: M(sa.avgMonthlyCreditTurnoverNgnMinor), trendPct: sa.creditTrendPct, walletSharePct: sa.walletSharePct } : null,
    },
    route: inst?.route ?? null,
    recommendations: chain.map((c) => ({ stage: c.stage_name, officer: c.actor_name, role: c.actor_role, action: c.action, comment: c.comment, at: c.created_at })),
  };
}

/** PRD: the combined term sheet is generated at submission and updated as the request moves through the approval workflow. */
registerJob('termsheet.refresh', async ({ facilityId, reason }) => {
  await tx((c) => generateTermSheet(c, SYSTEM, facilityId, undefined, { automatic: reason }));
});
void getPool;
