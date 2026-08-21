import { expect, test, type Page } from '@playwright/test';
import { Client } from 'ldapts';
import { Client as PgClient } from 'pg';

const ADMIN = process.env.SEED_ADMIN_PASSWORD;

test.beforeAll(() => {
  if (!ADMIN) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be set to the value the database was seeded with',
    );
  }
});

async function signIn(page: Page, login: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in and waits for the portal, so a following navigation cannot race. */
async function signInAndLand(page: Page, login: string, password: string) {
  await signIn(page, login, password);
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
}

/** Re-authenticates into an administrative session on the way to `path`. */
async function elevateTo(page: Page, path: string, password: string) {
  await page.goto(path);
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeVisible();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  // WAITED FOR. Clicking Continue starts the elevation; it does not finish it.
  // A UI action after this auto-waits and hides the gap — an API call through
  // `page.request` does not, and goes out against whatever cookie exists at
  // that instant.
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeHidden();
}

// The fixture directory (infra/ldap/seed.ldif) deliberately mirrors the app
// seed -- jdoe, sroe, Care, Learning, Nurses all already exist locally, so a
// run against the shared base produces conflicts, not creates (see
// correlate.ts: a correlation-value match against a locally managed row is a
// conflict, never a silent adopt). A joiner scoped to its own OU sidesteps
// that entirely and keeps this test about the sync pipeline, not about
// reconciling identity with the app seed. Added before the suite and removed
// after, the same pattern packages/core/src/sync/test-support.ts uses for the
// backend LDAP integration tests.
//
// Every identifier carries a per-run stamp, as e2e/access.spec.ts does, so
// this suite can run twice without an intervening `pnpm db:reset`. Without
// it, DirectorySource's unique (tenantId, name) rejected the second run and
// the constraint error masked whatever the test was actually there to catch.
// The stamp is what makes the suite repeatable; the cleanup below is what
// keeps the database from accumulating a run's worth of rows every time.
const STAMP = Date.now();
const LDAP_URL = process.env.LDAP_URL ?? 'ldap://localhost:1389';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://syntra_app:syntra_app@localhost:5432/syntra';
const BIND_DN = 'cn=admin,dc=acme,dc=test';
const BIND_PASSWORD = 'adminpassword';
const OU_DN = `ou=E2ESync${STAMP},dc=acme,dc=test`;
const NURSE_UID = `e2enurse${STAMP}`;
const CLERK_UID = `e2eclerk${STAMP}`;
const GROUP_CN = `E2E Team ${STAMP}`;
const NURSE_DN = `uid=${NURSE_UID},${OU_DN}`;
const CLERK_DN = `uid=${CLERK_UID},${OU_DN}`;
const GROUP_DN = `cn=${GROUP_CN},${OU_DN}`;
const SOURCE_NAME = `E2E OpenLDAP ${STAMP}`;

async function ldapClient(): Promise<Client> {
  const client = new Client({ url: LDAP_URL });
  await client.bind(BIND_DN, BIND_PASSWORD);
  return client;
}

/**
 * The DNs actually added, deepest last. Recorded as they are created rather
 * than assumed, so a setup that fails halfway removes exactly what it made.
 */
const added: string[] = [];

async function removeLdapFixture(): Promise<void> {
  const client = await ldapClient();
  try {
    // Deepest entries first: an OU cannot be deleted while it still has
    // children, and a stray failure here must not stop the rest from being
    // attempted, or the fixture is left dirty for the next run.
    for (const dn of [...added].reverse()) {
      await client.del(dn).catch(() => undefined);
    }
    added.length = 0;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/**
 * Removes the rows this suite's run created.
 *
 * Direct SQL rather than `DELETE /sources/:id`, even though that endpoint now
 * exists: the endpoint deactivates and detaches the accounts a source owned
 * rather than removing them, which is right for an administrator and wrong
 * for a fixture that has to leave the database as it found it. It connects as
 * `syntra_app` like the application does -- never as a superuser -- so it
 * binds the tenant first and row-level security applies to every statement
 * exactly as it would in a request.
 *
 * Order matters. `User`, `Group` and `OrgUnit` reference `DirectorySource`
 * with ON DELETE RESTRICT, so the rows this source owns have to be gone
 * before the source can be, and anything else still pointing at it has to be
 * detached first.
 *
 * `AuditEvent` is untouched on purpose: the log is append-only, and a test
 * that deleted from it would be rehearsing the attack the hash chain exists
 * to detect.
 */
async function removeDatabaseFixture(): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      'SELECT id FROM "Tenant" WHERE slug = $1',
      ['acme'],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) return;

    await client.query("SELECT set_config('app.current_tenant', $1, false)", [
      tenantId,
    ]);

    const logins = [NURSE_UID, CLERK_UID];
    await client.query(
      'DELETE FROM "GroupMembership" WHERE "userId" IN (SELECT id FROM "User" WHERE login = ANY($1))',
      [logins],
    );
    await client.query('DELETE FROM "User" WHERE login = ANY($1)', [logins]);
    await client.query('DELETE FROM "Group" WHERE name = $1', [GROUP_CN]);

    const sources = await client.query<{ id: string }>(
      'SELECT id FROM "DirectorySource" WHERE name = $1',
      [SOURCE_NAME],
    );

    for (const source of sources.rows) {
      // Anything the run created and this fixture does not name by hand -- an
      // organizational unit, an account a previous run left behind. Detached
      // rather than deleted, since deleting an org unit would take scoped role
      // assignments with it.
      for (const table of ['User', 'Group', 'OrgUnit']) {
        await client.query(
          `UPDATE "${table}" SET "sourceId" = NULL, "sourceAnchor" = NULL WHERE "sourceId" = $1`,
          [source.id],
        );
      }
      // AttributeMapping, SyncRun and SyncChange all cascade from the source.
      // The bind password does not: it lives in the vault under a name derived
      // from the source id.
      await client.query('DELETE FROM "DirectorySource" WHERE id = $1', [
        source.id,
      ]);
      await client.query('DELETE FROM "Secret" WHERE name = $1', [
        `source.${source.id}.bindPassword`,
      ]);
    }
  } finally {
    await client.end();
  }
}

test.beforeAll(async () => {
  const client = await ldapClient();
  try {
    const add = async (
      dn: string,
      attributes: Record<string, string | string[]>,
    ) => {
      await client.add(dn, attributes);
      added.push(dn);
    };

    // Cleaned up here as well as in afterAll: a beforeAll that throws halfway
    // must not leave a half-seeded tree behind, whatever the runner does with
    // afterAll hooks once a setup hook has failed.
    try {
      await add(OU_DN, {
        objectClass: ['organizationalUnit'],
        ou: `E2ESync${STAMP}`,
      });
      await add(NURSE_DN, {
        objectClass: ['inetOrgPerson'],
        uid: NURSE_UID,
        cn: 'E2E Nurse',
        sn: 'Nurse',
        mail: `${NURSE_UID}@acme.test`,
      });
      await add(CLERK_DN, {
        objectClass: ['inetOrgPerson'],
        uid: CLERK_UID,
        cn: 'E2E Clerk',
        sn: 'Clerk',
        mail: `${CLERK_UID}@acme.test`,
      });
      await add(GROUP_DN, {
        objectClass: ['groupOfNames'],
        cn: GROUP_CN,
        member: [NURSE_DN],
      });
    } catch (cause) {
      await client.unbind().catch(() => undefined);
      await removeLdapFixture();
      throw cause;
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
});

test.afterAll(async () => {
  await removeLdapFixture();
  await removeDatabaseFixture();
});

// The second test reads the source the first one created, so a failure in the
// first should skip the second rather than report a second, derived failure.
test.describe.configure({ mode: 'serial' });

/**
 * The whole path, through the console, with no API call standing in for a
 * control that does not exist.
 *
 * This test used to drive four of these steps over HTTP -- create, map, test,
 * run -- because the console had no form for any of them. That is the gap this
 * suite exists to prove closed, so anything it reaches for here has to be a
 * real control on a real page.
 */
test('a directory source is created, tested, mapped, run, partly applied and skipped, entirely from the console', async ({
  page,
}) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/sources', ADMIN!);
  await expect(
    page.getByRole('heading', { name: 'Directory sources' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'New source' }).click();
  await expect(
    page.getByRole('heading', { name: 'New directory source' }),
  ).toBeVisible();

  // One click seeds the attribute mappings, the anchor attribute and the
  // per-flavour filters, which is what "the common case needs no typing"
  // means: everything below this line is the part that is genuinely specific
  // to this directory.
  await page.getByRole('button', { name: 'OpenLDAP' }).click();
  await expect(page.getByLabel('Anchor attribute')).toHaveValue('entryUUID');

  await page.getByLabel('Name').fill(SOURCE_NAME);
  await page.getByLabel('Server URL').fill(LDAP_URL);
  await page.getByLabel('Transport').selectOption('plain');
  await page.getByLabel('Bind DN').fill(BIND_DN);
  await page.getByLabel('Bind password').fill(BIND_PASSWORD);
  await page.getByLabel('User search base').fill(OU_DN);
  await page.getByLabel('Group search base').fill(OU_DN);

  // Tested before anything is saved, and reporting what it found: the counts
  // and the object classes and attributes the directory returned. Spec
  // success criterion 1, which was unreachable from the console until now.
  await page.getByRole('button', { name: 'Test connection' }).click();
  const report = page.locator('section', {
    has: page.getByRole('heading', { name: 'Connection test' }),
  });
  await expect(report).toBeVisible();
  await expect(report).toContainText('Found 2 users, 1 groups');
  await expect(report).toContainText('inetOrgPerson');
  // The anchor attribute among them. It is operational on OpenLDAP and is not
  // returned by an ordinary search, so a report that lists uid and mail but
  // not this one omits the field the administrator came here to fill in.
  await expect(report).toContainText('entryUUID');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/attribute mappings were saved/i)).toBeVisible();
  // The editor moved to the saved source rather than staying on /new.
  await expect(page).toHaveURL(/\/admin\/sources\/[0-9a-f-]{36}$/);
  // Saved and read back, not merely echoed: this is a fresh GET of the source.
  await expect(page.getByLabel('Server URL')).toHaveValue(LDAP_URL);
  await expect(page.getByLabel('Users directory attribute 1')).toHaveValue('uid');

  // Run it by hand. The console lands on the run it started.
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('heading', { name: 'Sync run' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/sync-runs\/[0-9a-f-]{36}$/);

  await expect(
    page.getByRole('heading', { name: 'Create user (2)' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Create group (1)' }),
  ).toBeVisible();

  // Everything the source returned was understood. A run with mapping
  // failures is not a clean run whatever recordsRead says, and the review
  // screen is the only place those records are visible at all -- so their
  // absence is what says nothing was silently dropped.
  await expect(page.getByText(/could not be mapped/i)).toHaveCount(0);
  await expect(page.getByText(/could not be resolved/i)).toHaveCount(0);

  // Skip one proposed change outright. It is recorded as skipped on the run
  // and never applied.
  const clerkRow = page.getByRole('row').filter({ hasText: CLERK_UID });
  await clerkRow.getByRole('button', { name: 'Skip' }).click();
  await expect(clerkRow).toContainText('Skipped');
  await expect(clerkRow.getByRole('button', { name: 'Skip' })).toHaveCount(0);

  // Apply part of the run: everything except the group and its membership.
  // Spec success criterion 4, which had server support and no control.
  await page
    .getByRole('checkbox', { name: 'Apply this create group change' })
    .uncheck();
  await page
    .getByRole('checkbox', { name: 'Apply this add group member change' })
    .uncheck();
  await expect(page.getByText('1 of 3 changes selected')).toBeVisible();

  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();

  // The nurse landed; the clerk was skipped and did not; the group was left
  // out of this apply and did not.
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  const users = page.getByRole('table');
  await expect(users).toContainText(NURSE_UID);
  await expect(users).toContainText('E2E Nurse');
  await expect(users).not.toContainText(CLERK_UID);

  // A synced account names the directory that owns it and says it is
  // read-only, wherever it appears.
  const nurseRow = page.getByRole('row').filter({ hasText: NURSE_UID });
  await expect(nurseRow).toContainText(SOURCE_NAME);
  await expect(nurseRow).toContainText('read-only');

  await page.goto('/admin/groups');
  await expect(page.getByRole('heading', { name: 'Groups' })).toBeVisible();
  await expect(page.getByText(GROUP_CN)).toHaveCount(0);

  // What was left out is still proposed, so the rest of the run can be
  // applied afterwards. A partial apply is a pause, not a discard.
  await page.goBack();
  await page.goBack();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sync run' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByRole('checkbox', { name: /apply this/i }),
  ).toHaveCount(0);

  await page.goto('/admin/groups');
  await expect(page.getByText(GROUP_CN)).toBeVisible();
});

/**
 * The editor's destructive path, which is the one worth a browser test: the
 * counts have to be on the page before the button does anything.
 */
test('deleting a source states what it will deactivate before it will do it', async ({
  page,
}) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/sources', ADMIN!);

  await page.getByRole('link', { name: SOURCE_NAME }).click();
  await expect(page.getByRole('heading', { name: SOURCE_NAME })).toBeVisible();

  const panel = page.locator('section', {
    has: page.getByRole('heading', { name: 'Delete this source' }),
  });
  // The previous test applied one user and one group from this source.
  await expect(panel).toContainText('1 user');
  await expect(panel).toContainText('1 group');
  await expect(panel).toContainText(/deactivates every one of those/i);

  const remove = panel.getByRole('button', { name: 'Delete source' });
  await expect(remove).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await expect(remove).toBeEnabled();

  // Driven to completion, because the half of this that matters is what the
  // button actually does. The source goes; the accounts it owned stay, and
  // are deactivated with a reason naming it.
  await remove.click();
  await expect(page).toHaveURL(/\/admin\/sources$/);
  await expect(page.getByText(SOURCE_NAME)).toHaveCount(0);

  await page.goto('/admin/users');
  const nurse = page.getByRole('row').filter({ hasText: NURSE_UID });
  await expect(nurse).toContainText('Inactive');
  await expect(nurse).toContainText(SOURCE_NAME);
  // Detached, so the row no longer claims a source that no longer exists.
  await expect(nurse).toContainText('Syntra');
});
