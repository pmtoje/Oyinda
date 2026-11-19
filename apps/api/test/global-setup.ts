import pg from 'pg';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://gazelle:gazelle_dev_only@localhost:5432/gazelle_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
}
