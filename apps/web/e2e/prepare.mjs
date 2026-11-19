// Reset and seed the isolated e2e database before Playwright starts the servers.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
const k = (l) => createHash('sha256').update(`gazelle-e2e-only:${l}`).digest('base64');
const env = { APP_ENV: 'test', DATABASE_URL: 'postgres://gazelle:gazelle_dev_only@localhost:5432/gazelle_e2e', HMAC_KEY: k('hmac'), DATA_KEY: k('data'), COOKIE_SECURE: 'false', STORAGE_DIR: './storage-e2e', MOCK_AD_DEMO_PASSWORD: 'e2e-demo-password-123', WEB_ORIGIN: 'http://localhost:5173' };
const c = new pg.Client({ connectionString: env.DATABASE_URL });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
await c.end();
execSync('pnpm --filter @gazelle/api seed', { stdio: 'inherit', env: { ...process.env, ...env }, cwd: '../..' });
