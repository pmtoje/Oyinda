import { loadEnvFile } from './config/dotenv.js';
loadEnvFile();
const { getPool, closePool } = await import('./db/pool.js');
const { runOnce, reclaimStale } = await import('./jobs/queue.js');
await import('./modules/notifications/service.js');
await import('./modules/documents/service.js');
await import('./modules/analysis/statement-routes.js');
await import('./modules/docgen/service.js');
const { slaSweep } = await import('./modules/workflow/sweep.js');
const { monitoringSweep } = await import('./modules/servicing/routes.js');
const { expireDocuments } = await import('./modules/documents/service.js');

/**
 * Background worker. Many replicas may run: queue jobs use SKIP LOCKED, and periodic sweeps take a
 * Postgres advisory lock so only one replica runs each sweep at a time.
 */
let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));
const pool = getPool();
const withLock = async (key: number, fn: () => Promise<unknown>) => {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0].ok) return;
    try { await fn(); } finally { await c.query('SELECT pg_advisory_unlock($1)', [key]); }
  } finally { c.release(); }
};
const every = (ms: number, key: number, fn: () => Promise<unknown>) => {
  const tick = async () => { if (stopping) return; try { await withLock(key, fn); } catch (e) { console.error(JSON.stringify({ level: 'error', msg: 'sweep failed', key, err: String(e) })); } setTimeout(tick, ms); };
  void tick();
};
every(60_000, 9101, () => slaSweep(pool));
every(6 * 3600_000, 9102, () => monitoringSweep(pool));
every(6 * 3600_000, 9103, () => expireDocuments(pool));
every(300_000, 9104, () => reclaimStale(15));

while (!stopping) {
  try { if (!(await runOnce())) await new Promise((r) => setTimeout(r, 1000)); }
  catch (e) { console.error(JSON.stringify({ level: 'error', msg: 'job loop error', err: String(e) })); await new Promise((r) => setTimeout(r, 5000)); }
}
await closePool();
