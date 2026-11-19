import pg from 'pg';
import { env } from '../config/env.js';

// bigint (int8) → JS number. Minor-unit amounts stay well within 2^53.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('int8 value exceeds safe integer range');
  return n;
});
// numeric → number (ratios, rates). Exact money is stored as minor-unit bigint, never numeric.
pg.types.setTypeParser(1700, (v) => Number(v));
// date → keep as ISO string (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 20, idleTimeoutMillis: 30_000, statement_timeout: 30_000 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function q<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(db, sql, params);
  if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
  return rows[0]!;
}

export async function maybe<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(db, sql, params);
  return rows[0];
}

/** Run fn in a transaction. Serialization failures and deadlocks are retried. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err?.code === '40001' || err?.code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
