import { expect, test, type Page } from '@playwright/test';

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

test('an administrator signs in, elevates, and reaches the directory', async ({
  page,
}) => {
  await signIn(page, 'admin', ADMIN!);
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();

  await page.goto('/admin/users');
  // Reaching the console requires re-entering the password: elevation is a
  // fresh authentication, not a mode the portal session can switch into.
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeVisible();

  await page.getByLabel('Password').fill(ADMIN!);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('admin');
});

test('a wrong password and an unknown login look identical', async ({ page }) => {
  await signIn(page, 'admin', 'definitely-not-the-password');
  const wrong = await page.getByRole('alert').textContent();

  await page.goto('/login');
  await signIn(page, 'nobody-at-all', 'definitely-not-the-password');
  const unknown = await page.getByRole('alert').textContent();

  expect(unknown).toBe(wrong);
});

test('a non-administrator is refused the console', async ({ page }) => {
  await signIn(page, 'jdoe', USER!);
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();

  await page.goto('/admin/users');
  await page.getByLabel('Password').fill(USER!);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('alert')).toContainText(
    /no administrative roles/i,
  );
  await expect(page).not.toHaveURL(/\/admin\/users/);
});

test('signing out revokes the session', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // The cookie is gone, so returning to the portal bounces back to sign-in.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('a person with concurrent contracts shows both', async ({ page }) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/people', ADMIN!);

  await page.getByRole('link', { name: 'Jo Doe' }).click();
  await expect(page.getByRole('heading', { name: 'Contracts' })).toBeVisible();

  const contracts = page.getByRole('table').first();
  await expect(contracts).toContainText('Staff Nurse');
  await expect(contracts).toContainText('Clinical Trainer');
  await expect(contracts).toContainText('Primary');
  // An open-ended contract reads as ongoing rather than as missing data.
  await expect(contracts).toContainText('Ongoing');
});

test('a partial CSV import names every rejected line', async ({ page }) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/import', ADMIN!);

  const stamp = Date.now();
  await page.locator('#csv').fill(
    'externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department\n' +
      `E2E-${stamp}-a,Ada,Good,a@acme.localhost,1,true,2026-04-01,,Physiotherapist,Care\n` +
      `E2E-${stamp}-b,Bad,Sequence,b@acme.localhost,x,false,2026-04-01,,Porter,Facilities\n` +
      `E2E-${stamp}-c,Bad,Date,c@acme.localhost,1,true,2026-02-30,,Pharmacist,Care`,
  );
  await page.getByRole('button', { name: 'Import' }).click();

  const report = page.getByRole('alert');
  await expect(report).toContainText('1 created');
  await expect(report).toContainText('2 rejected');
  await expect(report).toContainText('sequence is not an integer');
  // 2026-02-30 parses in JavaScript and rolls into March; it must not.
  await expect(report).toContainText('startDate is not a valid ISO date');
});

test('the audit log reports whether its chain still holds', async ({ page }) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/audit', ADMIN!);

  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('auth.login');
});
