import pg from 'pg';
import { createDecipheriv, createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';
import { e2eEnv } from './env';

const db = () => { const c = new pg.Client({ connectionString: e2eEnv.DATABASE_URL }); return c.connect().then(() => c); };

/** Reads an OTP from the MOCK outbox (the API never returns OTPs). */
export async function lastOtp(destination: string) {
  const c = await db();
  try {
    for (let i = 0; i < 20; i++) {
      const r = await c.query('SELECT body FROM mock_outbox WHERE destination=$1 ORDER BY id DESC LIMIT 1', [destination]);
      const m = /code is (\d{6})/.exec(r.rows[0]?.body ?? '');
      if (m) return m[1]!;
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('no OTP for ' + destination);
  } finally { await c.end(); }
}
export async function sql(text: string, params: unknown[] = []) { const c = await db(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } }

const b32 = (s: string) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out: number[] = []; for (const ch of s) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
export function totp(secret: string) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', b32(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0');
}
function decryptField(tok: string) {
  const [, , iv, tag, ct] = tok.split('.');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(e2eEnv.DATA_KEY!, 'base64'), Buffer.from(iv!, 'base64url'));
  d.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct!, 'base64url')), d.final()]).toString();
}
export async function staffSecret(username: string) {
  await sql('UPDATE app_user SET mfa_last_step=NULL WHERE ad_username=$1', [username]);
  const r = await sql('SELECT mfa_secret_enc, mfa_pending_secret_enc FROM app_user WHERE ad_username=$1', [username]);
  const enc = r[0]?.mfa_secret_enc ?? r[0]?.mfa_pending_secret_enc; // pending = first sign-in (enrolment)
  return enc ? decryptField(enc) : null;
}
export async function shot(page: Page, name: string) { await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true }); }
