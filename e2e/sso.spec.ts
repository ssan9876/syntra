import { expect, test, type Page, type BrowserContext } from '@playwright/test';

const ADMIN = process.env.SEED_ADMIN_PASSWORD;
const USER = process.env.SEED_USER_PASSWORD;

test.beforeAll(() => {
  if (!ADMIN || !USER) {
    throw new Error(
      'SEED_ADMIN_PASSWORD and SEED_USER_PASSWORD must be set to the values the database was seeded with',
    );
  }
});

/**
 * The user-visible half of the slice: a tile that signs somebody into a real
 * service provider, and a policy rule that interrupts it.
 *
 * The service provider is a route handler on the *context* rather than on the
 * page. A launch opens the application in a tab of its own — with `noopener`,
 * so the application cannot reach back into the portal — and a handler
 * registered on the page that did the clicking would never see the request the
 * new tab makes.
 *
 * The handler accepts the POST and echoes what it received, which is enough to
 * prove the browser was sent there with a `SAMLResponse`. The assertion's
 * contents are pinned by the unit and integration suites, which can read the
 * XML; a browser test can only see that the round trip happened.
 */
async function serviceProvider(context: BrowserContext) {
  await context.route('https://sp.example.test/acs', async (route) => {
    const posted = route.request().postData() ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body:
        `<h1 id="sp">signed in</h1>` +
        `<pre id="body">${posted.slice(0, 64).replace(/</g, '&lt;')}</pre>`,
    });
  });
}

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

/** Clicks the tile and returns the tab it opened. */
async function launch(context: BrowserContext, page: Page, name: string) {
  const [opened] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: new RegExp(name, 'i') }).click(),
  ]);
  return opened;
}

test('a SAML tile signs the user into the service provider', async ({
  page,
  context,
}) => {
  await serviceProvider(context);
  await signInAndLand(page, 'jdoe', USER!);

  const sp = await launch(context, page, 'CRM');

  // The tile's address is derived from the tenant's own protocol identity, so
  // the tab starts on Syntra and only then auto-posts to the service provider.
  await expect(sp.locator('#sp')).toHaveText('signed in');
  await expect(sp.locator('#body')).toContainText('SAMLResponse');
  await sp.close();
});

/**
 * A rule scoped to the application, added and removed through the API.
 *
 * The console has no editor for an application-scoped rule — it writes
 * tenant-wide ones — and a tenant-wide `require_mfa` would interrupt the
 * *sign-in* rather than the launch, which is a different assertion and one the
 * MFA spec already makes. This is fixture work, so it goes through the API
 * with the administrator's own cookies rather than through screens that do not
 * exist.
 */
test.describe.serial('a rule scoped to the application', () => {
  test('interrupts the launch, and the launch completes once it is gone', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL!,
    });
    const admin = await adminContext.newPage();

    // The administrator elevates from a screen, because that is the only way
    // an administrative session is issued.
    await signInAndLand(admin, 'admin', ADMIN!);
    await admin.goto('/admin/policy');
    await expect(
      admin.getByRole('heading', { name: /confirm your password/i }),
    ).toBeVisible();
    await admin.getByLabel('Password').fill(ADMIN!);
    await admin.getByRole('button', { name: 'Continue' }).click();
    await expect(
      admin.getByRole('heading', { name: 'Authentication policy' }),
    ).toBeVisible();

    const applications = await admin.request.get('/api/admin/applications');
    const crm = (await applications.json()).applications.find(
      (row: { slug: string }) => row.slug === 'crm',
    );
    expect(crm, 'the seed creates a CRM application').toBeTruthy();

    const created = await admin.request.post('/api/admin/policy/rules', {
      data: {
        name: 'CRM needs a second factor',
        outcome: 'require_mfa',
        applicationIds: [crm.id],
      },
    });
    expect(created.status()).toBe(201);
    const ruleId = (await created.json()).id;

    const userContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL!,
    });
    const user = await userContext.newPage();
    try {
      await serviceProvider(userContext);

      // Signing in is untouched: the rule names one application, so it decides
      // nothing until somebody tries to enter that application.
      await signInAndLand(user, 'jdoe', USER!);

      await user.getByRole('button', { name: /CRM/i }).click();

      // Whether this is a step-up or a forced enrolment depends on whether
      // this user already holds a factor, and both are the same claim: the
      // launch stopped at the chokepoint. What matters is that it stopped.
      await expect(
        user.getByRole('heading', { name: /one more step|set up a second factor/i }),
      ).toBeVisible();
      // And no assertion was issued on the way past.
      expect(userContext.pages()).toHaveLength(1);

      // Take the rule away and try again. Without this the test proves only
      // that something refused; with it, it proves the rule was what refused.
      const removed = await admin.request.delete(`/api/admin/policy/rules/${ruleId}`);
      expect(removed.status()).toBe(204);

      await user.goto('/');
      await expect(user.getByRole('heading', { name: /good day/i })).toBeVisible();
      const sp = await launch(userContext, user, 'CRM');
      await expect(sp.locator('#sp')).toHaveText('signed in');
      await sp.close();
    } finally {
      // A rule left in force sends every later launch in this file to a
      // step-up screen, and the failure would surface in a test that has
      // nothing to do with it.
      await admin.request.delete(`/api/admin/policy/rules/${ruleId}`);
      await userContext.close();
      await adminContext.close();
    }
  });
});

/**
 * The other direction: a sign-in that *starts* at the protocol endpoint.
 *
 * This is the path the portal launch does not exercise. A browser arrives at a
 * Syntra protocol route holding no session, and everything after that is
 * full-page redirects — `/login?next=...` out, `/saml/continue?handle=...`
 * back — with no response body anywhere for the React application to read. It
 * read none of it until this task: signing in landed the user on the portal
 * and the service provider's request was abandoned with nothing on screen to
 * say so.
 */
test('a sign-in that starts at the protocol endpoint comes back to it', async ({
  page,
  context,
}) => {
  await serviceProvider(context);

  // The application id, from the tile list rather than from a fixture file.
  await signInAndLand(page, 'jdoe', USER!);
  const tiles = await page.request.get('/api/portal/applications');
  const crm = (await tiles.json()).applications.find(
    (row: { slug: string }) => row.slug === 'crm',
  );
  expect(crm).toBeTruthy();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Now arrive at the identity provider with no session, the way a service
  // provider's own "sign in" button sends somebody.
  await page.goto(`/saml/start/${crm.id}`);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveURL(/next=/);

  await page.getByLabel('Login').fill('jdoe');
  await page.getByLabel('Password').fill(USER!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Back to where the browser was going, and on to the service provider — in
  // this tab, because nothing opened a new one.
  await expect(page.locator('#sp')).toHaveText('signed in');
  await expect(page.locator('#body')).toContainText('SAMLResponse');
});
