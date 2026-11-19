import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** scrypt password hash: scrypt$N$r$p$salt$hash (base64). The plaintext is never stored or logged. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Always do the work, so timing does not reveal whether an account exists.
  const parts = (stored ?? '').split('$');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const [N, r, p] = valid ? parts.slice(1, 4).map(Number) : [PARAMS.N, PARAMS.r, PARAMS.p];
  const salt = valid ? Buffer.from(parts[4]!, 'base64') : randomBytes(16);
  const expected = valid ? Buffer.from(parts[5]!, 'base64') : randomBytes(64);
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: N!, r: r!, p: p!, maxmem: PARAMS.maxmem });
  return valid && timingSafeEqual(key, expected);
}

export interface PasswordPolicy { minLength: number; maxLength: number; requireUpper: boolean; requireLower: boolean; requireDigit: boolean; requireSymbol: boolean; disallowPersonalInfo: boolean }

/** Returns the unmet rules in plain language (empty when the password complies). */
export function checkPassword(policy: PasswordPolicy, password: string, personal: string[] = []): string[] {
  const issues: string[] = [];
  if (password.length < policy.minLength) issues.push(`At least ${policy.minLength} characters`);
  if (password.length > policy.maxLength) issues.push(`No more than ${policy.maxLength} characters`);
  if (policy.requireUpper && !/[A-Z]/.test(password)) issues.push('At least one upper-case letter');
  if (policy.requireLower && !/[a-z]/.test(password)) issues.push('At least one lower-case letter');
  if (policy.requireDigit && !/[0-9]/.test(password)) issues.push('At least one number');
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) issues.push('At least one special character');
  if (policy.disallowPersonalInfo) {
    const lower = password.toLowerCase();
    const parts = personal.flatMap((x) => x.toLowerCase().split(/[@\s.]+/)).filter((x) => x.length >= 4);
    if (parts.some((x) => lower.includes(x))) issues.push('Must not contain your name or e-mail address');
  }
  return issues;
}
