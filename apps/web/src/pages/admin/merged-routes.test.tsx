import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The sixteen paths that became tabs still resolve.
 *
 * Merging twenty-nine destinations into thirteen retired sixteen URLs, and
 * none of them was only ever typed into this application's own navigation.
 * They are in browser bookmarks, in runbooks, in the body of approval emails
 * the notification templates have already sent, and in tickets that outlive
 * any navigation change. A 404 for each of those is a worse answer than the
 * screen the reader meant.
 *
 * Two properties, and both matter:
 *
 * 1. Every retired path still has a route, and it redirects.
 * 2. It redirects to the RIGHT TAB, not merely to the merged page. Landing on
 *    "Governance" when the link said "orphans" leaves the reader to work out
 *    which of seven tabs they wanted, which is the cost the merge was supposed
 *    to remove.
 *
 * Read from the source rather than rendered because `AdminApp` mounts the
 * whole console; the routing table is the unit under test.
 */

const source = readFileSync('src/pages/admin/AdminApp.tsx', 'utf8');

const RETIRED: [string, string][] = [
  ['people', '/admin/users?tab=people'],
  ['import', '/admin/users?tab=import'],
  ['sync-runs', '/admin/sources?tab=runs'],
  ['branding', '/admin/settings?tab=branding'],
  ['webhooks', '/admin/settings?tab=webhooks'],
  ['incidents', '/admin/activity?tab=attention'],
  ['audit', '/admin/activity?tab=all'],
  ['automate/products', '/admin/requests?tab=catalog'],
  ['automate/workflows', '/admin/requests?tab=workflows'],
  ['automate/requests', '/admin/requests?tab=queue'],
  ['automate/sweeps', '/admin/requests?tab=sweeps'],
  ['automate/tasks', '/admin/requests?tab=tasks'],
  ['govern/findings', '/admin/govern?tab=findings'],
  ['govern/snapshots', '/admin/govern?tab=snapshots'],
  ['govern/reports', '/admin/govern?tab=reports'],
  ['govern/campaigns', '/admin/govern?tab=reviews'],
  ['govern/sod', '/admin/govern?tab=sod'],
  ['govern/orphans', '/admin/govern?tab=orphans'],
  ['govern/integrity', '/admin/govern?tab=integrity'],
];

describe('the paths that became tabs', () => {
  it.each(RETIRED)('sends /admin/%s to %s', (path, target) => {
    expect(source).toContain(
      `<Route path="${path}" element={<Navigate to="${target}" replace />} />`,
    );
  });

  it('redirects with replace, so Back does not bounce', () => {
    // Without `replace` the redirect leaves an entry in history, and pressing
    // Back returns to the old URL, which redirects forward again. The reader
    // is then trapped on the page they were trying to leave.
    const redirects = source.match(/<Route path="[^"]*" element=\{<Navigate[^}]*\}/g) ?? [];
    expect(redirects.length).toBeGreaterThan(0);
    for (const redirect of redirects) expect(redirect).toContain('replace');
  });
});

describe('the detail pages under a merged list', () => {
  // A list becoming a tab must not take its detail pages with it. Each of
  // these is reached FROM a tab and has to stay a page of its own.
  const KEPT = [
    'people/:id',
    'people/new',
    'people/:id/access',
    'sync-runs/:id',
    'automate/products/:id',
    'automate/requests/:id',
    'automate/sweeps/:id',
    'govern/snapshots/:id',
    'govern/campaigns/new',
    'govern/campaigns/:id',
    'govern/batches/:id',
  ];

  it.each(KEPT)('keeps /admin/%s as a page', (path) => {
    expect(source).toMatch(new RegExp(`<Route path="${path.replace(/[:/]/g, '$&')}" element={<[A-Z]`));
  });
});
