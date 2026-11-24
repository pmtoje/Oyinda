import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, db, DEMO_PASSWORD, getApp, staffLogin, upload } from './helpers.js';
import { q } from '../src/db/pool.js';
import { env, loadEnv } from '../src/config/env.js';
import { decryptField } from '../src/lib/crypto.js';
import { hotp, totpStep } from '../src/modules/identity/totp.js';

let app: Awaited<ReturnType<typeof getApp>>;
let admin: Client;
const tag = Math.random().toString(36).slice(2, 7);
const user = { username: `local.${tag}`, name: 'Adaeze Okoro', email: `local.${tag}@altbank.demo`, staffNumber: `LCL-${tag}`, directorate: 'COMM', businessUnit: 'LAG-COMM-1' };
const PW1 = 'Harmattan#Breeze2026x';
const PW2 = 'Second#Gazelle2026y';

const lastLink = async (email: string) => {
  const r = await q<{ body: string }>(db(), 'SELECT body FROM mock_outbox WHERE destination=$1 ORDER BY id DESC LIMIT 1', [email]);
  const m = /set-password\?token=([A-Za-z0-9_-]+)/.exec(r[0]?.body ?? '');
  if (!m) throw new Error(`no link for ${email}`);
  return m[1]!;
};
/** Sign in with a Credit360 password and complete (or enrol) the authenticator. */
async function localLogin(username: string, password: string) {
  const c = new Client(app);
  const r = await c.post('/api/auth/staff/login', { username, password });
  if (r.status !== 200) return { c, r };
  const secret = r.body.data.mfa === 'ENROL' ? r.body.data.enrolment.secret : decryptField((await q<any>(db(), 'SELECT mfa_secret_enc FROM app_user WHERE ad_username=$1', [username]))[0].mfa_secret_enc);
  await q(db(), 'UPDATE app_user SET mfa_last_step=NULL WHERE ad_username=$1', [username]);
  const m = await c.post('/api/auth/staff/mfa/verify', { code: hotp(secret, totpStep()) });
  return { c, r, m };
}

beforeAll(async () => {
  app = await getApp();
  admin = await staffLogin(app, 'demo.admin'); // signed in through the directory before the switch
  (env() as any).STAFF_AUTH_MODE = 'local';
});
afterAll(() => { (env() as any).STAFF_AUTH_MODE = 'directory'; });

describe('interim staff sign-in: Credit360 password + authenticator (until AD)', () => {
  it('reports the mode and refuses unsafe production configuration', async () => {
    expect((await new Client(app).get('/api/meta')).body.data.staffAuthMode).toBe('local');
    const base = { APP_ENV: 'production', DATABASE_URL: 'postgres://x', HMAC_KEY: 'k'.repeat(44), DATA_KEY: 'k'.repeat(44), CBA_MODE: 'live', IDENTITY_MODE: 'live', MESSAGING_MODE: 'live', BUREAU_MODE: 'live', RARORAC_MODE: 'live', AV_MODE: 'live', AD_MODE: 'mock', STAFF_AUTH_MODE: 'local' } as any;
    expect(() => loadEnv(base)).toThrow(/STAFF_LOCAL_AUTH_APPROVAL_REF/);
    expect(() => loadEnv({ ...base, STAFF_LOCAL_AUTH_APPROVAL_REF: 'ISEC-WAIVER-2026-014' })).not.toThrow(); // AD not used for sign-in
    expect(() => loadEnv({ ...base, STAFF_AUTH_MODE: 'directory', STAFF_LOCAL_AUTH_APPROVAL_REF: 'x1x' })).toThrow(/AD_MODE/);
  });

  it('new staff receive a single-use activation link; administrators never handle the password', async () => {
    const r = await admin.post('/api/admin/users', user);
    expect(r.status).toBe(201);
    expect(r.body.data.activationLinkSentTo).toMatch(/@altbank\.demo$/);
    const uid = r.body.data.id;
    await admin.post(`/api/admin/users/${uid}/roles`, { change: 'GRANT_ROLE', role: 'RM', reason: 'Relationship Manager, Lagos Commercial 1' });
    // Before a password is set, nothing signs in — not even the directory password.
    expect((await new Client(app).post('/api/auth/staff/login', { username: user.username, password: DEMO_PASSWORD })).status).toBe(401);
    const token = await lastLink(user.email);
    const info = await new Client(app).get(`/api/auth/staff/password/link?token=${token}`);
    expect(info.body.data).toMatchObject({ purpose: 'ACTIVATE', username: user.username });
    expect(info.body.data.policy.minLength).toBeGreaterThanOrEqual(14);
    const weak = await new Client(app).post('/api/auth/staff/password/set', { token, password: 'Short#1a' });
    expect(weak.body.error.code).toBe('PASSWORD_POLICY');
    const personal = await new Client(app).post('/api/auth/staff/password/set', { token, password: `Officer#${tag}Gazelle99` });
    expect(personal.body.error.details.unmet).toContain('Must not contain your name or e-mail address');
    expect((await new Client(app).post('/api/auth/staff/password/set', { token, password: PW1 })).status).toBe(200);
    expect((await new Client(app).post('/api/auth/staff/password/set', { token, password: PW2 })).body.error.code).toBe('LINK_INVALID');
    const stored = (await q(db(), 'SELECT password_hash FROM app_user WHERE ad_username=$1', [user.username]))[0].password_hash;
    expect(stored).toMatch(/^scrypt\$/);
  });

  it('signs in with the password, then requires the authenticator', async () => {
    const { c, r, m } = await localLogin(user.username, PW1);
    expect(r.body.data.mfa).toBe('ENROL');
    expect(m!.status).toBe(200);
    expect((await c.get('/api/auth/me')).body.data.user.roles).toEqual(['RM']);
    const pre = new Client(app);
    await pre.post('/api/auth/staff/login', { username: user.username, password: PW1 });
    expect((await pre.get('/api/facilities')).status).toBe(401); // nothing usable before the second factor
  });

  it('gives the same answer for unknown users and wrong passwords, and locks after repeated failures', async () => {
    const a = await new Client(app).post('/api/auth/staff/login', { username: user.username, password: 'Wrong#Password1234' });
    const b = await new Client(app).post('/api/auth/staff/login', { username: 'nobody.here', password: PW1 });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.error.message).toBe(b.body.error.message);
    for (let i = 0; i < 4; i++) await new Client(app).post('/api/auth/staff/login', { username: user.username, password: 'Wrong#Password1234' });
    expect((await new Client(app).post('/api/auth/staff/login', { username: user.username, password: PW1 })).status).toBe(423);
    await q(db(), 'UPDATE app_user SET locked_until=NULL, failed_login_count=0 WHERE ad_username=$1', [user.username]);
  });

  it('self-service reset: generic response, single-use link, no reuse of recent passwords', async () => {
    const unknown = await new Client(app).post('/api/auth/staff/password/forgot', { username: 'nobody.here' });
    const known = await new Client(app).post('/api/auth/staff/password/forgot', { username: user.username });
    expect(unknown.body.data.message).toBe(known.body.data.message);
    const token = await lastLink(user.email);
    const reuse = await new Client(app).post('/api/auth/staff/password/set', { token, password: PW1 });
    expect(reuse.body.error.details.unmet.join(' ')).toMatch(/last 5 passwords/);
    expect((await new Client(app).post('/api/auth/staff/password/set', { token, password: PW2 })).status).toBe(200);
    expect((await localLogin(user.username, PW1)).r.status).toBe(401);
    expect((await localLogin(user.username, PW2)).m!.status).toBe(200);
  });

  it('expired passwords cannot sign in; a reset link is sent instead', async () => {
    await q(db(), `UPDATE app_user SET password_changed_at = now() - interval '91 days' WHERE ad_username=$1`, [user.username]);
    const before = (await q(db(), 'SELECT count(*)::int AS n FROM mock_outbox WHERE destination=$1', [user.email]))[0].n;
    const r = await new Client(app).post('/api/auth/staff/login', { username: user.username, password: PW2 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PASSWORD_EXPIRED');
    expect((await q(db(), 'SELECT count(*)::int AS n FROM mock_outbox WHERE destination=$1', [user.email]))[0].n).toBe(before + 1);
    await q(db(), `UPDATE app_user SET password_changed_at = now() WHERE ad_username=$1`, [user.username]);
  });

  it('a signed-in user can change their password, which ends their sessions', async () => {
    const { c } = await localLogin(user.username, PW2);
    expect((await c.post('/api/auth/staff/password/change', { currentPassword: 'Wrong#Password1234', newPassword: 'Third#Gazelle2026z' })).body.error.code).toBe('CURRENT_PASSWORD');
    expect((await c.post('/api/auth/staff/password/change', { currentPassword: PW2, newPassword: 'Third#Gazelle2026z' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('an administrator reset withdraws the password and ends sessions; admins cannot reset themselves', async () => {
    const { c } = await localLogin(user.username, 'Third#Gazelle2026z');
    const uid = (await q(db(), 'SELECT id FROM app_user WHERE ad_username=$1', [user.username]))[0].id;
    expect((await admin.post(`/api/admin/users/${uid}/credential-link`, { purpose: 'RESET' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect((await localLogin(user.username, 'Third#Gazelle2026z')).r.status).toBe(401);
    const me = (await q(db(), `SELECT id FROM app_user WHERE ad_username='demo.admin'`))[0].id;
    expect((await admin.post(`/api/admin/users/${me}/credential-link`, { purpose: 'RESET' })).status).toBe(403);
  });

  it('staff created by an approved spreadsheet import receive activation links', async () => {
    const { COLUMNS } = await import('../src/modules/admin/user-import.js');
    const email = `imported.${tag}@altbank.demo`;
    const csv = Buffer.from(`${COLUMNS.map((c) => c.header).join(',')}\nimported.${tag},Imported Local Officer,${email},,COMM,LAG-COMM-1,RM,,,,ACTIVE\n`);
    const up = await upload(admin, '/api/admin/user-imports', 'staff.csv', csv, 'text/csv');
    expect(up.body.data.status).toBe('PENDING_APPROVAL');
    // The checker signs in through the directory (demo.superadmin has no Credit360 password).
    (env() as any).STAFF_AUTH_MODE = 'directory';
    const checker = await staffLogin(app, 'demo.superadmin');
    (env() as any).STAFF_AUTH_MODE = 'local';
    const ap = await checker.post(`/api/admin/user-imports/${up.body.data.id}/decide`, { decision: 'APPROVE' });
    expect(ap.body.data.applied.activationLinksSent).toBe(1);
    expect(await lastLink(email)).toBeTruthy();
  });

  it('in directory mode the interim password routes do not exist', async () => {
    (env() as any).STAFF_AUTH_MODE = 'directory';
    try {
      expect((await new Client(app).post('/api/auth/staff/password/forgot', { username: user.username })).status).toBe(404);
      const uid = (await q(db(), 'SELECT id FROM app_user WHERE ad_username=$1', [user.username]))[0].id;
      expect((await admin.post(`/api/admin/users/${uid}/credential-link`, { purpose: 'RESET' })).status).toBe(409);
    } finally { (env() as any).STAFF_AUTH_MODE = 'local'; }
  });
});
