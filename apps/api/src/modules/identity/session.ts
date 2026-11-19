import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { hmac, randomToken } from '../../lib/crypto.js';
import { getActive } from '../config/service.js';

export const SESSION_COOKIE = 'gz_session';

export interface StaffPrincipal {
  id: string;
  name: string;
  email: string;
  roles: string[];
  permissions: Set<string>;
  businessUnit: string | null;
  directorate: string | null;
}
export interface CustomerPrincipal {
  userId: string;
  customerId: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  /** Portal rights within the business: SUBMIT_REQUESTS, RESPOND_TO_OFFERS, MANAGE_USERS. */
  permissions: string[];
  portalRole: 'PRIMARY' | 'DELEGATE';
}
export interface AuthContext {
  sessionId: string;
  subjectType: 'CUSTOMER' | 'STAFF';
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  subjectId: string;
  mfaSatisfied: boolean;
  csrfToken: string;
  staff?: StaffPrincipal;
  customer?: CustomerPrincipal;
}

const tokenHash = (t: string) => hmac(t, 'session');

export interface SessionPolicy { idleMinutes: number; absoluteHours: number; warningSeconds: number }
const POLICY_KEY = { CUSTOMER: 'CUSTOMER_PORTAL', STAFF: 'STAFF' } as const;
const policyCache = new Map<string, { at: number; value: SessionPolicy }>();

/**
 * The approved session policy for customers or staff (config `session_policy`, maker-checker). Falls back to the
 * environment defaults if none is approved. Cached briefly; an approved change applies to every session within 30 s.
 */
export async function sessionPolicy(db: Db, subjectType: 'CUSTOMER' | 'STAFF'): Promise<SessionPolicy> {
  const hit = policyCache.get(subjectType);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const e = env();
  const row = await getActive(db, 'session_policy', POLICY_KEY[subjectType]).catch(() => undefined);
  const value: SessionPolicy = { idleMinutes: e.SESSION_IDLE_MINUTES, absoluteHours: e.SESSION_ABSOLUTE_HOURS, warningSeconds: 120, ...((row?.payload as Partial<SessionPolicy>) ?? {}) };
  policyCache.set(subjectType, { at: Date.now(), value });
  return value;
}
export const clearSessionPolicyCache = () => policyCache.clear();
export const csrfFor = (sessionToken: string) => hmac(sessionToken, 'csrf').slice(0, 48);

export async function createSession(db: Db, input: { subjectType: 'CUSTOMER' | 'STAFF'; subjectId: string; mfaSatisfied: boolean; ip?: string | null; userAgent?: string | null }) {
  const token = randomToken(32);
  const p = await sessionPolicy(db, input.subjectType);
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO auth_session(token_hash, csrf_hash, subject_type, subject_id, mfa_satisfied, ip, user_agent, device_label, idle_expires_at, absolute_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9), now() + make_interval(hours => $10)) RETURNING id`,
    [tokenHash(token), hmac(csrfFor(token), 'csrf-store'), input.subjectType, input.subjectId, input.mfaSatisfied, input.ip ?? null, input.userAgent?.slice(0, 400) ?? null, deviceLabel(input.userAgent), p.idleMinutes, p.absoluteHours],
  );
  return { id: row.id, token, csrfToken: csrfFor(token) };
}

function deviceLabel(ua?: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

/**
 * SWR technology control 22 / PRD: restrict concurrent logins. When enabled, a new fully-authenticated
 * session ends every other live session of the same user. Returns how many were ended.
 */
export async function enforceSingleSession(db: Db, subjectType: 'CUSTOMER' | 'STAFF', subjectId: string, keepSessionId: string) {
  if (!env().SINGLE_SESSION) return 0;
  const r = await q(db, `UPDATE auth_session SET revoked_at=now(), revoked_reason='superseded_by_new_sign_in' WHERE subject_type=$1 AND subject_id=$2 AND id<>$3 AND revoked_at IS NULL RETURNING id`, [subjectType, subjectId, keepSessionId]);
  return r.length;
}

/**
 * Resolve a session token; enforces revocation, idle and absolute timeouts. Activity slides the idle window;
 * a passive request (background refresh, session-status check) is authenticated but does not extend the session.
 */
export async function resolveSession(db: Db, token: string, opts: { passive?: boolean } = {}): Promise<AuthContext | null> {
  if (!token || token.length > 100) return null;
  const live = await maybe<any>(db, `SELECT * FROM auth_session WHERE token_hash=$1 AND revoked_at IS NULL AND idle_expires_at > now() AND absolute_expires_at > now()`, [tokenHash(token)]);
  if (!live) return null;
  let s = live;
  if (!opts.passive) {
    const p = await sessionPolicy(db, live.subject_type);
    s = (await maybe<any>(
      db,
      `UPDATE auth_session SET last_seen_at=now(), idle_expires_at = LEAST(absolute_expires_at, now() + make_interval(mins => $2))
       WHERE id=$1 AND revoked_at IS NULL AND idle_expires_at > now() RETURNING *`,
      [live.id, p.idleMinutes],
    )) ?? null;
  }
  if (!s) return null;
  const ctx: AuthContext = { sessionId: s.id, subjectType: s.subject_type, idleExpiresAt: s.idle_expires_at, absoluteExpiresAt: s.absolute_expires_at, subjectId: s.subject_id, mfaSatisfied: s.mfa_satisfied, csrfToken: csrfFor(token) };
  if (s.subject_type === 'STAFF') {
    const u = await maybe<any>(db, `SELECT * FROM app_user WHERE id=$1 AND status='ACTIVE'`, [s.subject_id]);
    if (!u) return null;
    const roles = (await q<{ role_code: string }>(db, 'SELECT role_code FROM user_role WHERE user_id=$1', [u.id])).map((r) => r.role_code);
    const perms = await q<{ permission_code: string }>(db, 'SELECT DISTINCT permission_code FROM role_permission WHERE role_code = ANY($1)', [roles]);
    ctx.staff = { id: u.id, name: u.display_name, email: u.email, roles, permissions: new Set(perms.map((p) => p.permission_code)), businessUnit: u.business_unit_code, directorate: u.directorate_code };
  } else {
    const u = await maybe<any>(db, `SELECT cu.*, c.status AS customer_status FROM customer_user cu JOIN customer c ON c.id=cu.customer_id WHERE cu.id=$1 AND cu.status='ACTIVE'`, [s.subject_id]);
    if (!u || u.customer_status === 'SUSPENDED' || u.customer_status === 'EXITED') return null;
    ctx.customer = { userId: u.id, customerId: u.customer_id, fullName: u.full_name, email: u.email, emailVerified: !!u.email_verified_at, permissions: u.permissions ?? [], portalRole: u.portal_role };
  }
  return ctx;
}

export async function revokeSession(db: Db, id: string, reason: string) {
  await q(db, `UPDATE auth_session SET revoked_at=now(), revoked_reason=$2 WHERE id=$1 AND revoked_at IS NULL`, [id, reason]);
}

export async function revokeAllFor(db: Db, subjectType: string, subjectId: string, reason: string, exceptId?: string) {
  await q(db, `UPDATE auth_session SET revoked_at=now(), revoked_reason=$3 WHERE subject_type=$1 AND subject_id=$2 AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4)`, [subjectType, subjectId, reason, exceptId ?? null]);
}
