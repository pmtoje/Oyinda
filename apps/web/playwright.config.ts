import { defineConfig } from '@playwright/test';
import { e2eEnv } from './e2e/env';


/** Browser journeys against a real API + isolated e2e database seeded with DEMO data. */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
    viewport: { width: 1360, height: 900 },
  },
  webServer: [
    { command: 'pnpm --filter @gazelle/api start', url: 'http://127.0.0.1:4000/health/ready', reuseExistingServer: false, env: e2eEnv, timeout: 120_000, cwd: '../..' },
    { command: 'pnpm --filter @gazelle/web dev', url: 'http://localhost:5173', reuseExistingServer: false, timeout: 60_000, cwd: '../..' },
  ],
});
