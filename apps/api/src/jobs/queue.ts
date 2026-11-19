import { hostname } from 'node:os';
import type { Db } from '../db/pool.js';
import { getPool, maybe, q } from '../db/pool.js';
import { metrics } from '../lib/metrics.js';

export type JobHandler = (payload: any, job: { id: string; attempts: number }) => Promise<unknown>;
const handlers = new Map<string, JobHandler>();

export function registerJob(queue: string, h: JobHandler) { handlers.set(queue, h); }

/** Enqueue inside the caller's transaction (transactional outbox). Idempotency key de-duplicates. */
export async function enqueue(db: Db, queue: string, payload: unknown, opts: { idempotencyKey?: string; runAfter?: Date; maxAttempts?: number } = {}) {
  const r = await q<{ id: string }>(db, `INSERT INTO job(queue, payload, idempotency_key, run_after, max_attempts) VALUES ($1,$2,$3,COALESCE($4, now()),$5)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, [queue, JSON.stringify(payload), opts.idempotencyKey ?? null, opts.runAfter ?? null, opts.maxAttempts ?? 5]);
  return r[0]?.id;
}

const workerId = `${hostname()}:${process.pid}`;

/** Claim and run one ready job. Failures back off exponentially; exhausted jobs move to DEAD (dead-letter). */
export async function runOnce(queues?: string[]): Promise<boolean> {
  const pool = getPool();
  const job = await maybe<any>(pool, `UPDATE job SET status='RUNNING', locked_at=now(), locked_by=$2, attempts=attempts+1
    WHERE id = (SELECT id FROM job WHERE status IN ('QUEUED','FAILED') AND run_after <= now() AND ($1::text[] IS NULL OR queue = ANY($1))
                ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [queues ?? null, workerId]);
  if (!job) return false;
  const h = handlers.get(job.queue);
  try {
    if (!h) throw new Error(`No handler for queue ${job.queue}`);
    const result = await h(job.payload, { id: job.id, attempts: job.attempts });
    await q(pool, `UPDATE job SET status='DONE', finished_at=now(), result=$2, last_error=NULL WHERE id=$1`, [job.id, JSON.stringify(result ?? null)]);
    metrics.inc('gazelle_jobs_total', { queue: job.queue, outcome: 'done' });
  } catch (e) {
    const dead = job.attempts >= job.max_attempts;
    const backoff = Math.min(2 ** job.attempts * 5, 3600);
    await q(pool, `UPDATE job SET status=$2, last_error=$3, run_after=now() + make_interval(secs => $4), finished_at = CASE WHEN $2='DEAD' THEN now() END WHERE id=$1`, [job.id, dead ? 'DEAD' : 'FAILED', String((e as Error).message).slice(0, 2000), backoff]);
    metrics.inc('gazelle_jobs_total', { queue: job.queue, outcome: dead ? 'dead' : 'failed' });
  }
  return true;
}

/** Drain all ready jobs (used by tests and the worker loop). */
export async function drain(queues?: string[], max = 500) {
  let n = 0;
  while (n < max && (await runOnce(queues))) n++;
  return n;
}

/** Reclaim jobs stuck in RUNNING (worker crashed). */
export async function reclaimStale(minutes = 15) {
  await q(getPool(), `UPDATE job SET status='FAILED', last_error='reclaimed after worker timeout' WHERE status='RUNNING' AND locked_at < now() - make_interval(mins => $1)`, [minutes]);
}
