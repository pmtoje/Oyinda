import { expect, test, type Page } from '@playwright/test';
import { customerSignIn } from './auth';
import { e2eEnv } from './env';
import { sql } from './helpers';

/**
 * Inactivity timeout with warning (session policy: 15 min idle, 2 min warning in the baseline).
 * The browser clock is controlled; the server-side expiry is moved directly in the database.
 */
test.skip(e2eEnv.STAFF_AUTH_MODE === 'local', 'Directory-mode suite');

const EMAIL = 'treasury@abc-manufacturing.demo';
const setIdle = (expr: string) => sql(`UPDATE auth_session SET idle_expires_at = ${expr} WHERE subject_id=(SELECT id FROM customer_user WHERE email=$1) AND revoked_at IS NULL`, [EMAIL]);
/** Let the browser's slow passive poll (every 60 s) run without any user activity. */
const nextPoll = (page: Page) => page.clock.fastForward(61_000);

test('warns before an idle sign-out, lets the user stay, and keeps what they typed', async ({ page }) => {
  await page.clock.install();
  await customerSignIn(page, EMAIL, '08030000001');
  await page.goto('/portal/profile');
  const products = page.getByLabel('Products and services');
  await expect(products).toBeVisible();
  const typed = `Rigid PET containers and closures — draft not yet saved ${Date.now()}`;
  await products.fill(typed);

  // 90 seconds left on the server: the next check opens the warning (lead time 120 s)
  await setIdle(`now() + interval '90 seconds'`);
  await nextPoll(page);
  const dialog = page.getByRole('alertdialog', { name: 'Are you still there?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('signed out after 15 minutes without activity');
  await expect(dialog.getByText(/Signing out in \d:\d\d/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Stay signed in' })).toBeFocused();

  // Stay signed in: the server extends the session and the warning closes
  await dialog.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toBeHidden();
  const [row] = await sql(`SELECT extract(epoch FROM idle_expires_at - now())::int AS left FROM auth_session WHERE subject_id=(SELECT id FROM customer_user WHERE email=$1) AND revoked_at IS NULL`, [EMAIL]);
  expect(row.left).toBeGreaterThan(14 * 60);

  // Ignore the next warning: the session ends, the user lands on sign-in with an explanation
  await setIdle(`now() + interval '30 seconds'`);
  await nextPoll(page);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await setIdle(`now() - interval '1 second'`);
  await page.clock.fastForward(31_000);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status').filter({ hasText: 'signed out after a period of inactivity' })).toBeVisible();

  // Sign in again: offered to restore the unsaved entry on the same page
  await page.clock.resume();
  await customerSignIn(page, EMAIL, '08030000001');
  await page.goto('/portal/profile');
  await expect(page.getByText('You were signed out before saving')).toBeVisible();
  await expect(page.getByLabel('Products and services')).not.toHaveValue(typed);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByLabel('Products and services')).toHaveValue(typed);
  await expect(page.getByText(/Restored 1 entry/)).toBeVisible();
});

test('background refreshes alone never keep an idle session alive', async ({ page }) => {
  await page.clock.install();
  await customerSignIn(page, EMAIL, '08030000001');
  await page.goto('/portal');
  await page.waitForLoadState('networkidle');
  const active: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && !r.headers()['x-gz-passive'] && !r.url().includes('/api/auth/session/status')) active.push(`${r.method()} ${r.url()}`); });
  await setIdle(`now() + interval '5 minutes'`);
  // Several notification refreshes and status checks later, the server expiry has not moved
  for (let i = 0; i < 3; i++) await nextPoll(page);
  const [row] = await sql(`SELECT extract(epoch FROM idle_expires_at - now())::int AS left FROM auth_session WHERE subject_id=(SELECT id FROM customer_user WHERE email=$1) AND revoked_at IS NULL`, [EMAIL]);
  expect(active).toEqual([]);
  expect(row.left).toBeLessThanOrEqual(300);
});
