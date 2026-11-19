import { expect, test } from '@playwright/test';
import { staffSignIn } from './auth';
import { e2eEnv } from './env';
import { sql } from './helpers';

/**
 * Team queue: search, filters, sortable columns, priority and URL-persisted view.
 * Three controlled queue items are cloned from an existing task (distinct stage slots) and removed afterwards.
 */
test.skip(e2eEnv.STAFF_AUTH_MODE === 'local', 'Directory-mode suite');

const STAGES = [
  { idx: 901, name: 'Queue test — Alpha review', due: `now() - interval '2 hours'`, breached: 'now()' },
  { idx: 902, name: 'Queue test — Bravo review', due: `now() + interval '30 minutes'`, breached: 'NULL', warn: `now() - interval '5 minutes'` },
  { idx: 903, name: 'Queue test — Charlie review', due: `now() + interval '3 days'`, breached: 'NULL' },
];

test.beforeAll(async () => {
  await sql(`DELETE FROM workflow_task WHERE stage_index >= 900`);
  for (const s of STAGES) {
    await sql(`INSERT INTO workflow_task (instance_id, facility_id, stage_index, stage_key, stage_name, branch_key, task_type, role_code, status, due_at, warn_at, breached_at, sla_policy_config_id, created_at, permitted_actions)
      SELECT instance_id, facility_id, $1, 'QUEUE_TEST_${s.idx}', $2, NULL, 'REVIEW', 'LEGAL', 'OPEN', ${s.due}, ${s.warn ?? 'NULL'}, ${s.breached}, sla_policy_config_id, now() - make_interval(hours => $3), permitted_actions
      FROM workflow_task ORDER BY created_at LIMIT 1`, [s.idx, s.name, s.idx - 900]);
  }
});
test.afterAll(async () => { await sql(`DELETE FROM workflow_task WHERE stage_index >= 900`); });

test('team queue: search, filter, sort and priority; the view is kept in the address', async ({ page }) => {
  await staffSignIn(page, 'demo.legal');
  await page.goto('/work/queue');
  const rows = page.locator('table.data tbody tr').filter({ hasText: 'Queue test' });
  await expect(rows).toHaveCount(3);

  // Default: most urgent first — breached, then approaching, then on track — with priority labels
  await expect(rows.nth(0)).toContainText('Alpha');
  await expect(rows.nth(0)).toContainText('High priority');
  await expect(rows.nth(1)).toContainText('Bravo');
  await expect(rows.nth(1)).toContainText('Medium priority');
  await expect(rows.nth(2)).toContainText('Charlie');

  // Search narrows the list and says so
  await page.getByLabel('Search').fill('charlie');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: /Showing 1 of \d+ tasks/ })).toBeVisible();
  await expect(page).toHaveURL(/q=charlie/);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(3);

  // The SLA metric tiles filter too
  await page.getByRole('button', { name: /SLA breached/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Alpha');
  await page.getByRole('button', { name: /SLA breached/ }).click();
  await expect(rows).toHaveCount(3);

  // Sortable columns announce their direction
  const opened = page.getByRole('columnheader', { name: /Opened/ });
  await opened.getByRole('button').click();
  await expect(opened).toHaveAttribute('aria-sort', 'ascending');
  await expect(rows.nth(0)).toContainText('Charlie'); // opened longest ago (3 h)
  await opened.getByRole('button').click();
  await expect(opened).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.nth(0)).toContainText('Alpha');

  // Filter by stage, then reload: the view survives
  await page.getByLabel('Stage').selectOption('Queue test — Bravo review');
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('Stage')).toHaveValue('Queue test — Bravo review');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('columnheader', { name: /Opened/ })).toHaveAttribute('aria-sort', 'descending');
});
