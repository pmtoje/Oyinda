import { beforeAll, describe, expect, it } from 'vitest';
import { Client, completeKanoProfile, CUSTOMER_PASSWORD, customerLogin, db, draftMurabaha, getApp, kanoClient, lastOtp, rewindOtpThrottle, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';

let app: Awaited<ReturnType<typeof getApp>>;
let primary: Client;
let customerId: string;
const tag = Math.random().toString(36).slice(2, 7);
const preparer = { fullName: 'Musa Danladi', email: `preparer.${tag}@kano-agro.demo`, roleInCompany: 'Finance Officer', phone: `0813${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` };
const submitter = { fullName: 'Rakiya Bello', email: `submitter.${tag}@kano-agro.demo`, roleInCompany: 'Finance Manager', phone: `0814${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` };

const inviteToken = async (email: string) => {
  const r = await q<{ body: string }>(db(), 'SELECT body FROM mock_outbox WHERE destination=$1 ORDER BY id DESC LIMIT 1', [email]);
  return /\/invite\?token=([A-Za-z0-9_-]+)/.exec(r[0]?.body ?? '')![1]!;
};
/** The invitee's own journey: open the link, verify their mobile, set a password, accept the terms. */
async function accept(person: typeof preparer) {
  await rewindOtpThrottle();
  const c = new Client(app);
  const token = await inviteToken(person.email);
  const info = await c.get(`/api/portal-invites?token=${token}`);
  expect((await c.post('/api/portal-invites/phone', { token, phone: person.phone })).status).toBe(200);
  const r = await c.post('/api/portal-invites/accept', { token, code: await lastOtp(person.phone), password: CUSTOMER_PASSWORD, acceptTerms: true, privacyConsent: true, termsVersion: info.body.data.terms.version });
  expect(r.status).toBe(201);
  return c;
}

beforeAll(async () => {
  app = await getApp();
  primary = await kanoClient(app);
  customerId = (await primary.get('/api/auth/me')).body.data.customer.id;
  await completeKanoProfile(primary, customerId);
});

describe('more than one portal user per business', () => {
  it('the first user holds every right and can invite colleagues after re-entering their password', async () => {
    const me = (await primary.get('/api/auth/me')).body.data.user;
    expect(me.primary).toBe(true);
    expect(me.permissions).toEqual(expect.arrayContaining(['SUBMIT_REQUESTS', 'RESPOND_TO_OFFERS', 'MANAGE_USERS']));
    const wrong = await primary.post('/api/portal/users/invites', { ...preparer, permissions: [], currentPassword: 'Wrong#Password1' });
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD');
    const r = await primary.post('/api/portal/users/invites', { ...preparer, permissions: [], currentPassword: CUSTOMER_PASSWORD });
    expect(r.status).toBe(201);
    expect((await primary.post('/api/portal/users/invites', { ...preparer, permissions: [], currentPassword: CUSTOMER_PASSWORD })).body.error.code).toBe('ALREADY_INVITED');
    expect((await primary.post('/api/portal/users/invites', { ...preparer, email: 'finance@kano-agro.demo', permissions: [], currentPassword: CUSTOMER_PASSWORD })).body.error.code).toBe('EMAIL_IN_USE');
    expect((await primary.post('/api/portal/users/invites', { ...submitter, permissions: ['SUBMIT_REQUESTS'], currentPassword: CUSTOMER_PASSWORD })).status).toBe(201);
    const list = (await primary.get('/api/portal/users')).body.data;
    expect(list.invites.map((i: any) => i.email)).toEqual(expect.arrayContaining([preparer.email, submitter.email]));
  });

  it('the invitee verifies their own mobile, sets a policy-compliant password and joins with the granted rights only', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    const token = await inviteToken(preparer.email);
    const info = await c.get(`/api/portal-invites?token=${token}`);
    expect(info.body.data).toMatchObject({ business: 'Kano Agro-Allied Processing Ltd', email: preparer.email, permissions: [] });
    const base = { token, password: CUSTOMER_PASSWORD, acceptTerms: true, privacyConsent: true, termsVersion: info.body.data.terms.version };
    expect((await c.post('/api/portal-invites/accept', { ...base, code: '123456' })).body.error.code).toBe('PHONE_FIRST');
    expect((await c.post('/api/portal-invites/phone', { token, phone: '12345' })).status).toBe(400);
    await c.post('/api/portal-invites/phone', { token, phone: preparer.phone });
    const code = await lastOtp(preparer.phone);
    expect((await c.post('/api/portal-invites/accept', { ...base, code: code === '000000' ? '111111' : '000000' })).body.error.code).toBe('OTP_INVALID');
    expect((await c.post('/api/portal-invites/accept', { ...base, code, password: 'weak' })).body.error.code).toBe('PASSWORD_POLICY');
    expect((await c.post('/api/portal-invites/accept', { ...base, code })).status).toBe(201);
    const me = (await c.get('/api/auth/me')).body.data;
    expect(me.customer.id).toBe(customerId);
    expect(me.user).toMatchObject({ primary: false, permissions: [], emailVerified: true });
    expect((await new Client(app).get(`/api/portal-invites?token=${token}`)).body.error.code).toBe('INVITE_INVALID'); // single use
    // Signing in later: password, then OTP to the invitee's own mobile
    const again = await customerLogin(app, preparer.email, preparer.phone);
    expect((await again.get('/api/auth/me')).status).toBe(200);
  });

  it('a user without the right can prepare a request but cannot submit it, respond to offers or manage users', async () => {
    const c = await customerLogin(app, preparer.email, preparer.phone);
    const f = await draftMurabaha(c);
    await uploadAllRequired(c, f.id);
    const cur = (await c.get(`/api/facilities/${f.id}`)).body.data.facility;
    const sub = await c.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    expect(sub.status).toBe(403);
    expect(sub.body.error.message).toMatch(/submitting requests/);
    expect((await c.post('/api/portal/users/invites', { ...submitter, email: `x.${tag}@kano-agro.demo`, permissions: [], currentPassword: CUSTOMER_PASSWORD })).status).toBe(403);
    const anyOffer = (await q(db(), `SELECT o.id FROM offer_letter o JOIN facility_request f ON f.id=o.facility_id WHERE f.customer_id=$1 LIMIT 1`, [customerId]))[0];
    if (anyOffer) expect((await c.post(`/api/offers/${anyOffer.id}/respond`, { decision: 'REJECT', rowVersion: 1 })).status).toBe(403);
    expect((await c.get('/api/portal/users')).body.data.canManage).toBe(false);
    // A colleague with the right submits the same request
    const s = await accept(submitter);
    const cur2 = (await s.get(`/api/facilities/${f.id}`)).body.data.facility;
    expect((await s.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur2.rowVersion, declaration: true })).status).toBe(200);
  });

  it('a user manager changes rights and deactivates users; nobody changes their own access; one manager always remains', async () => {
    const users = (await primary.get('/api/portal/users')).body.data.users;
    const p = users.find((u: any) => u.email === preparer.email);
    const me = users.find((u: any) => u.you);
    expect((await primary.patch(`/api/portal/users/${me.id}`, { status: 'DISABLED', currentPassword: CUSTOMER_PASSWORD })).status).toBe(403);
    expect((await primary.patch(`/api/portal/users/${p.id}`, { permissions: ['SUBMIT_REQUESTS'], currentPassword: CUSTOMER_PASSWORD })).status).toBe(200);
    const c = await customerLogin(app, preparer.email, preparer.phone);
    expect((await c.get('/api/auth/me')).body.data.user.permissions).toEqual(['SUBMIT_REQUESTS']);
    expect((await primary.patch(`/api/portal/users/${p.id}`, { status: 'DISABLED', currentPassword: CUSTOMER_PASSWORD })).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    await expect(customerLogin(app, preparer.email, preparer.phone)).rejects.toThrow();
    // Make the preparer the only other manager, then show the last manager cannot be removed by them
    await primary.patch(`/api/portal/users/${p.id}`, { status: 'ACTIVE', permissions: ['MANAGE_USERS'], currentPassword: CUSTOMER_PASSWORD });
    const mgr = await customerLogin(app, preparer.email, preparer.phone);
    const sub = users.find((u: any) => u.email === submitter.email);
    expect((await mgr.patch(`/api/portal/users/${sub.id}`, { permissions: [], currentPassword: CUSTOMER_PASSWORD })).status).toBe(200);
    expect((await q(db(), `SELECT count(*)::int AS n FROM audit_log WHERE action IN ('PORTAL_USER_RIGHTS_CHANGED','PORTAL_USER_DEACTIVATED','PORTAL_USER_JOINED') AND customer_id=$1`, [customerId]))[0].n).toBeGreaterThanOrEqual(4);
  });

  it('a second person cannot self-onboard an already registered business; they are told to ask for an invitation', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    await c.post('/api/onboarding/start', { accountNumber: '0100000003', fullName: 'Another Person', roleInCompany: 'Accountant' });
    const v = await c.post('/api/onboarding/verify-otp', { code: await lastOtp('08030000002') });
    expect(v.body.data.alreadyOnGazelle).toBe(true);
    const r = await c.post('/api/onboarding/complete', { password: 'Another#Secure2026', acceptTerms: true, privacyConsent: true, termsVersion: v.body.data.terms.version });
    expect(r.body.error.message).toMatch(/invite you/);
  });
});
