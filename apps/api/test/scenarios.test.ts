import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abcClient, act, Client, completeAbcProfile, db, draftMurabaha, getApp, performCreditAnalysis, staffLogin, uploadAllRequired, verifyPromoters } from './helpers.js';
import { q } from '../src/db/pool.js';

/**
 * Master prompt end-to-end scenarios, driven through the real workflow (customer submission → RM → BM → RBE → DH →
 * credit analysis → Team Lead → approval chain): PEP, insider-related, Single Obligor Limit breach and cash-backed.
 * Each asserts the resolved approval chain against the approved authority matrix, and its stated reasons.
 */
let app: Awaited<ReturnType<typeof getApp>>;
let abc: Client; let customerId: string;
const staff: Record<string, Client> = {};
const addedParties: string[] = [];

beforeAll(async () => {
  app = await getApp();
  abc = await abcClient(app);
  customerId = (await abc.get('/api/auth/me')).body.data.customer.id;
  await completeAbcProfile(abc, customerId);
  for (const u of ['rm', 'bm', 'rbe', 'dh', 'analyst', 'ctl', 'admin', 'superadmin']) staff[u] = await staffLogin(app, `demo.${u}`);
  await q(db(), `INSERT INTO fx_rate(base_ccy, quote_ccy, rate, rate_date, source) VALUES ('USD','NGN',1520.50,'2025-10-31','CBN NAFEM closing (DEMO)') ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  for (const id of addedParties) await abc.del(`/api/customers/${customerId}/parties/${id}`);
});

/** Submit a ₦amount Murabaha and take it through every pre-approval stage; returns the resolved route. */
async function toApproval(opts: { amountMinor?: number; beforeAnalysis?: (facilityId: string) => Promise<void> } = {}) {
  const f = await draftMurabaha(abc, { amountMinor: opts.amountMinor });
  await uploadAllRequired(abc, f.id);
  const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
  expect((await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true })).status).toBe(200);
  const docs = (await staff.rm!.get(`/api/facilities/${f.id}/documents`)).body.data;
  for (const d of docs.filter((x: any) => x.status === 'UPLOADED')) await staff.rm!.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' });
  for (const [u, k] of [['rm', 'RM_REVIEW'], ['bm', 'BM_REVIEW'], ['rbe', 'RBE_REVIEW'], ['dh', 'DH_REVIEW']] as const) {
    const r = await act(staff[u]!, f.id, k, 'RECOMMEND');
    expect(r.status, `${k}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const t = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='CREDIT_ANALYSIS' AND status='OPEN'`, [f.id]))[0];
  expect((await staff.analyst!.post(`/api/tasks/${t.id}/claim`)).status).toBe(200);
  await opts.beforeAnalysis?.(f.id);
  await performCreditAnalysis(staff.analyst!, f.id, customerId);
  expect((await act(staff.analyst!, f.id, 'CREDIT_ANALYSIS', 'COMPLETE')).status).toBe(200);
  expect((await act(staff.ctl!, f.id, 'CTL_REVIEW', 'RECOMMEND')).status).toBe(200);
  const inst = (await q(db(), `SELECT i.route, c.title, c.payload FROM workflow_instance i JOIN config_item c ON c.id=i.authority_config_id WHERE i.facility_id=$1`, [f.id]))[0];
  const levels = inst.route.stages.filter((s: any) => s.type === 'APPROVAL_LEVEL');
  return { facilityId: f.id, levels, keys: levels.map((s: any) => s.key) as string[], explanation: (inst.route.explanation as string[]).join(' '), matrixTitle: inst.title as string, matrix: inst.payload };
}

/** Every level of the matrix up to and including the Board — the full chain an override demands. */
const fullChainToBoard = (matrix: any) => { const codes = matrix.levels.map((l: any) => l.code); return codes.slice(0, codes.indexOf('BOARD') + 1); };

async function declareParty(body: Record<string, unknown>) {
  const r = await abc.post(`/api/customers/${customerId}/parties`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  addedParties.push(r.body.data.id);
  await verifyPromoters(abc, customerId); // a new director must have their BVN and NIN verified before submission
  return r.body.data.id as string;
}
async function removeParty(id: string) {
  expect((await abc.del(`/api/customers/${customerId}/parties/${id}`)).status).toBeLessThan(300);
  addedParties.splice(addedParties.indexOf(id), 1);
}

describe('master prompt scenarios through the live workflow', () => {
  it('PEP: a politically exposed director sends a ₦150m request through the full chain to the Board', async () => {
    // Declaring a PEP requires the connection to be described
    expect((await abc.post(`/api/customers/${customerId}/parties`, { partyType: 'DIRECTOR', fullName: 'Hon. Tobiloba Ajayi', designation: 'Non-executive Director', isPep: true })).status).toBe(400);
    const id = await declareParty({ partyType: 'DIRECTOR', fullName: 'Hon. Tobiloba Ajayi', designation: 'Non-executive Director', isPep: true, pepDetails: 'Serving member of a State House of Assembly (DEMO)' });
    const r = await toApproval();
    expect(r.keys).toEqual(fullChainToBoard(r.matrix));
    expect(r.keys.at(-1)).toBe('BOARD');
    expect(r.levels.at(-1).level.isFinal).toBe(true);
    expect(r.explanation).toMatch(/PEP:.*Board/);
    expect(r.explanation).toMatch(/Final approving authority: Board/);
    const flags = (await staff.analyst!.get(`/api/facilities/${r.facilityId}/risk-flags`)).body.data;
    expect(flags.map((f: any) => f.code)).toContain('PEP');
    await removeParty(id);
  });

  it('Insider-related: a director related to Bank staff routes to the Board irrespective of amount', async () => {
    const id = await declareParty({ partyType: 'DIRECTOR', fullName: 'Kemi Adeyemi', designation: 'Non-executive Director', isInsider: true, insiderRelationship: 'Spouse of a serving Alternative Bank Executive Director (DEMO)' });
    const r = await toApproval({ amountMinor: 20_000_000_00 }); // a small ₦20m request still goes to the Board
    expect(r.keys).toEqual(fullChainToBoard(r.matrix));
    expect(r.explanation).toMatch(/INSIDER_RELATED:.*Board/);
    expect(r.explanation).not.toMatch(/PEP:/);
    await removeParty(id);
  });

  it('SOL breach: with the Single Obligor Limit set below the aggregate exposure, the Board must approve', async () => {
    const cur = (await staff.admin!.get('/api/admin/config?kind=sol_limit&key=STANDARD&status=ACTIVE')).body.data[0];
    const original = cur.payload;
    const approve = async (payload: any, reason: string) => {
      const d = await staff.admin!.post('/api/admin/config', { kind: 'sol_limit', key: 'STANDARD', title: cur.title, payload, changeReason: reason });
      expect(d.status).toBe(201);
      await staff.admin!.post(`/api/admin/config/${d.body.data.id}/submit`);
      expect((await staff.superadmin!.post(`/api/admin/config/${d.body.data.id}/approve`)).status).toBe(200);
    };
    await approve({ ...original, singleObligorLimitMinor: 300_000_000_00 }, 'Scenario test: shareholders’ funds restated (DEMO)');
    try {
      const r = await toApproval();
      const ex = (await staff.analyst!.get(`/api/facilities/${r.facilityId}/exposure`)).body.data;
      expect(ex.solBreached).toBe(true);
      expect(ex.aggregateMinor).toBeGreaterThan(300_000_000_00);
      expect(r.keys).toEqual(fullChainToBoard(r.matrix));
      expect(r.explanation).toMatch(/SOL_BREACH:/);
      const flags = (await staff.analyst!.get(`/api/facilities/${r.facilityId}/risk-flags`)).body.data;
      expect(flags.find((f: any) => f.code === 'SOL_BREACH')?.severity).toBe('HIGH');
    } finally {
      await approve(original, 'Scenario test: restore the Single Obligor Limit');
    }
  });

  it('Cash-backed: ≥110% cash deposit cover selects the cash-backed matrix and its higher limits', async () => {
    const r = await toApproval({
      beforeAnalysis: async (facilityId) => {
        const c = await staff.analyst!.post(`/api/facilities/${facilityId}/collateral`, { typeKey: 'CASH_DEPOSIT', ownerName: 'ABC Manufacturing Ltd', description: 'Lien on a term deposit with Alternative Bank (DEMO)', marketValueMinor: 170_000_000_00, valuationDate: '2026-11-01', valuationSource: 'Core banking balance (DEMO)', perfectionStatus: 'PERFECTED' });
        expect(c.status, JSON.stringify(c.body)).toBe(201);
      },
    });
    expect(r.matrixTitle).toMatch(/cash-backed direct/i);
    expect(r.explanation).toMatch(/Authority matrix: Approval authority — cash-backed direct facilities/);
    expect(r.explanation).not.toMatch(/PEP:|INSIDER_RELATED:|SOL_BREACH:/);
    // Same request and exposure that needs more senior approval under the standard matrix stays with HCR here
    const amount = Number(/Authority amount ₦([\d,]+)/.exec(r.explanation)![1]!.replace(/,/g, '')) * 100;
    const standard = (await q(db(), `SELECT payload FROM config_item WHERE kind='approval_authority' AND key='APPROVED_LINE_DIRECT' AND status='ACTIVE' ORDER BY version DESC LIMIT 1`))[0].payload;
    expect(standard.levels.find((l: any) => l.code === 'HCR').limitMinor).toBeLessThan(amount);
    const final = r.levels.at(-1);
    expect(final.key).toBe('HCR');
    expect(final.level.effectiveLimitMinor).toBe(r.matrix.levels.find((l: any) => l.code === 'HCR').limitMinor);
    expect(final.level.effectiveLimitMinor).toBeGreaterThanOrEqual(amount);
    expect(r.keys).not.toContain('BOARD');
  });
});
