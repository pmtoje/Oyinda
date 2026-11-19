import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { getApp } from './helpers.js';
import { PUBLIC_ROUTES, routeKey } from '../src/http/public-routes.js';

let app: Awaited<ReturnType<typeof getApp>>;
let routes: { method: string; url: string }[];
beforeAll(async () => {
  app = await getApp();
  routes = (app as any).routeList;
});

const sample = (url: string) => url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

describe('deny by default', () => {
  it('every non-public /api route answers 401 to an anonymous caller — before validation or record lookup', async () => {
    const gated = routes.filter((r) => r.url.startsWith('/api/') && !PUBLIC_ROUTES.has(routeKey(r.method, r.url)));
    expect(gated.length).toBeGreaterThan(150);
    const leaks: string[] = [];
    for (const r of gated) {
      const res = await app.inject({ method: r.method as any, url: sample(r.url), headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{"x":1}' });
      if (res.statusCode !== 401) leaks.push(`${res.statusCode} ${r.method} ${r.url}`);
    }
    expect(leaks).toEqual([]);
  });

  it('the public allowlist names only routes that exist', () => {
    const existing = new Set(routes.map((r) => routeKey(r.method, r.url)));
    expect([...PUBLIC_ROUTES].filter((k) => !existing.has(k))).toEqual([]);
  });

  it('a session cookie that is not valid is treated as no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie: 'gz_session=forged-token-value-that-does-not-exist' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('API reference', () => {
  it('docs/api-reference.md is generated from the current routes', () => {
    expect(() => execFileSync('npx', ['tsx', 'scripts/api-reference.ts', '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
