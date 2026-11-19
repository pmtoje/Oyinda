import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';

/** Atomically allocate the next human reference in a scope, e.g. GZ-FAC-2026-000001. Must run inside the creating transaction. */
export async function nextRef(db: Db, scope: 'FAC' | 'CUS', now = new Date()): Promise<string> {
  const period = scope === 'FAC' ? String(now.getUTCFullYear()) : 'ALL';
  const row = await one<{ value: number }>(
    db,
    `INSERT INTO id_counter(scope, period, value) VALUES ($1,$2,1)
     ON CONFLICT (scope, period) DO UPDATE SET value = id_counter.value + 1 RETURNING value`,
    [scope, period],
  );
  const seq = String(row.value).padStart(6, '0');
  return scope === 'FAC' ? `GZ-FAC-${period}-${seq}` : `GZ-CUS-${seq}`;
}
