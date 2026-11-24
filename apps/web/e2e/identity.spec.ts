import { expect, test } from '@playwright/test';
import { customerSignIn, staffSignIn } from './auth';
import { e2eEnv } from './env';
import { sql } from './helpers';

/**
 * Promoter identity verification in the browser: the customer verifies a director's BVN and NIN, sees a
 * plain-language difference (never the record itself), asks for a review; two KYC officers clear it.
 * Sandbox provider only — the screens label it as such.
 */
test.skip(e2eEnv.STAFF_AUTH_MODE === 'local', 'Directory-mode suite');

const NAME = 'Ifeoma Chukwu';
let partyId: string;

test.beforeAll(async () => {
  const [c] = await sql(`SELECT id FROM customer WHERE customer_ref='GZ-CUS-000001'`);
  await sql(`UPDATE business_party SET deleted_at=now() WHERE customer_id=$1 AND full_name=$2 AND deleted_at IS NULL`, [c.id, NAME]);
  [{ id: partyId }] = await sql(`INSERT INTO business_party(customer_id, party_type, entity_kind, full_name, designation) VALUES ($1,'DIRECTOR','INDIVIDUAL',$2,'Executive Director') RETURNING id`, [c.id, NAME]);
});
test.afterAll(async () => { await sql(`UPDATE business_party SET deleted_at=now() WHERE id=$1`, [partyId]); });

test('a difference in a director’s records goes to a two-person review, then the director is verified', async ({ page, browser }) => {
  await customerSignIn(page, 'treasury@abc-manufacturing.demo', '08030000001');
  await page.goto('/portal/profile#identity');
  const card = page.locator('.id-person').filter({ has: page.getByRole('heading', { name: NAME }) });
  await expect(card.getByText('Not started')).toBeVisible();
  await card.getByLabel('Date of birth').fill('1990-04-04');
  await card.getByLabel('BVN').fill('22244455566');
  await card.getByLabel('NIN').fill('10044455566');
  await expect(card.getByRole('button', { name: /^Verify Ifeoma/ })).toBeDisabled(); // consent first
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: /^Verify Ifeoma/ }).click();

  await expect(card.getByText('Some details don’t match the identity records')).toBeVisible();
  await expect(card).toContainText('Date of birth on the NIN record does not match what you entered.');
  await expect(card.getByText('SANDBOX')).toBeVisible();
  await expect(card).not.toContainText('1991'); // the record's value is never shown to the customer
  await expect(card).toContainText('BVN •••5566');
  await expect(page.locator('body')).not.toContainText('22244455566');

  await card.getByRole('button', { name: 'Ask the Bank to review' }).click();
  await card.getByLabel('Why do the details differ?').fill('NIN slip shows the wrong birth year; NIMC correction in progress.');
  await card.getByRole('button', { name: 'Ask the Bank to review' }).click();
  await expect(card.getByText('With the Bank for review')).toBeVisible();

  // First KYC officer proposes clearing it
  const k1 = await browser.newContext(); const p1 = await k1.newPage();
  await staffSignIn(p1, 'demo.kyc');
  await p1.getByRole('link', { name: 'Identity reviews' }).click();
  await p1.getByRole('row').filter({ hasText: NAME }).click();
  const drawer = p1.getByRole('dialog', { name: 'Identity review' });
  await expect(drawer.getByText('•••••••5566').first()).toBeVisible();
  await drawer.getByRole('button', { name: 'Show identity records' }).click();
  await expect(drawer.getByRole('cell', { name: '1991-04-04' })).toBeVisible();
  await drawer.getByLabel('Reason and evidence').fill('NIMC correction slip seen; BVN date of birth agrees with passport.');
  await drawer.getByRole('button', { name: 'Submit proposal' }).click();
  await expect(drawer.getByText('Waiting for a second reviewer')).toBeVisible();
  await k1.close();

  // A different officer approves
  const k2 = await browser.newContext(); const p2 = await k2.newPage();
  await staffSignIn(p2, 'demo.kyc2');
  await p2.goto('/work/identity-reviews');
  await p2.getByRole('row').filter({ hasText: NAME }).click();
  const d2 = p2.getByRole('dialog', { name: 'Identity review' });
  await d2.getByLabel('Reason').fill('Evidence reviewed; agree to clear the discrepancy.');
  await d2.getByRole('button', { name: 'Approve proposal' }).click();
  await expect(d2.getByText(/Decided by/)).toBeVisible();
  await k2.close();

  await page.reload();
  await expect(card.getByText('Verified')).toBeVisible();
  await expect(card).toContainText('Identity confirmed after review by the Bank.');
});
