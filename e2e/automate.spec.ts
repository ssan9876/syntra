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
/** Matched on by the CSV import that later ends this person's contract. */
const LEAVER_EXTERNAL_ID = `E-LEAVER-${STAMP}`;

/**
 * What `buildCatalog` made, for the tests that need to name it.
 *
 * Written once in `beforeAll` and read afterwards. The suite runs with
 * `workers: 1` and `fullyParallel: false`, so there is exactly one of these.
 */
const fixture = {
  /** Jo Doe — `jdoe`'s person, and the delegate who manages the group below. */
  joPersonId: '',
  /** Ada Approver, the person the team-lead test adds. */
  approverPersonId: '',
  /** A group Jo manages directly, with no product behind it. */
  wardGroupId: '',
  /**
   * Employed when they are granted, and a leaver by the time the sweep runs.
   * That order is forced — see `endTheLeaverContract`.
   */
  leaverPersonId: '',
};

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
  fixture.approverPersonId = approverPersonId;
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

  // ---- What the delegation tests need -----------------------------------
  //
  // A team lead is a PERSON holding a `ResourceDelegation`, acting under an
  // ordinary portal session. The only portal login the seed gives a password
  // to is `jdoe`, so Jo Doe is the team lead — which is also the honest
  // shape of the thing: a delegate is a colleague, not a second administrator.
  const persons = await ok(await page.request.get('/api/admin/persons'), 'list persons');
  fixture.joPersonId = ((await persons.json()).persons as {
    id: string;
    externalId: string | null;
  }[]).find((p) => p.externalId === 'E1001')!.id;

  // A group with NO product behind it, deliberately. `delegatedGrant` applies
  // the product's audience where there is one and the delegation's own where
  // there is not, and it is the second path this exercises — the one that
  // stops delegation being a hole underneath the catalog's visibility model.
  const ward = await ok(
    await page.request.post('/api/admin/groups', {
      data: { name: `Ward rota ${STAMP}`, description: 'Managed by a team lead.' },
    }),
    'create the delegated group',
  );
  fixture.wardGroupId = (await ward.json()).id as string;

  await ok(
    await page.request.post('/api/admin/automate/resource-delegations', {
      data: {
        resourceType: 'group',
        resourceId: fixture.wardGroupId,
        delegatePersonId: fixture.joPersonId,
        capabilities: ['view_members', 'grant', 'revoke'],
        // `{ all: [] }` is an empty AND: everybody is inside the audience.
        // Narrowing it would refuse the grant for a reason that has nothing to
        // do with what these tests are about.
        audienceCondition: { all: [] },
        startsAt: '2024-01-01',
      },
    }),
    'delegate the group to Jo',
  );

  // A LEAVER, for the sweep — created here EMPLOYED, and made a leaver later.
  //
  // The order is forced and it is worth saying why. A grant can only be made
  // to somebody the audience admits, and `{ all: [] }` still does not admit a
  // person with no active contract — an empty AND is not "no rules", it is
  // still asked whether this person is anybody. So the leaver must hold a live
  // contract at the moment they are granted, and lose it afterwards.
  //
  // They also need a Syntra ACCOUNT. A group grant adds a user to a group, so
  // fulfilment refuses a person with none — `the subject holds no active
  // Syntra account` — and the request lands in `fulfilment_failed` with no
  // grant behind it and nothing for the sweep to find.
  const leaver = await ok(
    await page.request.post('/api/admin/persons', {
      data: {
        givenName: 'Lee',
        familyName: 'Aver',
        businessEmail: `lee${STAMP}@acme.test`,
        externalId: LEAVER_EXTERNAL_ID,
      },
    }),
    'create the leaver',
  );
  fixture.leaverPersonId = (await leaver.json()).id as string;
  await ok(
    await page.request.post(`/api/admin/persons/${fixture.leaverPersonId}/contracts`, {
      data: {
        sequence: 1,
        isPrimary: true,
        startDate: '2024-01-01',
        jobTitle: 'Bank Nurse',
        department: 'Care',
        employer: 'Acme Care',
      },
    }),
    'employ the leaver, for now',
  );

  const leaverUser = await ok(
    await page.request.post('/api/admin/users', {
      data: {
        login: `lee${STAMP}`,
        email: `lee${STAMP}@acme.test`,
        displayName: 'Lee Aver',
      },
    }),
    'create the leaver login',
  );
  await ok(
    await page.request.post(`/api/admin/persons/${fixture.leaverPersonId}/link-user`, {
      data: { userId: (await leaverUser.json()).id as string },
    }),
    'link the leaver to their account',
  );
}

/**
 * The leaver leaves — through the CSV import, which is how a real deployment
 * records it.
 *
 * There is no endpoint that ends a contract. The import is the path: it
 * matches an existing contract on `(person, sequence)` and updates it in
 * place, end date included, which is exactly what an HR export carrying a
 * leaver looks like. Using it here means the fixture is doing something the
 * product actually supports rather than reaching behind it.
 */
async function endTheLeaverContract(
  page: import('@playwright/test').Page,
): Promise<void> {
  const csv = [
    'externalId,givenName,familyName,businessEmail,sequence,startDate,endDate',
    `${LEAVER_EXTERNAL_ID},Lee,Aver,lee${STAMP}@acme.test,1,2024-01-01,2025-01-31`,
  ].join('\n');
  const res = await page.request.post('/api/admin/persons/import', { data: { csv } });
  expect(res.status(), `end the contract: ${await res.text()}`).toBeLessThan(300);
  expect((await res.json()).errors, 'the import reported errors').toEqual([]);
}

/**
 * Jo grants the leaver the group she manages, through the PORTAL API under her
 * own session.
 *
 * Done here rather than in a test so the sweep has something to sweep whatever
 * order the tests run in, and done as Jo rather than as an administrator
 * because there is no admin endpoint that writes an `AccessGrant` directly —
 * grants come from an approved request, and a delegated act is one.
 */
async function grantLeaverAccess(browser: import('@playwright/test').Browser): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, 'jdoe', USER!);
    const res = await page.request.post(
      `/api/portal/automate/managed-resources/group/${fixture.wardGroupId}/grant`,
      {
        data: {
          subjectPersonIds: [fixture.leaverPersonId],
          justification: 'covering nights',
          durationDays: null,
        },
      },
    );
    expect(res.status(), `grant to the leaver: ${await res.text()}`).toBeLessThan(300);
  } finally {
    await context.close();
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
  // ORDER MATTERS, and it is the whole shape of the sweep fixture: employed,
  // then granted, then gone. Reversed, the grant is refused for being outside
  // the audience and the sweep has nothing to propose.
  await grantLeaverAccess(browser);

  const closing = await browser.newContext();
  const closingPage = await closing.newPage();
  try {
    await signIn(closingPage, 'admin', ADMIN!);
    await elevateTo(closingPage, '/admin/persons');
    await endTheLeaverContract(closingPage);
  } finally {
    await closing.close();
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
 * The two that were `fixme`, and what unblocked each.
 *
 * **The team lead** was blocked on a portal login that could not be created:
 * `POST /users` makes an account with no password and no admin endpoint sets
 * one, so only the two accounts the seed gives a password to can reach the
 * portal. The answer was not a new endpoint — it was to stop needing one. A
 * team lead is a PERSON holding a `ResourceDelegation`, and Jo Doe is already
 * a person with a password, so the fixture delegates a group to her. That is
 * also the truer shape: a delegate is a colleague, not a second administrator.
 *
 * **The blocked sweep** was thought to need "grants near expiry" — a fixture
 * made of time. It does not. The guard is PROPORTIONAL: one lapse out of a
 * handful of grants is far past the 10% default, so one leaver is enough, and
 * the verdict is confirmable rather than flatly blocked. Leaning on the
 * proportion rather than on "the first sweep in this tenant" is also what
 * keeps this idempotent: the first-sweep reason stops applying the moment
 * this test applies one, and the proportional reason does not.
 *
 * Three things about the leaver were assumptions until they were measured
 * against a running stack, and all three were wrong:
 *
 *   - a person with no live contract CANNOT be granted anything, even against
 *     an `{ all: [] }` audience — an empty AND is still asked whether this
 *     person is anybody, and the refusal is `outside-audience`;
 *   - fulfilment refuses a person with no Syntra account, so the request ends
 *     `fulfilment_failed` with no grant for the sweep to find;
 *   - no endpoint ends a contract. The CSV import does, by updating one in
 *     place on `(person, sequence)`, which is how a real deployment records a
 *     leaver anyway.
 *
 * Hence: employed, granted, then gone.
 */
test('a team lead adds a member from the portal with no administrative session', async ({
  page,
}) => {
  await signIn(page, 'jdoe', USER!);
  await page.goto('/managed');
  await expect(page.getByText(/resources you manage/i)).toBeVisible();
  await expect(page.getByText(fixture.wardGroupId)).toBeVisible();

  await page.getByLabel(/add somebody/i).fill(fixture.approverPersonId);
  await page.getByRole('button', { name: 'Add' }).click();

  // The grant landed and the list re-read it.
  await expect(page.getByText(fixture.approverPersonId)).toBeVisible();

  // AND TAKE IT BACK AGAIN. Two reasons, and the second is the one that bit.
  //
  // It exercises `revoke`, the other half of what this delegation grants. And
  // it leaves the tenant as it found it: every spec here shares one database,
  // and the Govern campaign is scoped to every Syntra group holding in it — so
  // a membership left behind by this test turns up in somebody else's review
  // queue, two spec files later, as a failure that says nothing about either.
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.getByText(fixture.approverPersonId)).toHaveCount(0);

  // No elevation prompt appeared anywhere in this test. That is the assertion:
  // this surface works under an ordinary portal session, which is the whole
  // point of delegating a resource to somebody who is not an administrator.
  await expect(page.getByRole('heading', { name: /confirm your password/i })).toHaveCount(0);
});

test('a blocked sweep is reviewed and confirmed', async ({ page }) => {
  await signIn(page, 'admin', ADMIN!);
  await elevateTo(page, '/admin/automate/sweeps');
  await page.getByRole('button', { name: /run a preview now/i }).click();

  // Scoped to the LIST, not `getByRole('link').first()` — which picks up the
  // console's own navigation and walks off to another page entirely, then
  // fails on an assertion about a sweep it never opened.
  const list = page.getByRole('list').filter({ hasText: /lapsing/ }).first();
  await expect(list).toBeVisible();
  await list.getByRole('link').first().click();

  // The sweep proposes something and refuses to apply it unattended: one
  // lapse out of a handful of grants is far past the 10% default.
  await expect(page.getByText(/this sweep stopped/i)).toBeVisible();
  await expect(page.getByText(/threshold 10%/)).toBeVisible();

  await page.getByRole('button', { name: /apply the ticked rows/i }).click();
  await expect(page.getByText(/applied/i).first()).toBeVisible();
});
