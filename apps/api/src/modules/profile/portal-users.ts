import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getPool, maybe, one, q, tx } from '../../db/pool.js';
import { actorOf, ok, parse, requireCustomer, requireCustomerRight } from '../../http/context.js';
import { hmac, randomToken } from '../../lib/crypto.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { maskEmail, maskPhone } from '../../lib/mask.js';
import { integrations } from '../../integrations/index.js';
import { audit } from '../audit/audit.js';
import { getActive } from '../config/service.js';
import { issueOtp, verifyOtp, OTP_MESSAGES } from '../identity/otp.js';
import { checkPassword, hashPassword, verifyPassword, type PasswordPolicy } from '../identity/password.js';
import { createSession, revokeAllFor, SESSION_COOKIE } from '../identity/session.js';

/**
 * More than one portal user per business. The first user (who onboarded with the CBA company e-mail) holds every
 * right; users with MANAGE_USERS invite colleagues. Invitees prove their e-mail (single-use link), verify their
 * own mobile number by OTP, set a password and accept the terms. Rights:
 *   SUBMIT_REQUESTS — submit and resubmit facility requests
 *   RESPOND_TO_OFFERS — accept, reject or negotiate offers on behalf of the business
 *   MANAGE_USERS — invite, change and deactivate portal users
 * Every user can prepare drafts, upload documents, keep the profile up to date and exchange messages.
 */
export const PORTAL_RIGHTS = ['SUBMIT_REQUESTS', 'RESPOND_TO_OFFERS', 'MANAGE_USERS'] as const;
const right = z.enum(PORTAL_RIGHTS);
const INVITE_HOURS = 72;
const MAX_USERS = 25;
const phoneSchema = z.string().trim().transform((s) => s.replace(/[\s-]/g, '').replace(/^\+234/, '0')).pipe(z.string().regex(/^0[789][01][0-9]{8}$/, 'Enter a Nigerian mobile number, e.g. 0803 000 0000.'));

async function confirmPassword(db: any, userId: string, password: string) {
  const u = await one<any>(db, 'SELECT password_hash FROM customer_user WHERE id=$1', [userId]);
  if (!(await verifyPassword(password, u.password_hash))) throw new AppError(422, 'CURRENT_PASSWORD', 'Your password is incorrect.');
}

export async function portalUserRoutes(app: FastifyInstance) {
  const db = getPool();
  const LIMIT = { rateLimit: { max: env().AUTH_RATE_LIMIT_PER_15MIN, timeWindow: '15 minutes' } };

  app.get('/api/portal/users', async (req, reply) => {
    const cu = requireCustomer(req);
    const manage = cu.permissions.includes('MANAGE_USERS');
    const users = await q<any>(db, `SELECT id, full_name, email, phone, role_in_company, designation, portal_role, permissions, status, last_login_at, created_at FROM customer_user WHERE customer_id=$1 ORDER BY portal_role, full_name`, [cu.customerId]);
    const invites = manage ? await q<any>(db, `SELECT i.id, i.full_name, i.email, i.role_in_company, i.permissions, i.expires_at, i.created_at, u.full_name AS invited_by FROM customer_user_invite i JOIN customer_user u ON u.id=i.invited_by WHERE i.customer_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC`, [cu.customerId]) : [];
    return ok(reply, {
      canManage: manage,
      users: users.map((u) => ({ id: u.id, name: u.full_name, email: manage || u.id === cu.userId ? u.email : maskEmail(u.email), phone: manage ? maskPhone(u.phone) : undefined, roleInCompany: u.role_in_company ?? u.designation, primary: u.portal_role === 'PRIMARY', permissions: u.permissions, status: u.status, lastLoginAt: manage ? u.last_login_at : undefined, you: u.id === cu.userId })),
      invites: invites.map((i) => ({ id: i.id, name: i.full_name, email: i.email, roleInCompany: i.role_in_company, permissions: i.permissions, expiresAt: i.expires_at, expired: new Date(i.expires_at) < new Date(), invitedBy: i.invited_by, createdAt: i.created_at })),
    });
  });

  app.post('/api/portal/users/invites', { config: LIMIT }, async (req, reply) => {
    const cu = requireCustomerRight(req, 'MANAGE_USERS');
    const b = parse(z.object({
      fullName: z.string().trim().min(3).max(120), email: z.email().max(200).transform((s) => s.toLowerCase()), roleInCompany: z.string().trim().min(2).max(80),
      permissions: z.array(right).max(3).default([]), currentPassword: z.string().min(1).max(256),
    }), req.body);
    await confirmPassword(db, cu.userId, b.currentPassword);
    const out = await tx(async (c) => {
      await q(c, `UPDATE customer_user_invite SET revoked_at=now() WHERE lower(email)=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at < now()`, [b.email]);
      if (await maybe(c, 'SELECT 1 FROM customer_user WHERE lower(email)=$1', [b.email])) throw conflict('EMAIL_IN_USE', 'This e-mail address already has Gazelle access.');
      if (await maybe(c, `SELECT 1 FROM customer_user_invite WHERE lower(email)=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, [b.email])) throw conflict('ALREADY_INVITED', 'An invitation to this e-mail address is already open. Revoke it to send a new one.');
      const n = await one<{ n: number }>(c, `SELECT (SELECT count(*) FROM customer_user WHERE customer_id=$1 AND status='ACTIVE') + (SELECT count(*) FROM customer_user_invite WHERE customer_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL) AS n`, [cu.customerId]);
      if (Number(n.n) >= MAX_USERS) throw unprocessable('USER_LIMIT', `A business can have at most ${MAX_USERS} portal users and open invitations.`);
      const token = randomToken(32);
      const inv = await one<any>(c, `INSERT INTO customer_user_invite(customer_id, email, full_name, role_in_company, permissions, token_hash, expires_at, invited_by) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7), $8) RETURNING id`,
        [cu.customerId, b.email, b.fullName, b.roleInCompany, [...new Set(b.permissions)], hmac(token, 'portal-invite'), INVITE_HOURS, cu.userId]);
      await audit(c, actorOf(req), { action: 'PORTAL_USER_INVITED', entityType: 'customer_user_invite', entityId: inv.id, customerId: cu.customerId, metadata: { email: maskEmail(b.email), permissions: b.permissions } });
      const biz = await one<any>(c, 'SELECT legal_name FROM customer WHERE id=$1', [cu.customerId]);
      return { id: inv.id, token, business: biz.legal_name };
    });
    const link = `${env().WEB_ORIGIN}/invite?token=${out.token}`;
    await integrations().messaging.sendEmail(b.email, `Invitation to Gazelle by Alternative Bank — ${out.business}`,
      `Dear ${b.fullName},\n\n${cu.fullName} has invited you to use Gazelle by Alternative Bank for ${out.business}. Accept within ${INVITE_HOURS} hours using this link:\n${link}\n\nYou will verify your mobile number and set a password. If you did not expect this, ignore this e-mail. The Bank will never ask for your password or a verification code.`);
    return ok(reply, { id: out.id, sentTo: maskEmail(b.email), expiresInHours: INVITE_HOURS }, 201);
  });

  app.post('/api/portal/users/invites/:iid/revoke', async (req, reply) => {
    const cu = requireCustomerRight(req, 'MANAGE_USERS');
    const { iid } = parse(z.object({ iid: z.uuid() }), req.params);
    const r = await q(db, `UPDATE customer_user_invite SET revoked_at=now() WHERE id=$1 AND customer_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [iid, cu.customerId]);
    if (!r.length) throw notFound('Invitation');
    await audit(db, actorOf(req), { action: 'PORTAL_INVITE_REVOKED', entityType: 'customer_user_invite', entityId: iid, customerId: cu.customerId });
    return ok(reply, { revoked: true });
  });

  /** Change another user's rights or status. The business always keeps at least one active user who can manage users. */
  app.patch('/api/portal/users/:uid', { config: LIMIT }, async (req, reply) => {
    const cu = requireCustomerRight(req, 'MANAGE_USERS');
    const { uid } = parse(z.object({ uid: z.uuid() }), req.params);
    const b = parse(z.object({ permissions: z.array(right).max(3).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), currentPassword: z.string().min(1).max(256) }), req.body);
    if (uid === cu.userId) throw forbidden('You cannot change your own access. Ask another user administrator.');
    await confirmPassword(db, cu.userId, b.currentPassword);
    await tx(async (c) => {
      const u = await maybe<any>(c, 'SELECT * FROM customer_user WHERE id=$1 AND customer_id=$2 FOR UPDATE', [uid, cu.customerId]);
      if (!u) throw notFound('User');
      const perms = b.permissions ? [...new Set(b.permissions)] : u.permissions;
      const status = b.status ?? u.status;
      const managers = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM customer_user WHERE customer_id=$1 AND status='ACTIVE' AND 'MANAGE_USERS' = ANY(permissions) AND id<>$2`, [cu.customerId, uid]);
      if (managers.n === 0 && !(status === 'ACTIVE' && perms.includes('MANAGE_USERS'))) throw conflict('LAST_MANAGER', 'The business must keep at least one active user who can manage users.');
      await q(c, 'UPDATE customer_user SET permissions=$2, status=$3 WHERE id=$1', [uid, perms, status]);
      if (status !== 'ACTIVE' || perms.length < u.permissions.length || perms.some((p: string) => !u.permissions.includes(p))) await revokeAllFor(c, 'CUSTOMER', uid, 'portal_access_changed');
      await audit(c, actorOf(req), { action: status !== u.status ? (status === 'ACTIVE' ? 'PORTAL_USER_REACTIVATED' : 'PORTAL_USER_DEACTIVATED') : 'PORTAL_USER_RIGHTS_CHANGED', entityType: 'customer_user', entityId: uid, customerId: cu.customerId, before: { permissions: u.permissions, status: u.status }, after: { permissions: perms, status } });
    });
    return ok(reply, { updated: true });
  });

  // -------------------------------------------------------------------------
  // Accepting an invitation (public; the link proves control of the e-mail address)
  // -------------------------------------------------------------------------
  async function liveInvite(c: any, token: string, lock = false) {
    const i = await maybe<any>(c, `SELECT i.*, cu.legal_name, cu.status AS customer_status FROM customer_user_invite i JOIN customer cu ON cu.id=i.customer_id WHERE i.token_hash=$1 ${lock ? 'FOR UPDATE OF i' : ''}`, [hmac(token, 'portal-invite')]);
    if (!i || i.accepted_at || i.revoked_at || new Date(i.expires_at) < new Date() || i.customer_status === 'SUSPENDED') return null;
    return i;
  }
  const invalid = () => unprocessable('INVITE_INVALID', 'This invitation is invalid, has expired or has been withdrawn. Ask your colleague to send a new one.');
  const tokenSchema = z.string().min(20).max(100);

  app.get('/api/portal-invites', { config: LIMIT }, async (req, reply) => {
    const { token } = parse(z.object({ token: tokenSchema }), req.query);
    const i = await liveInvite(db, token);
    if (!i) throw invalid();
    const terms = await getActive(db, 'legal_terms', 'CUSTOMER_PORTAL');
    const policy = (await getActive(db, 'password_policy', 'CUSTOMER_PORTAL'))?.payload ?? null;
    return ok(reply, { business: i.legal_name, name: i.full_name, email: i.email, roleInCompany: i.role_in_company, permissions: i.permissions, phoneSentTo: i.phone ? maskPhone(i.phone) : null, passwordPolicy: policy, terms: terms ? { version: terms.payload.version, termsText: terms.payload.termsText, privacyText: terms.payload.privacyText } : null });
  });

  app.post('/api/portal-invites/phone', { config: LIMIT }, async (req, reply) => {
    const b = parse(z.object({ token: tokenSchema, phone: phoneSchema }), req.body);
    const out = await tx(async (c) => {
      const i = await liveInvite(c, b.token, true);
      if (!i) throw invalid();
      const otp = await issueOtp(c, { purpose: 'PHONE_VERIFY', subjectKey: hmac(i.id, 'portal-invite-phone'), channel: 'SMS', destinationMasked: maskPhone(b.phone), ip: req.ip });
      await q(c, 'UPDATE customer_user_invite SET phone=$2, otp_challenge_id=$3 WHERE id=$1', [i.id, b.phone, otp.challengeId]);
      return otp;
    });
    await integrations().messaging.sendSms(b.phone, `Your Gazelle by Alternative Bank verification code is ${out.code}. It expires in ${Math.round(env().OTP_TTL_SECONDS / 60)} minutes. Never share this code; the Bank will never ask for it.`);
    return ok(reply, { otpSentTo: maskPhone(b.phone), expiresInSeconds: env().OTP_TTL_SECONDS });
  });

  app.post('/api/portal-invites/accept', { config: LIMIT }, async (req, reply) => {
    const b = parse(z.object({
      token: tokenSchema, code: z.string().trim().regex(/^[0-9]{6}$/, 'Enter the 6-digit code.'), password: z.string().min(1).max(256),
      acceptTerms: z.literal(true, { error: 'You must accept the terms to continue.' }), privacyConsent: z.literal(true, { error: 'Consent to the data privacy terms is required.' }), termsVersion: z.string().min(1).max(40),
    }), req.body);
    const terms = await getActive(db, 'legal_terms', 'CUSTOMER_PORTAL');
    if (!terms || terms.payload.version !== b.termsVersion) throw conflict('TERMS_CHANGED', 'The terms have been updated. Please review the current version.');
    const policy = (await getActive(db, 'password_policy', 'CUSTOMER_PORTAL'))?.payload as PasswordPolicy | undefined;
    if (!policy) throw conflict('NO_PASSWORD_POLICY', 'Sign-up is temporarily unavailable. Please try again later.');
    const pre = await liveInvite(db, b.token);
    if (!pre) throw invalid();
    const issues = checkPassword(policy, b.password, [pre.full_name, pre.email, pre.legal_name]);
    if (issues.length) throw unprocessable('PASSWORD_POLICY', 'Your password does not meet the Bank’s requirements.', { unmet: issues });
    const hash = await hashPassword(b.password);
    const result = await tx(async (c) => {
      const i = await liveInvite(c, b.token, true);
      if (!i) throw invalid();
      if (!i.otp_challenge_id || !i.phone) throw conflict('PHONE_FIRST', 'Verify your mobile number first.');
      const r = await verifyOtp(c, { challengeId: i.otp_challenge_id, purpose: 'PHONE_VERIFY', subjectKey: hmac(i.id, 'portal-invite-phone'), code: b.code });
      if (!r.ok) return { error: r };
      if (await maybe(c, 'SELECT 1 FROM customer_user WHERE lower(email)=lower($1)', [i.email])) throw conflict('EMAIL_IN_USE', 'This e-mail address already has Gazelle access.');
      const user = await one<any>(c, `INSERT INTO customer_user(customer_id, full_name, email, phone, designation, role_in_company, portal_role, permissions, invited_by, email_verified_at, phone_verified_at, password_hash, password_changed_at, terms_version, terms_accepted_at, privacy_consent_version, privacy_consent_at)
        VALUES ($1,$2,$3,$4,$5,$5,'DELEGATE',$6,$7, now(), now(), $8, now(), $9, now(), $9, now()) RETURNING *`, [i.customer_id, i.full_name, i.email.toLowerCase(), i.phone, i.role_in_company, i.permissions, i.invited_by, hash, b.termsVersion]);
      await q(c, 'UPDATE customer_user_invite SET accepted_at=now(), accepted_user_id=$2 WHERE id=$1', [i.id, user.id]);
      await audit(c, { ...actorOf(req), type: 'CUSTOMER', id: user.id, label: user.full_name }, { action: 'PORTAL_USER_JOINED', entityType: 'customer_user', entityId: user.id, customerId: i.customer_id, metadata: { invite: i.id, permissions: i.permissions, termsVersion: b.termsVersion } });
      const s = await createSession(c, { subjectType: 'CUSTOMER', subjectId: user.id, mfaSatisfied: true, ip: req.ip, userAgent: req.headers['user-agent'] });
      return { session: s, user };
    });
    if ('error' in result) { const e = result.error as any; throw unprocessable(`OTP_${e.reason}`, OTP_MESSAGES[e.reason as keyof typeof OTP_MESSAGES], { remainingAttempts: e.remaining }); }
    reply.setCookie(SESSION_COOKIE, result.session.token, { httpOnly: true, secure: env().COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: env().SESSION_ABSOLUTE_HOURS * 3600 });
    return ok(reply, { csrfToken: result.session.csrfToken, username: result.user.email }, 201);
  });
}
