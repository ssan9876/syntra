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

/**
 * Every identifier carries a per-run stamp, as `sync.spec.ts` does, so this
 * suite can run twice without an intervening `pnpm db:reset`: `TargetSystem`
 * has a unique `(tenantId, name)` and the second run would otherwise fail on
 * the constraint rather than on anything it was testing.
 */
// Base 36, not the raw milliseconds: `sAMAccountName` is capped at 20
// characters (`SAM_ACCOUNT_NAME_MAX_LENGTH`), and a 13-digit stamp pushes
// `anna.novak<stamp>` to 23 and gets it truncated — so the assertion below
// would be checking a name the generator never produces.
const STAMP = Date.now().toString(36);
const SAMBA_URL = process.env.SAMBA_LDAPS_URL ?? 'ldaps://localhost:1637';
const BASE_DN = process.env.SAMBA_BASE_DN ?? 'DC=syntra,DC=test';
const BIND_DN =
  process.env.SAMBA_BIND_DN ?? 'CN=Administrator,CN=Users,DC=syntra,DC=test';
const BIND_PASSWORD = process.env.SAMBA_BIND_PASSWORD ?? 'Syntra!Passw0rd';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://syntra_app:syntra_app@localhost:5432/syntra';

const OU_DN = `OU=E2EProv${STAMP},${BASE_DN}`;
const GROUPS_DN = `OU=E2EProvGroups${STAMP},${BASE_DN}`;
const ARCHIVE_DN = `OU=E2EProvArchive${STAMP},${BASE_DN}`;
const GROUP_CN = `E2EFinance${STAMP}`;
const GROUP_DN = `CN=${GROUP_CN},${GROUPS_DN}`;
const TARGET_NAME = `E2E Samba ${STAMP}`;
const DEPARTMENT = `E2EFin${STAMP}`;
const GIVEN_NAME = 'Anna';
const FAMILY_NAME = `Novak${STAMP}`;
const PERSON_NAME = `${GIVEN_NAME} ${FAMILY_NAME}`;
const ACCOUNT_NAME = `anna.novak${STAMP}`;
const RULE_NAME = `E2E Finance ${STAMP}`;

async function ldapClient(): Promise<Client> {
  // The container's certificate is self-signed, and it refuses a plain simple
  // bind outright, so both of these are deliberate rather than convenient.
  const client = new Client({
    url: SAMBA_URL,
    tlsOptions: { rejectUnauthorized: false },
    connectTimeout: 10_000,
  });
  await client.bind(BIND_DN, BIND_PASSWORD);
  return client;
}

/** The DNs actually added, so a setup that fails halfway removes what it made. */
const added: string[] = [];

async function removeLdapFixture(): Promise<void> {
  const client = await ldapClient();
  try {
    // Deepest first: a non-leaf delete is refused, and one failure must not
    // stop the rest from being attempted.
    for (const dn of [...added].reverse()) {
      await client.del(dn).catch(() => undefined);
    }
    // Whatever the run itself created under the test OU. Provision never
    // deletes, so the accounts it made are still there and the OU cannot go
    // until they do.
    const { searchEntries } = await client
      .search(OU_DN, { scope: 'sub', filter: '(objectClass=*)', attributes: ['dn'] })
      .catch(() => ({ searchEntries: [] as { dn: string }[] }));
    for (const entry of searchEntries
      .map((e) => e.dn)
      .sort((a, b) => b.length - a.length)) {
      await client.del(entry).catch(() => undefined);
    }
    added.length = 0;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/**
 * The rows this run created, removed as `sync.spec.ts` removes its own.
 *
 * Connected as `syntra_app`, never as a superuser, with the tenant bound
 * first, so row-level security applies exactly as it would in a request.
 *
 * A person and a contract are inserted here rather than added to the shared
 * seed: the seed is every developer's dev database and every other browser
 * test's fixture, and a person who exists only for one provisioning spec does
 * not belong in it. Stamped, so two runs do not collide.
 */
async function withDatabase<T>(
  work: (client: PgClient, tenantId: string) => Promise<T>,
): Promise<T | undefined> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      'SELECT id FROM "Tenant" WHERE slug = $1',
      ['acme'],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) return undefined;
    await client.query("SELECT set_config('app.current_tenant', $1, false)", [
      tenantId,
    ]);
    return await work(client, tenantId);
  } finally {
    await client.end();
  }
}

async function addPerson(): Promise<void> {
  await withDatabase(async (client, tenantId) => {
    const person = await client.query<{ id: string }>(
      'INSERT INTO "Person" ("id", "tenantId", "givenName", "familyName", "businessEmail", "updatedAt")' +
        " VALUES (gen_random_uuid(), $1, $2, $3, $4, now()) RETURNING id",
      [tenantId, GIVEN_NAME, FAMILY_NAME, `anna.novak${STAMP}@acme.localhost`],
    );
    await client.query(
      'INSERT INTO "Contract" ("id", "tenantId", "personId", "sequence", "isPrimary", "startDate", "jobTitle", "department")' +
        " VALUES (gen_random_uuid(), $1, $2, 1, true, DATE '2020-01-01', 'Analyst', $3)",
      [tenantId, person.rows[0]!.id, DEPARTMENT],
    );
  });
}

async function removeDatabaseFixture(): Promise<void> {
  await withDatabase(async (client) => {
    const targets = await client.query<{ id: string }>(
      'SELECT id FROM "TargetSystem" WHERE name LIKE $1',
      ['E2E Samba %'],
    );
    for (const target of targets.rows) {
      // DriftFinding names a target with no relation behind the column, so it
      // does not cascade with the target the way the runs, rules, catalog and
      // accounts do.
      await client.query('DELETE FROM "DriftFinding" WHERE "targetSystemId" = $1', [
        target.id,
      ]);
      await client.query('DELETE FROM "TargetSystem" WHERE id = $1', [target.id]);
      await client.query('DELETE FROM "Secret" WHERE name LIKE $1', [
        `target.${target.id}.%`,
      ]);
    }
    await client.query('DELETE FROM "Person" WHERE "familyName" LIKE $1', [
      'Novak%',
    ]);
  });
}

test.beforeAll(async () => {
  await removeDatabaseFixture();
  const client = await ldapClient();
  try {
    const add = async (dn: string, attributes: Record<string, string | string[]>) => {
      await client.add(dn, attributes);
      added.push(dn);
    };
    try {
      for (const [dn, ou] of [
        [OU_DN, `E2EProv${STAMP}`],
        [GROUPS_DN, `E2EProvGroups${STAMP}`],
        [ARCHIVE_DN, `E2EProvArchive${STAMP}`],
      ] as const) {
        await add(dn, { objectClass: ['top', 'organizationalUnit'], ou });
      }
      await add(GROUP_DN, {
        objectClass: ['top', 'group'],
        sAMAccountName: GROUP_CN,
      });
    } catch (cause) {
      await client.unbind().catch(() => undefined);
      await removeLdapFixture();
      throw cause;
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
  await addPerson();
});

test.afterAll(async () => {
  await removeLdapFixture();
  await removeDatabaseFixture();
});

/**
 * The whole path, through the console, with no API call standing in for a
 * control that does not exist.
 *
 * Everything this test reaches for is a real control on a real page: if a
 * screen were missing, the step would fail rather than be quietly replaced by
 * an HTTP request the product does not offer anybody.
 */
test('configure a target, write a rule, review a run, apply part of it', async ({
  page,
}) => {
  // A run is enqueued and performed by a background worker against a real
  // domain controller, so this is minutes rather than the 60s default.
  test.setTimeout(300_000);

  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/targets', ADMIN!);
  await expect(page.getByRole('heading', { name: 'Target systems' })).toBeVisible();

  // A fresh install has no targets, and the empty state says what a target is
  // rather than showing an empty table.
  await expect(page.getByText('No target systems yet')).toBeVisible();

  await page.getByRole('link', { name: 'New target' }).click();
  await expect(page.getByRole('heading', { name: 'New target' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(TARGET_NAME);
  await page.getByLabel('URL', { exact: true }).fill(SAMBA_URL);
  await page.getByLabel('Transport').selectOption('ldaps');
  await page.getByLabel(/Verify the directory server/).uncheck();
  await page.getByLabel('Bind DN').fill(BIND_DN);
  await page.getByLabel('Bind password').fill(BIND_PASSWORD);
  await page.getByLabel('Base DN').fill(OU_DN);
  await page.getByLabel('Entitlement search base').fill(GROUPS_DN);
  await page.getByLabel('Archive container').fill(ARCHIVE_DN);

  await page.getByRole('button', { name: 'Test connection' }).click();
  const report = page.locator('section', {
    has: page.getByRole('heading', { name: 'Connection test' }),
  });
  await expect(report).toBeVisible();
  await expect(report).toContainText('Connected');

  // Finding M20, and the reason this list exists. The bind can create users
  // in the base DN, so that right is `granted` — and the OU is empty, so
  // there is no account to read `modifyUser` from and the connector says so
  // rather than assuming. An `unverified` right renders as its own thing,
  // never as a quiet approval.
  await expect(report).toContainText('Create accounts');
  await expect(report.getByText('granted').first()).toBeVisible();
  await expect(report.getByText('Could not check').first()).toBeVisible();

  await page.getByRole('button', { name: 'Create target' }).click();
  await expect(page).toHaveURL(/\/admin\/targets\/[0-9a-f-]{36}$/);
  // Kept, because `goBack()` further down does not reliably land here — there
  // are several navigations in between — and the target's own page is the only
  // one carrying the links this test still needs.
  const targetUrl = page.url();

  // Additive by default, and visible on the target's own screen (Ruling P2).
  await expect(page.getByLabel('Enforcement mode')).toHaveValue('additive');

  await page.getByRole('link', { name: 'Account profile' }).click();
  await expect(page.getByRole('heading', { name: 'Account profile' })).toBeVisible();
  await page
    .getByLabel('Account name template')
    .fill('%person.givenName%.%person.familyName%');
  await page.getByLabel('Container template').fill(OU_DN);
  await page.getByLabel('Fallback container').fill(OU_DN);
  await page.getByLabel('Person').selectOption({ label: PERSON_NAME });
  await page.getByRole('button', { name: 'Preview' }).click();
  // The name the run would actually create, before anything is written.
  await expect(page.getByText(ACCOUNT_NAME)).toBeVisible();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.goBack();
  await page.getByRole('link', { name: 'Business rules' }).click();
  await expect(page.getByRole('heading', { name: 'Business rules' })).toBeVisible();

  // The catalog has to be read before a rule can name anything in it, and
  // there has to be a control for that or the page tells somebody to do
  // something the console cannot do.
  await page.getByRole('button', { name: 'Refresh entitlement catalog' }).click();
  await expect(page.getByText(/entitlement.*read from the target/i)).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(RULE_NAME);
  await page.getByLabel('Field').selectOption('contract.department');
  await page.getByLabel('Test').selectOption('equals');
  await page.getByLabel('Value').fill(DEPARTMENT);
  await page.getByLabel(GROUP_CN).check();

  await page.getByRole('button', { name: 'Preview impact' }).click();
  const impact = page.locator('p', { hasText: 'This rule matches' });
  await expect(impact).toContainText(/matches\s*1\s*of/);
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // The compound-condition editor, end to end: group the just-saved leaf
  // with AND and add a second leaf naming the SAME department, so the
  // resulting condition matches exactly the same population as the single
  // leaf did — this step verifies the editor and the round-trip through the
  // API, without changing what the rest of this test provisions.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Group with AND' }).click();
  await page.getByRole('button', { name: 'Add condition' }).click();
  const compoundValues = page.getByLabel('Value');
  await expect(compoundValues).toHaveCount(2);
  await compoundValues.nth(1).fill(DEPARTMENT);
  await page.getByRole('button', { name: 'Preview impact' }).click();
  await expect(impact).toContainText(/matches\s*1\s*of/);
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(
    page.getByText(
      `(contract.department is ${DEPARTMENT}) AND (contract.department is ${DEPARTMENT})`,
      { exact: false },
    ),
  ).toBeVisible();

  // EXACT, and from the target's own page.
  //
  // `getByRole('link', { name: 'Runs' })` is a SUBSTRING match, and the admin
  // navigation carries "Sync runs" on every page. After a `goBack()` that did
  // not return here, that was the only match — so this clicked through to
  // Directory Sync's run list, where `heading 'Runs'` matched "Sync runs" just
  // as loosely and the assertion passed. The test then waited five minutes for
  // a "Run now" button on a page that has never had one.
  await page.goto(targetUrl);
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run now' }).click();

  // Enqueued, not performed in the request: the row appears when the worker
  // picks the job up.
  //
  // Pressed for, not merely waited for. `ProvisionRunsPage` polls at
  // `POLL_MS = 2000` for `POLL_LIMIT = 10` attempts and then **stops on
  // purpose** — a page that spins for ever is a page that lies about what it
  // knows — and leaves a Refresh button behind. A bare 120 s wait therefore
  // spends 100 s of it waiting on a poll that is no longer running, and then
  // fails for a reason that has nothing to do with the worker.
  //
  // Scoped to the runs table, too. The old locator was
  // `getByRole('link', { name: /\d/ }).first()` over the WHOLE page, which any
  // navigation link containing a digit can satisfy — including one in the
  // shell above the table.
  const firstRun = page
    .getByRole('table')
    .locator('tbody tr')
    .first()
    .getByRole('link');
  await expect(async () => {
    if ((await firstRun.count()) === 0) {
      await page.getByRole('button', { name: 'Refresh' }).click();
    }
    await expect(firstRun).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
  await firstRun.click();
  await expect(page.getByRole('heading', { name: 'Run detail' })).toBeVisible();

  // A first run is always blocked pending confirmation: every population has
  // a denominator of zero, so no threshold can say anything about it.
  await expect(page.getByText('This run is blocked')).toBeVisible();
  await expect(page.getByText(/never had a run applied/)).toBeVisible();

  // Apply part of it: untick the grant, apply the create.
  const grant = page.getByRole('checkbox', {
    name: `Apply grant_entitlement for ${PERSON_NAME}`,
  });
  await grant.uncheck();
  await page
    .getByLabel('I have read the numbers above and want to apply this run anyway')
    .check();
  await page.getByRole('button', { name: /Apply 1 action/ }).click();
  await expect(page.getByText(/now partially_applied/)).toBeVisible({
    timeout: 60_000,
  });

  // And no second bite. `APPLIABLE_RUN_STATUSES` is ['previewed', 'blocked'],
  // so applying part of a run ends it: what was left out is superseded by the
  // next preview and worked out again against the world as it then is. The
  // plan's script drove a second apply here; the engine answers that 409.
  await expect(page.getByText('Nothing further to apply')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Apply/ })).toHaveCount(0);

  // And the question everybody asks.
  // People is a tab of Users now. Named explicitly rather than relying on the
  // /admin/people redirect, so a failure here is a failure of THIS test's
  // subject rather than of the redirect, which has its own coverage.
  await page.goto('/admin/users?tab=people');
  await page.getByRole('link', { name: PERSON_NAME }).click();
  await page
    .getByRole('link', { name: 'Why does this person hold what they hold?' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Why does this person hold this?' }),
  ).toBeVisible();
  // The account was created; the entitlement was deliberately left out of the
  // apply, so it is not held. An access view that showed it anyway would be
  // reporting what Syntra intended rather than what the person has.
  await expect(page.getByText(TARGET_NAME)).toBeVisible();
  await expect(page.getByText(ACCOUNT_NAME)).toBeVisible();
  await expect(page.getByRole('cell', { name: GROUP_CN })).toHaveCount(0);
});
