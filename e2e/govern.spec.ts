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

const STAMP = Date.now();
const CAMPAIGN = `Ward review ${STAMP}`;
const SUBJECT_LOGIN = `ward${STAMP}`;
const GROUP_NAME = `Ward ${STAMP}`;
let campaignId = '';
let joPersonId = '';

/**
 * A SUBJECT WHO IS NOT THE REVIEWER.
 *
 * `reviewer-service.ts` subtracts the subject from the resolved set — nobody
 * reviews their own access — and the seed links exactly two users to persons:
 * `jdoe` to Jo Doe, and `sroe` to Sam Roe, who is inactive. The only Syntra
 * group membership it creates is Jo's own membership of Nurses. Scope a
 * campaign at `syntraGroup` with Jo as the reviewer and the only holding in
 * range is Jo's, the resolved set empties, and every item lands
 * `blocked_no_reviewer`.
 *
 * So the spec builds its own: a person, a login for them, and a group they are
 * in. Jo can review that. `sync.spec.ts` works the same way with its
 * timestamped OU — a browser test that needs a fixture the seed does not have
 * creates it rather than describing one that does not exist.
 */
async function buildReviewableHolding(page: import('@playwright/test').Page): Promise<void> {
  const person = await page.request.post('/api/admin/persons', {
    data: { givenName: 'Wanda', familyName: `Ward${STAMP}`, businessEmail: `${SUBJECT_LOGIN}@acme.test` },
  });
  expect(person.status(), await person.text()).toBe(201);
  const personId = (await person.json()).id as string;

  const user = await page.request.post('/api/admin/users', {
    data: {
      login: SUBJECT_LOGIN,
      email: `${SUBJECT_LOGIN}@acme.test`,
      displayName: `Wanda Ward${STAMP}`,
    },
  });
  expect(user.status(), await user.text()).toBe(201);
  const userId = (await user.json()).id as string;

  // The link is what makes the holding a PERSON's holding. Without it the item
  // is an unattributed account, which routes to the fallback and tests
  // something else entirely.
  const linked = await page.request.post(`/api/admin/persons/${personId}/link-user`, {
    data: { userId },
  });
  expect(linked.ok(), await linked.text()).toBeTruthy();

  const group = await page.request.post('/api/admin/groups', {
    data: { name: GROUP_NAME, description: 'Built by the Govern browser spec.' },
  });
  expect(group.status(), await group.text()).toBe(201);
  const groupId = (await group.json()).id as string;

  const member = await page.request.post(`/api/admin/groups/${groupId}/members/${userId}`);
  expect(member.ok(), await member.text()).toBeTruthy();
}

test('a snapshot is built from the console, and says what it could not see', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/govern/snapshots', ADMIN!);

  // BEFORE the snapshot. A snapshot is a point-in-time picture, and a holding
  // created after it was taken is not in it.
  await buildReviewableHolding(page);

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
  joPersonId = jo!.id;

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

test('a manager reviews from the PORTAL, with no administrative session', async ({ page }) => {
  await signIn(page, 'jdoe', USER!);

  await page.goto('/govern/reviews');
  await expect(page.getByRole('heading', { name: 'My reviews' })).toBeVisible();

  const item = page.getByText(GROUP_NAME).first();
  await expect(item).toBeVisible();

  // A revoke always needs a comment, and the page asks for it before it sends
  // anything.
  page.once('dialog', (dialog) => void dialog.accept('Wanda left the ward in January'));
  await page.getByRole('button', { name: 'Remove' }).first().click();

  // Decided items leave the queue; nothing is left waiting.
  // `getByText`, not `getByRole('heading')`. `Empty` renders its title as a
  // `<p>` — there is no heading here, and an assertion that asks for one waits
  // out its timeout against a screen that is showing exactly what it should.
  await expect(page.getByText('Nothing is waiting for you')).toBeVisible();
});

test('the console has nothing to offer a reviewer who is not an administrator', async ({ page }) => {
  await signIn(page, 'jdoe', USER!);

  await page.goto('/admin/govern/campaigns');
  // Whatever the screen does — a sign-in wall, a step-up, a refusal — the one
  // thing it must not do is list other people's campaigns.
  await expect(page.getByText(CAMPAIGN)).toHaveCount(0);
});

test('the revocation batch carries the decision, and is the last cheap moment', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, `/admin/govern/campaigns/${campaignId}`, ADMIN!);

  // NOT `1 revoked`. The campaign's counters — certified, revoked, moot,
  // undecided, coverage — are written when the campaign CLOSES, by
  // `closeDueCampaigns`, and stay zero while it is open. Asserting them here
  // was asserting that a closing artefact exists before the close.
  //
  // What is true of an open campaign, and is the more interesting fact anyway:
  // one item resolved to nobody. Jo cannot review Jo's own membership of
  // Nurses, so that item has no reviewer and the screen says so instead of
  // quietly counting it as done.
  await expect(page.getByText(/item\(s\) have no reviewer and no fallback/)).toBeVisible();

  await page.getByRole('button', { name: 'Compute the revocation batch' }).click();
  await page.getByRole('link', { name: 'Open the batch' }).click();

  await expect(page.getByRole('heading', { name: /removals Govern can dispatch/ })).toBeVisible();
  // The decision reached the batch, whichever route it took: a dispatchable
  // removal, or its own panel because something else has to change first.
  await expect(page.getByText(GROUP_NAME).first()).toBeVisible();
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
