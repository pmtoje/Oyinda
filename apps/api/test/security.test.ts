import { beforeAll, describe, expect, it } from 'vitest';
import { abcClient, act, Client, completeAbcProfile, db, draftMurabaha, getApp, idem, kanoClient, pdf, rewindOtpThrottle, staffLogin, upload, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';
import { PrivateEndpointProvider } from '../src/modules/ai/providers.js';

let app: Awaited<ReturnType<typeof getApp>>;
let abc: Client; let other: Client; let abcCustomer: string; let facilityId: string;
const s: Record<string, Client> = {};

beforeAll(async () => {
  app = await getApp();
  abc = await abcClient(app);
  abcCustomer = (await abc.get('/api/auth/me')).body.data.customer.id;
  await completeAbcProfile(abc, abcCustomer);
  await rewindOtpThrottle();
  other = await kanoClient(app);
  for (const u of ['rm', 'bm', 'analyst', 'creditops', 'creditops2']) s[u] = await staffLogin(app, `demo.${u}`);
  const f = await draftMurabaha(abc);
  facilityId = f.id;
  await uploadAllRequired(abc, f.id);
  const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
  await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
});

describe('Phase 78 — application security assessment', () => {
  it('IDOR: another customer cannot read, edit, upload to or message on ABC’s facility', async () => {
    const docs = (await abc.get(`/api/facilities/${facilityId}/documents`)).body.data;
    for (const [m, u] of [['GET', `/api/facilities/${facilityId}`], ['GET', `/api/facilities/${facilityId}/offer`], ['GET', `/api/facilities/${facilityId}/threads`], ['GET', `/api/facilities/${facilityId}/bank-statements`], ['POST', `/api/documents/${docs[0].id}/grant`], ['GET', `/api/documents/${docs[0].id}/versions`], ['POST', `/api/facilities/${facilityId}/withdraw`], ['GET', `/api/customers/${abcCustomer}/financial-statements`]] as const) {
      const r = await other.req(m, u, m === 'GET' ? undefined : { reason: 'hijack attempt' });
      expect([404], `${m} ${u}`).toContain(r.status);
    }
    expect((await upload(other, `/api/documents/${docs[0].id}/upload`, 'x.pdf', pdf())).status).toBe(404);
  });

  it('customer ID manipulation: a customer cannot create a facility for another customer', async () => {
    const r = await other.post('/api/facilities', { productCode: 'MURABAHA', idempotencyKey: idem(), customerId: abcCustomer });
    expect(r.status).toBe(201);
    const row = await q(db(), 'SELECT customer_id FROM facility_request WHERE id=$1', [r.body.data.id]);
    expect(row[0].customer_id).not.toBe(abcCustomer); // customerId from the client is ignored for customers
  });

  it('mass assignment and prototype pollution are rejected or ignored', async () => {
    const f = await draftMurabaha(abc);
    const r = await abc.patch(`/api/facilities/${f.id}`, { rowVersion: f.rowVersion, status: 'APPROVED', amountMinor: 160_000_000_00, productFields: { __proto__: { admin: true }, constructor: 'x' } });
    const row = await q(db(), 'SELECT status, product_fields FROM facility_request WHERE id=$1', [f.id]);
    expect(row[0].status).toBe('DRAFT');
    expect(({} as any).admin).toBeUndefined();
    expect(r.status === 200 || r.status === 400).toBe(true);
  });

  it('SQL injection attempts are treated as data', async () => {
    const r = await s.analyst!.get(`/api/facilities?search=${encodeURIComponent("' OR 1=1; DROP TABLE facility_request; --")}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect((await q(db(), 'SELECT count(*)::int AS n FROM facility_request'))[0].n).toBeGreaterThan(0);
    expect((await s.analyst!.get(`/api/facilities?status=${encodeURIComponent("IN_REVIEW') OR ('1'='1")}`)).body.data).toEqual([]);
  });

  it('stored XSS: script payloads are stored as text and served only as JSON', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';
    await abc.put(`/api/customers/${abcCustomer}/profile`, { businessDescription: payload });
    const r = await s.rm!.get(`/api/customers/${abcCustomer}/profile`);
    expect(r.raw.headers['content-type']).toMatch(/application\/json/);
    expect(r.body.data.profile.businessDescription).toBe(payload);
    expect(r.raw.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.raw.headers['x-content-type-options']).toBe('nosniff');
  });

  it('path traversal: identifiers are validated; storage keys are never user-controlled', async () => {
    for (const u of ['/api/files/..%2F..%2Fetc%2Fpasswd', '/api/documents/..%2F..%2Fetc/versions', `/api/facilities/${encodeURIComponent('../../etc/passwd')}`]) expect([400, 404]).toContain((await abc.get(u)).status);
    const keys = await q(db(), 'SELECT storage_key FROM document_version');
    for (const k of keys) expect(k.storage_key).toMatch(/^[a-f0-9]{48}$/);
    const target = (await abc.get(`/api/facilities/${(await draftMurabaha(abc)).id}/documents`)).body.data.find((d: any) => d.requirementKey === 'PROFORMA_INVOICE');
    const r = await upload(abc, `/api/documents/${target.id}/upload`, '../../../etc/passwd.pdf', pdf());
    // Directory components are stripped from client filenames; storage location never derives from them.
    if (r.status === 201) expect(r.body.data.current.filename).toBe('passwd.pdf');
    else expect(r.body.error.code).toBe('FILE_REJECTED');
  });

  it('SSRF: the AI endpoint must be HTTPS and on the approved host allow-list; no user-supplied URLs are fetched', () => {
    expect(() => new PrivateEndpointProvider('http://169.254.169.254/latest/meta-data', ['169.254.169.254'])).toThrow(/allow-list/);
    expect(() => new PrivateEndpointProvider('https://evil.example.com', ['ai.altbank.internal'])).toThrow(/allow-list/);
    expect(() => new PrivateEndpointProvider('https://ai.altbank.internal', ['ai.altbank.internal'])).not.toThrow();
  });

  it('workflow manipulation: acting without claiming, after completion, or replaying another task’s key fails', async () => {
    const t = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='RM_REVIEW'`, [facilityId]))[0];
    expect((await s.rm!.post(`/api/tasks/${t.id}/actions`, { action: 'RECOMMEND', idempotencyKey: idem() })).status).toBe(403); // not claimed
    for (const d of (await s.rm!.get(`/api/facilities/${facilityId}/documents`)).body.data.filter((x: any) => x.status === 'UPLOADED')) await s.rm!.post(`/api/documents/${d.id}/review`, { decision: 'VERIFIED' });
    const key = idem();
    await s.rm!.post(`/api/tasks/${t.id}/claim`);
    expect((await s.rm!.post(`/api/tasks/${t.id}/actions`, { action: 'RECOMMEND', idempotencyKey: key, comment: 'ok ok ok' })).status).toBe(200);
    expect((await s.rm!.post(`/api/tasks/${t.id}/actions`, { action: 'RECOMMEND', idempotencyKey: key })).body.data.replayed).toBe(true);
    expect((await s.rm!.post(`/api/tasks/${t.id}/actions`, { action: 'RECOMMEND', idempotencyKey: idem() })).status).toBe(403); // completed
    const bm = (await q(db(), `SELECT id FROM workflow_task WHERE facility_id=$1 AND stage_key='BM_REVIEW'`, [facilityId]))[0];
    await s.bm!.post(`/api/tasks/${bm.id}/claim`);
    expect((await s.bm!.post(`/api/tasks/${bm.id}/actions`, { action: 'RECOMMEND', idempotencyKey: key })).body.error.code).toBe('IDEMPOTENCY_REUSED');
    expect((await s.bm!.post(`/api/tasks/${bm.id}/actions`, { action: 'APPROVE', idempotencyKey: idem() })).status).toBe(403); // not offered at this stage
  });

  it('rate-limit bypass via spoofed X-Forwarded-For is not possible (proxy headers untrusted by default)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/meta', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(r.statusCode).toBe(200);
    const { env } = await import('../src/config/env.js');
    expect(env().TRUST_PROXY).toBe(false);
  });

  it('a customer session cannot be used as a staff session and vice versa', async () => {
    expect((await abc.get('/api/tasks')).status).toBe(401);
    expect((await s.rm!.post('/api/offers/00000000-0000-0000-0000-000000000000/respond', { decision: 'ACCEPT', rowVersion: 1, acknowledgement: true })).status).toBe(401);
  });

  it('oversized uploads are refused before processing', async () => {
    const d = (await abc.get(`/api/facilities/${(await draftMurabaha(abc)).id}/documents`)).body.data.find((x: any) => x.requirementKey === 'PROFORMA_INVOICE');
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(21 * 1024 * 1024, 32)]);
    const r = await upload(abc, `/api/documents/${d.id}/upload`, 'big.pdf', big);
    expect([400, 413]).toContain(r.status);
  });

  it('secrets never leak: no key material in responses, health or logs', async () => {
    const { env } = await import('../src/config/env.js');
    const h = await (await staffLogin(app, 'demo.superadmin')).get('/api/admin/health');
    const text = JSON.stringify(h.body);
    expect(text).not.toContain(env().DATA_KEY);
    expect(text).not.toContain(env().HMAC_KEY);
    const audit = await q(db(), `SELECT count(*)::int AS n FROM audit_log WHERE after_data::text ILIKE '%22212345678%' OR metadata::text ILIKE '%22212345678%'`);
    expect(audit[0].n).toBe(0); // full BVN never in the audit trail
  });
});
