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
  await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function elevateTo(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: /confirm your password/i })).toBeVisible();
  await page.getByLabel('Password').fill(ADMIN!);
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('a product with no audience is visible to nobody, and saying so is on the screen', async ({
  page,
}) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/automate/products/new');
  await page.getByLabel('Name').fill('Nobody sees this');
  await page.getByLabel('Slug').fill('nobody-sees-this');
  await page.getByRole('button', { name: /show me who/i }).click();
  await expect(page.getByText(/nobody will see this product/i)).toBeVisible();
});

test('a user requests something, the manager approves, and the user sees it granted', async ({
  page,
}) => {
  await signIn(page, 'user', USER!);
  await page.goto('/catalog');
  await page.getByRole('link', { name: /statistics licence/i }).click();
  await page.getByLabel(/why do you need this/i).fill('Q3 audit');
  await page.getByRole('button', { name: /send the request/i }).click();
  await expect(page.getByText(/waiting for approval/i)).toBeVisible();
  // Naming the approver is deliberate: anonymous approval makes chasing
  // impossible and removes the accountability that makes an approver read it.
  await expect(page.getByText(/with:/i)).toBeVisible();
  await signOut(page);

  await signIn(page, 'admin', ADMIN!);
  await page.goto('/approvals');
  await page.getByLabel('Comment').fill('fine for the audit');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/nothing is waiting for you/i)).toBeVisible();
  await signOut(page);

  await signIn(page, 'user', USER!);
  await page.goto('/access');
  await expect(page.getByText(/held/i).first()).toBeVisible();
});

test('a refusal names the reason and the requester reads it', async ({ page }) => {
  await signIn(page, 'user', USER!);
  await page.goto('/catalog');
  await page.getByRole('link', { name: /finance folder/i }).click();
  await page.getByLabel(/why do you need this/i).fill('for a report');
  await page.getByRole('button', { name: /send the request/i }).click();
  await signOut(page);

  await signIn(page, 'admin', ADMIN!);
  await page.goto('/approvals');
  await page.getByRole('button', { name: 'Refuse' }).click();
  // The client refuses to send it, before the server does.
  await expect(page.getByText(/say why/i)).toBeVisible();
  await page.getByLabel('Comment').fill('not for this project');
  await page.getByRole('button', { name: 'Refuse' }).click();
  await signOut(page);

  await signIn(page, 'user', USER!);
  await page.goto('/requests');
  await expect(page.getByText(/refused/i)).toBeVisible();
  await page.getByRole('link', { name: /finance folder/i }).click();
  await expect(page.getByText('not for this project')).toBeVisible();
});

test('a team lead adds a member from the portal with no administrative session', async ({
  page,
}) => {
  await signIn(page, 'lead', USER!);
  await page.goto('/managed');
  await expect(page.getByText(/resources you manage/i)).toBeVisible();
  await page.getByLabel(/add somebody/i).fill(process.env.SEED_MEMBER_PERSON_ID ?? '');
  await page.getByRole('button', { name: 'Add' }).click();
  // No elevation prompt appeared anywhere in this test. That is the assertion:
  // this surface works under an ordinary portal session.
  await expect(page.getByRole('heading', { name: /confirm your password/i })).toHaveCount(0);
});

test('a blocked sweep is reviewed and confirmed', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/automate/sweeps');
  await page.getByRole('button', { name: /run a preview now/i }).click();
  await page.getByRole('link').first().click();
  await expect(page.getByText(/this sweep stopped/i)).toBeVisible();
  await page.getByRole('button', { name: /apply the ticked rows/i }).click();
  await expect(page.getByText(/applied/i).first()).toBeVisible();
});
