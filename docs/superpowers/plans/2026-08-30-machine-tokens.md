# Machine Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bearer credential a program can hold — issued against a service account, bounded by the intersection of that account's roles and the token's scopes, and refused by the same `authorize()` that refuses everybody else.

**Architecture:** An `ApiToken` row keyed by a SHA-256 of a prefixed random secret. Presentation goes through `authorize()` under a new `kind: 'token'`, so account status, policy and auditing all apply unchanged. `requireSession` learns a second way to establish `request.session`, which is what makes every existing admin route accept a token without being edited — and a deny-list of routes that refuse one whatever it holds.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, Prisma 6 / PostgreSQL with RLS, Zod contracts, Vitest against a real database, React 19 for the console.

**Spec:** `docs/superpowers/specs/2026-08-30-machine-tokens-design.md`

## Global Constraints

- **`pnpm typecheck` must stay clean.** `exactOptionalPropertyTypes` is on; there is no linter.
- **Tests run against a real PostgreSQL** (`pnpm db:up`). Never run concurrent suites; never `docker compose down`.
- **New tenant-scoped tables get RLS in the migration that creates them** — `ENABLE`, `FORCE`, and a `tenant_isolation` policy. Copy the `DO $$` block from `20260925000000_person_sources`.
- **Migrations are hand-named above the floor** and appended to `KNOWN_MIGRATIONS` in `packages/db/src/migration-order.ts`. The next free name is `20261002000000_`.
- **The token value appears in exactly one response, once.** Never in a second read, never in an audit payload, never in a log line.
- **Authority is an intersection, never a union.** A scope the account does not hold grants nothing.
- Imports are extensionful ESM.

## File Structure

- Modify `packages/db/prisma/schema.prisma` + a migration — `ApiToken`
- Create `packages/core/src/auth/api-token-service.ts` + test — mint, hash, resolve, revoke
- Modify `packages/core/src/auth/authorize.ts` — the `token` request kind
- Modify `packages/core/src/rbac/permissions.ts` — `TOKEN_MANAGE`
- Create `apps/api/src/plugins/bearer-token.ts` — presentation and the deny-list
- Modify `apps/api/src/plugins/require-session.ts` — accept either credential
- Create `apps/api/src/routes/admin/tokens.ts` + test
- Modify `packages/contracts/src/auth.ts`, `packages/core/src/notify/webhook-event.ts`
- Create `apps/web/src/pages/admin/AccountTokens.tsx` + test
- Modify `docs/configure.md`, `docs/operate.md`

---

### Task 1: The row

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20261002000000_api_tokens/migration.sql`
- Modify: `packages/db/src/migration-order.ts`

**Interfaces:**
- Produces: the `ApiToken` model

- [ ] **Step 1: Add the model**

Exactly the shape in the spec. Docstrings on the three fields that are not obvious: `scopes` (intersected with the account's roles, empty means the account's full authority), `expiresAt` (null allowed and discouraged), `lastUsedAt` (written at most once a minute, because a busy integration would otherwise turn every read into a write).

Indexes: `@@unique([tokenHash])`, `@@index([tenantId])`, `@@index([userId])`.

`userId` is a real relation to `User` with `onDelete: Cascade` — a deleted account must not leave a live credential behind.

- [ ] **Step 2: Write the migration by hand**

`CREATE TABLE "ApiToken"`, the indexes, the foreign keys to `Tenant` and `User`, and the RLS block. A comment at the top saying what the table is and that a token is stored as a digest, never a value.

- [ ] **Step 3: Grandfather it**

Append `'20261002000000_api_tokens'` to `KNOWN_MIGRATIONS`. **Check this immediately** — the last two clusters both had a run where a `perl` multiline edit silently matched nothing and the list went out of step with the tree.

- [ ] **Step 4: Apply and verify**

```bash
pnpm db:migrate && pnpm db:generate
pnpm vitest run packages/db/src/migration-order.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): a credential a program can hold"
```

---

### Task 2: Minting, hashing and resolving

**Files:**
- Create: `packages/core/src/auth/api-token-service.ts`
- Create: `packages/core/src/auth/api-token-service.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export const API_TOKEN_PREFIX = 'syntra_pat_';
export function hashApiToken(token: string): string;
export interface IssuedToken { id: string; token: string; expiresAt: Date | null }
export async function issueApiToken(tx: TenantClient, input: {
  userId: string; name: string; scopes: string[];
  expiresAt: Date | null; createdBy: string | null;
}): Promise<IssuedToken>;
export interface ResolvedApiToken {
  id: string; userId: string; scopes: string[];
}
export async function resolveApiToken(
  tx: TenantClient, token: string, now?: Date,
): Promise<ResolvedApiToken | null>;
export async function touchApiToken(tx: TenantClient, id: string, now?: Date): Promise<void>;
export async function revokeApiToken(tx: TenantClient, id: string): Promise<boolean>;
export async function listApiTokens(tx: TenantClient, userId: string): Promise<ApiTokenView[]>;
```

- [ ] **Step 1: Write the failing test**

```ts
describe('issueApiToken', () => {
  it('returns a prefixed token once and stores only a digest', async () => {
    const issued = await withTenant(tenantId, (tx) =>
      issueApiToken(tx, { userId, name: 'SCIM', scopes: [], expiresAt: null, createdBy: null }),
    );

    expect(issued.token.startsWith('syntra_pat_')).toBe(true);
    const row = await withTenant(tenantId, (tx) => tx.apiToken.findFirstOrThrow());
    // The stored row must not contain the value anywhere.
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row.tokenHash).toBe(hashApiToken(issued.token));
  });

  it('mints a different token every time', async () => {
    const a = await issue(); const b = await issue();
    expect(a.token).not.toBe(b.token);
  });
});

describe('resolveApiToken', () => {
  it('resolves a live token to its account and scopes', async () => {
    const issued = await issue({ scopes: ['directory.read'] });
    const resolved = await withTenant(tenantId, (tx) => resolveApiToken(tx, issued.token));
    expect(resolved).toMatchObject({ userId, scopes: ['directory.read'] });
  });

  it('does not resolve a revoked token', async () => { /* revoke, then expect null */ });
  it('does not resolve an expired token', async () => { /* expiresAt in the past */ });
  it('does not resolve an unknown token', async () => { /* expect null */ });
  it('does not resolve a token without its prefix', async () => { /* expect null */ });

  it('does not resolve a token from another tenant', async () => {
    // RLS, asserted with no `where` on tenant anywhere.
    const issued = await issue();
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    expect(await withTenant(other.id, (tx) => resolveApiToken(tx, issued.token))).toBeNull();
  });
});

describe('touchApiToken', () => {
  it('records first use', async () => { /* lastUsedAt becomes non-null */ });

  it('does not write again within the minute', async () => {
    // A busy integration would otherwise turn every read into a write.
    const issued = await issue();
    await touch(); const first = await readLastUsed();
    await touch(); const second = await readLastUsed();
    expect(second).toEqual(first);
  });

  it('writes again once the minute has passed', async () => {
    // Backdate lastUsedAt, then touch.
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/auth/api-token-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`hashApiToken` is SHA-256, with the docstring saying why not Argon2id — the same reasoning `hashClientSecret` gives: a uniformly random 256-bit value has no dictionary to grind, and a memory-hard KDF here is a latency floor on every API request. Read that docstring and match its argument rather than restating it loosely.

`issueApiToken` builds `API_TOKEN_PREFIX + randomBytes(32).toString('base64url')`.

`resolveApiToken` returns null for anything that is not live: unknown digest, `revokedAt`, or `expiresAt` in the past. **One shape of null**, so a caller cannot tell the three apart.

`touchApiToken` updates `lastUsedAt` only when it is null or older than sixty seconds, in one `updateMany` with the age in the `where` — not a read followed by a write, which two concurrent requests both pass.

- [ ] **Step 4: Run tests, export, commit**

```bash
pnpm vitest run packages/core/src/auth/api-token-service.test.ts && pnpm typecheck
git add packages/core/src/auth/api-token-service.ts packages/core/src/auth/api-token-service.test.ts packages/core/src/index.ts
git commit -m "feat(core): mint a machine token, and store only its digest"
```

---

### Task 3: `authorize()` learns a token

**Files:**
- Modify: `packages/core/src/auth/authorize.ts`
- Modify: `packages/core/src/auth/authorize.test.ts`

**Interfaces:**
- Consumes: `resolveApiToken`
- Produces: `AuthorizeRequest` gains

```ts
| {
    kind: 'token';
    token: string;
    sourceIp: string | null;
    client?: ClientFacts | undefined;
    now?: Date | undefined;
  }
```

and an `allow` for it carries `scope: 'admin'`, `satisfiedFactor: null`, `mayElevate: false`.

- [ ] **Step 1: Write the failing test**

```ts
describe('authorize({ kind: "token" })', () => {
  it('allows a live token and names the account', async () => {
    const result = await authorize(tenantId, { kind: 'token', token, sourceIp: null });
    expect(result).toMatchObject({ status: 'allow', userId, scope: 'admin' });
  });

  it('denies a token whose account has been deactivated', async () => {
    // The reason this goes through authorize() at all: nothing token-specific
    // had to know about deactivation.
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    expect(await authorize(tenantId, { kind: 'token', token, sourceIp: null }))
      .toMatchObject({ status: 'deny' });
  });

  it('denies a revoked, expired or unknown token identically', async () => {
    // A caller learns the credential did not work, not which of the three.
  });

  it('DENIES a token when policy requires a second factor', async () => {
    // A bearer token cannot answer a challenge. Returning `challenge` would be
    // a shape no machine can act on; allowing would silently drop a
    // requirement an operator believes is enforced.
    await addRule(/* require_mfa matching everything */);
    const result = await authorize(tenantId, { kind: 'token', token, sourceIp: null });
    expect(result.status).toBe('deny');
  });

  it('is denied by an IP rule, and allowed from the permitted address', async () => {
    // The control that limits a stolen token.
  });

  it('never returns mayElevate for a token', async () => {
    const result = await authorize(tenantId, { kind: 'token', token, sourceIp: null });
    expect(result).toMatchObject({ mayElevate: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/auth/authorize.test.ts -t "kind: \"token\""`
Expected: FAIL — the union has no such member.

- [ ] **Step 3: Implement**

Add the union member and a `fromToken()` phase-1 function beside `primary()`, resolving the token and then calling the existing `decide()` with `scope: 'admin'`, `applicationId: null`.

`decide()` returns `challenge` when policy asks for a factor. **Convert that to a deny for a token**, in one place, with the reason `mfa_required_for_token` and a comment saying why: a machine cannot answer, an allow would drop a requirement silently, and a `challenge` is a shape the caller cannot act on.

Write `auth.token_denied` for every refusal, carrying the reason but never the token.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run packages/core/src/auth/authorize.test.ts && pnpm typecheck
git add packages/core/src/auth/authorize.ts packages/core/src/auth/authorize.test.ts
git commit -m "feat(core): a token is a decision, not an exemption"
```

---

### Task 4: Presenting one, and the routes that refuse it

**Files:**
- Create: `apps/api/src/plugins/bearer-token.ts`
- Modify: `apps/api/src/plugins/require-session.ts`
- Create: `apps/api/src/plugins/bearer-token.test.ts`

**Interfaces:**
- Produces: `resolveBearerPrincipal(request)`, and `requireSession` accepting either credential
- `request.session` gains `viaToken: boolean` and `tokenScopes: string[]`

- [ ] **Step 1: Write the failing test**

```ts
it('accepts a token on an admin route', async () => {
  const res = await get('/api/admin/users', bearer(token));
  expect(res.statusCode).toBe(200);
});

it('refuses a token at /api/auth/elevate whatever it holds', async () => {
  // A token that could elevate would be a token that could mint a session.
  const res = await post('/api/auth/elevate', bearer(adminToken), { password: 'x' });
  expect(res.statusCode).toBe(403);
  expect(res.json().type).toContain('token-not-accepted');
});

it('refuses a token at the password routes', async () => {
  // Handing a program the ability to set a human's credential is a different
  // authority from managing the directory.
  const res = await post(`/api/admin/users/${id}/password`, bearer(adminToken), { password: 'x' });
  expect(res.statusCode).toBe(403);
});

it('refuses a token on the portal', async () => {
  expect((await get('/api/portal/applications', bearer(token))).statusCode).toBe(403);
});

it('refuses with 403, not 401 — the credential was fine, the route is not for it', async () => {
  expect((await post('/api/auth/elevate', bearer(token), {})).statusCode).not.toBe(401);
});

it('records the token in the audit as a token, not as the person', async () => {
  // Same userId, different actor.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/api/src/plugins/bearer-token.test.ts`
Expected: FAIL — 401 everywhere; there is no bearer path.

- [ ] **Step 3: Implement**

`bearer-token.ts` reads `Authorization: Bearer syntra_pat_…`, calls `authorize({ kind: 'token' })`, and on allow builds a session-shaped principal with `viaToken: true` and the token's scopes. It calls `touchApiToken` **after** the decision, never before — a refused token has not been used.

`requireSession` tries the cookie first, then the bearer. A route in the deny-list refuses a bearer principal with `403 token-not-accepted` and a detail naming why. Keep the deny-list as an exported array with a comment per entry, so adding a route to it is a decision somebody reads.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run apps/api/src/plugins && pnpm typecheck
git add apps/api/src/plugins
git commit -m "feat(api): present a token, and the three places it is refused"
```

---

### Task 5: The intersection

**Files:**
- Modify: `apps/api/src/plugins/require-permission.ts`
- Modify: `apps/api/src/routes/admin/*.test.ts` as needed

**Interfaces:**
- Consumes: `request.session.tokenScopes`

- [ ] **Step 1: Write the failing test**

The four cases, and the third is the one that matters:

```ts
it('allows what both the account and the token hold', async () => { /* 200 */ });

it('refuses what the token does not hold, though the account does', async () => {
  // scopes: ['directory.read'], account holds directory.write
  expect((await post(url, bearer(token), body)).statusCode).toBe(403);
});

it('refuses what the ACCOUNT does not hold, though the token names it', async () => {
  // THE case that proves an intersection rather than a union. A union passes
  // this and hands a token authority its account never had.
  // scopes: ['directory.write'], account holds only directory.read
  expect((await post(url, bearer(token), body)).statusCode).toBe(403);
});

it('gives an empty scope list the account\'s full authority', async () => { /* 200 */ });

it('loses the authority when the account\'s role is revoked, with no token change', async () => {
  // What makes offboarding an integration a single act.
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: the second, third and fifth cases pass a request they should refuse.

- [ ] **Step 3: Implement**

In `requirePermission`, after the existing `hasPermission` check, add: when the principal came from a token and its scope list is non-empty, the permission must also be in that list. Comment it as the intersection, with the reason both directions are checked.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run apps/api/src && pnpm typecheck
git add apps/api/src/plugins/require-permission.ts
git commit -m "feat(api): a token can never exceed the account that issued it"
```

---

### Task 6: Issuing and revoking

**Files:**
- Create: `apps/api/src/routes/admin/tokens.ts` + `.test.ts`
- Modify: `apps/api/src/app.ts`, `packages/core/src/rbac/permissions.ts`, `packages/contracts/src/auth.ts`

- [ ] **Step 1: Add `TOKEN_MANAGE`**

In `PERMISSIONS`, with a docstring in the voice of `DIRECTORY_DELETE`'s: issuing a credential that acts as an account is a different authority from editing that account, and the `directory.write` / `directory.delete` split is the precedent.

- [ ] **Step 2: Write the failing test**

```ts
it('returns the token exactly once', async () => {
  const created = await post(url, cookie, { name: 'SCIM', scopes: [] });
  expect(created.json().token).toMatch(/^syntra_pat_/);
  const listed = await get(url, cookie);
  expect(JSON.stringify(listed.json())).not.toContain(created.json().token);
});

it('needs token.manage, not directory.write', async () => { /* 403 with directory.write only */ });
it('needs a step-up to issue', async () => { /* 403 without, 201 with */ });
it('does not need a step-up to revoke', async () => { /* revocation grants nothing */ });
it('refuses a scope that is not a real permission', async () => { /* 400 */ });
it('writes an audit event carrying the name and scopes and NOT the token', async () => {});
it('revokes, and the token stops working immediately', async () => {});
```

- [ ] **Step 3: Implement**

Three routes as the spec lists. The Zod schema validates `scopes` against `ALL_PERMISSIONS`, so an unknown scope is a 400 rather than a token that silently grants nothing. `expiresAt` optional, defaulted by the console rather than the API — the API should not invent a policy the operator did not state.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run apps/api/src/routes/admin/tokens.test.ts && pnpm typecheck
git add apps/api/src/routes/admin/tokens.ts apps/api/src/routes/admin/tokens.test.ts apps/api/src/app.ts packages/core/src/rbac/permissions.ts packages/contracts/src/auth.ts
git commit -m "feat(api): issue a machine token, and show it once"
```

---

### Task 7: Audit events and the console

**Files:**
- Modify: `packages/core/src/notify/webhook-event.ts`
- Create: `apps/web/src/pages/admin/AccountTokens.tsx` + `.test.tsx`
- Modify: `apps/web/src/pages/admin/AccountDetailPage.tsx`

- [ ] **Step 1: Add the four actions to the `credentials` group**

`api_token.issued`, `api_token.revoked`, `api_token.expired`, `auth.token_denied`. The group's test asserts no action is in two groups; run it.

- [ ] **Step 2: Write the component test**

```tsx
it('shows the token once and says it will not be shown again', async () => {});
it('never shows a token value in the list', async () => {});
it('marks a token that never expires', async () => {});
it('shows when a token was last used, and when it never has been', async () => {
  // A credential nobody can tell is unused is a credential nobody revokes.
});
it('offers no issue control without token.manage', async () => {});
```

- [ ] **Step 3: Implement the panel**

Beside `AccountSessions` on the account record, following that file's structure. The issued token is shown in an `Alert tone="warning"` in the idiom `ApplicationSso` already uses for a client secret — read it and match it rather than inventing a second treatment for the same event.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @syntra/web test && pnpm vitest run packages/core/src/notify
git add packages/core/src/notify/webhook-event.ts apps/web/src/pages/admin
git commit -m "feat(console): a machine credential, shown once"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/configure.md`, `docs/operate.md`, `README.md`

- [ ] **Step 1: `configure.md` gains machine access**

What a token is, the prefix and why it has one, the intersection, `TOKEN_MANAGE`, the three refused route families, and — the surprise worth documenting before somebody meets it — **that a `require_mfa` policy rule refuses a token**, because a machine cannot answer a challenge.

- [ ] **Step 2: `operate.md` gains finding stale tokens**

`lastUsedAt`, that a non-expiring token is a choice somebody made and is marked as one, and that revoking a service account's role revokes every token it issued at once.

- [ ] **Step 3: README**

The Access row mentions machine tokens.

- [ ] **Step 4: Verify every claim against the code**

Route paths, the permission name, the prefix, the deny-list, the step-up rule. Cluster A shipped a doc paragraph describing a bug cured weeks earlier; this step is why.

- [ ] **Step 5: Full suite and commit**

```bash
pnpm vitest run && pnpm typecheck && pnpm --filter @syntra/web test
git add docs README.md
git commit -m "docs: a credential a program can hold"
```

---

## Self-Review

**Spec coverage.** The row and its fields → Task 1. Prefix, hashing, resolution, `lastUsedAt` throttling → Task 2. The `authorize()` ruling, including MFA-denies-a-token → Task 3. Presentation and the deny-list → Task 4. The intersection ruling, both directions → Task 5. Issue/revoke, `TOKEN_MANAGE`, the step-up split → Task 6. Audit actions, the webhook group, the console → Task 7. Documentation → Task 8. The spec's non-goals — inbound SCIM, OAuth for the admin API, per-token IP allowlists, tokens for portal users — have no tasks, correctly.

**Type consistency.** `API_TOKEN_PREFIX`, `hashApiToken`, `issueApiToken`, `IssuedToken`, `resolveApiToken`, `ResolvedApiToken`, `touchApiToken`, `revokeApiToken`, `listApiTokens`, `resolveBearerPrincipal`, `TOKEN_MANAGE` are each declared once and used with those names throughout.

**Known soft spots.** Three the repository decides: whether `decide()` can return `challenge` on a path a token reaches, and where exactly to convert it (Task 3); whether `request.session`'s type can carry `viaToken` without widening `ResolvedSession` in a way core objects to (Task 4); and how `AccountDetailPage` composes panels, which Task 7 should follow rather than restate.
