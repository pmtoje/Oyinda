import { randomBytes } from 'node:crypto';
// Test-only environment. Keys are generated per run; nothing here is a real secret.
process.env.APP_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://gazelle:gazelle_dev_only@localhost:5432/gazelle_test';
process.env.HMAC_KEY ??= randomBytes(32).toString('base64');
process.env.DATA_KEY ??= randomBytes(32).toString('base64');
process.env.COOKIE_SECURE = 'false';
process.env.STORAGE_DIR = './storage-test';
process.env.MOCK_AD_DEMO_PASSWORD = 'test-demo-password-1234';
process.env.LOG_LEVEL = 'error';
process.env.WEB_ORIGIN = 'http://localhost:5173';
