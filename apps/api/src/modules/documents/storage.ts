import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../../config/env.js';
import { decryptField, encryptField } from '../../lib/crypto.js';

/**
 * Encrypted object storage (envelope encryption). Each object gets a random 256-bit data key; the data key is
 * wrapped with the master key held by the KMS adapter (local key in development, HSM/KMS in production).
 * Object keys are random and never derived from user input, so path traversal is impossible.
 */
const KEY_RE = /^[a-f0-9]{48}$/;
const pathFor = (key: string) => {
  if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
  return join(resolve(env().STORAGE_DIR), key.slice(0, 2), key.slice(2, 4), key);
};

export async function putObject(data: Buffer) {
  const key = randomBytes(24).toString('hex');
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  const p = pathFor(key);
  await mkdir(join(p, '..'), { recursive: true, mode: 0o700 });
  await writeFile(p, ct, { mode: 0o600 });
  return { storageKey: key, wrappedKey: encryptField(dataKey.toString('base64')), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), keyId: env().DATA_KEY_ID };
}

export async function getObject(v: { storage_key: string; enc_wrapped_key: string; enc_iv: string; enc_tag: string }) {
  const ct = await readFile(pathFor(v.storage_key));
  const d = createDecipheriv('aes-256-gcm', Buffer.from(decryptField(v.enc_wrapped_key), 'base64'), Buffer.from(v.enc_iv, 'base64'));
  d.setAuthTag(Buffer.from(v.enc_tag, 'base64'));
  return Buffer.concat([d.update(ct), d.final()]);
}

export async function deleteObject(key: string) {
  await rm(pathFor(key), { force: true });
}
