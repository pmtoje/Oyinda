import { createHash } from 'node:crypto';
// Throwaway keys for the isolated e2e database only.
const k = (l: string) => createHash('sha256').update(`gazelle-e2e-only:${l}`).digest('base64');
export const e2eEnv: Record<string, string> = {
  APP_ENV: 'test', DATABASE_URL: 'postgres://gazelle:gazelle_dev_only@localhost:5432/gazelle_e2e', HMAC_KEY: k('hmac'), DATA_KEY: k('data'),
  COOKIE_SECURE: 'false', STORAGE_DIR: './storage-e2e', MOCK_AD_DEMO_PASSWORD: 'e2e-demo-password-123', WEB_ORIGIN: 'http://localhost:5173', LOG_LEVEL: 'warn', AUTH_RATE_LIMIT_PER_15MIN: '1000',
};
