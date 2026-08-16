import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';

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

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

/** Elevates into the console on the way to `path`. */
async function elevateTo(page: Page, path: string) {
  await page.goto(path);
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeVisible();
  await page.getByLabel('Password').fill(ADMIN!);
  await page.getByRole('button', { name: 'Continue' }).click();
}

const codeFor = (secret: string, at = Date.now()) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: 30,
    digits: 6,
    algorithm: 'SHA1',
    timestamp: at,
  });

/** The shared secret, shown once, as base32 and nothing else on its own line. */
const SECRET = /^[A-Z2-7]{32}$/;

/** Two groups of five from a Crockford-ish alphabet: no I, L, O, U, 0 or 1. */
const RECOVERY_CODE = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

/**
 * Waits until the next thirty-second TOTP step begins.
 *
 * Confirming an enrolment sets the replay watermark to the step it happened
 * in, so the very next code the user is asked for is refused if it is still
 * that same step — deliberately, since that is what stops the enrolment code
 * being replayed as a login. The integration tests backdate the enrolment to
 * sidestep this; a browser cannot, so it waits. Up to thirty-one seconds, once,
 * in one test.
 */
async function waitForNextTotpStep() {
  await new Promise((resolve) =>
    setTimeout(resolve, 30_000 - (Date.now() % 30_000) + 1_000),
  );
}

/**
 * Adds a rule from the policy page, checking the affected-user count first.
 * The page must already be on `/admin/policy` with an administrative session.
 */
async function saveRule(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Outcome').selectOption('require_mfa');

  // The count is shown before the rule is saved, not discovered afterwards.
  await page.getByRole('button', { name: /check who this affects/i }).click();
  await expect(page.getByText(/active users/i)).toBeVisible();

  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function removeRule(page: Page, name: string) {
  await page
    .getByRole('listitem')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText(name)).toHaveCount(0);
}

/**
 * Adds a `require_mfa` rule, runs the body, and takes the rule away again
 * WHATEVER the body does.
 *
 * The removal used to be the last statement of each test. A failure anywhere
 * before it left the rule in place, and a leftover `require_mfa` rule sends
 * every subsequent sign-in -- in this file and in every other spec, on this
 * run and on the next one until somebody reseeds -- to a step-up screen. One
 * genuine failure therefore reported as eleven, none of them anywhere near
 * their cause.
 *
 * The cleanup is best-effort only when the body already failed: a session the
 * failure killed cannot remove anything, and a throw from here would replace
 * the error that actually matters. When the body succeeded, a cleanup failure
 * IS the failure, because the next spec is about to inherit it.
 */
async function withRule(page: Page, name: string, body: () => Promise<void>) {
  await saveRule(page, name);
  let failed = false;
  try {
    await body();
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    try {
      await page.goto('/admin/policy');
      await removeRule(page, name);
    } catch (cleanup) {
      if (!failed) throw cleanup;
      console.error(`could not remove the "${name}" rule after a failing test`, cleanup);
    }
  }
}

test.describe.serial('access, second factors and the console', () => {
  test('a user sees the tiles assigned to them, and launching one opens it', async ({
    page,
    context,
  }) => {
    // The seeded launch URLs point at example.com. Fulfilled here so the suite
    // neither depends on the public internet nor reaches it.
    await context.route('https://example.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>The rota</h1>',
      }),
    );

    await signIn(page, 'jdoe', USER!);
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /rota planner/i })).toBeVisible();
    // Assigned to the owner only, so it must not appear here.
    await expect(page.getByRole('button', { name: /expenses/i })).toHaveCount(0);

    // A launch is a fresh authorize() decision, not a link. It opens in a tab
    // of its own — with noopener, so the application cannot reach back into
    // the portal — which is why this waits on the context rather than on a
    // popup opener the portal deliberately does not keep.
    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /rota planner/i }).click(),
    ]);
    await expect(opened).toHaveURL('https://example.com/rota');
    await opened.close();
  });

  test('a forgotten password answers the same for a real and an invented account', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Login or email').fill('jdoe');
    await page.getByRole('button', { name: /send the link/i }).click();
    const real = await page.getByRole('alert').textContent();

    await page.goto('/forgot-password');
    await page.getByLabel('Login or email').fill('definitely-not-a-user');
    await page.getByRole('button', { name: /send the link/i }).click();
    const invented = await page.getByRole('alert').textContent();

    expect(invented).toBe(real);
  });

  test('an administrator sees the application catalog', async ({ page }) => {
    await signInAndLand(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/applications');
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
    await expect(page.getByRole('link', { name: /staff handbook/i })).toBeVisible();
  });

  test('a user with no factor is enrolled rather than refused, and challenged next time', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000); // one wait for the next TOTP step
    const RULE = 'Everyone needs a factor';

    // The administrator saves the rule from a session established before it
    // existed, and keeps that session for the whole test. A policy change does
    // not reach sessions that are already live, which is what lets the rule be
    // taken away again at the end without the administrator first having to
    // satisfy the rule they just turned on.
    await signInAndLand(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/policy');
    await expect(
      page.getByRole('heading', { name: 'Authentication policy' }),
    ).toBeVisible();
    await withRule(page, RULE, async () => {
      // A second browser for the user. Signing in as somebody else on this page
      // would overwrite the administrator's cookie, and the rule is now in force
      // for every sign-in — so the administrator could not get back in to remove
      // it without going through forced enrolment themselves, and the cleanup
      // would fail three assertions away from its cause.
      const userContext = await browser.newContext({
        baseURL: test.info().project.use.baseURL!,
      });
      const user = await userContext.newPage();
      try {
        // A user who has never enrolled is offered enrolment, not a dead end.
        await signIn(user, 'jdoe', USER!);
        await expect(
          user.getByRole('heading', { name: /set up a second factor/i }),
        ).toBeVisible();
        await user.getByRole('button', { name: 'Start' }).click();

        const secret = await user.getByText(SECRET).innerText();
        await user.getByLabel('Six-digit code').fill(codeFor(secret));
        await user.getByRole('button', { name: 'Confirm' }).click();

        // Enrolling is proof of possession, so the sign-in completes rather than
        // immediately asking for the same code again.
        await expect(user.getByRole('heading', { name: /good day/i })).toBeVisible();

        // Signing in again now takes the step-up path instead.
        await signOut(user);
        await waitForNextTotpStep();
        await signIn(user, 'jdoe', USER!);
        await expect(
          user.getByRole('heading', { name: /one more step/i }),
        ).toBeVisible();
        await user.getByLabel('Six-digit code').fill(codeFor(secret));
        await user.getByRole('button', { name: 'Verify' }).click();
        await expect(user.getByRole('heading', { name: /good day/i })).toBeVisible();
        await signOut(user);
      } finally {
        await userContext.close();
      }
    });

    await signOut(page);
  });

  test('an administrator presents a factor and lands where the guard bounced them from', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const RULE = 'The console needs a factor';

    await signInAndLand(page, 'admin', ADMIN!);

    // The administrator enrols before the rule exists. Turning it on first
    // would send them through forced enrolment on the way back in — which
    // works, and the previous test proves it — but this test is about the
    // step-up an administrator who already holds a factor is asked for.
    await page.goto('/security');
    await page.getByRole('button', { name: 'Set up' }).click();
    const secret = await page.getByText(SECRET).innerText();
    await page.getByLabel('Code from your app').fill(codeFor(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();
    // The button is replaced by a status once the factor is confirmed.
    await expect(page.getByRole('button', { name: 'Set up' })).toHaveCount(0);

    // Recovery codes answer the step-ups below. That enrolment has just set
    // the replay watermark, and a recovery code is not subject to it, so this
    // test does not spend two more thirty-second waits re-proving what the
    // previous one already proved about TOTP.
    await page.getByRole('button', { name: 'Generate codes' }).click();
    // allInnerTexts() does not retry, so wait for the sheet to arrive first.
    await expect(page.getByText(/save these now/i)).toBeVisible();
    const codes = await page.getByText(RECOVERY_CODE).allInnerTexts();
    expect(codes).toHaveLength(10);

    await elevateTo(page, '/admin/policy');
    await withRule(page, RULE, async () => {
      await signOut(page);

      // Signing in now takes the step-up path.
      await signIn(page, 'admin', ADMIN!);
      await expect(page.getByRole('heading', { name: /one more step/i })).toBeVisible();
      await page.getByRole('button', { name: 'Use a recovery code' }).click();
      await page.getByLabel('Recovery code').fill(codes[0]!);
      await page.getByRole('button', { name: 'Verify' }).click();
      await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();

      // A deep link into the console. The guard bounces to /elevate; elevation
      // re-authenticates from scratch, so the factor presented at sign-in does
      // not carry over and the rule is met a second time. Satisfying it must
      // return the administrator to where they were going rather than to the
      // console's first page.
      await page.goto('/admin/audit');
      await expect(
        page.getByRole('heading', { name: /confirm your password/i }),
      ).toBeVisible();
      await page.getByLabel('Password').fill(ADMIN!);
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page.getByRole('heading', { name: /one more step/i })).toBeVisible();
      await page.getByRole('button', { name: 'Use a recovery code' }).click();
      await page.getByLabel('Recovery code').fill(codes[1]!);
      await page.getByRole('button', { name: 'Verify' }).click();

      await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
      await expect(page).toHaveURL(/\/admin\/audit/);
    });

    await signOut(page);
  });
});
