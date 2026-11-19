import type { Db } from '../../db/pool.js';
import { maybe, one, q } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { hmac, numericCode, safeEqualHex } from '../../lib/crypto.js';
import { tooMany, unprocessable } from '../../lib/errors.js';

export type OtpPurpose = 'ONBOARDING' | 'LOGIN' | 'EMAIL_VERIFY' | 'PHONE_VERIFY' | 'STEP_UP';

const codeHash = (challengeId: string, code: string) => hmac(`${challengeId}:${code}`, 'otp');

/**
 * Issue a 6-digit OTP. The plaintext code is returned ONLY to the caller so it can be dispatched to
 * the registered destination; it is never stored and never placed in an API response.
 */
export async function issueOtp(db: Db, input: { purpose: OtpPurpose; subjectKey: string; channel: 'SMS' | 'EMAIL'; destinationMasked: string; ip?: string | null }) {
  // Resend throttling: at most 5 challenges per subject per 15 minutes, 30 s between sends.
  const recent = await q<{ created_at: Date }>(
    db,
    `SELECT created_at FROM otp_challenge WHERE subject_key=$1 AND purpose=$2 AND created_at > now() - interval '15 minutes' ORDER BY created_at DESC`,
    [input.subjectKey, input.purpose],
  );
  if (recent.length >= 5) throw tooMany('Too many codes requested. Please wait 15 minutes and try again.');
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 30_000) throw tooMany('Please wait 30 seconds before requesting another code.');
  // Any earlier live challenge for this subject is invalidated (only the latest code works).
  await q(db, `UPDATE otp_challenge SET invalidated_at=now() WHERE subject_key=$1 AND purpose=$2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [input.subjectKey, input.purpose]);
  const code = numericCode(6);
  const row = await one<{ id: string; expires_at: Date }>(
    db,
    `INSERT INTO otp_challenge(purpose, subject_key, channel, destination_masked, code_hash, max_attempts, expires_at, created_ip)
     VALUES ($1,$2,$3,$4,'pending',$5, now() + make_interval(secs => $6), $7) RETURNING id, expires_at`,
    [input.purpose, input.subjectKey, input.channel, input.destinationMasked, env().OTP_MAX_ATTEMPTS, env().OTP_TTL_SECONDS, input.ip ?? null],
  );
  await q(db, 'UPDATE otp_challenge SET code_hash=$2 WHERE id=$1', [row.id, codeHash(row.id, code)]);
  return { challengeId: row.id, code, expiresAt: row.expires_at };
}

export type OtpFailure = 'INVALID' | 'EXPIRED' | 'USED' | 'LOCKED' | 'NOT_FOUND';

/** Server-side verification: single use, expiry, attempt limit, constant-time comparison. */
export async function verifyOtp(db: Db, input: { challengeId: string; purpose: OtpPurpose; subjectKey?: string; code: string }): Promise<{ ok: true; subjectKey: string } | { ok: false; reason: OtpFailure; remaining?: number }> {
  if (!/^[0-9]{6}$/.test(input.code)) throw unprocessable('OTP_FORMAT', 'Enter the 6-digit code.');
  const c = await maybe<any>(db, 'SELECT * FROM otp_challenge WHERE id=$1 AND purpose=$2 FOR UPDATE', [input.challengeId, input.purpose]);
  if (!c || (input.subjectKey && c.subject_key !== input.subjectKey)) return { ok: false, reason: 'NOT_FOUND' };
  if (c.consumed_at) return { ok: false, reason: 'USED' };
  if (c.attempts >= c.max_attempts) return { ok: false, reason: 'LOCKED' };
  if (c.invalidated_at) return { ok: false, reason: 'EXPIRED' };
  if (new Date(c.expires_at) < new Date()) return { ok: false, reason: 'EXPIRED' };
  const ok = safeEqualHex(c.code_hash, codeHash(c.id, input.code));
  if (!ok) {
    const attempts = c.attempts + 1;
    await q(db, `UPDATE otp_challenge SET attempts=$2, invalidated_at = CASE WHEN $2 >= max_attempts THEN now() ELSE NULL END WHERE id=$1`, [c.id, attempts]);
    return attempts >= c.max_attempts ? { ok: false, reason: 'LOCKED' } : { ok: false, reason: 'INVALID', remaining: c.max_attempts - attempts };
  }
  await q(db, 'UPDATE otp_challenge SET consumed_at=now(), attempts=attempts+1 WHERE id=$1', [c.id]);
  return { ok: true, subjectKey: c.subject_key };
}

export const OTP_MESSAGES: Record<OtpFailure, string> = {
  INVALID: 'The code entered is incorrect.',
  EXPIRED: 'This code has expired. Request a new code.',
  USED: 'This code has already been used. Request a new code.',
  LOCKED: 'Too many incorrect attempts. Request a new code.',
  NOT_FOUND: 'This code is not valid. Request a new code.',
};
