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
import { createSession, enforceSingleSession, revokeAllFor, revokeSession, SESSION_COOKIE, sessionPolicy, type AuthContext } from './session.js';
import { checkPassword, hashPassword, verifyPassword, type PasswordPolicy } from './password.js';
import { changePassword, issueStaffLink, localStaffAuth, passwordExpired, setPasswordWithToken, staffPolicy, tokenInfo } from './staff-credentials.js';
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
  // Onboarding — existing Alternative Bank account holders (SWR §1)
  //  1. Account number, the applicant's name and role in the company.
  //  2. Account validated on the CBA; a 6-digit OTP goes to the phone AND e-mail registered on the CBA.
  //  3. After the OTP, the account name is shown and the user creates a password; the username is the
  //     company e-mail registered on the CBA (never typed by the user).
  //  4. Terms & data privacy accepted; a welcome e-mail with a verification link is sent.
  // ---------------------------------------------------------------------------
  const GENERIC_START = 'If the account can be verified, a verification code has been sent to the phone number and e-mail address registered with the Bank.';

  async function sendOnboardingOtp(c: any, cba: any, subjectKey: string, ip: string) {
    const masked = [maskPhone(cba.registeredPhone), cba.registeredEmail ? maskEmail(cba.registeredEmail) : null].filter(Boolean).join(' and ');
    return issueOtp(c, { purpose: 'ONBOARDING', subjectKey, channel: 'SMS', destinationMasked: masked, ip });
  }
  async function deliverOnboardingOtp(cba: any, code: string) {
    await dispatchOtp('SMS', cba.registeredPhone, code, 'verification');
    if (cba.registeredEmail) await dispatchOtp('EMAIL', cba.registeredEmail, code, 'verification');
  }
  const sentTo = (cba: any) => ({ phone: maskPhone(cba.registeredPhone), email: cba.registeredEmail ? maskEmail(cba.registeredEmail) : null });

  app.get('/api/onboarding/password-policy', async (_req, reply) => {
    const p = (await getActive(db, 'password_policy', 'CUSTOMER_PORTAL'))?.payload as PasswordPolicy | undefined;
    return ok(reply, p ?? null);
  });

  app.post('/api/onboarding/start', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({
      accountNumber,
      fullName: z.string().trim().min(3, 'Enter your full name.').max(120),
      roleInCompany: z.string().trim().min(2, 'Enter your role in the company.').max(80),
    }), req.body);
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
      throw unprocessable('NOT_CORPORATE', 'Gazelle serves corporate, commercial and institutional customers. You must have an Alternative Bank business account to sign up.');
    }
    if (account.status === 'PND' || account.status === 'DORMANT') {
      throw unprocessable('ACCOUNT_RESTRICTED', 'This account has a restriction. Please contact your relationship manager before continuing.');
    }
    const out = await tx(async (c) => {
      const otp = await sendOnboardingOtp(c, cba, acctKey, req.ip);
      const token = randomToken();
      await q(c, `UPDATE onboarding_journey SET step='ABANDONED' WHERE account_number_hash=$1 AND step NOT IN ('COMPLETED','ABANDONED')`, [acctKey]);
      const j = await one<{ id: string }>(
        c,
        `INSERT INTO onboarding_journey(token_hash, account_number_hash, cba_customer_id, step, otp_challenge_id, cba_snapshot, ip, expires_at, applicant_name, applicant_role)
         VALUES ($1,$2,$3,'ACCOUNT_VERIFIED',$4,$5,$6, now() + interval '30 minutes', $7, $8) RETURNING id`,
        [hmac(token, 'onboarding'), acctKey, cba.cbaCustomerId, otp.challengeId, JSON.stringify(cba), req.ip, body.fullName, body.roleInCompany],
      );
      await recordStep(c, 'ONBOARDING', j.id, null, 'ACCOUNT', 'COMPLETED');
      await recordStep(c, 'ONBOARDING', j.id, null, 'OTP', 'ENTERED');
      await audit(c, actor, { action: 'OTP_ISSUED', entityType: 'onboarding_journey', entityId: j.id, metadata: { purpose: 'ONBOARDING', channels: cba.registeredEmail ? ['SMS', 'EMAIL'] : ['SMS'] } });
      return { token, otp };
    });
    await deliverOnboardingOtp(cba, out.otp.code);
    reply.setCookie(ONB_COOKIE, out.token, cookieOpts(1800));
    // SWR technology control 2: the name enquiry is generic — the account name is shown only after the OTP proves control.
    return ok(reply, { message: GENERIC_START, otpSentTo: sentTo(cba), expiresInSeconds: env().OTP_TTL_SECONDS });
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
      const o = await sendOnboardingOtp(c, cba, j.account_number_hash, req.ip);
      await q(c, 'UPDATE onboarding_journey SET otp_challenge_id=$2 WHERE id=$1', [j.id, o.challengeId]);
      await audit(c, actorOf(req), { action: 'OTP_RESENT', entityType: 'onboarding_journey', entityId: j.id });
      return o;
    });
    await deliverOnboardingOtp(cba, otp.code);
    return ok(reply, { otpSentTo: sentTo(cba), expiresInSeconds: env().OTP_TTL_SECONDS });
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
    const registered = existing ? await maybe(db, 'SELECT 1 FROM customer_user WHERE customer_id=$1', [existing.id]) : undefined;
    const terms = await getActive(db, 'legal_terms', 'CUSTOMER_PORTAL');
    const policy = (await getActive(db, 'password_policy', 'CUSTOMER_PORTAL'))?.payload ?? null;
    const primary = cba.accounts.find((a: any) => a.currency === 'NGN') ?? cba.accounts[0];
    return ok(reply, {
      business: {
        name: cba.businessName,
        accountName: primary?.accountName ?? cba.businessName,
        rcNumber: cba.rcNumber ?? null,
        tin: cba.tin ? `••••••••${cba.tin.slice(-4)}` : null,
        incorporationDate: cba.incorporationDate ?? null,
        address: [cba.address, cba.city, cba.state].filter(Boolean).join(', '),
        accounts: cba.accounts.map((a: any) => ({ account: maskAccount(a.accountNumber), currency: a.currency, product: a.productName })),
        registeredPhone: maskPhone(cba.registeredPhone),
      },
      applicant: { name: j.applicant_name, roleInCompany: j.applicant_role },
      // The username is the company e-mail on the core banking record. Shown in full only now that the OTP sent to it has been entered.
      username: cba.registeredEmail ?? null,
      alreadyOnGazelle: !!registered,
      passwordPolicy: policy,
      terms: terms ? { version: terms.payload.version, termsText: terms.payload.termsText, privacyText: terms.payload.privacyText } : null,
    });
  });

  app.post('/api/onboarding/complete', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(
      z.object({
        password: z.string().min(1).max(256),
        acceptTerms: z.literal(true, { error: 'You must accept the terms to continue.' }),
        privacyConsent: z.literal(true, { error: 'Consent to the data privacy terms is required.' }),
        termsVersion: z.string().min(1).max(40),
      }),
      req.body,
    );
    const j = await loadJourney(req);
    if (j.step !== 'OTP_VERIFIED') throw conflict('STEP', 'Verify your account first.');
    const terms = await getActive(db, 'legal_terms', 'CUSTOMER_PORTAL');
    if (!terms || terms.payload.version !== body.termsVersion) throw conflict('TERMS_CHANGED', 'The terms have been updated. Please review the current version.');
    const cba = j.cba_snapshot;
    if (!cba.registeredEmail) throw unprocessable('NO_REGISTERED_EMAIL', 'The Bank does not hold a company e-mail address for this account. Please update it with your relationship manager or branch, then try again.');
    const email = String(cba.registeredEmail).toLowerCase();
    // Tell a second person straight away that the business is already registered (they need an invitation).
    const existingBiz = await maybe<{ id: string }>(db, 'SELECT id FROM customer WHERE cba_customer_id=$1', [cba.cbaCustomerId]);
    if ((existingBiz && (await maybe(db, 'SELECT 1 FROM customer_user WHERE customer_id=$1', [existingBiz.id]))) || (await maybe(db, 'SELECT 1 FROM customer_user WHERE lower(email)=$1', [email]))) {
      throw conflict('ALREADY_REGISTERED', 'This business is already registered on Gazelle. Sign in, or ask a colleague who manages your business’s Gazelle users to invite you.');
    }
    const policy = (await getActive(db, 'password_policy', 'CUSTOMER_PORTAL'))?.payload as PasswordPolicy | undefined;
    if (!policy) throw conflict('NO_PASSWORD_POLICY', 'Sign-up is temporarily unavailable. Please try again later.');
    const issues = checkPassword(policy, body.password, [j.applicant_name ?? '', email, cba.businessName ?? '']);
    if (issues.length) throw unprocessable('PASSWORD_POLICY', 'Your password does not meet the Bank’s requirements.', { unmet: issues });
    const passwordHash = await hashPassword(body.password);
    const result = await tx(async (c) => {
      let customer = await maybe<any>(c, 'SELECT * FROM customer WHERE cba_customer_id=$1 FOR UPDATE', [cba.cbaCustomerId]);
      if (customer && (await maybe(c, 'SELECT 1 FROM customer_user WHERE customer_id=$1', [customer.id]))) throw conflict('ALREADY_REGISTERED', 'This business is already registered on Gazelle. Sign in, or ask a colleague who manages your business’s Gazelle users to invite you.');
      if (await maybe(c, 'SELECT 1 FROM customer_user WHERE lower(email)=$1', [email])) throw conflict('ALREADY_REGISTERED', 'This business is already registered on Gazelle. Sign in, or ask a colleague who manages your business’s Gazelle users to invite you.');
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
      const user = await one<any>(
        c,
        `INSERT INTO customer_user(customer_id, full_name, email, phone, designation, role_in_company, portal_role, phone_verified_at, password_hash, password_changed_at, terms_version, terms_accepted_at, privacy_consent_version, privacy_consent_at)
         VALUES ($1,$2,$3,$4,$5,$5,'PRIMARY', now(), $6, now(), $7, now(), $7, now()) RETURNING *`,
        [customer.id, j.applicant_name, email, cba.registeredPhone, j.applicant_role, passwordHash, body.termsVersion],
      );
      await q(c, `UPDATE onboarding_journey SET step='COMPLETED', completed_customer_user_id=$2 WHERE id=$1`, [j.id, user.id]);
      await recordStep(c, 'ONBOARDING', j.id, customer.id, 'PROFILE', 'COMPLETED');
      await recordStep(c, 'ONBOARDING', j.id, customer.id, 'COMPLETE', 'COMPLETED');
      const session = await createSession(c, { subjectType: 'CUSTOMER', subjectId: user.id, mfaSatisfied: true, ip: req.ip, userAgent: req.headers['user-agent'] });
      const link = await issueVerificationLink(c, user.id);
      await audit(c, { ...actor, type: 'CUSTOMER', id: user.id, label: user.full_name }, { action: 'CUSTOMER_USER_REGISTERED', entityType: 'customer_user', entityId: user.id, customerId: customer.id, metadata: { termsVersion: body.termsVersion, privacyConsent: true, role: user.portal_role } });
      return { session, user, link };
    });
    await sendWelcomeEmail(result.user, result.link);
    reply.clearCookie(ONB_COOKIE, { path: '/' });
    setSessionCookie(reply, result.session.token);
    return ok(reply, { csrfToken: result.session.csrfToken, username: result.user.email, welcomeEmailSentTo: maskEmail(result.user.email) }, 201);
  });

  // ---------------------------------------------------------------------------
  // Welcome e-mail with a verification link (SWR §1)
  // ---------------------------------------------------------------------------
  async function issueVerificationLink(c: any, userId: string) {
    const token = randomToken(32);
    await q(c, `UPDATE email_verification SET consumed_at=now() WHERE customer_user_id=$1 AND consumed_at IS NULL`, [userId]);
    await q(c, `INSERT INTO email_verification(customer_user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '48 hours')`, [userId, hmac(token, 'email-verify')]);
    return `${env().WEB_ORIGIN}/verify-email?token=${token}`;
  }
  async function sendWelcomeEmail(user: any, link: string) {
    const text = `Welcome to Gazelle by Alternative Bank, ${user.full_name}.\n\nYour username is ${user.email}. Confirm this e-mail address and open the portal using this link (valid for 48 hours):\n${link}\n\nIf you did not sign up, contact your relationship manager. The Bank will never ask for your password or a verification code.`;
    await integrations().messaging.sendEmail(user.email, 'Welcome to Gazelle by Alternative Bank — confirm your e-mail', text);
  }

  app.post('/api/auth/customer/email/send', { config: AUTH_LIMIT }, async (req, reply) => {
    const cu = requireCustomer(req);
    if (cu.emailVerified) throw conflict('ALREADY_VERIFIED', 'Your email address is already verified.');
    const recent = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM email_verification WHERE customer_user_id=$1 AND created_at > now() - interval '15 minutes'`, [cu.userId]);
    if (recent.n >= 3) throw new AppError(429, 'RATE_LIMITED', 'A verification link was sent recently. Check your inbox or try again in 15 minutes.');
    const user = await one<any>(db, 'SELECT * FROM customer_user WHERE id=$1', [cu.userId]);
    const link = await tx((c) => issueVerificationLink(c, cu.userId));
    await sendWelcomeEmail(user, link);
    return ok(reply, { sentTo: maskEmail(cu.email) });
  });

  /** Public: the link in the welcome e-mail. Single use, expires after 48 hours. */
  app.post('/api/auth/customer/email/verify-link', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(100) }), req.body);
    const ok_ = await tx(async (c) => {
      const v = await maybe<any>(c, `SELECT * FROM email_verification WHERE token_hash=$1 FOR UPDATE`, [hmac(body.token, 'email-verify')]);
      if (!v || v.consumed_at || new Date(v.expires_at) < new Date()) return false;
      await q(c, 'UPDATE email_verification SET consumed_at=now() WHERE id=$1', [v.id]);
      const u = await one<any>(c, 'UPDATE customer_user SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1 RETURNING id, customer_id, full_name', [v.customer_user_id]);
      await audit(c, { ...actorOf(req), type: 'CUSTOMER', id: u.id, label: u.full_name }, { action: 'EMAIL_VERIFIED', entityType: 'customer_user', entityId: u.id, customerId: u.customer_id });
      return true;
    });
    if (!ok_) throw unprocessable('LINK_INVALID', 'This verification link is invalid or has expired. Sign in and request a new link.');
    return ok(reply, { verified: true });
  });

  // ---------------------------------------------------------------------------
  // Customer sign-in: company e-mail + password, then a 6-digit OTP to the registered phone (two factors)
  // ---------------------------------------------------------------------------
  app.post('/api/auth/customer/login/start', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ email: z.email().max(200).transform((s) => s.toLowerCase()), password: z.string().min(1).max(256) }), req.body);
    const user = await maybe<any>(db, `SELECT u.*, c.status AS customer_status FROM customer_user u JOIN customer c ON c.id=u.customer_id WHERE lower(u.email)=$1`, [body.email]);
    const policy = ((await getActive(db, 'password_policy', 'CUSTOMER_PORTAL'))?.payload ?? { maxFailedAttempts: 5, lockMinutes: 30 }) as any;
    const generic = () => unauthorized('The e-mail address or password is incorrect.');
    if (user?.locked_until && new Date(user.locked_until) > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Your sign-in is locked for ${policy.lockMinutes} minutes.`);
    const passwordOk = await verifyPassword(body.password, user?.password_hash);
    if (!user || !passwordOk || user.status !== 'ACTIVE') {
      if (user && !passwordOk) {
        const failed = user.failed_password_count + 1;
        const lock = failed >= policy.maxFailedAttempts;
        await q(db, `UPDATE customer_user SET failed_password_count=$2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id=$1`, [user.id, lock ? 0 : failed, lock, policy.lockMinutes]);
        await audit(db, actorOf(req), { action: lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', entityType: 'customer_user', entityId: user.id, customerId: user.customer_id, outcome: 'FAILURE', metadata: { reason: 'password' } });
        if (lock) throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Your sign-in is locked for ${policy.lockMinutes} minutes.`);
      } else await audit(db, actorOf(req), { action: 'LOGIN_START_REJECTED', entityType: 'customer_user', entityId: user?.id ?? null, outcome: 'FAILURE', metadata: { reason: !user ? 'unknown' : 'inactive' } });
      throw generic();
    }
    if (user.customer_status === 'SUSPENDED') throw forbidden('Access to Gazelle for this business has been suspended. Please contact your relationship manager.');
    await q(db, 'UPDATE customer_user SET failed_password_count=0 WHERE id=$1', [user.id]);
    const otp = await issueOtp(db, { purpose: 'LOGIN', subjectKey: hmac(body.email, 'login'), channel: 'SMS', destinationMasked: maskPhone(user.phone), ip: req.ip });
    await dispatchOtp('SMS', user.phone, otp.code, 'sign-in');
    await audit(db, actorOf(req), { action: 'OTP_ISSUED', entityType: 'customer_user', entityId: user.id, customerId: user.customer_id, metadata: { purpose: 'LOGIN' } });
    return ok(reply, { challengeId: otp.challengeId, otpSentTo: maskPhone(user.phone) });
  });

  app.post('/api/auth/customer/login/verify', { config: AUTH_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ email: z.email().transform((s) => s.toLowerCase()), challengeId: z.uuid(), code: otpCode }), req.body);
    const result = await tx(async (c) => {
      const user = await maybe<any>(c, `SELECT u.*, cu.status AS customer_status FROM customer_user u JOIN customer cu ON cu.id=u.customer_id WHERE lower(u.email)=$1 FOR UPDATE OF u`, [body.email]);
      if (!user || user.status !== 'ACTIVE') return { error: 'INVALID' as const };
      if (user.customer_status === 'SUSPENDED') return { error: 'SUSPENDED' as const };
      if (user.locked_until && new Date(user.locked_until) > new Date()) return { error: 'LOCKED_ACCOUNT' as const };
      // The challenge is only ever issued after a correct password, and is bound to this e-mail.
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
      const replaced = await enforceSingleSession(c, 'CUSTOMER', user.id, s.id);
      await audit(c, { ...actorOf(req), type: 'CUSTOMER', id: user.id, label: user.full_name }, { action: 'LOGIN', entityType: 'customer_user', entityId: user.id, customerId: user.customer_id, metadata: { otherSessionsEnded: replaced } });
      return { session: s };
    });
    if ('error' in result) {
      if (result.error === 'LOCKED_ACCOUNT') throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Your sign-in is locked for 30 minutes.');
      if (result.error === 'SUSPENDED') throw forbidden('Access to Gazelle for this business has been suspended. Please contact your relationship manager.');
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
    // Directory (AD) sign-in is the target; `local` is the interim Gazelle password until AD authentication is available.
    const local = localStaffAuth();
    const policy = local ? await staffPolicy(db) : { maxFailedAttempts: 5, lockMinutes: 30, maxAgeDays: 0 };
    const verified = local ? await verifyPassword(body.password, user?.password_hash) : !!(await integrations().directory.authenticate(body.username, body.password));
    if (!verified || !user || user.status !== 'ACTIVE') {
      if (user) {
        const failed = user.failed_login_count + 1;
        const lock = failed >= policy.maxFailedAttempts;
        await q(db, `UPDATE app_user SET failed_login_count=$2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id=$1`, [user.id, lock ? 0 : failed, lock, policy.lockMinutes]);
      }
      await audit(db, actorOf(req), { action: 'STAFF_LOGIN_FAILED', entityType: 'app_user', entityId: user?.id ?? null, outcome: 'FAILURE', metadata: { username: body.username.slice(0, 60) } });
      throw generic();
    }
    if (local && passwordExpired(policy, user.password_changed_at)) {
      const link = await tx((c) => issueStaffLink(c, actorOf(req), user.id, 'RESET'));
      await link.send();
      throw new AppError(403, 'PASSWORD_EXPIRED', `Your password has expired. A link to set a new one has been sent to ${link.sentTo}.`);
    }
    const s = await tx(async (c) => {
      await q(c, 'UPDATE app_user SET failed_login_count=0 WHERE id=$1', [user.id]);
      const sess = await createSession(c, { subjectType: 'STAFF', subjectId: user.id, mfaSatisfied: false, ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(c, { ...actorOf(req), type: 'STAFF', id: user.id, label: user.display_name }, { action: 'STAFF_PASSWORD_VERIFIED', entityType: 'app_user', entityId: user.id, metadata: local ? { staffAuthMode: 'local' } : { directoryMode: integrations().directory.mode } });
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

  // ---------------------------------------------------------------------------
  // Interim staff passwords (STAFF_AUTH_MODE=local): set via single-use e-mailed links; never chosen by administrators.
  // ---------------------------------------------------------------------------
  const requireLocal = () => { if (!localStaffAuth()) throw notFound('Route'); };

  app.get('/api/auth/staff/password/link', { config: AUTH_LIMIT }, async (req, reply) => {
    requireLocal();
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.query);
    const info = await tokenInfo(db, token);
    if (!info) throw unprocessable('LINK_INVALID', 'This link is invalid or has expired. Ask for a new one from the sign-in page or your administrator.');
    const { maxFailedAttempts: _a, lockMinutes: _b, ...policy } = info.policy; void _a; void _b;
    return ok(reply, { purpose: info.purpose, username: info.username, policy });
  });

  app.post('/api/auth/staff/password/set', { config: AUTH_LIMIT }, async (req, reply) => {
    requireLocal();
    const b = parse(z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(256) }), req.body);
    const r = await tx((c) => setPasswordWithToken(c, actorOf(req), b.token, b.password));
    return ok(reply, { username: r.username, next: 'SIGN_IN' });
  });

  /** Self-service reset. Identical response whether or not the username exists. */
  app.post('/api/auth/staff/password/forgot', { config: AUTH_LIMIT }, async (req, reply) => {
    requireLocal();
    const b = parse(z.object({ username: z.string().trim().min(2).max(100) }), req.body);
    const u = await maybe<any>(db, `SELECT id FROM app_user WHERE lower(ad_username)=lower($1) AND status='ACTIVE'`, [b.username]);
    if (u) {
      const recent = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM staff_credential_token WHERE user_id=$1 AND created_at > now() - interval '1 hour'`, [u.id]);
      if (recent.n < 3) { const link = await tx((c) => issueStaffLink(c, actorOf(req), u.id, 'RESET')); await link.send(); }
    }
    return ok(reply, { message: 'If the username is registered, a link to set a new password has been sent to the work e-mail address on record.' });
  });

  app.post('/api/auth/staff/password/change', { config: AUTH_LIMIT }, async (req, reply) => {
    requireLocal();
    const st = requireStaff(req);
    const b = parse(z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }), req.body);
    await tx((c) => changePassword(c, actorOf(req), st.id, b.currentPassword, b.newPassword));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return ok(reply, { changed: true, next: 'SIGN_IN' });
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
      // PRD / SWR: one active session per user — a new fully-authenticated sign-in ends the others.
      const replaced = await enforceSingleSession(c, 'STAFF', u.id, s.id);
      await audit(c, actorOf(req), { action: enrolling ? 'MFA_ENROLLED' : 'LOGIN', entityType: 'app_user', entityId: u.id, metadata: { otherSessionsEnded: replaced } });
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
    const pref = await maybe<{ ui_theme: string }>(db, `SELECT ui_theme FROM ${a.subjectType === 'STAFF' ? 'app_user' : 'customer_user'} WHERE id=$1`, [a.subjectId]);
    const preferences = { theme: pref?.ui_theme ?? 'system' };
    if (a.subjectType === 'STAFF') {
      return ok(reply, { type: 'STAFF', csrfToken: a.csrfToken, mfaSatisfied: a.mfaSatisfied, preferences, user: a.mfaSatisfied && a.staff ? { id: a.staff.id, name: a.staff.name, email: a.staff.email, roles: a.staff.roles, permissions: [...a.staff.permissions], businessUnit: a.staff.businessUnit } : null });
    }
    const c = a.customer!;
    const customer = await one<any>(db, 'SELECT id, customer_ref, legal_name FROM customer WHERE id=$1', [c.customerId]);
    return ok(reply, { type: 'CUSTOMER', csrfToken: a.csrfToken, preferences, user: { id: c.userId, name: c.fullName, email: maskEmail(c.email), emailVerified: c.emailVerified, permissions: c.permissions, primary: c.portalRole === 'PRIMARY' }, customer: { id: customer.id, ref: customer.customer_ref, name: customer.legal_name } });
  });

  /** Display preferences saved on the user's account (theme follows the user between devices). */
  app.put('/api/me/preferences', async (req, reply) => {
    const a = req.auth;
    if (!a || (a.subjectType === 'STAFF' && !a.mfaSatisfied)) throw unauthorized();
    const b = parse(z.object({ theme: z.enum(['light', 'dark', 'system']) }), req.body);
    await q(db, `UPDATE ${a.subjectType === 'STAFF' ? 'app_user' : 'customer_user'} SET ui_theme=$2 WHERE id=$1`, [a.subjectId, b.theme]);
    return ok(reply, { theme: b.theme });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      await revokeSession(db, req.auth.sessionId, 'logout');
      await audit(db, actorOf(req), { action: 'LOGOUT', entityType: req.auth.subjectType === 'STAFF' ? 'app_user' : 'customer_user', entityId: req.auth.subjectId });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return ok(reply, { signedOut: true });
  });

  /** Session timing for the browser's inactivity warning. Passive: checking does not extend the session. */
  const sessionStatus = async (a: AuthContext) => {
    const p = await sessionPolicy(db, a.subjectType);
    return { idleExpiresAt: a.idleExpiresAt, absoluteExpiresAt: a.absoluteExpiresAt, serverTime: new Date(), idleMinutes: p.idleMinutes, warningSeconds: p.warningSeconds };
  };
  app.get('/api/auth/session/status', async (req, reply) => {
    if (!req.auth) throw unauthorized();
    return ok(reply, await sessionStatus(req.auth));
  });
  /** "Stay signed in": an explicit activity that slides the idle window (never past the maximum session length). */
  app.post('/api/auth/session/keep-alive', async (req, reply) => {
    if (!req.auth) throw unauthorized();
    return ok(reply, await sessionStatus(req.auth));
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
