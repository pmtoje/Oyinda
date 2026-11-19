import { beforeAll, describe, expect, it } from 'vitest';
import { act, Client, completeKanoProfile, db, draftMurabaha, getApp, idem, kanoClient, KANO, performCreditAnalysis, staffLogin, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';

let app: Awaited<ReturnType<typeof getApp>>;
let kano: Client; let customerId: string; let fid: string;
const s: Record<string, Client> = {};
const AMOUNT = 600_000_000_00;

beforeAll(async () => {
  app = await getApp();
  kano = await kanoClient(app);
  customerId = (await kano.get('/api/auth/me')).body.data.customer.id;
  await completeKanoProfile(kano, customerId);
  for (const u of ['rm', 'bm', 'rbe', 'dh', 'analyst', 'es', 'ctl', 'ghcr', 'cro', 'ed', 'ed2', 'md', 'ned1', 'ned2', 'ned3', 'creditops', 'creditops2']) s[u] = await staffLogin(app, `demo.${u}`);
  await q(db(), `INSERT INTO fx_rate(base_ccy, quote_ccy, rate, rate_date, source) VALUES ('USD','NGN',1520.50,'2025-10-31','CBN NAFEM closing (DEMO)') ON CONFLICT DO NOTHING`);
});

/** Customer submits; RM → TL → RBE → DH; credit analysis ∥ E&S; TL Credit Analysis. Returns the facility id. */
async function toApprovalChain(amountMinor: number) {
  const f = await draftMurabaha(kano, { amountMinor });
  await uploadAllRequired(kano, f.id);
  const cur = (await kano.get(`/api/facilities/${f.id}`)).body.data.facility;
  expect((await kano.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true })).status).toBe(200);
  for (const d of (await s.rm!.get(`/api/facilities/${f.id}/documents`)).body.data.filter((x: any) => x.status === 'UPLOADED')) await s.rm!.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' });
  for (const [u, k] of [['rm', 'RM_REVIEW'], ['bm', 'BM_REVIEW'], ['rbe', 'RBE_REVIEW'], ['dh', 'DH_REVIEW']] as const) expect((await act(s[u]!, f.id, k, 'RECOMMEND')).status).toBe(200);
  return f.id;
}

async function analyseAndReview(id: string) {
  const t = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='CREDIT_ANALYSIS'`, [id]))[0];
  await s.analyst!.post(`/api/tasks/${t.id}/claim`);
  await performCreditAnalysis(s.analyst!, id, customerId, { account: KANO.account, owner: 'Kano Agro-Allied Processing Ltd' });
  expect((await act(s.analyst!, id, 'CREDIT_ANALYSIS', 'COMPLETE')).status).toBe(200);
  const es = (await s.es!.get(`/api/facilities/${id}/es`)).body.data;
  const answers = Object.fromEntries(es.trigger.questionnaire.map((x: any) => [x.code, 'NA']));
  expect((await s.es!.put(`/api/facilities/${id}/es`, { answers, findings: 'Out-grower sourcing reviewed; permits current; no prohibited agrochemicals in use.', recommendation: 'PROCEED', submit: true })).status).toBe(200);
  expect((await act(s.es!, id, 'ES_REVIEW', 'COMPLETE')).status).toBe(200);
  expect((await act(s.ctl!, id, 'CTL_REVIEW', 'RECOMMEND')).status).toBe(200);
}

describe('HEART-sector request: concurrent E&S review and MIC approval (PRD grid)', () => {
  it('routes ₦100m+ agriculture requests to E&S review concurrently with credit analysis', async () => {
    fid = await toApprovalChain(AMOUNT);
    const open = await q(db(), `SELECT stage_key FROM workflow_task WHERE facility_id=$1 AND status='OPEN' ORDER BY stage_key`, [fid]);
    expect(open.map((t: any) => t.stage_key)).toEqual(['CREDIT_ANALYSIS', 'ES_REVIEW']);
    const es = (await s.es!.get(`/api/facilities/${fid}/es`)).body.data;
    expect(es.required).toBe(true);
    expect(es.trigger.questionnaire.map((x: any) => x.code)).toEqual(expect.arrayContaining(['PERMITS', 'CHILD_FORCED_LABOUR', 'PROHIBITED_AGROCHEMICALS', 'ESIA']));
    // SWR §10: the RM completes the checklist with the customer; only the E&S analyst may submit the assessment.
    const answers = Object.fromEntries(es.trigger.questionnaire.map((x: any) => [x.code, 'NA']));
    expect((await s.rm!.put(`/api/facilities/${fid}/es`, { answers, submit: false })).status).toBe(200);
    expect((await s.rm!.put(`/api/facilities/${fid}/es`, { answers, findings: 'RM attempting to submit the E&S assessment.', recommendation: 'PROCEED', submit: true })).status).toBe(403);
    expect((await s.analyst!.put(`/api/facilities/${fid}/es`, { answers, submit: false })).status).toBe(403);
  });

  it('₦600m follows HCR → CRO → Line ED → ED concurrence → MD → MIC', async () => {
    await analyseAndReview(fid);
    const route = (await q(db(), `SELECT route FROM workflow_instance WHERE facility_id=$1 AND kind='CREDIT_APPROVAL'`, [fid]))[0].route;
    expect(route.stages.filter((x: any) => x.type === 'APPROVAL_LEVEL').map((x: any) => x.key)).toEqual(['HCR', 'CRO', 'ED', 'ED_CONCURRENCE', 'MD', 'MIC']);
    expect(route.explanation.join(' ')).toMatch(/non-cash-backed|approved line/i);
    // The same ED cannot provide both the Line ED approval and the concurrence (segregation of duties).
    for (const [u, k] of [['ghcr', 'HCR'], ['cro', 'CRO'], ['ed', 'ED']] as const) expect((await act(s[u]!, fid, k, 'RECOMMEND')).status).toBe(200);
    const conc = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='ED_CONCURRENCE' AND status='OPEN'`, [fid]))[0];
    await s.ed!.post(`/api/tasks/${conc.id}/claim`);
    const view = (await s.ed!.get(`/api/tasks/${conc.id}`)).body.data;
    expect(view.availableActions.map((a: any) => a.code)).not.toContain('RECOMMEND');
    await s.ed!.post(`/api/tasks/${conc.id}/release`);
    for (const [u, k] of [['ed2', 'ED_CONCURRENCE'], ['md', 'MD']] as const) expect((await act(s[u]!, fid, k, 'RECOMMEND')).status).toBe(200);
  });

  it('MIC needs 3 NEDs and 2 EDs including the MD; a member votes once', async () => {
    const task = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='MIC' AND status='OPEN'`, [fid]))[0];
    const vote = (c: Client, v = 'APPROVE') => c.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: v, idempotencyKey: idem(), comment: 'Supported.' });
    expect((await vote(s.analyst!)).status).toBe(403);
    expect((await vote(s.ned1!)).body.data.committee).toBe('PENDING');
    expect((await vote(s.ned1!)).status).toBe(403);
    for (const u of ['ed', 'md', 'ned2']) expect((await vote(s[u]!)).body.data.committee).toBe('PENDING');
    const detail = (await s.md!.get(`/api/tasks/${task.id}`)).body.data;
    expect(detail.committee.votes).toHaveLength(4);
    expect(detail.committee.rules.requiredRoleCounts).toEqual({ NED: 3, 'ED|MD': 2 });
    // Five members have approved (quorum met) but only two NEDs have signed.
    expect((await vote(s.ed2!)).body.data.committee).toBe('PENDING');
    expect((await vote(s.ned3!)).body.data.committee).toBe('APPROVED');
    expect((await kano.get(`/api/facilities/${fid}`)).body.data.facility.status).toBe('APPROVED');
  });

  it('negotiation never edits approved terms; an approved change creates terms v2', async () => {
    await s.creditops!.post(`/api/facilities/${fid}/offer`);
    const off = (await s.creditops!.get(`/api/facilities/${fid}/offer`)).body.data.offers[0];
    await s.creditops2!.post(`/api/offers/${off.id}/check`, { decision: 'ISSUE' });
    expect((await s.rm!.post(`/api/offers/${off.id}/sign`, { kind: 'SIGN' })).status).toBe(200);
    expect((await s.rbe!.post(`/api/offers/${off.id}/sign`, { kind: 'COUNTERSIGN' })).body.data.issued).toBe(true);
    const co = (await kano.get(`/api/facilities/${fid}/offer`)).body.data.offers[0];
    const neg = await kano.post(`/api/offers/${co.id}/respond`, { decision: 'NEGOTIATE', rowVersion: co.rowVersion, negotiation: { amountMinor: 500_000_000_00, tenorMonths: 48, justification: 'We will phase the grain purchase over a longer period to match harvest inflows.' } });
    expect(neg.status).toBe(200);
    expect((await kano.get(`/api/facilities/${fid}`)).body.data.facility.status).toBe('IN_NEGOTIATION');
    const n = (await s.ghcr!.get(`/api/facilities/${fid}/offer`)).body.data.negotiations[0];
    const tooHigh = await s.ghcr!.post(`/api/negotiations/${n.id}/decide`, { decision: 'APPROVE', note: 'Agreed with changes', amountMinor: 700_000_000_00 });
    expect(tooHigh.body.error.code).toBe('REAPPROVAL_REQUIRED');
    const okd = await s.ghcr!.post(`/api/negotiations/${n.id}/decide`, { decision: 'APPROVE', note: 'Reduced amount and longer tenor agreed.' });
    expect(okd.body.data.newTermsVersion).toBe(2);
    const terms = await q(db(), 'SELECT version_no, amount_minor, tenor_months, source FROM approved_terms WHERE facility_id=$1 ORDER BY version_no', [fid]);
    expect(terms.map((t: any) => [t.version_no, t.amount_minor, t.tenor_months, t.source])).toEqual([[1, AMOUNT, 36, 'CREDIT_APPROVAL'], [2, 500_000_000_00, 48, 'NEGOTIATION_APPROVAL']]);
    expect((await s.creditops!.post(`/api/facilities/${fid}/offer`)).status).toBe(201);
    const offers = (await s.creditops!.get(`/api/facilities/${fid}/offer`)).body.data.offers;
    expect(offers.map((o: any) => [o.status, o.termsVersion])).toEqual([['PENDING_CHECK', 2], ['SUPERSEDED', 1]]);
  });

  it('Credit Operations can record a committee decision from the signed minutes (PRD single access)', async () => {
    const id = await toApprovalChain(AMOUNT);
    await analyseAndReview(id);
    for (const [u, k] of [['ghcr', 'HCR'], ['cro', 'CRO'], ['ed', 'ED'], ['ed2', 'ED_CONCURRENCE'], ['md', 'MD']] as const) expect((await act(s[u]!, id, k, 'RECOMMEND')).status).toBe(200);
    const task = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='MIC' AND status='OPEN'`, [id]))[0];
    expect((await s.creditops!.get(`/api/tasks/${task.id}`)).body.data.availableActions.map((a: any) => a.code)).toContain('RECORD_DECISION');
    const noMinutes = await s.creditops!.post(`/api/tasks/${task.id}/actions`, { action: 'RECORD_DECISION', vote: 'APPROVE', comment: 'Approved at the MIC meeting.', idempotencyKey: idem() });
    expect(noMinutes.body.error.code).toBe('MINUTES_REQUIRED');
    const r = await s.creditops!.post(`/api/tasks/${task.id}/actions`, { action: 'RECORD_DECISION', vote: 'APPROVE', minutesReference: 'MIC/2026/41', comment: 'Approved at the MIC meeting.', idempotencyKey: idem() });
    expect(r.body.data.committee).toBe('APPROVED');
    // PRD: authority follows the new request plus outstanding exposure — the first ₦600m approval takes this request to BRMC.
    const route = (await q(db(), `SELECT route FROM workflow_instance WHERE facility_id=$1 AND kind='CREDIT_APPROVAL'`, [id]))[0].route;
    expect(route.stages.filter((x: any) => x.type === 'APPROVAL_LEVEL').map((x: any) => x.key).slice(-2)).toEqual(['MIC', 'BRMC']);
    expect(route.explanation.join(' ')).toMatch(/outstanding exposure/);
    const brmc = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='BRMC' AND status='OPEN'`, [id]))[0];
    expect((await s.creditops!.post(`/api/tasks/${brmc.id}/actions`, { action: 'RECORD_DECISION', vote: 'APPROVE', minutesReference: 'BRMC/2026/12', comment: 'Approved at the BRMC meeting.', idempotencyKey: idem() })).body.data.committee).toBe('APPROVED');
    expect((await kano.get(`/api/facilities/${id}`)).body.data.facility.status).toBe('APPROVED');
    const rec = await q(db(), `SELECT comment FROM workflow_action WHERE facility_id=$1 AND action IN ('APPROVE','RECOMMEND') AND actor_type='SYSTEM' AND payload->>'recorded'='true' ORDER BY created_at`, [id]);
    expect(rec[0].comment).toMatch(/MIC\/2026\/41/);
  });
});
