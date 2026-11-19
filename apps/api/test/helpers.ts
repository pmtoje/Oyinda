import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { getPool, q, tx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedBaseline, seedDemoUsers } from '../src/seed/baseline.js';
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
  // Test-only: simulate the passage of time between sign-ins. TOTP replay protection itself is covered by
  // dedicated tests; here many files sign the same demo users in within one 30-second window.
  await q(db(), 'UPDATE app_user SET mfa_last_step=NULL WHERE ad_username=$1', [username]);
  const step = totpStep();
  const m = await c.post('/api/auth/staff/mfa/verify', { code: hotp(secret, step) });
  if (m.status !== 200) throw new Error(`MFA failed for ${username}: ${JSON.stringify(m.body)}`);
  return c;
}

/** Test-only customer password (meets the default portal password policy). */
export const CUSTOMER_PASSWORD = 'Gazelle#Portal2026';

/** Reads the verification link from the latest welcome e-mail in the MOCK outbox. */
export async function lastLinkToken(email: string): Promise<string> {
  const rows = await q<{ body: string }>(db(), 'SELECT body FROM mock_outbox WHERE destination=$1 ORDER BY id DESC LIMIT 1', [email]);
  const m = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(rows[0]?.body ?? '');
  if (!m) throw new Error(`No verification link found for ${email}`);
  return m[1]!;
}

/**
 * Onboard a demo customer through the real SWR journey: account number + name + role → OTP to the CBA phone and e-mail →
 * password (username = CBA e-mail) → terms → welcome e-mail link. `email` must be the e-mail registered on the CBA.
 */
export async function onboardCustomer(a: FastifyInstance, accountNumber: string, email: string, phone: string): Promise<Client> {
  const c = new Client(a);
  const s = await c.post('/api/onboarding/start', { accountNumber, fullName: 'Demo Treasurer', roleInCompany: 'Group Treasurer' });
  if (s.status !== 200) throw new Error(`onboarding start failed: ${JSON.stringify(s.body)}`);
  const v = await c.post('/api/onboarding/verify-otp', { code: await lastOtp(phone) });
  if (v.status !== 200) throw new Error(`onboarding verify failed: ${JSON.stringify(v.body)}`);
  if (v.body.data.username !== email) throw new Error(`expected username ${email}, got ${v.body.data.username}`);
  const done = await c.post('/api/onboarding/complete', { password: CUSTOMER_PASSWORD, acceptTerms: true, privacyConsent: true, termsVersion: v.body.data.terms.version });
  if (done.status !== 201) throw new Error(`onboarding complete failed: ${JSON.stringify(done.body)}`);
  const ev = await c.post('/api/auth/customer/email/verify-link', { token: await lastLinkToken(email) });
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

/** Onboard a customer user (once) and return a signed-in client. */
export async function customerClient(a: FastifyInstance, account: string, email: string, phone: string): Promise<Client> {
  const existing = await q(db(), `SELECT 1 FROM customer_user WHERE email=$1`, [email]);
  await rewindOtpThrottle();
  if (!existing.length) return onboardCustomer(a, account, email, phone);
  return customerLogin(a, email, phone);
}

/** Sign an existing customer user in. */
export async function customerLogin(a: FastifyInstance, email: string, phone: string): Promise<Client> {
  await rewindOtpThrottle();
  const c = new Client(a);
  const s = await c.post('/api/auth/customer/login/start', { email, password: CUSTOMER_PASSWORD });
  if (s.status !== 200) throw new Error(`login start failed for ${email}: ${JSON.stringify(s.body)}`);
  const r = await c.post('/api/auth/customer/login/verify', { email, challengeId: s.body.data.challengeId, code: await lastOtp(phone) });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return c;
}

/** Onboard ABC (once) and return a signed-in client. */
export const ABC_EMAIL = 'treasury@abc-manufacturing.demo';
export const abcClient = (a: FastifyInstance) => customerClient(a, ABC.account, ABC_EMAIL, ABC.phone);

export const KANO = { account: '0100000003', phone: '08030000002', email: 'finance@kano-agro.demo' };
/** Kano Agro-Allied (Agriculture — a HEART sector) for E&S and committee scenarios. */
export const kanoClient = (a: FastifyInstance) => customerClient(a, KANO.account, KANO.email, KANO.phone);

export async function completeKanoProfile(c: Client, customerId: string) {
  await c.put(`/api/customers/${customerId}/profile`, { businessType: 'LIMITED_LIABILITY', sectorCode: 'AGRICULTURE', industry: 'Grain processing', businessDescription: 'Processor of maize and sorghum into flour and animal feed for northern Nigeria.', productsServices: 'Maize flour, sorghum flour, poultry feed', valueChain: 'Buys grain from out-growers; sells to distributors', geographicFootprint: 'Kano, Kaduna, Jigawa', employeeCount: 260, hasLitigation: false, hasRegulatoryMatters: false });
  const parties = (await c.get(`/api/customers/${customerId}/profile`)).body.data.parties;
  if (!parties.length) {
    await c.post(`/api/customers/${customerId}/parties`, { partyType: 'DIRECTOR', fullName: 'Hauwa Garba', designation: 'Managing Director', bvn: '22287654321', yearsExperience: 18 });
    await c.post(`/api/customers/${customerId}/parties`, { partyType: 'SHAREHOLDER', fullName: 'Hauwa Garba', ownershipPct: 100, bvn: '22287654321' });
  }
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

import { drain } from '../src/jobs/queue.js';
export { drain };

let keyN = 0;
export const idem = () => `idem-${Date.now()}-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;

/** Claim (if needed) and act on the open task for a stage. */
export async function act(c: Client, facilityId: string, stageKey: string, action: string, extra: Record<string, unknown> = {}) {
  const t = await q<any>(db(), `SELECT id, status FROM workflow_task WHERE facility_id=$1 AND stage_key=$2 AND status IN ('OPEN','CLAIMED') ORDER BY created_at DESC LIMIT 1`, [facilityId, stageKey]);
  if (!t[0]) throw new Error(`No open task ${stageKey}`);
  if (t[0].status === 'OPEN' && action !== 'VOTE') {
    const cl = await c.post(`/api/tasks/${t[0].id}/claim`);
    if (cl.status !== 200) throw new Error(`claim ${stageKey}: ${JSON.stringify(cl.body)}`);
  }
  const r = await c.post(`/api/tasks/${t[0].id}/actions`, { action, idempotencyKey: idem(), comment: extra.comment ?? 'Reviewed against policy; in order.', ...extra });
  return { ...r, taskId: t[0].id };
}

export function statementCsv(account: string, months: string[], baseCredit: number, opening = 5_000_000) {
  let bal = opening;
  const lines = [`Account Number: ${account}`, 'Trans Date,Value Date,Narration,Debit,Credit,Balance'];
  months.forEach((m, i) => {
    const credit = Math.round(baseCredit * (1 + (i % 3) * 0.05));
    bal += credit;
    lines.push(`05/${m.slice(5, 7)}/${m.slice(0, 4)},05/${m.slice(5, 7)}/${m.slice(0, 4)},NIP TRF FROM BOTTLING CUSTOMER REF 10000${i},,"${credit.toLocaleString('en-US')}.00","${bal.toLocaleString('en-US')}.00"`);
    const debit = Math.round(credit * 0.8);
    bal -= debit;
    lines.push(`20/${m.slice(5, 7)}/${m.slice(0, 4)},20/${m.slice(5, 7)}/${m.slice(0, 4)},TRF TO RESIN SUPPLIER,"${debit.toLocaleString('en-US')}.00",,"${bal.toLocaleString('en-US')}.00"`);
  });
  return Buffer.from(lines.join('\n') + '\n');
}

export const fyLines = (rev: number, pat: number) => {
  const N = (n: number) => Math.round(n * 100);
  return { REVENUE: N(rev), COST_OF_SALES: N(rev * 0.68), OPERATING_EXPENSES: N(rev * 0.14), DEPRECIATION: N(rev * 0.03), FINANCE_COST: N(rev * 0.02), PROFIT_BEFORE_TAX: N(pat / 0.7), TAX: N(pat / 0.7 - pat), PROFIT_AFTER_TAX: N(pat), NON_CURRENT_ASSETS: N(rev * 0.5), INVENTORY: N(rev * 0.12), TRADE_RECEIVABLES: N(rev * 0.1), CASH: N(rev * 0.05), CURRENT_ASSETS: N(rev * 0.3), TOTAL_ASSETS: N(rev * 0.8), TRADE_PAYABLES: N(rev * 0.08), SHORT_TERM_FINANCING: N(rev * 0.06), CURRENT_LIABILITIES: N(rev * 0.2), LONG_TERM_FINANCING: N(rev * 0.1), TOTAL_LIABILITIES: N(rev * 0.35), TOTAL_EQUITY: N(rev * 0.45) };
};

/** Perform the full credit analysis for a facility through the API (as an analyst would). */
export async function performCreditAnalysis(analyst: Client, facilityId: string, customerId: string, opts: { rate?: number; account?: string; owner?: string } = {}) {
  const acct = opts.account ?? '0100000001';
  const fs = (await analyst.get(`/api/customers/${customerId}/financial-statements`)).body.data;
  if (!fs.some((s: any) => s.statementType === 'AUDITED')) {
    for (const [y, rev, pat] of [[2023, 2_400_000_000, 120_000_000], [2024, 2_800_000_000, 150_000_000], [2025, 3_200_000_000, 190_000_000]] as const) {
      const r = await analyst.post(`/api/customers/${customerId}/financial-statements`, { statementType: 'AUDITED', periodStart: `${y}-01-01`, periodEnd: `${y}-12-31`, auditor: 'Demo & Co Chartered Accountants', auditOpinion: 'UNQUALIFIED', lines: fyLines(rev, pat) });
      if (r.status !== 201) throw new Error('fs ' + JSON.stringify(r.body));
    }
  }
  const must = async (p: Promise<any>, label: string) => { const r = await p; if (r.status >= 300) throw new Error(`${label}: ${JSON.stringify(r.body)}`); return r; };
  await must(analyst.post(`/api/facilities/${facilityId}/financial-analysis`), 'financial-analysis');
  const sts = (await analyst.get(`/api/facilities/${facilityId}/bank-statements`)).body.data;
  if (!sts.length) {
    const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
    await must(upload(analyst, `/api/facilities/${facilityId}/bank-statements`, 'altbank.csv', statementCsv(acct, months, 260_000_000), 'text/csv', { bankName: 'Alternative Bank', accountNumber: acct, currency: 'NGN', periodStart: '2025-11-01', periodEnd: '2026-10-31' }), 'stmt1');
    await must(upload(analyst, `/api/facilities/${facilityId}/bank-statements`, 'otherbank.csv', statementCsv('2200000001', months, 40_000), 'text/csv', { bankName: 'Other Commercial Bank', accountNumber: '2200000001', currency: 'USD', periodStart: '2025-11-01', periodEnd: '2026-10-31' }), 'stmt2');
    await drain(['statement.parse']);
  }
  await must(analyst.post(`/api/facilities/${facilityId}/statement-analysis`), 'statement-analysis');
  await must(analyst.post(`/api/facilities/${facilityId}/bureau-checks`, { subject: 'BUSINESS' }), 'bureau');
  await must(analyst.post(`/api/facilities/${facilityId}/exposure`), 'exposure');
  const cols = (await analyst.get(`/api/facilities/${facilityId}/collateral`)).body.data.items;
  if (!cols.length) await must(analyst.post(`/api/facilities/${facilityId}/collateral`, { typeKey: 'LEGAL_MORTGAGE', ownerName: opts.owner ?? 'ABC Manufacturing Ltd', description: 'Factory and warehouse at 14 Industrial Estate Road, Ikeja (C of O)', marketValueMinor: 320_000_000_00, valuationDate: '2026-09-15', valuationSource: 'Demo Estate Surveyors & Valuers', perfectionStatus: 'IN_PROGRESS' }), 'collateral');
  const risk = (await analyst.get(`/api/facilities/${facilityId}/risk`)).body.data;
  for (const kind of ['ORR', 'INDUSTRY', 'COLLATERAL']) {
    const card = risk.scorecards.find((s: any) => s.kind === kind);
    const answers: Record<string, string> = {};
    for (const s of card.sections) for (const qq of s.questions) answers[qq.code] = qq.code === 'COVERAGE' ? risk.suggestions.COVERAGE : qq.options[Math.max(0, qq.options.length - 2)].code;
    await must(analyst.post(`/api/facilities/${facilityId}/risk/${kind}`, { scorecardConfigId: card.configId, answers, submit: true }), `risk ${kind}`);
  }
  await must(analyst.post(`/api/facilities/${facilityId}/risk-frr`), 'frr');
  await must(analyst.post(`/api/facilities/${facilityId}/risk-combined`), 'combined');
  const rar = await must(analyst.post(`/api/facilities/${facilityId}/rarorac`, { proposedProfitRatePct: opts.rate ?? 26, managementFeePct: 1 }), 'rarorac');
  if (rar.body.data.exceptionRequired) await must(analyst.post(`/api/rarorac/${rar.body.data.id}/justify`, { justification: 'Strategic anchor customer with full domiciliation of contract proceeds; pricing aligned to the relationship value and collateral cover.' }), 'justify');
  await must(analyst.post(`/api/facilities/${facilityId}/memo`, { recommendation: 'APPROVE_WITH_CONDITIONS', commentary: 'ABC Manufacturing has a 15-year operating history, growing revenue and adequate cover from domiciled receivables and a legal mortgage over its factory.', mitigants: ['Domiciliation of bottling customer receivables', 'Legal mortgage over Ikeja factory'], conditions: ['Evidence of insurance (Takaful) on mortgaged property'] }), 'memo');
}
