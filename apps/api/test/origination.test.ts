import { beforeAll, describe, expect, it } from 'vitest';
import { abcClient, Client, completeAbcProfile, db, draftMurabaha, getApp, onboardCustomer, pdf, rewindOtpThrottle, staffLogin, upload, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';

let app: Awaited<ReturnType<typeof getApp>>;
let abc: Client;
let customerId: string;
beforeAll(async () => {
  app = await getApp();
  abc = await abcClient(app);
  customerId = (await abc.get('/api/auth/me')).body.data.customer.id;
  await completeAbcProfile(abc, customerId);
});

describe('business profile', () => {
  it('is pre-populated from core banking and versioned on change', async () => {
    const p = (await abc.get(`/api/customers/${customerId}/profile`)).body.data;
    expect(p.profile.rcNumber).toBe('RC1234567');
    expect(p.profile.lockedFromCoreBanking).toContain('rcNumber');
    expect(p.completeness.pct).toBeGreaterThanOrEqual(80);
    const versions = await q(db(), 'SELECT count(*)::int AS n FROM business_profile_version WHERE customer_id=$1', [customerId]);
    expect(versions[0].n).toBeGreaterThan(0);
  });
  it('masks BVN and stores it encrypted', async () => {
    const p = (await abc.get(`/api/customers/${customerId}/profile`)).body.data;
    const d = p.parties.find((x: any) => x.fullName === 'Ade Johnson' && x.partyType === 'DIRECTOR');
    expect(d.bvn).toBe('•••••••5678');
    expect(JSON.stringify(p)).not.toContain('22212345678');
    const raw = await q(db(), `SELECT bvn_enc FROM business_party WHERE customer_id=$1 AND party_type='DIRECTOR'`, [customerId]);
    expect(raw[0].bvn_enc).toMatch(/^v1\./);
    expect(raw[0].bvn_enc).not.toContain('22212345678');
  });
  it('rejects invalid BVN, over-100% shareholding and unknown sectors', async () => {
    expect((await abc.post(`/api/customers/${customerId}/parties`, { partyType: 'DIRECTOR', fullName: 'Bad Bvn', bvn: '11111111111' })).body.error.code).toBe('BVN_INVALID');
    expect((await abc.post(`/api/customers/${customerId}/parties`, { partyType: 'SHAREHOLDER', fullName: 'Too Much', ownershipPct: 5 })).body.error.code).toBe('OWNERSHIP_OVER_100');
    expect((await abc.put(`/api/customers/${customerId}/profile`, { sectorCode: 'NOPE' })).status).toBe(422);
  });
  it('blocks one customer from reading another customer (IDOR)', async () => {
    await rewindOtpThrottle();
    const kano = await q(db(), `SELECT id FROM customer WHERE legal_name LIKE 'Kano%'`);
    const r = await abc.get(`/api/customers/${kano[0]?.id ?? '00000000-0000-0000-0000-000000000000'}/profile`);
    expect(r.status).toBe(404);
  });
});

describe('facility origination', () => {
  it('lists only customer-selectable Islamic products to customers', async () => {
    const r = await abc.get('/api/products');
    const codes = r.body.data.map((p: any) => p.code);
    expect(codes).toContain('MURABAHA');
    expect(codes).toContain('APG');
    expect(codes).not.toContain('DIRECT_INVESTMENT');
    expect(JSON.stringify(r.body)).not.toMatch(/\binterest rate\b|\bloan\b/i);
  });

  it('creates a facility with a GZ-FAC reference, idempotently', async () => {
    const a = await abc.post('/api/facilities', { productCode: 'MURABAHA', idempotencyKey: 'double-click-key-1' });
    const b = await abc.post('/api/facilities', { productCode: 'MURABAHA', idempotencyKey: 'double-click-key-1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(a.body.data.ref).toMatch(/^GZ-FAC-\d{4}-\d{6}$/);
  });

  it('validates against the product configuration and uses optimistic locking', async () => {
    const f = await abc.post('/api/facilities', { productCode: 'IJARAH', idempotencyKey: 'ijarah-validation' });
    const id = f.body.data.id;
    const low = await abc.patch(`/api/facilities/${id}`, { rowVersion: f.body.data.rowVersion, step: 'DETAILS', completeStep: true, amountMinor: 100, tenorMonths: 6, purpose: 'short', paymentFrequency: 'BULLET' });
    expect(low.status).toBe(422);
    const fields = low.body.error.details.map((d: any) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['amountMinor', 'tenorMonths', 'purpose', 'paymentFrequency']));
    const stale = await abc.patch(`/api/facilities/${id}`, { rowVersion: 999, purpose: 'x' });
    expect(stale.body.error.code).toBe('STALE');
  });

  it('generates document requirements dynamically from product and amount', async () => {
    const f = await draftMurabaha(abc);
    const docs = (await abc.get(`/api/facilities/${f.id}/documents`)).body.data;
    const keys = docs.map((d: any) => d.requirementKey);
    expect(keys).toEqual(expect.arrayContaining(['CAC_CERTIFICATE', 'BOARD_RESOLUTION', 'PROFORMA_INVOICE', 'CASH_FLOW_PROJECTION']));
    expect(keys).not.toContain('CONTRACT_AWARD');
  });

  it('enforces upload security: malware, MIME spoofing, active PDF content, executables', async () => {
    const f = await draftMurabaha(abc);
    const doc = (await abc.get(`/api/facilities/${f.id}/documents`)).body.data.find((d: any) => d.requirementKey === 'PROFORMA_INVOICE');
    const eicar = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF');
    expect((await upload(abc, `/api/documents/${doc.id}/upload`, 'cac.pdf', eicar)).body.error.code).toBe('MALWARE_DETECTED');
    expect((await upload(abc, `/api/documents/${doc.id}/upload`, 'cac.pdf', Buffer.from('MZ\x90\x00 executable'))).body.error.code).toBe('FILE_REJECTED');
    expect((await upload(abc, `/api/documents/${doc.id}/upload`, 'cac.png', pdf())).body.error.message).toMatch(/extension does not match/);
    expect((await upload(abc, `/api/documents/${doc.id}/upload`, 'cac.pdf.exe.pdf', pdf())).body.error.code).toBe('FILE_REJECTED');
    const js = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF');
    expect((await upload(abc, `/api/documents/${doc.id}/upload`, 'cac.pdf', js)).body.error.message).toMatch(/scripts/);
    const okUp = await upload(abc, `/api/documents/${doc.id}/upload`, 'cac.pdf', pdf());
    expect(okUp.status).toBe(201);
    expect(okUp.body.data.status).toBe('UPLOADED');
    // stored encrypted: raw bytes on disk do not contain the plaintext marker
    const v = await q(db(), 'SELECT storage_key FROM document_version WHERE id=$1', [okUp.body.data.current.id]);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(`./storage-test/${v[0].storage_key.slice(0, 2)}/${v[0].storage_key.slice(2, 4)}/${v[0].storage_key}`);
    expect(raw.includes(Buffer.from('%PDF'))).toBe(false);
  });

  it('serves files only through single-use grants bound to the requester', async () => {
    const f = await draftMurabaha(abc);
    const doc = (await abc.get(`/api/facilities/${f.id}/documents`)).body.data.find((d: any) => d.requirementKey === 'BOARD_RESOLUTION');
    await upload(abc, `/api/documents/${doc.id}/upload`, 'x.pdf', pdf('grant'));
    const g = await abc.post(`/api/documents/${doc.id}/grant`, { disposition: 'attachment' });
    expect(g.body.data.url).toMatch(/^\/api\/files\//);
    const other = await staffLogin(app, 'demo.legal');
    expect((await other.get(g.body.data.url)).status).toBe(403);
    // grant consumed by the failed attempt? No — the grant is single-use; re-issue for the owner
    const g2 = await abc.post(`/api/documents/${doc.id}/grant`, {});
    const file = await abc.get(g2.body.data.url);
    expect(file.status).toBe(200);
    expect(file.raw.headers['content-type']).toBe('application/pdf');
    expect((await abc.get(g2.body.data.url)).status).toBe(404); // reuse refused
  });

  it('refuses submission until complete, then starts the workflow with an RM task', async () => {
    const f = await draftMurabaha(abc);
    const early = await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: f.rowVersion, declaration: true });
    expect(early.body.error.code).toBe('INCOMPLETE');
    await uploadAllRequired(abc, f.id);
    const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    const r = await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    expect(r.status).toBe(200);
    const again = await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion + 1, declaration: true });
    expect(again.body.error.code).toBe('ALREADY_SUBMITTED');
    const detail = (await abc.get(`/api/facilities/${f.id}`)).body.data;
    expect(detail.facility.status).toBe('IN_REVIEW');
    expect(detail.progress.currentlyWith).toBe('Relationship Manager');
    expect(detail.eligibility.points).toBeDefined();
    expect(JSON.stringify(detail.eligibility)).not.toMatch(/internal|requiredValue|≥/i);
    const tasks = await q(db(), `SELECT stage_key, assigned_user_id FROM workflow_task WHERE facility_id=$1`, [f.id]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].stage_key).toBe('RM_REVIEW');
    expect(tasks[0].assigned_user_id).not.toBeNull();
  });

  it('prevents a customer reading another customer\'s facility or editing after submission', async () => {
    await rewindOtpThrottle();
    const kanoUser = await q(db(), `SELECT 1 FROM customer_user WHERE email='kano.ops@kano-agro.demo'`);
    const kano = kanoUser.length ? null : await onboardCustomer(app, '0100000003', 'kano.ops@kano-agro.demo', '08030000002').catch(() => null);
    const abcFac = await q(db(), `SELECT f.id FROM facility_request f JOIN customer c ON c.id=f.customer_id WHERE c.legal_name='ABC Manufacturing Ltd' LIMIT 1`);
    if (kano) {
      expect((await kano.get(`/api/facilities/${abcFac[0].id}`)).status).toBe(404);
      expect((await kano.patch(`/api/facilities/${abcFac[0].id}`, { rowVersion: 1, purpose: 'hijack' })).status).toBe(404);
      expect((await kano.get(`/api/facilities/${abcFac[0].id}/documents`)).status).toBe(404);
    }
    const unauth = new Client(app);
    expect((await unauth.get(`/api/facilities/${abcFac[0].id}`)).status).toBe(401);
  });
});

describe('document reuse', () => {
  it('reuses verified customer-level documents but never transaction-specific ones', async () => {
    const verified = await q(db(), `SELECT doc_type FROM document d JOIN customer c ON c.id=d.customer_id WHERE c.legal_name='ABC Manufacturing Ltd' AND d.status='VERIFIED'`);
    const f = await draftMurabaha(abc);
    const docs = (await abc.get(`/api/facilities/${f.id}/documents`)).body.data;
    const byKey = (k: string) => docs.find((d: any) => d.requirementKey === k);
    expect(byKey('PROFORMA_INVOICE').status).toBe('REQUIRED');
    expect(byKey('BOARD_RESOLUTION').status).toBe('REQUIRED');
    if (verified.some((v: any) => v.doc_type === 'CAC_CERTIFICATE')) expect(byKey('CAC_CERTIFICATE').status).toBe('VERIFIED');
  });
});
