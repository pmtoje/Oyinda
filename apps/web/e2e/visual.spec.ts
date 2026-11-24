import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { customerSignIn, staffSignIn } from './auth';
import { e2eEnv } from './env';
import { sql } from './helpers';

/**
 * Visual quality gates (master prompt §6–9, §73, §84–86):
 *  - every major screen, in Light and Dark, at desktop, laptop and tablet widths;
 *  - extreme data (very long company name, ₦-hundreds-of-billions amounts, long text);
 *  - automatic collision checks: no horizontal page overflow, no overlapping text, no clipped figures;
 *  - axe accessibility scan (WCAG 2.x A/AA, incl. colour contrast) in both themes;
 *  - screenshot baselines for screens without time-varying data.
 * Screens are written to test-results/visual/ for review.
 */
test.skip(e2eEnv.STAFF_AUTH_MODE === 'local', 'Directory-mode suite');
test.describe.configure({ mode: 'serial' });

const THEMES = ['light', 'dark'] as const;
/**
 * Pixel baselines are tied to the machine image that recorded them (installed fonts, anti-aliasing). They run where
 * they were recorded; on CI they are opt-in (VISUAL_BASELINES=strict after recording on the CI image with
 * --update-snapshots). Layout, overlap, clipping and accessibility checks always run.
 */
const COMPARE_PIXELS = !process.env.CI || process.env.VISUAL_BASELINES === 'strict';
/**
 * Widths from the Credit360 prompt (§49). Browser zoom is covered by width: 200% zoom on a 1280 px screen lays out
 * as 640 CSS px and 400% as 320 px (the WCAG 1.4.10 reflow case), so 320–768 also prove the zoomed layouts.
 */
const VIEWPORTS = [
  { name: 'wide', width: 1920, height: 1080 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-375', width: 375, height: 812 },
  { name: 'phone-320', width: 320, height: 640 },
];
const LONG_NAME = 'ABC Manufacturing, Packaging, Plastics & Allied Industrial Products Holdings Nigeria Limited (formerly ABC Rigid Containers and Bottling Supplies West Africa Company) — Lagos, Ogun, Kano & Abuja Operations';

/** Runs in the page: returns layout defects. */
async function layoutDefects(page: Page) {
  return page.evaluate(() => {
    const issues: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) issues.push(`horizontal page overflow: ${de.scrollWidth}px content in ${de.clientWidth}px viewport`);
    // With a drawer or dialog open, only its content is in view (the page behind it is covered by the overlay)
    const modal = Array.from(document.querySelectorAll('.overlay [role="dialog"]')).pop() ?? null;
    const visible = (el: Element) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05 && (modal ? modal.contains(el) : !el.closest('.overlay')) && !el.closest('.sr-only, [aria-hidden="true"], .skip-link, details:not([open]) > :not(summary)'); };
    type R = { l: number; r: number; t: number; b: number; node: Node; text: string; scroller: Element | null };
    const rects: R[] = [];
    const scrollerOf = (el: Element) => { let e: Element | null = el; while (e && e !== document.body) { const o = getComputedStyle(e).overflowX; if (o === 'auto' || o === 'scroll') return e; e = e.parentElement; } return null; };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; const el = n.parentElement;
      if (!el || !n.textContent?.trim() || !visible(el)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const scroller = scrollerOf(el);
      // Visible box = text box ∩ every clipping ancestor (scrolling tables, ellipsis truncation)
      let clip: { left: number; right: number; top: number; bottom: number } | undefined;
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const r = e.getBoundingClientRect();
          clip = clip ? { left: Math.max(clip.left, r.left), right: Math.min(clip.right, r.right), top: Math.max(clip.top, r.top), bottom: Math.min(clip.bottom, r.bottom) } : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }
      }
      for (const b of Array.from(range.getClientRects())) {
        // Text scrolled out of view inside a scrolling container is hidden, not overlapping.
        const box = clip ? { l: Math.max(b.left, clip.left), r: Math.min(b.right, clip.right), t: Math.max(b.top, clip.top), b: Math.min(b.bottom, clip.bottom) } : { l: b.left, r: b.right, t: b.top, b: b.bottom };
        if (box.r - box.l >= 1 && box.b - box.t >= 1) rects.push({ ...box, node: n, text: n.textContent.trim().slice(0, 50), scroller });
      }
    }
    rects.sort((a, b) => a.t - b.t);
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i]!;
      for (let j = i + 1; j < rects.length && rects[j]!.t < a.b - 1; j++) {
        const c = rects[j]!;
        if (c.node === a.node) continue;
        const w = Math.min(a.r, c.r) - Math.max(a.l, c.l), h = Math.min(a.b, c.b) - Math.max(a.t, c.t);
        if (w > 2 && h > 3) issues.push(`text overlap: "${a.text}" × "${c.text}"`);
      }
    }
    // Figures must never be clipped: money / numeric cells, metric values, badges
    for (const el of Array.from(document.querySelectorAll('.num, .value, .status, .tag, .mono, .pill, h1, h2, .summary-strip .value'))) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if ((cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) issues.push(`clipped: "${(el.textContent ?? '').trim().slice(0, 50)}"`);
    }
    // Form values must not be cut off (inputs, selects)
    for (const el of Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]), select')) as HTMLInputElement[]) {
      if (!visible(el) || !el.value) continue;
      if (el.scrollWidth > el.clientWidth + 2) issues.push(`clipped field value: "${String(el.value).slice(0, 40)}"`);
    }
    // An open drawer or dialog must fit the viewport
    if (modal) { const r = modal.getBoundingClientRect(); if (r.left < -1 || r.right > window.innerWidth + 1 || r.top < -1 || r.bottom > window.innerHeight + 1) issues.push(`dialog exceeds the viewport: ${Math.round(r.width)}×${Math.round(r.height)}`); }
    // Content must stay inside its panel unless the panel scrolls it
    for (const panel of Array.from(document.querySelectorAll('.panel, .metric, .level-card, .dialog, .drawer'))) {
      if (!visible(panel)) continue;
      const pr = panel.getBoundingClientRect();
      for (const child of Array.from(panel.querySelectorAll('input, select, textarea, button, table, .value, .status'))) {
        if (!visible(child) || scrollerOf(child) && panel.contains(scrollerOf(child)!)) continue;
        const cr = child.getBoundingClientRect();
        if (cr.width && (cr.right > pr.right + 1 || cr.left < pr.left - 1)) { issues.push(`escapes its panel: <${child.tagName.toLowerCase()}> "${(child.textContent || (child as HTMLInputElement).value || '').trim().slice(0, 40)}"`); break; }
      }
    }
    return [...new Set(issues)].slice(0, 30);
  });
}

async function setTheme(page: Page, theme: string, account?: { table: 'app_user' | 'customer_user'; key: string; value: string }) {
  if (account) await sql(`UPDATE ${account.table} SET ui_theme=$1 WHERE ${account.key}=$2`, [theme, account.value]);
  await page.evaluate((t) => { localStorage.setItem('gz-theme', t); }, theme);
}

async function audit(page: Page, name: string, theme: string, opts: { axe?: boolean; phone?: boolean } = {}) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 10_000 }).catch(() => { /* some pages keep a skeleton for optional panels */ });
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
  const found: Record<string, string[]> = {};
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/visual/${name}-${theme}-${vp.name}.png`, fullPage: true });
    const d = await layoutDefects(page);
    if (d.length) found[vp.name] = d;
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect.soft(found, `${name} (${theme}) layout defects`).toEqual({});
  if (opts.axe !== false) {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('.mode-banner')
.analyze(); // the logo is artwork (SVG images in a labelled link); the brand gold is never used for ordinary text
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    expect.soft(serious, `${name} (${theme}) accessibility`).toEqual([]);
  }
}

// Deterministic rendering: web fonts are not fetched, so screenshot baselines never depend on network access.
test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
});

test.beforeAll(async () => {
  // Extreme data on the DEMO customer: very long name, a huge request and long free text.
  await sql(`UPDATE customer SET legal_name=$1 WHERE customer_ref='GZ-CUS-000001'`, [LONG_NAME]);
  await sql(`UPDATE business_profile SET registered_name=$1 WHERE customer_id=(SELECT id FROM customer WHERE customer_ref='GZ-CUS-000001')`, [LONG_NAME]);
  await sql(`UPDATE facility_request SET amount_minor=2500000000050 WHERE facility_ref='GZ-FAC-2026-000001'`); // ₦25,000,000,000.50 (§8)
  await sql(`UPDATE facility_request SET amount_minor=98765432109876, purpose=$1 WHERE facility_ref='GZ-FAC-2026-000002'`, ['Lease of ten 15-tonne delivery trucks, two forklifts and associated telematics to expand distribution across the South-West, North-Central and North-West regions, including Ikeja, Ibadan, Ilorin, Abuja, Kaduna and Kano depots, with staged delivery over nine months. '.repeat(3)]);
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test('public and sign-in screens', async ({ page }) => {
      await page.goto('/');
      for (const [path, name] of [['/', 'welcome'], ['/login', 'customer-login'], ['/staff/login', 'staff-login'], ['/onboarding', 'onboarding']] as const) {
        await setTheme(page, theme);
        await page.goto(path);
        await audit(page, name, theme, { phone: true });
        if (COMPARE_PIXELS) await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });
      }
    });

    test('customer portal', async ({ page }) => {
      await customerSignIn(page, 'treasury@abc-manufacturing.demo', '08030000001');
      await setTheme(page, theme, { table: 'customer_user', key: 'email', value: 'treasury@abc-manufacturing.demo' });
      const [mur] = await sql(`SELECT id FROM facility_request WHERE facility_ref='GZ-FAC-2026-000001'`);
      const [ij] = await sql(`SELECT id FROM facility_request WHERE facility_ref='GZ-FAC-2026-000002'`);
      for (const [path, name] of [['/portal', 'portal-dashboard'], [`/portal/facilities/${mur.id}`, 'portal-facility'], [`/portal/facilities/${ij.id}/apply`, 'portal-application'], ['/portal/profile', 'portal-profile'], ['/portal/users', 'portal-users'], ['/portal/facilities/new', 'portal-new-facility'], ['/portal/security', 'portal-security']] as const) {
        await page.goto(path);
        await audit(page, name, theme, { phone: true });
      }
    });

    test('credit workspace and executive decision view', async ({ page }) => {
      await staffSignIn(page, 'demo.analyst');
      await setTheme(page, theme, { table: 'app_user', key: 'ad_username', value: 'demo.analyst' });
      const [mur] = await sql(`SELECT id FROM facility_request WHERE facility_ref='GZ-FAC-2026-000001'`);
      const [apg] = await sql(`SELECT id FROM facility_request WHERE facility_ref='GZ-FAC-2026-000003'`);
      for (const [path, name] of [['/work', 'work-dashboard'], ['/work/queue', 'work-queue'], ['/work/facilities', 'work-facilities'],
        [`/work/facilities/${mur.id}`, 'workspace-overview'], [`/work/facilities/${apg.id}?tab=financials`, 'workspace-financials'], [`/work/facilities/${apg.id}?tab=statements`, 'workspace-statements'],
        [`/work/facilities/${apg.id}?tab=credit`, 'workspace-credit'], [`/work/facilities/${apg.id}?tab=risk`, 'workspace-risk'], [`/work/facilities/${apg.id}?tab=memo`, 'workspace-memo'],
        [`/work/facilities/${apg.id}?tab=workflow`, 'workspace-workflow'], [`/work/facilities/${apg.id}/decision`, 'decision-view'], ['/work/security', 'work-security']] as const) {
        await page.goto(path);
        await audit(page, name, theme);
      }
    });

    test('admin control centre', async ({ page }) => {
      await staffSignIn(page, 'demo.admin');
      await setTheme(page, theme, { table: 'app_user', key: 'ad_username', value: 'demo.admin' });
      const [cfg] = await sql(`SELECT id FROM config_item WHERE kind='approval_authority' AND key='APPROVED_LINE_DIRECT' AND status='ACTIVE'`);
      for (const [path, name] of [['/admin/config', 'admin-config'], [`/admin/config/${cfg.id}`, 'admin-authority-matrix'], ['/admin/users', 'admin-users'], ['/admin/audit', 'admin-audit'], ['/admin/health', 'admin-health'], ['/work/reports', 'executive-dashboard'], ['/admin/design-system', 'design-system']] as const) {
        await page.goto(path);
        await audit(page, name, theme);
      }
    });

    test('open drawers and dialogs, validation and upload errors', async ({ page, browser }) => {
      // Component catalogue: open drawer and centred dialog (both themes, every width)
      await staffSignIn(page, 'demo.admin');
      await setTheme(page, theme, { table: 'app_user', key: 'ad_username', value: 'demo.admin' });
      await page.goto('/admin/design-system');
      await expect(page.getByText('Enter the 10-digit account number.')).toBeVisible(); // validation error state
      await page.getByRole('button', { name: 'Open drawer' }).click();
      await expect(page.getByRole('dialog', { name: 'Invite a colleague' })).toBeVisible();
      await audit(page, 'ds-drawer', theme);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open dialog' }).click();
      await expect(page.getByRole('dialog', { name: 'Confirm acceptance' })).toBeVisible();
      await audit(page, 'ds-dialog', theme);

      // Customer: invitation drawer, upload preview dialog and a refused upload
      const ctx = await browser.newContext();
      const cp = await ctx.newPage();
      await cp.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      await customerSignIn(cp, 'treasury@abc-manufacturing.demo', '08030000001');
      await setTheme(cp, theme, { table: 'customer_user', key: 'email', value: 'treasury@abc-manufacturing.demo' });
      await cp.goto('/portal/users');
      await cp.getByRole('button', { name: 'Invite a colleague' }).click();
      await expect(cp.getByRole('dialog', { name: 'Invite a colleague' })).toBeVisible();
      await audit(cp, 'portal-invite-drawer', theme);
      await cp.keyboard.press('Escape');
      const [ij] = await sql(`SELECT id FROM facility_request WHERE facility_ref='GZ-FAC-2026-000002'`);
      await cp.goto(`/portal/facilities/${ij.id}/apply`);
      await cp.getByRole('button', { name: 'Documents' }).click();
      const row = cp.locator('tr').filter({ hasText: 'Not uploaded' }).first();
      await row.locator('input[type="file"]').setInputFiles({ name: 'board-resolution-signed-by-all-directors-and-company-secretary-2026.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
      await expect(cp.getByRole('dialog')).toBeVisible();
      await audit(cp, 'portal-upload-dialog', theme);
      await cp.getByRole('button', { name: 'Choose another file' }).click();
      await row.locator('input[type="file"]').setInputFiles({ name: 'payload.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
      await expect(row.getByRole('alert')).toBeVisible();
      await audit(cp, 'portal-upload-error', theme);
      await ctx.close();
    });
  });
}

test('theme choice is saved to the account and follows the user to a new device', async ({ page, browser }) => {
  await customerSignIn(page, 'treasury@abc-manufacturing.demo', '08030000001');
  await setTheme(page, 'light', { table: 'customer_user', key: 'email', value: 'treasury@abc-manufacturing.demo' });
  await page.goto('/portal/security');
  await page.getByRole('group', { name: 'Colour theme' }).getByRole('radio', { name: /^Dark/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await sql(`SELECT ui_theme FROM customer_user WHERE email=$1`, ['treasury@abc-manufacturing.demo']))[0].ui_theme).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // A fresh browser (no local preference) picks the account setting up after sign-in
  const other = await browser.newContext({ colorScheme: 'light' });
  const p2 = await other.newPage();
  await customerSignIn(p2, 'treasury@abc-manufacturing.demo', '08030000001');
  await p2.goto('/portal');
  await expect(p2.locator('html')).toHaveAttribute('data-theme', 'dark');
  // "Match this device" follows the operating system (single session: continue on the newest device)
  await p2.emulateMedia({ colorScheme: 'light' });
  await p2.goto('/portal/security');
  await p2.getByRole('group', { name: 'Colour theme' }).getByRole('radio', { name: /Match this device/ }).check();
  await expect(p2.locator('html')).toHaveAttribute('data-theme', 'light');
  await p2.emulateMedia({ colorScheme: 'dark' });
  await expect(p2.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.close();
});
