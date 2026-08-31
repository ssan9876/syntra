import { expect, test, type Page } from '@playwright/test';

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

async function signInAndLand(page: Page, login: string, password: string) {
  await signIn(page, login, password);
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
}

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

/**
 * Paging and search on the people list, against the seeded directory.
 *
 * `pageSize=1` rather than seeding fifty-one people: the boundary is the
 * subject, and the number that produces it is arbitrary. The seed has more than
 * one person, which is the only thing this relies on.
 */
test('pages through people and searches for one', async ({ page }) => {
  await signInAndLand(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/users?tab=people&pageSize=1', ADMIN!);

  const pager = page.getByText(/^1–1 of \d+$/);
  await expect(pager).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

  // The name on page one, so page two can be shown to hold a different one.
  const firstRow = page.locator('tbody tr').first();
  const firstName = await firstRow.locator('td').first().innerText();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText(/^2–2 of \d+$/)).toBeVisible();
  await expect(page.locator('tbody tr').first().locator('td').first()).not.toHaveText(
    firstName,
  );

  // A search that matches nothing says so, rather than showing an empty table,
  // and it drops the page it was on rather than stranding the reader there.
  await page.getByLabel('Search people').fill('zzz-nobody-by-this-name');
  await expect(page.getByText(/Nobody matches/)).toBeVisible();
  await expect(page).not.toHaveURL(/page=2/);

  // And clearing it puts the list back.
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await expect(page.locator('tbody tr').first()).toBeVisible();
});
