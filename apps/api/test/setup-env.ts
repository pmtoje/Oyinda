import { createHash } from 'node:crypto';
// Test-only environment. Keys are derived from fixed labels so every test file (and the shared test DB) agree.
// They protect only throwaway test data and are not secrets.
const testKey = (label: string) => createHash('sha256').update(`gazelle-test-only:${label}`).digest('base64');
process.env.APP_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://gazelle:gazelle_dev_only@localhost:5432/gazelle_test';
process.env.HMAC_KEY = testKey('hmac');
process.env.DATA_KEY = testKey('data');
process.env.COOKIE_SECURE = 'false';
process.env.STORAGE_DIR = './storage-test';
process.env.MOCK_AD_DEMO_PASSWORD = 'test-demo-password-1234';
process.env.LOG_LEVEL = 'error';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.AUTH_RATE_LIMIT_PER_15MIN = '100000';
