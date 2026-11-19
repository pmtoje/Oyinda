import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader for local development. Existing process variables always win. */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, k, raw] = m;
    if (process.env[k!] === undefined) process.env[k!] = raw!.replace(/^"(.*)"$/, '$1');
  }
}
