import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { abcClient, Client, completeAbcProfile, db, draftMurabaha, getApp, staffLogin, uploadAllRequired } from './helpers.js';
import { q } from '../src/db/pool.js';

/**
 * Performance regression gate (in-process, test database with the data created by the other test files).
 * Budgets are deliberately generous so the gate is stable on shared CI runners; it catches order-of-magnitude
 * regressions such as an N+1 query or a missing index. Measurements are written to test-results/performance.json.
 */
const BUDGET_P95_MS = 400;
const RUNS = 25;

let app: Awaited<ReturnType<typeof getApp>>;
let analyst: Client; let admin: Client;
let facilityId: string;
const results: Record<string, { p50: number; p95: number; max: number }> = {};

async function measure(c: Client, url: string) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const r = await c.get(url);
    times.push(performance.now() - t);
    expect(r.status, `${url}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
  }
  times.sort((a, b) => a - b);
  const pick = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))]!);
  return (results[url.replace(/[0-9a-f-]{36}/, ':id')] = { p50: pick(0.5), p95: pick(0.95), max: Math.round(times.at(-1)!) });
}

beforeAll(async () => {
  app = await getApp();
  analyst = await staffLogin(app, 'demo.analyst');
  admin = await staffLogin(app, 'demo.admin');
  facilityId = (await q<any>(db(), `SELECT id FROM facility_request WHERE status NOT IN ('DRAFT') ORDER BY created_at LIMIT 1`))[0]?.id;
  if (!facilityId) { // running on its own: create one submitted request
    const abc = await abcClient(app);
    await completeAbcProfile(abc, (await abc.get('/api/auth/me')).body.data.customer.id);
    const f = await draftMurabaha(abc);
    await uploadAllRequired(abc, f.id);
    const cur = (await abc.get(`/api/facilities/${f.id}`)).body.data.facility;
    await abc.post(`/api/facilities/${f.id}/submit`, { rowVersion: cur.rowVersion, declaration: true });
    facilityId = f.id;
  }
});

describe('performance budgets (p95)', () => {
  for (const [label, url, who] of [
    ['work queue', '/api/tasks?scope=queue', 'analyst'],
    ['my tasks', '/api/tasks?scope=mine', 'analyst'],
    ['facility list', '/api/facilities', 'analyst'],
    ['facility workspace', '/api/facilities/:id', 'analyst'],
    ['executive decision view', '/api/facilities/:id/decision-view', 'analyst'],
    ['notifications', '/api/notifications?limit=20', 'analyst'],
    ['configuration list', '/api/admin/config', 'admin'],
  ] as const) {
    it(`${label} stays within ${BUDGET_P95_MS} ms at p95`, async () => {
      const r = await measure(who === 'admin' ? admin : analyst, url.replace(':id', facilityId));
      expect(r.p95).toBeLessThan(BUDGET_P95_MS);
    });
  }

  it('50 concurrent queue requests complete within 5 seconds', async () => {
    const t = performance.now();
    const rs = await Promise.all(Array.from({ length: 50 }, () => analyst.get('/api/tasks?scope=queue')));
    const ms = performance.now() - t;
    expect(rs.every((r) => r.status === 200)).toBe(true);
    results['50 concurrent /api/tasks?scope=queue (total)'] = { p50: 0, p95: 0, max: Math.round(ms) };
    expect(ms).toBeLessThan(5000);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/performance.json', JSON.stringify({ measuredAt: new Date().toISOString(), runs: RUNS, budgetP95Ms: BUDGET_P95_MS, results }, null, 2));
  });
});
