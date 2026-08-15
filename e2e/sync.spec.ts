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
 * Direct SQL because there is no delete endpoint for a directory source, and
 * there is deliberately not going to be one in this slice. It connects as
 * `syntra_app` like the application does -- never as a superuser -- so it
 * binds the tenant first and row-level security applies to every statement
 * exactly as it would in a request.
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

    const sources = await client.query<{ id: string }>(
      'DELETE FROM "DirectorySource" WHERE name = $1 RETURNING id',
      [SOURCE_NAME],
    );
    // AttributeMapping, SyncRun and SyncChange all cascade from the source.
    // The bind password does not: it lives in the vault under a name derived
    // from the source id.
    for (const source of sources.rows) {
      await client.query('DELETE FROM "Secret" WHERE name = $1', [
        `source.${source.id}.bindPassword`,
      ]);
    }

    const logins = [NURSE_UID, CLERK_UID];
    await client.query(
      'DELETE FROM "GroupMembership" WHERE "userId" IN (SELECT id FROM "User" WHERE login = ANY($1))',
      [logins],
    );
    await client.query('DELETE FROM "User" WHERE login = ANY($1)', [logins]);
    await client.query('DELETE FROM "Group" WHERE name = $1', [GROUP_CN]);
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

test('a directory source is connected, previewed, applied, and its users land in the directory', async ({
  page,
}) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/sources', ADMIN!);
  await expect(
    page.getByRole('heading', { name: 'Directory sources' }),
  ).toBeVisible();

  // SourcesPage is a read-only list -- there is no form yet to create,
  // test, or run a source from the console, so this drives the same API
  // those controls would call, over the browser's own session cookie
  // (page.request shares cookie storage with the page's browser context).
  // See task-15-report.md for why this wasn't built as a new UI form.
  const created = await page.request.post('/api/admin/sources', {
    data: {
      name: SOURCE_NAME,
      config: {
        url: LDAP_URL,
        bindDn: BIND_DN,
        userSearchBase: OU_DN,
        groupSearchBase: OU_DN,
        userFilter: '(objectClass=inetOrgPerson)',
        groupFilter: '(objectClass=groupOfNames)',
        anchorAttribute: 'entryUUID',
      },
      bindPassword: BIND_PASSWORD,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const source = await created.json();

  const mapped = await page.request.put(
    `/api/admin/sources/${source.id}/mappings`,
    {
      data: {
        rules: [
          {
            objectType: 'user',
            sourceAttribute: 'uid',
            targetField: 'login',
            transform: 'lowercase',
            isCorrelation: true,
          },
          {
            objectType: 'user',
            sourceAttribute: 'mail',
            targetField: 'email',
            transform: 'lowercase',
            isCorrelation: false,
          },
          {
            objectType: 'user',
            sourceAttribute: 'cn',
            targetField: 'displayName',
            transform: 'trim',
            isCorrelation: false,
          },
          {
            objectType: 'group',
            sourceAttribute: 'cn',
            targetField: 'name',
            transform: 'trim',
            isCorrelation: true,
          },
        ],
      },
    },
  );
  expect(mapped.ok(), await mapped.text()).toBe(true);

  // The new source shows up in the list the console does have.
  await page.reload();
  await expect(page.getByRole('table')).toContainText(SOURCE_NAME);

  // Test the connection and see the counts.
  const tested = await page.request.post(
    `/api/admin/sources/${source.id}/test`,
  );
  expect(tested.ok(), await tested.text()).toBe(true);
  const testResult = await tested.json();
  expect(testResult.ok).toBe(true);
  expect(testResult.sampleCounts).toMatchObject({ user: 2, group: 1 });

  // Run a preview.
  const run = await page.request.post(`/api/admin/sources/${source.id}/run`);
  expect(run.ok(), await run.text()).toBe(true);
  const runBody = await run.json();
  expect(runBody.status).toBe('previewed');
  // Everything the source returned was understood: a run with mapping
  // failures is not a clean run, whatever recordsRead says.
  expect(runBody.mappingFailures).toBe(0);

  // See the proposed creates grouped by type, on the review page the
  // console actually renders.
  await page.goto(`/admin/sync-runs/${runBody.id}`);
  await expect(page.getByRole('heading', { name: 'Sync run' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Create user (2)' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Create group (1)' }),
  ).toBeVisible();
  // Panels are grouped and ordered by changeType, so "Add group member"
  // sorts before "Create user" -- scope to the create-user panel by its
  // heading rather than assuming table order.
  const createUserPanel = page.locator('section', {
    has: page.getByRole('heading', { name: 'Create user (2)' }),
  });
  await expect(createUserPanel.getByRole('table')).toContainText(NURSE_UID);

  // Apply.
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();

  // Find the LDAP users listed under Users.
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  const users = page.getByRole('table');
  await expect(users).toContainText(NURSE_UID);
  await expect(users).toContainText('E2E Nurse');
  await expect(users).toContainText(CLERK_UID);
  await expect(users).toContainText('E2E Clerk');
});
