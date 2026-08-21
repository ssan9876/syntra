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
  // WAITED FOR. Clicking Continue starts the elevation; it does not finish it.
  // A UI action after this auto-waits and hides the gap — an API call through
  // `page.request` does not, and goes out against whatever cookie exists at
  // that instant.
  await expect(
    page.getByRole('heading', { name: /confirm your password/i }),
  ).toBeHidden();
}


const STAMP = Date.now();

/**
 * THE FIXTURE THE SEED DOES NOT HAVE.
 *
 * Automate needs a catalog before any of it means anything: a product, an
 * audience that includes the requester, and a workflow naming somebody who can
 * approve. The seed creates none of that, so this file built its whole journey
 * on furniture that was never there.
 *
 * Two constraints shape what follows, and both are properties of the product
 * rather than of the test:
 *
 *   - **`POST /users` cannot set a password**, and there is no admin endpoint
 *     that can. So a created login can never sign in, and the requester has to
 *     be `jdoe` — the seed's one active person with a password.
 *   - **An approver is a PERSON**, and the seeded `admin` is a user with no
 *     person behind it. So the fixture gives it one and links them; otherwise
 *     no `person` selector can ever name the only account that can approve.
 */
async function buildCatalog(page: import('@playwright/test').Page): Promise<void> {
  const ok = async (res: import('@playwright/test').APIResponse, what: string) => {
    expect(res.status(), `${what}: ${await res.text()}`).toBeLessThan(300);
    return res;
  };

  const users = await ok(await page.request.get('/api/admin/users'), 'list users');
  const adminUserId = ((await users.json()).users as { id: string; login: string }[])
    .find((u) => u.login === 'admin')!.id;

  const approver = await ok(
    await page.request.post('/api/admin/persons', {
      data: { givenName: 'Ada', familyName: 'Approver', businessEmail: `ada${STAMP}@acme.test` },
    }),
    'create the approver person',
  );
  const approverPersonId = (await approver.json()).id as string;
  await ok(
    await page.request.post(`/api/admin/persons/${approverPersonId}/link-user`, {
      data: { userId: adminUserId },
    }),
    'link the approver to the admin login',
  );

  // AND A CONTRACT. `isValidApprover` drops anybody with no active one —
  // `no_active_contract` — which is a real rule and a good one: an approver is
  // somebody the organization currently employs. A person with a login and no
  // contract resolves to nobody, and the request comes back
  // `blocked_no_approver` with the stage saying so.
  await ok(
    await page.request.post(`/api/admin/persons/${approverPersonId}/contracts`, {
      data: {
        sequence: 1,
        isPrimary: true,
        startDate: '2024-01-01',
        jobTitle: 'Head of access',
        department: 'Security',
        employer: 'Acme Care',
      },
    }),
    'give the approver a contract',
  );

  const workflow = await ok(
    await page.request.post('/api/admin/automate/workflows', {
      data: {
        name: `One approval ${STAMP}`,
        stages: [
          {
            sequence: 1,
            name: 'Approval',
            selector: 'person',
            selectorConfig: { personId: approverPersonId },
          },
        ],
      },
    }),
    'create the workflow',
  );
  const workflowId = (await workflow.json()).id as string;

  // A product grants something, and a Syntra group is the one resource type
  // this fixture can create outright — no target system, no connector.
  for (const [name, slug] of [
    ['Statistics licence', `statistics-licence-${STAMP}`],
    ['Finance folder', `finance-folder-${STAMP}`],
  ] as const) {
    const group = await ok(
      await page.request.post('/api/admin/groups', {
        data: { name: `${name} ${STAMP}`, description: 'Built by the Automate browser spec.' },
      }),
      `create the group behind ${name}`,
    );
    const groupId = (await group.json()).id as string;

    await ok(
      await page.request.post('/api/admin/automate/products', {
        data: {
          name,
          slug,
          kind: 'localGroup',
          grants: [{ resourceType: 'group', resourceId: groupId }],
          // `{ all: [] }` is an empty AND: everybody matches. The audience is
          // not what these tests are about, and a narrower one would fail for
          // a reason that has nothing to do with requesting or approving.
          audienceCondition: { all: [] },
          workflowId,
          durationMode: 'permanent',
          status: 'active',
        },
      }),
      `create ${name}`,
    );
  }
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/automate/products');
    await buildCatalog(page);
  } finally {
    await context.close();
  }
});

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
  await signIn(page, 'jdoe', USER!);
  await page.goto('/catalog');
  await page.getByRole('link', { name: /statistics licence/i }).first().click();
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

  await signIn(page, 'jdoe', USER!);
  await page.goto('/access');
  await expect(page.getByText(/held/i).first()).toBeVisible();
});

test('a refusal names the reason and the requester reads it', async ({ page }) => {
  await signIn(page, 'jdoe', USER!);
  await page.goto('/catalog');
  await page.getByRole('link', { name: /finance folder/i }).first().click();
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

  await signIn(page, 'jdoe', USER!);
  await page.goto('/requests');
  await expect(page.getByText(/refused/i)).toBeVisible();
  await page.getByRole('link', { name: /finance folder/i }).first().click();
  await expect(page.getByText('not for this project')).toBeVisible();
});

/**
 * THE LAST TWO, and why each is still `fixme`.
 *
 * **The team lead** signs in as `lead`, and fills a field from
 * `process.env.SEED_MEMBER_PERSON_ID` — an environment variable that is set
 * nowhere in this repository. `lead` cannot be created either: `POST /users`
 * makes a login with no password and there is no admin endpoint that sets one,
 * so the only accounts that can reach the portal are the two the seed gives a
 * password to. Covering this needs either a seeded second portal user or an
 * administrative way to set a password, and both are product decisions rather
 * than test ones.
 *
 * **The blocked sweep** needs a population of grants close enough to expiry to
 * trip the sweep's own guard. That is a fixture of a different kind — time, and
 * enough of it — and it is exercised at the service layer in
 * `automate/sweep-service.test.ts`.
 */
test.fixme('a team lead adds a member from the portal with no administrative session', async ({
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

test.fixme('a blocked sweep is reviewed and confirmed', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/automate/sweeps');
  await page.getByRole('button', { name: /run a preview now/i }).click();
  await page.getByRole('link').first().click();
  await expect(page.getByText(/this sweep stopped/i)).toBeVisible();
  await page.getByRole('button', { name: /apply the ticked rows/i }).click();
  await expect(page.getByText(/applied/i).first()).toBeVisible();
});
