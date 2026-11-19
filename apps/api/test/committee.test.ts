import { beforeAll, describe, expect, it } from 'vitest';
import { abcClient, act, Client, completeAbcProfile, db, draftMurabaha, getApp, idem, performCreditAnalysis, staffLogin, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';

let app: Awaited<ReturnType<typeof getApp>>;
let abc: Client; let customerId: string; let fid: string;
const s: Record<string, Client> = {};

beforeAll(async () => {
  app = await getApp();
  abc = await abcClient(app);
  customerId = (await abc.get('/api/auth/me')).body.data.customer.id;
  await completeAbcProfile(abc, customerId);
  for (const u of ['rm', 'bm', 'analyst', 'es', 'ctl', 'ghcr', 'cro', 'ed', 'md', 'mic1', 'creditops', 'creditops2']) s[u] = await staffLogin(app, `demo.${u}`);
  await q(db(), `INSERT INTO fx_rate(base_ccy, quote_ccy, rate, rate_date, source) VALUES ('USD','NGN',1520.50,'2025-10-31','CBN NAFEM closing (DEMO)') ON CONFLICT DO NOTHING`);
});

describe('committee approval (MIC) and customer negotiation', () => {
  it('routes ₦1bn to MIC after CRO, ED and MD recommendations', async () => {
    const f = await draftMurabaha(abc, { amountMinor: 1_000_000_000_00 });
    fid = f.id;
    await uploadAllRequired(abc, fid);
    const cur = (await abc.get(`/api/facilities/${fid}`)).body.data.facility;
    expect((await abc.post(`/api/facilities/${fid}/submit`, { rowVersion: cur.rowVersion, declaration: true })).status).toBe(200);
    for (const d of (await s.rm!.get(`/api/facilities/${fid}/documents`)).body.data.filter((x: any) => x.status === 'UPLOADED')) await s.rm!.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' });
    expect((await act(s.rm!, fid, 'RM_REVIEW', 'RECOMMEND')).status).toBe(200);
    expect((await act(s.bm!, fid, 'BM_REVIEW', 'RECOMMEND')).status).toBe(200);
    const t = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='CREDIT_ANALYSIS'`, [fid]))[0];
    await s.analyst!.post(`/api/tasks/${t.id}/claim`);
    await performCreditAnalysis(s.analyst!, fid, customerId);
    expect((await act(s.analyst!, fid, 'CREDIT_ANALYSIS', 'COMPLETE')).status).toBe(200);
    const es = (await s.es!.get(`/api/facilities/${fid}/es`)).body.data;
    await s.es!.put(`/api/facilities/${fid}/es`, { answers: Object.fromEntries(es.trigger.questionnaire.map((x: any) => [x.code, x.options[0].code])), findings: 'Low environmental and social impact; permits current and verified.', recommendation: 'PROCEED', submit: true });
    expect((await act(s.es!, fid, 'ES_REVIEW', 'COMPLETE')).status).toBe(200);
    expect((await act(s.ctl!, fid, 'CTL_REVIEW', 'RECOMMEND')).status).toBe(200);
    expect((await act(s.ghcr!, fid, 'GH_CR_REVIEW', 'RECOMMEND')).status).toBe(200);
    const route = (await q(db(), `SELECT route FROM workflow_instance WHERE facility_id=$1 AND kind='CREDIT_APPROVAL'`, [fid]))[0].route;
    expect(route.stages.filter((x: any) => x.type === 'APPROVAL_LEVEL').map((x: any) => x.key)).toEqual(['CRO', 'ED', 'MD', 'MIC']);
    for (const [u, k] of [['cro', 'CRO'], ['ed', 'ED'], ['md', 'MD']] as const) expect((await act(s[u]!, fid, k, 'RECOMMEND')).status).toBe(200);
  });

  it('committee needs quorum, required approvals and the MD; a member votes once', async () => {
    const task = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='MIC' AND status='OPEN'`, [fid]))[0];
    expect((await s.analyst!.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: 'APPROVE', idempotencyKey: idem() })).status).toBe(403);
    const v1 = await s.mic1!.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: 'APPROVE', idempotencyKey: idem(), comment: 'Supported.' });
    expect(v1.body.data.committee).toBe('PENDING');
    expect((await s.mic1!.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: 'APPROVE', idempotencyKey: idem() })).status).toBe(403);
    expect((await s.cro!.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: 'APPROVE', idempotencyKey: idem(), comment: 'Supported.' })).body.data.committee).toBe('PENDING');
    // ED approves: 3 approvals reach quorum but the required MD vote is still missing
    const v3 = await s.ed!.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: 'APPROVE', idempotencyKey: idem(), comment: 'Supported.' });
    expect(v3.body.data.committee).toBe('PENDING');
    const detail = (await s.md!.get(`/api/tasks/${task.id}`)).body.data;
    expect(detail.committee.votes).toHaveLength(3);
    expect(detail.committee.rules.requiredRoles).toEqual(['MD']);
    const v4 = await s.md!.post(`/api/tasks/${task.id}/actions`, { action: 'VOTE', vote: 'APPROVE', idempotencyKey: idem(), comment: 'Approved.' });
    expect(v4.body.data.committee).toBe('APPROVED');
    expect((await abc.get(`/api/facilities/${fid}`)).body.data.facility.status).toBe('APPROVED');
  });

  it('negotiation never edits approved terms; an approved change creates terms v2', async () => {
    await s.creditops!.post(`/api/facilities/${fid}/offer`);
    const off = (await s.creditops!.get(`/api/facilities/${fid}/offer`)).body.data.offers[0];
    await s.creditops2!.post(`/api/offers/${off.id}/check`, { decision: 'ISSUE' });
    const co = (await abc.get(`/api/facilities/${fid}/offer`)).body.data.offers[0];
    const neg = await abc.post(`/api/offers/${co.id}/respond`, { decision: 'NEGOTIATE', rowVersion: co.rowVersion, negotiation: { amountMinor: 800_000_000_00, tenorMonths: 48, justification: 'We will phase the resin purchase over a longer period to match contract inflows.' } });
    expect(neg.status).toBe(200);
    expect((await abc.get(`/api/facilities/${fid}`)).body.data.facility.status).toBe('IN_NEGOTIATION');
    const n = (await s.ghcr!.get(`/api/facilities/${fid}/offer`)).body.data.negotiations[0];
    const tooHigh = await s.ghcr!.post(`/api/negotiations/${n.id}/decide`, { decision: 'APPROVE', note: 'Agreed with changes', amountMinor: 1_200_000_000_00 });
    expect(tooHigh.body.error.code).toBe('REAPPROVAL_REQUIRED');
    const okd = await s.ghcr!.post(`/api/negotiations/${n.id}/decide`, { decision: 'APPROVE', note: 'Reduced amount and longer tenor agreed.' });
    expect(okd.body.data.newTermsVersion).toBe(2);
    const terms = await q(db(), 'SELECT version_no, amount_minor, tenor_months, source FROM approved_terms WHERE facility_id=$1 ORDER BY version_no', [fid]);
    expect(terms.map((t: any) => [t.version_no, t.amount_minor, t.tenor_months, t.source])).toEqual([[1, 1_000_000_000_00, 36, 'CREDIT_APPROVAL'], [2, 800_000_000_00, 48, 'NEGOTIATION_APPROVAL']]);
    expect((await s.creditops!.post(`/api/facilities/${fid}/offer`)).status).toBe(201);
    const offers = (await s.creditops!.get(`/api/facilities/${fid}/offer`)).body.data.offers;
    expect(offers.map((o: any) => [o.status, o.termsVersion])).toEqual([['PENDING_CHECK', 2], ['SUPERSEDED', 1]]);
  });
});
