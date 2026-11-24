/**
 * Generates docs/api-reference.md from the route source: every HTTP endpoint, who may call it (derived from the
 * authorisation call in its handler), the comment above it, and where it is defined.
 *
 *   pnpm --filter @gazelle/api docs:api           write the reference
 *   pnpm --filter @gazelle/api docs:api --check   fail if the committed reference is out of date (used by tests)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ROUTES, routeKey } from '../src/http/public-routes.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(here, '../src');
const ROOT = resolve(here, '../../..');
export const OUT = join(ROOT, 'docs/api-reference.md');

type Route = { method: string; path: string; access: string; summary: string; file: string; line: number; module: string };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
}

const PERM_LIST = (s: string) => [...s.matchAll(/'([a-z_.]+)'/g)].map((m) => `\`${m[1]}\``);

/**
 * Who may call the route. Public status comes from the enforced allowlist (src/http/public-routes.ts); every other
 * /api route is rejected without a session by the gate, and the handler's own check is shown where it is explicit.
 */
function accessOf(body: string, method: string, path: string): string {
  if (!path.startsWith('/api/')) return 'Operational (outside /api)';
  if (PUBLIC_ROUTES.has(routeKey(method, path))) return 'Public · no session (own challenge / rate limits)';
  let m: RegExpExecArray | null;
  if ((m = /requireStaff\(req(?:,\s*([^)]*))?\)/.exec(body))) { const p = m[1] ? PERM_LIST(m[1]) : []; return p.length ? `Staff + MFA · ${p.join(' and ')}` : 'Staff + MFA'; }
  if ((m = /requireAnyPerm\(req,\s*\[([^\]]*)\]/.exec(body))) return `Staff + MFA · any of ${PERM_LIST(m[1]!).join(', ')}`;
  if ((m = /requireCustomerRight\(req,\s*'([A-Z_]+)'/.exec(body))) return `Customer user with portal right \`${m[1]}\``;
  if (/requireCustomer\(req\)/.test(body)) return 'Customer user';
  if (/loadFacility\(/.test(body)) return 'Owning customer, or staff with access to the facility';
  return 'Signed in · further checks in the handler';
}

function summaryAbove(lines: string[], i: number): string {
  const out: string[] = [];
  for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
    const t = lines[j]!.trim();
    if (t.startsWith('//')) { const c = t.replace(/^\/\/\s?/, '').replace(/^[-=─]+\s*/, ''); if (/^[-=─\s]*$/.test(c)) break; out.unshift(c); continue; }
    if (t.endsWith('*/')) {
      const block: string[] = [];
      for (let k = j; k >= 0; k--) { const u = lines[k]!.trim(); block.unshift(u.replace(/^\/\*\*?|\*\/$|^\*\s?/g, '').trim()); if (u.startsWith('/*')) break; }
      out.unshift(...block.filter(Boolean));
    }
    break;
  }
  return out.join(' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

export function collect(): Route[] {
  const routes: Route[] = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, 'utf8');
    if (!/app\.(get|post|put|patch|delete)\(/.test(text)) continue;
    const lines = text.split('\n');
    const starts: { i: number; method: string; path: string }[] = [];
    lines.forEach((l, i) => { const m = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(l); if (m) starts.push({ i, method: m[1]!.toUpperCase(), path: m[2]! }); });
    starts.forEach((s, n) => {
      const body = lines.slice(s.i, n + 1 < starts.length ? starts[n + 1]!.i : lines.length).join('\n');
      const rel = relative(SRC, f);
      routes.push({ method: s.method, path: s.path, access: accessOf(body, s.method, s.path), summary: summaryAbove(lines, s.i), file: rel, line: s.i + 1, module: rel.split('/')[1] ?? rel });
    });
  }
  const order = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  return routes.sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path) || order.indexOf(a.method) - order.indexOf(b.method));
}

export function render(routes: Route[]): string {
  const byModule = new Map<string, Route[]>();
  for (const r of routes) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);
  const parts = [
    '# Credit360 API reference',
    '',
    '_Generated from the route source by `pnpm --filter @gazelle/api docs:api`; a test fails when this file is out of date. Do not edit by hand._',
    '',
    '## Conventions',
    '',
    '* **Base:** same origin as the web app; JSON in and out. Successful responses are `{ "data": … }`; errors are `{ "error": { "code", "message", "details?", "requestId" } }` with an HTTP status (400 validation, 401 not signed in, 403 not permitted, 404 not found or not visible to you, 409 conflict / stale `rowVersion`, 422 business rule, 429 rate limited with `Retry-After`).',
    '* **Session:** an HttpOnly `gz_session` cookie. Every state-changing request needs the `x-csrf-token` header (returned by sign-in and `GET /api/auth/session`) and a same-origin `Origin`.',
    '* **Background refreshes** send `x-gz-passive: 1`: authenticated, but they never extend the inactivity timeout.',
    '* **Deny by default:** every `/api` route returns 401 without a session unless it is on the public allowlist (`src/http/public-routes.ts`); a test calls every route anonymously to prove it.',
    '* **Access** below is the check made by the handler. "Staff + MFA" means a staff session that completed the second factor; permissions are listed in `docs/security-model.md`. Facility-scoped routes additionally enforce row-level visibility (own customer, assigned relationship manager, or a role that sees all).',
    '* **Idempotency:** facility creation, workflow actions and disbursements take an `idempotencyKey`; optimistic concurrency uses `rowVersion`.',
    '',
    `**${routes.length} endpoints** in ${byModule.size} modules.`,
    '',
  ];
  for (const [mod, rs] of byModule) {
    parts.push(`## ${mod}`, '', '| Method | Path | Access | Purpose | Source |', '| --- | --- | --- | --- | --- |');
    for (const r of rs) parts.push(`| ${r.method} | \`${r.path}\` | ${r.access} | ${r.summary || '—'} | \`${r.file}:${r.line}\` |`);
    parts.push('');
  }
  return parts.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const doc = render(collect());
  if (process.argv.includes('--check')) {
    const current = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return ''; } })();
    if (current !== doc) { console.error('docs/api-reference.md is out of date: run `pnpm --filter @gazelle/api docs:api`.'); process.exit(1); }
    console.log('docs/api-reference.md is current.');
  } else {
    writeFileSync(OUT, doc);
    console.log(`Wrote ${relative(ROOT, OUT)} (${collect().length} endpoints).`);
  }
}
