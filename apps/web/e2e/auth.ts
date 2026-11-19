import { expect, type Page } from '@playwright/test';
import { lastOtp, sql, staffSecret, totp } from './helpers';
import { e2eEnv } from './env';

export const otpBox = (p: Page) => p.locator('input[inputmode="numeric"]').first();

export const CUSTOMER_PASSWORD = 'Gazelle#Portal2026';

export async function customerSignIn(page: Page, email: string, phone: string) {
  await sql(`UPDATE otp_challenge SET created_at = created_at - interval '1 hour'`);
  await page.goto('/login');
  await page.getByLabel('Company e-mail address').fill(email);
  await page.getByLabel(/^Password/).fill(CUSTOMER_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(otpBox(page)).toBeVisible();
  await otpBox(page).fill(await lastOtp(phone));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/portal/);
}

export async function staffSignIn(page: Page, username: string) {
  await page.goto('/staff/login');
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel('Password').fill(e2eEnv.MOCK_AD_DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(otpBox(page)).toBeVisible();
  const secret = await staffSecret(username);
  await otpBox(page).fill(totp(secret!));
  await page.getByRole('button', { name: /verify|sign in|continue/i }).last().click();
  await page.waitForURL(/\/work/);
}

