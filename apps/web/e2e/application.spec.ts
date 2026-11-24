import { expect, test } from '@playwright/test';
import { customerSignIn } from './auth';
import { e2eEnv } from './env';
import { sql } from './helpers';

/**
 * A customer applies for a Murabaha entirely through the portal: product choice, every step, documents, declaration
 * and submission. Guards two regressions: (1) a new request skips "Verify identity" when every required promoter is
 * already verified; (2) right after submission the page shows the submitted state, never the cached draft.
 */
test.skip(e2eEnv.STAFF_AUTH_MODE === 'local', 'Directory-mode suite');

const pdf = (label: string) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n% ${label} ${Math.random()}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const saveAndContinue = (p: import('@playwright/test').Page) => p.getByRole('button', { name: 'Save and continue', exact: true }).first().click();

test('a customer completes and submits a Murabaha; the request shows as submitted immediately', async ({ page }) => {
  await customerSignIn(page, 'treasury@abc-manufacturing.demo', '08030000001');
  await page.getByRole('link', { name: /Start new facility request/i }).or(page.getByRole('button', { name: /Start new facility request/i })).first().click();
  await page.getByRole('button', { name: /^Murabaha/ }).click();
  await expect(page.locator('.action-rail')).toContainText('Shariah structure');
  await page.getByRole('button', { name: /Continue with Murabaha/ }).click();
  await page.waitForURL(/\/apply$/);
  const facilityId = /facilities\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  // Promoters are already verified, so the request opens on the facility details and the identity step shows done
  await expect(page.getByLabel('Facility amount')).toBeVisible();
  await expect(page.locator('.stepper li.done').filter({ hasText: 'Verify identity' })).toHaveCount(1);

  await page.getByLabel('Facility amount').fill('150000000');
  await page.getByLabel('Tenor (months)').fill('24');
  await page.getByLabel('Payment frequency').selectOption('MONTHLY');
  await page.getByLabel('Purpose of the facility').fill('Purchase of PET resin for bottle production');
  await page.getByLabel('Proposed payment structure').fill('24 equal monthly instalments of the Murabaha sale price');
  await page.getByLabel('Source of payment').fill('Sales proceeds from bottling customers, domiciled with Alternative Bank');
  await saveAndContinue(page);

  await page.getByLabel('Supplier / vendor').fill('Resin Supplies FZE (DEMO)');
  await page.getByLabel('Underlying asset or goods').fill('1,200 tonnes bottle-grade PET resin');
  await page.getByLabel('Goods or asset to be purchased').fill('1,200 tonnes bottle-grade PET resin');
  await page.getByLabel('Supplier pro-forma invoice reference').fill('PFI-2026-118');
  await page.getByLabel('Cost of goods (supplier price)').fill('140000000');
  await page.getByLabel('Delivery location').fill('Ikeja, Lagos');
  await saveAndContinue(page);

  await page.getByLabel('Security you propose to offer').fill('Legal mortgage over the Ikeja factory; domiciliation of receivables');
  await saveAndContinue(page); // → financial statements
  await saveAndContinue(page); // → bank statements
  await saveAndContinue(page); // → documents

  // Upload every document still outstanding, each through its own control
  const outstanding = page.locator('tr').filter({ hasText: 'Not uploaded' });
  await expect(outstanding.first()).toBeVisible();
  for (let i = 0; (await outstanding.count()) > 0 && i < 15; i++) {
    const row = outstanding.first();
    const title = (await row.locator('td').first().innerText()).split('\n')[0]!;
    await row.locator('input[type="file"]').setInputFiles({ name: `document-${i + 1}.pdf`, mimeType: 'application/pdf', buffer: pdf(`doc ${i}`) });
    await expect(page.locator('tr').filter({ hasText: title }).getByText(/Uploaded|Verified/).first()).toBeVisible({ timeout: 15_000 });
  }
  await saveAndContinue(page); // → review

  await expect(page.getByText('All sections are complete.')).toBeVisible();
  await page.getByLabel(/I confirm that the information in this request is true/).check();
  await page.getByRole('button', { name: /^Submit/ }).click();
  await page.waitForURL(new RegExp(`/portal/facilities/${facilityId}$`));
  // No stale draft: submitted status, no "continue" action, without waiting for any cache to expire
  // (the status badge specifically — the step indicator also has an "Under review" label)
  await expect(page.locator('.badge').filter({ hasText: /^Under Review$/ }).first()).toBeVisible({ timeout: 1500 });
  await expect(page.getByRole('button', { name: 'Continue application' })).toHaveCount(0, { timeout: 1000 });
  await expect(page.locator('.badge').filter({ hasText: /^Draft$/ })).toHaveCount(0, { timeout: 1000 });
  const [f] = await sql(`SELECT status FROM facility_request WHERE id=$1`, [facilityId]);
  expect(['SUBMITTED', 'IN_REVIEW']).toContain(f.status);
});
