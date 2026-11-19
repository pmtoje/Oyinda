import type { Db } from '../db/pool.js';
import { q } from '../db/pool.js';
import { env } from '../config/env.js';

/**
 * DEMO / NON-PRODUCTION business data, created by driving the real API in-process so every record
 * passes the same validation, workflow and audit rules as live usage.
 *
 *  - ABC Manufacturing Ltd (onboarded) with:
 *      Murabaha ₦150m — with Credit Analysis (Manufacturing is outside the HEART/E&S sectors)
 *      Ijarah ₦60m   — draft, partially completed by the customer
 *      APG ₦45m      — fully assessed; approved by the MD (₦45m + outstanding exposure); offer issued, awaiting the customer
 *  - Kano Agro-Allied Processing Ltd is left un-onboarded so the onboarding journey can be demonstrated.
 */
export async function seedDemoData(db: Db): Promise<void> {
  if (env().APP_ENV === 'production') throw new Error('Demo data must never be loaded in production');
  if ((await q(db, `SELECT 1 FROM customer WHERE legal_name='ABC Manufacturing Ltd'`)).length) { console.log('demo data already present'); return; }
  if (!process.env.MOCK_AD_DEMO_PASSWORD) throw new Error('MOCK_AD_DEMO_PASSWORD must be set to seed demo data');
  // The in-process demo driver signs in many DEMO staff from one address; lift the sign-in rate limit for this
  // non-production seeding run only (the API it builds below reads the limit at start-up).
  (env() as any).AUTH_RATE_LIMIT_PER_15MIN = Math.max(env().AUTH_RATE_LIMIT_PER_15MIN, 1000);
  const h = await import('../../test/helpers.js');
  const { DEMO_PASSWORD: _unused } = h; void _unused;
  const app = await h.getApp();
  const staff = async (u: string) => {
    // demo sign-in through the real AD (mock) + TOTP flow
    const c = new h.Client(app);
    const r = await c.post('/api/auth/staff/login', { username: u, password: process.env.MOCK_AD_DEMO_PASSWORD });
    const { decryptField } = await import('../lib/crypto.js');
    const { hotp, totpStep } = await import('../modules/identity/totp.js');
    const secret = r.body.data.mfa === 'ENROL' ? r.body.data.enrolment.secret : decryptField((await q<any>(db, 'SELECT mfa_secret_enc FROM app_user WHERE ad_username=$1', [u]))[0].mfa_secret_enc);
    await q(db, 'UPDATE app_user SET mfa_last_step=NULL WHERE ad_username=$1', [u]);
    const m = await c.post('/api/auth/staff/mfa/verify', { code: hotp(secret, totpStep()) });
    if (m.status !== 200) throw new Error(`demo login failed for ${u}`);
    return c;
  };
  const step = (m: string) => process.env.GZ_SEED_TRACE && console.log('seed:', m);
  const must = (r: any, label: string) => { step(label); if (r.status >= 300) throw new Error(`${label}: ${JSON.stringify(r.body)}`); return r; };

  step('onboarding');
  await h.rewindOtpThrottle();
  const abc = await h.onboardCustomer(app, '0100000001', 'treasury@abc-manufacturing.demo', '08030000001');
  const customerId = (await abc.get('/api/auth/me')).body.data.customer.id;
  await h.completeAbcProfile(abc, customerId);
  await q(db, `INSERT INTO fx_rate(base_ccy, quote_ccy, rate, rate_date, source) VALUES ('USD','NGN',1520.50,'2025-10-31','CBN NAFEM closing (DEMO)') ON CONFLICT DO NOTHING`);
  step('staff logins');
  const s = Object.fromEntries(await Promise.all(['rm', 'bm', 'rbe', 'dh', 'analyst', 'es', 'ctl', 'ghcr', 'cro', 'ed', 'ed2', 'md', 'creditops', 'creditops2'].map(async (u) => [u, await staff(`demo.${u}`)])));
  const submit = async (id: string) => { const cur = (await abc.get(`/api/facilities/${id}`)).body.data.facility; must(await abc.post(`/api/facilities/${id}/submit`, { rowVersion: cur.rowVersion, declaration: true }), 'submit'); };
  const verifyDocs = async (id: string) => { for (const d of (await s.rm.get(`/api/facilities/${id}/documents`)).body.data.filter((x: any) => x.status === 'UPLOADED')) await s.rm.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' }); };

  // 1. Murabaha ₦150m — waiting with Credit Analysis
  const mur = await h.draftMurabaha(abc, { idem: 'demo-murabaha-150m' });
  await h.uploadAllRequired(abc, mur.id);
  await submit(mur.id);
  await verifyDocs(mur.id);
  must(await h.act(s.rm, mur.id, 'RM_REVIEW', 'RECOMMEND', { comment: 'Long-standing customer with strong account conduct; request is consistent with seasonal resin purchases.' }), 'rm');
  must(await h.act(s.bm, mur.id, 'BM_REVIEW', 'RECOMMEND', { comment: 'Concur with RM. Domiciliation of bottling receivables confirmed.' }), 'bm');
  must(await h.act(s.rbe, mur.id, 'RBE_REVIEW', 'RECOMMEND', { comment: 'Supported; within the region’s risk appetite for packaging manufacturers.' }), 'rbe');
  must(await h.act(s.dh, mur.id, 'DH_REVIEW', 'RECOMMEND', { comment: 'Supported for credit analysis.' }), 'dh');

  // 2. Ijarah ₦60m — draft in progress
  const ij = must(await abc.post('/api/facilities', { productCode: 'IJARAH', idempotencyKey: 'demo-ijarah-60m' }), 'ijarah');
  must(await abc.patch(`/api/facilities/${ij.body.data.id}`, { rowVersion: ij.body.data.rowVersion, step: 'DETAILS', completeStep: true, amountMinor: 60_000_000_00, tenorMonths: 36, purpose: 'Lease of ten delivery trucks to expand distribution in the South-West', paymentFrequency: 'MONTHLY', sourceOfPayment: 'Distribution revenue domiciled with Alternative Bank' }), 'ijarah details');

  // 3. APG ₦45m — fully assessed, approved by the MD, offer issued
  const apg = must(await abc.post('/api/facilities', { productCode: 'APG', idempotencyKey: 'demo-apg-45m' }), 'apg');
  const aid = apg.body.data.id;
  let rv = apg.body.data.rowVersion;
  rv = must(await abc.patch(`/api/facilities/${aid}`, { rowVersion: rv, step: 'DETAILS', completeStep: true, amountMinor: 45_000_000_00, tenorMonths: 12, purpose: 'Advance payment guarantee in favour of Lagos State Water Corporation for a bottling-line supply contract', paymentFrequency: 'BULLET' }), 'apg d').body.data.rowVersion;
  rv = must(await abc.patch(`/api/facilities/${aid}`, { rowVersion: rv, step: 'PRODUCT_INFO', completeStep: true, productFields: { beneficiary: 'Lagos State Water Corporation (DEMO)', contractReference: 'LSWC/PROC/2026/044', contractValueMinor: 150_000_000_00, expiryDate: '2027-11-30' } }), 'apg p').body.data.rowVersion;
  must(await abc.patch(`/api/facilities/${aid}`, { rowVersion: rv, step: 'SECURITY', completeStep: true, proposedSecurity: 'Counter-indemnity and 30% cash deposit under lien' }), 'apg s');
  await h.uploadAllRequired(abc, aid);
  await submit(aid);
  await verifyDocs(aid);
  must(await h.act(s.rm, aid, 'RM_REVIEW', 'RECOMMEND'), 'apg rm');
  for (const [u, k] of [['bm', 'BM_REVIEW'], ['rbe', 'RBE_REVIEW'], ['dh', 'DH_REVIEW']] as const) must(await h.act(s[u], aid, k, 'RECOMMEND'), `apg ${k}`);
  const t = (await q<any>(db, `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='CREDIT_ANALYSIS'`, [aid]))[0];
  await s.analyst.post(`/api/tasks/${t.id}/claim`);
  await h.performCreditAnalysis(s.analyst, aid, customerId, { rate: 2 });
  must(await h.act(s.analyst, aid, 'CREDIT_ANALYSIS', 'COMPLETE'), 'apg analysis');
  // ₦45m request + ₦240m outstanding = ₦285m: HCR → CRO → Line ED → ED concurrence → MD (PRD grid, non-cash-backed contingent)
  for (const [u, k] of [['ctl', 'CTL_REVIEW'], ['ghcr', 'HCR'], ['cro', 'CRO'], ['ed', 'ED'], ['ed2', 'ED_CONCURRENCE']] as const) must(await h.act(s[u], aid, k, 'RECOMMEND'), k);
  must(await h.act(s.md, aid, 'MD', 'APPROVE', { comment: 'Approved. Contract award verified; cash cover and counter-indemnity adequate.', conditions: ['Lien on 30% cash deposit before issuance'] }), 'md');
  must(await s.creditops.post(`/api/facilities/${aid}/offer`), 'offer');
  const off = (await s.creditops.get(`/api/facilities/${aid}/offer`)).body.data.offers[0];
  must(await s.creditops2.post(`/api/offers/${off.id}/check`, { decision: 'ISSUE' }), 'issue');
  console.log('DEMO data: ABC Manufacturing Ltd with Murabaha (in review), Ijarah (draft), APG (offer issued)');
}
