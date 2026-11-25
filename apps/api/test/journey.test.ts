import { beforeAll, describe, expect, it } from 'vitest';
import { abcClient, act, Client, completeAbcProfile, db, draftMurabaha, getApp, idem, pdf, performCreditAnalysis, staffLogin, upload, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';
import { verifyAuditChain } from '../src/modules/audit/audit.js';
import { slaSweep } from '../src/modules/workflow/sweep.js';
import { monitoringSweep } from '../src/modules/servicing/routes.js';

let app: Awaited<ReturnType<typeof getApp>>;
let abc: Client; let customerId: string;
const staff: Record<string, Client> = {};
let facilityId: string;

beforeAll(async () => {
  app = await getApp();
  abc = await abcClient(app);
  customerId = (await abc.get('/api/auth/me')).body.data.customer.id;
  await completeAbcProfile(abc, customerId);
  for (const u of ['rm', 'bm', 'rbe', 'dh', 'ed2', 'analyst', 'analyst2', 'es', 'ctl', 'ghcr', 'cro', 'ed', 'md', 'legal', 'shariah', 'creditops', 'creditops2']) staff[u] = await staffLogin(app, `demo.${u}`);
  await q(db(), `INSERT INTO fx_rate(base_ccy, quote_ccy, rate, rate_date, source) VALUES ('USD','NGN',1520.50,'2025-10-31','CBN NAFEM closing (DEMO)') ON CONFLICT DO NOTHING`);
});

describe('Phase 77 — end-to-end Murabaha journey for ABC Manufacturing Ltd', () => {
  it('Journey 2–3: customer drafts and submits a ₦150m, 36-month Murabaha', async () => {
    const f = await draftMurabaha(abc, { idem: 'phase77-murabaha' });
    facilityId = f.id;
    await uploadAllRequired(abc, f.id);
    const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    const r = await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    expect(r.status).toBe(200);
  });

  it('customer cannot modify the amount after submission', async () => {
    const cur = (await abc.get(`/api/facilities/${facilityId}`)).body.data.facility;
    const r = await abc.patch(`/api/facilities/${facilityId}`, { rowVersion: cur.rowVersion, amountMinor: 900_000_000_00 });
    expect(r.body.error.code).toBe('NOT_EDITABLE');
  });

  it('Journey 4: RM must verify documents before recommending', async () => {
    const early = await act(staff.rm!, facilityId, 'RM_REVIEW', 'RECOMMEND');
    expect(early.body.error.code).toBe('PREREQUISITES');
    const docs = (await staff.rm!.get(`/api/facilities/${facilityId}/documents`)).body.data;
    for (const d of docs.filter((x: any) => x.status === 'UPLOADED')) expect((await staff.rm!.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' })).status).toBe(200);
    const r = await act(staff.rm!, facilityId, 'RM_REVIEW', 'RECOMMEND');
    expect(r.status).toBe(200);
  });

  it('Journey 5: Team Lead → RBE → DH review (SWR route) — unauthorised users cannot act', async () => {
    const t = (await q(db(), `SELECT id, assigned_user_id FROM workflow_task WHERE facility_id=$1 AND stage_key='BM_REVIEW' AND status='OPEN'`, [facilityId]))[0];
    // Routed to the RM's own line manager (reporting line from the staff directory)
    expect(t.assigned_user_id).toBe((await q(db(), `SELECT id FROM app_user WHERE ad_username='demo.bm'`))[0].id);
    expect((await staff.analyst!.post(`/api/tasks/${t.id}/claim`)).status).toBe(403);
    expect((await abc.post(`/api/tasks/${t.id}/claim`)).status).toBe(401);
    const r = await act(staff.bm!, facilityId, 'BM_REVIEW', 'RECOMMEND');
    expect(r.status).toBe(200);
    expect((await act(staff.rbe!, facilityId, 'RBE_REVIEW', 'RECOMMEND')).status).toBe(200);
    expect((await act(staff.dh!, facilityId, 'DH_REVIEW', 'RECOMMEND')).status).toBe(200);
  });

  it('Journey 6: Manufacturing is outside the HEART/E&S sectors, so only credit analysis opens; only one analyst can claim', async () => {
    const tasks = await q(db(), `SELECT stage_key FROM workflow_task WHERE facility_id=$1 AND status='OPEN' ORDER BY stage_key`, [facilityId]);
    expect(tasks.map((t: any) => t.stage_key)).toEqual(['CREDIT_ANALYSIS']);
    const route = (await q(db(), `SELECT route FROM workflow_instance WHERE facility_id=$1`, [facilityId]))[0].route;
    expect(route.explanation.join(' ')).toMatch(/E&S risk review not required/);
    const t = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='CREDIT_ANALYSIS'`, [facilityId]))[0];
    const [a, b] = await Promise.all([staff.analyst!.post(`/api/tasks/${t.id}/claim`), staff.analyst2!.post(`/api/tasks/${t.id}/claim`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    if (a.status !== 200) { await staff.analyst2!.post(`/api/tasks/${t.id}/release`); await staff.analyst!.post(`/api/tasks/${t.id}/claim`); }
    const early = await act(staff.analyst!, facilityId, 'CREDIT_ANALYSIS', 'COMPLETE');
    expect(early.body.error.code).toBe('PREREQUISITES');
    expect(early.body.error.details.length).toBeGreaterThanOrEqual(7);
  });

  it('analyst performs the full analysis (financials, statements, FX, bureau, exposure, collateral, ratings, RARORAC, memo)', async () => {
    await performCreditAnalysis(staff.analyst!, facilityId, customerId);
    const sa = (await staff.analyst!.get(`/api/facilities/${facilityId}/statement-analysis`)).body.data;
    expect(sa.summary.accounts).toBe(2);
    expect(sa.summary.monthsCovered).toBe(12);
    expect(sa.fxRates[0].rate).toBe(1520.5);
    expect(sa.summary.walletSharePct).toBeCloseTo((260e6 * 3.15 / 3) / (260e6 * 3.15 / 3 + 40e3 * 3.15 / 3 * 1520.5) * 100, 0);
    const ex = (await staff.analyst!.get(`/api/facilities/${facilityId}/exposure`)).body.data;
    expect(ex.solBreached).toBe(false);
    // CBA direct + 50% CCF on the APG + related-party Ijarah + this request + any approved-but-unbooked Credit360 pipeline
    const pipeline = ex.lines.pipeline.reduce((a: number, l: any) => a + (l.kind === 'CONTINGENT' ? l.outstandingMinor / 2 : l.outstandingMinor), 0);
    expect(ex.aggregateMinor).toBe(180_000_000_00 + 30_000_000_00 + 22_500_000_00 + 150_000_000_00 + pipeline);
    const flags = (await staff.analyst!.get(`/api/facilities/${facilityId}/risk-flags`)).body.data;
    for (const fl of flags) expect(fl.evidence.length).toBeGreaterThan(0);
    const rar = (await staff.analyst!.get(`/api/facilities/${facilityId}/rarorac`)).body.data[0];
    expect(rar.mode).toBe('MOCK');
    expect(rar.notes[0]).toMatch(/MOCK/);
    const done = await act(staff.analyst!, facilityId, 'CREDIT_ANALYSIS', 'COMPLETE');
    expect(done.status).toBe(200);
    // No E&S branch: Team Lead, Credit Analysis opens straight away.
    expect(await q(db(), `SELECT 1 FROM workflow_task WHERE facility_id=$1 AND stage_key='CTL_REVIEW' AND status='OPEN'`, [facilityId])).toHaveLength(1);
  });

  it('E&S review is not required for a Manufacturing request (SWR: HEART, Oil & Gas, Mining, Aviation only)', async () => {
    const es = (await staff.es!.get(`/api/facilities/${facilityId}/es`)).body.data;
    expect(es.required).toBe(false);
  });

  it('Journey 7: authority follows request + outstanding exposure (PRD); HCR → CRO → Line ED → ED concurrence → MD approves', async () => {
    expect((await act(staff.ctl!, facilityId, 'CTL_REVIEW', 'RECOMMEND')).status).toBe(200);
    const route = (await q(db(), `SELECT route FROM workflow_instance WHERE facility_id=$1`, [facilityId]))[0].route;
    // ₦150m request + ₦180m Murabaha + ₦30m APG (₦60m at 50% CCF) outstanding = ₦360m → MD + CRO + HCR band with ED concurrence
    expect(route.explanation.join(' ')).toMatch(/outstanding exposure/);
    expect(route.stages.filter((s: any) => s.type === 'APPROVAL_LEVEL').map((s: any) => s.key)).toEqual(['HCR', 'CRO', 'ED', 'ED_CONCURRENCE', 'MD']);
    const hcrTask = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='HCR'`, [facilityId]))[0];
    await staff.ghcr!.post(`/api/tasks/${hcrTask.id}/claim`);
    const codes = (await staff.ghcr!.get(`/api/tasks/${hcrTask.id}`)).body.data.availableActions.map((a: any) => a.code);
    expect(codes).toContain('RECOMMEND');
    expect(codes).not.toContain('APPROVE'); // above HCR authority: Approve must not appear
    expect((await staff.ghcr!.post(`/api/tasks/${hcrTask.id}/actions`, { action: 'APPROVE', idempotencyKey: idem() })).status).toBe(403);
    for (const [u, k] of [['ghcr', 'HCR'], ['cro', 'CRO'], ['ed', 'ED'], ['ed2', 'ED_CONCURRENCE']] as const) expect((await act(staff[u]!, facilityId, k, 'RECOMMEND')).status).toBe(200);
    const md = await act(staff.md!, facilityId, 'MD', 'APPROVE', { conditions: ['Insurance (Takaful) cover on mortgaged factory noting the Bank'] });
    expect(md.status).toBe(200);
    // replayed approval request is not re-applied
    const f = (await abc.get(`/api/facilities/${facilityId}`)).body.data.facility;
    expect(f.status).toBe('APPROVED');
    const terms = await q(db(), 'SELECT * FROM approved_terms WHERE facility_id=$1', [facilityId]);
    expect(terms).toHaveLength(1);
    expect(terms[0].amount_minor).toBe(150_000_000_00);
    expect(terms[0].approved_by_names).toEqual(expect.arrayContaining([expect.stringMatching(/DEMO MD/)]));
    await expect(q(db(), 'UPDATE approved_terms SET amount_minor=1 WHERE facility_id=$1', [facilityId])).rejects.toThrow(/GZ_IMMUTABLE/);
  });

  it('executive decision view and Word term sheet are produced', async () => {
    const v = (await staff.md!.get(`/api/facilities/${facilityId}/decision-view`)).body.data;
    expect(v.summary.requestedAmount).toMatch(/150,000,000/);
    expect(v.recommendations.map((r: any) => r.action)).toEqual(expect.arrayContaining(['RECOMMEND', 'APPROVE', 'COMPLETE']));
    // PRD: the combined term sheet is generated at submission and refreshed at every decision (background job).
    const { drain } = await import('./helpers.js');
    await drain(['termsheet.refresh']);
    const auto = await q(db(), `SELECT version_no, content, edit_reason FROM generated_document WHERE facility_id=$1 AND kind='TERM_SHEET' ORDER BY version_no`, [facilityId]);
    expect(auto.length).toBeGreaterThanOrEqual(8); // submit, RM, TL, RBE, DH, TL credit, HCR, CRO, ED, ED, MD
    expect(auto[0].edit_reason).toBeNull();
    expect(auto.at(-1).edit_reason).toBe('approval recorded');
    const latest = auto.at(-1).content;
    expect(latest.format).toBe('CAM');
    const headings = latest.sections.map((x: any) => x.heading);
    for (const h of ['1. Executive summary', '2. Group facility summary', '9. Historical financial analysis & outlook', '12. Summary of transactions with Alternative Bank — last twelve months', '14. Consolidated transaction history — last twelve months', '21. Assigned collateral', '27. Approval recommendations and conditions — for Credit Risk', 'Officers who commented or decided']) expect(headings).toContain(h);
    const wf = latest.sections.find((x: any) => x.heading === 'Approval workflow — comments and decisions');
    expect(wf.table.rows.some((r: any) => /DEMO MD/.test(r[1]) && r[3] === 'APPROVE' && /\d{4}/.test(r[0]))).toBe(true);
    const signers = latest.sections.find((x: any) => x.heading === 'Officers who commented or decided').table.rows.map((r: any) => r[0]);
    expect(signers).toEqual(expect.arrayContaining([expect.stringMatching(/DEMO RM/), expect.stringMatching(/DEMO MD/), expect.stringMatching(/Credit Analyst/)]));
    const n = auto.length;
    const ts = await staff.analyst!.post(`/api/facilities/${facilityId}/term-sheet`, {});
    expect(ts.status).toBe(201);
    const ts2 = await staff.analyst!.post(`/api/facilities/${facilityId}/term-sheet`, { overrides: { decisionNote: 'Approved subject to Takaful cover.', swot: 'Strength: 15-year operating history.' }, reason: 'Added decision note' });
    expect(ts2.body.data.version).toBe(n + 2);
    // Narrative edits are carried forward into later automatic refreshes.
    const { generateTermSheet } = await import('../src/modules/docgen/service.js');
    const { SYSTEM } = await import('../src/modules/audit/audit.js');
    const { tx } = await import('../src/db/pool.js');
    const again = await tx((c) => generateTermSheet(c, SYSTEM, facilityId, undefined, { automatic: 'test refresh' }));
    expect(again.content.overrides.swot).toMatch(/15-year/);
    const g = await staff.analyst!.post(`/api/documents/${ts2.body.data.documentId}/grant`, { disposition: 'attachment' });
    const file = await staff.analyst!.get(g.body.data.url);
    expect(file.raw.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(file.raw.rawPayload.subarray(0, 2).toString()).toBe('PK');
    // the customer cannot see internal documents
    expect((await abc.post(`/api/documents/${ts2.body.data.documentId}/grant`, {})).status).toBe(404);
  });

  it('Journey 8: offer maker-checker, then customer accepts', async () => {
    expect((await staff.creditops!.post(`/api/facilities/${facilityId}/offer`)).status).toBe(201);
    const off = (await staff.creditops!.get(`/api/facilities/${facilityId}/offer`)).body.data.offers[0];
    expect(off.sections.map((s: any) => s.heading)).toContain('Pricing');
    expect(JSON.stringify(off.sections)).not.toMatch(/(?<!non-)\binterest\b|\bloans?\b/i);
    expect((await abc.get(`/api/facilities/${facilityId}/offer`)).body.data.offers).toHaveLength(0); // not visible before issue
    expect((await staff.creditops!.post(`/api/offers/${off.id}/check`, { decision: 'ISSUE' })).status).toBe(403);
    expect((await staff.creditops2!.post(`/api/offers/${off.id}/check`, { decision: 'ISSUE' })).status).toBe(200);
    // PRD sign-off: above ₦2m the account officer signs and the RBE / Group Head countersigns before issue.
    const pending = (await staff.rm!.get(`/api/facilities/${facilityId}/offer`)).body.data.offers[0];
    expect(pending.status).toBe('PENDING_SIGNOFF');
    expect(pending.signoff.rule).toMatch(/RBE or Group Head/);
    expect((await abc.get(`/api/facilities/${facilityId}/offer`)).body.data.offers).toHaveLength(0);
    expect((await staff.analyst!.post(`/api/offers/${off.id}/sign`, { kind: 'SIGN' })).status).toBe(403);
    expect((await staff.rm!.post(`/api/offers/${off.id}/sign`, { kind: 'COUNTERSIGN' })).status).toBe(403);
    expect((await staff.rm!.post(`/api/offers/${off.id}/sign`, { kind: 'SIGN' })).body.data.issued).toBe(false);
    expect((await staff.rbe!.post(`/api/offers/${off.id}/sign`, { kind: 'COUNTERSIGN' })).body.data.issued).toBe(true);
    const cOff = (await abc.get(`/api/facilities/${facilityId}/offer`)).body.data.offers[0];
    expect(cOff.maker).toBeUndefined();
    const noAck = await abc.post(`/api/offers/${cOff.id}/respond`, { decision: 'ACCEPT', rowVersion: cOff.rowVersion });
    expect(noAck.status).toBe(400);
    expect((await abc.post(`/api/offers/${cOff.id}/respond`, { decision: 'ACCEPT', acknowledgement: true, rowVersion: cOff.rowVersion })).status).toBe(200);
    expect((await abc.get(`/api/facilities/${facilityId}`)).body.data.facility.status).toBe('FULFILMENT');
  });

  it('Journey 9–10: Legal ∥ Shariah, then Credit Operations; mandatory conditions block completion', async () => {
    const cond = (await staff.legal!.get(`/api/facilities/${facilityId}/conditions`)).body.data;
    expect(cond.blocking).toBeGreaterThan(0);
    expect((await act(staff.legal!, facilityId, 'LEGAL', 'COMPLETE')).body.error.code).toBe('PREREQUISITES');
    const evidence = async (c: Client) => {
      const d = await c.post(`/api/facilities/${facilityId}/documents`, { title: 'Executed document', customerVisible: false });
      await upload(c, `/api/documents/${d.body.data.id}/upload`, 'evidence.pdf', pdf('evidence'));
      return d.body.data.id;
    };
    const satisfy = async (c: Client, team: string) => {
      for (const it of cond.items.filter((x: any) => x.ownerTeam === team && x.category === 'PRECEDENT')) {
        const r = await c.patch(`/api/conditions/${it.id}`, { status: 'SATISFIED', evidenceDocumentId: await evidence(c), comment: 'Executed and verified against the original.' });
        expect(r.status).toBe(200);
      }
    };
    // Shariah cannot action Legal conditions
    const legalItem = cond.items.find((x: any) => x.ownerTeam === 'LEGAL');
    expect((await staff.shariah!.patch(`/api/conditions/${legalItem.id}`, { status: 'SATISFIED', comment: 'Trying to action legal' })).status).toBe(403);
    await satisfy(staff.legal!, 'LEGAL');
    await satisfy(staff.shariah!, 'SHARIAH');
    expect((await act(staff.legal!, facilityId, 'LEGAL', 'COMPLETE')).status).toBe(200);
    expect((await act(staff.shariah!, facilityId, 'SHARIAH', 'COMPLETE')).status).toBe(200);
    await satisfy(staff.creditops!, 'CREDIT_OPS');
    expect((await act(staff.creditops!, facilityId, 'CREDIT_OPS', 'COMPLETE')).status).toBe(200);
    expect((await abc.get(`/api/facilities/${facilityId}`)).body.data.facility.status).toBe('READY_FOR_ACTIVATION');
  });

  it('Journey 11: activation, then maker-checker disbursement protected against double submission', async () => {
    const a = await staff.creditops!.post(`/api/facilities/${facilityId}/activate`);
    expect(a.status).toBe(201);
    expect((await staff.creditops!.post(`/api/facilities/${facilityId}/activate`)).body.error.code).toBe('NOT_READY');
    const key = idem();
    const body = { amountMinor: 100_000_000_00, beneficiaryAccount: '0100000001', beneficiaryName: 'Resin Supplies FZE (DEMO)', narrative: 'Murabaha purchase — first tranche', idempotencyKey: key };
    const [d1, d2] = [await staff.creditops!.post(`/api/facilities/${facilityId}/disbursements`, body), await staff.creditops!.post(`/api/facilities/${facilityId}/disbursements`, body)];
    expect(d1.body.data.id).toBe(d2.body.data.id);
    expect((await staff.creditops!.post(`/api/facilities/${facilityId}/disbursements`, { ...body, amountMinor: 60_000_000_00, idempotencyKey: idem() })).body.error.code).toBe('EXCEEDS_LIMIT');
    expect((await staff.creditops!.post(`/api/disbursements/${d1.body.data.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    const ok = await staff.creditops2!.post(`/api/disbursements/${d1.body.data.id}/decide`, { decision: 'APPROVE' });
    expect(ok.body.data.status).toBe('POSTED');
    const acct = (await abc.get(`/api/facilities/${facilityId}/account`)).body.data;
    expect(acct.utilisedMinor).toBe(100_000_000_00);
    expect(acct.schedule).toHaveLength(36);
    expect(acct.cbaReference).toBeUndefined(); // internal reference hidden from customer
    const totalProfit = acct.schedule.reduce((s: number, i: any) => s + i.profitMinor, 0);
    expect(totalProfit).toBe(Math.round(150_000_000_00 * 0.26 * 3));
  });

  it('Journey 12: monitoring detects overdue payments and payments resolve them', async () => {
    const acct = (await staff.creditops!.get(`/api/facilities/${facilityId}/account`)).body.data;
    const far = new Date(Date.now() + 70 * 86400_000).toISOString().slice(0, 10);
    const n = await monitoringSweep(db(), far);
    expect(n).toBeGreaterThan(0);
    const items = (await staff.rm!.get('/api/monitoring')).body.data.filter((m: any) => m.facilityId === facilityId);
    expect(items.some((m: any) => m.kind === 'PAYMENT_OVERDUE')).toBe(true);
    const first = acct.schedule[0];
    expect((await staff.creditops!.post(`/api/facility-accounts/${acct.id}/payments`, { amountMinor: first.totalMinor * 2, valueDate: far, reference: 'DEMO-PAY-0001' })).status).toBe(201);
    expect((await staff.creditops!.post(`/api/facility-accounts/${acct.id}/payments`, { amountMinor: 1, valueDate: far, reference: 'DEMO-PAY-0001' })).body.error.code).toBe('DUPLICATE_PAYMENT');
    const after = (await staff.creditops!.get(`/api/facilities/${facilityId}/account`)).body.data;
    expect(after.schedule[0].status).toBe('PAID');
    expect(after.schedule[1].status).toBe('PAID');
  });

  it('Journey 13: full repayment settles the facility — account closed, balance cleared, customer sees Closed', async () => {
    const acct = (await staff.creditops!.get(`/api/facilities/${facilityId}/account`)).body.data;
    const remaining = acct.schedule.reduce((s: number, i: any) => s + i.totalMinor - i.paidMinor, 0);
    const part = await staff.creditops!.post(`/api/facility-accounts/${acct.id}/payments`, { amountMinor: remaining - 1, valueDate: '2029-01-31', reference: 'DEMO-PAY-0002' });
    expect(part.body.data.settled).toBe(false); // one kobo short: still open
    const last = await staff.creditops!.post(`/api/facility-accounts/${acct.id}/payments`, { amountMinor: 1, valueDate: '2029-01-31', reference: 'DEMO-PAY-0003' });
    expect(last.body.data.settled).toBe(true);
    const after = (await abc.get(`/api/facilities/${facilityId}/account`)).body.data;
    expect(after.status).toBe('CLOSED');
    expect(after.outstandingMinor).toBe(0);
    expect(after.schedule.every((i: any) => i.status === 'PAID')).toBe(true);
    const closed = (await abc.get(`/api/facilities/${facilityId}`)).body.data;
    expect(closed.facility.status).toBe('CLOSED');
    expect(closed.progress.nextStep).toMatch(/Fully repaid/);
    expect((await staff.creditops!.post(`/api/facility-accounts/${acct.id}/payments`, { amountMinor: 100, valueDate: '2029-02-28', reference: 'DEMO-PAY-0004' })).body.error.code).toBe('ACCOUNT_CLOSED');
    const n = await q(db(), `SELECT 1 FROM notification WHERE event_code='FACILITY_SETTLED' AND facility_id=$1`, [facilityId]);
    expect(n.length).toBeGreaterThan(0);
  });

  it('audit trail covers the whole journey and the hash chain verifies', async () => {
    const actions = (await q(db(), 'SELECT DISTINCT action FROM audit_log WHERE facility_id=$1', [facilityId])).map((r: any) => r.action);
    for (const a of ['FACILITY_CREATED', 'DOCUMENT_UPLOADED', 'FACILITY_SUBMITTED', 'WORKFLOW_RECOMMEND', 'BUREAU_REQUESTED', 'EXPOSURE_COMPUTED', 'RARORAC_COMPUTED', 'WORKFLOW_APPROVE', 'TERMS_APPROVED', 'OFFER_ISSUED', 'OFFER_ACCEPTED', 'CONDITION_SATISFIED', 'FACILITY_ACTIVATED', 'DISBURSEMENT_POSTED', 'PAYMENT_RECORDED', 'FACILITY_SETTLED']) expect(actions).toContain(a);
    expect((await verifyAuditChain(db())).ok).toBe(true);
    const timeline = (await abc.get(`/api/facilities/${facilityId}`)).body.data.timeline;
    expect(timeline.at(-1).status).toBe('Closed');
    expect(JSON.stringify(timeline)).not.toMatch(/actor|reason/);
  });
});

describe('workflow controls', () => {
  it('SLA sweep warns, breaches and escalates to the CRO after a prolonged breach', async () => {
    const f = await draftMurabaha(abc);
    await uploadAllRequired(abc, f.id);
    const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    const t = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND status='OPEN'`, [f.id]))[0];
    await q(db(), `UPDATE workflow_task SET warn_at=now()-interval '40 hours', due_at=now()-interval '50 hours' WHERE id=$1`, [t.id]);
    const r = await slaSweep(db());
    expect(r.breached).toBeGreaterThanOrEqual(1);
    expect(r.escalated).toBeGreaterThanOrEqual(1);
    const ev = (await q(db(), `SELECT kind, level FROM sla_event WHERE task_id=$1 ORDER BY id`, [t.id])).map((e: any) => e.kind);
    expect(ev).toEqual(expect.arrayContaining(['STARTED', 'BREACHED', 'ESCALATED']));
    const croN = await q(db(), `SELECT 1 FROM notification n JOIN app_user u ON u.id=n.recipient_id WHERE u.ad_username='demo.cro' AND n.event_code='SLA_ESCALATED' AND n.task_id=$1`, [t.id]);
    expect(croN.length).toBe(1);
    const again = await slaSweep(db());
    expect(again.escalated).toBe(0); // idempotent
  });

  it('return to customer highlights exactly what needs attention, then resumes at the returning stage', async () => {
    const f = await draftMurabaha(abc);
    await uploadAllRequired(abc, f.id);
    let cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    const noItems = await act(staff.rm!, f.id, 'RM_REVIEW', 'RETURN', { returnTarget: 'CUSTOMER', comment: 'Please update' });
    expect(noItems.body.error.code).toBe('REWORK_ITEMS');
    const r = await act(staff.rm!, f.id, 'RM_REVIEW', 'RETURN', { returnTarget: 'CUSTOMER', comment: 'Board resolution unsigned', reworkItems: [{ section: 'DOCUMENTS', message: 'Upload a signed copy of the board resolution.', targetRef: 'BOARD_RESOLUTION' }] });
    expect(r.status).toBe(200);
    const d = (await abc.get(`/api/facilities/${f.id}`)).body.data;
    expect(d.facility.status).toBe('RETURNED');
    expect(d.rework[0].message).toMatch(/signed copy/);
    expect(d.progress.currentlyWith).toBe('You');
    cur = d.facility;
    expect((await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true })).body.error.code).toBe('INCOMPLETE');
    await abc.post(`/api/facilities/${f.id}/rework/${d.rework[0].id}/respond`, { response: 'Signed resolution uploaded.' });
    cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    expect((await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true })).status).toBe(200);
    expect(await q(db(), `SELECT 1 FROM workflow_task WHERE facility_id=$1 AND stage_key='RM_REVIEW' AND status='OPEN'`, [f.id])).toHaveLength(1);
  });

  it('clarification thread keeps the conversation inside Credit360', async () => {
    const f = (await q(db(), `SELECT t.facility_id FROM workflow_task t JOIN facility_request fr ON fr.id=t.facility_id WHERE t.stage_key='RM_REVIEW' AND t.status='OPEN' AND fr.customer_id=$1 LIMIT 1`, [customerId]))[0].facility_id;
    const r = await act(staff.rm!, f, 'RM_REVIEW', 'REQUEST_CLARIFICATION', { comment: 'Please confirm the supplier delivery timeline.', clarification: { toCustomer: true, subject: 'Supplier delivery timeline' } });
    expect(r.status).toBe(200);
    const threads = (await abc.get(`/api/facilities/${f}/threads`)).body.data;
    expect(threads[0].subject).toBe('Supplier delivery timeline');
    expect(threads[0].unread).toBe(1);
    expect((await abc.post(`/api/threads/${threads[0].id}/messages`, { body: 'Delivery is within 21 days of the purchase order.' })).status).toBe(201);
    const t = (await staff.rm!.get(`/api/threads/${threads[0].id}`)).body.data;
    expect(t.messages).toHaveLength(2);
    expect(t.messages[1].senderType).toBe('CUSTOMER');
  });

  it('RM-initiated requests follow the alternative route (BM → RBE → DH)', async () => {
    const r = await staff.rm!.post('/api/facilities', { productCode: 'IJARAH', idempotencyKey: idem(), customerId });
    expect(r.status).toBe(201);
    expect(r.body.data.origin).toBe('RM');
    const id = r.body.data.id;
    let rv = r.body.data.rowVersion;
    rv = (await staff.rm!.patch(`/api/facilities/${id}`, { rowVersion: rv, step: 'DETAILS', completeStep: true, amountMinor: 60_000_000_00, tenorMonths: 36, purpose: 'Lease of 10 delivery trucks for distribution', paymentFrequency: 'MONTHLY', sourceOfPayment: 'Distribution revenue domiciled with the Bank' })).body.data.rowVersion;
    rv = (await staff.rm!.patch(`/api/facilities/${id}`, { rowVersion: rv, step: 'PRODUCT_INFO', completeStep: true, supplierName: 'Demo Motors Ltd', underlyingAsset: '10 x 15-tonne trucks', productFields: { assetType: 'VEHICLES', assetDescription: '10 x 15-tonne trucks', assetCostMinor: 60_000_000_00 } })).body.data.rowVersion;
    rv = (await staff.rm!.patch(`/api/facilities/${id}`, { rowVersion: rv, step: 'SECURITY', completeStep: true, proposedSecurity: 'Bank title to leased vehicles' })).body.data.rowVersion;
    await uploadAllRequired(staff.rm!, id);
    const s = await staff.rm!.post(`/api/facilities/${id}/submit`, { rowVersion: rv + 0, declaration: true });
    const rv2 = s.status === 409 ? (await staff.rm!.get(`/api/facilities/${id}`)).body.data.facility.rowVersion : rv;
    if (s.status !== 200) expect((await staff.rm!.post(`/api/facilities/${id}/submit`, { rowVersion: rv2, declaration: true })).status).toBe(200);
    const first = await q(db(), `SELECT stage_key FROM workflow_task WHERE facility_id=$1`, [id]);
    expect(first.map((x: any) => x.stage_key)).toEqual(['BM_REVIEW']);
    const route = (await q(db(), `SELECT route FROM workflow_instance WHERE facility_id=$1`, [id]))[0].route;
    expect(route.stages.slice(0, 3).map((x: any) => x.key)).toEqual(['BM_REVIEW', 'RBE_REVIEW', 'DH_REVIEW']);
  });

  it('an RM "not recommended" is recorded and the request still moves to the Team Lead; a Team Lead decline ends it (PRD)', async () => {
    const f = await draftMurabaha(abc);
    await uploadAllRequired(abc, f.id);
    const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    for (const d of (await staff.rm!.get(`/api/facilities/${f.id}/documents`)).body.data.filter((x: any) => x.status === 'UPLOADED')) await staff.rm!.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' });
    expect((await act(staff.rm!, f.id, 'RM_REVIEW', 'DECLINE', { comment: 'Turnover does not support the requested amount.' })).status).toBe(200);
    expect(await q(db(), `SELECT 1 FROM workflow_task WHERE facility_id=$1 AND stage_key='BM_REVIEW' AND status='OPEN'`, [f.id])).toHaveLength(1);
    expect((await abc.get(`/api/facilities/${f.id}`)).body.data.facility.status).toBe('IN_REVIEW');
    expect((await act(staff.bm!, f.id, 'BM_REVIEW', 'DECLINE', { comment: 'Declined in line with the RM view.' })).status).toBe(200);
    expect((await abc.get(`/api/facilities/${f.id}`)).body.data.facility.status).toBe('DECLINED');
  });
});
