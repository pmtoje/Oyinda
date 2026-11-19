import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { env } from '../config/env.js';

const keyFrom = (b64: string) => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('Key material must be 32 bytes (base64)');
  return k;
};

export function hmac(value: string, purpose: string): string {
  return createHmac('sha256', keyFrom(env().HMAC_KEY)).update(`${purpose}:${value}`).digest('hex');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** URL-safe random token with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniformly distributed numeric code (no modulo bias). */
export function numericCode(digits: number): string {
  let out = '';
  for (let i = 0; i < digits; i++) out += String(randomInt(0, 10));
  return out;
}

/**
 * Field-level encryption (AES-256-GCM) for sensitive values such as BVN and MFA secrets.
 * Format: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url parts).
 */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(env().DATA_KEY), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', env().DATA_KEY_ID, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(token: string): string {
  const [v, , iv, tag, ct] = token.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
  const d = createDecipheriv('aes-256-gcm', keyFrom(env().DATA_KEY), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
