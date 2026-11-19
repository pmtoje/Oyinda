import { expect, test, type Page } from '@playwright/test';
import { lastOtp, sql, staffSecret, totp } from './helpers';
import { e2eEnv } from './env';

const otpBox = (p: Page) => p.locator('input[inputmode="numeric"]').first();

const CUSTOMER_PASSWORD = 'Gazelle#Portal2026';

async function customerSignIn(page: Page, email: string, phone: string) {
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

async function staffSignIn(page: Page, username: string) {
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

test.describe.configure({ mode: 'serial' });
test.skip(e2eEnv.STAFF_AUTH_MODE === 'local', 'Directory-mode journeys; the interim sign-in journey is in local-auth.spec.ts');

test('Journey 1: a new corporate customer onboards with their Alternative Bank account', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Do you have an Alternative Bank account?')).toBeVisible();
  await page.getByText('Yes, I have an account').click();
  await page.getByLabel('Company account number').fill('0100000003');
  await page.getByLabel('Your full name').fill('Hauwa Sule');
  await page.getByLabel('Your role in the company').fill('Chief Financial Officer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/0803•••••02/)).toBeVisible();
  await expect(page.getByText('KANO AGRO-ALLIED PROCESSING LTD')).toHaveCount(0); // name shown only after the OTP
  await otpBox(page).fill('000000');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/incorrect/i);
  await otpBox(page).fill(await lastOtp('finance@kano-agro.demo'));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'KANO AGRO-ALLIED PROCESSING LTD' })).toBeVisible();
  await expect(page.getByLabel(/Username/)).toHaveValue('finance@kano-agro.demo');
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('weak');
  await page.getByLabel('Confirm password').fill('weak');
  await page.getByLabel(/I have read and accept the terms/).check();
  await page.getByLabel(/I accept the data privacy terms/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  const popup = page.getByRole('dialog', { name: 'Your password needs attention' });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(/At least 12 characters/);
  await popup.getByRole('button', { name: 'Update password' }).click();
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(CUSTOMER_PASSWORD);
  await page.getByLabel('Confirm password').fill(CUSTOMER_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Your account is ready')).toBeVisible();
  const mail = await sql(`SELECT body FROM mock_outbox WHERE destination='finance@kano-agro.demo' ORDER BY id DESC LIMIT 1`);
  const link = /verify-email\?token=[A-Za-z0-9_-]+/.exec(mail[0].body)![0];
  await page.goto('/' + link);
  await expect(page.getByText('E-mail address confirmed')).toBeVisible();
  await page.getByRole('link', { name: 'Go to your dashboard' }).click();
  await page.waitForURL(/\/portal$/);
  await expect(page.getByRole('heading', { name: 'Kano Agro-Allied Processing Ltd' })).toBeVisible();
  await expect(page.getByText("Your business on the Bank's records")).toBeVisible();
  await expect(page.getByText('RC7654321')).toBeVisible();
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
  await expect(page.getByText(/E&S risk review not required/).first()).toBeVisible();
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
  await expect(page.getByLabel('Company e-mail address')).toBeVisible();
  const unlabelled = await page.locator('input:not([type=hidden])').evaluateAll((els) => els.filter((e) => !e.id || !document.querySelector(`label[for="${e.id}"]`)).length);
  expect(unlabelled).toBe(0);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(['A', 'INPUT', 'BUTTON']).toContain(focused);
  // focus is visible (box-shadow focus ring from the design system)
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
  expect(ring).not.toBe('none');
});

test('Admin loads staff from a spreadsheet; a second administrator approves it', async ({ page }) => {
  const header = ['Username (AD)', 'Full name', 'E-mail', 'Staff number', 'Directorate code', 'Business unit code', 'Roles', 'Line manager username', 'Personal approval limits (NGN)', 'Sectors', 'Status'];
  const csv = `${header.join(',')}\ne2e.rm,E2E Imported RM,e2e.rm@altbank.demo,E2E-001,COMM,LAG-COMM-1,RM,demo.bm,,,ACTIVE\n`;
  await staffSignIn(page, 'demo.admin');
  await page.goto('/admin/users');
  await page.getByRole('tab', { name: 'Import from spreadsheet' }).click();
  await expect(page.getByRole('link', { name: 'Download template' })).toBeVisible();
  await page.getByLabel(/Spreadsheet/).setInputFiles({ name: 'staff.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate file' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Another administrator must review and approve this upload.');
  await expect(drawer).toContainText('Create E2E Imported RM');
  await expect(drawer.getByRole('button', { name: 'Approve and apply' })).toHaveCount(0);
  expect(await sql(`SELECT 1 FROM app_user WHERE ad_username='e2e.rm'`)).toHaveLength(0);
  await page.screenshot({ path: 'test-results/screens/staff-import-preview.png', fullPage: true });
  await page.context().clearCookies();
  await staffSignIn(page, 'demo.superadmin');
  await page.goto('/admin/users');
  await page.getByRole('tab', { name: 'Import from spreadsheet' }).click();
  await page.getByRole('button', { name: 'Review' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve and apply' }).click();
  await expect(page.getByRole('row', { name: /staff\.csv/ }).first()).toContainText('Applied');
  const u = await sql(`SELECT u.source, m.ad_username AS manager FROM app_user u JOIN app_user m ON m.id=u.manager_id WHERE u.ad_username='e2e.rm'`);
  expect(u[0]).toMatchObject({ source: 'SPREADSHEET', manager: 'demo.bm' });
});
