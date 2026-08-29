import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The path a human takes, once.
 *
 * The branching lives in the unit tests: `guard.test.ts` and `diff.test.ts`
 * enumerate the cases, and an end-to-end run that tried to would be slow,
 * flaky, and a worse description of them than those files already are. What
 * only this level can show is that the console, the API, the connector and
 * the guard agree about one real file on one real server.
 *
 * Needs the SFTP container from `infra/docker-compose.yml`:
 *
 *   pnpm sftp:up && pnpm sftp:wait
 *
 * and an API started with `OUTBOUND_ALLOW_PRIVATE=true`, because the container
 * is on loopback and the outbound guard blocks that by default.
 */
const ADMIN = process.env.SEED_ADMIN_PASSWORD;
/**
 * Everything this spec writes is scoped to one run.
 *
 * `PersonSource` is unique on (tenant, name) and `Person` on (tenant,
 * externalId), so a second run against a database the first already wrote to
 * would fail on the create rather than on anything these tests are about --
 * and, worse, the assertions about people appearing would be satisfied by the
 * PREVIOUS run's rows, which is a test that passes while proving nothing.
 */
const RUN = String(Date.now()).slice(-6);
const SOURCE_NAME = `HR nightly (e2e ${RUN})`;
const EXPORT_FILE = resolve(process.cwd(), 'infra/sftp/people.csv');

const HEADER = 'employeeId,firstName,lastName,hireDate,dept\n';
const ADA = `${RUN}-1,Ada,Lovelace${RUN},2026-01-05,Research\n`;
const GRACE = `${RUN}-2,Grace,Hopper${RUN},2026-02-01,Engineering\n`;
const FULL = HEADER + ADA + GRACE;

test.beforeAll(() => {
  if (!ADMIN) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be set to the value the database was seeded with',
    );
  }
  // The second test rewrites this file; restore it so a re-run starts clean.
  writeFileSync(EXPORT_FILE, FULL, 'utf8');
});

test.afterAll(() => {
  writeFileSync(EXPORT_FILE, FULL, 'utf8');
});

async function signInAndLand(page: Page, login: string, password: string) {
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
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeHidden();
}

test.describe.serial('an HR source, end to end', () => {
  test('is created, its key accepted, mapped, run and applied from the console', async ({
    page,
  }) => {
    await signInAndLand(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/sources', ADMIN!);
    await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();

    await page.getByRole('tab', { name: 'People' }).click();
    await page.getByRole('link', { name: 'New person source' }).click();

    // Exact: "Name" is a substring of "Username".
    await page.getByLabel('Name', { exact: true }).fill(SOURCE_NAME);
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Port', { exact: true }).fill('2222');
    await page.getByLabel('Username').fill('syntra');
    await page.getByLabel('Remote path').fill('/export/people.csv');
    await page.getByLabel(/password or private key/i).fill('Syntra!Passw0rd');

    // Nothing is preselected, and nothing can be saved until it is answered.
    // This is the field that decides whether somebody missing from tomorrow's
    // file is a leaver.
    await expect(page.getByRole('button', { name: 'Create source' })).toBeDisabled();
    await page.getByRole('radio', { name: /everyone currently employed/i }).check();
    await expect(page.getByText(/treated as leavers/i)).toBeVisible();
    await page.getByRole('button', { name: 'Create source' }).click();
    await expect(page).toHaveURL(/\/admin\/person-sources\/[0-9a-f-]{36}$/);

    // The key is accepted from what the test showed, never typed. There is no
    // field to type one into.
    await expect(page.getByLabel(/fingerprint/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText(/host key Syntra has not seen before/i)).toBeVisible();
    await page.getByRole('button', { name: 'Accept this key' }).click();
    await expect(page.getByText(/host key accepted/i)).toBeVisible();

    // Mapping from the columns the test actually read.
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByLabel(/column for employee id/i)).toBeVisible();
    await page.getByLabel(/column for employee id/i).selectOption('employeeId');
    await page.getByLabel(/column for given name/i).selectOption('firstName');
    await page.getByLabel(/column for family name/i).selectOption('lastName');
    await page.getByLabel(/column for start date/i).selectOption('hireDate');
    await page.getByLabel(/column for department/i).selectOption('dept');
    await page.getByRole('button', { name: 'Save mappings' }).click();

    // Run it. The console lands on the run it started.
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page).toHaveURL(/\/admin\/person-import-runs\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/2 records read/i)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /^Apply$/ }).click();
    // The run is applied, so it offers no apply action any more. The changes
    // stay listed -- a run is a record of what happened, not a queue that
    // empties.
    await expect(page.getByRole('button', { name: /^Apply$/ })).toHaveCount(0, {
      timeout: 30_000,
    });

    await page.goto('/admin/users?tab=people');
    await expect(page.getByText(`Lovelace${RUN}`)).toBeVisible();
    await expect(page.getByText(`Hopper${RUN}`)).toBeVisible();
  });

  /**
   * The second run, with a file that lost somebody.
   *
   * This is the branch worth spending an end-to-end on: it crosses the
   * connector, the diff, the guard, the confirmation and the apply, and it is
   * the whole reason the feature exists.
   */
  test('proposes a leaver when the next file drops somebody, and applies it once confirmed', async ({
    page,
  }) => {
    // Grace is gone from tonight's file. Ada is not.
    writeFileSync(EXPORT_FILE, HEADER + ADA, 'utf8');

    await signInAndLand(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/sources', ADMIN!);
    await page.getByRole('tab', { name: 'People' }).click();
    await page.getByRole('link', { name: SOURCE_NAME }).click();

    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page).toHaveURL(/\/admin\/person-import-runs\/[0-9a-f-]{36}$/);

    // One of two is 50%, over the 10% threshold: blocked, and confirmable.
    await expect(page.getByRole('heading', { name: /leavers/i })).toBeVisible({
      timeout: 30_000,
    });
    // The same sentence twice, deliberately: the guard's refusal and the
    // count beside the leavers list. That is the design -- the administrator
    // confirming reads the number the refusal was computed from -- so the
    // locators have to tell them apart rather than collapse them.
    await expect(
      page.getByText('1 of 2 people this source owns', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/would depart 1 of 2 people this source owns \(50\.0%\)/),
    ).toBeVisible();

    await page.getByRole('button', { name: /i have read the numbers/i }).click();
    await expect(
      page.getByRole('button', { name: /i have read the numbers/i }),
    ).toHaveCount(0, { timeout: 30_000 });

    await page.goto('/admin/users?tab=people');
    // Departed, not deleted: the row is still there. Nothing in this pipeline
    // removes a person, and the register stays auditable because of it.
    await expect(page.getByText(`Hopper${RUN}`)).toBeVisible();
  });
});
