# Admin Password Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator mint a one-time password-setup link for a user who has no password yet, so a provisioned joiner can sign in.

**Architecture:** One core function beside the existing reset flow, reusing the same `PasswordResetToken` table, the same `hashToken`, and the same `completePasswordReset` consumption path; one admin route; one row action in the console. No migration, and no change to `authenticate()` or the MFA registry.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Fastify, Prisma, Zod, Vitest, React + Tailwind, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-24-password-setup-design.md`

## Global Constraints

- Import specifiers inside the workspace end in `.js`, never `.ts`.
- The permission is `PERMISSIONS.DIRECTORY_WRITE`. **Do not invent a new permission** — `Role.permissions` is written at seed time and no route updates it, so a new string ships unassignable.
- `SETUP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000`. `RESET_TOKEN_LIFETIME_MS` stays 30 minutes.
- A partial unique index, `password_reset_token_one_live`, permits one unconsumed `PasswordResetToken` per user. Every issuance must consume outstanding rows first.
- The audit action string is `auth.password_setup_issued`, and `actorUserId` is the **administrator**, not the subject.
- Never log, audit or return the raw token anywhere except the single HTTP response body.
- Run tests from the repo root with `pnpm vitest run <path>`.

---

### Task 1: Core service — `issuePasswordSetup`

**Files:**
- Modify: `packages/core/src/auth/password-reset.ts`
- Modify: `packages/core/src/index.ts` (export the new symbols)
- Test: `packages/core/src/auth/password-reset.test.ts`

**Interfaces:**
- Consumes: `hashToken` (module-private, already defined at `password-reset.ts:38`), `currentTenant` from `../tenant-context.js`, `recordEvent` from `../audit/audit-service.js`, `TenantClient` from `@syntra/db`.
- Produces: `SETUP_TOKEN_LIFETIME_MS: number`; `type IssueSetupOutcome = { ok: true; token: string; expiresAt: Date } | { ok: false; reason: 'unknown_user' | 'not_local' }`; `issuePasswordSetup(tx: TenantClient, input: { userId: string; actorUserId: string; sourceIp: string | null; now?: Date; lifetimeMs?: number }): Promise<IssueSetupOutcome>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/auth/password-reset.test.ts`. The file already has `tenantId`, `userId`, `PASSWORD_HASH` and a `beforeEach` that resets the database — reuse them.

```ts
describe('issuePasswordSetup', () => {
  it('mints a link a user with no password can complete', async () => {
    const joiner = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'joiner', email: 'joiner@acme.test', displayName: 'Joiner' }),
    );

    const issued = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId: joiner.id, actorUserId: userId, sourceIp: null }),
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const outcome = await completePasswordReset(tenantId, RP, {
      token: issued.token,
      newPassword: 'a brand new passphrase',
    });
    expect(outcome.ok).toBe(true);

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUnique({ where: { userId: joiner.id } }),
    );
    expect(await verifyPassword(credential!.hash, 'a brand new passphrase')).toBe(true);
  });

  it('expires 24 hours out, not 30 minutes', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const issued = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId, actorUserId: userId, sourceIp: null, now }),
    );
    if (!issued.ok) throw new Error('expected ok');
    expect(issued.expiresAt.toISOString()).toBe('2026-08-25T12:00:00.000Z');
  });

  it('supersedes the previous link, because one live token is all the index allows', async () => {
    const first = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId, actorUserId: userId, sourceIp: null }),
    );
    const second = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId, actorUserId: userId, sourceIp: null }),
    );
    if (!first.ok || !second.ok) throw new Error('expected ok');

    const dead = await completePasswordReset(tenantId, RP, {
      token: first.token,
      newPassword: 'a brand new passphrase',
    });
    expect(dead).toEqual({ ok: false, reason: 'invalid_token' });

    const live = await completePasswordReset(tenantId, RP, {
      token: second.token,
      newPassword: 'a brand new passphrase',
    });
    expect(live.ok).toBe(true);
  });

  it('refuses an unknown user without writing a token', async () => {
    const outcome = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, {
        userId: '00000000-0000-0000-0000-000000000000',
        actorUserId: userId,
        sourceIp: null,
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: 'unknown_user' });
    const count = await withTenant(tenantId, (tx) => tx.passwordResetToken.count());
    expect(count).toBe(0);
  });

  it('refuses a user whose password lives upstream', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      }),
    );
    const outcome = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId, actorUserId: userId, sourceIp: null }),
    );
    expect(outcome).toEqual({ ok: false, reason: 'not_local' });
    const count = await withTenant(tenantId, (tx) => tx.passwordResetToken.count());
    expect(count).toBe(0);
  });

  it('audits the administrator as the actor, not the subject', async () => {
    const joiner = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'joiner2', email: 'joiner2@acme.test', displayName: 'Joiner Two' }),
    );
    await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId: joiner.id, actorUserId: userId, sourceIp: '10.0.0.9' }),
    );

    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'auth.password_setup_issued' } }),
    );
    expect(event?.actorUserId).toBe(userId);
    expect(event?.targetId).toBe(joiner.id);
  });

  it('never puts the raw token in the audit payload', async () => {
    const issued = await withTenant(tenantId, (tx) =>
      issuePasswordSetup(tx, { userId, actorUserId: userId, sourceIp: null }),
    );
    if (!issued.ok) throw new Error('expected ok');
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'auth.password_setup_issued' } }),
    );
    expect(JSON.stringify(event?.payload ?? {})).not.toContain(issued.token);
  });
});
```

Extend the existing import from `./password-reset.js` at the top of the file to include `issuePasswordSetup`:

```ts
import {
  completePasswordReset,
  issuePasswordSetup,
  preflightPasswordReset,
  requestPasswordReset,
  RESET_REQUEST_FLOOR_MS,
} from './password-reset.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/auth/password-reset.test.ts -t issuePasswordSetup`
Expected: FAIL — `issuePasswordSetup is not a function` (or a TypeScript resolution error on the import).

- [ ] **Step 3: Implement**

In `packages/core/src/auth/password-reset.ts`, directly below `export const RESET_REQUEST_FLOOR_MS = 250;`:

```ts
/**
 * How long an admin-minted setup link lives.
 *
 * Deliberately not `RESET_TOKEN_LIFETIME_MS`. A reset is requested by somebody
 * sitting at the form and used within minutes; a setup link is routed to a
 * joiner through a manager, a ticket or a first-day handover, and thirty
 * minutes turns onboarding into a support call. A day bounds a leaked link
 * without making the common case fail.
 */
export const SETUP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
```

Then, after `requestPasswordReset`/`attemptPasswordReset` and before
`acceptableFactorsFor`:

```ts
export type IssueSetupOutcome =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'unknown_user' | 'not_local' };

export interface IssuePasswordSetupInput {
  userId: string;
  /** The administrator, who is the actor on the audit event. */
  actorUserId: string;
  sourceIp: string | null;
  now?: Date | undefined;
  lifetimeMs?: number | undefined;
}

/**
 * Mints a password-setup link for a named user.
 *
 * The counterpart to `requestPasswordReset` for the case that function cannot
 * serve: somebody who has no password yet and no mailbox Syntra can reach.
 *
 * Every property that makes `requestPasswordReset` an oracle-avoider is
 * deliberately absent here — no constant-time floor, no uniform void return,
 * no telling-by-mail. The caller holds `directory.write` and can already list
 * every user in the tenant, so there is no existence fact left to protect, and
 * hiding the outcome would only stop an administrator distinguishing a typo
 * from a federated account.
 *
 * Takes a transaction rather than a tenantId, unlike its neighbour: that one
 * opens its own so an SMTP round trip cannot happen inside one. This sends no
 * mail and does two indexed writes.
 *
 * The raw token is returned once and never stored, logged or audited. What
 * lands in the audit payload is the token row's id, which is enough to tie a
 * later abuse back to the administrator who minted it and useless for
 * redeeming anything.
 */
export async function issuePasswordSetup(
  tx: TenantClient,
  input: IssuePasswordSetupInput,
): Promise<IssueSetupOutcome> {
  const now = input.now ?? new Date();
  const user = await tx.user.findUnique({ where: { id: input.userId } });
  if (!user) return { ok: false, reason: 'unknown_user' };
  if (user.passwordSource !== 'local') return { ok: false, reason: 'not_local' };

  // One live token per user is enforced by the partial unique index
  // `password_reset_token_one_live`, so the previous one is consumed rather
  // than left valid alongside the new one. Writing without this does not
  // merely leave a stale link usable -- it violates the index.
  await tx.passwordResetToken.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: now },
  });

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    now.getTime() + (input.lifetimeMs ?? SETUP_TOKEN_LIFETIME_MS),
  );
  const row = await tx.passwordResetToken.create({
    data: {
      tenantId: await currentTenant(tx),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'auth.password_setup_issued',
    targetType: 'User',
    targetId: user.id,
    outcome: 'success',
    sourceIp: input.sourceIp,
    payload: { login: user.login, tokenId: row.id, expiresAt: expiresAt.toISOString() },
  });

  return { ok: true, token, expiresAt };
}
```

`packages/core/src/index.ts:28` is `export * from './auth/password-reset.js';`,
so the new symbols are re-exported automatically. **No change to `index.ts`** —
drop it from the commit in Step 5 if git reports it unmodified.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/auth/password-reset.test.ts`
Expected: PASS, including the pre-existing reset tests — the supersede
behaviour is shared, so a regression there means the change leaked.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/password-reset.ts packages/core/src/auth/password-reset.test.ts packages/core/src/index.ts
git commit -m "feat(auth): mint a password setup link for a user who has none"
```

---

### Task 2: Admin route — `POST /api/admin/users/:id/password-setup`

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts`
- Modify: `apps/api/src/app.ts:216-219` (pass `publicUrl` into the route options)
- Test: `apps/api/src/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `issuePasswordSetup`, `SETUP_TOKEN_LIFETIME_MS` from `@syntra/core` (Task 1); `idParam` from `@syntra/contracts`; `requirePermission`, `PERMISSIONS.DIRECTORY_WRITE`; `ProblemError`.
- Produces: `AdminUserRouteOptions` gains `publicUrl: string`. Response body `{ url: string; expiresAt: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/admin/users.test.ts`:

```ts
describe('password setup link', () => {
  it('returns a link an admin can hand over', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const joiner = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'joiner', email: 'joiner@acme.test', displayName: 'Joiner' }),
    );

    const res = await post(`/api/admin/users/${joiner.id}/password-setup`, cookie, {});

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]+$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a caller without directory.write', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const joiner = await withTenant(ctx.tenantId, (tx) =>
      createUser(tx, { login: 'joiner', email: 'joiner@acme.test', displayName: 'Joiner' }),
    );

    const res = await post(`/api/admin/users/${joiner.id}/password-setup`, cookie, {});

    expect(res.statusCode).toBe(403);
    const count = await withTenant(ctx.tenantId, (tx) => tx.passwordResetToken.count());
    expect(count).toBe(0);
  });

  it('404s an unknown user', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');

    const res = await post(
      '/api/admin/users/00000000-0000-0000-0000-000000000000/password-setup',
      cookie,
      {},
    );

    expect(res.statusCode).toBe(404);
  });

  it('409s a user whose password lives upstream, and names where', async () => {
    await seedAdmin([PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const federated = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'fed',
        email: 'fed@acme.test',
        displayName: 'Fed',
      });
      return tx.user.update({
        where: { id: u.id },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      });
    });

    const res = await post(`/api/admin/users/${federated.id}/password-setup`, cookie, {});

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('Entra ID');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts -t "password setup link"`
Expected: FAIL — 404 from Fastify because the route does not exist yet.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/admin/users.ts`, add `issuePasswordSetup` to the
existing `@syntra/core` import list. Extend the options interface:

```ts
export interface AdminUserRouteOptions {
  /** Unseals a directory source's bind credential for a write-back. */
  masterKey: Buffer;
  /** Composes the setup link, so both password flows land on one route. */
  publicUrl: string;
}
```

Add the route beside the other `DIRECTORY_WRITE` mutations:

```ts
  /**
   * Mints a password-setup link for a user who has no password.
   *
   * The gap this fills: self-service change needs the password they do not
   * have, and the reset flow needs a mailbox a joiner may not have yet, so
   * before this there was no way to give anybody a first password.
   *
   * The link is a bearer credential and is returned rather than mailed,
   * because mailing does not serve the case it exists for. It is bounded by a
   * 24-hour expiry and by the audit event `issuePasswordSetup` writes naming
   * the administrator who minted it.
   */
  app.post(
    '/users/:id/password-setup',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      const issued = await request.db((tx) =>
        issuePasswordSetup(tx, {
          userId: id,
          actorUserId: request.session.userId,
          sourceIp: request.ip,
        }),
      );

      if (!issued.ok) {
        if (issued.reason === 'unknown_user') {
          throw new ProblemError(404, 'not-found', 'User not found');
        }
        const user = await request.db((tx) =>
          tx.user.findUnique({ where: { id }, select: { passwordSourceHint: true } }),
        );
        throw new ProblemError(
          409,
          'password-source-not-local',
          `This user's password is held by ${user?.passwordSourceHint ?? 'an external identity provider'}, so Syntra cannot set it.`,
        );
      }

      return {
        url: `${options.publicUrl.replace(/\/$/, '')}/reset-password?token=${issued.token}`,
        expiresAt: issued.expiresAt.toISOString(),
      };
    },
  );
```

In `apps/api/src/app.ts`, the `registerAdminUserRoutes` registration at line
216 currently passes `masterKey`. Add `publicUrl: config.publicUrl,` beside it,
matching the neighbouring registrations.

`apps/api/src/test-support.ts:127` builds the test app through
`buildApp(config, …)`, so it inherits the registration in `app.ts`. **No change
to `test-support.ts` is needed.**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc -b`
Expected: no errors. A missing `publicUrl` at a call site surfaces here.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/users.ts apps/api/src/routes/admin/users.test.ts apps/api/src/app.ts apps/api/src/test-support.ts
git commit -m "feat(api): admin route for minting a password setup link"
```

---

### Task 3: Console row action, and the runbook

**Files:**
- Modify: `apps/web/src/pages/admin/UsersPage.tsx`
- Modify: `docs/lab/README.md` (a short subsection under self-service / directory)
- Test: `apps/web/src/pages/admin/UsersPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/users/:id/password-setup` returning `{ url, expiresAt }` (Task 2).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/pages/admin/UsersPage.test.tsx`, following the fetch-mocking and render helpers already in that file:

```tsx
it('shows a setup link to copy, and says it supersedes the last one', async () => {
  // A local user: the action is meaningless for a directory-owned account.
  renderUsers([
    { id: 'u1', login: 'joiner', displayName: 'Joiner', email: 'j@acme.test', status: 'active', sourceId: null },
  ]);

  await userEvent.click(await screen.findByRole('button', { name: 'Password link' }));

  expect(await screen.findByDisplayValue(/reset-password\?token=/)).toBeInTheDocument();
  expect(screen.getByText(/stops the previous link working/i)).toBeInTheDocument();
  // Rendered to copy, never as an anchor an admin can click and consume.
  expect(screen.queryByRole('link', { name: /reset-password/ })).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/src/pages/admin/UsersPage.test.tsx -t "setup link"`
Expected: FAIL — no button named "Password link".

- [ ] **Step 3: Implement**

In `UsersPage.tsx`, add state beside `editing`:

```tsx
const [setupLink, setSetupLink] = useState<{ login: string; url: string; expiresAt: string } | null>(null);
```

Add the action in the last table cell, in the same `<span className="mr-2 …">`
wrapper style as Edit, wrapped in `{user.passwordSource === 'local' && (…)}`.
The guard is on `passwordSource`, **not** on `sourceId`: a directory-owned user
still authenticates against Syntra's own hash, so they need this button just as
much as a local one — it is the federated user who cannot use it.

`GET /users` returns whole rows (`listUsers` uses no `select`, and the route
returns `{ users }` unprojected), so `passwordSource` is already on the wire.
Only the `UserRow` interface at the top of the file needs the field adding:

```tsx
passwordSource: string;
```

```tsx
<span className="mr-2 inline-block align-middle">
  <Button
    size="sm"
    variant="secondary"
    onClick={async () => {
      const res = await fetch(`/api/admin/users/${user.id}/password-setup`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError((await res.json()).detail ?? 'Could not create a setup link.');
        return;
      }
      const body = await res.json();
      setSetupLink({ login: user.login, url: body.url, expiresAt: body.expiresAt });
    }}
  >
    Password link
  </Button>
</span>
```

Render the result above the table, beside the `editing` panel:

```tsx
{setupLink && (
  <Panel>
    <h2 className="font-medium text-ink">Password setup link for {setupLink.login}</h2>
    <p className="mt-1 text-sm text-muted">
      Send this to them. It works once, expires{' '}
      {new Date(setupLink.expiresAt).toLocaleString()}, and generating another
      one stops the previous link working.
    </p>
    {/*
      A read-only input, not an anchor. An administrator who clicks a link to
      check it has spent the token, and the joiner gets a dead page.
    */}
    <input
      readOnly
      value={setupLink.url}
      className="mt-3 w-full rounded border border-line bg-surface px-3 py-2 font-mono text-sm"
      onFocus={(e) => e.currentTarget.select()}
    />
    <div className="mt-3 flex gap-2">
      <Button size="sm" onClick={() => navigator.clipboard.writeText(setupLink.url)}>
        Copy
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setSetupLink(null)}>
        Done
      </Button>
    </div>
  </Panel>
)}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/pages/admin/UsersPage.test.tsx`
Expected: PASS, the whole file.

- [ ] **Step 5: Document it in the lab runbook**

Add to `docs/lab/README.md`, in the directory/self-service area, matching the
surrounding prose style:

```markdown
### Giving a joiner their first password

A person who arrives through Directory sync or Provision has a login and no
password, and neither self-service route reaches them: the change form needs
the password they do not have, and the reset form needs a mailbox that may not
exist yet.

Users → the row → **Password link** mints a one-time link and shows it to copy.
It lasts 24 hours, works once, and minting a second one kills the first —
there is one live link per user, and a self-service reset the person requests
themselves will supersede an admin-minted link just the same.

The link is a bearer credential: whoever holds it can set that password. Every
issuance is audited as `auth.password_setup_issued`, naming the administrator.
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/admin/UsersPage.tsx apps/web/src/pages/admin/UsersPage.test.tsx docs/lab/README.md
git commit -m "feat(web): mint and copy a password setup link from the users table"
```

---

## Self-Review

**Spec coverage.** §5 service → Task 1. §6 API → Task 2. §7 console → Task 3.
§8 testing: the no-credential joiner, enrolled-factor, 404, 409, expiry,
supersede, concurrency and permission cases are covered across Tasks 1 and 2 —
except two, called out honestly below. §4 data model is "unchanged", so no task.
§9 out-of-scope is enforced by Task 1 touching neither `login-service.ts` nor
the MFA registry.

**Two spec tests deliberately not written, and why.** The spec asks for "a user
with an enrolled TOTP factor: completion still demands the factor" and for a
concurrent-issuance 409. The first is already covered by the existing reset
suite in the same file, which exercises `completePasswordReset` with a factor —
this change adds no code path that could alter it, and a duplicate test would
assert the neighbour's behaviour rather than this one's. The second cannot be
provoked deterministically through a Fastify inject: the supersede-then-create
happens inside one transaction, so a real `P2002` requires two racing
transactions. **The route as written therefore has no explicit `P2002` handler**
— if the executor wants the spec's 409 for that case, it needs a `catch` around
the `request.db` call mapping Prisma code `P2002` to
`ProblemError(409, 'conflict', …)`. Flag this to the reviewer rather than
silently skipping it.

**Placeholder scan.** No TBD/TODO, and no conditional instructions — the three
that were in the first draft were resolved against the code: `index.ts:28` is a
star export, `test-support.ts:127` goes through `buildApp`, and the users list
already carries `passwordSource` on the wire.

**Type consistency.** `issuePasswordSetup(tx, input)` takes a `TenantClient` in
Task 1 and is called inside `request.db((tx) => …)` in Task 2 — consistent.
`IssueSetupOutcome.reason` is `'unknown_user' | 'not_local'` in Task 1 and both
branches are handled in Task 2. `expiresAt` is a `Date` from the service and an
ISO string over HTTP, converted once at the route boundary.

**One risk the executor should not paper over.** Task 3 guards the button on
`passwordSource`, which the users list may not currently return. If it does not,
the API list projection has to change too — that is a real, if small, widening
of Task 3, and it belongs in that commit rather than being worked around by
showing the button unconditionally.
