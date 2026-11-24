import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { hmac, randomToken } from '../../lib/crypto.js';
import { maskEmail } from '../../lib/mask.js';
import { AppError, conflict, unprocessable } from '../../lib/errors.js';
import { integrations } from '../../integrations/index.js';
import { audit, type Actor } from '../audit/audit.js';
import { getActive } from '../config/service.js';
import { checkPassword, hashPassword, verifyPassword, type PasswordPolicy } from './password.js';
import { revokeAllFor } from './session.js';

/**
 * Interim staff credentials (STAFF_AUTH_MODE=local) until Active Directory authentication is available.
 * Nobody — including administrators — ever sees or chooses another person's password: the staff member sets it
 * through a single-use link sent to their work e-mail, then enrols their authenticator at first sign-in.
 */
export const localStaffAuth = () => env().STAFF_AUTH_MODE === 'local';

const TTL_HOURS = { ACTIVATE: 72, RESET: 1 } as const;
const FALLBACK: PasswordPolicy & { maxFailedAttempts: number; lockMinutes: number; maxAgeDays: number; historyCount: number } = { minLength: 14, maxLength: 128, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, disallowPersonalInfo: true, maxFailedAttempts: 5, lockMinutes: 30, maxAgeDays: 90, historyCount: 5 };

export async function staffPolicy(db: Db) {
  return { ...FALLBACK, ...((await getActive(db, 'password_policy', 'STAFF_INTERIM'))?.payload as any ?? {}) } as typeof FALLBACK;
}

export function passwordExpired(policy: { maxAgeDays: number }, changedAt: Date | string | null) {
  if (!policy.maxAgeDays || !changedAt) return false;
  return Date.now() - new Date(changedAt).getTime() > policy.maxAgeDays * 86400_000;
}

/** Issue an activation or reset link (invalidating earlier unused links) and e-mail it to the user's work address. */
export async function issueStaffLink(db: Db, actor: Actor, userId: string, purpose: 'ACTIVATE' | 'RESET') {
  const u = await one<any>(db, 'SELECT id, ad_username, display_name, email, status FROM app_user WHERE id=$1', [userId]);
  if (u.status !== 'ACTIVE') throw conflict('INACTIVE', 'Links can only be sent to active users.');
  const token = randomToken(32);
  await q(db, `UPDATE staff_credential_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL`, [userId]);
  await q(db, `INSERT INTO staff_credential_token(user_id, purpose, token_hash, expires_at, created_by) VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5)`, [userId, purpose, hmac(token, 'staff-credential'), TTL_HOURS[purpose], actor.type === 'STAFF' ? actor.id : null]);
  await audit(db, actor, { action: purpose === 'ACTIVATE' ? 'STAFF_ACTIVATION_LINK_SENT' : 'STAFF_RESET_LINK_SENT', entityType: 'app_user', entityId: userId, metadata: { expiresInHours: TTL_HOURS[purpose] } });
  const link = `${env().WEB_ORIGIN}/staff/set-password?token=${token}`;
  const text = purpose === 'ACTIVATE'
    ? `Dear ${u.display_name},\n\nA Credit360 by AltBank staff account has been set up for you (username ${u.ad_username}). Set your password using this link, valid for ${TTL_HOURS.ACTIVATE} hours:\n${link}\n\nAt your first sign-in you will also set up the Bank-approved authenticator app. If you did not expect this, contact Information Security.`
    : `Dear ${u.display_name},\n\nUse this link to set a new Credit360 password. It is valid for ${TTL_HOURS.RESET} hour and can be used once:\n${link}\n\nIf you did not ask for this, ignore this e-mail and tell Information Security. The Bank will never ask for your password.`;
  return { send: () => integrations().messaging.sendEmail(u.email, purpose === 'ACTIVATE' ? 'Set up your Credit360 staff account' : 'Reset your Credit360 password', text), sentTo: maskEmail(u.email) };
}

async function liveToken(db: Db, token: string, lock = false) {
  const t = await maybe<any>(db, `SELECT t.*, u.ad_username, u.display_name, u.email, u.status FROM staff_credential_token t JOIN app_user u ON u.id=t.user_id WHERE t.token_hash=$1 ${lock ? 'FOR UPDATE OF t' : ''}`, [hmac(token, 'staff-credential')]);
  if (!t || t.consumed_at || new Date(t.expires_at) < new Date() || t.status !== 'ACTIVE') return null;
  return t;
}

export async function tokenInfo(db: Db, token: string) {
  const t = await liveToken(db, token);
  if (!t) return null;
  return { purpose: t.purpose as 'ACTIVATE' | 'RESET', username: t.ad_username as string, policy: await staffPolicy(db) };
}

/** Apply a new password after policy and history checks. Ends every session and clears any lock. */
async function storePassword(db: Db, actor: Actor, user: { id: string; ad_username: string; display_name: string; email: string }, password: string, reason: string) {
  const policy = await staffPolicy(db);
  const issues = checkPassword(policy, password, [user.ad_username, user.display_name, user.email]);
  if (issues.length) throw unprocessable('PASSWORD_POLICY', 'The password does not meet the Bank’s requirements.', { unmet: issues });
  if (policy.historyCount) {
    const prev = await q<{ password_hash: string }>(db, 'SELECT password_hash FROM staff_password_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [user.id, policy.historyCount]);
    for (const p of prev) if (await verifyPassword(password, p.password_hash)) throw unprocessable('PASSWORD_POLICY', 'The password does not meet the Bank’s requirements.', { unmet: [`Must not be one of your last ${policy.historyCount} passwords`] });
  }
  const hash = await hashPassword(password);
  await q(db, `UPDATE app_user SET password_hash=$2, password_changed_at=now(), failed_login_count=0, locked_until=NULL WHERE id=$1`, [user.id, hash]);
  await q(db, 'INSERT INTO staff_password_history(user_id, password_hash) VALUES ($1,$2)', [user.id, hash]);
  await revokeAllFor(db, 'STAFF', user.id, 'password_changed');
  await audit(db, { ...actor, type: 'STAFF', id: user.id, label: user.display_name }, { action: 'STAFF_PASSWORD_SET', entityType: 'app_user', entityId: user.id, metadata: { reason } });
}

export async function setPasswordWithToken(db: Db, actor: Actor, token: string, password: string) {
  const t = await liveToken(db, token, true);
  if (!t) throw unprocessable('LINK_INVALID', 'This link is invalid or has expired. Ask for a new one from the sign-in page or your administrator.');
  await storePassword(db, actor, { id: t.user_id, ad_username: t.ad_username, display_name: t.display_name, email: t.email }, password, t.purpose === 'ACTIVATE' ? 'activation' : 'reset');
  await q(db, 'UPDATE staff_credential_token SET consumed_at=now() WHERE id=$1', [t.id]);
  return { username: t.ad_username as string };
}

export async function changePassword(db: Db, actor: Actor, userId: string, current: string, next: string) {
  const u = await one<any>(db, 'SELECT id, ad_username, display_name, email, password_hash FROM app_user WHERE id=$1 FOR UPDATE', [userId]);
  if (!(await verifyPassword(current, u.password_hash))) throw new AppError(422, 'CURRENT_PASSWORD', 'Your current password is incorrect.');
  await storePassword(db, actor, u, next, 'change');
}
