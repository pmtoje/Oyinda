import { beforeAll, describe, expect, it } from 'vitest';
import { Client, DEMO_PASSWORD, db, getApp, lastOtp, rewindOtpThrottle, staffLogin } from './helpers.js';
import { q } from '../src/db/pool.js';
import { verifyAuditChain } from '../src/modules/audit/audit.js';

let app: Awaited<ReturnType<typeof getApp>>;
beforeAll(async () => { app = await getApp(); });

const KANO_ACCT = '0100000003';
const KANO_PHONE = '08030000002';

describe('customer onboarding & OTP security', () => {
  it('never returns the OTP in any API response', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    const r = await c.post('/api/onboarding/start', { accountNumber: KANO_ACCT });
    expect(r.status).toBe(200);
    const code = await lastOtp(KANO_PHONE);
    expect(JSON.stringify(r.body)).not.toContain(code);
    expect(r.body.data.otpSentTo).toBe('0803•••••02');
    const rows = await q(db(), 'SELECT code_hash FROM otp_challenge ORDER BY created_at DESC LIMIT 1');
    expect(rows[0].code_hash).not.toContain(code);
  });

  it('rejects unknown and non-corporate accounts without revealing data', async () => {
    const c = new Client(app);
    const r = await c.post('/api/onboarding/start', { accountNumber: '0999999999' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ACCOUNT_NOT_VERIFIED');
    const ind = await c.post('/api/onboarding/start', { accountNumber: '0100000004' });
    expect(ind.body.error.code).toBe('NOT_CORPORATE');
    const bad = await c.post('/api/onboarding/start', { accountNumber: "0100' OR 1=1" });
    expect(bad.status).toBe(400);
  });

  it('rejects wrong, then locks after max attempts, and refuses reuse', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    await c.post('/api/onboarding/start', { accountNumber: KANO_ACCT });
    const right = await lastOtp(KANO_PHONE);
    const wrong = right === '000000' ? '111111' : '000000';
    const w1 = await c.post('/api/onboarding/verify-otp', { code: wrong });
    expect(w1.status).toBe(422);
    expect(w1.body.error.code).toBe('OTP_INVALID');
    expect(w1.body.error.details.remainingAttempts).toBe(4);
    for (let i = 0; i < 4; i++) await c.post('/api/onboarding/verify-otp', { code: wrong });
    const locked = await c.post('/api/onboarding/verify-otp', { code: right });
    expect(locked.body.error.code).toBe('OTP_LOCKED');
  });

  it('rejects an expired OTP', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    await c.post('/api/onboarding/start', { accountNumber: KANO_ACCT });
    const code = await lastOtp(KANO_PHONE);
    await q(db(), `UPDATE otp_challenge SET expires_at = now() - interval '1 second' WHERE consumed_at IS NULL AND invalidated_at IS NULL`);
    const r = await c.post('/api/onboarding/verify-otp', { code });
    expect(r.body.error.code).toBe('OTP_EXPIRED');
  });

  it('cannot skip the OTP step (no bypass)', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    await c.post('/api/onboarding/start', { accountNumber: KANO_ACCT });
    const r = await c.post('/api/onboarding/complete', { fullName: 'Attacker', email: 'x@evil.demo', designation: 'Director', acceptTerms: true, privacyConsent: true, termsVersion: '2026.1' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STEP');
    const noJourney = await new Client(app).post('/api/onboarding/verify-otp', { code: '123456' });
    expect(noJourney.status).toBe(401);
  });

  it('completes onboarding, verifies email, and refuses OTP reuse', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    await c.post('/api/onboarding/start', { accountNumber: KANO_ACCT });
    const code = await lastOtp(KANO_PHONE);
    const v = await c.post('/api/onboarding/verify-otp', { code });
    expect(v.status).toBe(200);
    expect(v.body.data.business.name).toBe('Kano Agro-Allied Processing Ltd');
    expect(v.body.data.business.tin).toMatch(/^•+0001$/);
    const reuse = await c.post('/api/onboarding/verify-otp', { code });
    expect(reuse.status).toBe(409);
    const done = await c.post('/api/onboarding/complete', { fullName: 'Hauwa Sule', email: 'hauwa@kano-agro.demo', designation: 'CFO', acceptTerms: true, privacyConsent: true, termsVersion: '2026.1' });
    expect(done.status).toBe(201);
    const me = await c.get('/api/auth/me');
    expect(me.body.data.customer.name).toBe('Kano Agro-Allied Processing Ltd');
    expect(me.body.data.user.emailVerified).toBe(false);
    const ev = await c.post('/api/auth/customer/email/verify', { challengeId: done.body.data.emailVerificationChallengeId, code: await lastOtp('hauwa@kano-agro.demo') });
    expect(ev.status).toBe(200);
    // Profile was pre-populated from the core banking record, not from client input
    const prof = await q(db(), `SELECT bp.rc_number FROM business_profile bp JOIN customer c ON c.id=bp.customer_id WHERE c.legal_name=$1`, ['Kano Agro-Allied Processing Ltd']);
    expect(prof[0].rc_number).toBe('RC7654321');
  });

  it('customer login: enumeration-resistant start, lockout after repeated failures', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    const unknown = await c.post('/api/auth/customer/login/start', { email: 'nobody@nowhere.demo' });
    const known = await c.post('/api/auth/customer/login/start', { email: 'hauwa@kano-agro.demo' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.data.message).toBe(known.body.data.message);
    const challengeId = known.body.data.challengeId;
    const right = await lastOtp(KANO_PHONE);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/api/auth/customer/login/verify', { email: 'hauwa@kano-agro.demo', challengeId, code: wrong });
      expect(r.status).toBe(422);
    }
    await rewindOtpThrottle();
    const again = await c.post('/api/auth/customer/login/start', { email: 'hauwa@kano-agro.demo' });
    const r5 = await c.post('/api/auth/customer/login/verify', { email: 'hauwa@kano-agro.demo', challengeId: again.body.data.challengeId, code: wrong });
    expect(r5.status).toBe(423);
    await q(db(), `UPDATE customer_user SET locked_until=NULL, failed_otp_count=0 WHERE email='hauwa@kano-agro.demo'`);
  });

  it('customer login success creates an HttpOnly session; logout revokes it', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    const s = await c.post('/api/auth/customer/login/start', { email: 'hauwa@kano-agro.demo' });
    const r = await c.post('/api/auth/customer/login/verify', { email: 'hauwa@kano-agro.demo', challengeId: s.body.data.challengeId, code: await lastOtp(KANO_PHONE) });
    expect(r.status).toBe(200);
    const setCookie = String(r.raw.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const sessions = await c.get('/api/auth/sessions');
    expect(sessions.body.data.some((x: any) => x.current)).toBe(true);
    const out = await c.post('/api/auth/logout');
    expect(out.status).toBe(200);
    // replaying the old cookie no longer works (stolen-token replay after logout)
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('CSRF and session protections', () => {
  it('rejects state-changing requests without a valid CSRF token or from a foreign origin', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    const s = await c.post('/api/auth/customer/login/start', { email: 'hauwa@kano-agro.demo' });
    await c.post('/api/auth/customer/login/verify', { email: 'hauwa@kano-agro.demo', challengeId: s.body.data.challengeId, code: await lastOtp(KANO_PHONE) });
    const token = c.csrf;
    c.csrf = undefined;
    expect((await c.post('/api/auth/sessions/revoke-others')).status).toBe(403);
    c.csrf = 'a'.repeat(48);
    expect((await c.post('/api/auth/sessions/revoke-others')).status).toBe(403);
    c.csrf = token;
    expect((await c.post('/api/auth/sessions/revoke-others', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.post('/api/auth/sessions/revoke-others')).status).toBe(200);
  });

  it('expires idle sessions server-side', async () => {
    await rewindOtpThrottle();
    const c = new Client(app);
    const s = await c.post('/api/auth/customer/login/start', { email: 'hauwa@kano-agro.demo' });
    await c.post('/api/auth/customer/login/verify', { email: 'hauwa@kano-agro.demo', challengeId: s.body.data.challengeId, code: await lastOtp(KANO_PHONE) });
    await q(db(), `UPDATE auth_session SET idle_expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects forged session tokens', async () => {
    const c = new Client(app);
    c.cookies.set('gz_session', 'forged-token-value');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('never exposes stack traces', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/onboarding/start', headers: { 'content-type': 'application/json' }, payload: '{bad json' });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/at .*\.ts:\d+/);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('staff authentication (AD + MFA)', () => {
  it('requires MFA before any staff API is usable', async () => {
    const c = new Client(app);
    const r = await c.post('/api/auth/staff/login', { username: 'demo.board4', password: DEMO_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.data.mfa).toBe('ENROL'); // demo.board4 is not used by any other test file
    const me = await c.get('/api/auth/me');
    expect(me.body.data.mfaSatisfied).toBe(false);
    expect(me.body.data.user).toBeNull();
    const wrongMfa = await c.post('/api/auth/staff/mfa/verify', { code: '000000' });
    expect(wrongMfa.status).toBe(422);
  });

  it('rejects wrong passwords and unknown users with the same message', async () => {
    const c = new Client(app);
    const a = await c.post('/api/auth/staff/login', { username: 'demo.cro', password: 'wrong-password' });
    const b = await c.post('/api/auth/staff/login', { username: 'no.such.user', password: DEMO_PASSWORD });
    expect(a.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks staff accounts after repeated failed sign-ins', async () => {
    const c = new Client(app);
    for (let i = 0; i < 5; i++) await c.post('/api/auth/staff/login', { username: 'demo.auditor', password: 'nope' });
    const r = await c.post('/api/auth/staff/login', { username: 'demo.auditor', password: DEMO_PASSWORD });
    expect(r.status).toBe(423);
    await q(db(), `UPDATE app_user SET locked_until=NULL WHERE ad_username='demo.auditor'`);
  });

  it('completes enrolment + MFA and rotates the session token', async () => {
    const c = await staffLogin(app, 'demo.cro');
    const me = await c.get('/api/auth/me');
    expect(me.body.data.mfaSatisfied).toBe(true);
    expect(me.body.data.user.roles).toContain('CRO');
  });
});

describe('audit log', () => {
  it('is hash-chained and verifiable', async () => {
    const r = await verifyAuditChain(db());
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(10);
  });
  it('cannot be modified, deleted or truncated', async () => {
    await expect(q(db(), `UPDATE audit_log SET action='TAMPERED' WHERE id=(SELECT min(id) FROM audit_log)`)).rejects.toThrow(/GZ_IMMUTABLE/);
    await expect(q(db(), `DELETE FROM audit_log`)).rejects.toThrow(/GZ_IMMUTABLE/);
    await expect(q(db(), `TRUNCATE audit_log`)).rejects.toThrow(/GZ_IMMUTABLE/);
  });
  it('never records OTP codes', async () => {
    const rows = await q(db(), `SELECT count(*)::int AS n FROM audit_log WHERE metadata::text ~ '"code"\\s*:\\s*"\\d{6}"'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('rate limiting', () => {
  it('blocks brute force on identity endpoints at the production default', async () => {
    const { loadEnv, setEnvForTests, env } = await import('../src/config/env.js');
    const { buildApp } = await import('../src/http/app.js');
    const saved = env();
    setEnvForTests(loadEnv({ ...process.env, AUTH_RATE_LIMIT_PER_15MIN: '10' }));
    const limited = await buildApp({ logger: false });
    await limited.ready(); // plugins register lazily; resolve them while the production limit is in force
    setEnvForTests(saved);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await limited.inject({ method: 'POST', url: '/api/auth/staff/login', headers: { 'content-type': 'application/json' }, payload: { username: 'no.such.user', password: 'wrong-password' } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    await limited.close();
  });
});
