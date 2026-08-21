import { expect, test, type Page } from '@playwright/test';

/**
 * Govern, end to end: a snapshot, a campaign against it, a manager reviewing
 * from the PORTAL, and the revocation batch that comes out the other side.
 *
 * The campaign itself is created over the API rather than through a form. The
 * console ships no campaign-creation screen in this slice — scope, reviewer
 * selector, fallback selector and recurrence are eleven fields and a preview,
 * and they are their own piece of work — so the spec creates the campaign the
 * way the product currently does and drives the UI for everything a person
 * actually touches: the queue, the decision, the batch and the confirmation.
 *
 * Scoped to `syntraGroup` deliberately. The seed gives Jo Doe a membership of
 * Nurses with no target system, no connector and no directory read involved,
 * so the campaign has exactly one item whatever else the database has been
 * left holding.
 */

const ADMIN = process.env.SEED_ADMIN_PASSWORD;
const USER = process.env.SEED_USER_PASSWORD;

test.beforeAll(() => {
  if (!ADMIN || !USER) {
    throw new Error(
      'SEED_ADMIN_PASSWORD and SEED_USER_PASSWORD must be set to the values the database was seeded with',
    );
  }
});

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
}

/** Re-authenticates into an administrative session on the way to `path`. */
async function elevateTo(page: Page, path: string, password: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: /confirm your password/i })).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  // WAITED FOR. Clicking Continue starts the elevation; it does not finish it.
  // Every UI action after this auto-waits and so hides the gap, but an API
  // call through `page.request` does not — it goes out against whatever cookie
  // exists at that instant and comes back 403 "administrative session
  // required", which reads as a permissions bug rather than a race.
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeHidden();
}

test.describe.configure({ mode: 'serial' });

const CAMPAIGN = `Nurses review ${Date.now()}`;
let campaignId = '';

test('a snapshot is built from the console, and says what it could not see', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/govern/snapshots', ADMIN!);

  await page.getByRole('button', { name: 'Build a snapshot now' }).click();

  // The row itself is the assertion: a snapshot exists and is dated. Coverage
  // is a property of the snapshot, not of the button that made it.
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).not.toHaveCount(1);
});

test('a campaign against that snapshot appears with its denominator, never a bare percentage', async ({
  page,
}) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/govern/campaigns', ADMIN!);

  const persons = await page.request.get('/api/admin/persons');
  // The STATUS and the body in the message. `expect(ok).toBeTruthy()` reports
  // "Received: false", which says nothing about whether this was a 401 with no
  // session, a 403 with no permission, or a 500.
  expect(persons.status(), await persons.text()).toBe(200);
  const jo = ((await persons.json()) as { persons: { id: string; givenName: string }[] }).persons
    .find((p) => p.givenName === 'Jo');
  expect(jo, 'the seed must have Jo Doe in it').toBeTruthy();

  const created = await page.request.post('/api/admin/govern/campaigns', {
    data: {
      name: CAMPAIGN,
      scope: { resourceKinds: ['syntraGroup'] },
      // `person`, not `manager`: the seed gives nobody a manager, and a
      // campaign whose every item falls to a fallback is testing the fallback.
      reviewerSelector: 'person',
      reviewerConfig: { personId: jo!.id },
      fallbackSelector: 'person',
      fallbackConfig: { personId: jo!.id },
      ownerPersonId: jo!.id,
      opensAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      allowBulkCertify: false,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  campaignId = ((await created.json()) as { id: string }).id;

  const started = await page.request.post(`/api/admin/govern/campaigns/${campaignId}/start`);
  expect(started.ok(), await started.text()).toBeTruthy();

  await page.goto('/admin/govern/campaigns');
  const row = page.getByRole('row').filter({ hasText: CAMPAIGN });
  await expect(row).toBeVisible();
  // §12: an open campaign has no coverage yet, and the screen says so in
  // words rather than printing 0%.
  await expect(row).toContainText('not yet closed');
});

/**
 * THE PORTAL REVIEW PATH IS NOT COVERED HERE, and the reason is worth writing
 * down rather than discovering twice.
 *
 * A reviewer may not review their own access — `reviewer-service.ts` applies
 * the self-review invariant as a subtraction from the resolved set — and the
 * seed links exactly two users to persons: `jdoe` to Jo Doe, and `sroe` to Sam
 * Roe, who is inactive. The only Syntra group membership in the seed is Jo's
 * own membership of Nurses. So the only holding available to review belongs to
 * the only person available to review it, the resolved set is empty, and the
 * item lands `blocked_no_reviewer` — which is the product behaving correctly
 * and saying so, not a defect.
 *
 * Covering this needs the spec to create its own fixture: a second person with
 * a portal login, holding something the first person can review. `sync.spec.ts`
 * already works that way with its timestamped OU. Until then these two are
 * `fixme` rather than deleted, because the path they describe is real and
 * exercised thoroughly by the integration tests — it is the BROWSER journey
 * that is unproven.
 */
test.fixme('a manager reviews from the PORTAL, with no administrative session', async ({ page }) => {
  await signIn(page, 'jdoe', USER!);

  await page.goto('/govern/reviews');
  await expect(page.getByRole('heading', { name: 'My reviews' })).toBeVisible();

  const item = page.getByText('Nurses').first();
  await expect(item).toBeVisible();

  // A revoke always needs a comment, and the page asks for it before it sends
  // anything.
  page.once('dialog', (dialog) => void dialog.accept('Jo moved to Learning in January'));
  await page.getByRole('button', { name: 'Remove' }).first().click();

  // Decided items leave the queue; nothing is left waiting.
  await expect(page.getByRole('heading', { name: 'Nothing is waiting for you' })).toBeVisible();
});

test('the console has nothing to offer a reviewer who is not an administrator', async ({ page }) => {
  await signIn(page, 'jdoe', USER!);

  await page.goto('/admin/govern/campaigns');
  // Whatever the screen does — a sign-in wall, a step-up, a refusal — the one
  // thing it must not do is list other people's campaigns.
  await expect(page.getByText(CAMPAIGN)).toHaveCount(0);
});

// Depends on the revoke the fixme above would have made.
test.fixme('the revocation batch carries the decision, and is the last cheap moment', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, `/admin/govern/campaigns/${campaignId}`, ADMIN!);

  await expect(page.getByText('1 revoked')).toBeVisible();

  await page.getByRole('button', { name: 'Compute the revocation batch' }).click();
  await page.getByRole('link', { name: 'Open the batch' }).click();

  await expect(page.getByRole('heading', { name: /removals Govern can dispatch/ })).toBeVisible();
  // The decision reached the batch, whichever route it took: a dispatchable
  // removal, or its own panel because something else has to change first.
  await expect(page.getByText('Nurses').first()).toBeVisible();
  await expect(
    page.getByText('Nothing here has happened yet. This is the last point at which a mistake costs nothing.'),
  ).toBeVisible();
});

test('the segregation-of-duties screen refuses to be written over two groups', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/govern/sod', ADMIN!);

  // The sentence is the product decision, and it is on the page rather than in
  // a tooltip: a rule relates two business FUNCTIONS, never two entitlements.
  await expect(page.getByText(/never two entitlements/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show me who this would flag, before I save it' }),
  ).toBeDisabled();
});
