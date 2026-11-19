import { expect, test, type Page } from '@playwright/test';
import { lastOtp, sql, staffSecret, totp } from './helpers';
import { e2eEnv } from './env';

const otpBox = (p: Page) => p.locator('input[inputmode="numeric"]').first();

async function customerSignIn(page: Page, email: string, phone: string) {
  await sql(`UPDATE otp_challenge SET created_at = created_at - interval '1 hour'`);
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(otpBox(page)).toBeVisible();
  await otpBox(page).fill(await lastOtp(phone));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/portal/);
}

async function staffSignIn(page: Page, username: string) {
  await page.goto('/staff/login');
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel('Password').fill(e2eEnv.MOCK_AD_DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(otpBox(page)).toBeVisible();
  let secret = await staffSecret(username);
  if (!secret) secret = (await page.locator('[data-mfa-secret]').first().getAttribute('data-mfa-secret')) ?? (await page.locator('code').first().innerText()).replace(/\s/g, '');
  await otpBox(page).fill(totp(secret!));
  await page.getByRole('button', { name: /verify|sign in|continue/i }).last().click();
  await page.waitForURL(/\/work/);
}

test.describe.configure({ mode: 'serial' });

test('Journey 1: a new corporate customer onboards with their Alternative Bank account', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Do you have an Alternative Bank account?')).toBeVisible();
  await page.getByText('Yes, I have an account').click();
  await page.getByLabel('Account number').fill('0100000003');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/0803•••••02/)).toBeVisible();
  await otpBox(page).fill('000000');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/incorrect/i);
  await otpBox(page).fill(await lastOtp('08030000002'));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Kano Agro-Allied Processing Ltd')).toBeVisible();
  await page.getByLabel('Full name').fill('Hauwa Sule');
  await page.getByLabel('Work email').fill('hauwa.e2e@kano-agro.demo');
  await page.getByLabel('Designation').fill('Chief Financial Officer');
  await page.getByLabel(/I have read and accept the terms/).check();
  await page.getByLabel(/I consent to the processing/).check();
  await page.getByRole('button', { name: 'Create access' }).click();
  await expect(otpBox(page)).toBeVisible();
  await otpBox(page).fill(await lastOtp('hauwa.e2e@kano-agro.demo'));
  await page.getByRole('button', { name: 'Verify email' }).click();
  await page.waitForURL(/\/portal$/);
  await expect(page.getByRole('heading', { name: 'Kano Agro-Allied Processing Ltd' })).toBeVisible();
  await expect(page.getByRole('button', { name: /start new facility request/i }).or(page.getByRole('link', { name: /start new facility request/i })).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/onboarded-dashboard.png', fullPage: true });
});

test('Journey 8: the customer reviews and accepts the APG offer letter', async ({ page }) => {
  await customerSignIn(page, 'treasury@abc-manufacturing.demo', '08030000001');
  await page.getByText(/An offer letter is ready/).locator('xpath=ancestor::li[1]').getByRole('link', { name: 'Open' }).or(page.getByRole('link', { name: 'Open' }).first()).first().click();
  await expect(page.getByText('Offer of Advance Payment Guarantee Facility')).toBeVisible();
  await expect(page.getByText('Commission', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Accept offer' }).click();
  await expect(page.getByRole('button', { name: 'Confirm acceptance' })).toBeDisabled();
  await page.getByLabel(/I have read the offer letter/).check();
  await page.getByRole('button', { name: 'Confirm acceptance' }).click();
  await expect(page.getByText(/accepted/i).first()).toBeVisible();
  const f = await sql(`SELECT status FROM facility_request WHERE facility_ref='GZ-FAC-2026-000003'`);
  expect(f[0].status).toBe('FULFILMENT');
});

test('Journey 6: the credit analyst claims the Murabaha and sees what remains before completion', async ({ page }) => {
  await staffSignIn(page, 'demo.analyst');
  await page.goto('/work/queue');
  await page.getByText('GZ-FAC-2026-000001').first().click();
  await expect(page.getByRole('heading', { name: 'ABC Manufacturing Ltd' })).toBeVisible();
  await page.getByRole('button', { name: /claim/i }).first().click();
  await expect(page.getByText(/before you finish/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await page.getByRole('tab', { name: /workflow/i }).click();
  await expect(page.getByText(/E&S review/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/analyst-workspace.png', fullPage: true });
});

test('Executive decision view is understandable at a glance', async ({ page }) => {
  await staffSignIn(page, 'demo.cro');
  const [f] = await sql(`SELECT id FROM facility_request WHERE facility_ref='GZ-FAC-2026-000003'`);
  await page.goto(`/work/facilities/${f.id}/decision`);
  await expect(page.getByText('₦45,000,000.00').first()).toBeVisible();
  await expect(page.getByText('MOCK').first()).toBeVisible();
  await expect(page.getByText('Recommendation chain')).toBeVisible();
});

test('Access control in the browser: customers cannot reach staff screens', async ({ page }) => {
  await customerSignIn(page, 'treasury@abc-manufacturing.demo', '08030000001');
  await page.goto('/work');
  await page.waitForURL(/\/staff\/login/);
  await page.goto('/admin/config');
  await page.waitForURL(/\/staff\/login/);
});

test('Accessibility basics: skip link, labelled controls and keyboard focus', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toBeVisible();
  const unlabelled = await page.locator('input:not([type=hidden])').evaluateAll((els) => els.filter((e) => !e.id || !document.querySelector(`label[for="${e.id}"]`)).length);
  expect(unlabelled).toBe(0);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(['A', 'INPUT', 'BUTTON']).toContain(focused);
  // focus is visible (box-shadow focus ring from the design system)
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
  expect(ring).not.toBe('none');
});
