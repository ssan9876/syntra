#!/usr/bin/env node
/**
 * Refreshes docs/images/console from a running Syntra.
 *
 *   node scripts/docs-screenshots.mjs https://syntra.example.com [redactions.json]
 *
 * Opens a visible browser at the instance's sign-in page and waits. A person
 * signs in there -- password, second factor, the console's password
 * confirmation -- and once the console's Overview is on screen the script
 * walks the pages the guide shows and writes one PNG per page.
 *
 * It never handles a credential. Signing in is done by the person at the
 * keyboard, in the browser this opens; the script only reads what the
 * console then displays.
 *
 * REDACTIONS. A live instance shows real people, logins and domains, and the
 * repository should not. The optional JSON file maps text to its stand-in,
 * applied to every text node and input on the page before each capture:
 *
 *   { "Jane Smith": "Alex Doe", "acme-corp.com": "example.com" }
 *
 * Longer keys are applied first, so a full name wins over a surname. A key
 * starting with `=` replaces a whole text node only -- for initials such as
 * `"=JS": "AD"`, which would otherwise rewrite every "JS" on the page. Keep the
 * file outside the repository (or name it `.docs-redactions.json`, which is
 * ignored): it is, by construction, a list of the identifiers being hidden.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/docs-screenshots.mjs <https://instance> [redactions.json]');
  process.exit(2);
}
const redactions = process.argv[3]
  ? Object.entries(JSON.parse(readFileSync(process.argv[3], 'utf8'))).sort(
      ([a], [b]) => b.length - a.length,
    )
  : [];

const OUT = 'docs/images/console';
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ['/admin', '03-overview'],
  ['/admin/users?tab=people', '04-people'],
  ['/admin/users?tab=accounts', '05-accounts'],
  ['/admin/org-units', '06-org-units'],
  ['/admin/applications', '07-applications'],
  ['/admin/sources', '08-sources'],
  ['/admin/targets', '09-targets'],
  ['/admin/provisioning-setup', '10-provisioning-setup'],
  ['/admin/employee-work', '11-employee-work'],
  ['/admin/lifecycle-policy', '12-lifecycle-policy'],
  ['/admin/roles', '13-roles'],
  ['/admin/policy', '14-authentication-policy'],
  ['/admin/activity', '15-activity'],
  ['/admin/operations', '16-operations'],
  ['/admin/settings', '17-settings'],
  ['/admin/updates', '18-updates'],
];

function redact(pairs) {
  const exact = new Map(pairs.filter(([from]) => from.startsWith('=')).map(([from, to]) => [from.slice(1), to]));
  const partial = pairs.filter(([from]) => !from.startsWith('='));
  const swap = (value) => {
    const whole = exact.get(value.trim());
    if (whole !== undefined) return whole;
    return partial.reduce((text, [from, to]) => text.split(from).join(to), value);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = swap(node.nodeValue ?? '');
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  for (const input of document.querySelectorAll('input, textarea')) {
    if (input.type === 'password') continue;
    const next = swap(input.value);
    if (next !== input.value) input.value = next;
  }
  for (const el of document.querySelectorAll('[title]')) {
    el.setAttribute('title', swap(el.getAttribute('title') ?? ''));
  }
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page
    .locator('.skeleton')
    .first()
    .waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => {});
  await page.mouse.move(0, 0);
}

async function shot(page, name, fullPage = false) {
  await settle(page);
  if (redactions.length > 0) await page.evaluate(redact, redactions);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`  ${name}.png`);
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await context.newPage();

// The sign-in page, before anybody types into it.
await page.goto(`${base}/login`);
await shot(page, '01-sign-in');

console.log('\nSign in in the browser window, then open Administration.');
console.log('Waiting for the Overview page (up to 10 minutes)...\n');
await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 600_000 });

await page.goto(`${base}/`);
await shot(page, '02-portal');

for (const [path, name] of PAGES) {
  await page.goto(`${base}${path}`);
  await page.locator('main h1').first().waitFor({ timeout: 20_000 });
  await shot(page, name);
}

// A record of each kind the guide walks through, reached from its list.
const records = [
  ['/admin/users?tab=people', 'main table tbody tr a', '19-person-record'],
  ['/admin/applications', 'main table tbody tr a', '20-application'],
  ['/admin/targets', 'main table tbody tr a', '21-target'],
  ['/admin/sources', 'main table tbody tr a', '22-source'],
];
for (const [path, selector, name] of records) {
  await page.goto(`${base}${path}`);
  await settle(page);
  const link = page.locator(selector).first();
  if (await link.isVisible().catch(() => false)) {
    const before = page.url();
    await link.click();
    await page.waitForURL((url) => url.toString() !== before, { timeout: 20_000 });
    await page.locator('main h1').first().waitFor({ timeout: 20_000 });
    await shot(page, name);
  }
}

await page.goto(`${base}/admin/roles`);
await settle(page);
const edit = page.getByRole('button', { name: 'Edit' }).first();
if (await edit.isVisible().catch(() => false)) {
  await edit.click();
  await shot(page, '23-role-edit');
}

await browser.close();
console.log(`\nWrote ${OUT}/`);
