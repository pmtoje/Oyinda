import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getPool, closePool } from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map((await pool.query('SELECT name, checksum FROM schema_migration')).rows.map((r) => [r.name, r.checksum]));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration(name, checksum) VALUES ($1,$2)', [file, checksum]);
      await client.query('COMMIT');
      log(`applied ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then(() => closePool())
    .catch(async (e) => {
      console.error(e.message);
      await closePool();
      process.exit(1);
    });
}
