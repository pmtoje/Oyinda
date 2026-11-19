import { beforeAll, describe, expect, it } from 'vitest';
import { abcClient, Client, db, getApp, staffLogin } from './helpers.js';
import { q } from '../src/db/pool.js';
import { clearSessionPolicyCache } from '../src/modules/identity/session.js';

let app: Awaited<ReturnType<typeof getApp>>;
let admin: Client, superadmin: Client, abc: Client;
let abcUserId: string;

const currentSession = async (subjectId: string) =>
  (await q<any>(db(), `SELECT id, idle_expires_at, absolute_expires_at, created_at FROM auth_session WHERE subject_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [subjectId]))[0];
const minutesLeft = (d: Date) => (new Date(d).getTime() - Date.now()) / 60_000;
const passive = (c: Client, url: string) => c.req('GET', url, undefined, { 'x-gz-passive': '1' });

/** Maker (admin) drafts and submits, checker (superadmin) approves — the normal control path. */
async function approvePolicy(key: 'STAFF' | 'CUSTOMER_PORTAL', payload: Record<string, number>, reason: string) {
  const cur = (await admin.get(`/api/admin/config?kind=session_policy&key=${key}&status=ACTIVE`)).body.data[0];
  const d = await admin.post('/api/admin/config', { kind: 'session_policy', key, title: cur.title, payload, changeReason: reason });
  expect(d.status).toBe(201);
  expect((await admin.post(`/api/admin/config/${d.body.data.id}/submit`)).status).toBe(200);
  expect((await superadmin.post(`/api/admin/config/${d.body.data.id}/approve`)).status).toBe(200);
  clearSessionPolicyCache();
}

beforeAll(async () => {
  app = await getApp();
  admin = await staffLogin(app, 'demo.admin');
  superadmin = await staffLogin(app, 'demo.superadmin');
  abc = await abcClient(app);
  abcUserId = (await abc.get('/api/auth/me')).body.data.user.id;
});

describe('configurable session timeout', () => {
  it('reports the session timing and warning lead time without extending the session', async () => {
    await q(db(), `UPDATE auth_session SET idle_expires_at = now() + interval '3 minutes' WHERE id=$1`, [(await currentSession(abcUserId)).id]);
    const st = await abc.get('/api/auth/session/status');
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ idleMinutes: 15, warningSeconds: 120 });
    expect(minutesLeft(st.body.data.idleExpiresAt)).toBeLessThan(3.1);
    expect(minutesLeft((await currentSession(abcUserId)).idle_expires_at)).toBeLessThan(3.1);
  });

  it('background refreshes do not keep an idle session alive; real activity does', async () => {
    const s = await currentSession(abcUserId);
    await q(db(), `UPDATE auth_session SET idle_expires_at = now() + interval '2 minutes' WHERE id=$1`, [s.id]);
    expect((await passive(abc, '/api/notifications?limit=1')).status).toBe(200);
    expect(minutesLeft((await currentSession(abcUserId)).idle_expires_at)).toBeLessThan(2.1);
    expect((await abc.get('/api/notifications?limit=1')).status).toBe(200);
    expect(minutesLeft((await currentSession(abcUserId)).idle_expires_at)).toBeGreaterThan(14);
  });

  it('"Stay signed in" extends the session, but never beyond its maximum length', async () => {
    const s = await currentSession(abcUserId);
    await q(db(), `UPDATE auth_session SET idle_expires_at = now() + interval '1 minute', absolute_expires_at = now() + interval '5 minutes' WHERE id=$1`, [s.id]);
    const r = await abc.post('/api/auth/session/keep-alive');
    expect(r.status).toBe(200);
    const after = await currentSession(abcUserId);
    expect(minutesLeft(after.idle_expires_at)).toBeGreaterThan(4.5);
    expect(new Date(after.idle_expires_at).getTime()).toBeLessThanOrEqual(new Date(after.absolute_expires_at).getTime());
  });

  it('an expired session is refused everywhere, including the status check', async () => {
    await q(db(), `UPDATE auth_session SET idle_expires_at = now() - interval '1 second' WHERE id=$1`, [(await currentSession(abcUserId)).id]);
    expect((await abc.get('/api/auth/session/status')).status).toBe(401);
    expect((await abc.post('/api/auth/session/keep-alive')).status).toBe(401);
    expect((await abc.get('/api/auth/me')).status).toBe(401);
  });

  it('administrators change the timeout through maker-checker; invalid combinations are rejected', async () => {
    const bad = await admin.post('/api/admin/config', { kind: 'session_policy', key: 'STAFF', title: 'Staff session timeout', payload: { idleMinutes: 5, absoluteHours: 8, warningSeconds: 300 }, changeReason: 'Warning longer than the timeout' });
    expect(bad.status).toBe(400);
    expect((await admin.post('/api/admin/config', { kind: 'session_policy', key: 'STAFF', title: 'x', payload: { idleMinutes: 1, absoluteHours: 8, warningSeconds: 30 }, changeReason: 'Below the minimum' })).status).toBe(400);
    await approvePolicy('STAFF', { idleMinutes: 30, absoluteHours: 10, warningSeconds: 90 }, 'Management direction: longer credit reviews');
    const rm = await staffLogin(app, 'demo.rm');
    const st = (await rm.get('/api/auth/session/status')).body.data;
    expect(st).toMatchObject({ idleMinutes: 30, warningSeconds: 90 });
    expect(minutesLeft(st.idleExpiresAt)).toBeGreaterThan(29);
    // Customers keep their own policy
    const c = await abcClient(app);
    expect((await c.get('/api/auth/session/status')).body.data.idleMinutes).toBe(15);
    await approvePolicy('STAFF', { idleMinutes: 15, absoluteHours: 10, warningSeconds: 120 }, 'Restore the standard timeout');
  });
});

describe('request limits', () => {
  it('limits each signed-in user independently of their IP, and never reports it as signed out', async () => {
    const { env } = await import('../src/config/env.js');
    const before = env().USER_RATE_LIMIT_PER_MIN;
    (env() as any).USER_RATE_LIMIT_PER_MIN = 12;
    try {
      const rm = await staffLogin(app, 'demo.rm');
      const statuses: number[] = [];
      for (let i = 0; i < 16; i++) statuses.push((await rm.get('/api/notifications?limit=1')).status);
      expect(statuses).toContain(429);
      const limited = await rm.get('/api/notifications?limit=1');
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.raw.headers['retry-after']).toBeDefined();
      // Another user on the same IP is unaffected
      const other = await staffLogin(app, 'demo.auditor');
      expect((await other.get('/api/notifications?limit=1')).status).toBe(200);
    } finally {
      (env() as any).USER_RATE_LIMIT_PER_MIN = before;
    }
  });
});
