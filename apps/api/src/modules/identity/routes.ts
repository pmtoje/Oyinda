import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { encryptField, decryptField, hmac, randomToken } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { maskAccount, maskEmail, maskPhone } from '../../lib/mask.js';
import { nextRef } from '../../lib/ids.js';
import { actorOf, parse, requireCustomer, requireStaff, ok } from '../../http/context.js';
import { integrations } from '../../integrations/index.js';
import { audit } from '../audit/audit.js';
import { getActive } from '../config/service.js';
import { issueOtp, verifyOtp, OTP_MESSAGES } from './otp.js';
import { createSession, revokeAllFor, revokeSession, SESSION_COOKIE } from './session.js';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import { recordStep } from '../analytics/journey.js';

const ONB_COOKIE = 'gz_onb';
const accountNumber = z.string().trim().regex(/^[0-9]{10}$/, 'Enter your 10-digit NUBAN account number.');
const otpCode = z.string().trim().regex(/^[0-9]{6}$/, 'Enter the 6-digit code.');


function cookieOpts(maxAgeSeconds?: number) {
  return { httpOnly: true, secure: env().COOKIE_SECURE, sameSite: 'strict' as const, path: '/', ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}) };
}

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, cookieOpts(env().SESSION_ABSOLUTE_HOURS * 3600));
}

async function dispatchOtp(channel: 'SMS' | 'EMAIL', to: string, code: string, purpose: string) {
  const text = `Your Gazelle by Alternative Bank ${purpose} code is ${code}. It expires in ${Math.round(env().OTP_TTL_SECONDS / 60)} minutes. Never share this code; the Bank will never ask for it.`;
  if (channel === 'SMS') await integrations().messaging.sendSms(to, text);
  else await integrations().messaging.sendEmail(to, `Your Gazelle ${purpose} code`, text);
}

export async function identityRoutes(app: FastifyInstance) {
  const db = getPool();
  // Brute-force protection on every identity endpoint (per client IP), in addition to per-account lockout.
  const AUTH_LIMIT = { rateLimit: { max: env().AUTH_RATE_LIMIT_PER_15MIN, timeWindow: '15 minutes' } };

  // ---------------------------------------------------------------------------
  // Onboarding — existing Alternative Bank account holders
  // ---------------------------------------------------------------------------
  app.post('/api/onboarding/start', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ accountNumber }), req.body);
    const actor = actorOf(req);
    const acctKey = hmac(body.accountNumber, 'account');
    // Identity comes from the core banking system only — never from the client.
    const cba = await integrations().cba.findByAccountNumber(body.accountNumber);
    const account = cba?.accounts.find((a) => a.accountNumber === body.accountNumber);
    if (!cba || !account || account.status === 'CLOSED') {
      await audit(db, actor, { action: 'ONBOARDING_ACCOUNT_NOT_VERIFIED', entityType: 'onboarding', outcome: 'FAILURE', metadata: { account: maskAccount(body.accountNumber) } });
      throw unprocessable('ACCOUNT_NOT_VERIFIED', 'We could not verify this account. Check the number, or contact your relationship manager.');
    }
    if (cba.customerType !== 'CORPORATE') {
      throw unprocessable('NOT_CORPORATE', 'Gazelle serves corporate, commercial and institutional customers. This account is not a business account.');
    }
    if (account.status === 'PND' || account.status === 'DORMANT') {
      throw unprocessable('ACCOUNT_RESTRICTED', 'This account has a restriction. Please contact your relationship manager before continuing.');
    }
    const out = await tx(async (c) => {
      const otp = await issueOtp(c, { purpose: 'ONBOARDING', subjectKey: acctKey, channel: 'SMS', destinationMasked: maskPhone(cba.registeredPhone), ip: req.ip });
      const token = randomToken();
      await q(c, `UPDATE onboarding_journey SET step='ABANDONED' WHERE account_number_hash=$1 AND step NOT IN ('COMPLETED','ABANDONED')`, [acctKey]);
      const j = await one<{ id: string }>(
        c,
        `INSERT INTO onboarding_journey(token_hash, account_number_hash, cba_customer_id, step, otp_challenge_id, cba_snapshot, ip, expires_at)
         VALUES ($1,$2,$3,'ACCOUNT_VERIFIED',$4,$5,$6, now() + interval '30 minutes') RETURNING id`,
        [hmac(token, 'onboarding'), acctKey, cba.cbaCustomerId, otp.challengeId, JSON.stringify(cba), req.ip],
      );
      await recordStep(c, 'ONBOARDING', j.id, null, 'ACCOUNT', 'COMPLETED');
      await recordStep(c, 'ONBOARDING', j.id, null, 'OTP', 'ENTERED');
      await audit(c, actor, { action: 'OTP_ISSUED', entityType: 'onboarding_journey', entityId: j.id, metadata: { purpose: 'ONBOARDING', channel: 'SMS' } });
      return { token, otp, cba };
    });
    await dispatchOtp('SMS', out.cba.registeredPhone, out.otp.code, 'verification');
    reply.setCookie(ONB_COOKIE, out.token, cookieOpts(1800));
    return ok(reply, { otpSentTo: maskPhone(out.cba.registeredPhone), channel: 'SMS', expiresInSeconds: env().OTP_TTL_SECONDS });
  });

  async function loadJourney(req: FastifyRequest) {
    const token = req.cookies[ONB_COOKIE];
    if (!token) throw unauthorized('Your verification session has expired. Start again.');
    const j = await maybe<any>(db, `SELECT * FROM onboarding_journey WHERE token_hash=$1 AND expires_at > now() AND step NOT IN ('COMPLETED','ABANDONED')`, [hmac(token, 'onboarding')]);
    if (!j) throw unauthorized('Your verification session has expired. Start again.');
    return j;
  }

  app.post('/api/onboarding/resend-otp', { config: AUTH_LIMIT }, async (req, reply) => {
    const j = await loadJourney(req);
    if (j.step !== 'ACCOUNT_VERIFIED') throw conflict('STEP', 'This step is already complete.');
    const cba = j.cba_snapshot;
    const otp = await tx(async (c) => {
      const o = await issueOtp(c, { purpose: 'ONBOARDING', subjectKey: j.account_number_hash, channel: 'SMS', destinationMasked: maskPhone(cba.registeredPhone), ip: req.ip });
      await q(c, 'UPDATE onboarding_journey SET otp_challenge_id=$2 WHERE id=$1', [j.id, o.challengeId]);
      await audit(c, actorOf(req), { action: 'OTP_RESENT', entityType: 'onboarding_journey', entityId: j.id });
      return o;
    });
    await dispatchOtp('SMS', cba.registeredPhone, otp.code, 'verification');
    return ok(reply, { otpSentTo: maskPhone(cba.registeredPhone), expiresInSeconds: env().OTP_TTL_SECONDS });
  });

  app.post('/api/onboarding/verify-otp', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ code: otpCode }), req.body);
    const j = await loadJourney(req);
    if (j.step !== 'ACCOUNT_VERIFIED') throw conflict('STEP', 'This step is already complete.');
    const res = await tx(async (c) => {
      const r = await verifyOtp(c, { challengeId: j.otp_challenge_id, purpose: 'ONBOARDING', subjectKey: j.account_number_hash, code: body.code });
      await audit(c, actorOf(req), { action: r.ok ? 'OTP_VERIFIED' : 'OTP_FAILED', entityType: 'onboarding_journey', entityId: j.id, outcome: r.ok ? 'SUCCESS' : 'FAILURE', metadata: r.ok ? undefined : { reason: r.reason } });
      await q(c, `INSERT INTO auth_attempt(subject_key, kind, ip, success) VALUES ($1,'ONBOARDING_OTP',$2,$3)`, [j.account_number_hash, req.ip, r.ok]);
      if (r.ok) {
        await q(c, `UPDATE onboarding_journey SET step='OTP_VERIFIED' WHERE id=$1`, [j.id]);
        await recordStep(c, 'ONBOARDING', j.id, null, 'OTP', 'COMPLETED');
        await recordStep(c, 'ONBOARDING', j.id, null, 'PROFILE', 'ENTERED');
      }
      return r;
    });
    if (!res.ok) throw unprocessable(`OTP_${res.reason}`, OTP_MESSAGES[res.reason], { remainingAttempts: res.remaining });
    const cba = j.cba_snapshot;
    const existing = await maybe<{ id: string }>(db, 'SELECT id FROM customer WHERE cba_customer_id=$1', [cba.cbaCustomerId]);
    const terms = await getActive(db, 'legal_terms', 'CUSTOMER_PORTAL');
    return ok(reply, {
      business: {
        name: cba.businessName,
        rcNumber: cba.rcNumber ?? null,
        tin: cba.tin ? `••••••••${cba.tin.slice(-4)}` : null,
        incorporationDate: cba.incorporationDate ?? null,
        address: [cba.address, cba.city, cba.state].filter(Boolean).join(', '),
        accounts: cba.accounts.map((a: any) => ({ account: maskAccount(a.accountNumber), currency: a.currency, product: a.productName })),
        registeredPhone: maskPhone(cba.registeredPhone),
      },
      alreadyOnGazelle: !!existing,
      terms: terms ? { version: terms.payload.version, termsText: terms.payload.termsText, privacyText: terms.payload.privacyText } : null,
    });
  });

  app.post('/api/onboarding/complete', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(
      z.object({
        fullName: z.string().trim().min(3).max(120),
        email: z.email().max(200).transform((s) => s.toLowerCase()),
        designation: z.string().trim().min(2).max(80),
        acceptTerms: z.literal(true, { error: 'You must accept the terms to continue.' }),
        privacyConsent: z.literal(true, { error: 'Consent to the privacy notice is required.' }),
        termsVersion: z.string().min(1).max(40),
      }),
      req.body,
    );
    const j = await loadJourney(req);
    if (j.step !== 'OTP_VERIFIED') throw conflict('STEP', 'Verify your account first.');
    const terms = await getActive(db, 'legal_terms', 'CUSTOMER_PORTAL');
    if (!terms || terms.payload.version !== body.termsVersion) throw conflict('TERMS_CHANGED', 'The terms have been updated. Please review the current version.');
    const cba = j.cba_snapshot;
    const result = await tx(async (c) => {
      if (await maybe(c, 'SELECT 1 FROM customer_user WHERE lower(email)=$1', [body.email])) throw conflict('EMAIL_IN_USE', 'This email is already registered on Gazelle. Sign in instead.');
      let customer = await maybe<any>(c, 'SELECT * FROM customer WHERE cba_customer_id=$1 FOR UPDATE', [cba.cbaCustomerId]);
      const actor = actorOf(req);
      if (!customer) {
        const rm = cba.relationshipManagerStaffNumber ? await maybe<{ id: string }>(c, `SELECT id FROM app_user WHERE staff_number=$1 AND status='ACTIVE'`, [cba.relationshipManagerStaffNumber]) : undefined;
        const bu = cba.businessUnitCode ? await maybe<{ code: string }>(c, 'SELECT code FROM business_unit WHERE code=$1', [cba.businessUnitCode]) : undefined;
        customer = await one(
          c,
          `INSERT INTO customer(customer_ref, cba_customer_id, legal_name, relationship_manager_id, business_unit_code, status, is_demo, bank_relationship_since)
           VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7) RETURNING *`,
          [await nextRef(c, 'CUS'), cba.cbaCustomerId, cba.businessName, rm?.id ?? null, bu?.code ?? null, integrations().cba.mode === 'MOCK', cba.customerSince ?? null],
        );
        for (const a of cba.accounts) {
          await q(c, `INSERT INTO customer_account(customer_id, account_number, account_name, currency, product_name, is_primary) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_number) DO NOTHING`, [customer.id, a.accountNumber, a.accountName, a.currency, a.productName, a.accountNumber === cba.accounts[0].accountNumber]);
        }
        // Pre-populate the master Business Profile from the core banking record.
        await q(
          c,
          `INSERT INTO business_profile(customer_id, registered_name, rc_number, tin, incorporation_date, address_line, city, state, updated_by_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SYSTEM')`,
          [customer.id, cba.businessName, cba.rcNumber ?? null, cba.tin ?? null, cba.incorporationDate ?? null, cba.address ?? null, cba.city ?? null, cba.state ?? null],
        );
        await audit(c, actor, { action: 'CUSTOMER_CREATED', entityType: 'customer', entityId: customer.id, customerId: customer.id, metadata: { source: 'CBA', cbaMode: integrations().cba.mode } });
      }
      const hasPrimary = await maybe(c, `SELECT 1 FROM customer_user WHERE customer_id=$1 AND portal_role='PRIMARY'`, [customer.id]);
      const user = await one<any>(
        c,
        `INSERT INTO customer_user(customer_id, full_name, email, phone, designation, portal_role, phone_verified_at, terms_version, terms_accepted_at, privacy_consent_version, privacy_consent_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(), $7, now(), $7, now()) RETURNING *`,
        [customer.id, body.fullName, body.email, cba.registeredPhone, body.designation, hasPrimary ? 'DELEGATE' : 'PRIMARY', body.termsVersion],
      );
      await q(c, `UPDATE onboarding_journey SET step='COMPLETED', completed_customer_user_id=$2 WHERE id=$1`, [j.id, user.id]);
      await recordStep(c, 'ONBOARDING', j.id, customer.id, 'PROFILE', 'COMPLETED');
      await recordStep(c, 'ONBOARDING', j.id, customer.id, 'COMPLETE', 'COMPLETED');
      const session = await createSession(c, { subjectType: 'CUSTOMER', subjectId: user.id, mfaSatisfied: true, ip: req.ip, userAgent: req.headers['user-agent'] });
      const emailOtp = await issueOtp(c, { purpose: 'EMAIL_VERIFY', subjectKey: hmac(user.id, 'cu'), channel: 'EMAIL', destinationMasked: maskEmail(user.email), ip: req.ip });
      await audit(c, { ...actor, type: 'CUSTOMER', id: user.id, label: user.full_name }, { action: 'CUSTOMER_USER_REGISTERED', entityType: 'customer_user', entityId: user.id, customerId: customer.id, metadata: { termsVersion: body.termsVersion, privacyConsent: true, role: user.portal_role } });
      return { session, user, emailOtp };
    });
    await dispatchOtp('EMAIL', result.user.email, result.emailOtp.code, 'email verification');
    reply.clearCookie(ONB_COOKIE, { path: '/' });
    setSessionCookie(reply, result.session.token);
    return ok(reply, { csrfToken: result.session.csrfToken, emailVerificationChallengeId: result.emailOtp.challengeId, emailVerificationSentTo: maskEmail(result.user.email) }, 201);
  });

  // ---------------------------------------------------------------------------
  // Customer email verification
  // ---------------------------------------------------------------------------
  app.post('/api/auth/customer/email/send', { config: AUTH_LIMIT }, async (req, reply) => {
    const cu = requireCustomer(req);
    if (cu.emailVerified) throw conflict('ALREADY_VERIFIED', 'Your email address is already verified.');
    const otp = await issueOtp(db, { purpose: 'EMAIL_VERIFY', subjectKey: hmac(cu.userId, 'cu'), channel: 'EMAIL', destinationMasked: maskEmail(cu.email), ip: req.ip });
    await dispatchOtp('EMAIL', cu.email, otp.code, 'email verification');
    return ok(reply, { challengeId: otp.challengeId, sentTo: maskEmail(cu.email) });
  });

  app.post('/api/auth/customer/email/verify', { config: AUTH_LIMIT }, async (req, reply) => {
    const cu = requireCustomer(req);
    const body = parse(z.object({ challengeId: z.uuid(), code: otpCode }), req.body);
    const r = await tx(async (c) => {
      const res = await verifyOtp(c, { challengeId: body.challengeId, purpose: 'EMAIL_VERIFY', subjectKey: hmac(cu.userId, 'cu'), code: body.code });
      if (res.ok) await q(c, 'UPDATE customer_user SET email_verified_at=now() WHERE id=$1', [cu.userId]);
      await audit(c, actorOf(req), { action: res.ok ? 'EMAIL_VERIFIED' : 'OTP_FAILED', entityType: 'customer_user', entityId: cu.userId, customerId: cu.customerId, outcome: res.ok ? 'SUCCESS' : 'FAILURE' });
      return res;
    });
    if (!r.ok) throw unprocessable(`OTP_${r.reason}`, OTP_MESSAGES[r.reason], { remainingAttempts: r.remaining });
    return ok(reply, { verified: true });
  });

  // ---------------------------------------------------------------------------
  // Customer sign-in (OTP to the phone registered on the core banking record)
  // ---------------------------------------------------------------------------
  app.post('/api/auth/customer/login/start', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ email: z.email().max(200).transform((s) => s.toLowerCase()) }), req.body);
    const user = await maybe<any>(db, `SELECT * FROM customer_user WHERE lower(email)=$1`, [body.email]);
    const subjectKey = hmac(body.email, 'login');
    // Enumeration resistance: identical response whether or not the user exists.
    const generic = { challengeId: undefined as string | undefined, message: 'If these details match a registered user, a sign-in code has been sent to the registered mobile number.' };
    if (!user || user.status !== 'ACTIVE' || (user.locked_until && new Date(user.locked_until) > new Date())) {
      await audit(db, actorOf(req), { action: 'LOGIN_START_REJECTED', entityType: 'customer_user', entityId: user?.id ?? null, outcome: 'FAILURE', metadata: { reason: !user ? 'unknown' : 'locked_or_inactive' } });
      generic.challengeId = (await import('node:crypto')).randomUUID();
      return ok(reply, generic);
    }
    const otp = await issueOtp(db, { purpose: 'LOGIN', subjectKey, channel: 'SMS', destinationMasked: maskPhone(user.phone), ip: req.ip });
    await dispatchOtp('SMS', user.phone, otp.code, 'sign-in');
    await audit(db, actorOf(req), { action: 'OTP_ISSUED', entityType: 'customer_user', entityId: user.id, customerId: user.customer_id, metadata: { purpose: 'LOGIN' } });
    generic.challengeId = otp.challengeId;
    return ok(reply, generic);
  });

  app.post('/api/auth/customer/login/verify', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ email: z.email().transform((s) => s.toLowerCase()), challengeId: z.uuid(), code: otpCode }), req.body);
    const result = await tx(async (c) => {
      const user = await maybe<any>(c, `SELECT * FROM customer_user WHERE lower(email)=$1 FOR UPDATE`, [body.email]);
      if (!user || user.status !== 'ACTIVE') return { error: 'INVALID' as const };
      if (user.locked_until && new Date(user.locked_until) > new Date()) return { error: 'LOCKED_ACCOUNT' as const };
      const r = await verifyOtp(c, { challengeId: body.challengeId, purpose: 'LOGIN', subjectKey: hmac(body.email, 'login'), code: body.code });
      await q(c, `INSERT INTO auth_attempt(subject_key, kind, ip, success) VALUES ($1,'CUSTOMER_LOGIN',$2,$3)`, [hmac(body.email, 'login'), req.ip, r.ok]);
      if (!r.ok) {
        const failed = user.failed_otp_count + 1;
        const lock = failed >= 5;
        await q(c, `UPDATE customer_user SET failed_otp_count=$2, locked_until = CASE WHEN $3 THEN now() + interval '30 minutes' ELSE locked_until END WHERE id=$1`, [user.id, lock ? 0 : failed, lock]);
        await audit(c, { ...actorOf(req), type: 'ANONYMOUS' }, { action: lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', entityType: 'customer_user', entityId: user.id, customerId: user.customer_id, outcome: 'FAILURE', metadata: { reason: r.reason } });
        return { error: lock ? ('LOCKED_ACCOUNT' as const) : r.reason };
      }
      await q(c, `UPDATE customer_user SET failed_otp_count=0, last_login_at=now() WHERE id=$1`, [user.id]);
      const s = await createSession(c, { subjectType: 'CUSTOMER', subjectId: user.id, mfaSatisfied: true, ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(c, { ...actorOf(req), type: 'CUSTOMER', id: user.id, label: user.full_name }, { action: 'LOGIN', entityType: 'customer_user', entityId: user.id, customerId: user.customer_id });
      return { session: s };
    });
    if ('error' in result) {
      if (result.error === 'LOCKED_ACCOUNT') throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Your sign-in is locked for 30 minutes.');
      throw unprocessable('OTP_INVALID', OTP_MESSAGES[(result.error === 'INVALID' ? 'NOT_FOUND' : result.error) as keyof typeof OTP_MESSAGES] ?? OTP_MESSAGES.INVALID);
    }
    setSessionCookie(reply, result.session.token);
    return ok(reply, { csrfToken: result.session.csrfToken });
  });

  // ---------------------------------------------------------------------------
  // Staff sign-in: Active Directory + TOTP MFA (never local passwords)
  // ---------------------------------------------------------------------------
  app.post('/api/auth/staff/login', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().trim().min(2).max(100), password: z.string().min(1).max(200) }), req.body);
    const generic = () => unauthorized('The username or password is incorrect, or your account is not enabled for Gazelle.');
    const user = await maybe<any>(db, `SELECT * FROM app_user WHERE lower(ad_username)=lower($1)`, [body.username]);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Sign-in is locked for 30 minutes.');
    const dir = await integrations().directory.authenticate(body.username, body.password);
    if (!dir || !user || user.status !== 'ACTIVE') {
      if (user) {
        const failed = user.failed_login_count + 1;
        const lock = failed >= 5;
        await q(db, `UPDATE app_user SET failed_login_count=$2, locked_until = CASE WHEN $3 THEN now() + interval '30 minutes' ELSE locked_until END WHERE id=$1`, [user.id, lock ? 0 : failed, lock]);
      }
      await audit(db, actorOf(req), { action: 'STAFF_LOGIN_FAILED', entityType: 'app_user', entityId: user?.id ?? null, outcome: 'FAILURE', metadata: { username: body.username.slice(0, 60) } });
      throw generic();
    }
    const s = await tx(async (c) => {
      await q(c, 'UPDATE app_user SET failed_login_count=0 WHERE id=$1', [user.id]);
      const sess = await createSession(c, { subjectType: 'STAFF', subjectId: user.id, mfaSatisfied: false, ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(c, { ...actorOf(req), type: 'STAFF', id: user.id, label: user.display_name }, { action: 'STAFF_PASSWORD_VERIFIED', entityType: 'app_user', entityId: user.id, metadata: { directoryMode: integrations().directory.mode } });
      return sess;
    });
    setSessionCookie(reply, s.token);
    if (!user.mfa_enrolled_at) {
      const secret = newTotpSecret();
      await q(db, 'UPDATE app_user SET mfa_pending_secret_enc=$2 WHERE id=$1', [user.id, encryptField(secret)]);
      return ok(reply, { mfa: 'ENROL', csrfToken: s.csrfToken, enrolment: { secret, uri: otpauthUri(secret, user.email) } });
    }
    return ok(reply, { mfa: 'VERIFY', csrfToken: s.csrfToken });
  });

  app.post('/api/auth/staff/mfa/verify', { config: AUTH_LIMIT }, async (req, reply) => {
    const a = req.auth;
    if (!a || a.subjectType !== 'STAFF') throw unauthorized();
    if (a.mfaSatisfied) throw conflict('MFA_DONE', 'Multi-factor authentication is already complete.');
    const body = parse(z.object({ code: otpCode }), req.body);
    const out = await tx(async (c) => {
      const u = await one<any>(c, 'SELECT * FROM app_user WHERE id=$1 FOR UPDATE', [a.subjectId]);
      const enrolling = !u.mfa_enrolled_at;
      const encSecret = enrolling ? u.mfa_pending_secret_enc : u.mfa_secret_enc;
      if (!encSecret) throw badRequest('MFA_NOT_READY', 'Sign in again to set up your authenticator.');
      const step = verifyTotp(decryptField(encSecret), body.code, u.mfa_last_step === null ? null : Number(u.mfa_last_step));
      await q(c, `INSERT INTO auth_attempt(subject_key, kind, ip, success) VALUES ($1,'STAFF_MFA',$2,$3)`, [u.id, req.ip, step !== null]);
      const recentFails = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM auth_attempt WHERE subject_key=$1 AND kind='STAFF_MFA' AND NOT success AND created_at > now() - interval '15 minutes'`, [u.id]);
      if (step === null) {
        if (recentFails.n >= 5) {
          await revokeSession(c, a.sessionId, 'mfa_failures');
          await q(c, `UPDATE app_user SET locked_until=now() + interval '30 minutes' WHERE id=$1`, [u.id]);
        }
        await audit(c, actorOf(req), { action: 'MFA_FAILED', entityType: 'app_user', entityId: u.id, outcome: 'FAILURE' });
        return null;
      }
      if (enrolling) await q(c, `UPDATE app_user SET mfa_secret_enc=mfa_pending_secret_enc, mfa_pending_secret_enc=NULL, mfa_enrolled_at=now() WHERE id=$1`, [u.id]);
      await q(c, 'UPDATE app_user SET mfa_last_step=$2, last_login_at=now() WHERE id=$1', [u.id, step]);
      // Rotate the session on privilege change (session fixation defence).
      await revokeSession(c, a.sessionId, 'rotated_after_mfa');
      const s = await createSession(c, { subjectType: 'STAFF', subjectId: u.id, mfaSatisfied: true, ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(c, actorOf(req), { action: enrolling ? 'MFA_ENROLLED' : 'LOGIN', entityType: 'app_user', entityId: u.id });
      return s;
    });
    if (!out) throw unprocessable('MFA_INVALID', 'The authenticator code is incorrect or has already been used.');
    setSessionCookie(reply, out.token);
    return ok(reply, { csrfToken: out.csrfToken });
  });

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------
  /** Session probe for the SPA: 200 with null when signed out (avoids noisy 401s before sign-in). */
  app.get('/api/auth/session', async (req, reply) => {
    if (!req.auth) return ok(reply, null);
    return reply.redirect('/api/auth/me', 307);
  });

  app.get('/api/auth/me', async (req, reply) => {
    const a = req.auth;
    if (!a) throw unauthorized();
    if (a.subjectType === 'STAFF') {
      return ok(reply, { type: 'STAFF', csrfToken: a.csrfToken, mfaSatisfied: a.mfaSatisfied, user: a.mfaSatisfied && a.staff ? { id: a.staff.id, name: a.staff.name, email: a.staff.email, roles: a.staff.roles, permissions: [...a.staff.permissions], businessUnit: a.staff.businessUnit } : null });
    }
    const c = a.customer!;
    const customer = await one<any>(db, 'SELECT id, customer_ref, legal_name FROM customer WHERE id=$1', [c.customerId]);
    return ok(reply, { type: 'CUSTOMER', csrfToken: a.csrfToken, user: { id: c.userId, name: c.fullName, email: maskEmail(c.email), emailVerified: c.emailVerified }, customer: { id: customer.id, ref: customer.customer_ref, name: customer.legal_name } });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      await revokeSession(db, req.auth.sessionId, 'logout');
      await audit(db, actorOf(req), { action: 'LOGOUT', entityType: req.auth.subjectType === 'STAFF' ? 'app_user' : 'customer_user', entityId: req.auth.subjectId });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return ok(reply, { signedOut: true });
  });

  app.get('/api/auth/sessions', async (req, reply) => {
    const a = req.auth;
    if (!a || (a.subjectType === 'STAFF' && !a.mfaSatisfied)) throw unauthorized();
    const rows = await q(db, `SELECT id, device_label, ip::text AS ip, created_at, last_seen_at FROM auth_session WHERE subject_type=$1 AND subject_id=$2 AND revoked_at IS NULL AND idle_expires_at > now() ORDER BY last_seen_at DESC`, [a.subjectType, a.subjectId]);
    return ok(reply, rows.map((r: any) => ({ ...r, current: r.id === a.sessionId })));
  });

  app.delete('/api/auth/sessions/:id', async (req, reply) => {
    const a = req.auth;
    if (!a || (a.subjectType === 'STAFF' && !a.mfaSatisfied)) throw unauthorized();
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const s = await maybe<any>(db, 'SELECT * FROM auth_session WHERE id=$1 AND subject_type=$2 AND subject_id=$3', [id, a.subjectType, a.subjectId]);
    if (!s) throw notFound('Session');
    await revokeSession(db, id, 'user_revoked');
    await audit(db, actorOf(req), { action: 'SESSION_REVOKED', entityType: 'auth_session', entityId: id });
    return ok(reply, { revoked: true });
  });

  app.post('/api/auth/sessions/revoke-others', async (req, reply) => {
    const a = req.auth;
    if (!a || (a.subjectType === 'STAFF' && !a.mfaSatisfied)) throw unauthorized();
    await revokeAllFor(db, a.subjectType, a.subjectId, 'user_revoked_others', a.sessionId);
    await audit(db, actorOf(req), { action: 'SESSIONS_REVOKED', entityType: 'auth_session', metadata: { scope: 'others' } });
    return ok(reply, { revoked: true });
  });

  void forbidden; void requireStaff;
}
