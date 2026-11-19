import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { sql, staffSecret, totp } from './helpers';
import { e2eEnv } from './env';

test.skip(e2eEnv.STAFF_AUTH_MODE !== 'local', 'Run with `pnpm e2e:local`');
test.describe.configure({ mode: 'serial' });

const otpBox = (p: Page) => p.locator('input[inputmode="numeric"]').first();
const PASSWORD = 'Harmattan#Breeze2026x';
const linkFor = async (email: string) => {
  const r = await sql('SELECT body FROM mock_outbox WHERE destination=$1 ORDER BY id DESC LIMIT 1', [email]);
  return /\/staff\/set-password\?token=[A-Za-z0-9_-]+/.exec(r[0]?.body ?? '')![0];
};

test('Interim sign-in: the first administrator activates, sets a password, enrols the authenticator and works', async ({ page }) => {
  // Bootstrap: the operator command e-mails an activation link (there is no administrator yet to send one).
  execSync('pnpm --filter @gazelle/api staff:activation-link demo.admin', { cwd: '../..', env: { ...process.env, ...e2eEnv }, stdio: 'pipe' });
  await page.goto(await linkFor('demo.admin@altbank.demo'));
  await expect(page.getByRole('heading', { name: 'Activate your account' })).toBeVisible();
  expect(page.url()).not.toContain('token='); // removed from the address bar
  await page.getByLabel(/^New password/).fill('weak');
  await page.getByLabel(/^Confirm new password/).fill('weak');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('dialog', { name: 'Your password needs attention' })).toContainText('At least 14 characters');
  await page.getByRole('button', { name: 'Update password' }).click();
  await page.getByLabel(/^New password/).fill(PASSWORD);
  await page.getByLabel(/^Confirm new password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password set')).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/staff-set-password.png', fullPage: true });

  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await expect(page.getByText(/Interim sign-in until Active Directory/)).toBeVisible();
  await page.getByLabel('Username').fill('demo.admin');
  await page.getByLabel('Gazelle password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
  await otpBox(page).fill(totp((await staffSecret('demo.admin'))!));
  await page.getByRole('button', { name: /verify|sign in|continue/i }).last().click();
  await page.waitForURL(/\/work/);
  await expect(page.getByText('Interim staff sign-in (Gazelle passwords) until Active Directory')).toBeVisible();

  // The administrator sends a colleague their activation link; nobody sees the password.
  await page.goto('/admin/users');
  await page.getByText('Amina Bello (DEMO RM)').first().click();
  await page.getByRole('button', { name: 'Send activation link' }).click();
  await expect(page.getByText(/Activation link sent to/)).toBeVisible();
  expect(await linkFor('demo.rm@altbank.demo')).toContain('set-password');
});

test('Forgotten password gives the same answer whether or not the user exists', async ({ page }) => {
  for (const u of ['demo.rm', 'nobody.here']) {
    await page.goto('/staff/forgot-password');
    await page.getByLabel('Username').fill(u);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(/If the username is registered/)).toBeVisible();
  }
});
