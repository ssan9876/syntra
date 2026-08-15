import { expect, test, type Page } from '@playwright/test';
import { Client } from 'ldapts';

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
const LDAP_URL = process.env.LDAP_URL ?? 'ldap://localhost:1389';
const BIND_DN = 'cn=admin,dc=acme,dc=test';
const BIND_PASSWORD = 'adminpassword';
const OU_DN = 'ou=E2ESync,dc=acme,dc=test';
const NURSE_DN = `uid=e2enurse,${OU_DN}`;
const CLERK_DN = `uid=e2eclerk,${OU_DN}`;
const GROUP_DN = `cn=E2E Team,${OU_DN}`;

async function ldapClient(): Promise<Client> {
  const client = new Client({ url: LDAP_URL });
  await client.bind(BIND_DN, BIND_PASSWORD);
  return client;
}

test.beforeAll(async () => {
  const client = await ldapClient();
  try {
    await client.add(OU_DN, {
      objectClass: ['organizationalUnit'],
      ou: 'E2ESync',
    });
    await client.add(NURSE_DN, {
      objectClass: ['inetOrgPerson'],
      uid: 'e2enurse',
      cn: 'E2E Nurse',
      sn: 'Nurse',
      mail: 'e2enurse@acme.test',
    });
    await client.add(CLERK_DN, {
      objectClass: ['inetOrgPerson'],
      uid: 'e2eclerk',
      cn: 'E2E Clerk',
      sn: 'Clerk',
      mail: 'e2eclerk@acme.test',
    });
    await client.add(GROUP_DN, {
      objectClass: ['groupOfNames'],
      cn: 'E2E Team',
      member: [NURSE_DN],
    });
  } finally {
    await client.unbind().catch(() => undefined);
  }
});

test.afterAll(async () => {
  const client = await ldapClient();
  try {
    // Deepest entries first: an OU cannot be deleted while it still has
    // children, and a stray failure here must not stop the rest from being
    // attempted, or the fixture is left dirty for the next run.
    await client.del(GROUP_DN).catch(() => undefined);
    await client.del(NURSE_DN).catch(() => undefined);
    await client.del(CLERK_DN).catch(() => undefined);
    await client.del(OU_DN).catch(() => undefined);
  } finally {
    await client.unbind().catch(() => undefined);
  }
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
      name: 'E2E OpenLDAP',
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
  await expect(page.getByRole('table')).toContainText('E2E OpenLDAP');

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
  await expect(createUserPanel.getByRole('table')).toContainText('e2enurse');

  // Apply.
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();

  // Find the LDAP users listed under Users.
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  const users = page.getByRole('table');
  await expect(users).toContainText('e2enurse');
  await expect(users).toContainText('E2E Nurse');
  await expect(users).toContainText('e2eclerk');
  await expect(users).toContainText('E2E Clerk');
});
