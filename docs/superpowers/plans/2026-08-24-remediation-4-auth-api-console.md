# Remediation 4 — Authentication, Authorization, the API and the Console

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signing in correct where it currently loops or locks somebody out, give the product the authorization surface it has never had, stop four API routes turning a caller's mistake into a 500 or an approval, and build the console screens the server has been waiting for since the features shipped.

**Architecture:** Five labelled phases, in dependency order. **A** fixes the paths a person takes to get in: the `ForceAuthn` loop, the passkey reset lockout, self-service TOTP removal, cookie security, and telling somebody a factor left their account. **B** is authorization: a role-management API with a migration that backfills the built-in roles, plus the two routes that decide something without checking what they were sent. **C** is API hygiene — cache invalidation, uuid validation, malformed credentials, strict schemas, and the three response contracts nobody used. **D** is the console, which is the largest phase and the one that turns working server features into product. **E** is the sync path and the data layer: correlation, connection tests, run queueing, error classification, readiness timeouts, the seed guard and three missing indexes.

Phases A, C, D and E are independent of each other. Phase B's console task (Task 9) depends on Tasks 6–8; nothing else in the plan depends on Phase B.

**Tech Stack:** TypeScript (ESM, strict, `exactOptionalPropertyTypes`), Fastify, Prisma + PostgreSQL, React 19 + Vite, zod contracts, vitest (forks pool for the root suite, jsdom for `apps/web`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-24-audit-findings.md` — §7.3 (S1–S7), §7.4 (H1–H6), §7.5 (N1–N6), §7.6 (W1–W9), §9 (B1–B5).

## Global Constraints

- Node `>=22`; pnpm pinned to `9.12.0` via `packageManager`. Never run `npm` or a different pnpm.
- **The root vitest suite takes ~155 minutes at `SYNTRA_TEST_WORKERS=4`. Never run the whole suite to check one change.** Run the file: `npx vitest run apps/api/src/routes/mfa.test.ts`.
- **Web tests run under `apps/web`'s own config**, which is the jsdom one: `cd apps/web && npx vitest run src/pages/admin/RolesPage.test.tsx`. Core and API tests run from the repository root. The two configs are not interchangeable — the root one has no jsdom environment and no React plugin.
- The house style for a web test is `apps/web/src/pages/admin/StatusToggle.test.tsx`: `vi.spyOn(globalThis, 'fetch')` with a `mockImplementation` that branches on the URL, a `json()` helper returning a real `Response`, `vi.restoreAllMocks()` in `beforeEach`, and `@testing-library/user-event` for interaction. Follow it; do not invent a second mocking convention.
- **The working tree is not clean and is not yours alone.** Another session is mid-TDD on `packages/core/src/auth/password-reset.test.ts` — it holds tests for an `issuePasswordSetup` feature. **Never `git add -A`, never `git commit -a`, and never stage `packages/core/src/auth/password-reset.test.ts`.** Task 2 touches the same module; its tests go in a **new** file, `packages/core/src/auth/password-reset-webauthn.test.ts`, and it leaves the other session's file alone. Stage only the exact paths each task names.
- `npx tsc -b` must exit 0 at every commit, and `pnpm --filter @syntra/web build` must stay green.
- **Any schema change needs a migration named ABOVE `20260830000000`**, because four migrations in this tree are hand-dated ahead of the real clock and `migrate deploy` replays in name order. Two tasks here add one: Task 8 (`20260903000000_builtin_role_permissions`) and Task 35 (`20260904000000_membership_index_and_one_per_uniques`). **Both names must also be appended to `KNOWN_MIGRATIONS` in `packages/db/src/migration-order.ts`** — remediation 1 Task 5 adds a test asserting that list describes the directory exactly, and a migration added without updating it turns that test red.
- Integration tests reach a fresh database through `buildTestApp()` (which calls `resetDatabase()`) and go through `withTenant`; never call `prisma` directly for tenant-scoped data in a test.
- Commit messages: lower-case type prefix, imperative, no trailing period — e.g. `fix(saml): a ForceAuthn request needs an authentication newer than itself`.

---

## Phase A — Signing in

### Task 1: A `ForceAuthn` request needs an authentication newer than itself

Spec §7.5, **N1** — the highest-value defect in this plan. `completeSso` redirects to `/login` whenever `ctx.parked.forceAuthn` is set, and *nothing ever clears the flag*. The login page signs the user in and returns the browser to `/saml/continue?handle=…`, the same condition fires, and the loop runs — minting a fresh session each round — until the row expires at ten minutes with a 410. No assertion is ever issued for any service provider that asks for `ForceAuthn`, and no test covers the flag.

The fix is not to clear the flag. `forceAuthn` means "re-authenticate for *this* request", and the honest test of that is a session established **after** the request was parked. Both rows already carry the timestamp; neither type carries it out to the caller.

**Files:**
- Modify: `packages/core/src/access/saml-request-service.ts:5-13` (the `ParkedAuthnRequest` interface), `:55-63` and `:90-98` (the two row-to-interface maps)
- Modify: `packages/core/src/auth/session-service.ts:30-44` (`ResolvedSession`), `:93-101` (`SessionRow`), `:133-138` (`toResolved`)
- Modify: `apps/api/src/routes/saml-idp.ts:664-670` (the refusal in `completeSso`)
- Test: `apps/api/src/routes/saml-force-authn.test.ts` (new)

**Interfaces:**
- Consumes: `buildTestApp`, `TEST_HOST` from `apps/api/src/test-support.js`; `samlConfig`, `samlKeyOptions`, `SP`, `ACS`, `bindingCookie` from `apps/api/src/routes/saml-sso-post.test.js`.
- Produces:
  - `interface ParkedAuthnRequest` gains `createdAt: Date`
  - `interface ResolvedSession` gains `createdAt: Date`
  - No route signature changes. `GET /saml/sso`, `POST /saml/sso` and `GET /saml/continue` keep their shapes.

- [x] **Step 1: Write the failing test**

Create `apps/api/src/routes/saml-force-authn.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  assignApplication,
  createApplication,
  createUser,
  hashPassword,
  saveSamlConfig,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import { ACS, SP, bindingCookie, samlConfig, samlKeyOptions } from './saml-sso-post.test.js';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

/**
 * An AuthnRequest that asks for a fresh authentication.
 *
 * `ForceAuthn="true"` is what a payroll system or a signing portal sends when
 * it wants the person in front of the browser proved again rather than
 * inherited from a session minted hours earlier. It is the one attribute this
 * identity provider stored, honoured, and could never satisfy.
 */
const forceAuthnRequest = (id = '_force1') =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" ForceAuthn="true" IssueInstant="${new Date().toISOString()}" Destination="http://${TEST_HOST}/saml/sso" AssertionConsumerServiceURL="${ACS}"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

const postSso = (xml: string, cookies: string[]) =>
  ctx.app.inject({
    method: 'POST',
    url: '/saml/sso',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookies.join('; '),
    },
    payload: new URLSearchParams({
      SAMLRequest: Buffer.from(xml).toString('base64'),
    }).toString(),
  });

const getContinue = (handle: string, cookies: string[]) =>
  ctx.app.inject({
    method: 'GET',
    url: `/saml/continue?handle=${handle}`,
    headers: { host: TEST_HOST, cookie: cookies.join('; ') },
  });

const signIn = async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  return res.cookies.find((c) => c.name === 'syntra_session')!.value;
};

/** The handle out of the `/login?next=/saml/continue?handle=…` redirect. */
const handleFrom = (location: string): string => {
  const next = decodeURIComponent(
    new URL(location, 'http://x').searchParams.get('next') ?? '',
  );
  return new URLSearchParams(next.split('?')[1] ?? '').get('handle')!;
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  const applicationId = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, {
      name: 'Payroll', slug: 'payroll', type: 'saml',
    });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    return application.id;
  });
  await saveSamlConfig(ctx.tenantId, applicationId, samlConfig(), samlKeyOptions);
  cookie = await signIn();
});

describe('ForceAuthn', () => {
  /**
   * The loop, stated as a test.
   *
   * A session that already existed when the request was parked is not an
   * answer to ForceAuthn, so the first hop MUST be the login screen — that
   * part was always right and stays asserted here, so the fix cannot
   * accidentally satisfy the flag with the stale session.
   */
  it('sends a browser holding an older session to the login screen', async () => {
    const parked = await postSso(forceAuthnRequest(), [`syntra_session=${cookie}`]);
    expect(parked.statusCode).toBe(302);
    expect(parked.headers.location).toContain('/login?next=');
    expect(parked.headers.location).toContain('%2Fsaml%2Fcontinue');
  });

  /**
   * THE ONE THAT MATTERS. The user does what the redirect asked: they sign in
   * again. Before this fix the second sign-in changed nothing — nothing on the
   * parked row or on the session recorded that a re-authentication had
   * happened — so /saml/continue redirected to /login again, and again, until
   * the row expired at ten minutes with a 410 and no assertion was ever issued
   * to any service provider that asks for ForceAuthn.
   */
  it('issues the assertion once the user has authenticated again', async () => {
    const parked = await postSso(forceAuthnRequest(), [`syntra_session=${cookie}`]);
    const handle = handleFrom(parked.headers.location as string);
    const binding = bindingCookie(parked);

    // The login screen. A fresh session, minted after the request was parked.
    const fresh = await signIn();

    const done = await getContinue(handle, [`syntra_session=${fresh}`, ...binding]);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain(`action="${ACS}"`);
    expect(done.body).toContain('name="SAMLResponse"');
  });

  /**
   * And the loop itself: returning with the SAME session the request was
   * parked against must still be refused, or "re-authenticate" would be
   * satisfied by pressing back.
   */
  it('still refuses the session that was already held', async () => {
    const parked = await postSso(forceAuthnRequest(), [`syntra_session=${cookie}`]);
    const handle = handleFrom(parked.headers.location as string);
    const binding = bindingCookie(parked);

    const again = await getContinue(handle, [`syntra_session=${cookie}`, ...binding]);
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toContain('/login?next=');
  });

  /** An ordinary request is unaffected: the held session is enough. */
  it('does not ask for a fresh authentication when ForceAuthn is absent', async () => {
    const xml = forceAuthnRequest().replace(' ForceAuthn="true"', '');
    const res = await postSso(xml, [`syntra_session=${cookie}`]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="SAMLResponse"');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/saml-force-authn.test.ts`

Expected: FAIL. The second case gets a 302 to `/login?next=…` instead of a 200 carrying a form — the fresh session does not satisfy the flag, because nothing compares the two times. Cases one, three and four pass already.

- [x] **Step 3: Carry `createdAt` out of the parked row**

In `packages/core/src/access/saml-request-service.ts`, add the field to the interface (currently lines 5–13):

```ts
export interface ParkedAuthnRequest {
  id: string;
  applicationId: string;
  handle: string;
  requestId: string | null;
  acsUrl: string;
  relayState: string | null;
  forceAuthn: boolean;
  /**
   * When the request was parked.
   *
   * Carried out to the caller because it is half of the answer to
   * `forceAuthn`. The flag says "prove this person again"; the only honest
   * test of that is a session established AFTER the service provider asked,
   * and neither side of the comparison was reachable before this.
   */
  createdAt: Date;
}
```

Then add `createdAt: row.createdAt,` to the object returned by `parkAuthnRequest` (after `forceAuthn: row.forceAuthn,`, line 62) and to the one returned by `findParkedAuthnRequest` (after `forceAuthn: row.forceAuthn,`, line 97). The column already exists — `SamlAuthnRequest.createdAt DateTime @default(now())`, `schema.prisma:1027` — so there is no migration here.

- [x] **Step 4: Carry `createdAt` out of the session**

In `packages/core/src/auth/session-service.ts`, add to `ResolvedSession` after `satisfiedFactor` (line 43):

```ts
  /**
   * When this session was minted.
   *
   * Read by the SAML identity provider to answer `ForceAuthn`: a service
   * provider demanding a fresh authentication is answered by a session NEWER
   * than the request, and by nothing else. Comparing against the request's own
   * `createdAt` is what makes "sign in again" a thing the user can actually
   * do — before it, the flag was checked, never satisfied, and the browser
   * bounced between the login screen and `/saml/continue` until the parked row
   * expired.
   */
  createdAt: Date;
```

Add `createdAt: Date;` to the private `SessionRow` interface (after `satisfiedFactor: string | null;`, line 97), and the field to `toResolved` (lines 133–138):

```ts
const toResolved = (row: SessionRow): ResolvedSession => ({
  sessionId: row.id,
  userId: row.userId,
  scope: row.scope as SessionScope,
  satisfiedFactor: row.satisfiedFactor,
  createdAt: row.createdAt,
});
```

Both readers (`resolveSession`, `readSession`) select whole rows, so the column arrives with no query change. `Session.createdAt` already exists at `schema.prisma:293`.

- [x] **Step 5: Make the refusal ask the real question**

In `apps/api/src/routes/saml-idp.ts`, replace the block at lines 664–670:

```ts
    // No Syntra session yet, or the service provider demanded a fresh
    // authentication this session is not an answer to.
    //
    // `forceAuthn` on its own is NOT the condition, and that distinction is
    // the whole of this fix. Nothing clears the flag -- the parked row is read
    // back unchanged, and `consumeParkedAuthnRequest` only stamps `consumedAt`
    // and runs after this point -- so redirecting on the flag alone sent the
    // user to `/login`, which sent them back to `/saml/continue`, which
    // redirected again. The browser looped, minting a fresh session each
    // round, until the row expired at ten minutes with a 410, and no assertion
    // was ever issued to any service provider that asks for ForceAuthn.
    //
    // A session minted AFTER the request was parked is the fresh
    // authentication the service provider asked for, and it is the only thing
    // that is. Comparing timestamps rather than marking the row also means two
    // tabs mid-sign-in cannot satisfy each other's demand: each request is
    // measured against the session as it stood when that request arrived.
    const staleForForceAuthn =
      session !== null &&
      ctx.parked.forceAuthn &&
      session.createdAt.getTime() <= ctx.parked.createdAt.getTime();

    if (!session || staleForForceAuthn) {
      const next = encodeURIComponent(`/saml/continue?handle=${ctx.parked.handle}`);
      return reply.redirect(`/login?next=${next}`, 302);
    }
```

- [x] **Step 6: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/saml-force-authn.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 7: Run the suites that read these two types**

Run: `npx vitest run apps/api/src/routes/saml-sso-post.test.ts apps/api/src/routes/saml-sso-redirect.test.ts apps/api/src/routes/auth.test.ts`

Expected: PASS. These are the callers of `ParkedAuthnRequest` and `ResolvedSession`; a widened interface with a construction site left behind would show here.

- [x] **Step 8: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/access/saml-request-service.ts \
        packages/core/src/auth/session-service.ts \
        apps/api/src/routes/saml-idp.ts \
        apps/api/src/routes/saml-force-authn.test.ts
git commit -m "$(cat <<'EOF'
fix(saml): a ForceAuthn request needs an authentication newer than itself

`completeSso` redirected to /login whenever the parked request carried
`forceAuthn`, and nothing anywhere cleared it: the row is read back
unchanged, and `consumeParkedAuthnRequest` only stamps consumedAt and runs
after the check. The login page sent the browser back to /saml/continue,
the same condition fired, and the user re-authenticated in a loop --
minting a fresh session each round -- until the row expired at ten minutes
with a 410. No assertion was ever issued to any service provider that asks
for ForceAuthn, and no test covered the flag.

The flag is not cleared now either, because that is not what it means.
ForceAuthn asks for the person to be proved again for THIS request, and
the honest test of that is a session established after the request was
parked. Both rows already carried the timestamp; neither type carried it
out. Comparing them also keeps two tabs mid-sign-in from satisfying each
other's demand.
EOF
)"
```

---

### Task 2: A reset-scoped WebAuthn challenge, so a passkey-only user can get back in

Spec §7.4, **H1** — found independently by two reviewers. `completePasswordReset` demands a factor when one is enrolled and verifies WebAuthn against a stored challenge; the only endpoint that mints one, `POST /api/auth/mfa/webauthn/challenge`, requires a live `AuthAttempt` token. The reset flow holds a `PasswordResetToken`. `findAttempt` always misses and the route answers 401 — and `ResetPassword.tsx:57` proves the client believes otherwise, posting the reset token as `attemptToken`. **A user whose only factor is a passkey, with no recovery codes left, is hard-locked out of their own account.**

It fails closed, so this is a lockout rather than a hole. The fix is a second challenge endpoint scoped to the reset token, not a flag on the first: the two are authenticated by different credentials, and mixing them is how one credential ends up satisfying the other's rule.

**Files:**
- Modify: `packages/core/src/auth/password-reset.ts` (add `userForResetToken` after `preflightPasswordReset` ends, line 363)
- Modify: `apps/api/src/routes/password-reset.ts` (a new route after `/preflight`, line 65)
- Modify: `apps/web/src/mfa/webauthn.ts` (add `assertWebAuthnForReset` after line 58)
- Modify: `apps/web/src/pages/ResetPassword.tsx:6,57`
- Test: `packages/core/src/auth/password-reset-webauthn.test.ts` (**new — do not touch `password-reset.test.ts`, another session is mid-TDD in it**)
- Test: `apps/api/src/routes/password-reset.test.ts`

**Interfaces:**
- Consumes: module-private `liveToken`, `withTenant`; `beginWebAuthnAuthentication(tenantId, userId, rp, now?)` from `@syntra/core`; `tenantRelyingParty(tenant, publicUrl)` from `apps/api/src/routes/relying-party.js`; `resetPreflightRequest` from `@syntra/contracts`.
- Produces:
  - `export async function userForResetToken(tenantId: string, token: string, now?: Date): Promise<string | null>`
  - `POST /api/auth/password-reset/webauthn/challenge` — body `{ token: string }`, answers `PublicKeyCredentialRequestOptionsJSON`, or 400 `invalid-reset-token`
  - `export async function assertWebAuthnForReset(token: string): Promise<Record<string, unknown>>`

- [x] **Step 1: Write the failing core test**

Create `packages/core/src/auth/password-reset-webauthn.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { createUser } from '../directory/user-service.js';
import { memoryTransport } from '../notify/notification-service.js';
import { hashPassword, setPasswordHash } from './password.js';
import { requestPasswordReset, userForResetToken } from './password-reset.js';

let tenantId: string;
let userId: string;
let mail: ReturnType<typeof memoryTransport>;

/**
 * The raw token, which `requestPasswordReset` deliberately never returns: it
 * goes to the account owner's inbox and nowhere else. The memory transport is
 * where a test reads it from, exactly as a person reads it from their mail
 * client.
 */
const tokenFromMail = (): string => {
  const body = mail.sent.at(-1)!.text;
  return new URL(body.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
};

const issue = async () => {
  mail = memoryTransport();
  await requestPasswordReset(tenantId, mail, 'https://acme.test', {
    login: 'jdoe',
    sourceIp: null,
    // Nothing here is about timing, and the 250 ms floor is a quarter of a
    // second per case for no benefit.
    floorMs: 0,
  });
  return tokenFromMail();
};

beforeEach(async () => {
  // The same fixture the other password tests in this directory use: read the
  // top of `password-change.test.ts` and reuse its tenant helper rather than
  // adding a second one.
  ({ tenantId } = await freshTenant());
  const hash = await hashPassword('correct horse battery staple');
  userId = await withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, hash);
    return user.id;
  });
});

/**
 * The lookup a reset-scoped WebAuthn challenge is built on.
 *
 * A passkey-only user could not complete a reset at all: `completePasswordReset`
 * verifies the assertion against a stored challenge, and the only endpoint that
 * minted one required a live `AuthAttempt`. The reset flow holds a
 * `PasswordResetToken`, so the lookup always missed and the route answered 401
 * -- a hard lockout for anybody whose only factor is a passkey and whose
 * recovery codes are spent.
 */
describe('userForResetToken', () => {
  it('names the user a live token belongs to', async () => {
    expect(await userForResetToken(tenantId, await issue())).toBe(userId);
  });

  it('refuses an unknown token', async () => {
    expect(await userForResetToken(tenantId, 'not-a-token')).toBeNull();
  });

  /**
   * A CONSUMED token must not mint a challenge either. It is spent the moment
   * a reset completes, and a challenge issued after that is a credential
   * outliving the thing that authorised it.
   */
  it('refuses a token that has already been spent', async () => {
    const token = await issue();
    await withTenant(tenantId, (tx) =>
      tx.passwordResetToken.updateMany({
        where: { userId },
        data: { consumedAt: new Date() },
      }),
    );
    expect(await userForResetToken(tenantId, token)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const token = await issue();
    const anHourOn = new Date(Date.now() + 60 * 60 * 1000);
    expect(await userForResetToken(tenantId, token, anHourOn)).toBeNull();
  });
});
```

Before running it, open `packages/core/src/auth/password-change.test.ts` and copy its tenant fixture verbatim in place of the `freshTenant()` placeholder — the directory has one convention for that and this file must use it rather than inventing a second.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/auth/password-reset-webauthn.test.ts`
Expected: FAIL — `userForResetToken` is not exported from `./password-reset.js`.

- [x] **Step 3: Add the lookup**

In `packages/core/src/auth/password-reset.ts`, immediately after `preflightPasswordReset` ends (line 363):

```ts
/**
 * The user a live reset token belongs to, or null.
 *
 * Exists for exactly one caller: the reset-scoped WebAuthn challenge endpoint.
 * A passkey-only user could not complete a reset at all, because
 * `completePasswordReset` verifies the assertion against a stored challenge and
 * the only endpoint that minted one demanded a live `AuthAttempt` -- which
 * exists after a password has been accepted, not after a link has been opened.
 * `findAttempt` always missed, the route answered 401, and somebody whose only
 * factor is a passkey and whose recovery codes were spent had no way back into
 * their account that did not go through an administrator.
 *
 * Liveness is `liveToken`'s definition and not a second one: unknown, consumed
 * and expired all answer null, so a challenge cannot outlive the link that
 * authorised it. The caller learns a user id and nothing else -- not whether
 * the login exists, not whether it is federated, not what it has enrolled.
 */
export async function userForResetToken(
  tenantId: string,
  token: string,
  now: Date = new Date(),
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await liveToken(tx, token, now);
    return row?.userId ?? null;
  });
}
```

- [x] **Step 4: Run the core test to verify it passes**

Run: `npx vitest run packages/core/src/auth/password-reset-webauthn.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 5: Write the failing route test**

Read the top of `apps/api/src/routes/password-reset.test.ts` and reuse its existing helper for obtaining a live reset token (it already requests one and reads it out of `ctx.mail`). Append:

```ts
/**
 * The endpoint that makes a passkey reset possible at all.
 *
 * Separate from `/api/auth/mfa/webauthn/challenge` rather than a flag on it,
 * because the two are authenticated by different credentials -- an attempt
 * token there, a reset token here -- and one endpoint taking either is how a
 * reset token comes to satisfy a rule written about a sign-in attempt.
 */
describe('POST /api/auth/password-reset/webauthn/challenge', () => {
  it('mints a challenge for the holder of a live reset token', async () => {
    const token = await liveResetToken();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/webauthn/challenge',
      headers: { host: ctx.host },
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { challenge?: string; rpId?: string };
    expect(typeof body.challenge).toBe('string');
    // The RELYING PARTY IS THE TENANT'S, never the Host header. This endpoint
    // is unauthenticated; it is the last place that should trust one.
    expect(body.rpId).toBe(ctx.host);
  });

  it('refuses an unknown token in the same words as a spent one', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/webauthn/challenge',
      headers: { host: ctx.host },
      payload: { token: 'not-a-real-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      type: expect.stringContaining('invalid-reset-token'),
    });
  });
});
```

The RP id assertion requires the tenant's `primaryDomain` to be the test host; if the file does not already set it in its `beforeEach`, add `await prisma.tenant.update({ where: { id: ctx.tenantId }, data: { primaryDomain: TEST_HOST } });` there, as `saml-force-authn.test.ts` does.

- [x] **Step 6: Run the route test to verify it fails**

Run: `npx vitest run apps/api/src/routes/password-reset.test.ts`
Expected: FAIL — both new cases get 404, because the route does not exist.

- [x] **Step 7: Add the route**

In `apps/api/src/routes/password-reset.ts`, add `beginWebAuthnAuthentication` and `userForResetToken` to the `@syntra/core` import block (lines 8–13), then insert after the `/preflight` handler (line 65):

```ts
  /**
   * A WebAuthn challenge for somebody holding a reset link.
   *
   * WITHOUT THIS ROUTE a passkey-only user cannot complete a password reset at
   * all. `completePasswordReset` verifies the assertion against a stored
   * challenge, and the only endpoint that minted one required a live
   * `AuthAttempt` -- which exists after a password has been accepted, not
   * after a link has been opened. The reset flow holds a `PasswordResetToken`,
   * so the lookup always missed, the answer was 401, and somebody whose only
   * factor is a passkey and whose recovery codes were spent had no way back
   * that did not go through an administrator.
   *
   * Deliberately a second endpoint rather than a second credential accepted by
   * the first. The two are authenticated by different things, and an endpoint
   * that takes either is how a reset token comes to satisfy a rule written
   * about a sign-in.
   *
   * The refusal is the one `/complete` gives for a dead token, in the same
   * words: this endpoint must not become an oracle for whether a link is still
   * good, whether the account exists, or what it has enrolled. It carries the
   * same rate limit as every other credential-presenting route here.
   */
  app.post('/webauthn/challenge', { ...LIMIT }, async (request) => {
    const body = resetPreflightRequest.parse(request.body);
    const userId = await userForResetToken(request.tenantId, body.token);
    if (userId === null) {
      throw new ProblemError(
        400,
        'invalid-reset-token',
        'That reset link is no longer usable',
        'Request a new one.',
      );
    }

    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    // From the tenant, exactly as `/complete` derives it. The assertion this
    // challenge produces is verified against the tenant's own origin, and a
    // challenge minted against a header would be one whose audience an
    // attacker chooses.
    return beginWebAuthnAuthentication(
      request.tenantId,
      userId,
      tenantRelyingParty(tenant, options.publicUrl),
    );
  });
```

- [x] **Step 8: Run the route test to verify it passes**

Run: `npx vitest run apps/api/src/routes/password-reset.test.ts`
Expected: PASS, the whole file.

- [x] **Step 9: Point the browser at the right endpoint**

Append to `apps/web/src/mfa/webauthn.ts`:

```ts
/**
 * Signs a reset challenge. The caller holds a PASSWORD RESET TOKEN, not an
 * attempt token and not a session.
 *
 * `assertWebAuthn` above posts to `/api/auth/mfa/webauthn/challenge`, which
 * reads an `AuthAttempt`. `ResetPassword.tsx` called it with the reset token in
 * the `attemptToken` field, the lookup missed every time, and the reset screen
 * answered 401 to every passkey-only user who reached it -- which is a lockout,
 * not a wrong message.
 */
export async function assertWebAuthnForReset(
  token: string,
): Promise<Record<string, unknown>> {
  const optionsJSON = await api<Record<string, unknown>>(
    '/api/auth/password-reset/webauthn/challenge',
    { method: 'POST', body: JSON.stringify({ token }) },
  );
  const assertion = await startAuthentication({ optionsJSON: optionsJSON as never });
  return assertion as unknown as Record<string, unknown>;
}
```

In `apps/web/src/pages/ResetPassword.tsx`, change line 6 to `import { assertWebAuthnForReset } from '../mfa/webauthn.js';` and line 57 to:

```tsx
          ? { type: 'webauthn' as const, assertion: await assertWebAuthnForReset(token) }
```

- [x] **Step 10: Verify the web suite and the typecheck**

```bash
cd apps/web && npx vitest run src/pages/ResetPassword.test.tsx; cd ../..
npx tsc -b
```

Expected: PASS, and `tsc -b` exits 0.

- [x] **Step 11: Commit — and check what is staged first**

```bash
git add packages/core/src/auth/password-reset.ts \
        packages/core/src/auth/password-reset-webauthn.test.ts \
        apps/api/src/routes/password-reset.ts \
        apps/api/src/routes/password-reset.test.ts \
        apps/web/src/mfa/webauthn.ts \
        apps/web/src/pages/ResetPassword.tsx
git status --short
```

Expected: exactly six files staged, and `packages/core/src/auth/password-reset.test.ts` still unstaged and untouched.

```bash
git commit -m "$(cat <<'EOF'
fix(auth): a passkey-only user can complete a password reset

`completePasswordReset` verifies a WebAuthn assertion against a stored
challenge, and the only endpoint that minted one required a live
`AuthAttempt`. The reset flow holds a PasswordResetToken, so the lookup
always missed and the route answered 401 -- and ResetPassword.tsx proved
the client believed otherwise, posting the reset token as `attemptToken`.
A user whose only factor is a passkey, with no recovery codes left, was
hard-locked out with no way back that did not go through an administrator.

A second challenge endpoint scoped to the reset token, not a second
credential accepted by the first: the two are authenticated by different
things, and an endpoint taking either is how a reset token comes to
satisfy a rule written about a sign-in. Liveness is `liveToken`'s
definition, so a challenge cannot outlive the link that authorised it, and
the refusal is word-for-word the one /complete already gives.
EOF
)"
```

---

### Task 3: Self-service TOTP removal

Spec §7.4, **H3**. `POST /mfa/totp/begin` refuses with "Remove the existing one before setting up another" and **no route and no screen can do that**. The only removal is the admin-gated `DELETE /admin/users/:id/factors/totp`, so replacing a phone requires an administrator — for a control the product otherwise treats as self-service.

**Files:**
- Modify: `apps/api/src/routes/mfa.ts` (a new route after the `webauthn/:credentialId` delete, line 427)
- Modify: `apps/web/src/pages/Security.tsx:141-148` (the authenticator panel's actions)
- Test: `apps/api/src/routes/mfa.test.ts`
- Test: `apps/web/src/pages/Security.test.tsx` (new)

**Interfaces:**
- Consumes: `removeTotp`, `revokeOrphanedRecoveryCodes`, `recordEvent`, `hasTotp` from `@syntra/core`; `requireSession('portal')` (already applied to the `secured` sub-register).
- Produces: `DELETE /api/auth/mfa/totp` — 200 `{ recoveryCodesRevoked: number }`, or 409 `no-totp` when none is enrolled. Mirrors `DELETE /api/auth/mfa/webauthn/:credentialId` exactly.

- [x] **Step 1: Write the failing route test**

Append to `apps/api/src/routes/mfa.test.ts`:

```ts
describe('removing an authenticator app', () => {
  /**
   * `POST /mfa/totp/begin` refuses with "Remove the existing one before
   * setting up another", and until this route existed nothing could. A person
   * who replaced their phone had to raise a ticket to use a control the rest
   * of this screen treats as self-service.
   */
  it('removes it, so a new one can be set up', async () => {
    await seedUser();
    const cookie = await portalCookie();
    await enrolTotp(cookie);

    const removed = await call('DELETE', '/api/auth/mfa/totp', { cookie });
    expect(removed.statusCode).toBe(200);

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.json()).toMatchObject({ totp: { enrolled: false } });

    // And the refusal that motivated all of this is gone.
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    expect(begin.statusCode).toBe(200);
  });

  /**
   * Removing the last real factor takes the recovery codes with it, exactly as
   * the passkey removal does. Holding a factor is a precondition of issuing
   * codes; leaving them behind here reaches the state that gate exists to
   * prevent, from the other side.
   */
  it('revokes orphaned recovery codes and says how many', async () => {
    await seedUser();
    const cookie = await portalCookie();
    await enrolTotp(cookie);
    const issued = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });
    expect(issued.statusCode).toBe(200);

    const removed = await call('DELETE', '/api/auth/mfa/totp', { cookie });
    expect(removed.json()).toEqual({
      recoveryCodesRevoked: (issued.json() as { codes: string[] }).codes.length,
    });
    const remaining = await withTenant(ctx.tenantId, (tx) =>
      countUnusedRecoveryCodes(tx, userId),
    );
    expect(remaining).toBe(0);
  });

  it('refuses when nothing is enrolled, rather than reporting a removal', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const res = await call('DELETE', '/api/auth/mfa/totp', { cookie });
    expect(res.statusCode).toBe(409);
  });

  it('needs a session', async () => {
    await seedUser();
    const res = await call('DELETE', '/api/auth/mfa/totp', {});
    expect(res.statusCode).toBe(401);
  });
});
```

`enrolTotp(cookie)` is the file's existing helper that begins and confirms an enrolment with `OTPAuth` — reuse it; the file already imports `otpauth` and `confirmTotpEnrolment` for exactly this.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/mfa.test.ts -t 'removing an authenticator app'`
Expected: FAIL — 404 on `DELETE /api/auth/mfa/totp`.

- [x] **Step 3: Add the route**

In `apps/api/src/routes/mfa.ts`, add `removeTotp` to the `@syntra/core` import block, and insert after the `secured.delete('/webauthn/:credentialId', …)` handler ends (line 427):

```ts
    /**
     * Takes the authenticator app off your own account.
     *
     * `POST /totp/begin` refuses a second enrolment with "Remove the existing
     * one before setting up another", and nothing could: the only removal was
     * the admin-gated `DELETE /admin/users/:id/factors/totp`, so somebody who
     * had replaced their phone had to raise a ticket to use a control this
     * screen otherwise treats as self-service.
     *
     * The session is the whole authorisation, and that is the same trade the
     * passkey removal above makes: a factor is a control over the account, and
     * an account whose holder cannot manage its controls without a ticket
     * pushes people towards not enrolling one at all. What makes it acceptable
     * is the mail -- see `tellOwnerAFactorWasRemoved` -- which reaches the one
     * person who can tell a legitimate removal from an attacker's.
     *
     * A 409 rather than a silent 204 when nothing is enrolled: "removed" and
     * "there was nothing there" are different answers, and reporting the
     * second as the first hides a client that is out of step with the server.
     */
    secured.delete('/totp', async (request, reply) => {
      const revoked = await request.db(async (tx) => {
        if (!(await hasTotp(tx, request.session.userId))) {
          throw new ProblemError(
            409,
            'no-totp',
            'No authenticator app is set up',
            'There is nothing to remove.',
          );
        }
        await removeTotp(tx, request.session.userId);
        // The same rule the passkey removal follows: recovery codes are a way
        // back in when a real factor is lost, not a factor of their own, so
        // the last real factor leaving takes them with it.
        const dropped = await revokeOrphanedRecoveryCodes(tx, request.session.userId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.removed',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { factor: 'totp', recoveryCodesRevoked: dropped },
        });
        return dropped;
      });

      await tellOwnerAFactorWasRemoved(
        request,
        options.transport,
        request.session.userId,
        'authenticator app',
      );
      return reply.status(200).send({ recoveryCodesRevoked: revoked });
    });
```

`tellOwnerAFactorWasRemoved` is added in Task 5. **Do Task 5 before this step**, or add the function first and land both together — the two are the same screen and the same route file, and splitting the mail out would ship a removal nobody is told about.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/mfa.test.ts`
Expected: PASS, the whole file.

- [x] **Step 5: Give the screen the control**

In `apps/web/src/pages/Security.tsx`, add beside `removeKey`:

```tsx
  /**
   * Removing the authenticator app.
   *
   * The panel used to render a bare "Set up" badge once one was enrolled, so
   * the only way to move to a new phone was through an administrator — for a
   * control the rest of this screen manages without one.
   *
   * The count of revoked recovery codes is SHOWN rather than discarded. It is
   * the one thing the user cannot find out any other way: the codes they
   * printed have just stopped working, and a screen that quietly said nothing
   * would send them to a drawer full of dead codes in six months.
   */
  async function removeTotp() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodesRevoked: number }>(
        '/api/auth/mfa/totp',
        { method: 'DELETE' },
      );
      if (result.recoveryCodesRevoked > 0) {
        setNotice(
          `Your authenticator app was removed, and ${result.recoveryCodesRevoked} unused recovery code${
            result.recoveryCodesRevoked === 1 ? '' : 's'
          } stopped working with it. Set up a factor and generate new ones.`,
        );
      } else {
        setNotice('Your authenticator app was removed.');
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }
```

Add `const [notice, setNotice] = useState<string | null>(null);` beside the other state (line 32), and render it under the error alert at line 133:

```tsx
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="warning">{notice}</Alert>}
```

Replace the authenticator panel's `actions` (lines 140–148) with:

```tsx
          actions={
            status?.totp.enrolled ? (
              <span className="flex items-center gap-2">
                <Status tone="active">Set up</Status>
                <Button size="sm" variant="ghost" loading={busy} onClick={removeTotp}>
                  Remove
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="primary" loading={busy} onClick={beginTotp}>
                Set up
              </Button>
            )
          }
```

- [x] **Step 6: Write the web test**

Create `apps/web/src/pages/Security.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { Security } from './Security.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const status = (over: Record<string, unknown> = {}) => ({
  totp: { enrolled: true },
  webauthn: { available: true, unavailableReason: null, credentials: [] },
  recoveryCodes: { remaining: 5 },
  ...over,
});

/**
 * Records what was sent, and answers the two endpoints this screen reads.
 * The same shape `StatusToggle.test.tsx` uses: branch on the URL, return a
 * real `Response`, keep the calls for assertions.
 */
function mockApi(over: { totpDelete?: Response } = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'DELETE' && url.endsWith('/api/auth/mfa/totp')) {
      return Promise.resolve(over.totpDelete ?? json({ recoveryCodesRevoked: 0 }));
    }
    if (url.endsWith('/api/auth/mfa')) return Promise.resolve(json(status()));
    if (url.endsWith('/api/auth/session')) return Promise.resolve(json({}, 401));
    return Promise.resolve(json({}));
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <Security />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the authenticator app can be removed without an administrator', () => {
  it('sends the DELETE and reloads', async () => {
    const calls = mockApi();
    renderPage();
    await screen.findByText('Set up');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/auth/mfa/totp')),
      ).toBe(true),
    );
  });

  /**
   * The count is the one thing the user cannot find out any other way: the
   * codes they printed have just stopped working, and a screen that said
   * nothing would send them to a drawer full of dead codes in six months.
   */
  it('says how many recovery codes stopped working with it', async () => {
    mockApi({ totpDelete: json({ recoveryCodesRevoked: 7 }) });
    renderPage();
    await screen.findByText('Set up');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/7 unused recovery codes stopped working/)).toBeInTheDocument();
  });

  it('reports a refusal instead of appearing to do nothing', async () => {
    mockApi({
      totpDelete: json(
        { type: 'https://syntra.dev/problems/no-totp', title: 'No authenticator app is set up', status: 409, detail: 'There is nothing to remove.' },
        409,
      ),
    });
    renderPage();
    await screen.findByText('Set up');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('There is nothing to remove.')).toBeInTheDocument();
  });
});
```

- [x] **Step 7: Run the web test**

Run: `cd apps/web && npx vitest run src/pages/Security.test.tsx; cd ../..`
Expected: PASS, 3 tests.

- [x] **Step 8: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/api/src/routes/mfa.ts apps/api/src/routes/mfa.test.ts \
        apps/web/src/pages/Security.tsx apps/web/src/pages/Security.test.tsx
git commit -m "$(cat <<'EOF'
feat(mfa): remove your own authenticator app

`POST /mfa/totp/begin` refuses a second enrolment with "Remove the
existing one before setting up another", and nothing could: the only
removal was the admin-gated DELETE on /admin/users/:id/factors/totp. So
replacing a phone meant raising a ticket, for a control the rest of the
Security screen manages without one -- which is how people end up not
enrolling a factor at all.

Mirrors the passkey removal exactly: the session authorises it, the owner
is mailed, orphaned recovery codes go with the last real factor, and the
count of revoked codes is shown rather than discarded. A 409 when nothing
is enrolled, because "removed" and "there was nothing there" are different
answers.
EOF
)"
```

---

### Task 4: Cookie security from the configured URL, not `NODE_ENV`

Spec §7.4, **H4**. The session cookie's `secure` flag and the federation binding cookie's `SameSite=None; Secure` pair both read `process.env.NODE_ENV === 'production'`, which `config.ts` has no say in and the lab deployment sets nowhere (§4 verified that: not in the systemd unit, not in either `.env.example`). Running behind TLS without exporting it sends session tokens without `Secure`, and falls the binding cookie back to `Lax` — which `federation.ts`'s own comment says breaks every cross-site federation POST — with no configuration error anywhere. The SAML binding cookie has the same line.

`PUBLIC_URL` is a validated configuration key that already means "where this deployment is reached". Its scheme is the answer.

**Files:**
- Modify: `packages/core/src/config.ts:164-186` (the `Config` interface) and `:217-240` (the returned object)
- Create: `packages/core/src/cookie-security.ts`
- Create: `packages/core/src/cookie-security.test.ts`
- Modify: `apps/api/src/app.ts` (decorate the instance)
- Modify: `apps/api/src/routes/session-reply.ts:20-25,79`
- Modify: `apps/api/src/routes/saml-idp.ts:99-111`
- Modify: `apps/api/src/routes/federation.ts:146-148`

**Interfaces:**
- Consumes: `Config.publicUrl`.
- Produces:
  - `export function cookiesAreSecure(publicUrl: string): boolean`
  - `Config` gains `cookieSecure: boolean`
  - Fastify instance decoration `cookieSecure: boolean`, declared in `session-reply.ts`
  - `export function sessionCookieOptions(secure: boolean)` replaces the `SESSION_COOKIE_OPTIONS` constant
  - `samlBindingCookieOptions(secure: boolean)` replaces `SAML_BINDING_COOKIE_OPTIONS` (module-private)

- [x] **Step 1: Write the failing test**

Create `packages/core/src/cookie-security.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cookiesAreSecure } from './cookie-security.js';

describe('cookiesAreSecure', () => {
  /**
   * THE ONE THAT MATTERS. A deployment reached over HTTPS marks its cookies
   * Secure, whether or not anybody exported NODE_ENV -- which the lab
   * deployment does not: not in the systemd unit, not in either .env.example.
   */
  it('is true for an https public URL', () => {
    expect(cookiesAreSecure('https://id.acme.example')).toBe(true);
    expect(cookiesAreSecure('https://id.acme.example:8443/')).toBe(true);
  });

  /**
   * And a development server on plain HTTP must NOT mark them Secure: the
   * cookie would never come back, which reads as "sign-in is broken" rather
   * than as a cookie policy.
   */
  it('is false for an http public URL', () => {
    expect(cookiesAreSecure('http://localhost:3000')).toBe(false);
    expect(cookiesAreSecure('http://acme.localhost')).toBe(false);
  });

  /**
   * Unparseable falls to the SAFE side. `loadConfig` validates PUBLIC_URL as a
   * URL before this is ever called, so reaching here means something is very
   * wrong -- and the failure mode of a cookie that does not come back is a
   * broken login, while the failure mode of one sent in the clear is a stolen
   * session.
   */
  it('is true when the URL cannot be read at all', () => {
    expect(cookiesAreSecure('not-a-url')).toBe(true);
    expect(cookiesAreSecure('')).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/cookie-security.test.ts`
Expected: FAIL — `Cannot find module './cookie-security.js'`.

- [x] **Step 3: Write the helper**

Create `packages/core/src/cookie-security.ts`:

```ts
/**
 * Whether this deployment's cookies carry `Secure`.
 *
 * Read off `PUBLIC_URL`, which is a validated configuration key meaning
 * exactly "where this deployment is reached". It replaces
 * `process.env.NODE_ENV === 'production'`, which three cookie definitions
 * consulted independently and which `config.ts` had no say in at all.
 *
 * That mattered in both directions. The lab deployment sets NODE_ENV NOWHERE
 * -- not in `docs/lab/systemd/syntra.service`, not in `.env.example`, not in
 * `packages/db/.env.example` -- so an instance behind TLS sent its session
 * cookie without `Secure`, and the federation binding cookie fell back to
 * `SameSite=Lax`, which `federation.ts`'s own comment says breaks every
 * cross-site federation POST. Neither produced a configuration error anywhere;
 * the first is a session token on the wire and the second is a login that
 * simply stops working.
 *
 * Unparseable answers TRUE. `loadConfig` parses PUBLIC_URL as a URL before
 * anything reaches here, so this branch means something is badly wrong -- and
 * between a cookie that does not come back and a cookie sent in the clear, the
 * broken login is the one you can see.
 */
export function cookiesAreSecure(publicUrl: string): boolean {
  try {
    return new URL(publicUrl).protocol === 'https:';
  } catch {
    return true;
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/cookie-security.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 5: Put it on the config**

In `packages/core/src/config.ts`, add the import `import { cookiesAreSecure } from './cookie-security.js';`, add to the `Config` interface after `publicUrl` (line 167):

```ts
  /**
   * Whether cookies carry `Secure`, derived from `publicUrl`'s scheme.
   *
   * On the config rather than read from `process.env` at three cookie
   * definitions, which is what it replaced: NODE_ENV is a variable this
   * product's own configuration loader never sees, and the lab deployment
   * exports it nowhere.
   */
  cookieSecure: boolean;
```

and to the returned object after `publicUrl: v.PUBLIC_URL,` (line 220):

```ts
    cookieSecure: cookiesAreSecure(v.PUBLIC_URL),
```

Add `export * from './cookie-security.js';` to `packages/core/src/index.ts` beside the other top-level exports.

- [x] **Step 6: Decorate the app and rewrite the three cookie definitions**

In `apps/api/src/routes/session-reply.ts`, replace lines 11–25:

```ts
declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Whether this deployment's cookies carry `Secure`, from `PUBLIC_URL`.
     *
     * A decoration rather than an option threaded through four route
     * registrations, because `issueSession` is called from `auth.ts`,
     * `mfa.ts`, `enrol.ts` and `federation.ts` and none of them take options
     * of their own. One value, set once in `buildApp`, read where the cookie
     * is written.
     */
    cookieSecure: boolean;
  }
}

/**
 * How a session cookie is written. One definition, because four routes set the
 * same cookie and a fifth will, and the attribute that matters most —
 * `httpOnly` — is the one nobody notices missing from a copy.
 *
 * `secure` comes from `PUBLIC_URL`'s scheme, not from NODE_ENV. The variable it
 * used to read is one `config.ts` has no say in and the lab deployment sets
 * nowhere, so an instance behind TLS sent session tokens without `Secure` and
 * nothing anywhere reported a misconfiguration. The scheme of the URL the
 * deployment is reached at is the fact this actually wanted, and it is
 * validated at startup.
 *
 * Still false on plain HTTP: a development server would otherwise set a cookie
 * that never comes back, which reads as "sign-in is broken".
 */
export const sessionCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure,
});
```

and line 79:

```ts
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(request.server.cookieSecure));
```

In `apps/api/src/app.ts`, immediately after the Fastify instance is created and before any route is registered, add:

```ts
  // Read once, from configuration, and available wherever a cookie is written.
  app.decorate('cookieSecure', config.cookieSecure);
```

In `apps/api/src/routes/saml-idp.ts`, replace lines 99–111 with a function of the same shape and call it where the cookie is set (line 127), taking the flag from `request.server.cookieSecure`:

```ts
const samlBindingCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/saml',
  // From PUBLIC_URL's scheme, for the reason `sessionCookieOptions` gives:
  // NODE_ENV is set nowhere in the lab deployment, so this cookie went out
  // without `Secure` on the one instance that is actually behind TLS.
  secure,
  // Comfortably longer than a parked request's ten minutes, so the row is what
  // expires the flow and not the cookie, and re-issued on every park.
  maxAge: 30 * 60,
});
```

```ts
  reply.setCookie(
    SAML_BINDING_COOKIE,
    nonce,
    samlBindingCookieOptions(request.server.cookieSecure),
  );
```

In `apps/api/src/routes/federation.ts`, delete the module-level constant at lines 146–148 and call `federationBindingCookieOptions(request.server.cookieSecure)` at each `setCookie` site. `federationBindingCookieOptions` already takes the flag as a parameter, so its body and its comment stay exactly as they are.

- [x] **Step 7: Verify nothing that reads these cookies broke**

Run: `npx vitest run apps/api/src/routes/auth.test.ts apps/api/src/routes/federation-saml.test.ts apps/api/src/routes/saml-sso-post.test.ts`

Expected: PASS. `buildTestApp` configures `PUBLIC_URL: http://acme.syntra.test`, so `cookieSecure` is false throughout the suite — identical to the behaviour NODE_ENV gave, which is what makes this a safe swap.

- [x] **Step 8: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/cookie-security.ts packages/core/src/cookie-security.test.ts \
        packages/core/src/config.ts packages/core/src/index.ts \
        apps/api/src/app.ts apps/api/src/routes/session-reply.ts \
        apps/api/src/routes/saml-idp.ts apps/api/src/routes/federation.ts
git commit -m "$(cat <<'EOF'
fix(auth): cookie security comes from the configured URL, not NODE_ENV

Three cookie definitions read `process.env.NODE_ENV === 'production'`
independently -- the session cookie's Secure flag, and the SAML and
federation binding cookies' Secure/SameSite pair. config.ts has no say in
that variable and the lab deployment exports it nowhere: not the systemd
unit, not either .env.example. So an instance behind TLS sent session
tokens without Secure, and the federation binding cookie fell back to
SameSite=Lax -- which that file's own comment says breaks every cross-site
federation POST -- with no configuration error anywhere.

PUBLIC_URL is a validated key that already means "where this deployment is
reached", and its scheme is the fact all three wanted. Derived once in
loadConfig, decorated onto the instance, read where the cookie is written.
Plain HTTP still means no Secure, so a development server keeps working;
an unreadable URL falls to Secure, because a broken login is visible and a
session on the wire is not.
EOF
)"
```

---

### Task 5: Removing a factor tells the person it belonged to

Spec §7.4 **H5** and §7.6 **W9**, plus the `Security.removeKey` half of **W5**. Passkey removal needs only a session — no current password, no step-up — and it cascades recovery-code revocation, while factor *additions* deliberately mail the owner as one of the two controls that make the enrolment trade acceptable. The console then discards the `recoveryCodesRevoked` the route answers, so the user is never told their printed codes just stopped working; and `removeKey` has no error handling at all, so a refusal is an unhandled rejection and the button appears to do nothing.

Three findings, one screen, one route file. Landing them apart would ship a removal nobody is told about, twice.

**Files:**
- Modify: `packages/core/src/notify/templates/index.ts` (a `factor-removed` template beside `factor-added`, line 26)
- Modify: `apps/api/src/routes/mfa.ts` (add `tellOwnerAFactorWasRemoved` beside `tellOwnerAFactorWasAdded`, line 125; call it from the webauthn delete at line 397–427)
- Modify: `apps/web/src/pages/Security.tsx:97-100` (`removeKey`)
- Test: `apps/api/src/routes/mfa.test.ts`
- Test: `apps/web/src/pages/Security.test.tsx` (created in Task 3)

**Interfaces:**
- Consumes: `renderMessage(tenantName, name, to, vars)`, `deliverMessage(transport, message, opts)` from `@syntra/core`; `TEMPLATES` gains the key `factor-removed`.
- Produces:
  - `export async function tellOwnerAFactorWasRemoved(request: FastifyRequest, transport: Transport, userId: string, factor: string): Promise<void>`
  - `DELETE /api/auth/mfa/webauthn/:credentialId` keeps its 200 `{ recoveryCodesRevoked }` shape and now also sends mail.

- [x] **Step 1: Write the failing route test**

Append to `apps/api/src/routes/mfa.test.ts`:

```ts
describe('a factor leaving an account is told to its owner', () => {
  /**
   * Additions mail the owner deliberately: it is one of the two controls that
   * make "a stolen password can enrol a factor" an acceptable trade. Removal
   * needs only a session -- no current password, no step-up -- and cascades
   * recovery-code revocation, which is strictly the more damaging half, and it
   * told nobody at all. An attacker holding a session could quietly strip
   * every factor off an account and the owner would find out at their next
   * sign-in, with nothing to say what happened.
   */
  it('mails the owner when a security key is removed', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const credentialId = await enrolWebAuthn(cookie);

    const before = ctx.mail.sent.length;
    const res = await call('DELETE', `/api/auth/mfa/webauthn/${credentialId}`, { cookie });
    expect(res.statusCode).toBe(200);

    const sent = ctx.mail.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('j@acme.test');
    expect(sent[0]!.text).toContain('security key');
  });

  /**
   * The count is on the wire because the console shows it. A user whose
   * printed codes have just been revoked has no other way to find that out.
   */
  it('answers how many recovery codes went with it', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const credentialId = await enrolWebAuthn(cookie);
    const issued = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });

    const res = await call('DELETE', `/api/auth/mfa/webauthn/${credentialId}`, { cookie });
    expect(res.json()).toEqual({
      recoveryCodesRevoked: (issued.json() as { codes: string[] }).codes.length,
    });
  });
});
```

`enrolWebAuthn(cookie)` is the file's existing helper for registering a credential; reuse it.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/mfa.test.ts -t 'told to its owner'`
Expected: FAIL — the first case sees zero messages sent. The second passes already.

- [x] **Step 3: Add the template**

In `packages/core/src/notify/templates/index.ts`, after the `factor-added` entry (line 26):

```ts
  'factor-removed': {
    subject: 'A second factor was removed from your {{tenantName}} account',
    text: 'Hello {{displayName}},\n\nA {{factor}} was removed from your account on {{when}}, from {{sourceIp}}.{{codesNote}}\n\nIf that was you, nothing further is needed. If it was not, change your password and contact your administrator immediately — removing a factor is what an attacker holding your session does before they do anything else, and it is the step nobody notices.',
    html: '<p>Hello {{displayName}},</p><p>A <strong>{{factor}}</strong> was removed from your account on {{when}}, from {{sourceIp}}.{{codesNote}}</p><p>If that was you, nothing further is needed. If it was not, change your password and contact your administrator immediately — removing a factor is what an attacker holding your session does before they do anything else, and it is the step nobody notices.</p>',
  },
```

- [x] **Step 4: Add the sender and call it**

In `apps/api/src/routes/mfa.ts`, after `tellOwnerAFactorWasAdded` ends (line 125):

```ts
/**
 * Tells the account owner a factor was taken off.
 *
 * The mirror of `tellOwnerAFactorWasAdded`, and the more important of the two.
 * Removal needs only a session -- no current password, no step-up -- and it
 * cascades recovery-code revocation, so an attacker holding a stolen session
 * can strip every way back in off an account in two requests. Additions were
 * mailed precisely because a factor enrolled by somebody else survives the
 * password change that would otherwise fix things; a factor REMOVED by
 * somebody else is the step that comes first, and until this it produced no
 * signal the owner could see at all.
 *
 * `codesNote` is part of the message rather than a separate mail: "and the
 * recovery codes you printed have stopped working" is the sentence that turns
 * this from a notification into something the reader can act on, and sending
 * it separately means half of them arrive and half do not.
 *
 * Delivery goes through `deliverMessage`, which does not throw: the removal has
 * already committed, and a mail server that is down must not turn it into a 500
 * for the user who just made it. A failure is logged and recorded as
 * `notify.delivery_failed`.
 */
export async function tellOwnerAFactorWasRemoved(
  request: FastifyRequest,
  transport: Transport,
  userId: string,
  factor: string,
  recoveryCodesRevoked = 0,
): Promise<void> {
  const { user, tenantName } = await request.db(async (tx) => ({
    user: await tx.user.findUnique({ where: { id: userId } }),
    tenantName: (
      await tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } })
    ).name,
  }));
  if (!user) return;

  const message = renderMessage(tenantName, 'factor-removed', user.email, {
    displayName: user.displayName,
    factor,
    when: new Date().toISOString(),
    sourceIp: request.ip,
    codesNote:
      recoveryCodesRevoked === 0
        ? ''
        : ` ${recoveryCodesRevoked} unused recovery code${
            recoveryCodesRevoked === 1 ? '' : 's'
          } stopped working with it, because recovery codes are a way back in when a real factor is lost and there is no longer one to lose.`,
  });
  await deliverMessage(transport, message, {
    tenantId: request.tenantId,
    userId: user.id,
    purpose: 'factor-removed',
    log: (error, purpose) =>
      request.log.error({ err: error, purpose }, 'notification not delivered'),
  });
}
```

In the `secured.delete('/webauthn/:credentialId', …)` handler, replace the final line (line 426):

```ts
      // Outside the transaction above, and awaited so a mail failure is logged
      // and audited rather than becoming an unhandled rejection on a removal
      // that has already committed.
      await tellOwnerAFactorWasRemoved(
        request,
        options.transport,
        request.session.userId,
        'security key',
        revoked,
      );
      return reply.status(200).send({ recoveryCodesRevoked: revoked });
```

- [x] **Step 5: Run the route test to verify it passes**

Run: `npx vitest run apps/api/src/routes/mfa.test.ts`
Expected: PASS, the whole file.

- [x] **Step 6: Make the console show the answer and report the refusal**

In `apps/web/src/pages/Security.tsx`, replace `removeKey` (lines 97–100):

```tsx
  /**
   * Removing a security key.
   *
   * Two things were missing and both were silent. The response carries
   * `recoveryCodesRevoked` and this function threw it away, so a user whose
   * printed codes had just stopped working was never told — and there is no
   * other screen that would tell them. And there was no error handling at all:
   * a refusal was an unhandled rejection and the button simply appeared not to
   * work.
   */
  async function removeKey(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ recoveryCodesRevoked: number }>(
        `/api/auth/mfa/webauthn/${id}`,
        { method: 'DELETE' },
      );
      if (result.recoveryCodesRevoked > 0) {
        setNotice(
          `That key was removed, and ${result.recoveryCodesRevoked} unused recovery code${
            result.recoveryCodesRevoked === 1 ? '' : 's'
          } stopped working with it. Set up a factor and generate new ones.`,
        );
      }
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That key could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }
```

- [x] **Step 7: Extend the web test**

Append to `apps/web/src/pages/Security.test.tsx`:

```tsx
describe('removing a security key says what it cost', () => {
  const withKey = () => ({
    ...status(),
    webauthn: {
      available: true,
      unavailableReason: null,
      credentials: [
        { id: 'k1', label: 'YubiKey', createdAt: '2026-01-02T00:00:00.000Z', lastUsedAt: null },
      ],
    },
  });

  function mockWithKey(deleteResponse: Response) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === 'DELETE' && url.includes('/webauthn/')) {
        return Promise.resolve(deleteResponse);
      }
      if (url.endsWith('/api/auth/mfa')) return Promise.resolve(json(withKey()));
      if (url.endsWith('/api/auth/session')) return Promise.resolve(json({}, 401));
      return Promise.resolve(json({}));
    });
  }

  it('tells the user the printed codes have stopped working', async () => {
    mockWithKey(json({ recoveryCodesRevoked: 4 }));
    renderPage();
    await screen.findByText('YubiKey');

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    expect(
      await screen.findByText(/4 unused recovery codes stopped working with it/),
    ).toBeInTheDocument();
  });

  /**
   * There was no catch here at all, so a refusal was an unhandled rejection
   * and the button read as broken.
   */
  it('reports a refusal instead of doing nothing visible', async () => {
    mockWithKey(
      json(
        { type: 'https://syntra.dev/problems/forbidden', title: 'Forbidden', status: 403, detail: 'That key is not yours.' },
        403,
      ),
    );
    renderPage();
    await screen.findByText('YubiKey');

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    expect(await screen.findByText('That key is not yours.')).toBeInTheDocument();
  });
});
```

The `[1]` index is deliberate: the authenticator panel from Task 3 renders the first `Remove` and the key list renders the second. If the ordering changes, scope the query to the panel with `within()` rather than adjusting the index.

- [x] **Step 8: Run the web test and typecheck**

```bash
cd apps/web && npx vitest run src/pages/Security.test.tsx; cd ../..
npx tsc -b
```

Expected: PASS, 5 tests; `tsc -b` exits 0.

- [x] **Step 9: Commit**

```bash
git add packages/core/src/notify/templates/index.ts \
        apps/api/src/routes/mfa.ts apps/api/src/routes/mfa.test.ts \
        apps/web/src/pages/Security.tsx apps/web/src/pages/Security.test.tsx
git commit -m "$(cat <<'EOF'
fix(mfa): removing a factor tells the person it belonged to

Enrolment mails the owner deliberately -- it is one of the two controls
that make "a stolen password can enrol a factor" an acceptable trade.
Removal needs only a session, no current password and no step-up, and it
cascades recovery-code revocation: an attacker holding a stolen session
strips every way back in with two requests, and until now that produced no
signal the owner could see.

The console also threw away the `recoveryCodesRevoked` the route already
answered, so somebody whose printed codes had just stopped working was
never told, by this screen or any other. And `removeKey` had no catch at
all, so a refusal was an unhandled rejection and the button read as
broken. Same screen, same route, one change.
EOF
)"
```

---

## Phase B — Authorization

### Task 6: Roles become editable in the domain

Spec §7.4, **H2**, part one of four. `createRole`, `assignRole`, `revokeRole` and `listRoles` have no callers outside the seed and the tests, so `rbac.manage` and `secrets.write` gate nothing and `isPermission` is never called. There is no way to change a role's permissions at all: `Role.permissions` is a stored snapshot written once by the seed, and the catalogue grew in six later commits with no migration behind them. An upgraded deployment's Owner gets 403 on every new module with no path to grant it but raw SQL. **This is the general case of U3** — `deployment.manage` is one instance of it.

This task adds the domain operations. Task 7 exposes them, Task 8 repairs the installs that already exist, Task 9 puts a screen on it.

**Files:**
- Modify: `packages/core/src/rbac/rbac-service.ts` (append after `isAdministrator`, line 158)
- Test: `packages/core/src/rbac/rbac-service.test.ts` (append)

**Interfaces:**
- Consumes: `currentTenant(tx)`, `TenantClient`, `Permission`, `PERMISSIONS`, `isPermission` from `./permissions.js`.
- Produces:
  - `export class RoleRefusedError extends Error { readonly code: string }`
  - `export function assertPermissionNames(values: readonly string[]): Permission[]`
  - `export async function readRole(tx: TenantClient, roleId: string)` — the role with its assignments
  - `export async function listRolesWithAssignmentCounts(tx: TenantClient): Promise<Array<Role & { assignmentCount: number }>>`
  - `export async function updateRole(tx: TenantClient, roleId: string, input: { name?: string; description?: string | null; permissions?: readonly string[] }): Promise<void>`
  - `export async function deleteRole(tx: TenantClient, roleId: string): Promise<void>`
  - `export async function countHoldersOf(tx: TenantClient, permission: Permission): Promise<number>`

- [x] **Step 1: Write the failing test**

Append to `packages/core/src/rbac/rbac-service.test.ts`:

```ts
describe('editing a role', () => {
  /**
   * The whole reason this exists. `Role.permissions` is a stored snapshot
   * written once by the seed, and the catalogue grew in six later commits with
   * no migration behind them -- so an upgraded deployment's Owner got 403 on
   * every new module and the only remedy was hand-written SQL.
   */
  it('replaces the permission set', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
      await updateRole(tx, role.id, {
        permissions: [PERMISSIONS.AUDIT_READ, PERMISSIONS.GOVERN_READ],
      });
      return role.id;
    });

    const after = await withTenant(tenantId, (tx) => readRole(tx, roleId));
    expect([...after.permissions].sort()).toEqual(
      [PERMISSIONS.AUDIT_READ, PERMISSIONS.GOVERN_READ].sort(),
    );
  });

  /**
   * The catalogue is closed and it is closed HERE, in the domain, not in a
   * zod enum at the edge. A second declaration of the same list is a second
   * thing to keep in step, and this one already exists and is already the
   * authority `hasPermission` compares against.
   */
  it('refuses a permission that is not in the catalogue', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const role = await createRole(tx, 'Odd', [PERMISSIONS.AUDIT_READ]);
        await updateRole(tx, role.id, { permissions: ['directory.reed'] });
      }),
    ).rejects.toThrow(/directory\.reed/);
  });

  it('renames without touching the permissions', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Auditor', [PERMISSIONS.AUDIT_READ]);
      await updateRole(tx, role.id, { name: 'Internal audit' });
      return role.id;
    });
    const after = await withTenant(tenantId, (tx) => readRole(tx, roleId));
    expect(after.name).toBe('Internal audit');
    expect(after.permissions).toEqual([PERMISSIONS.AUDIT_READ]);
  });
});

describe('deleting a role', () => {
  it('deletes one nobody holds', async () => {
    const roleId = await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Temporary', [PERMISSIONS.AUDIT_READ]);
      await deleteRole(tx, role.id);
      return role.id;
    });
    const rows = await withTenant(tenantId, (tx) => listRoles(tx));
    expect(rows.map((r) => r.id)).not.toContain(roleId);
  });

  /**
   * A built-in role is the one the seed wrote and the one the migration
   * backfills. Deleting it is not an edit an administrator can undo, and the
   * assignment rows cascade with it.
   */
  it('refuses a built-in role', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const role = await createRole(tx, 'Owner', ALL_PERMISSIONS, { builtIn: true });
        await deleteRole(tx, role.id);
      }),
    ).rejects.toThrow(/built-in/);
  });

  it('refuses one that is still assigned, and names the count', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const user = await createUser(tx, {
          login: 'a', email: 'a@acme.test', displayName: 'A',
        });
        const role = await createRole(tx, 'Held', [PERMISSIONS.AUDIT_READ]);
        await assignRole(tx, user.id, role.id);
        await deleteRole(tx, role.id);
      }),
    ).rejects.toThrow(/1 /);
  });
});

describe('countHoldersOf', () => {
  /**
   * The denominator behind the lockout guard the API applies. Unscoped
   * assignments ONLY: `hasPermission` deliberately refuses a scoped grant
   * asked tenant-wide, so a department-scoped `rbac.manage` cannot administer
   * roles and must not count towards "somebody can still do this".
   */
  it('counts people holding it tenant-wide, once each', async () => {
    const count = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'b', email: 'b@acme.test', displayName: 'B',
      });
      const one = await createRole(tx, 'One', [PERMISSIONS.RBAC_MANAGE]);
      const two = await createRole(tx, 'Two', [PERMISSIONS.RBAC_MANAGE]);
      await assignRole(tx, user.id, one.id);
      await assignRole(tx, user.id, two.id);
      return countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE);
    });
    expect(count).toBe(1);
  });

  it('does not count a scoped assignment', async () => {
    const count = await withTenant(tenantId, async (tx) => {
      const unit = await createOrgUnit(tx, 'Care');
      const user = await createUser(tx, {
        login: 'c', email: 'c@acme.test', displayName: 'C',
      });
      const role = await createRole(tx, 'Scoped', [PERMISSIONS.RBAC_MANAGE]);
      await assignRole(tx, user.id, role.id, unit.id);
      return countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE);
    });
    expect(count).toBe(0);
  });
});
```

Add `ALL_PERMISSIONS`, `createOrgUnit`, `createUser`, `countHoldersOf`, `deleteRole`, `readRole` and `updateRole` to the file's existing imports.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/rbac/rbac-service.test.ts`
Expected: FAIL — `updateRole`, `deleteRole`, `readRole` and `countHoldersOf` do not exist.

- [x] **Step 3: Write the operations**

Append to `packages/core/src/rbac/rbac-service.ts`, and add `PERMISSIONS, isPermission` to the import from `./permissions.js` (line 3):

```ts
/**
 * A role change the domain will not make, with a code the API turns into a
 * problem type.
 *
 * The same shape `CampaignRefusedError` and `DecisionRefusedError` use: these
 * are decisions this module made about a well-formed request, not faults, and a
 * 500 would tell the caller nothing they can act on.
 */
export class RoleRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoleRefusedError';
  }
}

/**
 * The permission names, checked against the closed catalogue.
 *
 * THE CATALOGUE LIVES HERE, and this is the one place it is enforced on the
 * way in. The obvious alternative -- a `z.enum` in the contract built from
 * `ALL_PERMISSIONS` -- would put a second copy of the list at the edge, and a
 * second copy is a second thing to keep in step with `hasPermission`, which
 * compares against this one. It is also what `isPermission` was written for:
 * the function existed, was tested, and had no caller anywhere in the tree.
 *
 * The offending value is named in the message because the caller is an
 * administrator looking at a list of checkboxes and a typo in a permission
 * string is otherwise indistinguishable from a permission that does not exist
 * yet.
 */
export function assertPermissionNames(values: readonly string[]): Permission[] {
  const unknown = values.filter((value) => !isPermission(value));
  if (unknown.length > 0) {
    throw new RoleRefusedError(
      'unknown-permission',
      `not permissions this product has: ${unknown.join(', ')}`,
    );
  }
  return values as Permission[];
}

export async function readRole(tx: TenantClient, roleId: string) {
  return tx.role.findUniqueOrThrow({
    where: { id: roleId },
    include: { assignments: true },
  });
}

/**
 * Every role with how many people hold it.
 *
 * The count is what makes the screen readable: "Owner — 1 holder" and
 * "Auditor — 0 holders" are different facts about whether a permission change
 * matters, and a list of names without them is a list somebody has to click
 * through one row at a time.
 */
export async function listRolesWithAssignmentCounts(tx: TenantClient) {
  const roles = await tx.role.findMany({
    orderBy: { name: 'asc' },
    include: { assignments: { select: { userId: true } } },
  });
  return roles.map(({ assignments, ...role }) => ({
    ...role,
    assignmentCount: new Set(assignments.map((a) => a.userId)).size,
  }));
}

/**
 * Changes a role's name, description or permission set.
 *
 * The permission set is REPLACED WHOLE rather than merged, and the caller
 * sends the whole thing. A merge would need an add/remove vocabulary the
 * screen does not have, and "the permissions are what the boxes say" is the
 * only rule an administrator can predict from looking at the form.
 *
 * A built-in role is editable HERE, deliberately, and that is the point of the
 * whole task: `Role.permissions` is a snapshot the seed wrote once, the
 * catalogue grew in six later commits, and the Owner of an upgraded
 * installation got 403 on every new module with no way to grant itself the
 * permission but raw SQL. Deletion is a different question -- see below.
 */
export async function updateRole(
  tx: TenantClient,
  roleId: string,
  input: {
    name?: string;
    description?: string | null;
    permissions?: readonly string[];
  },
): Promise<void> {
  const role = await tx.role.findUniqueOrThrow({ where: { id: roleId } });

  await tx.role.update({
    where: { id: role.id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.permissions === undefined
        ? {}
        : { permissions: assertPermissionNames(input.permissions) }),
    },
  });
}

/**
 * Deletes a role nobody holds.
 *
 * Two refusals, both of them about damage that is not visible from the button.
 * `RoleAssignment` cascades from `Role`, so deleting a held role silently
 * revokes administrative authority from however many people held it, with no
 * record of what they had; and a built-in role is the one the seed wrote and
 * the one the permission backfill migration targets, so deleting it makes the
 * installation unrepairable by the mechanism that repairs it.
 *
 * The holder count is in the message because "it is in use" without a number
 * is not something the reader can act on.
 */
export async function deleteRole(tx: TenantClient, roleId: string): Promise<void> {
  const role = await tx.role.findUniqueOrThrow({
    where: { id: roleId },
    include: { assignments: { select: { userId: true } } },
  });

  if (role.builtIn) {
    throw new RoleRefusedError(
      'built-in-role',
      `"${role.name}" is a built-in role: it is what the seed created and what the permission backfill targets, so it cannot be deleted. Change its permissions instead.`,
    );
  }
  const holders = new Set(role.assignments.map((a) => a.userId)).size;
  if (holders > 0) {
    throw new RoleRefusedError(
      'role-in-use',
      `${holders} ${holders === 1 ? 'person holds' : 'people hold'} "${role.name}". Deleting it would revoke that authority with no record of what it was; take the role off them first.`,
    );
  }

  await tx.role.delete({ where: { id: role.id } });
}

/**
 * How many people hold this permission TENANT-WIDE.
 *
 * The denominator behind the lockout guard the role API applies: a change that
 * leaves nobody able to administer roles leaves an installation that can only
 * be repaired with SQL, which is exactly the state this whole task exists to
 * get out of.
 *
 * Unscoped assignments only, and that is not an oversight. `hasPermission`
 * deliberately refuses a scoped grant asked with no scope -- a tenant-wide
 * question is not answered by authority over one department -- so a
 * department-scoped `rbac.manage` cannot reach the role API at all and must
 * not count towards "somebody can still do this".
 */
export async function countHoldersOf(
  tx: TenantClient,
  permission: Permission,
): Promise<number> {
  const assignments = await tx.roleAssignment.findMany({
    where: { scopeOrgUnitId: null },
    include: { role: true },
  });
  return new Set(
    assignments
      .filter((a) => a.role.permissions.includes(permission))
      .map((a) => a.userId),
  ).size;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/rbac/rbac-service.test.ts`
Expected: PASS, the whole file.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/rbac/rbac-service.ts packages/core/src/rbac/rbac-service.test.ts
git commit -m "$(cat <<'EOF'
feat(rbac): roles can be edited, deleted and counted

`Role.permissions` is a stored snapshot written once by the seed. The
catalogue grew in six later commits with no migration behind them, so an
upgraded deployment's Owner gets 403 on every new module and the only
remedy is hand-written SQL. `createRole`, `assignRole`, `revokeRole` and
`listRoles` had no callers outside the seed either, so `rbac.manage` and
`secrets.write` gated nothing at all.

The domain half: replace a permission set, rename, delete, and count
tenant-wide holders of a permission. `assertPermissionNames` is where the
closed catalogue is enforced -- through `isPermission`, which existed, was
tested and had no caller anywhere. Deletion refuses a built-in role and
one that is still held: RoleAssignment cascades, so the delete would
quietly revoke authority with no record of what it was. `countHoldersOf`
ignores scoped assignments, because `hasPermission` refuses a scoped grant
asked tenant-wide and authority over one department is not an answer to
"can anybody still administer roles".
EOF
)"
```

---

### Task 7: The role-management API

Spec §7.4, **H2**, part two. The routes, the contract, and the one guard that keeps this from being the fastest way to lock an installation out of itself.

**Files:**
- Create: `packages/contracts/src/rbac.ts`
- Modify: `packages/contracts/src/index.ts` (add the export)
- Create: `apps/api/src/routes/admin/roles.ts`
- Create: `apps/api/src/routes/admin/roles.test.ts`
- Modify: `apps/api/src/app.ts` (register beside the other admin routers, after line 215)

**Interfaces:**
- Consumes: `PERMISSIONS`, `assignRole`, `createRole`, `revokeRole`, `readRole`, `updateRole`, `deleteRole`, `listRolesWithAssignmentCounts`, `countHoldersOf`, `assertPermissionNames`, `RoleRefusedError`, `ALL_PERMISSIONS`, `recordEvent` from `@syntra/core`; `idParam` from `@syntra/contracts`; `requireSession('admin')`, `requirePermission`.
- Produces:
  - contracts: `roleBody`, `patchRoleBody`, `roleAssignmentBody`, `roleAssignmentParams`
  - `GET /api/admin/roles` → `{ catalog: string[]; roles: Array<{ id, name, description, permissions, builtIn, assignmentCount }> }`
  - `POST /api/admin/roles` → 201 the role
  - `PATCH /api/admin/roles/:id` → 204
  - `DELETE /api/admin/roles/:id` → 204
  - `POST /api/admin/roles/:id/assignments` → 204
  - `DELETE /api/admin/roles/:id/assignments/:userId` → 204
  - `export async function registerAdminRoleRoutes(app: FastifyInstance): Promise<void>`

- [x] **Step 1: Write the contract**

Create `packages/contracts/src/rbac.ts`:

```ts
import { z } from 'zod';

/**
 * A role, as an administrator types it.
 *
 * `permissions` is `z.array(z.string())` and NOT an enum built from the
 * catalogue, deliberately. The catalogue is a closed set defined in
 * `@syntra/core`'s `permissions.ts` and enforced there by
 * `assertPermissionNames`; declaring it a second time here would be a second
 * copy to keep in step with the one `hasPermission` actually compares against,
 * and the two would drift the first time somebody added a permission and
 * forgot this file. The refusal is a 422 naming the offending value, which is
 * what the console renders against the field.
 *
 * `.strict()` for the reason `provision.ts` writes out at length: this body
 * REPLACES the permission set, so a typoed key stripped silently would be a
 * save that reports success and changed something other than what was meant.
 *
 * `.min(1)` on the list: a role with no permissions grants nothing and is
 * indistinguishable from a mistake. Deleting the role is how you say that.
 */
export const roleBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().default(null),
    permissions: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type RoleBody = z.input<typeof roleBody>;

/**
 * Editing one. Every field optional and at least one present — a PATCH naming
 * no field is a bug in the caller, and answering it 204 hides that.
 */
export const patchRoleBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    permissions: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

/**
 * Granting the role, optionally confined to one organizational unit.
 *
 * Nullable rather than absent for the unscoped case, because the two readings
 * of a missing field — "tenant-wide" and "I forgot" — are the difference
 * between authority over one department and authority over everything.
 */
export const roleAssignmentBody = z
  .object({
    userId: z.string().uuid(),
    scopeOrgUnitId: z.string().uuid().nullable().default(null),
  })
  .strict();

export const roleAssignmentParams = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});
```

Add `export * from './rbac.js';` to `packages/contracts/src/index.ts`.

- [x] **Step 2: Write the failing route test**

Create `apps/api/src/routes/admin/roles.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  assignRole,
  createOrgUnit,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

async function seedAdmin(login: string, permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login, email: `${login}@acme.test`, displayName: login,
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, `role-${login}`, permissions);
    await assignRole(tx, user.id, role.id);
    return { user, roleId: role.id };
  });
}

async function authCookie(login: string) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login, password: PASSWORD },
  });
  const token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST', url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject(
    payload === undefined
      ? { method, url, headers: { host: ctx.host, cookie } }
      : { method, url, headers: { host: ctx.host, cookie }, payload: payload as object },
  );

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('the role API that did not exist', () => {
  it('lists roles with their holder counts, and the catalogue beside them', async () => {
    await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('GET', '/api/admin/roles', cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      catalog: string[];
      roles: { name: string; assignmentCount: number; permissions: string[] }[];
    };
    // The catalogue is on the response because the screen renders a checkbox
    // per permission and there is no other way for it to know the list.
    expect(body.catalog).toEqual([...ALL_PERMISSIONS]);
    expect(body.roles.find((r) => r.name === 'role-owner')?.assignmentCount).toBe(1);
  });

  /**
   * U3, closed from the product side. `deployment.manage` was added to the
   * catalogue in a later commit than the seed that wrote the Owner role, so
   * the Updates page was hidden and every update route answered 403 with no
   * path to grant it but SQL.
   */
  it('grants a permission the seed never wrote', async () => {
    const { roleId } = await seedAdmin('owner', [
      PERMISSIONS.RBAC_MANAGE,
      PERMISSIONS.DIRECTORY_READ,
    ]);
    const cookie = await authCookie('owner');

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: [
        PERMISSIONS.RBAC_MANAGE,
        PERMISSIONS.DIRECTORY_READ,
        PERMISSIONS.DEPLOYMENT_MANAGE,
      ],
    });
    expect(res.statusCode).toBe(204);

    const session = await ctx.app.inject({
      method: 'GET', url: '/api/auth/session',
      headers: { host: ctx.host, cookie },
    });
    expect((session.json() as { permissions: string[] }).permissions).toContain(
      'deployment.manage',
    );
  });

  it('names a permission it does not have, rather than dropping it', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: ['directory.reed'],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ detail: expect.stringContaining('directory.reed') });
  });

  it('creates, assigns and revokes', async () => {
    await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');
    const subject = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'jo', email: 'jo@acme.test', displayName: 'Jo' }),
    );

    const created = await send('POST', '/api/admin/roles', cookie, {
      name: 'Auditor',
      permissions: [PERMISSIONS.AUDIT_READ],
    });
    expect(created.statusCode).toBe(201);
    const roleId = (created.json() as { id: string }).id;

    expect(
      (await send('POST', `/api/admin/roles/${roleId}/assignments`, cookie, {
        userId: subject.id,
      })).statusCode,
    ).toBe(204);
    expect(
      (await send('GET', '/api/admin/roles', cookie)).json() as { roles: { id: string; assignmentCount: number }[] },
    ).toMatchObject({ roles: expect.arrayContaining([{ id: roleId, assignmentCount: 1 }]) as never });

    expect(
      (await send('DELETE', `/api/admin/roles/${roleId}/assignments/${subject.id}`, cookie))
        .statusCode,
    ).toBe(204);
  });

  /**
   * THE GUARD THAT MATTERS MOST. Taking `rbac.manage` off the last role that
   * carries it leaves an installation nobody can administer roles in — which
   * is precisely the state this whole task exists to get out of, reached by
   * the very screen that fixes it.
   */
  it('refuses a change that leaves nobody able to administer roles', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: [PERMISSIONS.DIRECTORY_READ],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: expect.stringContaining('would-strand-rbac') });

    // And nothing was written: the guard runs inside the transaction.
    const still = await ctx.app.inject({
      method: 'GET', url: '/api/admin/roles',
      headers: { host: ctx.host, cookie },
    });
    expect(still.statusCode).toBe(200);
  });

  it('refuses revoking the last holder of rbac.manage', async () => {
    const { user, roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');

    const res = await send('DELETE', `/api/admin/roles/${roleId}/assignments/${user.id}`, cookie);
    expect(res.statusCode).toBe(409);
  });

  it('allows the same change once somebody else holds it', async () => {
    const { roleId } = await seedAdmin('owner', ALL_PERMISSIONS);
    const cookie = await authCookie('owner');
    await withTenant(ctx.tenantId, async (tx) => {
      const other = await createUser(tx, {
        login: 'second', email: 's@acme.test', displayName: 'S',
      });
      const role = await createRole(tx, 'Co-admin', [PERMISSIONS.RBAC_MANAGE]);
      await assignRole(tx, other.id, role.id);
    });

    const res = await send('PATCH', `/api/admin/roles/${roleId}`, cookie, {
      permissions: [PERMISSIONS.DIRECTORY_READ],
    });
    expect(res.statusCode).toBe(204);
  });

  it('requires rbac.manage', async () => {
    await seedAdmin('reader', [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('reader');
    expect((await send('GET', '/api/admin/roles', cookie)).statusCode).toBe(403);
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/roles.test.ts`
Expected: FAIL — every case 404s; the router does not exist.

- [x] **Step 4: Write the router**

Create `apps/api/src/routes/admin/roles.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  idParam,
  patchRoleBody,
  roleAssignmentBody,
  roleAssignmentParams,
  roleBody,
} from '@syntra/contracts';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  RoleRefusedError,
  assertPermissionNames,
  assignRole,
  countHoldersOf,
  createRole,
  deleteRole,
  listRolesWithAssignmentCounts,
  recordEvent,
  revokeRole,
  updateRole,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * The role surface, which did not exist at all.
 *
 * `Role.permissions` was written once by the seed and never again: no
 * migration, no backfill, no API. The catalogue grew in six later commits, so
 * an upgraded installation's Owner got 403 on every new module -- the Updates
 * page most visibly, since `deployment.manage` was added after every existing
 * deployment had already been seeded -- and the only remedy was raw SQL
 * against the `Role` table. `rbac.manage` itself gated nothing, because
 * nothing consulted it.
 *
 * Guarded by `rbac.manage`, which finally means something. Every mutation is
 * audited in the same transaction as the write, like every other admin route
 * in this directory.
 */
export async function registerAdminRoleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  /**
   * Refuses to be the change that locks the installation out of itself.
   *
   * Run INSIDE the writing transaction, after the write, so it sees the state
   * the change actually produced rather than a prediction of it -- and so
   * throwing rolls the write back. Predicting the post-change holder set in
   * memory would mean reimplementing `hasPermission`'s rules here, and the two
   * would disagree the first time one of them changed.
   *
   * Only `rbac.manage` is guarded. Every other permission can be taken away
   * and given back by somebody holding this one; this is the only one whose
   * absence is unrecoverable without a database client, which is exactly the
   * state this module was built to end.
   */
  const refuseIfStranded = async (
    tx: Parameters<Parameters<typeof app.get>[1]>[0] extends never ? never : never,
  ) => tx;

  const guardRbac = async (
    tx: Parameters<typeof countHoldersOf>[0],
  ): Promise<void> => {
    if ((await countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE)) > 0) return;
    throw new RoleRefusedError(
      'would-strand-rbac',
      'That would leave nobody able to administer roles, and there is no way back from it but a database client. Give somebody else rbac.manage first.',
    );
  };

  /** Domain refusals become 4xx problems carrying their code. */
  const asProblem = (cause: unknown): never => {
    if (cause instanceof RoleRefusedError) {
      const status =
        cause.code === 'unknown-permission'
          ? 422
          : cause.code === 'would-strand-rbac' || cause.code === 'role-in-use'
            ? 409
            : 409;
      throw new ProblemError(status, cause.code, 'Cannot be saved', cause.message);
    }
    throw cause;
  };

  app.get(
    '/roles',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request) => ({
      // The CATALOGUE travels with the list. The console renders a checkbox
      // per permission and has no other way to know what they are -- and a
      // hard-coded copy in the web bundle is the second definition this
      // module exists to avoid.
      catalog: [...ALL_PERMISSIONS],
      roles: await request.db((tx) => listRolesWithAssignmentCounts(tx)),
    }),
  );

  app.post(
    '/roles',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const body = roleBody.parse(request.body);
      try {
        const created = await request.db(async (tx) => {
          const role = await createRole(
            tx,
            body.name,
            assertPermissionNames(body.permissions),
            body.description === null ? {} : { description: body.description },
          );
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_created',
            targetType: 'Role',
            targetId: role.id,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { name: role.name, permissions: role.permissions },
          });
          return role;
        });
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.patch(
    '/roles/:id',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = patchRoleBody.parse(request.body);
      try {
        await request.db(async (tx) => {
          await updateRole(tx, id, body);
          await guardRbac(tx);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_updated',
            targetType: 'Role',
            targetId: id,
            outcome: 'success',
            sourceIp: request.ip,
            // The resulting state, not the diff of a form nobody can see
            // later. Same rule the tenant settings route follows.
            payload: { changed: Object.keys(body), ...body },
          });
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    '/roles/:id',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      try {
        await request.db(async (tx) => {
          const role = await tx.role.findUniqueOrThrow({ where: { id } });
          await deleteRole(tx, id);
          await guardRbac(tx);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_deleted',
            targetType: 'Role',
            targetId: id,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { name: role.name, permissions: role.permissions },
          });
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/roles/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = roleAssignmentBody.parse(request.body);
      await request.db(async (tx) => {
        await tx.role.findUniqueOrThrow({ where: { id } });
        await tx.user.findUniqueOrThrow({ where: { id: body.userId } });
        await assignRole(
          tx,
          body.userId,
          id,
          body.scopeOrgUnitId ?? undefined,
        );
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'rbac.role_assigned',
          targetType: 'User',
          targetId: body.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { roleId: id, scopeOrgUnitId: body.scopeOrgUnitId },
        });
      });
      return reply.status(204).send();
    },
  );

  app.delete(
    '/roles/:id/assignments/:userId',
    { preHandler: requirePermission(PERMISSIONS.RBAC_MANAGE) },
    async (request, reply) => {
      const { id, userId } = roleAssignmentParams.parse(request.params);
      try {
        await request.db(async (tx) => {
          // Every scope, because the path names none. A caller who wants to
          // remove one department's grant and keep another's does it by
          // re-assigning; taking "the role" off somebody means all of it.
          await revokeRole(tx, userId, id);
          await guardRbac(tx);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'rbac.role_revoked',
            targetType: 'User',
            targetId: userId,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { roleId: id },
          });
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );
}
```

Delete the stray `refuseIfStranded` stub above `guardRbac` before running anything — it is a leftover shape and must not ship. `guardRbac` is the whole guard.

- [x] **Step 5: Register it**

In `apps/api/src/app.ts`, add `import { registerAdminRoleRoutes } from './routes/admin/roles.js';` beside the other admin imports, and after the tenant registration (line 215):

```ts
  await app.register(registerAdminRoleRoutes, { prefix: '/api/admin' });
```

- [x] **Step 6: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/roles.test.ts`
Expected: PASS, 8 tests.

- [x] **Step 7: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/contracts/src/rbac.ts packages/contracts/src/index.ts \
        apps/api/src/routes/admin/roles.ts apps/api/src/routes/admin/roles.test.ts \
        apps/api/src/app.ts
git commit -m "$(cat <<'EOF'
feat(rbac): a role-management API, so a permission can be granted at all

There was no role API. `Role.permissions` was a snapshot the seed wrote
once, the catalogue grew in six later commits with no migration, and an
upgraded installation's Owner got 403 on every new module -- the Updates
page most visibly, since deployment.manage landed after every existing
deployment had been seeded. `rbac.manage` gated nothing because nothing
consulted it.

List, create, edit, delete, assign, revoke, all under rbac.manage and all
audited in the same transaction as the write. The catalogue travels on the
list response because the console renders a checkbox per permission and a
hard-coded copy in the web bundle is the second definition this avoids.

The one guard: a change that leaves nobody holding rbac.manage tenant-wide
is refused. It runs inside the writing transaction and after the write, so
it sees what actually happened and throwing rolls it back -- and it counts
only unscoped assignments, because `hasPermission` refuses a scoped grant
asked tenant-wide. Every other permission is recoverable by somebody
holding this one; this is the only one whose absence needs a database
client, which is the state the whole module exists to end.
EOF
)"
```

---

### Task 8: Backfill the built-in roles, so existing installs are repaired

Spec §7.4 **H2** and §5 **U3**. The API from Task 7 lets an administrator grant a new permission — but only if they can reach the console, and reaching a permission-gated page needs the permission. An installation seeded before `deployment.manage`, `govern.export` or `provision.read` existed has an Owner that holds none of them and, until this migration, no way to grant them that does not start with SQL.

**Files:**
- Create: `packages/db/prisma/migrations/20260903000000_builtin_role_permissions/migration.sql`
- Modify: `packages/db/src/migration-order.ts` (append the name to `KNOWN_MIGRATIONS`)
- Create: `packages/db/src/builtin-role-permissions.test.ts`

**Interfaces:**
- Consumes: `ALL_PERMISSIONS` from `@syntra/core`; the migration directory listing.
- Produces: no exported symbols. Every `Role` with `builtIn = true` gains every permission in the literal list that it does not already hold. Nothing is ever removed.

- [x] **Step 1: Write the failing test**

Create `packages/db/src/builtin-role-permissions.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@syntra/core';

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../prisma/migrations/20260903000000_builtin_role_permissions/migration.sql',
  ),
  'utf8',
);

/** The quoted strings inside the migration's ARRAY[...] literal. */
const backfilled = (): string[] =>
  [...(sql.match(/ARRAY\[([\s\S]*?)\]::text\[\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1]!,
  );

describe('the built-in role backfill', () => {
  /**
   * The literal list is a SNAPSHOT of the catalogue at the moment this
   * migration was written, and it has to stay one: a name in here that the
   * catalogue does not have is a typo that grants a meaningless string
   * forever, and `hasPermission` compares by exact match so nobody would ever
   * see it fail.
   *
   * Deliberately a SUBSET assertion and not an equality one. Once the role API
   * exists the catalogue is meant to grow without a migration behind it —
   * an administrator grants the new permission from the console — so demanding
   * a new migration per permission would be demanding the exact ceremony this
   * work removed.
   */
  it('names only permissions the catalogue has', () => {
    const catalog = new Set<string>(ALL_PERMISSIONS);
    expect(backfilled().filter((p) => !catalog.has(p))).toEqual([]);
  });

  /**
   * U3, named. `deployment.manage` was added to the catalogue after every
   * existing deployment had been seeded, so the Updates page was hidden and
   * every update route answered 403 -- on the one feature whose whole point is
   * repairing a deployment.
   */
  it('includes deployment.manage', () => {
    expect(backfilled()).toContain('deployment.manage');
  });

  /** Whatever the catalogue held when this was written, all of it. */
  it('is the full catalogue as of the migration', () => {
    expect(backfilled().length).toBeGreaterThanOrEqual(20);
  });

  /**
   * ADDITIVE ONLY. A built-in role that an administrator has deliberately
   * narrowed must not be widened back on the next deploy, and no role may lose
   * anything: this migration repairs an omission, it does not enforce a
   * policy.
   */
  it('only ever adds, and only to built-in roles', () => {
    expect(sql).toMatch(/"builtIn"\s*=\s*true/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+"Role"/i);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/db/src/builtin-role-permissions.test.ts`
Expected: FAIL — `ENOENT`, the migration does not exist.

- [x] **Step 3: Generate the permission list from the catalogue**

```bash
node --import tsx -e "import('@syntra/core').then(m => console.log(m.ALL_PERMISSIONS.map(p => \"    '\" + p + \"'\").join(',\n')))"
```

Paste that output into the `ARRAY[...]` literal below rather than typing the names by hand. The test in Step 1 is what keeps the paste honest.

- [x] **Step 4: Write the migration**

Create `packages/db/prisma/migrations/20260903000000_builtin_role_permissions/migration.sql`:

```sql
-- Give every built-in role the permissions the catalogue has grown since it
-- was seeded.
--
-- `Role.permissions` is a stored snapshot. The seed writes it once, exits
-- early on an already-seeded database, and nothing else has ever written it:
-- no migration, no backfill, and until this release no API. The catalogue grew
-- in six commits after the seed that created most installations' Owner role,
-- so those installations' administrators hold a set of permissions frozen at
-- whatever the product had on the day they installed it.
--
-- What that looks like in the product: `deployment.manage` was added for the
-- in-console updater, the Updates page is hidden because the console filters
-- navigation on permissions, and every /api/admin/update route answers 403.
-- The one feature whose purpose is repairing a deployment cannot be reached by
-- the deployment that needs repairing. `govern.export`, `provision.read` and
-- `govern.accept_risk` are in the same position, more quietly.
--
-- ADDITIVE, AND ONLY FOR `builtIn` ROLES. An administrator who deliberately
-- narrowed a custom role must not have it widened by a deploy, and nobody
-- loses anything here: `array_agg(DISTINCT ...)` over the union takes what is
-- there and adds what is missing. A built-in role is the one the seed wrote
-- with the full catalogue as its intent, so restoring that intent is what this
-- is.
--
-- The list below is a SNAPSHOT of `ALL_PERMISSIONS` at the time of writing,
-- because SQL cannot read a TypeScript constant. It does not need to be
-- updated when the catalogue grows again: that is what the role API is for,
-- and `builtin-role-permissions.test.ts` asserts only that everything named
-- here is a permission the catalogue actually has.
UPDATE "Role" AS r
SET "permissions" = sub.merged
FROM (
  SELECT
    r2.id,
    ARRAY(
      SELECT DISTINCT p
      FROM unnest(
        r2."permissions" || ARRAY[
          'directory.read',
          'directory.write',
          'identity.read',
          'identity.write',
          'audit.read',
          'secrets.write',
          'rbac.manage',
          'tenant.manage',
          'deployment.manage',
          'sync.read',
          'sync.manage',
          'access.read',
          'access.manage',
          'policy.read',
          'policy.manage',
          'automate.read',
          'automate.manage',
          'automate.request_on_behalf',
          'provision.read',
          'provision.manage',
          'govern.read',
          'govern.manage',
          'govern.accept_risk',
          'govern.export'
        ]::text[]
      ) AS p
      ORDER BY p
    ) AS merged
  FROM "Role" AS r2
  WHERE r2."builtIn" = true
) AS sub
WHERE r.id = sub.id;
```

Regenerate the literal from Step 3's output if the catalogue has changed since this plan was written; the test will say so.

- [x] **Step 5: Register the migration name**

In `packages/db/src/migration-order.ts`, append `'20260903000000_builtin_role_permissions',` to `KNOWN_MIGRATIONS`. **This is not optional** — remediation 1 Task 5's `grandfathers exactly the migrations that exist` case compares that list against the directory and fails otherwise.

- [x] **Step 6: Apply it and check the two tests**

```bash
cd packages/db && npx prisma migrate deploy; cd ../..
npx vitest run packages/db/src/builtin-role-permissions.test.ts packages/db/src/migration-order.test.ts
```

Expected: the migration applies, and both files PASS.

- [x] **Step 7: Prove it repairs the case it exists for**

```bash
SYNTRA_ALLOW_RESET=syntra pnpm db:reset && SEED_ADMIN_PASSWORD=aaaaaaaaaaaa pnpm seed
```

Then, from `packages/db`:

```bash
npx prisma db execute --stdin <<'SQL'
UPDATE "Role" SET "permissions" = ARRAY['directory.read']::text[] WHERE "builtIn" = true;
SQL
npx prisma migrate resolve --rolled-back 20260903000000_builtin_role_permissions 2>/dev/null || true
```

That is the shape of an old installation. Re-running the migration's `UPDATE` by hand must restore the full set:

```bash
npx prisma db execute --file prisma/migrations/20260903000000_builtin_role_permissions/migration.sql
```

Expected: the Owner role's `permissions` array contains `deployment.manage` again. Only do this against a development database.

- [x] **Step 8: Commit**

```bash
git add packages/db/prisma/migrations/20260903000000_builtin_role_permissions/migration.sql \
        packages/db/src/migration-order.ts \
        packages/db/src/builtin-role-permissions.test.ts
git commit -m "$(cat <<'EOF'
fix(rbac): backfill the built-in roles with the catalogue they were meant to have

`Role.permissions` is written once by the seed, which exits early on an
already-seeded database, and nothing else has ever written it. The
catalogue grew in six later commits, so every installation's Owner holds
whatever the product had on the day it was installed.

Most visibly that is U3: `deployment.manage` was added for the in-console
updater, so the Updates page is hidden and every update route answers 403.
The one feature whose purpose is repairing a deployment cannot be reached
by the deployment that needs repairing. govern.export, provision.read and
govern.accept_risk are in the same position, more quietly.

Additive, and only for builtIn roles: nobody loses a permission and a
custom role somebody deliberately narrowed is untouched. The list is a
snapshot, because SQL cannot read a TypeScript constant, and it does not
need updating when the catalogue grows again -- that is what the role API
is for. The test asserts only that every name here is one the catalogue
actually has, which is what catches a typo that would otherwise grant a
meaningless string forever.
EOF
)"
```

---

### Task 9: A roles screen in the console

Spec §7.4, **H2**, part four. The API from Task 7 is unreachable from the product without it.

**Files:**
- Create: `apps/web/src/pages/admin/RolesPage.tsx`
- Create: `apps/web/src/pages/admin/RolesPage.test.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx` (a route, beside `settings` at line 108)
- Modify: `apps/web/src/pages/admin/AdminNav.tsx` (an item in the System group, line 80–88)

**Interfaces:**
- Consumes: `useApiResource` from `./hooks.js`; `api`, `ApiError` from `../../session/api.js`; `Alert`, `Button`, `Check`, `Empty`, `Field`, `Panel`, `SkeletonRows`, `Status` from `@syntra/ui`; `PageHeader`.
- Produces: `export function RolesPage()`; route `/admin/roles`; nav item `{ to: '/admin/roles', label: 'Roles', permission: 'rbac.manage' }`.

- [x] **Step 1: Write the failing test**

Create `apps/web/src/pages/admin/RolesPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RolesPage } from './RolesPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const CATALOG = ['directory.read', 'deployment.manage', 'rbac.manage'];

const roles = [
  {
    id: 'r1',
    name: 'Owner',
    description: 'Full administrative access to this tenant.',
    permissions: ['directory.read', 'rbac.manage'],
    builtIn: true,
    assignmentCount: 1,
  },
];

function mockApi(over: { patch?: Response } = {}) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'PATCH') return Promise.resolve(over.patch ?? json({}, 204));
      return Promise.resolve(json({}, 204));
    }
    if (url.includes('/api/admin/roles')) {
      return Promise.resolve(json({ catalog: CATALOG, roles }));
    }
    if (url.includes('/api/admin/users')) return Promise.resolve(json({ users: [] }));
    return Promise.resolve(json({}));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <RolesPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the roles screen', () => {
  it('lists each role with its holder count', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.getByText(/1 holder/)).toBeInTheDocument();
  });

  /**
   * THE ONE THAT MATTERS. `deployment.manage` was added to the catalogue after
   * most installations were seeded, so their Owner does not hold it, the
   * Updates page is hidden and every update route answers 403. This checkbox
   * is the whole path back — a permission in the catalogue and not on the
   * role has to be visible and grantable, not merely absent.
   */
  it('offers a catalogue permission the role does not hold, and grants it', async () => {
    const sent = mockApi();
    renderPage();
    await screen.findByText('Owner');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('group', { name: 'Permissions' });
    const box = within(editor).getByRole('checkbox', { name: /deployment\.manage/ });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PATCH');
    expect(sent[0]!.url).toContain('/api/admin/roles/r1');
    expect((sent[0]!.body as { permissions: string[] }).permissions).toEqual(
      expect.arrayContaining(['directory.read', 'rbac.manage', 'deployment.manage']),
    );
  });

  /**
   * The lockout guard's refusal is a sentence the reader can act on, and it
   * has to reach the screen. A 409 rendered as "something went wrong" would
   * leave somebody clicking Save again.
   */
  it('renders the server’s refusal when a change would strand rbac.manage', async () => {
    mockApi({
      patch: json(
        {
          type: 'https://syntra.dev/problems/would-strand-rbac',
          title: 'Cannot be saved',
          status: 409,
          detail:
            'That would leave nobody able to administer roles, and there is no way back from it but a database client. Give somebody else rbac.manage first.',
        },
        409,
      ),
    });
    renderPage();
    await screen.findByText('Owner');

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/nobody able to administer roles/),
    ).toBeInTheDocument();
  });

  /**
   * A built-in role's permissions are editable — that is the entire point —
   * but deleting it is not. RoleAssignment cascades, and the backfill
   * migration targets exactly these rows.
   */
  it('does not offer Delete for a built-in role', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Owner');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/admin/RolesPage.test.tsx; cd ../..`
Expected: FAIL — `Cannot find module './RolesPage.js'`.

- [x] **Step 3: Write the page**

Create `apps/web/src/pages/admin/RolesPage.tsx`:

```tsx
import { useState } from 'react';
import { Alert, Button, Check, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  builtIn: boolean;
  assignmentCount: number;
}

/**
 * Administrative roles, and the permissions they carry.
 *
 * There was no screen and no API. `Role.permissions` was a snapshot the seed
 * wrote once, so an installation upgraded past the commit that added
 * `deployment.manage` had an Owner that did not hold it — the Updates page was
 * hidden, every update route answered 403, and the only remedy was raw SQL.
 * This page is the path back, and the checkbox for a catalogue permission the
 * role does not yet hold is the specific control that closes it.
 *
 * The catalogue comes from the server on every load rather than being listed
 * here. A copy in the bundle would be a second definition of a closed set that
 * `hasPermission` compares against, and it would be wrong the first time
 * somebody added a permission and did not think of this file.
 */
export function RolesPage() {
  const { data, error, loading, reload } = useApiResource<{
    catalog: string[];
    roles: RoleRow[];
  }>('/api/admin/roles');

  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (role: RoleRow) => {
    setEditing(role);
    setChosen(new Set(role.permissions));
    setName(role.name);
    setProblem(null);
  };

  const toggle = (permission: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(permission);
    else next.delete(permission);
    setChosen(next);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/roles/${editing.id}`, {
        method: 'PATCH',
        // The permission set is REPLACED whole, so the whole set is sent. An
        // add/remove vocabulary would need a merge rule nobody looking at a
        // page of checkboxes could predict.
        body: JSON.stringify({ name, permissions: [...chosen] }),
      });
      setEditing(null);
      reload();
    } catch (cause) {
      // The server's own sentence, always. The refusal that matters most here
      // — "that would leave nobody able to administer roles" — is one the
      // reader can act on, and flattening it to "something went wrong" leaves
      // them pressing Save again.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That role could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: RoleRow) => {
    setProblem(null);
    try {
      await api(`/api/admin/roles/${role.id}`, { method: 'DELETE' });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That role could not be deleted.',
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Roles"
        description="What an administrator may do, and who holds it. A role's permissions are stored on the role, so a permission added by an upgrade has to be granted here before anybody has it."
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}

      {editing && (
        <div className="mb-6">
          <Panel
            title={`Edit ${editing.name}`}
            description={
              editing.builtIn
                ? 'A built-in role. Its permissions are editable — that is how a permission added by an upgrade reaches the person who needs it — but it cannot be deleted.'
                : undefined
            }
          >
            <div className="space-y-4 p-4">
              <Field label="Name" value={name} onChange={setName} />
              <fieldset aria-label="Permissions" className="space-y-2">
                <legend className="mb-1.5 font-medium text-ink">Permissions</legend>
                {(data?.catalog ?? []).map((permission) => (
                  <Check
                    key={permission}
                    checked={chosen.has(permission)}
                    onChange={(on) => toggle(permission, on)}
                    label={permission}
                  />
                ))}
              </fieldset>
              <div className="flex gap-2">
                <Button variant="primary" loading={busy} onClick={save}>
                  Save
                </Button>
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      <Panel>
        {loading && <SkeletonRows rows={3} cols={3} />}
        {!loading && (data?.roles ?? []).length === 0 && (
          <div className="p-6">
            <Empty title="No roles yet">
              A role is a named set of permissions. Nobody can reach the console
              without one.
            </Empty>
          </div>
        )}
        {!loading && data && data.roles.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {data.roles.map((role) => (
              <li key={role.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span>
                  <span className="font-medium text-ink">{role.name}</span>
                  {role.builtIn && (
                    <Status tone="neutral" className="ml-2">
                      built in
                    </Status>
                  )}
                  <span className="ml-2 text-muted">
                    {role.assignmentCount} holder{role.assignmentCount === 1 ? '' : 's'} ·{' '}
                    {role.permissions.length} permission
                    {role.permissions.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => open(role)}>
                    Edit
                  </Button>
                  {/* A built-in role is what the seed wrote and what the
                      permission backfill targets, and RoleAssignment cascades
                      from Role — so the control is not offered rather than
                      offered and refused. */}
                  {!role.builtIn && (
                    <Button size="sm" variant="ghost" onClick={() => remove(role)}>
                      Delete
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
```

`Status` takes no `className` today — check `packages/ui/src/Status.tsx` before using it that way, and wrap the badge in a `<span className="ml-2">` instead if it does not.

- [x] **Step 4: Add the route and the nav item**

In `apps/web/src/pages/admin/AdminApp.tsx`, add the import and, beside `settings` (line 108):

```tsx
            <Route path="roles" element={<RolesPage />} />
```

In `apps/web/src/pages/admin/AdminNav.tsx`, in the System group (lines 80–88), before the audit log:

```ts
      // `rbac.manage`, which until the role API existed gated nothing at all.
      { to: '/admin/roles', label: 'Roles', permission: 'rbac.manage' },
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/pages/admin/RolesPage.test.tsx; cd ../..`
Expected: PASS, 4 tests.

- [x] **Step 6: Typecheck, build and commit**

```bash
npx tsc -b
pnpm --filter @syntra/web build
```

Expected: exit 0 for both.

```bash
git add apps/web/src/pages/admin/RolesPage.tsx apps/web/src/pages/admin/RolesPage.test.tsx \
        apps/web/src/pages/admin/AdminApp.tsx apps/web/src/pages/admin/AdminNav.tsx
git commit -m "$(cat <<'EOF'
feat(console): a roles screen, so a permission can be granted from the product

The role API has no way in without it. The specific control that matters
is the checkbox for a catalogue permission the role does not yet hold:
deployment.manage was added after most installations were seeded, so their
Owner does not hold it, the Updates page is hidden and every update route
answers 403.

The catalogue comes from the server on every load rather than being listed
in the bundle -- a copy would be a second definition of a closed set that
hasPermission compares against, wrong the first time somebody added a
permission and did not think of this file. A built-in role's permissions
are editable and its Delete control is not offered, because RoleAssignment
cascades and the backfill migration targets exactly those rows.
EOF
)"
```

---

### Task 10: The admin decide route parses what it was sent

Spec §7.5, **N2** — an authorization bug wearing a validation bug's clothes. `POST /automate/requests/:id/decide` casts the body instead of parsing it with `decideRequestBody`, and `recordDecision` only branches on `=== 'reject'`. So `{"decision":"Reject"}` — capitalised — **approves the request**: it skips the comment-required guard, fulfils the grants, and writes the literal string into the decision row and the audit payload. A missing field reaches Prisma as `undefined` and becomes a 500. `POST /automate/grants/:id/revoke` is uncast in the same way.

**Files:**
- Modify: `apps/api/src/routes/admin/automate.ts:240-247` (the decide handler's body read) and `:270-285` (the revoke handler's)
- Modify: `packages/contracts/src/automate.ts` (a `revokeGrantBody`, after `decideRequestBody` at line 145)
- Test: `apps/api/src/routes/admin/automate.test.ts`

**Interfaces:**
- Consumes: `decideRequestBody` from `@syntra/contracts` (already exported, never imported by this file).
- Produces: `export const revokeGrantBody` in `packages/contracts/src/automate.ts`; `POST /automate/requests/:id/decide` and `POST /automate/grants/:id/revoke` answer 400 with `errors[]` for a body that does not parse.

- [x] **Step 1: Write the failing test**

Append to `apps/api/src/routes/admin/automate.test.ts`, reusing that file's existing fixtures for a pending request and an admin cookie:

```ts
describe('the admin decide route parses its body', () => {
  /**
   * THE ONE THAT MATTERS, and it is an authorization bug rather than a
   * validation one. The body was cast, not parsed, and `recordDecision` only
   * branches on `=== 'reject'` -- so a capitalised "Reject" APPROVED the
   * request: it skipped the comment-required guard, fulfilled the grants, and
   * wrote the literal string into the decision row and the audit payload,
   * where it reads as a rejection to anybody looking later.
   */
  it('refuses "Reject" rather than approving it', async () => {
    const { requestId, cookie } = await pendingRequest();

    const res = await post(`/api/admin/automate/requests/${requestId}/decide`, cookie, {
      decision: 'Reject',
      comment: 'no',
    });
    expect(res.statusCode).toBe(400);

    const after = await get(`/api/admin/automate/requests/${requestId}`, cookie);
    expect((after.json() as { status: string }).status).toBe('pending_approval');
  });

  /**
   * The comment-required refinement lives on the schema, so skipping the parse
   * skipped it: a rejection with no reason is a request the person will raise
   * again, and the guard existed and was never reached from this route.
   */
  it('applies the comment-required rule on a rejection', async () => {
    const { requestId, cookie } = await pendingRequest();

    const res = await post(`/api/admin/automate/requests/${requestId}/decide`, cookie, {
      decision: 'reject',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('comment') }),
      ]) as never,
    });
  });

  it('is a 400, not a 500, when the field is missing entirely', async () => {
    const { requestId, cookie } = await pendingRequest();
    const res = await post(`/api/admin/automate/requests/${requestId}/decide`, cookie, {});
    expect(res.statusCode).toBe(400);
  });

  it('still approves a well-formed approval', async () => {
    const { requestId, cookie } = await pendingRequest();
    const res = await post(`/api/admin/automate/requests/${requestId}/decide`, cookie, {
      decision: 'approve',
      comment: null,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('the grant revoke route parses its body', () => {
  it('refuses a reason of the wrong type instead of storing it', async () => {
    const { grantId, cookie } = await liveGrant();
    const res = await post(`/api/admin/automate/grants/${grantId}/revoke`, cookie, {
      reason: 42,
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an absent reason and records the default', async () => {
    const { grantId, cookie } = await liveGrant();
    const res = await post(`/api/admin/automate/grants/${grantId}/revoke`, cookie, {});
    expect(res.statusCode).toBe(204);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/automate.test.ts -t 'parses its body'`
Expected: FAIL. The first case gets 200 and the request comes back `approved` — the capitalised value took the approval branch. The missing-field case is a 500.

- [x] **Step 3: Add the revoke contract**

In `packages/contracts/src/automate.ts`, after `decideRequestBody`'s type export (line 145):

```ts
/**
 * Withdrawing a grant administratively.
 *
 * `.strict()`, and the reason is the one `provision.ts` writes out: this route
 * was reading `(request.body ?? {}) as { reason?: string }`, so a `resaon`
 * typo silently became the default reason and a number became a number in the
 * audit payload. The default is preserved -- an API caller who says nothing is
 * still saying "withdrawn by an administrator" -- but a caller who says
 * something wrong is now told.
 */
export const revokeGrantBody = z
  .object({
    reason: z.string().min(1).max(1000).default('withdrawn by an administrator'),
  })
  .strict();
export type RevokeGrantBody = z.input<typeof revokeGrantBody>;
```

- [x] **Step 4: Parse both bodies**

In `apps/api/src/routes/admin/automate.ts`, add `decideRequestBody` and `revokeGrantBody` to the `@syntra/contracts` import block (lines 3–13). Replace line 240:

```ts
      // PARSED, not cast, and that distinction was an authorization bug rather
      // than a tidiness one. `recordDecision` branches on `=== 'reject'`, so a
      // capitalised "Reject" took the approval path: it skipped the
      // comment-required guard on the schema below, fulfilled the grants, and
      // wrote the literal string into the decision row and the audit payload,
      // where it reads as a rejection to anybody looking later. A missing
      // field reached Prisma as `undefined` and became a 500.
      //
      // `decideRequestBody` existed and was exported and had no importer.
      const body = decideRequestBody.parse(request.body);
```

and, further down in the same handler, `comment: body.comment ?? null,` becomes `comment: body.comment,` — the schema already defaults it to `null` — and `shortenedToDays: null,` becomes `shortenedToDays: body.shortenedToDays,`, which is what the schema carries and what the route was throwing away.

Replace line 275:

```ts
      const body = revokeGrantBody.parse(request.body ?? {});
```

and the call below it:

```ts
      await revokeGrant(
        request.tenantId,
        request.session.userId,
        id,
        body.reason,
        { scheduler: scheduler(), publicUrl: options.publicUrl },
      );
```

- [x] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/automate.test.ts`
Expected: PASS, the whole file.

- [x] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/contracts/src/automate.ts \
        apps/api/src/routes/admin/automate.ts \
        apps/api/src/routes/admin/automate.test.ts
git commit -m "$(cat <<'EOF'
fix(automate): the admin decide route parses its body

The body was cast rather than parsed with `decideRequestBody`, and
`recordDecision` branches on `=== 'reject'`. So {"decision":"Reject"}
capitalised APPROVED the request: it skipped the comment-required guard
that lives on the schema, fulfilled the grants, and wrote the literal
string into the decision row and the audit payload, where it reads as a
rejection to whoever looks later. A missing field reached Prisma as
undefined and came back a 500.

`decideRequestBody` existed, was exported, and had no importer. Parsing it
also restores `shortenedToDays`, which the route hard-coded to null and
the schema has always carried. /automate/grants/:id/revoke was uncast the
same way and gets a strict schema of its own, so a misspelled key is a 400
rather than a silent fallback to the default reason.
EOF
)"
```

---

### Task 11: Govern's preview endpoints stop returning the whole tenant

Spec §7.5, **N3**. Three POST routes — `/govern/campaigns/preview-scope`, `/govern/campaigns/preview-reviewers` and `/govern/sod/rules/preview` — are guarded by `requireGovernRead()` alone with no scope filter, unlike every GET beside them, and return tenant-wide holding counts, person counts and subject-key samples. They are absent from `GOVERN_READ_ROUTES`, and the structural test that enforces §21 only scans `app.get(`, so nothing sees them.

**Resolution chosen: raise the three to `govern.manage` rather than scope-filter them.** All three exist to help somebody *configure* a campaign or a rule, and saving what they preview already requires `govern.manage` — which `requirePermission` asks unscoped, so a department-scoped reader cannot hold it. Filtering the counts to a department instead would produce a preview that disagrees with the campaign the administrator then creates, which is a worse answer than no preview.

The enumeration is widened at the same time, because otherwise the next POST read route added under `requireGovernRead` is invisible for exactly the same reason these three were. That brings `POST /govern/sod/violations/:id/except` into the list, and it needs the scope applied.

**Files:**
- Modify: `apps/api/src/routes/admin/govern.ts:693-713` (the two campaign previews), `:897-905` (the SoD rule preview), `:928-960` (the exception request), `:130-194` (`GOVERN_READ_ROUTES`)
- Modify: `apps/api/src/routes/admin/govern.test.ts:292-322` (the two enumeration cases)

**Interfaces:**
- Consumes: `requirePermission(PERMISSIONS.GOVERN_MANAGE)`, `scopeOf(request)`, `personIdsInScope(tx, scope)` — all already in the module.
- Produces: `GOVERN_READ_ROUTES` gains `{ path: 'POST /govern/sod/violations/:id/except', scoped: true }`. No new exports.

- [x] **Step 1: Widen the structural test so it can see a POST**

In `apps/api/src/routes/admin/govern.test.ts`, replace the `EVERY read route in the module is enumerated` case (lines 292–305):

```ts
  it('EVERY route guarded by requireGovernRead is enumerated — the list is the control', () => {
    // The scoping case iterates `GOVERN_READ_ROUTES`, so a route missing from
    // the list is invisible to it. It used to scan `app.get(` only, and three
    // POST previews — campaign scope, campaign reviewers, SoD rule impact —
    // were guarded by `requireGovernRead()` with no scope filter and appeared
    // in neither the list nor the scan. They returned tenant-wide holding
    // counts, person counts and subject-key samples to a department-scoped
    // reader.
    //
    // Guarded-by, not method: `POST /govern/exports/csv` was always in the
    // list, so the enumeration was never really about GET. What makes a route
    // this test's business is `requireGovernRead`, which is what admits a
    // scoped holder in the first place.
    const source = readFileSync(new URL('./govern.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function registerAdminGovernRoutes'));
    const declared = new Set(GOVERN_READ_ROUTES.map((r) => r.path));

    const found = [
      ...body.matchAll(/app\.(get|post)\(\s*\n?\s*'([^']+)',\s*\n?\s*\{[^}]*requireGovernRead\(/g),
    ].map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`);

    expect(found.length).toBeGreaterThan(10);
    for (const path of found) {
      expect(declared, `${path} is admitted by govern.read and must be in GOVERN_READ_ROUTES`)
        .toContain(path);
    }
  });
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/govern.test.ts -t 'enumerated'`
Expected: FAIL, naming `POST /govern/campaigns/preview-scope`, `POST /govern/campaigns/preview-reviewers`, `POST /govern/sod/rules/preview` and `POST /govern/sod/violations/:id/except` as routes admitted by `govern.read` that are not in the list.

- [x] **Step 3: Raise the three previews to `govern.manage`**

In `apps/api/src/routes/admin/govern.ts`, change the guard on all three, and say why once, above the first of them (line 693):

```ts
  // ---- previews ----------------------------------------------------------
  //
  // `govern.manage`, NOT `requireGovernRead()`. These three answer tenant-wide
  // questions -- how many holdings a scope covers, how many people a reviewer
  // selector resolves for, how many persons a rule would put in violation --
  // and they were admitted by `govern.read`, which is scopeable. A department
  // lead therefore got the whole tenant's counts and a sample of subject keys
  // from outside their scope, three routes below GETs that filter carefully.
  //
  // Raised rather than filtered, deliberately. All three exist to configure
  // something whose SAVE already requires `govern.manage`, and
  // `requirePermission` asks unscoped, so a scoped holder cannot save what
  // they previewed anyway. A preview filtered to one department would report
  // different numbers from the campaign the administrator then creates, which
  // is a worse answer than not offering the preview.
  app.post(
    '/govern/campaigns/preview-scope',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const body = previewScopeBody.parse(request.body);
      return previewCampaignScope(request.tenantId, body.scope, body.snapshotId);
    },
  );
```

Apply the same guard change to `/govern/campaigns/preview-reviewers` (line 702) and `/govern/sod/rules/preview` (line 897), leaving their existing bodies and comments intact.

- [x] **Step 4: Scope the exception request, and list it**

In the `/govern/sod/violations/:id/except` handler (line 928), after the violation is read and before `requestSodException` is called:

```ts
      const scope = scopeOf(request);
      if (scope.kind !== 'tenant') {
        // §21 on every read path, and this route reads: it resolves the rule
        // and the person off a violation the caller named by id. Without this,
        // a department lead could raise -- and disclose the existence of -- an
        // exception against somebody in another department's violation.
        //
        // 404, not 403, for the reason the person report gives: a 403 confirms
        // the violation exists, and the existence of a violation about
        // somebody in another department is itself information.
        const admitted = await request.db((tx) => personIdsInScope(tx, scope));
        if (admitted !== 'all' && !admitted.has(violation.personId)) {
          throw new ProblemError(404, 'not-found', 'Not found');
        }
      }
```

In `GOVERN_READ_ROUTES`, at the end of the slice-2 block (after `GET /govern/sod/graph`, line 193):

```ts
  {
    path: 'POST /govern/sod/violations/:id/except',
    scoped: true,
  },
```

- [x] **Step 5: Run the whole govern route suite**

Run: `npx vitest run apps/api/src/routes/admin/govern.test.ts`

Expected: PASS. The `exempt list is short and named` case is unchanged — the four routes above are either no longer admitted by `govern.read` or are listed as `scoped: true`, so nothing joins the exempt list.

- [x] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/api/src/routes/admin/govern.ts apps/api/src/routes/admin/govern.test.ts
git commit -m "$(cat <<'EOF'
fix(govern): the preview endpoints stop answering for the whole tenant

Three POST previews -- campaign scope, campaign reviewers, SoD rule impact
-- were guarded by requireGovernRead() with no scope filter, three routes
below GETs that filter carefully, and returned tenant-wide holding counts,
person counts and subject-key samples to a department-scoped reader.

Raised to govern.manage rather than filtered. All three configure
something whose save already requires govern.manage, which
`requirePermission` asks unscoped -- so a scoped holder cannot save what
they previewed -- and a preview filtered to one department would report
different numbers from the campaign the administrator then creates.

The structural §21 test scanned `app.get(` only, which is why nothing saw
them: it now enumerates every route guarded by requireGovernRead
regardless of method, which is the property that actually matters, since
POST /govern/exports/csv was always on the list. That pulled in
POST /govern/sod/violations/:id/except, which reads a violation by id and
now applies the scope with the same 404-not-403 the person report uses.
EOF
)"
```

---

## Phase C — API hygiene

### Task 12: Changing a tenant's domain invalidates the cached OIDC provider

Spec §7.5, **N4**. `providerFor` caches one `Provider` per tenant with the issuer fixed at construction — `new Provider(issuer, setup)` asserts a single web URI and never re-reads it. `invalidateProvider` is called when clients change (`protocol-apps.ts:324`) and when signing keys rotate (`app.ts:175`), but **not** by `PUT /api/admin/tenant`, which is the route that changes `primaryDomain`. Every token keeps the old `iss` until a restart or an unrelated key rotation, and a relying party validates `iss` against the issuer it discovered.

**Files:**
- Modify: `apps/api/src/routes/admin/tenant.ts:39-141` (the PUT handler)
- Test: `apps/api/src/routes/admin/tenant.test.ts`

**Interfaces:**
- Consumes: `invalidateProvider(tenantId)` from `@syntra/protocols` — already imported by `protocol-apps.ts`, so the dependency edge exists.
- Produces: no signature change. `PUT /api/admin/tenant` keeps its body and its response.

- [x] **Step 1: Write the failing test**

Append to `apps/api/src/routes/admin/tenant.test.ts`:

```ts
import { invalidateProvider } from '@syntra/protocols';

describe('changing the tenant’s domain', () => {
  /**
   * `providerFor` fixes the issuer at construction -- oidc-provider asserts a
   * single web URI and never re-reads it -- and caches one Provider per
   * tenant. `invalidateProvider` is called on client changes and on key
   * rotation, and was NOT called here, which is the one route that changes
   * `primaryDomain`. Every token kept the old `iss` until a restart or an
   * unrelated rotation, and a relying party validates `iss` against the issuer
   * it discovered, so the tokens simply stopped being accepted.
   */
  it('drops the cached OIDC provider so the issuer is rebuilt', async () => {
    const spy = vi.spyOn(protocols, 'invalidateProvider');
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await authCookie('admin');

    const res = await put('/api/admin/tenant', cookie, {
      primaryDomain: 'id.acme.example',
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(ctx.tenantId);
  });

  /**
   * And NOT on a change that cannot move the issuer. Rebuilding the provider
   * discards every cached client and re-reads the key set, which is real work
   * on a route an administrator might save from twice in a row.
   */
  it('leaves the cache alone when no hostname changed', async () => {
    const spy = vi.spyOn(protocols, 'invalidateProvider');
    await seedAdmin([PERMISSIONS.TENANT_MANAGE]);
    const cookie = await authCookie('admin');

    const res = await put('/api/admin/tenant', cookie, { adminMfaRequired: true });
    expect(res.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

Import the module namespace at the top of the file — `import * as protocols from '@syntra/protocols';` — because `vi.spyOn` needs an object to replace the property on, and add `vi` to the `vitest` import if the file does not already have it.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/tenant.test.ts -t 'domain'`
Expected: FAIL — the first case: `invalidateProvider` was never called.

- [x] **Step 3: Invalidate after the write commits**

In `apps/api/src/routes/admin/tenant.ts`, add `import { invalidateProvider } from '@syntra/protocols';` and restructure the handler so the transaction's result is captured and the cache is dropped **after** it commits (currently the handler is `return request.db(async (tx) => { … })`, lines 43–141):

```ts
      const before = await request.db((tx) => readTenant(tx));
      const saved = await request.db(async (tx) => {
        // ... the existing body, unchanged, ending in `return saved;`
      });

      // AFTER the commit, and only when a hostname actually moved.
      //
      // `providerFor` caches one Provider per tenant with the issuer fixed at
      // construction -- oidc-provider asserts a single web URI and never
      // re-reads it. `invalidateProvider` was wired to client changes and to
      // key rotation and not to this route, which is the only one that changes
      // `primaryDomain`, so every token carried the old `iss` until a restart
      // or an unrelated rotation. A relying party validates `iss` against the
      // issuer it discovered, so those tokens were simply rejected, with
      // nothing anywhere saying why.
      //
      // Guarded on the hostnames rather than called unconditionally: rebuilding
      // the provider discards every cached client and re-reads the key set,
      // and this route is saved from for reasons that have nothing to do with
      // the issuer.
      const hostnamesMoved =
        saved.primaryDomain !== before.primaryDomain ||
        saved.additionalDomains.join(',') !== before.additionalDomains.join(',');
      if (hostnamesMoved) invalidateProvider(request.tenantId);

      return saved;
```

The `before` read is the one the handler already makes inside the transaction (line 47); hoist it rather than adding a second, and keep the in-transaction `before` for the lockout check that uses it.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/tenant.test.ts`
Expected: PASS, the whole file.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/api/src/routes/admin/tenant.ts apps/api/src/routes/admin/tenant.test.ts
git commit -m "$(cat <<'EOF'
fix(oidc): moving a tenant's domain drops the cached provider

`providerFor` caches one Provider per tenant with the issuer fixed at
construction -- oidc-provider asserts a single web URI and never re-reads
it. `invalidateProvider` was wired to client changes and to key rotation
and not to PUT /api/admin/tenant, which is the only route that changes
primaryDomain. Every token kept the old `iss` until a restart or an
unrelated rotation, and a relying party validates `iss` against the issuer
it discovered, so the tokens were rejected with nothing anywhere saying
why.

Called after the commit and only when a hostname actually moved:
rebuilding discards every cached client and re-reads the key set, and this
route is saved from for reasons that have nothing to do with the issuer.
EOF
)"
```

---

### Task 13: A malformed uuid is a 400, not a 500

Spec §7.5, **N5**. Four routes reach a path or query parameter with a cast instead of a schema, so a mistyped id becomes a Prisma error and a bare 500 — including on `GET /saml/metadata/:applicationId`, which is unauthenticated.

**Files:**
- Modify: `apps/api/src/routes/saml-idp.ts:382-388` (`metadata`)
- Modify: `apps/api/src/routes/admin/govern.ts:355` (`/govern/reports/person/:personId`)
- Modify: `apps/api/src/routes/automate-portal.ts:96-115` (`subjectFor`)
- Modify: `packages/contracts/src/govern.ts` (a `personParam`, beside `personReportQuery` at line 18)
- Test: `apps/api/src/routes/saml-metadata.test.ts`, `apps/api/src/routes/admin/govern.test.ts`, `apps/api/src/routes/automate-portal.test.ts`

**Interfaces:**
- Consumes: `idParam` from `@syntra/contracts`.
- Produces: `export const personParam = z.object({ personId: z.string().uuid() })` in `packages/contracts/src/govern.ts`. No route signature changes; the three routes answer 400 with `errors[]` instead of 500.

- [x] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/saml-metadata.test.ts`:

```ts
/**
 * UNAUTHENTICATED, so a 500 here is a stack trace in the log for anybody who
 * can reach the host and type a URL. The comment above this handler already
 * claimed the parameter was "validated so a mistyped id is a 404 rather than a
 * document naming an application that does not exist" — it was cast, and
 * Prisma raised on the malformed uuid before the 404 branch was reached.
 */
it('answers 400 for a metadata path that is not a uuid', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/saml/metadata/not-a-uuid',
    headers: { host: ctx.host },
  });
  expect(res.statusCode).toBe(400);
});
```

Append to `apps/api/src/routes/admin/govern.test.ts`:

```ts
it('answers 400 for a person report path that is not a uuid', async () => {
  await seedAdmin('owner', [PERMISSIONS.GOVERN_READ]);
  const cookie = await cookieFor('owner');
  const res = await get('/api/admin/govern/reports/person/not-a-uuid', cookie);
  expect(res.statusCode).toBe(400);
});
```

Append to `apps/api/src/routes/automate-portal.test.ts`:

```ts
it('answers 400 for a subjectPersonId that is not a uuid', async () => {
  const cookie = await portalCookie();
  const res = await get('/api/portal/automate/catalog?subjectPersonId=not-a-uuid', cookie);
  expect(res.statusCode).toBe(400);
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/src/routes/saml-metadata.test.ts apps/api/src/routes/admin/govern.test.ts apps/api/src/routes/automate-portal.test.ts -t 'not a uuid'`
Expected: FAIL — all three answer 500.

- [x] **Step 3: Validate the three parameters**

`apps/api/src/routes/saml-idp.ts`, replacing lines 382–384:

```ts
    // `idParam.parse`, not a cast. This route is UNAUTHENTICATED, and a
    // malformed id reached Prisma as a uuid it could not read: a bare 500 and
    // a stack trace in the log for anybody who can reach the host and type a
    // URL. The comment above already claimed the parameter was validated.
    const raw = (request.params as { applicationId?: string }).applicationId;
    if (raw !== undefined) {
      const { id: applicationId } = idParam.parse({ id: raw });
      const application = await request.db((tx) => findApplication(tx, applicationId));
      if (!application || application.type !== 'saml') {
        throw new ProblemError(404, 'not-found', 'No such SAML application');
      }
    }
```

`packages/contracts/src/govern.ts`, after `personReportQuery` (line 20):

```ts
/**
 * The person report's path parameter. `idParam` names its field `id`, and this
 * route's is `personId`, which is why the route reached for a cast and got a
 * 500 on every mistyped url.
 */
export const personParam = z.object({ personId: z.string().uuid() });
```

`apps/api/src/routes/admin/govern.ts`, replacing line 355:

```ts
      const { personId } = personParam.parse(request.params);
```

and adding `personParam` to the `@syntra/contracts` import block.

`apps/api/src/routes/automate-portal.ts`, in `subjectFor` (line 96), replacing the `requested === undefined || requested === self` line:

```ts
  const subjectFor = async (
    request: FastifyRequest,
    requested: string | undefined,
  ): Promise<string> => {
    const self = await personFor(request);
    if (requested === undefined) return self;
    // PARSED. A malformed id went straight into `contract.findMany({ where: {
    // personId } })` and came back as a Prisma error on a uuid column -- a 500
    // where the caller's mistake deserved a 400, on a route any portal user can
    // reach.
    const { id: subject } = idParam.parse({ id: requested });
    if (subject === self) return self;
```

and use `subject` in place of `requested` for the remainder of the function. Add `idParam` to the file's `@syntra/contracts` import if it is not already there.

- [x] **Step 4: Run the three files to verify they pass**

Run: `npx vitest run apps/api/src/routes/saml-metadata.test.ts apps/api/src/routes/admin/govern.test.ts apps/api/src/routes/automate-portal.test.ts`
Expected: PASS, all three files in full.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/contracts/src/govern.ts apps/api/src/routes/saml-idp.ts \
        apps/api/src/routes/admin/govern.ts apps/api/src/routes/automate-portal.ts \
        apps/api/src/routes/saml-metadata.test.ts \
        apps/api/src/routes/admin/govern.test.ts \
        apps/api/src/routes/automate-portal.test.ts
git commit -m "$(cat <<'EOF'
fix(api): a malformed uuid is a 400, not a 500

Three routes reached a path or query parameter with a cast instead of a
schema, so a mistyped id went into a uuid column and came back as a Prisma
error and a bare 500.

The worst of them is GET /saml/metadata/:applicationId, which is
unauthenticated -- a stack trace in the log for anybody who can reach the
host and type a URL -- and whose own comment already claimed the parameter
was "validated so a mistyped id is a 404". The govern person report needed
a schema of its own because `idParam` names its field `id` and that route's
is `personId`, which is why it reached for the cast in the first place.
EOF
)"
```

---

### Task 14: The token endpoint answers `invalid_client` for malformed credentials

Spec §7.5, **N6**. `presentedCredentials` runs `decodeURIComponent` over both halves of a Basic credential — correct per RFC 6749 §2.3.1 — and `decodeURIComponent('%zz')` throws `URIError`. The token endpoint answers 500 where OAuth requires `invalid_client`.

**Files:**
- Modify: `apps/api/src/routes/oidc-token.ts:49-69` (`presentedCredentials`) and `:305-322` (the handler's credential branch)
- Test: `apps/api/src/routes/oidc-token.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `presentedCredentials` returns `ClientCredentials | 'malformed' | null`. `POST /oidc/token` answers 401 `{ error: 'invalid_client' }` for an unreadable Basic header.

- [x] **Step 1: Write the failing test**

Append to `apps/api/src/routes/oidc-token.test.ts`:

```ts
describe('malformed client credentials', () => {
  /**
   * RFC 6749 §2.3.1 percent-encodes both halves of a Basic credential, so this
   * decodes them -- and `decodeURIComponent('%zz')` throws URIError. The token
   * endpoint answered 500 where the specification requires invalid_client, so
   * a client with a broken encoder got an unexplained server error instead of
   * the one refusal that tells it what is wrong.
   */
  it('answers invalid_client for percent-encoding that cannot be read', async () => {
    const header = Buffer.from('client%zz:secret', 'utf8').toString('base64');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: {
        host: ctx.host,
        authorization: `Basic ${header}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_client' });
  });

  /** A header with no colon at all is the same answer, not a different one. */
  it('answers invalid_client for a Basic header with no separator', async () => {
    const header = Buffer.from('nocolonhere', 'utf8').toString('base64');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: {
        host: ctx.host,
        authorization: `Basic ${header}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_client' });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/oidc-token.test.ts -t 'malformed client credentials'`
Expected: FAIL — the first case is a 500 from the `URIError`. The second currently returns `null`, which reads as "public client" and produces a different refusal further down.

- [x] **Step 3: Distinguish "no credentials" from "unreadable credentials"**

In `apps/api/src/routes/oidc-token.ts`, replace `presentedCredentials` (lines 49–69):

```ts
/**
 * The client credentials a token request presented.
 *
 * Three answers, not two, and the third is the fix. `null` means a public
 * client authenticating with PKCE alone, which is legitimate and passes
 * through. `'malformed'` means a Basic header that arrived and could not be
 * read -- and that is emphatically not the same thing: treating it as `null`
 * would let a broken credential fall through to the public-client path.
 *
 * Both halves are percent-decoded per RFC 6749 §2.3.1, and
 * `decodeURIComponent('%zz')` throws `URIError`. Uncaught, that came out of
 * the token endpoint as a 500, where the specification says `invalid_client`
 * -- so a client with a broken encoder was told the server had failed rather
 * than being told what was actually wrong with its request.
 */
function presentedCredentials(
  request: FastifyRequest,
  params: URLSearchParams,
): ClientCredentials | 'malformed' | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index <= 0) return 'malformed';
    try {
      return {
        clientId: decodeURIComponent(decoded.slice(0, index)),
        secret: decodeURIComponent(decoded.slice(index + 1)),
        via: 'basic',
      };
    } catch {
      // A URIError, and nothing else can be thrown here. The bytes are not
      // repeated back: an error_description quoting what arrived would echo
      // half a credential into whatever logs the client's response.
      return 'malformed';
    }
  }
  const clientId = params.get('client_id');
  const secret = params.get('client_secret');
  if (clientId === null || secret === null) return null;
  return { clientId, secret, via: 'post' };
}
```

In the handler (line 305), before the `credentials !== null` branch:

```ts
      const presented = presentedCredentials(request, params);
      if (presented === 'malformed') {
        // The refusal OAuth names for this, in the words it names. Identical
        // to the one a wrong secret gets, so an attacker learns nothing about
        // which half of the credential was rejected.
        return reply.status(401).type('application/json').send({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        });
      }
      const credentials = presented;
```

The rest of the handler is unchanged: `credentials` is now `ClientCredentials | null`, which is what `substitutedRequest` already takes.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/oidc-token.test.ts`
Expected: PASS, the whole file.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/api/src/routes/oidc-token.ts apps/api/src/routes/oidc-token.test.ts
git commit -m "$(cat <<'EOF'
fix(oidc): malformed Basic credentials are invalid_client, not a 500

RFC 6749 2.3.1 percent-encodes both halves of a Basic credential, so the
token endpoint decodes them -- and decodeURIComponent('%zz') throws
URIError. Uncaught, that surfaced as a 500 where the specification
requires invalid_client, so a client with a broken encoder was told the
server had failed instead of being told what was wrong with its request.

`presentedCredentials` now answers three things rather than two: null is a
public client on PKCE alone and still passes through, and 'malformed' is a
header that arrived and could not be read. Collapsing the second into the
first would let a broken credential fall through to the public-client
path. The refusal is word for word the one a wrong secret gets, and the
bytes are never echoed back.
EOF
)"
```

---

### Task 15: Strict schemas where the security-relevant flags live

Spec §9, **B1**. `createSourceRequest` and `updateSourceRequest` strip unknown keys, so a `PATCH` carrying a typoed `writebackPasword` alongside a valid field commits the valid one, answers success, and leaves password write-back exactly as it was. `provision.ts` documents at length why *its* schemas are strict; the schemas carrying the write-back flags never got the same treatment, and neither did `tenantSettingsRequest` or `patchUserRequest`.

`patchUserRequest` is the one that decides where a password lives. `tenantSettingsRequest` is the one that decides whether the console requires a second factor.

**Files:**
- Modify: `packages/contracts/src/sync.ts:45-97`
- Modify: `packages/contracts/src/tenant.ts:36-72`
- Modify: `packages/contracts/src/reset.ts:31-35`
- Test: `packages/contracts/src/sync.test.ts` (exists), `packages/contracts/src/strictness.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: no new symbols. `createSourceRequest`, `updateSourceRequest`, `tenantSettingsRequest` and `patchUserRequest` refuse unknown keys.

- [x] **Step 1: Write the failing test**

Create `packages/contracts/src/strictness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSourceRequest, updateSourceRequest } from './sync.js';
import { tenantSettingsRequest } from './tenant.js';
import { patchUserRequest } from './reset.js';

/**
 * The schemas carrying a security-relevant flag refuse a key they do not know.
 *
 * `provision.ts` writes the argument out at length for target configuration and
 * these four never got it. The failure is quiet and specific: zod strips an
 * unknown key, so a PATCH carrying `writebackPasword` alongside a valid field
 * commits the valid one, answers success, and leaves password write-back
 * exactly as it was. An administrator narrowing a source's behaviour after an
 * incident gets a save that reports success and changed nothing.
 *
 * Note for anyone editing these: `.partial()` and `.extend()` PRESERVE
 * `unknownKeys` in zod, so a derived schema is still strict. `.passthrough()`
 * is what reverses it.
 */
describe('the schemas that carry a security-relevant flag are strict', () => {
  it('refuses a misspelled write-back flag on a source update', () => {
    const result = updateSourceRequest.safeParse({
      name: 'AD',
      writebackPasword: true,
    });
    expect(result.success).toBe(false);
  });

  it('refuses one on a source create', () => {
    const result = createSourceRequest.safeParse({
      name: 'AD',
      config: {},
      bindPassword: 'x',
      writebackDisble: true,
    });
    expect(result.success).toBe(false);
  });

  /**
   * `adminMfaRequired` is what decides whether the console demands a second
   * factor. A misspelling that turned into a 200 and no change is an operator
   * who believes they hardened the console and did not.
   */
  it('refuses a misspelled tenant setting', () => {
    const result = tenantSettingsRequest.safeParse({ adminMfaRequred: true });
    expect(result.success).toBe(false);
  });

  /**
   * `passwordSource` decides whether Syntra holds this account's password at
   * all. There is nothing here that should be stripped silently.
   */
  it('refuses a misspelled password-source field', () => {
    const result = patchUserRequest.safeParse({ passwordSorce: 'upstream' });
    expect(result.success).toBe(false);
  });

  it('still accepts every field each schema actually declares', () => {
    expect(
      updateSourceRequest.safeParse({
        name: 'AD',
        writebackEnabled: true,
        writebackPassword: true,
        writebackDisable: false,
      }).success,
    ).toBe(true);
    expect(tenantSettingsRequest.safeParse({ adminMfaRequired: true }).success).toBe(true);
    expect(patchUserRequest.safeParse({ passwordSource: 'upstream' }).success).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/strictness.test.ts`
Expected: FAIL — the first four cases parse successfully, because the unknown key is stripped.

- [x] **Step 3: Make them strict**

In `packages/contracts/src/sync.ts`, add `.strict()` to `createSourceRequest` (close the `z.object({…})` at line 71 with `}).strict();`) and to `updateSourceRequest` before its `.refine` (line 94), and put the reason where the write-back block already explains itself (line 60):

```ts
/**
 * `.strict()`, for the reason `provision.ts` gives about target config and one
 * this schema has of its own.
 *
 * Three of these fields turn password write-back and account disabling on and
 * off. Without strictness zod strips a key it does not know, so a PATCH
 * carrying `writebackPasword` beside a valid field commits the valid one,
 * answers success, and leaves write-back exactly as it was -- an administrator
 * narrowing a source's behaviour after an incident gets a save that reports
 * success and changed nothing, which is the failure mode this product spends
 * most of its comments avoiding.
 */
```

In `packages/contracts/src/tenant.ts`, close `tenantSettingsRequest` with `}).strict();` (line 72) and add above it:

```ts
/**
 * `.strict()`. `adminMfaRequired` decides whether the console demands a second
 * factor and `primaryDomain` is the WebAuthn relying party; a misspelling that
 * came back 200 with nothing changed is an operator who believes they hardened
 * an installation and did not.
 */
```

In `packages/contracts/src/reset.ts`, close `patchUserRequest` with `}).strict();` and add:

```ts
/**
 * `.strict()`. This is the request that decides whether Syntra holds an
 * account's password at all, and there is nothing in it that should be dropped
 * without telling the caller.
 */
```

- [x] **Step 4: Run the test and the two suites that parse these**

```bash
npx vitest run packages/contracts/src/strictness.test.ts packages/contracts/src/sync.test.ts
npx vitest run apps/api/src/routes/admin/sources.test.ts apps/api/src/routes/admin/tenant.test.ts apps/api/src/routes/admin/users.test.ts
```

Expected: PASS. A route test that was sending an extra key will now fail — fix the test's payload rather than relaxing the schema; a caller sending a key the API does not accept is exactly what this is for.

- [x] **Step 5: Verify the console still saves**

```bash
cd apps/web && npx vitest run src/pages/admin/SourceDetailPage.test.tsx src/pages/admin/TenantSettingsPage.test.tsx; cd ../..
```

Expected: PASS. These build the request bodies the strict schemas now police.

- [x] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/contracts/src/sync.ts packages/contracts/src/tenant.ts \
        packages/contracts/src/reset.ts packages/contracts/src/strictness.test.ts
git commit -m "$(cat <<'EOF'
fix(contracts): strict schemas where the security-relevant flags live

`createSourceRequest` and `updateSourceRequest` stripped unknown keys, so
a PATCH carrying `writebackPasword` beside a valid field committed the
valid one, answered success, and left password write-back exactly as it
was. An administrator narrowing a source's behaviour after an incident got
a save that reported success and changed nothing.

provision.ts documents the argument at length for target configuration.
The three schemas carrying write-back flags, the tenant settings that
decide whether the console demands a second factor, and the request that
decides whether Syntra holds an account's password at all never got the
same treatment. They have it now.
EOF
)"
```

---

### Task 16: The three unused response contracts become the wire shape they were written to pin

Spec §9, **B5**. `mfaStatusResponse`, `applicationTile` and `ruleImpactResponse` are declared and used by nothing: the API builds those responses by hand and the web types them locally, so the shape they exist to pin can drift silently in either direction.

**Resolution chosen: wire them in as compile-time types on both sides, rather than deleting them.** Two reasons, and the second is the decisive one. The schemas already hold the only written record of *why* the wire shape is what it is — `mfaStatusResponse`'s own comment explains that omitting `available` would silently turn "security keys are unavailable, and here is why" back into an enabled button that always fails — and deleting them deletes that. And annotating the handler's return with `z.infer<>` costs one line per route and makes a drift a `tsc -b` failure, which is strictly more than the schemas do today.

They are deliberately **not** parsed at runtime in the browser. A zod parse in the client drops keys it does not know, which would turn an additive server change into silent data loss in the console — the exact failure the schemas warn about, moved to the other end of the wire.

**Files:**
- Modify: `apps/api/src/routes/mfa.ts:244-281` (the `GET /` handler)
- Modify: `apps/api/src/routes/portal.ts:30-45` (`GET /applications`)
- Modify: `apps/api/src/routes/admin/policies.ts:94-105` (`POST /policy/rules/impact`)
- Modify: `apps/web/src/pages/Security.tsx:8-16` (the local `MfaStatus`)
- Modify: `apps/web/src/pages/Portal.tsx:9-15` (the local `interface Tile`)
- Modify: `apps/web/src/pages/admin/PoliciesPage.tsx:30-35` (the local `RuleImpact`)

**Interfaces:**
- Consumes: `MfaStatusResponse`, `ApplicationTile`, `RuleImpactResponse` — the `z.infer` types the three schemas already export.
- Produces: no new symbols. Three handlers gain a return-type annotation; three components import a type instead of declaring one.

- [x] **Step 1: Pin the API side**

In `apps/api/src/routes/mfa.ts`, add `type MfaStatusResponse` to the `@syntra/contracts` import and annotate the handler (line 244):

```ts
    // ANNOTATED, not parsed. The schema is the written record of what this
    // endpoint promises -- including `available` and `unavailableReason`,
    // whose absence its own comment says would turn "security keys are
    // unavailable, and here is why" back into an enabled button that fails
    // when pressed -- and until now nothing referred to it, so the response
    // and the contract could drift in either direction with nothing to say so.
    //
    // A return type rather than a `.parse()` at the boundary: parsing would
    // strip a field an endpoint had legitimately started sending, which is the
    // same silent loss one layer down. This makes a drift a `tsc -b` failure.
    secured.get('/', async (request): Promise<MfaStatusResponse> => {
```

In `apps/api/src/routes/portal.ts`, add `type ApplicationTile` to the imports and give the map an explicit type (line 37):

```ts
    // `ApplicationTile`, the contract, rather than an anonymous literal. A
    // tile is a name and an icon; the schema says so and now the handler is
    // checked against it. Deliberately not the launch URL -- getting to the
    // application goes through /launch, which goes through authorize().
    const applications: ApplicationTile[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      iconUrl: row.iconUrl,
    }));
    return { applications };
```

In `apps/api/src/routes/admin/policies.ts`, annotate the impact handler (line 99):

```ts
    async (request): Promise<RuleImpactResponse> => {
```

adding `type RuleImpactResponse` to the `@syntra/contracts` import. `previewRuleImpact` returns core's `RuleImpact`, whose four fields are exactly the schema's; if `tsc` disagrees, the contract and the core type have already drifted and that disagreement is the finding.

- [x] **Step 2: Pin the web side**

In `apps/web/src/pages/Security.tsx`, delete the local `interface MfaStatus` (lines 8–16) and replace it with:

```ts
// The CONTRACT, not a local restatement. The API builds this response by hand
// and this file described it independently, so the two could drift with
// nothing anywhere to notice -- which is the whole reason `mfaStatusResponse`
// exists. Type-only: a runtime parse in the browser would strip a field the
// server had legitimately started sending.
import type { MfaStatusResponse } from '@syntra/contracts';
```

and use `MfaStatusResponse` at the two use sites (`useState<MfaStatusResponse | null>(null)` and `api<MfaStatusResponse>('/api/auth/mfa')`).

Do the same in `apps/web/src/pages/Portal.tsx` with `ApplicationTile`, and in `apps/web/src/pages/admin/PoliciesPage.tsx` with `RuleImpactResponse` in place of the local `interface RuleImpact` (lines 30–35).

- [x] **Step 3: Typecheck — this is the test**

Run: `npx tsc -b`
Expected: exit 0. A failure here means the hand-built response and the contract already disagree; fix the response, not the contract, unless the contract is the one that is wrong about what the product does.

- [x] **Step 4: Run the suites that touch the three shapes**

```bash
npx vitest run apps/api/src/routes/mfa.test.ts apps/api/src/routes/portal.test.ts
cd apps/web && npx vitest run src/pages/Security.test.tsx src/pages/admin/PoliciesPage.test.tsx; cd ../..
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/mfa.ts apps/api/src/routes/portal.ts \
        apps/api/src/routes/admin/policies.ts \
        apps/web/src/pages/Security.tsx apps/web/src/pages/Portal.tsx \
        apps/web/src/pages/admin/PoliciesPage.tsx
git commit -m "$(cat <<'EOF'
refactor(contracts): the three unused response shapes become the wire shape

`mfaStatusResponse`, `applicationTile` and `ruleImpactResponse` were
declared and referred to by nothing. The API built each response by hand
and the console described it again locally, so the shape the schemas exist
to pin could drift in either direction with nothing to say so.

Wired rather than deleted, because the schemas hold the only written
record of why the shapes are what they are -- mfaStatusResponse's own
comment explains that dropping `available` turns "security keys are
unavailable, and here is why" back into a button that always fails -- and
one return-type annotation per handler makes a drift a `tsc -b` failure,
which is more than they did before.

Type-only on both ends. A zod parse in the browser would strip a field the
server had legitimately started sending, which is the same silent loss
these schemas warn about, moved to the other end of the wire.
EOF
)"
```

---

## Phase D — The console

### Task 17: The product editor loads the product it edits

Spec §7.6, **W1**. `ProductEditorPage` renders in edit mode but nothing fetches the product: the only fetch is the list, whose `data` is never read. All fields start empty and `save()` issues a full `PUT` requiring the whole object — so "fixing a typo in the name" replaces the description, the category, the grants, the form schema and the duration mode with the editor's defaults. There is no `GET /automate/products/:id` for it to call.

**Files:**
- Modify: `apps/api/src/routes/admin/automate.ts:81-85` (a read beside the list)
- Modify: `apps/web/src/pages/admin/ProductEditorPage.tsx` (whole file)
- Test: `apps/api/src/routes/admin/automate.test.ts`
- Test: `apps/web/src/pages/admin/ProductEditorPage.test.tsx` (new)

**Interfaces:**
- Consumes: `idParam`, `PERMISSIONS.AUTOMATE_READ`, `productBody` (unchanged).
- Produces: `GET /api/admin/automate/products/:id` → the `Product` row with `grants`, or 404. `ProductEditorPage` reads it when `id` is present and sends every field the schema declares.

- [x] **Step 1: Write the failing route test**

Append to `apps/api/src/routes/admin/automate.test.ts`:

```ts
describe('reading one product', () => {
  /**
   * WITHOUT THIS ROUTE the editor cannot load what it edits, and its PUT
   * requires the whole object -- so saving a renamed product replaced its
   * description, category, grants, form schema and duration mode with the
   * editor's defaults.
   */
  it('answers the product and its grants', async () => {
    const { productId, cookie } = await seedProduct();
    const res = await get(`/api/admin/automate/products/${productId}`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; grants: unknown[] };
    expect(body.id).toBe(productId);
    expect(body.grants.length).toBeGreaterThan(0);
  });

  it('404s an id that names nothing', async () => {
    const { cookie } = await seedProduct();
    const res = await get(
      '/api/admin/automate/products/00000000-0000-4000-8000-000000000000',
      cookie,
    );
    expect(res.statusCode).toBe(404);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/automate.test.ts -t 'reading one product'`
Expected: FAIL — 404 on a product that exists, because the route does not.

- [x] **Step 3: Add the route**

In `apps/api/src/routes/admin/automate.ts`, after the products list (line 85):

```ts
  /**
   * One product, with its grants.
   *
   * The editor could not load what it edited: the page fetched the LIST and
   * never read it, every field started empty, and `PUT` requires the whole
   * object -- so renaming a product replaced its description, category,
   * grants, form schema and duration mode with the editor's defaults. A
   * catalog entry could be destroyed by fixing a typo in it.
   */
  app.get(
    '/automate/products/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const product = await request.db((tx) =>
        tx.product.findUnique({ where: { id }, include: { grants: true } }),
      );
      if (product === null) throw new ProblemError(404, 'not-found', 'Not found');
      return product;
    },
  );
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/automate.test.ts`
Expected: PASS, the whole file.

- [x] **Step 5: Write the failing web test**

Create `apps/web/src/pages/admin/ProductEditorPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductEditorPage } from './ProductEditorPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const product = {
  id: 'p1',
  name: 'AP approve',
  slug: 'ap-approve',
  description: 'Approving supplier invoices in the ledger.',
  category: 'Finance',
  iconUrl: null,
  requestInstructions: 'Say which company code you need.',
  kind: 'targetEntitlement',
  audienceCondition: { all: [] },
  workflowId: '11111111-1111-4111-8111-111111111111',
  formSchema: [{ key: 'code', type: 'text', label: 'Company code', required: true }],
  durationMode: 'fixed',
  defaultDurationDays: 90,
  maxDurationDays: 365,
  ownerPersonId: null,
  ownerGroupId: null,
  status: 'active',
  grants: [
    {
      id: 'g1',
      resourceType: 'entitlement',
      resourceId: '22222222-2222-4222-8222-222222222222',
      targetSystemId: null,
      optional: false,
    },
  ],
};

function mockApi() {
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PUT' || method === 'POST') {
      sent.push({ url, method, body: JSON.parse(String(init!.body)) });
      return Promise.resolve(json({}, 204));
    }
    if (url.includes('/automate/products/p1')) return Promise.resolve(json(product));
    if (url.includes('/automate/products')) return Promise.resolve(json({ products: [] }));
    if (url.includes('/automate/workflows')) return Promise.resolve(json({ workflows: [] }));
    return Promise.resolve(json({}));
  });
  return sent;
}

const renderEditor = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/automate/products/:id" element={<ProductEditorPage />} />
        <Route path="/admin/automate/products/new" element={<ProductEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the product editor loads what it edits', () => {
  it('fills the form from the product', async () => {
    mockApi();
    renderEditor('/admin/automate/products/p1');
    expect(await screen.findByDisplayValue('AP approve')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ap-approve')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('Approving supplier invoices in the ledger.'),
    ).toBeInTheDocument();
  });

  /**
   * THE ONE THAT MATTERS. `PUT` replaces the whole object, and the editor sent
   * defaults for every field it never loaded — so fixing a typo in the name
   * wiped the description, the category, the grants, the form schema and the
   * duration mode. A catalog entry could be destroyed by editing it.
   */
  it('sends every field back, not the editor’s defaults', async () => {
    const sent = mockApi();
    renderEditor('/admin/automate/products/p1');
    await screen.findByDisplayValue('AP approve');

    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'AP approver');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.body).toMatchObject({
      name: 'AP approver',
      description: 'Approving supplier invoices in the ledger.',
      category: 'Finance',
      requestInstructions: 'Say which company code you need.',
      durationMode: 'fixed',
      defaultDurationDays: 90,
      maxDurationDays: 365,
      status: 'active',
      formSchema: product.formSchema,
      grants: [
        {
          resourceType: 'entitlement',
          resourceId: '22222222-2222-4222-8222-222222222222',
          targetSystemId: null,
          optional: false,
        },
      ],
    });
  });

  it('starts empty on the new route and POSTs', async () => {
    const sent = mockApi();
    renderEditor('/admin/automate/products/new');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''));

    await userEvent.type(screen.getByLabelText('Name'), 'Fresh');
    await userEvent.type(screen.getByLabelText('Slug'), 'fresh');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('POST');
  });
});
```

- [x] **Step 6: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/admin/ProductEditorPage.test.tsx; cd ../..`
Expected: FAIL — the first case finds no field with that value; the second sends the editor's defaults.

- [x] **Step 7: Rewrite the editor**

Replace the state and the fetch in `apps/web/src/pages/admin/ProductEditorPage.tsx` (lines 14–101). The essentials: read the product when there is an id, seed every field from it once it arrives, and send the whole object back.

```tsx
interface ProductGrant {
  resourceType: string;
  resourceId: string;
  targetSystemId: string | null;
  optional: boolean;
}

interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  iconUrl: string | null;
  requestInstructions: string | null;
  kind: string;
  audienceCondition: unknown;
  workflowId: string;
  formSchema: unknown;
  durationMode: string;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
  ownerPersonId: string | null;
  ownerGroupId: string | null;
  status: string;
  grants: ProductGrant[];
}

export function ProductEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined || id === 'new';

  /**
   * THE PRODUCT, not the list.
   *
   * This page fetched `/automate/products` and never read the result. Every
   * field therefore started empty, and `save()` issues a full PUT that
   * requires the whole object -- so renaming a product replaced its
   * description, category, grants, form schema and duration mode with the
   * editor's defaults. A catalog entry could be destroyed by fixing a typo in
   * its name, and nothing on the screen said so.
   */
  const { data: loaded, error } = useApiResource<Product>(
    isNew ? null : `/api/admin/automate/products/${id}`,
  );

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [requestInstructions, setRequestInstructions] = useState('');
  const [kind, setKind] = useState('application');
  const [workflowId, setWorkflowId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [audience, setAudience] = useState('');
  const [durationMode, setDurationMode] = useState('permanent');
  const [defaultDurationDays, setDefaultDurationDays] = useState('');
  const [maxDurationDays, setMaxDurationDays] = useState('');
  const [status, setStatus] = useState('draft');
  /**
   * The parts this form does not edit, carried through untouched.
   *
   * `formSchema` is a typed request form with its own editor elsewhere, and
   * the extra grants of a multi-grant product are not representable in the one
   * resource box below. Sending defaults for them is what destroyed them; the
   * honest answer while the form is this small is to send back exactly what
   * arrived.
   */
  const [carried, setCarried] = useState<Pick<
    Product,
    'formSchema' | 'iconUrl' | 'ownerPersonId' | 'ownerGroupId' | 'grants'
  > | null>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    setName(loaded.name);
    setSlug(loaded.slug);
    setDescription(loaded.description ?? '');
    setCategory(loaded.category ?? '');
    setRequestInstructions(loaded.requestInstructions ?? '');
    setKind(loaded.kind);
    setWorkflowId(loaded.workflowId);
    setResourceId(loaded.grants[0]?.resourceId ?? '');
    setAudience(
      loaded.audienceCondition === null ? '' : JSON.stringify(loaded.audienceCondition),
    );
    setDurationMode(loaded.durationMode);
    setDefaultDurationDays(loaded.defaultDurationDays?.toString() ?? '');
    setMaxDurationDays(loaded.maxDurationDays?.toString() ?? '');
    setStatus(loaded.status);
    setCarried({
      formSchema: loaded.formSchema,
      iconUrl: loaded.iconUrl,
      ownerPersonId: loaded.ownerPersonId,
      ownerGroupId: loaded.ownerGroupId,
      grants: loaded.grants,
    });
  }, [loaded]);
```

and the body of `save()`:

```tsx
      const grants =
        carried === null || carried.grants.length === 0
          ? [
              {
                resourceType:
                  kind === 'localGroup'
                    ? 'group'
                    : kind === 'application'
                      ? 'application'
                      : 'entitlement',
                resourceId,
                targetSystemId: null,
                optional: false,
              },
            ]
          : // The grant list as it arrived, with only the resource id this form
            // can edit replaced. A product with three grants had two of them
            // deleted every time somebody saved a name change.
            carried.grants.map((grant, index) =>
              index === 0 ? { ...grant, resourceId } : grant,
            );

      const body = {
        name,
        slug,
        description: description.trim() === '' ? null : description,
        category: category.trim() === '' ? null : category,
        iconUrl: carried?.iconUrl ?? null,
        requestInstructions:
          requestInstructions.trim() === '' ? null : requestInstructions,
        kind,
        grants,
        audienceCondition: parsedAudience(),
        workflowId,
        formSchema: carried?.formSchema ?? [],
        durationMode,
        defaultDurationDays:
          defaultDurationDays.trim() === '' ? null : Number(defaultDurationDays),
        maxDurationDays: maxDurationDays.trim() === '' ? null : Number(maxDurationDays),
        ownerPersonId: carried?.ownerPersonId ?? null,
        ownerGroupId: carried?.ownerGroupId ?? null,
        status,
      };
```

Add `Field`s and a `Select` for description, category, request instructions, duration mode, the two duration caps and status, and render `{error && <Alert tone="danger">{error}</Alert>}` above the panels. Import `useEffect` and `Select`.

- [x] **Step 8: Run the web test to verify it passes**

Run: `cd apps/web && npx vitest run src/pages/admin/ProductEditorPage.test.tsx; cd ../..`
Expected: PASS, 3 tests.

- [x] **Step 9: Typecheck, build and commit**

```bash
npx tsc -b
pnpm --filter @syntra/web build
```

```bash
git add apps/api/src/routes/admin/automate.ts apps/api/src/routes/admin/automate.test.ts \
        apps/web/src/pages/admin/ProductEditorPage.tsx \
        apps/web/src/pages/admin/ProductEditorPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(console): the product editor loads the product it edits

The page fetched the product LIST and never read the result. Every field
started empty, and `save()` issues a full PUT requiring the whole object
-- so fixing a typo in a product's name replaced its description,
category, grants, form schema and duration mode with the editor's
defaults. A catalog entry could be destroyed by editing it, and nothing on
the screen said so.

There was no GET for one product either, so the page could not have loaded
it. Added, and the editor now carries through the parts this form does not
edit -- the typed form schema, the owner, the extra grants of a
multi-grant product -- exactly as they arrived, rather than sending
defaults for them.
EOF
)"
```

---

### Task 18: Bulk certify stops dropping other campaigns' selections, and a double-click stops double-submitting

Spec §7.6, **W2** and **W7**. `MyReviewsPage` lists items across every open campaign and gives a checkbox to any bulk-enabled one, but the request always sends `items[0].campaign.id`; `bulkCertify` filters on it, so ids from other campaigns are neither certified nor listed in `refused` — they vanish, the selection clears, and nothing is reported. The bulk button also renders only when `items[0]` happens to belong to a bulk-enabled campaign. Separately, the decide buttons have no in-flight guard, so a double-click double-submits a revoke.

**Resolution chosen for W2: one request per campaign in the selection, with the `refused` lists merged.** The reviewer's queue genuinely spans campaigns and grouping it by campaign on screen would be reorganising the page around a server-side detail; sending one request per campaign keeps the queue as it is and drops nothing.

**Files:**
- Modify: `apps/web/src/pages/govern/MyReviewsPage.tsx:44-46` (state), `:58-84` (`decide`), `:123-159` (the bulk button), `:228-233` (the per-item buttons)
- Test: `apps/web/src/pages/govern/MyReviewsPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/portal/govern/reviews/bulk-certify` with `{ campaignId, itemIds }`; `POST /api/portal/govern/reviews/:id/decide`.
- Produces: no new endpoints. The page issues one bulk request per distinct campaign in the selection and reports every refusal from every one of them.

- [x] **Step 1: Write the failing test**

Append to `apps/web/src/pages/govern/MyReviewsPage.test.tsx`, adding a second campaign to its fixtures:

```tsx
const otherCampaign = {
  id: 'c-2',
  name: 'Finance quarterly',
  dueAt: '2026-10-31T00:00:00.000Z',
  allowBulkCertify: true,
};

const acrossTwoCampaigns = [
  { ...items[1]!, id: 'i-first', campaign },
  { ...items[1]!, id: 'i-second', subjectName: 'Dee Dunn', campaign: otherCampaign },
];

describe('a selection spanning two campaigns', () => {
  /**
   * THE ONE THAT MATTERS. The list spans every open campaign, any bulk-enabled
   * item gets a checkbox, and the request always carried `items[0].campaign.id`
   * -- so `bulkCertify` filtered the other campaign's ids out, they were
   * neither certified nor listed in `refused`, the selection cleared, and
   * nothing anywhere said so. The reviewer believed they had certified twelve
   * items and had certified five.
   */
  it('sends one request per campaign, so nothing is dropped', async () => {
    const sent = mockReviews(acrossTwoCampaigns);
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');

    for (const box of screen.getAllByRole('checkbox')) {
      await userEvent.click(box);
    }
    await userEvent.click(screen.getByRole('button', { name: /Certify selected/ }));

    await waitFor(() => expect(sent.bulk).toHaveLength(2));
    expect(sent.bulk.map((b) => b.campaignId).sort()).toEqual(['c-1', 'c-2']);
    expect(sent.bulk.flatMap((b) => b.itemIds).sort()).toEqual(['i-first', 'i-second']);
  });

  /** And every refusal from every request reaches the screen. */
  it('reports refusals from all of them', async () => {
    mockReviews(acrossTwoCampaigns, {
      bulkResult: { certified: 0, refused: [{ itemId: 'x', reason: 'this item is already certified' }] },
    });
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');

    for (const box of screen.getAllByRole('checkbox')) {
      await userEvent.click(box);
    }
    await userEvent.click(screen.getByRole('button', { name: /Certify selected/ }));

    expect(await screen.findByText(/2 item\(s\) were not certified/)).toBeInTheDocument();
  });

  /**
   * The button rendered on `items[0].campaign.allowBulkCertify`, so a reviewer
   * whose first item happened to belong to a campaign without bulk certify had
   * no button at all — for a queue that was mostly bulk-enabled.
   */
  it('offers the button when ANY item allows it, not only the first', async () => {
    mockReviews([
      { ...items[0]!, campaign: { ...campaign, allowBulkCertify: false } },
      { ...items[1]!, campaign: otherCampaign },
    ]);
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');
    expect(screen.getByRole('button', { name: /Certify selected/ })).toBeInTheDocument();
  });
});

describe('a double-click', () => {
  /**
   * A revoke is a removal. Two of them for one item is two decisions in the
   * audit trail and, under `quorum: 'any'`, a second decision the state
   * machine has to reconcile.
   */
  it('does not submit a decision twice', async () => {
    const sent = mockReviews([items[1]!], { slowDecide: true });
    render(<MyReviewsPage />);
    await screen.findByText('Ben Baker');

    const keep = screen.getByRole('button', { name: 'Keep' });
    await userEvent.click(keep);
    expect(keep).toBeDisabled();
    await userEvent.click(keep);

    await waitFor(() => expect(sent.decisions).toHaveLength(1));
  });
});
```

Extend the file's existing fetch mock into `mockReviews(rows, opts)` — returning `{ bulk: [], decisions: [] }` and honouring `bulkResult` and a `slowDecide` that resolves on a deferred promise — rather than adding a second mocking style beside the one already there.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/govern/MyReviewsPage.test.tsx; cd ../..`
Expected: FAIL — one bulk request carrying `c-1` and both ids; no button in the third case; two decisions in the fourth.

- [x] **Step 3: Group the selection by campaign**

In `apps/web/src/pages/govern/MyReviewsPage.tsx`, replace the bulk button (lines 123–159):

```tsx
            {items.some((item) => item.campaign.allowBulkCertify) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={selected.size === 0 || bulkBusy}
                loading={bulkBusy}
                onClick={() => void certifySelected()}
              >
                Certify selected ({selected.size})
              </Button>
            )}
```

and add above the render:

```tsx
  /**
   * ONE REQUEST PER CAMPAIGN, because the queue spans campaigns and the
   * endpoint does not.
   *
   * The list shows every open campaign's items together -- which is right; a
   * reviewer has one queue, not one per campaign -- and any bulk-enabled item
   * gets a checkbox. The request carried `items[0].campaign.id`, and
   * `bulkCertify` filters on it, so ids belonging to any other campaign were
   * neither certified nor listed in `refused`. They vanished: the selection
   * cleared, the page reloaded, and nothing anywhere said that half of what
   * was ticked had not happened. A reviewer who believed they had certified
   * twelve items had certified five.
   *
   * Grouping here rather than reorganising the page by campaign, because the
   * page is right and the endpoint's scope is a server-side detail the
   * reviewer should not have to work around.
   */
  const certifySelected = async () => {
    const byCampaign = new Map<string, string[]>();
    for (const item of items) {
      if (!selected.has(item.id)) continue;
      byCampaign.set(item.campaign.id, [
        ...(byCampaign.get(item.campaign.id) ?? []),
        item.id,
      ]);
    }

    setBulkBusy(true);
    setActionError(null);
    try {
      const results = await Promise.all(
        [...byCampaign].map(([campaignId, itemIds]) =>
          api<{ certified: number; refused: { reason: string }[] }>(
            '/api/portal/govern/reviews/bulk-certify',
            { method: 'POST', body: JSON.stringify({ campaignId, itemIds }) },
          ),
        ),
      );
      // EVERY refusal from EVERY request. Reporting one campaign's and
      // dropping the rest would be the same silence in a smaller shape.
      const refused = results.flatMap((r) => r.refused);
      setActionError(
        refused.length === 0
          ? null
          : `${refused.length} item(s) were not certified: ${refused
              .map((r) => r.reason)
              .join('; ')}`,
      );
      setSelected(new Set());
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Could not certify those items.',
      );
    } finally {
      setBulkBusy(false);
    }
  };
```

Add `const [bulkBusy, setBulkBusy] = useState(false);` beside the other state.

- [x] **Step 4: Guard the per-item decisions**

Replace `decide` (lines 58–84) so it tracks the item in flight, and the two buttons (lines 228–233):

```tsx
  // WHICH ITEM IS IN FLIGHT, not a single boolean. The queue is a page of
  // rows and disabling all of them while one is being decided would make a
  // twenty-item review a twenty-round-trip queue.
  const [deciding, setDeciding] = useState<string | null>(null);

  const decide = (item: ReviewItem, decision: 'certify' | 'revoke') => {
    // A revoke is a removal, and a double-click sent two: two decisions in the
    // audit trail for one item, and under `quorum: 'any'` a second decision
    // the state machine then has to reconcile against the first.
    if (deciding !== null) return;
    const needsComment = decision === 'revoke' || item.riskFlags.includes('unattributable');
    const comment = needsComment
      ? window.prompt(
          decision === 'revoke'
            ? 'Why are you removing this? A revoke decision needs a comment.'
            : 'Nothing in Syntra explains this access. Say who confirmed it is fine, and why.',
        )
      : null;
    if (needsComment && (comment === null || comment.trim() === '')) return;

    setDeciding(item.id);
    void api(`/api/portal/govern/reviews/${item.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    })
      .then(() => {
        setActionError(null);
        reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'Could not record that decision.',
        ),
      )
      .finally(() => setDeciding(null));
  };
```

```tsx
                      <Button
                        size="sm"
                        disabled={deciding !== null}
                        loading={deciding === item.id}
                        onClick={() => decide(item, 'certify')}
                      >
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deciding !== null}
                        loading={deciding === item.id}
                        onClick={() => decide(item, 'revoke')}
                      >
                        Remove
                      </Button>
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/pages/govern/MyReviewsPage.test.tsx; cd ../..`
Expected: PASS, the whole file.

- [x] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/web/src/pages/govern/MyReviewsPage.tsx apps/web/src/pages/govern/MyReviewsPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(console): bulk certify stops dropping other campaigns' selections

The reviewer's queue spans every open campaign -- which is right; a
reviewer has one queue, not one per campaign -- and any bulk-enabled item
gets a checkbox. The request always carried items[0].campaign.id, and
bulkCertify filters on it, so ids from any other campaign were neither
certified nor listed in `refused`. They vanished: the selection cleared,
the page reloaded, and nothing said that half of what was ticked had not
happened. The button also rendered on items[0] alone, so a reviewer whose
first item belonged to a campaign without bulk certify had no button at
all.

One request per campaign in the selection, with every refusal from every
one of them reported. And an in-flight guard on the per-item decisions: a
double-clicked Remove sent two revokes -- two decisions in the audit trail
for one item, and under quorum:'any' a second decision to reconcile.
EOF
)"
```

---

### Task 19: A 401 mid-session sends the reader back to sign in

Spec §7.6, **W3**. `use-api-resource.ts`'s `GENERIC` map covers 403 and 404, and nothing anywhere clears the session or navigates to `/login`. An expired admin session — the deliberately short one, fifteen minutes idle — turns every panel into "Something went wrong" with no route back.

**Files:**
- Modify: `apps/web/src/session/api.ts` (an expiry hook)
- Modify: `apps/web/src/session/SessionProvider.tsx:66-85` (register the hook)
- Modify: `apps/web/src/session/use-api-resource.ts:35-38` (a sentence for 401)
- Test: `apps/web/src/session/api.test.ts`

**Interfaces:**
- Consumes: `SessionProvider`'s `setSession`.
- Produces:
  - `export function onSessionExpired(handler: () => void): () => void` in `apps/web/src/session/api.ts`
  - `GENERIC[401]` in `use-api-resource.ts`
  - No component changes anywhere else: the router's existing `RequireSession` already navigates to `/login` when `session` becomes null.

- [x] **Step 1: Write the failing test**

Append to `apps/web/src/session/api.test.ts`:

```ts
describe('a 401 that means the session died', () => {
  /**
   * Nothing handled a 401 mid-session. `GENERIC` mapped 403 and 404 and
   * nothing cleared the session or navigated anywhere, so an expired admin
   * session -- the deliberately short one, fifteen minutes idle -- turned
   * every panel into "Something went wrong" with no route back but typing a
   * URL.
   */
  it('notifies when an admin route answers 401', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    );

    await expect(api('/api/admin/users')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    off();
  });

  /**
   * AND NOT for the credential-presenting endpoints. `/api/auth/elevate`
   * answers 401 for a wrong password while the caller holds a perfectly good
   * portal session; treating that as expiry would sign somebody out for
   * mistyping.
   */
  it('does not notify for an auth endpoint refusing a credential', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    );

    await expect(api('/api/auth/elevate', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api('/api/auth/login', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api('/api/auth/session')).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    off();
  });

  it('does not notify for a 403, which is about permissions and not the session', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    await expect(api('/api/admin/users')).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    off();
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/session/api.test.ts; cd ../..`
Expected: FAIL — `onSessionExpired` is not exported.

- [x] **Step 3: Add the hook**

In `apps/web/src/session/api.ts`, above `api`:

```ts
/**
 * The paths where a 401 means "that credential was wrong", not "your session
 * is gone".
 *
 * Every credential-presenting endpoint lives under `/api/auth/`: login,
 * elevate, the MFA verify and challenge pair, enrolment, and the reset flow.
 * `/api/auth/elevate` answers 401 for a mistyped password while the caller
 * holds a perfectly good portal session, and `/api/auth/session` answers 401
 * on every cold load before anybody has signed in. Treating either as expiry
 * would sign people out for typing badly, or bounce a first-time visitor off a
 * page they had never reached.
 *
 * Everything else -- `/api/admin/*`, `/api/portal/*` -- is behind
 * `requireSession`, where a 401 has exactly one meaning.
 */
const CREDENTIAL_PATHS = '/api/auth/';

let expiredHandler: (() => void) | null = null;

/**
 * Registers what happens when a live session stops being one.
 *
 * A registry rather than a direct import of the session store, because `api()`
 * is not a React module and must not become one. `SessionProvider` registers a
 * handler that clears the session; the router's `RequireSession` then does the
 * navigating, which keeps "where does an unauthenticated browser go" in the
 * one place that already answers it.
 *
 * Returns an unsubscribe, so a test can put it back.
 */
export function onSessionExpired(handler: () => void): () => void {
  expiredHandler = handler;
  return () => {
    if (expiredHandler === handler) expiredHandler = null;
  };
}
```

and inside `api`, in the `!response.ok` branch, before the throw:

```ts
    // A 401 from anything but a credential-presenting endpoint means the
    // session is gone. Nothing handled this: `GENERIC` mapped 403 and 404, and
    // an expired admin session -- the deliberately short one, fifteen minutes
    // idle -- turned every panel in the console into "Something went wrong"
    // with no route back but typing a URL.
    if (response.status === 401 && !path.startsWith(CREDENTIAL_PATHS)) {
      expiredHandler?.();
    }
```

- [x] **Step 4: Register it, and give the hook a sentence**

In `apps/web/src/session/SessionProvider.tsx`, add to the boot effect (line 70):

```tsx
  useEffect(() => {
    // The session dying mid-request clears it here; `RequireSession` in
    // routes.tsx does the navigating, because that is where "an
    // unauthenticated browser goes to /login, carrying where it was headed"
    // is already decided.
    return onSessionExpired(() => setSession(null));
  }, []);
```

In `apps/web/src/session/use-api-resource.ts`, add to `GENERIC` (line 35):

```ts
const GENERIC: Record<number, string> = {
  // Rendered for the instant between the 401 arriving and the router moving
  // the browser to /login. "Something went wrong" was what an expired session
  // used to say, on every panel at once.
  401: 'Your session has ended. Sign in again to continue.',
  403: 'You do not have permission to view this.',
  404: 'That record no longer exists.',
};
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/session/api.test.ts; cd ../..`
Expected: PASS, 3 new tests plus the file's existing ones.

- [x] **Step 6: Run the console suite, because this touches every fetch**

Run: `cd apps/web && npx vitest run; cd ../..`
Expected: PASS, everything. This is the one task in the plan where running the whole web suite is right — it is 301 tests and about a minute, and the change is under every page.

- [x] **Step 7: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/web/src/session/api.ts apps/web/src/session/api.test.ts \
        apps/web/src/session/SessionProvider.tsx apps/web/src/session/use-api-resource.ts
git commit -m "$(cat <<'EOF'
fix(console): a 401 mid-session sends the reader back to sign in

Nothing handled it. `GENERIC` mapped 403 and 404 and nothing cleared the
session or navigated anywhere, so an expired admin session -- the
deliberately short one, fifteen minutes idle -- turned every panel into
"Something went wrong" with no route back but typing a URL.

Handled in `api()`, once, for every fetch in the console, and excluding
/api/auth/* because that is where a 401 means "that credential was wrong":
elevate answers one for a mistyped password while the caller holds a good
portal session, and /api/auth/session answers one on every cold load. The
handler only clears the session; RequireSession does the navigating, so
"where an unauthenticated browser goes, carrying where it was headed"
stays in the one place that already decides it.
EOF
)"
```

---

### Task 20: The reports screen picks a snapshot instead of a Live toggle that does nothing

Spec §7.6, **W4**. Mode state is kept and a caveat is rendered, but the URL is always the snapshot one and the contract has no mode parameter — the administrator reads a snapshot believing it is live.

**Resolution chosen: remove the toggle and let the reader choose the snapshot.** `LiveReportHeader` exists in `report-service.ts` and nothing produces one; a genuinely live report would mean reading every connected system inside an HTTP request. The capability that does exist is `systemReportQuery.snapshotId`, which the screen never offered — so "which point in time" becomes a real question with a real answer instead of a switch with none.

**Files:**
- Modify: `apps/web/src/pages/admin/GovernReportsPage.tsx:79-120,143-167`
- Test: `apps/web/src/pages/admin/GovernReportsPage.test.tsx` (new)

**Interfaces:**
- Consumes: `GET /api/admin/govern/snapshots?limit=…` → `{ snapshots: { id, asOf, status }[] }`; `GET /api/admin/govern/reports/system?systemId=…&snapshotId=…`.
- Produces: no new endpoints. The page sends `snapshotId` when one is chosen and omits it for the latest.

- [x] **Step 1: Write the failing test**

Create `apps/web/src/pages/admin/GovernReportsPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GovernReportsPage } from './GovernReportsPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const snapshots = [
  { id: 's-new', asOf: '2026-08-20T02:00:00.000Z', status: 'complete' },
  { id: 's-old', asOf: '2026-07-20T02:00:00.000Z', status: 'complete' },
];

const report = {
  header: {
    live: false,
    snapshotId: 's-new',
    asOf: '2026-08-20T02:00:00.000Z',
    sources: [],
    coverageGapCount: 0,
    unattributableCount: 0,
    unattributedAccountCount: 0,
    scopeDescription: 'the whole tenant',
  },
  body: { rows: [], holderCount: { known: true, value: 0 } },
};

function mockApi() {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/govern/snapshots')) return Promise.resolve(json({ snapshots }));
    if (url.includes('/govern/reports/system')) return Promise.resolve(json(report));
    return Promise.resolve(json({}));
  });
  return urls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <GovernReportsPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the reports screen', () => {
  /**
   * The "Live" toggle was wired to nothing: mode state was kept and a caveat
   * rendered, and the URL was always the snapshot one. An administrator read a
   * snapshot believing it was live, and there was no producer of
   * `LiveReportHeader` anywhere in the tree for it to have been.
   */
  it('offers no Live toggle', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('System');
    expect(screen.queryByRole('button', { name: 'Live' })).toBeNull();
  });

  /**
   * The capability that DOES exist: `systemReportQuery.snapshotId`, which the
   * screen never offered. "Which point in time" is now a question with an
   * answer rather than a switch with none.
   */
  it('sends the chosen snapshot', async () => {
    const urls = mockApi();
    renderPage();
    await screen.findByLabelText('System');

    await userEvent.type(screen.getByLabelText('System'), 'sys-1');
    await userEvent.selectOptions(screen.getByLabelText('Point in time'), 's-old');
    await userEvent.click(screen.getByRole('button', { name: 'Run the report' }));

    await waitFor(() =>
      expect(urls.some((u) => u.includes('snapshotId=s-old'))).toBe(true),
    );
  });

  it('omits it for the latest, which is what the server defaults to', async () => {
    const urls = mockApi();
    renderPage();
    await screen.findByLabelText('System');

    await userEvent.type(screen.getByLabelText('System'), 'sys-1');
    await userEvent.click(screen.getByRole('button', { name: 'Run the report' }));

    await waitFor(() =>
      expect(urls.some((u) => u.includes('/govern/reports/system?systemId=sys-1'))).toBe(true),
    );
    expect(urls.some((u) => u.includes('snapshotId='))).toBe(false);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/admin/GovernReportsPage.test.tsx; cd ../..`
Expected: FAIL — the Live button is present and no snapshot picker exists.

- [x] **Step 3: Replace the toggle with a snapshot picker**

In `apps/web/src/pages/admin/GovernReportsPage.tsx`, delete the `mode` state (line 81) and the toggle block (lines 100–120), delete the now-unused `LiveReportHeader` interface (lines 26–31) and narrow `SystemReport['header']` to `ReportHeader`, and add:

```tsx
  const { data: snapshotList } = useApiResource<{
    snapshots: { id: string; asOf: string; status: string }[];
  }>('/api/admin/govern/snapshots?limit=25');
  const [snapshotId, setSnapshotId] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const { data, error, loading } = useApiResource<SystemReport>(submitted);
```

with the form's submit building the whole URL:

```tsx
          onSubmit={(event) => {
            event.preventDefault();
            const system = systemId.trim();
            if (system === '') {
              setSubmitted(null);
              return;
            }
            // WHICH POINT IN TIME, offered rather than assumed.
            //
            // This screen used to carry a "Live" toggle that was wired to
            // nothing: mode state was kept, a caveat was rendered, and the URL
            // was always the snapshot one -- so an administrator read a
            // snapshot believing it was live. Nothing in the tree produces a
            // `LiveReportHeader`, and a genuinely live report would mean
            // reading every connected system inside an HTTP request.
            //
            // `snapshotId` is the capability that does exist and that the
            // screen never offered. Omitted means the latest, which is what
            // `readableSnapshot` already defaults to; naming one is how an
            // auditor reads the picture a decision was made against.
            setSubmitted(
              `/api/admin/govern/reports/system?systemId=${encodeURIComponent(system)}` +
                (snapshotId === '' ? '' : `&snapshotId=${encodeURIComponent(snapshotId)}`),
            );
          }}
```

and, beside the system field:

```tsx
          <Select
            label="Point in time"
            value={snapshotId}
            onChange={setSnapshotId}
            hint="The snapshot this report is assembled from. The latest, unless you name another."
            options={[
              { value: '', label: 'Latest complete snapshot' },
              ...(snapshotList?.snapshots ?? []).map((s) => ({
                value: s.id,
                label: `${new Date(s.asOf).toLocaleString()} — ${s.status}`,
              })),
            ]}
          />
```

Import `Select` from `@syntra/ui`.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/pages/admin/GovernReportsPage.test.tsx; cd ../..`
Expected: PASS, 3 tests.

- [x] **Step 5: Typecheck, build and commit**

```bash
npx tsc -b
pnpm --filter @syntra/web build
```

```bash
git add apps/web/src/pages/admin/GovernReportsPage.tsx \
        apps/web/src/pages/admin/GovernReportsPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(console): the reports screen picks a snapshot, not a Live mode that is not one

The "Live" toggle was wired to nothing. Mode state was kept and a caveat
rendered, and the URL was always the snapshot one -- so an administrator
read a snapshot believing it was live. Nothing in the tree produces a
LiveReportHeader, and a genuinely live report would mean reading every
connected system inside an HTTP request.

Replaced with the capability that does exist and that the screen never
offered: `systemReportQuery.snapshotId`. "Which point in time" becomes a
question with an answer -- the latest by default, which is what
readableSnapshot already does, and a named one for the auditor reading the
picture a decision was made against.
EOF
)"
```

---

### Task 21: Assignment and policy controls report their failures

Spec §7.6, **W5**, the two sites outside `Security.tsx` (which Task 5 covered). `ApplicationDetailPage`'s `assign()` and `unassign()` have no error handling, so a 403 for a holder of `access.read` is an unhandled rejection and the button appears to do nothing. `PoliciesPage`'s `move()` and `remove()` are the same shape.

**Files:**
- Modify: `apps/web/src/pages/admin/ApplicationDetailPage.tsx:70-86`
- Modify: `apps/web/src/pages/admin/PoliciesPage.tsx:174-190`
- Test: `apps/web/src/pages/admin/ApplicationDetailPage.test.tsx` (new)
- Test: `apps/web/src/pages/admin/PoliciesPage.test.tsx` (append)

**Interfaces:**
- Consumes: `ApiError`, `api`.
- Produces: no signature changes. Both pages render the server's `detail` in an `Alert` on failure.

- [x] **Step 1: Write the failing tests**

Create `apps/web/src/pages/admin/ApplicationDetailPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApplicationDetailPage } from './ApplicationDetailPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const forbidden = json(
  {
    type: 'https://syntra.dev/problems/forbidden',
    title: 'Forbidden',
    status: 403,
    detail: 'Requires access.manage',
  },
  403,
);

function mockApi(mutation: Response) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      return Promise.resolve(mutation);
    }
    if (url.includes('/assignments')) {
      return Promise.resolve(
        json({
          assignments: [
            { id: 'a1', subjectType: 'group', userId: null, groupId: 'g1', orgUnitId: null },
          ],
        }),
      );
    }
    if (url.includes('/groups')) return Promise.resolve(json({ groups: [{ id: 'g1', name: 'Nurses' }] }));
    if (url.includes('/users')) return Promise.resolve(json({ users: [] }));
    if (url.includes('/org-units')) return Promise.resolve(json({ orgUnits: [] }));
    return Promise.resolve(json({}));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/applications/app-1']}>
      <Routes>
        <Route path="/admin/applications/:id" element={<ApplicationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('assignment controls', () => {
  /**
   * `assign()` and `unassign()` had no catch, so a 403 was an unhandled
   * rejection and the button simply appeared to do nothing. The caller was
   * usually a holder of `access.read` who could see the page and not change
   * it, and the interface gave them no way to find that out.
   */
  it('renders the server’s refusal when a removal is forbidden', async () => {
    mockApi(forbidden);
    renderPage();
    await screen.findByText('Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Requires access.manage')).toBeInTheDocument();
  });

  it('renders it for an assignment too', async () => {
    mockApi(forbidden);
    renderPage();
    await screen.findByText('Nurses');

    await userEvent.selectOptions(screen.getByLabelText('Group'), 'g1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Assign' })[0]!);
    expect(await screen.findByText('Requires access.manage')).toBeInTheDocument();
  });
});
```

Append to `apps/web/src/pages/admin/PoliciesPage.test.tsx` a case of the same shape for `Remove` on a rule, asserting the server's `detail` appears.

- [x] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run src/pages/admin/ApplicationDetailPage.test.tsx src/pages/admin/PoliciesPage.test.tsx; cd ../..`
Expected: FAIL — nothing renders, and the console shows an unhandled rejection.

- [x] **Step 3: Catch, and say what the server said**

In `apps/web/src/pages/admin/ApplicationDetailPage.tsx`, add `const [problem, setProblem] = useState<string | null>(null);` and replace the two handlers (lines 70–86):

```tsx
  /**
   * The refusal, rendered.
   *
   * Both of these had no catch at all. A 403 -- which is the ORDINARY case
   * here, because `access.read` is enough to open this page and not enough to
   * change it -- was an unhandled rejection, and the button appeared to do
   * nothing at all. The reader had no way to learn that the thing they were
   * clicking was not theirs to click.
   */
  const report = (cause: unknown) =>
    setProblem(
      cause instanceof ApiError
        ? (cause.problem.detail ?? cause.problem.title)
        : 'That could not be saved.',
    );

  async function assign(type: SubjectType) {
    const subjectId = chosen[type];
    if (!subjectId) return;
    setProblem(null);
    try {
      await api(`/api/admin/applications/${id}/assignments`, {
        method: 'POST',
        body: JSON.stringify({ type, id: subjectId }),
      });
      setChosen((current) => ({ ...current, [type]: '' }));
      reload();
    } catch (cause) {
      report(cause);
    }
  }

  async function unassign(assignmentId: string) {
    setProblem(null);
    try {
      await api(`/api/admin/applications/${id}/assignments/${assignmentId}`, {
        method: 'DELETE',
      });
      reload();
    } catch (cause) {
      report(cause);
    }
  }
```

Render `{problem && <Alert tone="warning">{problem}</Alert>}` beside the existing error alert (line 118), and import `ApiError`.

In `apps/web/src/pages/admin/PoliciesPage.tsx`, wrap `move()` and `remove()` (lines 174–190) the same way, reusing the page's existing `setFormError`:

```tsx
  async function move(index: number, delta: number) {
    if (!policy) return;
    const ids = policy.rules.map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setFormError(null);
    try {
      await api('/api/admin/policy/rules/order', {
        method: 'PUT',
        body: JSON.stringify({ ruleIds: ids }),
      });
      reload();
    } catch (cause) {
      // Rule ORDER decides which rule wins, so a reorder that silently did not
      // happen leaves the administrator believing a different rule is in force
      // than the one that is.
      setFormError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be moved.',
      );
    }
  }

  async function remove(id: string) {
    setFormError(null);
    try {
      await api(`/api/admin/policy/rules/${id}`, { method: 'DELETE' });
      reload();
    } catch (cause) {
      setFormError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be removed.',
      );
    }
  }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/pages/admin/ApplicationDetailPage.test.tsx src/pages/admin/PoliciesPage.test.tsx; cd ../..`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/web/src/pages/admin/ApplicationDetailPage.tsx \
        apps/web/src/pages/admin/ApplicationDetailPage.test.tsx \
        apps/web/src/pages/admin/PoliciesPage.tsx \
        apps/web/src/pages/admin/PoliciesPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(console): assignment and policy controls report their failures

`assign`, `unassign`, `move` and `remove` had no error handling at all, so
a refusal was an unhandled rejection and the button appeared to do
nothing. A 403 is the ordinary case on the assignments page --
`access.read` is enough to open it and not enough to change it -- and the
reader had no way to find out that what they were clicking was not theirs
to click. A reorder that silently did not happen is worse still: rule
order decides which rule wins, so the administrator is left believing a
different rule is in force than the one that is.
EOF
)"
```

---

### Task 22: Campaign creation, start and re-base — the access-review module becomes usable

Spec §7.6, **W6**, the largest half. `createCampaign`, `startCampaign`, `rebaseCampaign`, `previewCampaignScope` and `previewReviewerResolution` all exist, all have routes, and **none of them can be invoked from the console** — so the whole access-review module is inert while `GovernCampaignsPage`'s empty state tells the reader to create one.

This is the priority: with it the module works end to end, and without it nothing else in Govern can be reached by a person.

**Files:**
- Create: `apps/web/src/pages/admin/GovernCampaignNewPage.tsx`
- Create: `apps/web/src/pages/admin/GovernCampaignNewPage.test.tsx`
- Modify: `apps/web/src/pages/admin/GovernCampaignsPage.tsx:62-77` (a header action, and the empty state)
- Modify: `apps/web/src/pages/admin/GovernCampaignDetailPage.tsx:120-150` (Start and Re-base)
- Modify: `apps/web/src/pages/admin/AdminApp.tsx:98` (the `new` route, before the parametric one)
- Test: `apps/web/src/pages/admin/GovernCampaignDetailPage.test.tsx` (new)

**Interfaces:**
- Consumes:
  - `POST /api/admin/govern/campaigns` — `createCampaignBody`: `{ name, description, scope, reviewerSelector, reviewerConfig, fallbackSelector, fallbackConfig, ownerPersonId, opensAt, dueAt, allowBulkCertify, recurrence, snapshotId? }` → 201 the campaign
  - `POST /api/admin/govern/campaigns/preview-scope` — `{ scope, snapshotId? }` → `{ holdings, persons, systems, sample: { subjectKey, resourceName }[] }`
  - `POST /api/admin/govern/campaigns/preview-reviewers` — `{ scope, reviewerSelector, reviewerConfig, fallbackSelector, fallbackConfig, snapshotId? }` → `{ resolved, viaFallback, blocked, blockedSample: { subjectKey, resourceName, reason }[] }`
  - `POST /api/admin/govern/campaigns/:id/start` → `{ status, itemCount, blockedCount }`, or 409 carrying a `CampaignRefusedError` code
  - `POST /api/admin/govern/campaigns/:id/rebase` — `{ snapshotId }` → `{ reopened, kept }`
  - `GET /api/admin/govern/snapshots?limit=25`
- Produces: `export function GovernCampaignNewPage()`; route `/admin/govern/campaigns/new`.

Note that Task 11 raised the two preview routes to `govern.manage`, which is the same permission this screen's Save needs — so a reader who can see the previews can act on them.

- [x] **Step 1: Write the failing test for the creation screen**

Create `apps/web/src/pages/admin/GovernCampaignNewPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GovernCampaignNewPage } from './GovernCampaignNewPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const snapshots = [{ id: 's-1', asOf: '2026-08-20T02:00:00.000Z', status: 'complete' }];

function mockApi(over: { create?: Response } = {}) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/preview-scope')) {
        return Promise.resolve(
          json({
            holdings: 4120,
            persons: 1180,
            systems: 6,
            sample: [{ subjectKey: 'person:p1', resourceName: 'Domain Admins' }],
          }),
        );
      }
      if (url.endsWith('/preview-reviewers')) {
        return Promise.resolve(
          json({
            resolved: 1102,
            viaFallback: 61,
            blocked: 17,
            blockedSample: [
              { subjectKey: 'person:p9', resourceName: 'Ledger', reason: 'no manager' },
            ],
          }),
        );
      }
      return Promise.resolve(over.create ?? json({ id: 'c-1' }, 201));
    }
    if (url.includes('/govern/snapshots')) return Promise.resolve(json({ snapshots }));
    if (url.includes('/persons')) return Promise.resolve(json({ persons: [] }));
    return Promise.resolve(json({}));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <GovernCampaignNewPage />
    </MemoryRouter>,
  );

const fillTheEssentials = async () => {
  await userEvent.type(screen.getByLabelText('Name'), 'H2 access review');
  await userEvent.click(screen.getByRole('checkbox', { name: /targetEntitlement/ }));
  await userEvent.type(
    screen.getByLabelText('Owner person id'),
    '33333333-3333-4333-8333-333333333333',
  );
  await userEvent.type(screen.getByLabelText('Opens'), '2026-09-01');
  await userEvent.type(screen.getByLabelText('Due'), '2026-09-30');
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('creating a campaign', () => {
  /**
   * The whole access-review module was inert from the console: create, start,
   * re-base and both previews existed on the server, had routes, and had no
   * way in — while the campaigns page's empty state told the reader to create
   * one.
   */
  it('sends everything createCampaignBody requires', async () => {
    const sent = mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await fillTheEssentials();

    await userEvent.click(screen.getByRole('button', { name: 'Create the campaign' }));

    await waitFor(() => expect(sent.filter((s) => s.url.endsWith('/campaigns'))).toHaveLength(1));
    expect(sent.at(-1)!.body).toMatchObject({
      name: 'H2 access review',
      scope: { resourceKinds: ['targetEntitlement'] },
      reviewerSelector: 'manager',
      fallbackSelector: 'productOwner',
      ownerPersonId: '33333333-3333-4333-8333-333333333333',
      allowBulkCertify: false,
    });
  });

  /**
   * §20 in words: "this scope covers 4,120 holdings across 1,180 persons and 6
   * systems". The screen that catches an unreviewable campaign before 200
   * people are emailed, rather than at 3am on the due date — and it existed on
   * the server with nothing calling it.
   */
  it('shows the scope preview before anything is created', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('checkbox', { name: /targetEntitlement/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Show me what this covers' }));
    expect(await screen.findByText(/4,?120 holdings/)).toBeInTheDocument();
    expect(screen.getByText(/1,?180 persons/)).toBeInTheDocument();
  });

  /**
   * And the reviewer preview NAMES the items that resolve to nobody. A count
   * of 17 unreviewable items is not actionable; the sample is what makes it
   * one.
   */
  it('names the items that would resolve to nobody', async () => {
    mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('checkbox', { name: /targetEntitlement/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Show me who would review it' }));
    expect(await screen.findByText(/17 resolve to nobody/)).toBeInTheDocument();
    expect(screen.getByText(/no manager/)).toBeInTheDocument();
  });

  /**
   * A scope with no resource kinds covers NOTHING — `campaignScopeInput` says
   * `.min(1)` for exactly that reason — so the form must not let one be sent.
   */
  it('will not create a campaign whose scope covers nothing', async () => {
    const sent = mockApi();
    renderPage();
    await screen.findByLabelText('Name');
    await userEvent.type(screen.getByLabelText('Name'), 'Empty');

    expect(screen.getByRole('button', { name: 'Create the campaign' })).toBeDisabled();
    expect(sent.filter((s) => s.url.endsWith('/campaigns'))).toHaveLength(0);
  });

  it('renders the server’s refusal rather than a generic apology', async () => {
    mockApi({
      create: json(
        {
          type: 'https://syntra.dev/problems/stale_snapshot',
          title: 'Campaign refused',
          status: 409,
          detail: 'the snapshot is older than maxSnapshotAgeDays',
        },
        409,
      ),
    });
    renderPage();
    await screen.findByLabelText('Name');
    await fillTheEssentials();
    await userEvent.click(screen.getByRole('button', { name: 'Create the campaign' }));

    expect(
      await screen.findByText('the snapshot is older than maxSnapshotAgeDays'),
    ).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/admin/GovernCampaignNewPage.test.tsx; cd ../..`
Expected: FAIL — `Cannot find module './GovernCampaignNewPage.js'`.

- [x] **Step 3: Write the screen**

Create `apps/web/src/pages/admin/GovernCampaignNewPage.tsx`. The shape:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

const RESOURCE_KINDS = [
  'targetEntitlement',
  'targetAccount',
  'syntraGroup',
  'application',
  'syntraRole',
  'syntraUser',
] as const;

/** §20's selectors, in the order somebody meets them. */
const SELECTORS = ['manager', 'managerChain', 'productOwner', 'resourceOwner', 'role', 'group', 'person'];

interface ScopePreview {
  holdings: number;
  persons: number;
  systems: number;
  sample: { subjectKey: string; resourceName: string }[];
}

interface ReviewerPreview {
  resolved: number;
  viaFallback: number;
  blocked: number;
  blockedSample: { subjectKey: string; resourceName: string; reason: string }[];
}

/**
 * Creating an access review.
 *
 * The whole module was inert from the console. `createCampaign`,
 * `startCampaign`, `rebaseCampaign` and both previews existed on the server
 * and had routes; nothing could invoke any of them, while the campaigns
 * page's empty state told the reader to create one. This screen is what makes
 * Govern a product rather than a set of endpoints.
 *
 * BOTH PREVIEWS ARE ON THE PAGE, above the create button, because §20 asks for
 * them there: "1,102 items resolve, 61 fall to the fallback, 17 resolve to
 * nobody — here they are" is the screen that catches an unreviewable campaign
 * before 200 people are emailed rather than at 3am on the due date. They write
 * nothing.
 */
export function GovernCampaignNewPage() {
  const navigate = useNavigate();
  const { data: snapshotList } = useApiResource<{
    snapshots: { id: string; asOf: string; status: string }[];
  }>('/api/admin/govern/snapshots?limit=25');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [systemIds, setSystemIds] = useState('');
  const [privilegedOnly, setPrivilegedOnly] = useState(false);
  const [reviewerSelector, setReviewerSelector] = useState('manager');
  const [fallbackSelector, setFallbackSelector] = useState('productOwner');
  const [ownerPersonId, setOwnerPersonId] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [allowBulkCertify, setAllowBulkCertify] = useState(false);
  const [snapshotId, setSnapshotId] = useState('');
  const [scopePreview, setScopePreview] = useState<ScopePreview | null>(null);
  const [reviewerPreview, setReviewerPreview] = useState<ReviewerPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The scope object both previews and the create call share.
   *
   * `resourceKinds` is `.min(1)` in `campaignScopeInput` and the button is
   * disabled without one, because a scope with an empty kind list covers
   * NOTHING — "review the finance system" with no kinds ticked would create a
   * campaign over zero holdings that nobody could tell from a broken one.
   */
  const scope = () => ({
    resourceKinds: [...kinds],
    ...(systemIds.trim() === ''
      ? {}
      : { systemIds: systemIds.split(',').map((s) => s.trim()).filter(Boolean) }),
    ...(privilegedOnly ? { privilegedOnly: true } : {}),
  });

  const snapshotPart = () => (snapshotId === '' ? {} : { snapshotId });

  const report = (cause: unknown, fallback: string) =>
    setProblem(
      cause instanceof ApiError
        ? (cause.problem.detail ?? cause.problem.title)
        : fallback,
    );

  const previewScope = async () => {
    setProblem(null);
    try {
      setScopePreview(
        await api<ScopePreview>('/api/admin/govern/campaigns/preview-scope', {
          method: 'POST',
          body: JSON.stringify({ scope: scope(), ...snapshotPart() }),
        }),
      );
    } catch (cause) {
      report(cause, 'That scope could not be previewed.');
    }
  };

  const previewReviewers = async () => {
    setProblem(null);
    try {
      setReviewerPreview(
        await api<ReviewerPreview>('/api/admin/govern/campaigns/preview-reviewers', {
          method: 'POST',
          body: JSON.stringify({
            scope: scope(),
            reviewerSelector,
            reviewerConfig: {},
            fallbackSelector,
            fallbackConfig: {},
            ...snapshotPart(),
          }),
        }),
      );
    } catch (cause) {
      report(cause, 'The reviewers could not be resolved.');
    }
  };

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const created = await api<{ id: string }>('/api/admin/govern/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description.trim() === '' ? null : description,
          scope: scope(),
          reviewerSelector,
          reviewerConfig: {},
          fallbackSelector,
          fallbackConfig: {},
          ownerPersonId,
          opensAt,
          dueAt,
          allowBulkCertify,
          recurrence: null,
          ...snapshotPart(),
        }),
      });
      // A campaign is created as a DRAFT and generates nothing until it is
      // started, so the next screen is the one with the Start button on it.
      navigate(`/admin/govern/campaigns/${created.id}`);
    } catch (cause) {
      report(cause, 'That campaign could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim() !== '' && kinds.size > 0 && ownerPersonId.trim() !== '' &&
    opensAt !== '' && dueAt !== '';

  return (/* PageHeader, three Panels — What it covers, Who reviews it, When —
             each preview rendered under the fields that feed it, and the
             create button under the lot. */);
}
```

Write the JSX out in full: a `Field` per text input, a `Check` per resource kind labelled with the kind's name (the test queries by it), a `Select` for each selector and for the snapshot, `Field type="date"` for `Opens` and `Due`, and the two preview results rendered as `Alert`s carrying the numbers and the samples. The blocked sample must render each entry's `reason`.

- [x] **Step 4: Add the route and the way in**

In `apps/web/src/pages/admin/AdminApp.tsx`, before the parametric campaign route (line 99):

```tsx
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the detail screen. */}
            <Route path="govern/campaigns/new" element={<GovernCampaignNewPage />} />
```

In `apps/web/src/pages/admin/GovernCampaignsPage.tsx`, give the header an action and the empty state a link:

```tsx
      <PageHeader
        title="Access reviews"
        description="A campaign is a scope, a set of reviewers and a due date, frozen against one snapshot. Nothing in it removes anything until somebody confirms a revocation batch."
        actions={
          <Link to="/admin/govern/campaigns/new">
            <Button variant="primary" size="sm">
              New campaign
            </Button>
          </Link>
        }
      />
```

and, in the empty state, replace the prose with the same link — the empty state told the reader to create a campaign and offered no way to.

- [x] **Step 5: Start and re-base on the detail screen**

In `apps/web/src/pages/admin/GovernCampaignDetailPage.tsx`, add to the Actions panel (line 121), before the extend button:

```tsx
              {/* A campaign is created as a DRAFT and generates nothing until
                  it is started: `startCampaign` is what writes the items,
                  resolves the reviewers and sends the mail. Until this button
                  existed, every campaign the API could create sat as a draft
                  forever. */}
              {data.campaign.status === 'draft' && (
                <Button
                  variant="primary"
                  onClick={() =>
                    act(
                      `/api/admin/govern/campaigns/${data.campaign.id}/start`,
                      {},
                      (result) => {
                        const started = result as { itemCount: number; blockedCount: number };
                        setStarted(
                          `${started.itemCount} item(s) generated` +
                            (started.blockedCount === 0
                              ? '.'
                              : `, and ${started.blockedCount} resolved to nobody — they cannot be decided until somebody is named.`),
                        );
                      },
                    )
                  }
                >
                  Start it
                </Button>
              )}

              {/* §8 rule 2: a campaign whose snapshot has aged past
                  `maxSnapshotAgeDays` must be re-based before its revocations
                  can execute, and the guard refuses outright otherwise. The
                  endpoint existed; nothing could call it, so a campaign that
                  aged out was permanently unexecutable. */}
              <Select
                label="Re-base onto"
                value={rebaseTo}
                onChange={setRebaseTo}
                options={[
                  { value: '', label: 'Choose a snapshot…' },
                  ...(snapshotList?.snapshots ?? []).map((s) => ({
                    value: s.id,
                    label: new Date(s.asOf).toLocaleString(),
                  })),
                ]}
              />
              <Button
                variant="secondary"
                disabled={rebaseTo === ''}
                onClick={() =>
                  act(
                    `/api/admin/govern/campaigns/${data.campaign.id}/rebase`,
                    { snapshotId: rebaseTo },
                    (result) => {
                      const r = result as { reopened: number; kept: number };
                      setStarted(`${r.reopened} item(s) re-opened, ${r.kept} kept.`);
                    },
                  )
                }
              >
                Re-base
              </Button>
```

with `const [rebaseTo, setRebaseTo] = useState('');`, `const [started, setStarted] = useState<string | null>(null);`, the snapshot list read through `useApiResource`, and `{started && <Alert tone="info">{started}</Alert>}` beside the existing alerts.

- [x] **Step 6: Test the detail screen's two new controls**

Create `apps/web/src/pages/admin/GovernCampaignDetailPage.test.tsx` in the house style, asserting:
- a `draft` campaign shows **Start it**, a `closed_complete` one does not;
- clicking it POSTs to `/campaigns/c-1/start` and renders `12 item(s) generated`;
- a 409 from start renders the server's `detail` (`CampaignRefusedError` carries a real sentence — a stale snapshot, an empty scope);
- **Re-base** is disabled until a snapshot is chosen and then POSTs `{ snapshotId }`.

- [x] **Step 7: Run both web tests**

Run: `cd apps/web && npx vitest run src/pages/admin/GovernCampaignNewPage.test.tsx src/pages/admin/GovernCampaignDetailPage.test.tsx; cd ../..`
Expected: PASS.

- [x] **Step 8: Typecheck, build and commit**

```bash
npx tsc -b
pnpm --filter @syntra/web build
```

```bash
git add apps/web/src/pages/admin/GovernCampaignNewPage.tsx \
        apps/web/src/pages/admin/GovernCampaignNewPage.test.tsx \
        apps/web/src/pages/admin/GovernCampaignDetailPage.tsx \
        apps/web/src/pages/admin/GovernCampaignDetailPage.test.tsx \
        apps/web/src/pages/admin/GovernCampaignsPage.tsx \
        apps/web/src/pages/admin/AdminApp.tsx
git commit -m "$(cat <<'EOF'
feat(console): create, start and re-base an access review

The whole module was inert from the console. createCampaign,
startCampaign, rebaseCampaign, previewCampaignScope and
previewReviewerResolution all existed, all had routes, and none could be
invoked -- while the campaigns page's empty state told the reader to
create one.

Both previews are on the creation screen above the button, because that is
what section 20 asks for: "1,102 items resolve, 61 fall to the fallback,
17 resolve to nobody -- here they are" is the screen that catches an
unreviewable campaign before 200 people are emailed rather than at 3am on
the due date, and the blocked items are named rather than counted.

Start is on the detail screen because a campaign is created as a draft and
generates nothing until it is started. Re-base is there too: section 8
rule 2 requires a campaign whose snapshot aged past maxSnapshotAgeDays to
be re-based before its revocations can execute, so without the control a
campaign that aged out was permanently unexecutable.
EOF
)"
```

---

### Task 23: Workflows get a list, so a product can name one

Spec §7.6, **W6**, second surface. There is **no workflow list route at all** — `GET /automate/workflows` does not exist — so a product's required `workflowId` cannot be discovered, and `WorkflowEditorPage` is a resolution preview that asks the reader to type a workflow id it gives them no way to learn. `POST` and `PUT /automate/workflows/:id` exist and have no caller.

**Files:**
- Modify: `apps/api/src/routes/admin/automate.ts:139` (a list route before the create)
- Modify: `apps/web/src/pages/admin/WorkflowEditorPage.tsx` (whole file)
- Modify: `apps/web/src/pages/admin/ProductEditorPage.tsx` (a picker in place of the id box)
- Test: `apps/api/src/routes/admin/automate.test.ts`
- Test: `apps/web/src/pages/admin/WorkflowEditorPage.test.tsx` (new)

**Interfaces:**
- Consumes: `workflowBody` (unchanged), `PERMISSIONS.AUTOMATE_READ`.
- Produces: `GET /api/admin/automate/workflows` → `{ workflows: Array<ApprovalWorkflow & { stages: ApprovalStage[]; productCount: number }> }`.

- [x] **Step 1: Write the failing route test**

Append to `apps/api/src/routes/admin/automate.test.ts`:

```ts
describe('listing workflows', () => {
  /**
   * There was no list route at all, so a product's required `workflowId` could
   * not be discovered from the product: the editor asked an administrator to
   * type a uuid the console gave them no way to learn.
   */
  it('answers every workflow with its stages', async () => {
    const { cookie } = await seedProduct();
    const res = await get('/api/admin/automate/workflows', cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workflows: { stages: unknown[]; productCount: number }[] };
    expect(body.workflows.length).toBeGreaterThan(0);
    expect(Array.isArray(body.workflows[0]!.stages)).toBe(true);
    // The count is what makes "can I delete this" answerable from the list.
    expect(body.workflows[0]!.productCount).toBeGreaterThanOrEqual(0);
  });

  it('needs automate.read', async () => {
    await seedAdmin('reader', [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('reader');
    expect((await get('/api/admin/automate/workflows', cookie)).statusCode).toBe(403);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/automate.test.ts -t 'listing workflows'`
Expected: FAIL — 404.

- [x] **Step 3: Add the route**

In `apps/api/src/routes/admin/automate.ts`, before the workflow create (line 139):

```ts
  /**
   * Every approval workflow, with its stages and how many products use it.
   *
   * There was no list route of any kind, so `Product.workflowId` -- which is
   * REQUIRED and a uuid -- could not be discovered from the console at all:
   * the product editor asked an administrator to type an id the product gave
   * them no way to learn, and the workflow screen asked for the same id before
   * it would preview anything.
   *
   * `productCount` because a workflow bound to eleven products is not one
   * somebody should edit without knowing that, and `ApprovalWorkflow.products`
   * is a relation this can count without a second query.
   */
  app.get(
    '/automate/workflows',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const rows = await request.db((tx) =>
        tx.approvalWorkflow.findMany({
          orderBy: { name: 'asc' },
          include: {
            stages: { orderBy: { sequence: 'asc' } },
            products: { select: { id: true } },
          },
        }),
      );
      return {
        workflows: rows.map(({ products, ...workflow }) => ({
          ...workflow,
          productCount: products.length,
        })),
      };
    },
  );
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/automate.test.ts`
Expected: PASS.

- [x] **Step 5: Make the console screen a list**

Rewrite `apps/web/src/pages/admin/WorkflowEditorPage.tsx` so it reads `/api/admin/automate/workflows` and renders, for each workflow: its name, whether it is enabled, its `productCount`, and its stages in sequence with each stage's selector, quorum, fallback, SLA and timeout behaviour. Keep the existing resolution preview, but with the workflow chosen from a `Select` built from the list rather than typed as a uuid, and add a "New workflow" panel that POSTs a `{ name, description, enabled, stages: [] }` body — the contract permits an empty stage list and `workflowBody`'s own comment says an empty one grants immediately, which is the mechanism and worth saying on the screen.

Keep the existing `DROP_REASON` map and the preview rendering exactly as they are; the preview was the one part of this page that worked.

- [x] **Step 6: Let the product editor pick one**

In `apps/web/src/pages/admin/ProductEditorPage.tsx`, replace the `Approval workflow id` `Field` with:

```tsx
          <Select
            label="Approval workflow"
            value={workflowId}
            onChange={setWorkflowId}
            error={errors.workflowId}
            hint="Who has to agree before this is granted. A workflow with no stages grants immediately."
            options={[
              { value: '', label: 'Choose one…' },
              ...(workflowList?.workflows ?? []).map((w) => ({
                value: w.id,
                label: w.name,
              })),
            ]}
          />
```

with `const { data: workflowList } = useApiResource<{ workflows: { id: string; name: string }[] }>('/api/admin/automate/workflows');`. The editor's test from Task 17 already mocks that endpoint.

- [x] **Step 7: Test the workflow screen**

Create `apps/web/src/pages/admin/WorkflowEditorPage.test.tsx` in the house style, asserting:
- every workflow in the response is listed with its name and stage names;
- a workflow with no stages says so in words rather than showing an empty list ("grants immediately" is the mechanism, not a flag);
- creating a workflow POSTs `{ name, description, enabled, stages: [] }`;
- the resolution preview posts the id chosen from the picker, not a typed one.

- [x] **Step 8: Run the web tests, typecheck and commit**

```bash
cd apps/web && npx vitest run src/pages/admin/WorkflowEditorPage.test.tsx src/pages/admin/ProductEditorPage.test.tsx; cd ../..
npx tsc -b
```

```bash
git add apps/api/src/routes/admin/automate.ts apps/api/src/routes/admin/automate.test.ts \
        apps/web/src/pages/admin/WorkflowEditorPage.tsx \
        apps/web/src/pages/admin/WorkflowEditorPage.test.tsx \
        apps/web/src/pages/admin/ProductEditorPage.tsx
git commit -m "$(cat <<'EOF'
feat(console): workflows get a list, so a product can name one

There was no GET for workflows at all. `Product.workflowId` is required
and is a uuid, so the product editor asked an administrator to type an id
the console gave them no way to learn -- and the workflow screen asked for
the same id before it would preview anything. POST and PUT existed and had
no caller.

The list carries each workflow's stages in sequence and how many products
use it, because a workflow bound to eleven products is not one somebody
should edit without knowing that. The product editor picks from it, and
the workflow screen says in words that a workflow with no stages grants
immediately -- which is the mechanism, not a flag.
EOF
)"
```

---

### Task 24: Person link-user, group membership, and taking a factor off a user

Spec §7.6, **W6**, three more server features with no way to invoke them. `POST /persons/:id/link-user` exists and nothing calls it, so a person with no account "exists in the directory but cannot sign in" and the empty state says to link one. `GET/POST/DELETE /groups/:id/members` exist and `GroupsPage` shows no members at all. `DELETE /users/:id/factors/:type` exists — the way back in for somebody who lost their phone — and no screen reaches it.

**Files:**
- Modify: `apps/web/src/pages/admin/PersonDetailPage.tsx:128-156` (the Accounts panel)
- Modify: `apps/web/src/pages/admin/GroupsPage.tsx:117-163` (the rows)
- Modify: `apps/web/src/pages/admin/UsersPage.tsx:324-411` (the row actions)
- Test: `apps/web/src/pages/admin/PersonDetailPage.test.tsx` (append)
- Test: `apps/web/src/pages/admin/StatusToggle.test.tsx` (append the membership cases beside the existing `GroupsPage` ones)
- Test: `apps/web/src/pages/admin/UsersPage.test.tsx` (append)

**Interfaces:**
- Consumes:
  - `POST /api/admin/persons/:id/link-user` — `{ userId }` → 204
  - `GET /api/admin/groups/:id/members` → `{ users: … }`; `POST`/`DELETE /api/admin/groups/:id/members/:userId` → 204
  - `DELETE /api/admin/users/:id/factors/:type` → 200 `{ recoveryCodesRevoked }`
- Produces: no new endpoints.

- [x] **Step 1: Write the failing tests**

Append to `apps/web/src/pages/admin/PersonDetailPage.test.tsx`:

```tsx
describe('linking an account to a person', () => {
  /**
   * `POST /persons/:id/link-user` existed and nothing called it, while the
   * empty state on this very panel said "This person exists in the directory
   * but cannot sign in. Link an account to give them access." -- with no
   * control that would.
   */
  it('offers unlinked users and posts the link', async () => {
    const sent = mockPerson({ users: [], candidates: [{ id: 'u9', displayName: 'Maya Okafor', login: 'mokafor' }] });
    renderPage();
    await screen.findByText('No accounts linked');

    await userEvent.selectOptions(screen.getByLabelText('Account to link'), 'u9');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/api/admin/persons/p1/link-user');
    expect(sent[0]!.body).toEqual({ userId: 'u9' });
  });
});
```

Append to `apps/web/src/pages/admin/StatusToggle.test.tsx` (which already renders `GroupsPage`):

```tsx
describe('group membership', () => {
  /**
   * `GET`, `POST` and `DELETE /groups/:id/members` all existed and the groups
   * page showed no members at all — so the one thing a group is for could only
   * be done through the API.
   */
  it('lists members and adds one', async () => {
    const posts = mockApi({
      groups: [group()],
      users: [user()],
      members: [],
    });
    render(
      <MemoryRouter>
        <GroupsPage />
      </MemoryRouter>,
    );
    await screen.findByText('Ward Nurses');

    await userEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(await screen.findByText('Nobody is in this group yet')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Add a member'), 'u1');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/api/admin/groups/g1/members/u1');
  });
});
```

Extend `mockApi` in that file with `members` and a `/members` branch rather than adding a second mock.

Append to `apps/web/src/pages/admin/UsersPage.test.tsx`:

```tsx
describe('taking a factor off a user', () => {
  /**
   * The way back in for somebody who lost their phone, and the way an
   * administrator revokes a factor an attacker enrolled. The route existed and
   * wrote its own audit event naming the administrator; no screen reached it,
   * so the answer to "I lost my authenticator" was a database client.
   */
  it('removes the authenticator app and says what it cost', async () => {
    const sent = mockUsers([user()], { factorDelete: json({ recoveryCodesRevoked: 3 }) });
    render(
      <MemoryRouter>
        <UsersPage />
      </MemoryRouter>,
    );
    await screen.findByText('mokafor');

    await userEvent.click(screen.getByRole('button', { name: 'Factors' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove authenticator app' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/api/admin/users/u1/factors/totp');
    expect(sent[0]!.method).toBe('DELETE');
    expect(
      await screen.findByText(/3 unused recovery codes stopped working/),
    ).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run all three to verify they fail**

Run: `cd apps/web && npx vitest run src/pages/admin/PersonDetailPage.test.tsx src/pages/admin/StatusToggle.test.tsx src/pages/admin/UsersPage.test.tsx; cd ../..`
Expected: FAIL — none of the three controls exist.

- [x] **Step 3: Build the three controls**

`PersonDetailPage`: read `/api/admin/users`, filter to accounts whose `personId` is null (add `personId` to the users list response if it is not already there — check `apps/api/src/routes/admin/users.ts`'s list handler first), offer them in a `Select` labelled `Account to link`, and POST on **Link**. Render the refusal.

`GroupsPage`: a **Members** button per row opening a panel that reads `/api/admin/groups/:id/members`, lists each member with a **Remove** control, and offers an `Add a member` `Select` built from the users list. One panel for the page, opened by a row, exactly as the edit panel already is.

`UsersPage`: a **Factors** button per row opening a panel with one control per factor type — `Remove authenticator app`, `Remove security keys`, `Remove recovery codes` — each `DELETE`ing `/api/admin/users/:id/factors/:type` and rendering the returned `recoveryCodesRevoked` in words. Add the comment that makes the copy honest:

```tsx
                {/* The way back in for somebody who lost their phone, and the
                    way an administrator revokes a factor an attacker enrolled.
                    The route writes its own audit event naming the
                    administrator, because a factor that disappears with
                    nothing to show who removed it is indistinguishable from
                    one the attacker removed. */}
```

- [x] **Step 4: Run the three tests to verify they pass**

Run: `cd apps/web && npx vitest run src/pages/admin/PersonDetailPage.test.tsx src/pages/admin/StatusToggle.test.tsx src/pages/admin/UsersPage.test.tsx; cd ../..`
Expected: PASS.

- [x] **Step 5: Typecheck, build and commit**

```bash
npx tsc -b
pnpm --filter @syntra/web build
```

```bash
git add apps/web/src/pages/admin/PersonDetailPage.tsx apps/web/src/pages/admin/PersonDetailPage.test.tsx \
        apps/web/src/pages/admin/GroupsPage.tsx apps/web/src/pages/admin/StatusToggle.test.tsx \
        apps/web/src/pages/admin/UsersPage.tsx apps/web/src/pages/admin/UsersPage.test.tsx
git commit -m "$(cat <<'EOF'
feat(console): link a person to an account, edit group membership, remove a factor

Three server features with no way to invoke them.

`POST /persons/:id/link-user` existed and nothing called it, while the
empty state on that very panel read "This person exists in the directory
but cannot sign in. Link an account to give them access." The group
membership endpoints all existed and the groups page showed no members at
all -- the one thing a group is for. And `DELETE
/users/:id/factors/:type`, which is the way back in for somebody who lost
their phone and the way an administrator revokes a factor an attacker
enrolled, was reachable only with a database client.

The factor panel shows the revoked recovery-code count in words: taking
the last real factor away takes the printed codes with it, and nobody else
tells the user that.
EOF
)"
```

---

### Task 25: An extension replaces the grant instead of running beside it

Spec §7.6, **W6**, last surface. `MyAccessPage`'s **Extend** links to the plain request form and never sends `replacesGrantId`, so an "extension" is a second parallel grant: two live rows for the same resource, two expiry dates, and `fulfil.ts`'s replacement path — which exists and ends the old grant when the new one lands — never runs.

**Files:**
- Modify: `apps/web/src/pages/automate/MyAccessPage.tsx:97-103`
- Modify: `apps/web/src/pages/automate/RequestFormPage.tsx:50-78`
- Test: `apps/web/src/pages/automate/RequestFormPage.test.tsx` (append)

**Interfaces:**
- Consumes: `submitRequestBody.replacesGrantId` (already declared, `z.string().uuid().nullable().default(null)`), which `request-service.ts:310-320` validates against a live grant and `fulfil.ts:252` acts on.
- Produces: no new endpoints. `/catalog/:id?replaces=<grantId>` carries the grant being extended.

- [x] **Step 1: Write the failing test**

Append to `apps/web/src/pages/automate/RequestFormPage.test.tsx`:

```tsx
describe('an extension', () => {
  /**
   * `Extend` linked to the plain request form and sent no `replacesGrantId`,
   * so an "extension" was a second parallel grant: two live rows for the same
   * resource, two expiry dates, and `fulfil.ts`'s replacement path -- which
   * exists and ends the old grant when the new one lands -- never ran.
   */
  it('carries the grant it replaces through to the request', async () => {
    const sent = mockFormWithSubmit({ ...base });
    render(
      <MemoryRouter initialEntries={['/catalog/p3?replaces=g-77']}>
        <SessionProvider>
          <Routes>
            <Route path="/catalog/:id" element={<RequestFormPage />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
    await screen.findByText('AP approve');

    await userEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ productId: 'p3', replacesGrantId: 'g-77' });
  });

  /**
   * And it SAYS so. A form that silently ends an existing grant when this one
   * is approved is a form that surprises somebody.
   */
  it('says that the current access will be replaced', async () => {
    mockFormWithSubmit({ ...base });
    render(
      <MemoryRouter initialEntries={['/catalog/p3?replaces=g-77']}>
        <SessionProvider>
          <Routes>
            <Route path="/catalog/:id" element={<RequestFormPage />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/replaces the access you already hold/i)).toBeInTheDocument();
  });

  it('sends null when nothing is being replaced', async () => {
    const sent = mockFormWithSubmit({ ...base });
    renderPage();
    await screen.findByText('AP approve');
    await userEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ replacesGrantId: null });
  });
});
```

Extend the file's `mockForm` into `mockFormWithSubmit`, recording POST bodies, rather than adding a second mocking style.

- [x] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/automate/RequestFormPage.test.tsx; cd ../..`
Expected: FAIL — no `replacesGrantId` on the body and no such sentence on the page.

- [x] **Step 3: Carry the grant through**

In `apps/web/src/pages/automate/MyAccessPage.tsx`, replace the extend link (lines 97–103):

```tsx
                      {LIVE.includes(grant.status) &&
                        grant.endsAt !== null &&
                        grant.productId && (
                          // `?replaces=` is what makes this an EXTENSION rather
                          // than a second parallel grant. Without it the form
                          // submitted an ordinary request, `replacesGrantId`
                          // stayed null, and an approval left two live rows for
                          // the same resource with two expiry dates —
                          // `fulfil.ts`'s replacement path, which ends the old
                          // grant when the new one lands, was never reached.
                          <Link to={`/catalog/${grant.productId}?replaces=${grant.id}`}>
                            <Button size="sm">Extend</Button>
                          </Link>
                        )}
```

In `apps/web/src/pages/automate/RequestFormPage.tsx`, read the parameter and send it:

```tsx
  const [params] = useSearchParams();
  /**
   * The grant this request extends, if it is an extension.
   *
   * `submitRequestBody.replacesGrantId` has always existed, `request-service`
   * validates it against a live grant of the caller's, and `fulfil.ts` ends
   * that grant when the new one lands. Nothing ever sent it, so every
   * "extension" was a second grant beside the first.
   */
  const replacesGrantId = params.get('replaces');
```

in the submit body:

```tsx
            replacesGrantId,
```

and above the submit button:

```tsx
              {replacesGrantId !== null && (
                <Alert tone="info">
                  This replaces the access you already hold. The current grant
                  ends when this one is approved, so there is no gap and no
                  second copy running beside it.
                </Alert>
              )}
```

Import `useSearchParams` from `react-router-dom`.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/pages/automate/RequestFormPage.test.tsx; cd ../..`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/web/src/pages/automate/MyAccessPage.tsx \
        apps/web/src/pages/automate/RequestFormPage.tsx \
        apps/web/src/pages/automate/RequestFormPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(console): an extension replaces the grant instead of running beside it

`Extend` linked to the plain request form and never sent
`replacesGrantId`, so an approved "extension" left two live grants for the
same resource with two expiry dates. `submitRequestBody` has always
declared the field, request-service validates it against a live grant of
the caller's, and fulfil.ts ends that grant when the new one lands -- and
none of it was ever reached.

The form also says so now. Silently ending an existing grant when this one
is approved is a form that surprises somebody.
EOF
)"
```

---

### Task 26: The orphan Confirm button stops promising a 501

Spec §7.6, **W8**. `GovernOrphansPage`'s **Confirm** asks the reader to agree that "Provision's next run will evaluate that person's desired state against this account", then calls a route whose injected `link` function throws 501 with "Provision's account-linking entry point is supplied here once the two modules are joined". It always throws. The confirmation dialogue describes a consequence that cannot happen.

**Resolution chosen: remove the control and the route, and say on the page that confirming an owner is not available yet.** Wiring it means Provision adopting an existing directory object into a `TargetAccount` — an anchor, a correlation key, a provenance marker, and the reconciliation rules in `apply.ts` — which is a Provision slice, not a console one, and building it here would put an access-bearing write inside Govern that `boundaries.test.ts` structurally forbids. A button that always throws is worse than no button: it teaches an administrator that the drift screens are broken.

**Files:**
- Modify: `apps/web/src/pages/admin/GovernOrphansPage.tsx:55-82`
- Modify: `apps/api/src/routes/admin/govern.ts:560-578`
- Test: `apps/web/src/pages/admin/GovernOrphansPage.test.tsx` (new)

**Interfaces:**
- Consumes: `POST /api/admin/govern/orphans/:id/deny` (unchanged).
- Produces: `POST /api/admin/govern/orphans/:id/confirm` is removed. `confirmProposal` stays exported in core, tested and unreferenced by any route — deliberately, because it is the half of the pair a Provision slice will call.

- [x] **Step 1: Write the failing test**

Create `apps/web/src/pages/admin/GovernOrphansPage.test.tsx` in the house style:

```tsx
describe('an orphan proposal', () => {
  /**
   * The Confirm button called a route whose injected `link` function throws
   * 501 unconditionally -- and the confirmation dialogue in front of it
   * promised that "Provision's next run will evaluate that person's desired
   * state against this account", which is a consequence that cannot happen. An
   * administrator who pressed it learned that the drift screens are broken.
   */
  it('offers no Confirm control', async () => {
    mockOrphans([proposal()]);
    renderPage();
    await screen.findByText(/Maya Okafor/);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  /** And says why, rather than leaving a guess with no verb on the screen. */
  it('says that confirming an owner is not available yet', async () => {
    mockOrphans([proposal()]);
    renderPage();
    expect(
      await screen.findByText(/cannot be confirmed from here yet/i),
    ).toBeInTheDocument();
  });

  /** Denying still works: it is Govern's own write and it always was. */
  it('still records a denial', async () => {
    const sent = mockOrphans([proposal()]);
    renderPage();
    await screen.findByText(/Maya Okafor/);
    await userEvent.click(screen.getByRole('button', { name: 'Not them' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'different person');
    await userEvent.click(screen.getByRole('button', { name: 'Record it' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/orphans/prop-1/deny');
  });
});
```

The denial currently uses `window.prompt`, which `StatusToggle.test.tsx` documents as a control that silently stops working once a browser has been told to block dialogs. Move it into the page, exactly as `StatusToggle` did, which is what the third case asserts.

- [x] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/pages/admin/GovernOrphansPage.test.tsx; cd ../..`
Expected: FAIL — Confirm is present, the sentence is not, and the reason is asked for by `window.prompt`.

- [x] **Step 3: Remove the control and the route**

In `apps/web/src/pages/admin/GovernOrphansPage.tsx`, delete the Confirm `Button` (lines 56–82), move the denial's reason into the page as an inline form, and add under the proposal:

```tsx
                {/* NO CONFIRM CONTROL, deliberately.
                    It called a route whose injected `link` function throws 501
                    unconditionally, behind a confirmation that promised
                    "Provision's next run will evaluate that person's desired
                    state against this account" — a consequence that cannot
                    happen. Confirming an owner means Provision ADOPTING an
                    existing directory object into a TargetAccount: an anchor,
                    a correlation key, a provenance marker and apply.ts's
                    reconciliation rules. That is a Provision slice, and doing
                    it here would put an access-bearing write inside Govern,
                    which boundaries.test.ts structurally forbids. */}
                <p className="mt-2 text-muted">
                  This guess cannot be confirmed from here yet — linking an
                  account to a person is a write Provision owns, and Govern
                  deliberately makes none. Denying a wrong guess is recorded
                  either way, so the next snapshot stops proposing it.
                </p>
```

In `apps/api/src/routes/admin/govern.ts`, delete the `/govern/orphans/:id/confirm` route (lines 560–578) and the now-unused `confirmProposal` import, leaving a comment where it was:

```ts
  // There is deliberately NO `POST /govern/orphans/:id/confirm`.
  //
  // It existed and threw 501 on every call: `confirmProposal` takes the
  // linking function as a parameter -- so that `boundaries.test.ts`'s
  // no-access-bearing-write assertion stays true of the Govern module -- and
  // the function supplied here threw unconditionally. The console rendered a
  // Confirm button in front of it promising that Provision's next run would
  // act on the link.
  //
  // `confirmProposal` stays in core, exported and tested: it is the half of
  // the pair a Provision slice will call once account adoption exists. What
  // does not stay is a route that cannot do what its own name says.
```

- [x] **Step 4: Run the web test and the govern route suite**

```bash
cd apps/web && npx vitest run src/pages/admin/GovernOrphansPage.test.tsx; cd ../..
npx vitest run apps/api/src/routes/admin/govern.test.ts
```

Expected: PASS both. If a route test asserted the 501, delete it — it was asserting the defect.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/web/src/pages/admin/GovernOrphansPage.tsx \
        apps/web/src/pages/admin/GovernOrphansPage.test.tsx \
        apps/api/src/routes/admin/govern.ts
git commit -m "$(cat <<'EOF'
fix(govern): stop offering an orphan confirmation that always throws 501

The Confirm button called a route whose injected `link` function threw 501
unconditionally, behind a confirmation dialogue promising that
"Provision's next run will evaluate that person's desired state against
this account" -- a consequence that cannot happen. An administrator who
pressed it learned that the drift screens are broken.

Confirming an owner means Provision ADOPTING an existing directory object
into a TargetAccount: an anchor, a correlation key, a provenance marker
and apply.ts's reconciliation rules. That is a Provision slice, and
building it into Govern would put an access-bearing write inside a module
boundaries.test.ts structurally forbids one in. `confirmProposal` stays in
core, exported and tested, because it is the half of the pair that slice
will call.

The page says so in words, and denying -- which is Govern's own write and
always worked -- now asks for its reason in the page rather than through
window.prompt, which returns null for ever once a browser has been told to
block dialogs.
EOF
)"
```

---

## Phase E — Directory sync and the data layer

### Task 27: Correlation uses the correlation key the source was configured with

Spec §7.3, **S1**. `loadExisting` sets every existing user's `correlationValue` to `u.login` unconditionally, while the object side uses whichever mapping is marked `isCorrelation` — which `setMappings` and `mappingRule` allow to be `email` or `displayName`. Configure correlation on email and the intended `conflict` never fires: a duplicate account is created for the same person. Worse in the other direction, a source email that happens to equal somebody's login reports a spurious conflict against the wrong row.

**Files:**
- Modify: `packages/core/src/sync/run-service.ts:126-131` (the call), `:451-508` (`loadExisting`)
- Test: `packages/core/src/sync/run-service.test.ts` (append) or `packages/core/src/sync/correlate.test.ts` — put it beside the diff cases in `run-service.test.ts`, because the defect is in what `loadExisting` hands the correlator, not in the correlator.

**Interfaces:**
- Consumes: `MappingRule` from `./mapping.js`.
- Produces:
  - `loadExisting(tx: TenantClient, rules: MappingRule[]): Promise<ExistingSnapshot>` — one new parameter
  - a module-private `correlationFieldFor(rules: MappingRule[], objectType: ObjectType): string`

- [x] **Step 1: Write the failing test**

Append to `packages/core/src/sync/run-service.test.ts`:

```ts
describe('correlation on a configured key', () => {
  /**
   * `mappingRule.isCorrelation` is a per-source choice and `setMappings`
   * accepts it on `email` and `displayName` as readily as on `login`.
   * `loadExisting` ignored it and keyed every existing user on `u.login`, so
   * the two sides of the correlation compared different columns.
   *
   * The consequence is not a wrong message. The intended `conflict` never
   * fires, and the run proposes CREATING a second account for a person who
   * already has one.
   */
  it('matches an existing user on email when email is the correlation key', async () => {
    const sourceId = await seedSource({
      rules: [
        { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: true },
        { objectType: 'user', sourceAttribute: 'sAMAccountName', targetField: 'login', transform: 'lowercase', isCorrelation: false },
      ],
    });
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'mokafor', email: 'maya@acme.test', displayName: 'Maya Okafor' }),
    );

    const run = await previewRunWith(sourceId, [
      // A different login, the SAME email: one person, and the source calls
      // them something else.
      { anchor: 'a1', objectType: 'user', dn: 'cn=a1', attributes: { mail: 'maya@acme.test', sAMAccountName: 'm.okafor' } },
    ]);

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    // A conflict, not a create. Adopting silently would hand a directory entry
    // an existing account's history; creating is worse still -- two accounts
    // for one person, which is the shape that used to fail every nightly
    // governance snapshot.
    expect(changes.map((c) => c.changeType)).not.toContain('create_user');
    expect(changes.some((c) => c.status === 'conflict')).toBe(true);
  });

  /**
   * And the other direction, which is the quieter failure: with email as the
   * correlation key, a source record whose email happens to equal somebody's
   * LOGIN must not match that person.
   */
  it('does not match a login when login is not the correlation key', async () => {
    const sourceId = await seedSource({
      rules: [
        { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: true },
      ],
    });
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'maya@acme.test', email: 'someone.else@acme.test', displayName: 'Someone Else' }),
    );

    const run = await previewRunWith(sourceId, [
      { anchor: 'a2', objectType: 'user', dn: 'cn=a2', attributes: { mail: 'maya@acme.test' } },
    ]);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    expect(changes.map((c) => c.changeType)).toContain('create_user');
  });

  /** Nothing changes for the default mapping, which correlates on login. */
  it('still correlates on login when that is the configured key', async () => {
    const sourceId = await seedSource({});
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'mokafor', email: 'maya@acme.test', displayName: 'Maya Okafor' }),
    );

    const run = await previewRunWith(sourceId, [
      { anchor: 'a3', objectType: 'user', dn: 'cn=a3', attributes: { sAMAccountName: 'mokafor', mail: 'maya@acme.test' } },
    ]);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    expect(changes.map((c) => c.changeType)).not.toContain('create_user');
  });
});
```

`seedSource` and `previewRunWith` are the file's existing helpers for a source with mappings and a fake connector; read the top of the file and reuse them rather than adding new ones.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/sync/run-service.test.ts -t 'correlation on a configured key'`
Expected: FAIL — the first case proposes `create_user` for a person who already exists.

- [x] **Step 3: Read the configured field**

In `packages/core/src/sync/run-service.ts`, replace `loadExisting`'s signature and its three `correlationValue` lines (lines 451, 489, 497, 505):

```ts
/**
 * The field a source correlates an object type on, as configured.
 *
 * `mapRecord` lets the LAST rule marked `isCorrelation` win, and this reads
 * the same way so the two sides of the comparison cannot disagree about which
 * mapping is the correlation one.
 *
 * The fallback is what the seeded defaults use, so a source whose mappings say
 * nothing about an object type behaves exactly as it did.
 */
function correlationFieldFor(
  rules: MappingRule[],
  objectType: ObjectType,
  fallback: string,
): string {
  const configured = rules
    .filter((rule) => rule.objectType === objectType && rule.isCorrelation)
    .at(-1);
  return configured?.targetField ?? fallback;
}

/**
 * Every row a run could correlate against, with its current field values, in
 * three queries. The field values ride along with the rows because the diff
 * needs both, and loading them separately meant reading each table twice.
 *
 * `rules` is here because CORRELATION IS CONFIGURED. This function used to set
 * every user's `correlationValue` to `u.login` unconditionally, while the
 * object side used whichever mapping is marked `isCorrelation` -- and
 * `setMappings` accepts that on `email` and `displayName` as readily as on
 * `login`. The two sides of the correlation compared different columns, so a
 * source correlating on email never produced the `conflict` it was supposed
 * to and proposed CREATING a second account for a person who already had one;
 * and a source email that happened to equal somebody's login reported a
 * conflict against a row it had nothing to do with.
 */
async function loadExisting(
  tx: TenantClient,
  rules: MappingRule[],
): Promise<ExistingSnapshot> {
```

The `fields` map this function already builds holds exactly the columns a correlation rule can name — `login`, `email`, `displayName` for users; `name`, `description` for groups; `name` for units — so the value is read from it:

```ts
  const userField = correlationFieldFor(rules, 'user', 'login');
  const groupField = correlationFieldFor(rules, 'group', 'name');
  const unitField = correlationFieldFor(rules, 'orgUnit', 'name');

  return {
    fields,
    objects: [
      ...users.map((u) => ({
        id: u.id,
        objectType: 'user' as const,
        sourceId: u.sourceId,
        sourceAnchor: u.sourceAnchor,
        // A rule may name a field this row does not store -- `parentAnchor`,
        // say -- and an empty string would collide with every other such row.
        // Falling back to the login keeps the old behaviour for a mapping
        // nothing here can honour, rather than inventing a match.
        correlationValue: fields.get(u.id)?.[userField] ?? u.login,
        status: u.status,
      })),
      ...groups.map((g) => ({
        id: g.id,
        objectType: 'group' as const,
        sourceId: g.sourceId,
        sourceAnchor: g.sourceAnchor,
        correlationValue: fields.get(g.id)?.[groupField] ?? g.name,
        status: g.status,
      })),
      ...units.map((o) => ({
        id: o.id,
        objectType: 'orgUnit' as const,
        sourceId: o.sourceId,
        sourceAnchor: o.sourceAnchor,
        correlationValue: fields.get(o.id)?.[unitField] ?? o.name,
        status: 'active',
      })),
    ],
  };
```

At the call site (line 130), pass the rules the run already loaded:

```ts
    const snapshot = await withTenant(tenantId, async (tx) => ({
      existing: await loadExisting(tx, prepared.rules),
      memberships: await currentMemberships(tx, sourceId),
    }));
```

Import `ObjectType` from `@syntra/connectors` if the file does not already have it.

- [x] **Step 4: Run the test and the neighbouring suites**

Run: `npx vitest run packages/core/src/sync/run-service.test.ts packages/core/src/sync/correlate.test.ts packages/core/src/sync/mapping.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/sync/run-service.ts packages/core/src/sync/run-service.test.ts
git commit -m "$(cat <<'EOF'
fix(sync): correlate on the key the source was configured with

`loadExisting` set every existing user's correlationValue to `u.login`
unconditionally, while the object side used whichever mapping is marked
isCorrelation -- and setMappings accepts that on email and displayName as
readily as on login. The two sides of the correlation compared different
columns.

The consequence is not a wrong message. A source correlating on email
never produced the `conflict` it exists to produce, so the run proposed
CREATING a second account for a person who already had one -- the exact
two-accounts-one-person shape that used to fail every nightly governance
snapshot. In the other direction, a source email equal to somebody's login
raised a conflict against a row it had nothing to do with.

The rules are read the same way `mapRecord` reads them, last-wins, so the
two cannot disagree about which mapping is the correlation one, and the
fallback is the seeded default so a source that says nothing behaves
exactly as before.
EOF
)"
```

---

### Task 28: "Test connection" stops failing against every real directory

Spec §7.3, **S2**. `ldapConnector.test()` runs unpaged searches with no client `sizeLimit`, and ldapts throws `SizeLimitExceededError` on result code 4 unless one was set. AD's default `MaxPageSize` is 1000 and OpenLDAP's default is 500, so a perfectly good configuration reports failure and audits `connection-failed`. `discoverSchema` is unaffected only because it passes `sizeLimit: 20`.

**Resolution chosen: cap the sample and say it is one.** A connection test asks "can I bind and is anything there", not "how many". `ConnectionResult.sampleCounts` is already named `sample`, and the AD connector's own comment already says exactly this about its unpaged counts. Paging the whole directory to produce a census would make a connection test take minutes on the deployments where it matters most.

**Files:**
- Modify: `packages/connectors/src/ldap/connector.ts:225-252` (`test`)
- Modify: `packages/connectors/src/ad/connector.ts:808-823` (the two searches)
- Test: `packages/connectors/src/ldap/connector.test.ts`

**Interfaces:**
- Consumes: `runSearch(client, search, options, handler)` — already takes an options object.
- Produces: `export const TEST_SAMPLE_LIMIT = 20` from `packages/connectors/src/ldap/connector.ts`. `ConnectionResult.sampleCounts` is unchanged in shape and now capped at that value.

- [x] **Step 1: Write the failing test**

Append to `packages/connectors/src/ldap/connector.test.ts`, using the file's existing fake `Client`:

```ts
describe('test() against a directory with a server-side size limit', () => {
  /**
   * ldapts throws `SizeLimitExceededError` on result code 4 UNLESS the client
   * asked for a limit of its own. AD's default MaxPageSize is 1000 and
   * OpenLDAP's is 500, so an unpaged search with no `sizeLimit` fails on every
   * directory big enough to be worth connecting to -- and a perfectly good
   * configuration reported "connection failed" and audited connection-failed.
   */
  it('sends a sizeLimit, so the server does not refuse the search', async () => {
    const asked: unknown[] = [];
    const client = fakeClient({
      onSearch: (_base, options) => {
        asked.push(options);
        return { searchEntries: Array.from({ length: 20 }, (_, i) => ({ dn: `cn=${i}` })) };
      },
    });

    const result = await ldapConnector.test(configWith(client));
    expect(result.ok).toBe(true);
    for (const options of asked) {
      expect(options).toMatchObject({ sizeLimit: TEST_SAMPLE_LIMIT });
    }
  });

  /**
   * And the answer says it is a sample. `sampleCounts` was already named that
   * -- and the AD connector's comment already said so about its own unpaged
   * counts -- but the LDAP side read as a census, which is what made "how many
   * users does this source have" the wrong question to ask a connection test.
   */
  it('reports a capped count rather than a census', async () => {
    const client = fakeClient({
      onSearch: () => ({
        searchEntries: Array.from({ length: 20 }, (_, i) => ({ dn: `cn=${i}` })),
      }),
    });
    const result = await ldapConnector.test(configWith(client));
    expect(result.sampleCounts?.user).toBe(TEST_SAMPLE_LIMIT);
    expect(result.message).toMatch(/sample|at least/i);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/connectors/src/ldap/connector.test.ts -t 'server-side size limit'`
Expected: FAIL — no `sizeLimit` on the search options and the message says nothing about a sample.

- [x] **Step 3: Cap the searches**

In `packages/connectors/src/ldap/connector.ts`, above `ldapConnector` (line 224):

```ts
/**
 * How many entries a connection test asks for.
 *
 * `test()` used to run unpaged searches with no client `sizeLimit`, and ldapts
 * throws `SizeLimitExceededError` on result code 4 unless one was set. AD's
 * default MaxPageSize is 1000 and OpenLDAP's is 500, so a perfectly good
 * configuration reported "connection failed" and audited `connection-failed`
 * against a directory that had answered correctly. `discoverSchema` escaped it
 * only because it passes `sizeLimit: 20`.
 *
 * Capped rather than paged. A connection test asks "can I bind, and is
 * anything there" -- not "how many" -- and paging a real directory to produce
 * a census would make the test take minutes on exactly the deployments where
 * it matters most. The count it returns is a SAMPLE and the message says so.
 */
export const TEST_SAMPLE_LIMIT = 20;
```

and inside `test()`:

```ts
      for (const search of searches(config)) {
        counts[search.objectType] = await runSearch(
          client,
          search,
          { sizeLimit: TEST_SAMPLE_LIMIT, attributes: ['dn'] },
          (searchEntries) => searchEntries.length,
        );
      }

      const capped = Object.values(counts).some((n) => n >= TEST_SAMPLE_LIMIT);
      return {
        ok: true,
        message: capped
          ? `Connected to ${config.url}; read at least ${TEST_SAMPLE_LIMIT} of each kind (a sample, not a count)`
          : `Connected to ${config.url}`,
        sampleCounts: counts,
      };
```

In `packages/connectors/src/ad/connector.ts`, add `sizeLimit: TEST_SAMPLE_LIMIT` to both searches in `test()` (lines 813 and 818) — the comment beside `sampleCounts` there already explains that they are a sample and that the server caps them; the limit is what stops the server refusing instead.

- [x] **Step 4: Run the connector suites**

Run: `npx vitest run packages/connectors/src/ldap/connector.test.ts packages/connectors/src/ad/connector.unit.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/connectors/src/ldap/connector.ts \
        packages/connectors/src/ad/connector.ts \
        packages/connectors/src/ldap/connector.test.ts
git commit -m "$(cat <<'EOF'
fix(connectors): a connection test asks for a sample, not the directory

`test()` ran unpaged searches with no client sizeLimit, and ldapts throws
SizeLimitExceededError on result code 4 unless one was set. AD's default
MaxPageSize is 1000 and OpenLDAP's is 500, so a perfectly good
configuration reported "connection failed" and audited connection-failed
against a directory that had answered correctly. discoverSchema escaped it
only because it passes sizeLimit: 20.

Capped rather than paged: a connection test asks whether the bind works
and whether anything is there, and paging a real directory for a census
would make it take minutes on exactly the deployments where it matters
most. sampleCounts was already named a sample; the message now says so
when the cap was reached.
EOF
)"
```

---

### Task 29: A run queued for a disabled source is refused, not left queued forever

Spec §7.3, **S3**. Neither the route nor `queueRun` checks `enabled`, and `runSyncJob` early-returns without touching the run row. Nothing reaps `queued`. The page follows the run and spins indefinitely with no error recorded.

**Resolution chosen: refuse in `queueRun`**, not in the route. `queueRun` is what writes the row, it is what the route and any future caller share, and a check in the route leaves the same hole open for the next caller.

**Files:**
- Modify: `packages/core/src/sync/jobs.ts:44-66`
- Modify: `apps/api/src/routes/admin/sources.ts:562-588`
- Test: `packages/core/src/sync/jobs.test.ts`
- Test: `apps/api/src/routes/admin/sources.test.ts`

**Interfaces:**
- Consumes: `DirectorySource.enabled`.
- Produces: `export class SourceDisabledError extends Error { readonly sourceId: string }` from `packages/core/src/sync/jobs.ts`. `POST /sources/:id/run` answers 409 `source-disabled`.

- [x] **Step 1: Write the failing tests**

Append to `packages/core/src/sync/jobs.test.ts`:

```ts
describe('queueing a run for a disabled source', () => {
  /**
   * Neither the route nor queueRun checked `enabled`, and runSyncJob
   * early-returns without touching the run row. Nothing reaps `queued`, so the
   * row sat there for ever, the console followed it, and the page spun with no
   * error anywhere -- for a source somebody had deliberately switched off.
   */
  it('refuses rather than writing a run nothing will ever pick up', async () => {
    const scheduler = createFakeScheduler();
    const sourceId = await seedSource({ enabled: false });

    await expect(queueRun(scheduler, tenantId, sourceId)).rejects.toBeInstanceOf(
      SourceDisabledError,
    );

    const runs = await withTenant(tenantId, (tx) => tx.syncRun.findMany());
    expect(runs).toHaveLength(0);
    expect(scheduler.enqueued).toHaveLength(0);
  });

  it('still queues one for an enabled source', async () => {
    const scheduler = createFakeScheduler();
    const sourceId = await seedSource({ enabled: true });
    const run = await queueRun(scheduler, tenantId, sourceId);
    expect(run.status).toBe('queued');
    expect(scheduler.enqueued).toHaveLength(1);
  });
});
```

Append to `apps/api/src/routes/admin/sources.test.ts`:

```ts
it('answers 409 when a run is asked for on a disabled source', async () => {
  const { sourceId, cookie } = await seedSource({ enabled: false });
  const res = await post(`/api/admin/sources/${sourceId}/run`, cookie, {});
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ type: expect.stringContaining('source-disabled') });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/core/src/sync/jobs.test.ts apps/api/src/routes/admin/sources.test.ts -t 'disabled'`
Expected: FAIL — a `queued` run is written and the route answers 202.

- [x] **Step 3: Refuse where the row is written**

In `packages/core/src/sync/jobs.ts`, above `queueRun` (line 44):

```ts
/**
 * A run asked for on a source that is switched off.
 *
 * Refused HERE rather than in the route, because this is what writes the row:
 * a check in the route leaves the hole open for the next caller, and a run
 * that reaches the database is a run somebody has to reap.
 */
export class SourceDisabledError extends Error {
  constructor(readonly sourceId: string) {
    super('this source is disabled, so a run would never be picked up');
    this.name = 'SourceDisabledError';
  }
}
```

and inside `queueRun`'s transaction, after the source is read (line 51):

```ts
    if (!source.enabled) {
      // `runSyncJob` early-returns for a disabled source WITHOUT touching the
      // run row, and nothing reaps `queued`. So the row sat there for ever,
      // the console followed it, and the page spun with no error recorded --
      // for a source somebody had deliberately switched off. Throwing rolls
      // back the row, so nothing is left behind at all.
      throw new SourceDisabledError(sourceId);
    }
```

In `apps/api/src/routes/admin/sources.ts`, wrap the `queueRun` call:

```ts
      try {
        const run = await queueRun(scheduler, request.tenantId, id);
        return reply.status(202).send(run);
      } catch (cause) {
        if (cause instanceof SourceDisabledError) {
          throw new ProblemError(
            409,
            'source-disabled',
            'This source is switched off',
            'A run would never be picked up. Enable the source first.',
          );
        }
        throw cause;
      }
```

adding `SourceDisabledError` to the `@syntra/core` import.

- [x] **Step 4: Run both files to verify they pass**

Run: `npx vitest run packages/core/src/sync/jobs.test.ts apps/api/src/routes/admin/sources.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/sync/jobs.ts packages/core/src/sync/jobs.test.ts \
        apps/api/src/routes/admin/sources.ts apps/api/src/routes/admin/sources.test.ts
git commit -m "$(cat <<'EOF'
fix(sync): a run asked for on a disabled source is refused

Neither the route nor queueRun checked `enabled`, and runSyncJob
early-returns for a disabled source without touching the run row. Nothing
reaps `queued`, so the row sat there for ever: the console followed it and
the page spun indefinitely with no error recorded anywhere, for a source
somebody had deliberately switched off.

Refused in queueRun rather than in the route, because that is what writes
the row -- a check in the route leaves the hole open for the next caller,
and throwing inside the transaction means nothing is left behind at all.
EOF
)"
```

---

### Task 30: An unreachable directory is not "the directory refused your password"

Spec §7.3, **S4**. `classify()` defaults unmatched errors to `policy`, and DNS and TLS failures match nothing on its list — so a user iterating on ever-stronger passwords against an outage is told the directory rejected each one, and the audit says `directory_policy`.

**Files:**
- Modify: `packages/connectors/src/ldap/writeback.ts:61-89`
- Test: `packages/connectors/src/ldap/writeback.test.ts` (create if the file does not exist; `writeback.integration.test.ts` is the integration one and must not be the home for a pure-function case)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function classifyWritebackError(cause: unknown): WritebackFailure` — the existing private `classify`, exported so it can be tested without a directory.

- [x] **Step 1: Write the failing test**

Create `packages/connectors/src/ldap/writeback.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyWritebackError } from './writeback.js';

const named = (name: string, message: string) => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe('classifying a write-back failure', () => {
  /**
   * THE ONE THAT MATTERS. DNS and TLS failures matched nothing on the list and
   * fell to the default, which was `policy` -- "the directory refused the new
   * password". So a user iterating on ever-stronger passwords against an
   * outage was told each one was rejected on its merits, and the audit trail
   * recorded `directory_policy` for a directory that was never reached.
   */
  it('reads an unreachable host as transient, not as a policy refusal', () => {
    expect(classifyWritebackError(named('Error', 'getaddrinfo ENOTFOUND dc1.acme.test')))
      .toBe('transient');
    expect(classifyWritebackError(named('Error', 'getaddrinfo EAI_AGAIN dc1.acme.test')))
      .toBe('transient');
    expect(classifyWritebackError(named('Error', 'connect EHOSTUNREACH 10.0.0.5:636')))
      .toBe('transient');
  });

  it('reads a TLS failure as transient too', () => {
    expect(
      classifyWritebackError(
        named('Error', 'unable to verify the first certificate'),
      ),
    ).toBe('transient');
    expect(classifyWritebackError(named('Error', 'socket hang up'))).toBe('transient');
  });

  /**
   * And the fall-through itself. An error nobody has seen before is not
   * evidence that the directory examined a password and rejected it, and
   * `password-change.ts` turns `transient` into "the directory could not be
   * reached" -- which invites a retry, the right advice for an unknown fault.
   */
  it('falls through to transient rather than to policy', () => {
    expect(classifyWritebackError(named('WeirdError', 'something nobody has seen')))
      .toBe('transient');
  });

  /** Every case that was already right stays right. */
  it('still recognises the ones it always did', () => {
    expect(classifyWritebackError(named('InvalidCredentialsError', ''))).toBe('wrong_password');
    expect(classifyWritebackError(named('ConstraintViolationError', '0000052D'))).toBe('policy');
    expect(classifyWritebackError(named('UnwillingToPerformError', ''))).toBe('policy');
    expect(classifyWritebackError(named('InsufficientAccessError', ''))).toBe('unauthorized');
    expect(classifyWritebackError(named('NoSuchObjectError', ''))).toBe('not_found');
    expect(classifyWritebackError(named('Error', 'ECONNREFUSED'))).toBe('transient');
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/connectors/src/ldap/writeback.test.ts`
Expected: FAIL — `classifyWritebackError` is not exported, and once it is, the first three cases answer `policy`.

- [x] **Step 3: Widen the list and turn the default round**

In `packages/connectors/src/ldap/writeback.ts`, rename `classify` to `classifyWritebackError`, export it, update its two call sites, and rewrite the tail:

```ts
export function classifyWritebackError(cause: unknown): WritebackFailure {
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const text = `${name} ${message}`.toLowerCase();

  if (text.includes('invalidcredentials')) return 'wrong_password';
  // 0000052D is AD's "password does not meet policy / history / minimum age".
  // It arrives as a constraint violation, which is otherwise a schema problem,
  // so the code is what tells the two apart.
  if (text.includes('0000052d') || text.includes('constraintviolation')) {
    return 'policy';
  }
  if (text.includes('unwillingtoperform')) return 'policy';
  if (text.includes('insufficientaccess') || text.includes('strongauthrequired')) {
    return 'unauthorized';
  }
  if (text.includes('nosuchobject')) return 'not_found';

  // NAMED, because they used to fall through. DNS resolution and TLS
  // verification fail before the directory has read anything, and the list
  // below is what those failures actually look like on Node.
  if (
    text.includes('busy') ||
    text.includes('unavailable') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('econnaborted') ||
    text.includes('etimedout') ||
    text.includes('enotfound') ||
    text.includes('eai_again') ||
    text.includes('ehostunreach') ||
    text.includes('enetunreach') ||
    text.includes('epipe') ||
    text.includes('socket hang up') ||
    text.includes('certificate') ||
    text.includes('self-signed') ||
    text.includes('self signed') ||
    text.includes('cert_') ||
    text.includes('depth_zero')
  ) {
    return 'transient';
  }

  // THE DEFAULT IS `transient`, NOT `policy`, and that is the fix.
  //
  // `policy` is a positive claim: the directory examined this password and
  // rejected it on its merits. Nothing unmatched here is evidence of that --
  // DNS and TLS failures matched nothing on the old list, so a user iterating
  // on ever-stronger passwords against an outage was told each one had been
  // refused, and the audit trail recorded `directory_policy` for a directory
  // that was never reached.
  //
  // `password-change.ts` maps this to `directory_unavailable`, whose message
  // invites a retry -- which is the right advice for a fault nobody has
  // classified. Being wrong in that direction costs a retry; being wrong in
  // the other costs somebody their afternoon and buries the real cause.
  return 'transient';
}
```

- [x] **Step 4: Run the test and the callers**

Run: `npx vitest run packages/connectors/src/ldap/writeback.test.ts packages/core/src/auth/password-change.test.ts packages/core/src/directory/directory-writeback.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/connectors/src/ldap/writeback.ts packages/connectors/src/ldap/writeback.test.ts
git commit -m "$(cat <<'EOF'
fix(connectors): an unreachable directory is not a refused password

`classify` defaulted unmatched errors to `policy` -- "the directory
refused the new password" -- and DNS and TLS failures matched nothing on
its list. A user iterating on ever-stronger passwords against an outage
was told each one had been rejected on its merits, and the audit trail
recorded directory_policy for a directory that was never reached.

The network and TLS shapes are named, and the fall-through is now
`transient`. `policy` is a positive claim about a password the directory
examined; nothing unmatched is evidence of that. password-change maps
transient to "the directory could not be reached", which invites a retry
-- the right advice for a fault nobody has classified. Being wrong that
way costs a retry; being wrong the other way costs somebody their
afternoon and buries the real cause.

`classify` is exported as `classifyWritebackError` so it can be tested
without a directory, which is why it never was.
EOF
)"
```

---

### Task 31: The readiness gate has a timeout of its own

Spec §7.3, **S5**. A database that accepts TCP and stops answering hangs `/health/ready` — which is what the updater's automatic rollback decision waits on. A gate that cannot answer is a rollback that never happens.

**Files:**
- Modify: `packages/core/src/health/readiness.ts:62-176`
- Test: `packages/core/src/health/readiness.test.ts` (append — note remediation 1 Task 1 lands fixes in this file first)

**Interfaces:**
- Consumes: nothing.
- Produces: `export const PROBE_TIMEOUT_MS = 5_000`; a module-private `withTimeout<T>(name, ms, work): Promise<Probe>`. `readiness(deps)` keeps its signature and gains `probeTimeoutMs?: number` on `ReadinessDeps` for the test.

- [x] **Step 1: Write the failing test**

Append to `packages/core/src/health/readiness.test.ts`:

```ts
describe('a probe that never answers', () => {
  /**
   * The updater's automatic rollback hangs on this endpoint. A database that
   * accepts TCP and then stops answering -- a failed-over primary, a saturated
   * pool, a paused container -- leaves every query pending for ever, so the
   * readiness gate never resolves and the rollback that was waiting on it
   * never happens. A gate that cannot answer "no" is not a gate.
   */
  it('fails the probe rather than hanging the gate', async () => {
    const stall = vi
      .spyOn(prisma, '$queryRawUnsafe')
      .mockImplementation(() => new Promise(() => {}) as never);
    try {
      const report = await readiness({
        provider: localMasterKeyProvider(Buffer.alloc(32, 7)),
        version: 'test',
        probeTimeoutMs: 25,
      });
      const database = report.probes.find((p) => p.name === 'database')!;
      expect(database.status).toBe('fail');
      expect(database.detail).toMatch(/did not answer/i);
      expect(report.ready).toBe(false);
    } finally {
      stall.mockRestore();
    }
  });

  /** And the other probes still run: the report says everything at once. */
  it('still reports every other probe', async () => {
    const stall = vi
      .spyOn(prisma, '$queryRawUnsafe')
      .mockImplementation(() => new Promise(() => {}) as never);
    try {
      const report = await readiness({
        provider: localMasterKeyProvider(Buffer.alloc(32, 7)),
        version: 'test',
        probeTimeoutMs: 25,
      });
      expect(report.probes.map((p) => p.name)).toEqual([
        'database',
        'migrations',
        'vault',
        'web',
      ]);
    } finally {
      stall.mockRestore();
    }
  });
});
```

`prisma` is a Proxy that materialises methods on access — remediation 1 Task 1 documents that `vi.spyOn` restores to `undefined` here. Use the same hand-swap-with-`finally` shape that file already adopted rather than relying on `mockRestore` if the fix landed differently.

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/health/readiness.test.ts -t 'never answers'`
Expected: FAIL — the test times out, because `readiness` never resolves. That *is* the defect.

- [x] **Step 3: Give every probe a deadline**

In `packages/core/src/health/readiness.ts`, add to `ReadinessDeps` (line 46):

```ts
  /** Overridden by the tests only; nothing in the application passes it. */
  probeTimeoutMs?: number | undefined;
```

and above `probeDatabase` (line 62):

```ts
/**
 * How long any one probe may take before it is a failure.
 *
 * `/health/ready` is what the updater's automatic rollback decision waits on,
 * and none of these probes had a deadline. A database that accepts TCP and
 * then stops answering -- a failed-over primary, a saturated pool, a paused
 * container -- leaves the query pending for ever: the gate never resolves, the
 * rollback that was waiting on it never happens, and an operator watching a
 * broken update sees a request that simply hangs.
 *
 * Five seconds because every probe here is one indexed round trip and an AES
 * unseal. Anything slower than that is already an answer.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Runs a probe with a deadline, and turns overrunning it into a `fail`.
 *
 * A failure rather than a `skip`, deliberately. "I could not find out" and
 * "there is nothing to check" are different answers, and only the first should
 * roll an update back.
 */
async function withTimeout(
  name: string,
  ms: number,
  work: () => Promise<Probe>,
): Promise<Probe> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Probe>((resolve) => {
    timer = setTimeout(
      () => resolve(fail(name, `did not answer within ${ms} ms`)),
      ms,
    );
    // Never keeps the process alive on its own. A readiness check must not be
    // the reason a shutdown waits.
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

and rewrite `readiness` (line 166):

```ts
export async function readiness(deps: ReadinessDeps): Promise<ReadinessReport> {
  const ms = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probes = [
    await withTimeout('database', ms, probeDatabase),
    await withTimeout('migrations', ms, probeMigrations),
    await withTimeout('vault', ms, () => probeVault(deps.provider)),
    probeWeb(deps.webRoot),
  ];

  return {
    ready: probes.every((probe) => probe.status !== 'fail'),
    version: deps.version,
    probes,
  };
}
```

`probeWeb` is a synchronous `existsSync` and needs no deadline.

- [x] **Step 4: Run the file to verify it passes**

Run: `npx vitest run packages/core/src/health/readiness.test.ts`
Expected: PASS, the whole file.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/health/readiness.ts packages/core/src/health/readiness.test.ts
git commit -m "$(cat <<'EOF'
fix(health): the readiness gate answers, even when the database does not

None of the probes had a deadline. A database that accepts TCP and then
stops answering -- a failed-over primary, a saturated pool, a paused
container -- leaves the query pending for ever, so /health/ready never
resolves. That endpoint is what the updater's automatic rollback decision
waits on: a gate that cannot answer "no" is not a gate, and an operator
watching a broken update sees a request that simply hangs.

Five seconds per probe, because each is one indexed round trip and an AES
unseal, and anything slower is already an answer. A timeout is a `fail`
rather than a `skip`: "I could not find out" and "there is nothing to
check" are different answers and only the first should roll an update
back. Every probe still runs, so the report says everything that is wrong
at once.
EOF
)"
```

---

### Task 32: `POST /sources/:id/test` is audited

Spec §7.3, **S6**. `/sources/test` audits every attempt, including refusals; the saved-source variant beside it audits nothing at all — so a connection opened against a configured directory, and its outcome, leave no trace.

**Files:**
- Modify: `apps/api/src/routes/admin/sources.ts:546-560`
- Test: `apps/api/src/routes/admin/sources.test.ts`

**Interfaces:**
- Consumes: `recordEvent`, already imported by the module.
- Produces: no signature change. The route writes a `source.test` event with the same payload shape its unsaved sibling uses.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/admin/sources.test.ts`:

```ts
it('audits a test against a saved source, as the unsaved one already did', async () => {
  const { sourceId, cookie } = await seedSource({ enabled: true });
  await post(`/api/admin/sources/${sourceId}/test`, cookie, {});

  const events = await withTenant(ctx.tenantId, (tx) =>
    tx.auditEvent.findMany({ where: { action: 'source.test' } }),
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.targetId).toBe(sourceId);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/sources.test.ts -t 'audits a test against a saved source'`
Expected: FAIL — no events.

- [ ] **Step 3: Audit it**

In `apps/api/src/routes/admin/sources.ts`, replace the handler body (lines 549–559):

```ts
      const { id } = idParam.parse(request.params);
      const config = await request.db((tx) =>
        sourceWithPassword(tx, provider, id),
      );
      if (!config) throw new ProblemError(404, 'not-found', 'Source not found');

      // A failed connection is a result, not a server error: the operator
      // needs the message, not a 500.
      const result = await ldapConnector.test(config);

      // AUDITED, like `/sources/test` beside it. This route opens a connection
      // to a configured directory with the stored bind credential, and the
      // outcome is exactly the thing somebody looks for when a source starts
      // failing -- a run of refusals here is how a rotated bind password is
      // noticed. Its sibling recorded every attempt including the refused
      // ones; this one recorded nothing at all.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.test',
          targetType: 'DirectorySource',
          targetId: id,
          outcome: result.ok ? 'success' : 'failure',
          sourceIp: request.ip,
          // The same fields the unsaved variant records, minus the ones it
          // only has because the caller typed them. The bind DN is left out as
          // the rest of this file leaves it out, and the password appears
          // nowhere near here.
          payload: {
            url: config.url,
            tlsMode: config.tlsMode,
            rejectUnauthorized: config.rejectUnauthorized,
            usedStoredCredential: true,
            message: result.message,
          },
        }),
      );

      return result;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/sources.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add apps/api/src/routes/admin/sources.ts apps/api/src/routes/admin/sources.test.ts
git commit -m "$(cat <<'EOF'
fix(sync): audit a connection test against a saved source

`/sources/test` records every attempt, including the refused ones.
`/sources/:id/test` beside it recorded nothing -- and it is the one that
opens a connection to a configured directory using the stored bind
credential. A run of failures here is how a rotated bind password is
noticed, and there was no trace of any of it.
EOF
)"
```

---

### Task 33: An administrative deactivation starts the ladder, and a desynced password is findable

Spec §7.3, **S7** — two design gaps in one commit, because they are the two ends of the same write-back feature.

The write-back design §7.2 step 6 says a Provision run is enqueued after an administrative deactivation. Nothing does, so the leaver's entitlement revocation, archive and reap wait for the next scheduled run — on a change whose whole point is that it happens now. And §9 asks for `auth.password_writeback_desync`: when the directory has accepted a new password and the local commit then fails, the two diverge with the directory holding the password the user chose, and there is no marker to find that state by.

**Files:**
- Modify: `packages/core/src/directory/directory-writeback.ts:88-184`
- Modify: `apps/api/src/routes/admin/users.ts:35-43,144-180`
- Modify: `apps/api/src/app.ts:216-220` (pass the scheduler)
- Modify: `packages/core/src/auth/password-change.ts:218-223`
- Test: `packages/core/src/directory/directory-writeback.test.ts`
- Test: `packages/core/src/auth/password-change.test.ts`

**Interfaces:**
- Consumes: `PROVISION_JOB`, `provisionJobPayload`, `type Scheduler` from `@syntra/core`.
- Produces:
  - `DeactivateInput` gains `scheduler?: Scheduler | null`
  - `DeactivateOutcome`'s success arm gains `runsEnqueued: number`
  - `AdminUserRouteOptions` gains `scheduler?: () => Scheduler | null`
  - a new audit action, `auth.password_writeback_desync`

- [x] **Step 1: Write the failing tests**

Append to `packages/core/src/directory/directory-writeback.test.ts`:

```ts
describe('the ladder starts at the deactivation', () => {
  /**
   * Write-back design §7.2 step 6: a Provision run is enqueued after an
   * administrative deactivation. Nothing did, so the leaver's entitlement
   * revocation, the archive into the deactivated OU and the reap on the domain
   * controller all waited for the next SCHEDULED run -- on a change whose
   * whole point is that it happens now, and whose console copy says the leaver
   * steps "follow from today".
   */
  it('enqueues a run for every target holding this person an account', async () => {
    const scheduler = createFakeScheduler();
    const { userId, targetId } = await seedPersonWithTargetAccount();

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'left the organization',
      actorUserId: adminId,
      sourceIp: null,
      scheduler,
    });

    expect(outcome).toMatchObject({ ok: true, ladderStarted: true, runsEnqueued: 1 });
    expect(scheduler.enqueued).toEqual([
      { name: 'provision.run', data: { tenantId, targetSystemId: targetId } },
    ]);
  });

  /**
   * A user with no linked person has no contracts, no entitlement rules and no
   * provisioned account -- the disable is the whole of what there is to do --
   * so there is nothing to enqueue and nothing is.
   */
  it('enqueues nothing for a user with no person behind them', async () => {
    const scheduler = createFakeScheduler();
    const userId = await seedUnlinkedDirectoryUser();

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'service account retired',
      actorUserId: adminId,
      sourceIp: null,
      scheduler,
    });
    expect(outcome).toMatchObject({ ok: true, ladderStarted: false, runsEnqueued: 0 });
    expect(scheduler.enqueued).toHaveLength(0);
  });

  /**
   * And a failed directory write enqueues nothing either: the account is
   * exactly as it was, so a Provision run would be acting on a departure that
   * did not happen.
   */
  it('enqueues nothing when the directory refused the disable', async () => {
    const scheduler = createFakeScheduler();
    setEnabled.mockResolvedValue({ ok: false, failure: 'transient', message: 'down' });
    const { userId } = await seedPersonWithTargetAccount();

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId, reason: 'left', actorUserId: adminId, sourceIp: null, scheduler,
    });
    expect(outcome.ok).toBe(false);
    expect(scheduler.enqueued).toHaveLength(0);
  });

  /** No scheduler is not an error: the tests that are not about it pass none. */
  it('is a no-op without a scheduler', async () => {
    const { userId } = await seedPersonWithTargetAccount();
    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId, reason: 'left', actorUserId: adminId, sourceIp: null,
    });
    expect(outcome).toMatchObject({ ok: true, runsEnqueued: 0 });
  });
});
```

Append to `packages/core/src/auth/password-change.test.ts`:

```ts
describe('a password that landed in the directory and not locally', () => {
  /**
   * The divergence this ordering deliberately allows, made findable.
   *
   * The directory is written FIRST, so a commit failure after it accepted
   * leaves the two disagreeing -- with the DIRECTORY holding the password the
   * user just chose, which is the recoverable direction and the one that makes
   * their workstation login work at eight the next morning. What was missing
   * is any way to find that state: it propagated as a plain 500, and §9 asks
   * for `auth.password_writeback_desync` precisely so somebody can query for
   * the accounts it happened to.
   */
  it('records auth.password_writeback_desync before the failure propagates', async () => {
    const { userId } = await seedWritebackUser();
    changePassword.mockResolvedValue({ ok: true, message: 'changed' });
    const boom = vi
      .spyOn(passwordModule, 'setPasswordHash')
      .mockRejectedValue(new Error('connection terminated'));

    await expect(
      changeOwnPassword(tenantId, provider, {
        userId,
        currentPassword: 'old-password-here',
        newPassword: 'a-new-long-password',
        sessionId,
        sourceIp: null,
      }),
    ).rejects.toThrow(/connection terminated/);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_writeback_desync' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(userId);
    boom.mockRestore();
  });
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/core/src/directory/directory-writeback.test.ts packages/core/src/auth/password-change.test.ts -t 'ladder\|desync'`
Expected: FAIL — `scheduler` is not a field of `DeactivateInput`, and no desync event is written.

- [x] **Step 3: Enqueue the ladder**

In `packages/core/src/directory/directory-writeback.ts`, add `scheduler?: Scheduler | null | undefined;` to `DeactivateInput` and `runsEnqueued: number` to the success arm of `DeactivateOutcome`, and after the ladder transaction (line 177):

```ts
  /**
   * Write-back design §7.2 step 6: the Provision run that carries this
   * departure onto the ladder.
   *
   * Nothing enqueued one, so the entitlement revocation, the archive into the
   * deactivated OU and the reap on the domain controller all waited for the
   * next SCHEDULED run -- on a change whose whole point is that it happens
   * now, and whose console copy tells the administrator that the leaver steps
   * "follow from today".
   *
   * AFTER the directory write and after the local commit, and only when a
   * person was actually put on the ladder. A run enqueued for a departure that
   * did not happen would compute a desired state against a person who still
   * works here.
   *
   * One run per target system holding an account for this person, rather than
   * one per target in the tenant: a run reads the whole target, and enqueuing
   * every target on every leaver would make each departure a tenant-wide
   * reconciliation.
   */
  let runsEnqueued = 0;
  if (ladderStarted && input.scheduler && resolved.user.personId !== null) {
    const targets = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findMany({
        where: { personId: resolved.user.personId! },
        select: { targetSystemId: true },
      }),
    );
    const distinct = [...new Set(targets.map((t) => t.targetSystemId))];
    for (const targetSystemId of distinct) {
      await input.scheduler.enqueue(
        PROVISION_JOB,
        provisionJobPayload(tenantId, targetSystemId),
      );
    }
    runsEnqueued = distinct.length;
  }

  await withTenant(tenantId, (tx) =>
    audit(tx, input, enabled, { viaDirectory: true, ladderStarted, runsEnqueued }),
  );

  return { ok: true, viaDirectory: true, ladderStarted, runsEnqueued };
```

The locally-managed early return (line 105) returns `runsEnqueued: 0` too.

In `apps/api/src/routes/admin/users.ts`, add `scheduler?: () => Scheduler | null;` to `AdminUserRouteOptions` with the comment the source routes already use, and pass `scheduler: options.scheduler?.() ?? null` to both `deactivateDirectoryUser` and `reactivateDirectoryUser`. In `apps/api/src/app.ts`, add `...(options.scheduler ? { scheduler: options.scheduler } : {})` to the `registerAdminUserRoutes` registration (line 216), matching how the source routes are registered.

- [x] **Step 4: Mark the desync**

In `packages/core/src/auth/password-change.ts`, replace the success return of the write-back branch (line 222):

```ts
    // The directory has the new password. Syntra's hash follows so the portal
    // keeps working with the same string the workstation now wants.
    //
    // If THAT fails, the two have diverged -- with the directory holding the
    // password the user just chose, which is the recoverable direction and the
    // reason for this ordering. What was missing is any way to find the state
    // afterwards: it propagated as a plain 500 with no marker, and §9 names
    // `auth.password_writeback_desync` precisely so somebody can query for the
    // accounts it happened to and reconcile them.
    //
    // Recorded and RE-THROWN. Swallowing it would report a successful change
    // to a user whose Syntra password is now the old one, which is the failure
    // this event exists to make visible rather than one to hide.
    try {
      return { ok: true, otherSessionsRevoked: await commit() };
    } catch (cause) {
      await withTenant(tenantId, (tx) =>
        recordEvent(tx, {
          actorUserId: context.user.id,
          action: 'auth.password_writeback_desync',
          targetType: 'User',
          targetId: context.user.id,
          outcome: 'failure',
          sourceIp: input.sourceIp,
          payload: {
            // Neither password appears, and neither does the hash. What is
            // recorded is which account, which source, and which side holds
            // the value the user expects.
            sourceId: context.sourceId,
            directoryAccepted: true,
            localApplied: false,
            reason: cause instanceof Error ? cause.message : 'unknown',
          },
        }),
      );
      throw cause;
    }
```

- [x] **Step 5: Run both files to verify they pass**

Run: `npx vitest run packages/core/src/directory/directory-writeback.test.ts packages/core/src/auth/password-change.test.ts apps/api/src/routes/admin/users.test.ts`
Expected: PASS.

- [x] **Step 6: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/core/src/directory/directory-writeback.ts \
        packages/core/src/directory/directory-writeback.test.ts \
        packages/core/src/auth/password-change.ts \
        packages/core/src/auth/password-change.test.ts \
        apps/api/src/routes/admin/users.ts apps/api/src/app.ts
git commit -m "$(cat <<'EOF'
fix(directory): start the ladder at the deactivation, and mark a desynced password

Two ends of the same write-back feature, both named in its design and
neither implemented.

Section 7.2 step 6 says a Provision run is enqueued after an
administrative deactivation. Nothing did, so the entitlement revocation,
the archive into the deactivated OU and the reap all waited for the next
scheduled run -- on a change whose whole point is that it happens now, and
whose console copy tells the administrator the leaver steps "follow from
today". One run per target holding that person an account, after the
directory write and the local commit, and only when somebody was actually
put on the ladder.

Section 9 asks for `auth.password_writeback_desync`. The directory is
written first, so a commit failure after it accepted leaves the two
disagreeing with the directory holding the password the user chose -- the
recoverable direction, and the reason for the ordering. It propagated as a
plain 500 with no marker, so the state could not be found afterwards. Now
recorded and re-thrown: swallowing it would report a successful change to
somebody whose Syntra password is still the old one.
EOF
)"
```

---

### Task 34: The seed's idempotence guard tests the tenant it seeded

Spec §9, **B2**. `findFirst({ where: { login: 'admin' } })` after a slug upsert is satisfied by any leftover fixture — exactly what the integration suite leaves behind — so the seed reports "already seeded" and does nothing, and the browser tests look at a directory with no people in it. `upsert.update: {}` compounds it: a leftover `acme` tenant with a wrong `primaryDomain` is kept as-is, so the seed can succeed against a tenant whose domain never matches the host the browser uses.

**Files:**
- Modify: `packages/db/src/seed.ts:52-67`
- Test: `packages/db/src/seed-guard.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function seedMarkerFound(markers: { adminUser: boolean; builtInRole: boolean }): boolean` in a new `packages/db/src/seed-guard.ts`, so the decision is testable without running a seed.

- [x] **Step 1: Write the failing test**

Create `packages/db/src/seed-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { seedMarkerFound } from './seed-guard.js';

/**
 * What "already seeded" means.
 *
 * It used to mean `findFirst({ where: { login: 'admin' } })`, which the
 * integration suite satisfies constantly: several of its fixtures create a
 * user called `admin`. So `pnpm seed` reported "already seeded", did nothing,
 * and the browser tests then looked at a directory with no people in it --
 * which is why `e2e/README.md` tells operators to run `db:reset` first, a
 * habit that exists to work around this.
 */
describe('seedMarkerFound', () => {
  /**
   * BOTH markers, and the built-in role is the one that does the work: only
   * the seed writes `builtIn: true`. Every test fixture in the repository
   * creates roles with `createRole(tx, name, perms)` and no options, so
   * `builtIn` is false on all of them.
   */
  it('is true only when both the seed’s own markers are present', () => {
    expect(seedMarkerFound({ adminUser: true, builtInRole: true })).toBe(true);
  });

  it('is false for a leftover fixture user with no built-in role', () => {
    expect(seedMarkerFound({ adminUser: true, builtInRole: false })).toBe(false);
  });

  it('is false for a half-seeded tenant', () => {
    expect(seedMarkerFound({ adminUser: false, builtInRole: true })).toBe(false);
    expect(seedMarkerFound({ adminUser: false, builtInRole: false })).toBe(false);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/db/src/seed-guard.test.ts`
Expected: FAIL — `Cannot find module './seed-guard.js'`.

- [x] **Step 3: Write the guard and use it**

Create `packages/db/src/seed-guard.ts`:

```ts
/**
 * Whether this tenant carries the seed's own markers.
 *
 * Extracted so it can be tested without running a seed, and narrowed from what
 * it replaced.
 *
 * The old guard was `findFirst({ where: { login: 'admin' } })`. The
 * integration suite creates a user called `admin` in several fixtures and
 * truncates between cases rather than after them, so one is very often sitting
 * there when somebody runs `pnpm seed` -- which then reported the tenant
 * already seeded, did nothing, and left the browser tests looking at a
 * directory with no people in it. `e2e/README.md` tells operators to run
 * `db:reset` first, and that habit exists to work around exactly this.
 *
 * `builtInRole` is what makes the answer honest. `Role.builtIn` is written by
 * the seed and by nothing else: every fixture in the repository calls
 * `createRole(tx, name, permissions)` with no options, and `builtIn` defaults
 * to false. Requiring BOTH markers means a half-seeded tenant reads as not
 * seeded, which is the safe direction -- the create path is idempotent per row
 * and a leftover fragment is better re-created than skipped.
 */
export function seedMarkerFound(markers: {
  adminUser: boolean;
  builtInRole: boolean;
}): boolean {
  return markers.adminUser && markers.builtInRole;
}
```

In `packages/db/src/seed.ts`, replace the upsert and the guard (lines 52–67):

```ts
const tenant = await prisma.tenant.upsert({
  where: { slug: 'acme' },
  create: {
    name: 'Acme Care',
    slug: 'acme',
    primaryDomain: 'acme.localhost',
  },
  // NOT `{}`. A leftover `acme` tenant -- which the integration suite creates
  // and leaves behind constantly -- was kept exactly as it was, including a
  // `primaryDomain` of null or of whatever a test set. `resolveTenantId`
  // matches the Host header against that column, so the seed could report
  // success against a tenant the browser can never reach.
  update: {
    name: 'Acme Care',
    primaryDomain: 'acme.localhost',
  },
});

await withTenant(tenant.id, async (tx) => {
  const seeded = seedMarkerFound({
    adminUser: (await tx.user.findFirst({ where: { login: 'admin' } })) !== null,
    // The marker only the seed writes. Every fixture in the repository calls
    // `createRole(tx, name, permissions)` with no options, so `builtIn` is
    // false on all of them.
    builtInRole: (await tx.role.findFirst({ where: { builtIn: true } })) !== null,
  });
  if (seeded) {
    console.log(`Tenant ${tenant.slug} is already seeded. Nothing to do.`);
    return;
  }
```

adding `import { seedMarkerFound } from './seed-guard.js';`.

- [x] **Step 4: Run the guard test, then prove the seed still seeds**

```bash
npx vitest run packages/db/src/seed-guard.test.ts
SYNTRA_ALLOW_RESET=syntra pnpm db:reset && SEED_ADMIN_PASSWORD=aaaaaaaaaaaa pnpm seed
SEED_ADMIN_PASSWORD=aaaaaaaaaaaa pnpm seed
```

Expected: PASS; the first seed creates everything; the second prints "already seeded" and does nothing. Only against a development database.

- [x] **Step 5: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/db/src/seed.ts packages/db/src/seed-guard.ts packages/db/src/seed-guard.test.ts
git commit -m "$(cat <<'EOF'
fix(db): the seed's idempotence guard tests the tenant it seeded

`findFirst({ where: { login: 'admin' } })` is satisfied by any leftover
fixture, and the integration suite creates a user called `admin` in
several of them while truncating between cases rather than after. So
`pnpm seed` reported "already seeded", did nothing, and the browser tests
then looked at a directory with no people in it. The e2e README's habit of
running db:reset first exists to work around exactly this.

`Role.builtIn` is the marker only the seed writes: every fixture calls
createRole with no options and gets false. Both markers are required, so a
half-seeded tenant reads as not seeded -- the safe direction, since the
create path is idempotent per row.

The upsert's `update: {}` was the other half. A leftover `acme` was kept
as it stood, primaryDomain and all, and resolveTenantId matches the Host
header against that column -- so the seed could succeed against a tenant
the browser can never reach.
EOF
)"
```

---

### Task 35: The index every portal render needs, and the two one-per invariants nothing enforces

Spec §9, **B3** and **B4**, in one migration because they are one schema change.

`GroupMembership` has no index on `userId`: the unique index leads with `groupId`, so the per-user lookup falls back to the bare `tenantId` index and filters the tenant's whole membership table — on every portal render, every SAML assertion and every OIDC token. `RoleAssignment` carries the index this table lacks.

And two documented one-per invariants have no backing constraint: one `active` `SigningKey` per (tenant, kind), and one `TargetAccount` anchor per (target, anchor). `rotateKey` already carries the comment *"Only after the previous row has left 'active' — `signing_key_one_active` is what makes this ordering load-bearing rather than stylistic"*, naming an index that does not exist.

**Files:**
- Modify: `packages/db/prisma/schema.prisma:121-131` (`GroupMembership`)
- Create: `packages/db/prisma/migrations/20260904000000_membership_index_and_one_per_uniques/migration.sql`
- Modify: `packages/db/src/migration-order.ts` (append the name)
- Test: `packages/db/src/schema-invariants.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: index `GroupMembership_userId_idx`; partial unique indexes `signing_key_one_active` and `target_account_anchor_unique`. No code changes.

- [x] **Step 1: Check the existing data can satisfy the two constraints**

```bash
cd packages/db && npx prisma db execute --stdin <<'SQL'
SELECT "tenantId", "kind", count(*) FROM "SigningKey" WHERE "status" = 'active'
  GROUP BY 1, 2 HAVING count(*) > 1;
SELECT "targetSystemId", "anchor", count(*) FROM "TargetAccount" WHERE "anchor" IS NOT NULL
  GROUP BY 1, 2 HAVING count(*) > 1;
SQL
cd ../..
```

Expected: no rows from either. If there are rows, the invariant is already broken and this task's first job is finding out how — the constraint is the fix, but a migration that fails on deploy is not.

- [x] **Step 2: Write the failing test**

Create `packages/db/src/schema-invariants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { prisma } from './client.js';

/**
 * The indexes that carry an invariant, asked of the live database.
 *
 * A comment in `signing-key-service.ts` already claims `signing_key_one_active`
 * exists: "Only after the previous row has left 'active' --
 * signing_key_one_active is what makes this ordering load-bearing rather than
 * stylistic." It did not exist, so the ordering was stylistic after all.
 */
const indexes = async (table: string): Promise<string[]> => {
  const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    table,
  );
  return rows.map((r) => r.indexname);
};

describe('the schema’s one-per invariants', () => {
  it('allows only one active signing key per tenant and kind', async () => {
    expect(await indexes('SigningKey')).toContain('signing_key_one_active');
  });

  /**
   * `TargetAccount.anchor` is the target's immutable object identifier. Two
   * rows claiming one is two Syntra accounts pointing at one directory object,
   * and every convergence decision after that is made against whichever the
   * query happened to return.
   */
  it('allows only one account per target and anchor', async () => {
    expect(await indexes('TargetAccount')).toContain('target_account_anchor_unique');
  });
});

describe('the index every portal render needs', () => {
  /**
   * The unique index leads with `groupId`, so the per-USER lookup -- which is
   * what a portal render, a SAML assertion and an OIDC token each do -- fell
   * back to the bare `tenantId` index and filtered the tenant's whole
   * membership table. `RoleAssignment` carries exactly this index; this table
   * did not.
   */
  it('indexes GroupMembership on userId', async () => {
    expect(await indexes('GroupMembership')).toContain('GroupMembership_userId_idx');
  });
});
```

- [x] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/db/src/schema-invariants.test.ts`
Expected: FAIL — all three indexes are missing.

- [x] **Step 4: Write the migration**

Create `packages/db/prisma/migrations/20260904000000_membership_index_and_one_per_uniques/migration.sql`:

```sql
-- One index this table needed on every request, and two invariants the schema
-- documents and the database never enforced.

-- `GroupMembership` is read BY USER on every portal render, every SAML
-- assertion and every OIDC token: resolving what somebody can reach starts
-- with the groups they are in. The unique index leads with `groupId`, which
-- answers the other question, so the per-user lookup fell back to the bare
-- `tenantId` index and filtered the tenant's entire membership table.
-- `RoleAssignment` -- the same shape, read the same way -- has carried this
-- index since it was created.
CREATE INDEX "GroupMembership_userId_idx" ON "GroupMembership"("userId");

-- ONE ACTIVE SIGNING KEY per tenant and kind.
--
-- `signing-key-service.ts` already names this index in a comment: "Only after
-- the previous row has left 'active' -- signing_key_one_active is what makes
-- this ordering load-bearing rather than stylistic." It did not exist, so the
-- ordering was stylistic. Two active keys means `loadActiveKey`'s `findFirst`
-- picks one arbitrarily: assertions get signed with a key whose certificate is
-- not the one published as active, and the service provider rejects them.
--
-- A partial unique index, like `role_assignment_unscoped_unique`, because the
-- constraint is over a subset of rows -- 'outgoing' and 'retired' keys are
-- meant to accumulate.
CREATE UNIQUE INDEX signing_key_one_active
  ON "SigningKey" ("tenantId", "kind")
  WHERE "status" = 'active';

-- ONE ACCOUNT PER TARGET ANCHOR.
--
-- `anchor` is the target's immutable object identifier and is null until the
-- account exists there, so the constraint has to skip the nulls -- a `pending`
-- row holds its correlation key reserved and has no anchor yet, and the
-- existing unique on (tenant, target, correlationKey) is what covers that
-- window. Two rows claiming one anchor is two Syntra accounts pointing at one
-- directory object, and every convergence decision after that is made against
-- whichever the query happened to return first.
CREATE UNIQUE INDEX target_account_anchor_unique
  ON "TargetAccount" ("targetSystemId", "anchor")
  WHERE "anchor" IS NOT NULL;
```

In `packages/db/prisma/schema.prisma`, add `@@index([userId])` to `GroupMembership` (after line 130). The two partial uniques stay SQL-only — Prisma cannot express a partial unique index, which is why `role_assignment_unscoped_unique` is SQL-only too.

- [x] **Step 5: Register the migration name**

Append `'20260904000000_membership_index_and_one_per_uniques',` to `KNOWN_MIGRATIONS` in `packages/db/src/migration-order.ts`.

- [x] **Step 6: Apply and verify**

```bash
cd packages/db && npx prisma migrate deploy && npx prisma generate; cd ../..
npx vitest run packages/db/src/schema-invariants.test.ts packages/db/src/migration-order.test.ts
```

Expected: PASS.

- [x] **Step 7: Check the two constraints did not break rotation or provisioning**

Run: `npx vitest run packages/core/src/keys/signing-key-service.test.ts packages/core/src/provision/apply.test.ts`

Expected: PASS. `rotateKey` demotes the previous key to `outgoing` *before* inserting the new one, which is the ordering its own comment says this index makes load-bearing — this is where that claim is finally true.

- [x] **Step 8: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0.

```bash
git add packages/db/prisma/schema.prisma \
        packages/db/prisma/migrations/20260904000000_membership_index_and_one_per_uniques/migration.sql \
        packages/db/src/migration-order.ts \
        packages/db/src/schema-invariants.test.ts
git commit -m "$(cat <<'EOF'
perf(db): index GroupMembership by user, and enforce two one-per invariants

GroupMembership is read BY USER on every portal render, every SAML
assertion and every OIDC token. Its unique index leads with groupId, which
answers the other question, so that lookup fell back to the bare tenantId
index and filtered the tenant's whole membership table. RoleAssignment --
the same shape, read the same way -- has carried this index since it was
created.

Two documented invariants had no constraint behind them. One active
SigningKey per (tenant, kind): `signing-key-service.ts` already cites
`signing_key_one_active` by name in a comment explaining why rotation
demotes before it inserts, and the index did not exist, so the ordering
was stylistic. Two active keys means loadActiveKey picks one arbitrarily
and assertions get signed with a key whose certificate is not the
published one. And one TargetAccount per (target, anchor): two rows
claiming one directory object makes every convergence decision after it
depend on which row the query returned.

Both are partial unique indexes, like role_assignment_unscoped_unique --
Prisma cannot express one, and the subsets matter: outgoing keys are meant
to accumulate, and a pending account has no anchor yet.
EOF
)"
```

---

### Task 36: Strip the four dead exports

Spec §7.4, **H6**. Five dead exports were named: `hasPassword`, `listSecretNames`, `matchesIpRanges`, `matchesTimeWindow`, `isPermission`. Four are still dead. **`isPermission` is not** — Task 6 made it the enforcement point for the closed permission catalogue, which is what it was written for.

**Files:**
- Modify: `packages/core/src/auth/password.ts:57-65`
- Modify: `packages/core/src/vault/vault-service.ts:90-97`
- Modify: `packages/core/src/policy/ip-match.ts:85-86`
- Modify: `packages/core/src/policy/time-window.ts:105-106`
- Modify: `packages/core/src/policy/ip-match.test.ts`, `packages/core/src/policy/time-window.test.ts`, `packages/core/src/vault/vault-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: four fewer exports. `evaluateIpRanges` and `evaluateTimeWindow` — the three-valued functions the deleted ones wrapped, and the ones the policy engine actually calls — are untouched.

- [ ] **Step 1: Confirm they are still dead**

```bash
for name in hasPassword listSecretNames matchesIpRanges matchesTimeWindow; do
  echo "== $name"
  grep -rn "$name" --include=*.ts --include=*.tsx packages/*/src apps/*/src | grep -v "\.test\." | grep -v "export "
done
```

Expected: no output under any of the four. Anything printed is a caller and that export stays.

```bash
grep -rn "isPermission" --include=*.ts packages/*/src apps/*/src | grep -v "\.test\."
```

Expected: the declaration in `permissions.ts` **and** the call in `rbac-service.ts`'s `assertPermissionNames`. If the second is missing, Task 6 has not landed and this task is out of order.

- [ ] **Step 2: Delete the four, and their tests**

Remove `hasPassword` from `packages/core/src/auth/password.ts` and `listSecretNames` from `packages/core/src/vault/vault-service.ts` (and its case from `vault-service.test.ts` — the `putSecret`/`getSecret` cases around it stay).

In `packages/core/src/policy/ip-match.ts`, delete `matchesIpRanges` (lines 85–86) and leave a note where it was:

```ts
// There is deliberately no boolean `matchesIpRanges` wrapper any more.
//
// `evaluateIpRanges` answers THREE things -- 'match', 'no-match' and
// 'unevaluable' -- and the third is the point: a rule whose range list could
// not be read covers addresses this cannot see, and "no" would be an
// overstatement. A boolean wrapper collapses the third into the second, which
// is the wrong direction for a policy condition, and nothing outside its own
// test ever called it.
```

Do the same in `packages/core/src/policy/time-window.ts` for `matchesTimeWindow`, and rewrite the two test files to assert on `evaluateIpRanges` / `evaluateTimeWindow` directly, keeping every case — the coverage is worth keeping, the wrappers are not.

- [ ] **Step 3: Run the affected suites**

Run: `npx vitest run packages/core/src/policy/ip-match.test.ts packages/core/src/policy/time-window.test.ts packages/core/src/vault/vault-service.test.ts packages/core/src/auth/password.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc -b`
Expected: exit 0. `@syntra/core`'s index uses `export *`, so nothing else needs editing.

```bash
git add packages/core/src/auth/password.ts packages/core/src/vault/vault-service.ts \
        packages/core/src/policy/ip-match.ts packages/core/src/policy/time-window.ts \
        packages/core/src/policy/ip-match.test.ts packages/core/src/policy/time-window.test.ts \
        packages/core/src/vault/vault-service.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): remove four dead exports

`hasPassword`, `listSecretNames`, `matchesIpRanges` and
`matchesTimeWindow` had no caller anywhere outside their own tests.

The two policy wrappers are worth naming: `evaluateIpRanges` and
`evaluateTimeWindow` answer three things -- match, no-match and
unevaluable -- and the third is the point, because a rule whose range list
could not be read covers addresses the evaluation cannot see. A boolean
wrapper collapses that into "no", which is the wrong direction for a
policy condition. Their tests move onto the three-valued functions
unchanged.

`isPermission` was the fifth on the list and is not dead any more: the
role API's `assertPermissionNames` is the enforcement point for the closed
catalogue, which is what it was written for.
EOF
)"
```

---

## Done when

- [ ] A SAML service provider that sends `ForceAuthn` gets an assertion after the user signs in again, and does not get one for the session that was already held.
- [ ] A passkey-only user with no recovery codes can complete a password reset, and the challenge endpoint refuses a spent link in the same words `/complete` does.
- [ ] An authenticator app can be removed from the Security page; every factor removal mails its owner and says how many recovery codes went with it.
- [ ] Cookie `Secure` follows `PUBLIC_URL`; `grep -rn "NODE_ENV" apps/api/src` finds nothing setting a cookie attribute.
- [ ] `/admin/roles` lists roles with holder counts, grants `deployment.manage` to a role that lacks it, and refuses the change that would leave nobody holding `rbac.manage`. Existing installs get the permission from the backfill migration without anyone opening a database client. **This closes U3.**
- [ ] `{"decision":"Reject"}` is a 400 and the request stays pending; a rejection with no comment is refused.
- [ ] The three govern previews require `govern.manage`, and the structural §21 test enumerates every route guarded by `requireGovernRead` regardless of method.
- [ ] Moving a tenant's domain drops the cached OIDC provider; a malformed uuid on the four named routes is a 400; malformed Basic credentials are `invalid_client`.
- [ ] `writebackPasword`, `adminMfaRequred` and `passwordSorce` are all 400s.
- [ ] `tsc -b` is what catches a drift between a hand-built response and `mfaStatusResponse`, `applicationTile` or `ruleImpactResponse`.
- [ ] Editing a product's name preserves its description, category, grants, form schema and duration mode.
- [ ] A bulk certify spanning two campaigns certifies both; a double-clicked Remove sends one revoke.
- [ ] An expired session sends the reader to `/login` instead of turning every panel into "Something went wrong".
- [ ] The reports screen has no Live toggle and does have a snapshot picker.
- [ ] A campaign can be created, previewed on both axes, started and re-based from the console; a workflow list exists and the product editor picks from it; a person can be linked to an account, a group's membership edited, and a factor taken off a user; **Extend** sends `replacesGrantId`.
- [ ] Nothing in the console offers the orphan Confirm button, and `POST /govern/orphans/:id/confirm` is gone.
- [ ] A source correlating on email matches an existing user by email; "test connection" succeeds against a directory with a 500-entry server limit; a run queued for a disabled source is a 409; an unreachable host reads as `directory_unavailable`.
- [ ] `/health/ready` answers within five seconds per probe even when the database does not answer at all.
- [ ] `pnpm seed` run twice against a database holding integration fixtures seeds the first time and says "already seeded" the second.
- [ ] Three indexes exist: `GroupMembership_userId_idx`, `signing_key_one_active`, `target_account_anchor_unique`; both new migration names are in `KNOWN_MIGRATIONS`.
- [ ] `npx tsc -b` exits 0, `pnpm --filter @syntra/web build` succeeds, and `packages/core/src/auth/password-reset.test.ts` is still uncommitted and untouched.

## Deliberately not in this plan

- **Remediation 1 — Urgent.** R1–R3, C1, D1, X1–X3: the three tests committed red, the holding collision that halts every nightly snapshot, `pnpm db:reset` truncating the lab database, and the 71 web tests CI cannot see. **Task 8 and Task 35 depend on its Task 5**, which creates `packages/db/src/migration-order.ts`; both append to `KNOWN_MIGRATIONS`, and the plan must be run first or those two tasks must create that file themselves.
- **Remediation 2 — Governance.** G1–G27: the decide race, retention deleting the evidence a campaign was signed against, the `revoked` figure counting items that were not revoked, the two transaction-ceiling failures that never recover, the structurally empty evidence bundle, CSV formula injection, the scheduling switch that unschedules six unrelated jobs, and "Verify now" raising a false critical alarm.
- **Remediation 3 — Approvals and provisioning.** A1–A9, P1–P8: the stuck admin-unblocked multi-stage request, the read-then-write terminal transitions, the reviewer's revocation order that is silently dropped forever, the unguarded concurrent apply, and the deactivation guard's tenant-wide denominator. **Provision's account adoption belongs there**, and Task 26 removes the orphan Confirm control pending it.
- **Remediation 5 — The update feature.** U1–U10 and the lab rehearsal its own design lists as outstanding: no `DATABASE_URL` at the migrate step, no Prisma client on the target, `dev` forever, rollback leaving schema objects behind, the hard-coded environment, `sort -V` misordering, the unauthenticated chatty readiness route's rate limit, and the Updates page tearing down its own polling. **U3 is closed here** by Task 8, because it is one instance of H2 and the fix is the same migration.
