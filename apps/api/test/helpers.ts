import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { getPool, q, tx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedBaseline, seedDemoUsers } from '../src/seed/seed.js';
import { decryptField } from '../src/lib/crypto.js';
import { hotp, totpStep } from '../src/modules/identity/totp.js';

let app: FastifyInstance | undefined;
let prepared = false;

export async function getApp() {
  if (!prepared) {
    await migrate(() => undefined);
    await tx((c) => seedBaseline(c));
    await tx((c) => seedDemoUsers(c));
    prepared = true;
  }
  app ??= await buildApp({ logger: false });
  return app;
}

export const db = () => getPool();

/** A cookie-jar HTTP client that also carries the CSRF token, like the SPA does. */
export class Client {
  cookies = new Map<string, string>();
  csrf?: string;
  constructor(private a: FastifyInstance) {}
  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    if (body !== undefined && !(body instanceof Buffer)) headers['content-type'] = 'application/json';
    const res = await this.a.inject({ method: method as any, url, headers, payload: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body) });
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && new Date(c.expires) < new Date())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let json: any;
    try { json = res.json(); } catch { json = undefined; }
    if (json?.data?.csrfToken) this.csrf = json.data.csrfToken;
    return { status: res.statusCode, body: json, raw: res };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown, h?: Record<string, string>) => this.req('POST', u, b ?? {}, h);
  put = (u: string, b?: unknown) => this.req('PUT', u, b ?? {});
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b ?? {});
  del = (u: string) => this.req('DELETE', u);
}

/** Reads the latest message from the MOCK outbox (test-only — the API never returns OTPs). */
export async function lastOtp(destination: string): Promise<string> {
  const rows = await q<{ body: string }>(db(), 'SELECT body FROM mock_outbox WHERE destination=$1 ORDER BY id DESC LIMIT 1', [destination]);
  const m = /code is (\d{6})/.exec(rows[0]?.body ?? '');
  if (!m) throw new Error(`No OTP found for ${destination}`);
  return m[1]!;
}

export const DEMO_PASSWORD = 'test-demo-password-1234';

/** Full staff sign-in including TOTP enrolment on first use. */
export async function staffLogin(a: FastifyInstance, username: string): Promise<Client> {
  const c = new Client(a);
  const r = await c.post('/api/auth/staff/login', { username, password: DEMO_PASSWORD });
  if (r.status !== 200) throw new Error(`staff login failed for ${username}: ${JSON.stringify(r.body)}`);
  const secret = r.body.data.mfa === 'ENROL'
    ? r.body.data.enrolment.secret
    : decryptField((await q<{ mfa_secret_enc: string }>(db(), 'SELECT mfa_secret_enc FROM app_user WHERE ad_username=$1', [username]))[0]!.mfa_secret_enc);
  const last = (await q<{ mfa_last_step: number | null }>(db(), 'SELECT mfa_last_step FROM app_user WHERE ad_username=$1', [username]))[0]!.mfa_last_step;
  // Use the next unused step so repeated logins inside one 30s window do not trip replay protection.
  const step = last !== null && last >= totpStep() ? last + 1 : totpStep();
  const m = await c.post('/api/auth/staff/mfa/verify', { code: hotp(secret, step) });
  if (m.status !== 200) throw new Error(`MFA failed for ${username}: ${JSON.stringify(m.body)}`);
  return c;
}

/** Onboard a demo customer account through the real onboarding journey. */
export async function onboardCustomer(a: FastifyInstance, accountNumber: string, email: string, phone: string): Promise<Client> {
  const c = new Client(a);
  const s = await c.post('/api/onboarding/start', { accountNumber });
  if (s.status !== 200) throw new Error(`onboarding start failed: ${JSON.stringify(s.body)}`);
  const v = await c.post('/api/onboarding/verify-otp', { code: await lastOtp(phone) });
  if (v.status !== 200) throw new Error(`onboarding verify failed: ${JSON.stringify(v.body)}`);
  const done = await c.post('/api/onboarding/complete', { fullName: 'Demo Treasurer', email, designation: 'Group Treasurer', acceptTerms: true, privacyConsent: true, termsVersion: v.body.data.terms.version });
  if (done.status !== 201) throw new Error(`onboarding complete failed: ${JSON.stringify(done.body)}`);
  const ev = await c.post('/api/auth/customer/email/verify', { challengeId: done.body.data.emailVerificationChallengeId, code: await lastOtp(email) });
  if (ev.status !== 200) throw new Error(`email verify failed: ${JSON.stringify(ev.body)}`);
  return c;
}

/** Rewind the OTP send throttle so tests can request codes back-to-back. */
export async function rewindOtpThrottle() {
  await q(db(), `UPDATE otp_challenge SET created_at = created_at - interval '1 hour'`);
}

/** Multipart upload through the real HTTP stack. */
export async function upload(c: Client, url: string, filename: string, content: Buffer, mime = 'application/pdf', fields: Record<string, string> = {}) {
  const boundary = '----gazelle' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return c.req('POST', url, Buffer.concat(parts), { 'content-type': `multipart/form-data; boundary=${boundary}` });
}

export const pdf = (text = 'Gazelle test document') => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text} ${Math.random()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

export const ABC = { account: '0100000001', phone: '08030000001' };

/** Onboard ABC (once) and return a signed-in client. */
export async function abcClient(a: FastifyInstance): Promise<Client> {
  const existing = await q(db(), `SELECT 1 FROM customer_user WHERE email='treasury.lead@abc-manufacturing.demo'`);
  await rewindOtpThrottle();
  if (!existing.length) return onboardCustomer(a, ABC.account, 'treasury.lead@abc-manufacturing.demo', ABC.phone);
  const c = new Client(a);
  const s = await c.post('/api/auth/customer/login/start', { email: 'treasury.lead@abc-manufacturing.demo' });
  const r = await c.post('/api/auth/customer/login/verify', { email: 'treasury.lead@abc-manufacturing.demo', challengeId: s.body.data.challengeId, code: await lastOtp(ABC.phone) });
  if (r.status !== 200) throw new Error('ABC login failed ' + JSON.stringify(r.body));
  return c;
}

/** Complete ABC's profile to a realistic standard. */
export async function completeAbcProfile(c: Client, customerId: string) {
  await c.put(`/api/customers/${customerId}/profile`, { businessType: 'LIMITED_LIABILITY', sectorCode: 'MANUFACTURING', industry: 'Packaging & plastics', businessDescription: 'Manufacturer of rigid plastic packaging for food and beverage producers in West Africa.', productsServices: 'PET preforms, HDPE bottles, closures', valueChain: 'Imports resin; supplies bottlers in Lagos and Ogun', geographicFootprint: 'Lagos, Ogun, Kano', employeeCount: 420, hasLitigation: false, hasRegulatoryMatters: false });
  const parties = (await c.get(`/api/customers/${customerId}/profile`)).body.data.parties;
  if (!parties.length) {
    await c.post(`/api/customers/${customerId}/parties`, { partyType: 'DIRECTOR', fullName: 'Ade Johnson', designation: 'Managing Director', bvn: '22212345678', yearsExperience: 22 });
    await c.post(`/api/customers/${customerId}/parties`, { partyType: 'SHAREHOLDER', fullName: 'Ade Johnson', ownershipPct: 60, bvn: '22212345678' });
    await c.post(`/api/customers/${customerId}/parties`, { partyType: 'SHAREHOLDER', entityKind: 'CORPORATE', fullName: 'Johnson Holdings Ltd', ownershipPct: 40 });
    await c.post(`/api/customers/${customerId}/parties`, { partyType: 'KEY_EXECUTIVE', fullName: 'Ngozi Peters', designation: 'Chief Financial Officer', yearsExperience: 15 });
  }
}

/** Create and fill a Murabaha request (₦150m, 36 months) up to document upload. */
export async function draftMurabaha(c: Client, opts: { amountMinor?: number; idem?: string } = {}) {
  const f = await c.post('/api/facilities', { productCode: 'MURABAHA', idempotencyKey: opts.idem ?? `t-${Math.random().toString(36).slice(2)}` });
  const id = f.body.data.id;
  let rv = f.body.data.rowVersion;
  const p1 = await c.patch(`/api/facilities/${id}`, { rowVersion: rv, step: 'DETAILS', completeStep: true, currency: 'NGN', amountMinor: opts.amountMinor ?? 150_000_000_00, tenorMonths: 36, purpose: 'Purchase of PET resin and moulding equipment spares', paymentFrequency: 'MONTHLY', sourceOfPayment: 'Proceeds of sales to bottling customers, domiciled to Alternative Bank', paymentStructure: 'Equal monthly instalments of cost plus profit' });
  if (p1.status !== 200) throw new Error('details ' + JSON.stringify(p1.body));
  rv = p1.body.data.rowVersion;
  const p2 = await c.patch(`/api/facilities/${id}`, { rowVersion: rv, step: 'PRODUCT_INFO', completeStep: true, supplierName: 'Resin Supplies FZE (DEMO)', underlyingAsset: '1,200 tonnes PET resin', productFields: { assetDescription: '1,200 tonnes bottle-grade PET resin', supplierQuoteRef: 'PFI-2026-118', assetCostMinor: 160_000_000_00, customerContributionMinor: 10_000_000_00, deliveryLocation: 'Ikeja, Lagos' } });
  if (p2.status !== 200) throw new Error('product ' + JSON.stringify(p2.body));
  rv = p2.body.data.rowVersion;
  const p3 = await c.patch(`/api/facilities/${id}`, { rowVersion: rv, step: 'SECURITY', completeStep: true, proposedSecurity: 'Legal mortgage over factory premises at Ikeja; domiciliation of receivables' });
  return { id, rowVersion: p3.body.data.rowVersion, ref: f.body.data.ref };
}

export async function uploadAllRequired(c: Client, facilityId: string) {
  const docs = (await c.get(`/api/facilities/${facilityId}/documents`)).body.data;
  for (const d of docs.filter((x: any) => x.mandatory && x.status === 'REQUIRED')) {
    const r = await upload(c, `/api/documents/${d.id}/upload`, `${d.docType.toLowerCase()}.pdf`, pdf(d.title));
    if (r.status !== 201) throw new Error('upload ' + JSON.stringify(r.body));
  }
  return docs;
}
