# Ending Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Syntra a way to make somebody's access stop — a session inventory with revocation, working client authentication on the OIDC revocation and introspection endpoints, and OpenID Connect back-channel logout — all funnelled through one function so no caller can revoke without propagating.

**Architecture:** Three phases that land independently. Phase 1 adds origin columns to `Session` and the list/revoke surfaces over them. Phase 2 moves revocation and introspection off oidc-provider's catch-all into the token plugin that owns real client authentication. Phase 3 adds logout-token delivery reusing the webhook retry policy and `guardedFetch`, then introduces `endSessions` and migrates every existing revocation caller onto it — proving the migration complete by un-exporting what they used to call.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, Prisma 6 / PostgreSQL with `FORCE ROW LEVEL SECURITY`, Zod contracts, oidc-provider, `jose` for JWT, Vitest against a real database, React 19 + Vite for the console, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-29-ending-access-design.md`

## Global Constraints

- **Node 22+, pnpm 9.12.0.** `corepack enable` picks up the pinned pnpm.
- **Every new tenant-scoped table gets RLS in the same migration that creates it** — `ENABLE`, `FORCE`, and a `tenant_isolation` policy using `NULLIF(current_setting('app.current_tenant', true), '')::uuid`. Copy the `DO $$` block from `packages/db/prisma/migrations/20260925000000_person_sources/migration.sql:140`.
- **Migration directories are hand-named above the floor.** `MIGRATION_NAME_FLOOR` is `20260928000000` (`packages/db/src/migration-order.ts:44`). New migrations use `20260929000000_` and `20260930000000_` prefixes and **must be appended to `KNOWN_MIGRATIONS`** in the same file — `migration-order.test.ts:54` asserts the list equals the directory listing exactly.
- **Tests run against a real PostgreSQL**, never mocked. `pnpm db:up` first.
- **Do not run concurrent test suites.** Per the project's own notes, concurrent runs produce phantom failures.
- **Never run `docker compose down` or `down -v`.** It wipes local fixtures.
- **Audit every state change** through `recordEvent(tx, {actorUserId, action, targetType, targetId, outcome, sourceIp, payload})` inside the same transaction.
- **Imports are extensionful ESM**: `./session-service.js`, never `./session-service`.
- **No `any`.** `pnpm typecheck` is `tsc -b` and must stay clean.

## File Structure

**Phase 1 — sessions**
- Modify `packages/db/prisma/schema.prisma` — `ip`, `userAgent` on `Session`
- Create `packages/db/prisma/migrations/20260929000000_session_origin/migration.sql`
- Modify `packages/db/src/migration-order.ts` — grandfather the new directory
- Modify `packages/core/src/auth/session-service.ts` — `SessionOrigin`, `SessionSummary`, `listSessionsForUser`, `revokeSessionById`
- Modify `apps/api/src/routes/session-reply.ts:123` — the only non-test `createSession` caller
- Create `apps/api/src/routes/admin/sessions.ts` + `.test.ts`
- Modify `apps/api/src/routes/portal.ts` — own-session routes
- Modify `apps/api/src/app.ts` — register the admin plugin
- Modify `packages/contracts/src/auth.ts` — session summary schema
- Create `apps/web/src/pages/admin/AccountSessions.tsx` + test; modify `AccountDetailPage.tsx`
- Create `apps/web/src/pages/YourDevices.tsx` + test

**Phase 2 — OIDC endpoints**
- Modify `apps/api/src/routes/oidc-token.ts` — two explicit routes
- Modify `apps/api/src/routes/oidc-boundary.test.ts` — replace the pin
- Create `apps/api/src/routes/oidc-revocation.test.ts`

**Phase 3 — back-channel logout**
- Modify `packages/db/prisma/schema.prisma` — `OidcClient` columns, `LogoutDelivery` model
- Create `packages/db/prisma/migrations/20260930000000_backchannel_logout/migration.sql`
- Create `packages/core/src/access/logout-token.ts` + test — minting only
- Create `packages/core/src/access/logout-delivery.ts` + test — enqueue and send
- Create `packages/core/src/access/logout-jobs.ts` — scheduler registration
- Create `packages/core/src/auth/end-sessions.ts` + test — the funnel
- Modify the seven existing revocation callers
- Modify `docs/configure.md`, `docs/operate.md`

Splitting minting from delivery is deliberate: minting is pure and testable without a server, delivery needs one. A single file would make the token tests need HTTP.

---

## Phase 1 — Session inventory

### Task 1: Session origin columns

**Files:**
- Modify: `packages/db/prisma/schema.prisma:591-610`
- Create: `packages/db/prisma/migrations/20260929000000_session_origin/migration.sql`
- Modify: `packages/db/src/migration-order.ts:51`
- Test: `packages/db/src/migration-order.test.ts` (existing, must keep passing)

**Interfaces:**
- Consumes: nothing
- Produces: `Session.ip: string | null`, `Session.userAgent: string | null` in the Prisma client

- [ ] **Step 1: Add the columns to the schema**

In `schema.prisma`, inside `model Session`, after `satisfiedFactor`:

```prisma
  /// The address the session was established from, as the trusted-proxy
  /// resolution reports it. Descriptive, never authoritative: nothing reads
  /// this to make a decision, and a session is not refused for having moved.
  ip                String?
  /// The User-Agent at establishment, truncated to 256 bytes on write. Stored
  /// so a person can recognise a session in a list -- a list of scopes and
  /// timestamps is not recognisable, and an unrecognisable list gets revoked
  /// wholesale instead of precisely.
  userAgent         String?
```

And add the list index next to the existing ones:

```prisma
  @@index([userId, revokedAt])
```

- [ ] **Step 2: Write the migration by hand**

Create `packages/db/prisma/migrations/20260929000000_session_origin/migration.sql`:

```sql
-- Where a session came from, so a person can recognise one they did not start.
--
-- Both nullable: sessions that predate this migration have neither, and a
-- backfill would have to invent values. Null renders as "unknown", which is
-- the truth.
ALTER TABLE "Session" ADD COLUMN "ip" TEXT;
ALTER TABLE "Session" ADD COLUMN "userAgent" TEXT;

-- The inventory query is "live sessions for this user".
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");
```

No RLS block: `Session` already has row-level security, and adding a column does not change its policy.

- [ ] **Step 3: Grandfather the directory**

In `packages/db/src/migration-order.ts`, append to the end of the `KNOWN_MIGRATIONS` array, after `'20260928000000_tenant_foreign_keys',`:

```ts
  '20260929000000_session_origin',
```

Leave `MIGRATION_NAME_FLOOR` at `'20260928000000'` — the new name sorts above it, which is the point.

- [ ] **Step 4: Run the migration order test to verify it passes**

Run: `pnpm vitest run packages/db/src/migration-order.test.ts`
Expected: PASS. If `grandfathers exactly the migrations that exist` fails, the array and the directory disagree — fix the array.

- [ ] **Step 5: Apply and regenerate**

Run:
```bash
pnpm db:up
pnpm db:migrate
pnpm db:generate
```
Expected: the migration applies; `prisma generate` reports the client written.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/db/src/migration-order.ts
git commit -m "feat(db): a session records where it was established from"
```

---

### Task 2: SessionOrigin on createSession

**Files:**
- Modify: `packages/core/src/auth/session-service.ts:85`
- Modify: `apps/api/src/routes/session-reply.ts:123`
- Test: `packages/core/src/auth/session-service.test.ts`

**Interfaces:**
- Consumes: Task 1's columns
- Produces: `SessionOrigin { ip: string | null; userAgent: string | null }`; `createSession(tx, decision, origin)` — a **three**-argument signature every later task uses

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/auth/session-service.test.ts`:

```ts
describe('session origin', () => {
  it('records the address and user agent the session was established from', async () => {
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'portal'), {
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/141.0',
      });
      const row = await tx.session.findFirstOrThrow({ where: { userId } });
      expect(row.ip).toBe('203.0.113.7');
      expect(row.userAgent).toBe('Mozilla/5.0 (Windows NT 10.0) Firefox/141.0');
    });
  });

  it('truncates a user agent that is trying to be a payload', async () => {
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'portal'), {
        ip: null,
        userAgent: 'x'.repeat(5000),
      });
      const row = await tx.session.findFirstOrThrow({ where: { userId } });
      expect(row.userAgent).toHaveLength(256);
    });
  });

  it('accepts a session with no origin at all', async () => {
    // Not every caller has a request behind it, and a null column is the
    // honest answer rather than a fabricated one.
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'portal'), { ip: null, userAgent: null });
      const row = await tx.session.findFirstOrThrow({ where: { userId } });
      expect(row.ip).toBeNull();
      expect(row.userAgent).toBeNull();
    });
  });
});
```

Reuse whatever `seedUser` / `allowance` helpers the file already defines; if it has none, write them from the existing tests' setup in the same file rather than inventing a new style.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/auth/session-service.test.ts -t "session origin"`
Expected: FAIL — `createSession` takes 2 arguments, not 3.

- [ ] **Step 3: Implement**

In `session-service.ts`, above `createSession`:

```ts
/**
 * Where a session was established from. Description, not authority.
 *
 * A separate parameter from `SessionAllowance` on purpose. Everything the
 * decision carries is read off the decision, "never taken from ambient request
 * state" -- and an address and a user agent ARE ambient request state. Putting
 * them on the allowance would make that sentence false, and that sentence is
 * what stops a route passing a user id its decision does not carry.
 *
 * Two parameters, two meanings: the decision says who may have a session, the
 * origin says what the browser looked like when they got one.
 */
export interface SessionOrigin {
  ip: string | null;
  userAgent: string | null;
}

/** Attacker-controlled text of unbounded length, kept to be read by a human. */
const USER_AGENT_MAX = 256;
```

Change the signature and the create call:

```ts
export async function createSession(
  tx: TenantClient,
  decision: SessionAllowance,
  origin: SessionOrigin,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const { userId, scope, satisfiedFactor } = decision;
  const absoluteExpiresAt = new Date(Date.now() + ABSOLUTE_LIFETIME_MS[scope]);

  await tx.session.create({
    data: {
      tenantId,
      userId,
      tokenHash: hashToken(token),
      scope,
      satisfiedFactor,
      absoluteExpiresAt,
      ip: origin.ip,
      userAgent: origin.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    },
  });

  return { token, expiresAt: absoluteExpiresAt };
}
```

- [ ] **Step 4: Update the one real caller**

In `apps/api/src/routes/session-reply.ts:123`:

```ts
  const { token } = await request.db((tx) =>
    createSession(tx, decision, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    }),
  );
```

`request.ip` is Fastify's, which honours the trusted-proxy configuration the per-IP rate limits already depend on (`packages/core/src/config.ts:81`). Do not compute the address any other way.

- [ ] **Step 5: Run the tests and typecheck**

Run:
```bash
pnpm vitest run packages/core/src/auth/session-service.test.ts
pnpm typecheck
```
Expected: PASS, and `tsc -b` clean. Any other `createSession` caller that appears is a test — give it `{ ip: null, userAgent: null }`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/auth/session-service.ts apps/api/src/routes/session-reply.ts packages/core/src/auth/session-service.test.ts
git commit -m "feat(core): a decision carries authority, an origin carries description"
```

---

### Task 3: Listing and revoking one session

**Files:**
- Modify: `packages/core/src/auth/session-service.ts`
- Test: `packages/core/src/auth/session-service.test.ts`

**Interfaces:**
- Consumes: Task 2's columns and signature
- Produces:
  - `SessionSummary { id, scope, satisfiedFactor, ip, userAgent, createdAt, lastSeenAt, absoluteExpiresAt }`
  - `listSessionsForUser(tx: TenantClient, userId: string): Promise<SessionSummary[]>`
  - `revokeSessionById(tx: TenantClient, sessionId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
describe('listSessionsForUser', () => {
  it('returns live sessions newest first, without the token hash', async () => {
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'portal'), { ip: '198.51.100.1', userAgent: 'A' });
      await createSession(tx, allowance(userId, 'admin'), { ip: '198.51.100.2', userAgent: 'B' });

      const sessions = await listSessionsForUser(tx, userId);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        sessions[1]!.createdAt.getTime(),
      );
      expect(sessions[0]).not.toHaveProperty('tokenHash');
    });
  });

  it('omits a revoked session', async () => {
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      const { token } = await createSession(tx, allowance(userId, 'portal'), {
        ip: null, userAgent: null,
      });
      await revokeSession(tx, token);
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
    });
  });

  it('omits a session past its absolute expiry, which revokedAt alone would miss', async () => {
    // The liveness rules are resolveSession's. A row with a null revokedAt and
    // an expiry in the past is dead, and a list that shows it invites somebody
    // to revoke a session that already ended.
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'portal'), { ip: null, userAgent: null });
      await tx.session.updateMany({
        where: { userId },
        data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
      });
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
    });
  });

  it('omits an idle session past its scope timeout', async () => {
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'admin'), { ip: null, userAgent: null });
      // Admin idles out at 15 minutes.
      await tx.session.updateMany({
        where: { userId },
        data: { lastSeenAt: new Date(Date.now() - 16 * 60 * 1000) },
      });
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
    });
  });
});

describe('revokeSessionById', () => {
  it('revokes one session and leaves the others', async () => {
    const { userId, tenantId } = await seedUser();
    await withTenant(tenantId, async (tx) => {
      await createSession(tx, allowance(userId, 'portal'), { ip: null, userAgent: null });
      await createSession(tx, allowance(userId, 'portal'), { ip: null, userAgent: null });
      const [first] = await listSessionsForUser(tx, userId);

      expect(await revokeSessionById(tx, first!.id)).toBe(true);
      expect(await listSessionsForUser(tx, userId)).toHaveLength(1);
    });
  });

  it('answers false for a session that is not there', async () => {
    const { tenantId } = await seedUser();
    await withTenant(tenantId, (tx) =>
      expect(revokeSessionById(tx, '00000000-0000-0000-0000-000000000001')).resolves.toBe(false),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/auth/session-service.test.ts -t "listSessionsForUser"`
Expected: FAIL — `listSessionsForUser is not a function`.

- [ ] **Step 3: Implement**

Append to `session-service.ts`:

```ts
/**
 * A session as somebody is shown it. Never the token hash: there is no screen
 * on which a session's stored digest is a thing anyone needs.
 */
export interface SessionSummary {
  id: string;
  scope: SessionScope;
  satisfiedFactor: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Every session of this user's that is still good.
 *
 * "Still good" is `isLive`'s answer and nobody else's -- the same predicate
 * `resolveSession` and `readSession` use, covering revocation, absolute expiry
 * AND the per-scope idle timeout. Filtering on `revokedAt: null` alone would
 * list sessions that stopped working hours ago, and the first thing anybody
 * would do is revoke one of them and wonder why nothing changed.
 */
export async function listSessionsForUser(
  tx: TenantClient,
  userId: string,
): Promise<SessionSummary[]> {
  const now = Date.now();
  const rows = await tx.session.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const live: SessionSummary[] = [];
  for (const row of rows) {
    if (!(await isLive(tx, row, now))) continue;
    live.push({
      id: row.id,
      scope: row.scope as SessionScope,
      satisfiedFactor: row.satisfiedFactor,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    });
  }
  return live;
}

/**
 * Revokes one session by its id rather than by its token.
 *
 * The token is what a holder presents; the id is what a list offers. An
 * administrator revoking somebody else's session has the second and must never
 * need the first.
 *
 * Returns whether anything was revoked, so a route can answer 404 for a
 * session that is not there instead of a cheerful 200 for a no-op.
 */
export async function revokeSessionById(
  tx: TenantClient,
  sessionId: string,
): Promise<boolean> {
  const { count } = await tx.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}
```

If `isLive` is not already in scope at this point in the file, move these functions below its definition rather than exporting it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/auth/session-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/auth/session-service.ts packages/core/src/auth/session-service.test.ts
git commit -m "feat(core): list a user's live sessions, and revoke one by id"
```

---

### Task 4: Admin session routes

**Files:**
- Create: `apps/api/src/routes/admin/sessions.ts`
- Create: `apps/api/src/routes/admin/sessions.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/contracts/src/auth.ts`

**Interfaces:**
- Consumes: `listSessionsForUser`, `revokeSessionById`, `revokeAllForUser`
- Produces: `registerAdminSessionRoutes(app: FastifyInstance): Promise<void>`; the `sessionSummary` Zod schema

- [ ] **Step 1: Add the contract**

In `packages/contracts/src/auth.ts`:

```ts
export const sessionSummary = z.object({
  id: z.string().uuid(),
  scope: z.enum(['portal', 'admin']),
  satisfiedFactor: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  absoluteExpiresAt: z.string(),
  current: z.boolean().optional(),
});
export type SessionSummaryDto = z.infer<typeof sessionSummary>;
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/admin/sessions.test.ts`, modelled on `users.test.ts` — copy its `seedAdmin` / `authCookie` helpers and `buildTestApp` import verbatim rather than inventing a second harness.

```ts
describe('admin sessions', () => {
  it('lists a user\'s live sessions', async () => {
    const cookie = await authCookie('admin');
    const target = await seedTargetUserWithSessions(2);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${target.id}/sessions`,
      headers: { host: ctx.host, cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).not.toHaveProperty('tokenHash');
  });

  it('revokes one session and audits who did it', async () => {
    const cookie = await authCookie('admin');
    const target = await seedTargetUserWithSessions(2);
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${target.id}/sessions`,
      headers: { host: ctx.host, cookie },
    });
    const victim = list.json().sessions[0].id;

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${target.id}/sessions/${victim}`,
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(204);

    const event = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'session.revoked' }, orderBy: { sequence: 'desc' } }),
    );
    expect(event).not.toBeNull();
    expect((event!.payload as Record<string, unknown>).trigger).toBe('admin');
  });

  it('answers 404 for a session that is not this user\'s', async () => {
    const cookie = await authCookie('admin');
    const target = await seedTargetUserWithSessions(1);
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${target.id}/sessions/00000000-0000-0000-0000-000000000001`,
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a caller without directory.write', async () => {
    // Seeded with directory.read only.
    const cookie = await readOnlyAdminCookie();
    const target = await seedTargetUserWithSessions(1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${target.id}/sessions/revoke`,
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/sessions.test.ts`
Expected: FAIL — 404 on every route, because the plugin is not registered.

- [ ] **Step 4: Implement the routes**

Create `apps/api/src/routes/admin/sessions.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  listSessionsForUser,
  recordEvent,
  revokeAllForUser,
  revokeSessionById,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';

const sessionParams = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
});

/**
 * Somebody else's sessions, listed and ended.
 *
 * Guarded by `directory.write` and no step-up. Revocation GRANTS NOTHING --
 * it is the same authority as deactivating the account, exercised more
 * narrowly, and demanding a second factor to take access away would make the
 * safe act harder than the dangerous one.
 */
export async function registerAdminSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/users/:id/sessions',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const sessions = await request.db((tx) => listSessionsForUser(tx, id));
      return { sessions };
    },
  );

  app.delete(
    '/users/:id/sessions/:sessionId',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, sessionId } = sessionParams.parse(request.params);

      await request.db(async (tx) => {
        // Scoped to the user in the path, so a session id alone is not a
        // capability to revoke anything in the tenant.
        const owned = await tx.session.findFirst({
          where: { id: sessionId, userId: id, revokedAt: null },
          select: { id: true },
        });
        if (!owned) throw new ProblemError(404, 'not-found', 'Session not found');

        await revokeSessionById(tx, sessionId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'session.revoked',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { trigger: 'admin', count: 1, sessionId },
        });
      });

      return reply.code(204).send();
    },
  );

  app.post(
    '/users/:id/sessions/revoke',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const count = await revokeAllForUser(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'session.revoked',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { trigger: 'admin', count },
        });
        return { sessionsRevoked: count };
      });
    },
  );
}
```

> **Task 15 changes both write handlers** to call `endSessions` instead of `revokeAllForUser` / `revokeSessionById`. They are written directly here because the funnel does not exist yet.

- [ ] **Step 5: Register the plugin**

In `apps/api/src/app.ts`, beside the other admin registrations — import it next to `registerAdminUserRoutes` and register it on the same prefix the other admin plugins use (copy the exact `app.register(...)` line for `registerAdminUserRoutes` and substitute).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/admin/sessions.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin/sessions.ts apps/api/src/routes/admin/sessions.test.ts apps/api/src/app.ts packages/contracts/src/auth.ts
git commit -m "feat(api): list and revoke somebody's sessions"
```

---

### Task 5: Portal session routes

**Files:**
- Modify: `apps/api/src/routes/portal.ts`
- Modify: `apps/api/src/routes/portal.test.ts`

**Interfaces:**
- Consumes: `listSessionsForUser`, `revokeSessionById`
- Produces: `GET /api/portal/sessions`, `DELETE /api/portal/sessions/:id`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/portal.test.ts`:

```ts
describe('your own sessions', () => {
  it('flags the session making the request', async () => {
    const cookie = await authCookie('portal');
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/portal/sessions',
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    const current = res.json().sessions.filter((s: { current?: boolean }) => s.current);
    expect(current).toHaveLength(1);
  });

  it('signs you out when you revoke the session you are holding, and says so', async () => {
    // Refusing this would be worse: the session somebody most wants to end
    // from another device is the one in front of them.
    const cookie = await authCookie('portal');
    const list = await ctx.app.inject({
      method: 'GET', url: '/api/portal/sessions',
      headers: { host: ctx.host, cookie },
    });
    const mine = list.json().sessions.find((s: { current?: boolean }) => s.current);

    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/portal/sessions/${mine.id}`,
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ signedOut: true });
    expect(res.cookies.find((c) => c.name === 'syntra_session')?.value).toBe('');

    const after = await ctx.app.inject({
      method: 'GET', url: '/api/portal/sessions',
      headers: { host: ctx.host, cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('cannot revoke somebody else\'s session', async () => {
    const cookie = await authCookie('portal');
    const other = await seedOtherUserSession();
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/portal/sessions/${other.sessionId}`,
      headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/portal.test.ts -t "your own sessions"`
Expected: FAIL — 404, routes not defined.

- [ ] **Step 3: Implement**

In `registerPortalRoutes`, add `listSessionsForUser`, `revokeSessionById` and `recordEvent` to the `@syntra/core` import, then:

```ts
  /**
   * Your own sessions, and ending them.
   *
   * The current one is flagged rather than hidden. Hiding it would leave a
   * list that cannot account for the browser reading it, and somebody trying
   * to work out which row is "here" is somebody about to revoke the wrong one.
   */
  app.get('/sessions', async (request) => {
    const sessions = await request.db((tx) =>
      listSessionsForUser(tx, request.session.userId),
    );
    return {
      sessions: sessions.map((s) => ({
        ...s,
        current: s.id === request.session.sessionId,
      })),
    };
  });

  app.delete('/sessions/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const isCurrent = id === request.session.sessionId;

    await request.db(async (tx) => {
      const owned = await tx.session.findFirst({
        where: { id, userId: request.session.userId, revokedAt: null },
        select: { id: true },
      });
      // 404 rather than 403 for somebody else's: answering "forbidden" would
      // confirm the session exists, and a session id is not a secret worth
      // leaking the existence of.
      if (!owned) throw new ProblemError(404, 'not-found', 'Session not found');

      await revokeSessionById(tx, id);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'session.revoked',
        targetType: 'User',
        targetId: request.session.userId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { trigger: 'self', count: 1, sessionId: id, current: isCurrent },
      });
    });

    if (isCurrent) {
      reply.clearCookie('syntra_session', { path: '/' });
      return { signedOut: true };
    }
    return { signedOut: false };
  });
```

If `request.session` carries no `sessionId`, add it where `requireSession` builds the object — `resolveSession` already returns it as `ResolvedSession.sessionId`. Check `apps/api/src/plugins/require-session.ts` first; do not re-resolve the session in the handler.

The cookie name and options must match exactly what `session-reply.ts` sets, or the browser keeps a cookie the server has forgotten.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/portal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/portal.ts apps/api/src/routes/portal.test.ts apps/api/src/plugins/require-session.ts
git commit -m "feat(api): your own devices, and signing one out"
```

---

### Task 6: Console — the admin Sessions tab

**Files:**
- Create: `apps/web/src/pages/admin/AccountSessions.tsx`
- Create: `apps/web/src/pages/admin/AccountSessions.test.tsx`
- Modify: `apps/web/src/pages/admin/AccountDetailPage.tsx`

**Interfaces:**
- Consumes: `GET/DELETE/POST /api/admin/users/:id/sessions*`
- Produces: `<AccountSessions userId={string} />`

- [ ] **Step 1: Write the failing test**

Follow the existing `AccountDetailPage.test.tsx` idiom exactly — same `json()` helper, same MSW-style handler shape.

```tsx
it('shows a session in terms somebody can recognise', async () => {
  server.use(
    http.get('/api/admin/users/u1/sessions', () =>
      json({ sessions: [{
        id: 's1', scope: 'portal', satisfiedFactor: 'totp',
        ip: '198.51.100.4', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/141.0',
        createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }] }),
    ),
  );
  render(<AccountSessions userId="u1" />);
  expect(await screen.findByText(/198\.51\.100\.4/)).toBeInTheDocument();
  expect(screen.getByText(/Firefox/)).toBeInTheDocument();
});

it('revokes one row and stops showing it', async () => {
  let revoked = false;
  server.use(
    http.get('/api/admin/users/u1/sessions', () =>
      json({ sessions: revoked ? [] : [oneSession()] })),
    http.delete('/api/admin/users/u1/sessions/s1', () => { revoked = true; return new Response(null, { status: 204 }); }),
  );
  render(<AccountSessions userId="u1" />);
  await userEvent.click(await screen.findByRole('button', { name: /revoke/i }));
  expect(await screen.findByText(/no active sessions/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @syntra/web test -- AccountSessions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Build it from the design-system primitives the neighbouring admin pages use — read `AccountDetailPage.tsx` and match its table, button and empty-state components rather than writing raw markup. Requirements the tests pin:

- A row per session: scope, `ip`, a readable rendering of `userAgent`, established-at, last-seen.
- A **Revoke** button per row and a **Revoke all** above the table.
- An empty state reading "No active sessions".
- `userAgent` rendered through a small local helper that reduces the string to a browser and platform where it recognises one and otherwise shows it whole and truncated. Keep the helper in this file: it is presentation, and no other screen needs it.

Do not add explanatory prose next to the controls. If a control needs a paragraph, the control is wrong.

- [ ] **Step 4: Wire the tab**

Add a `Sessions` tab to `AccountDetailPage.tsx` beside the existing ones, rendering `<AccountSessions userId={id} />`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @syntra/web test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/admin/AccountSessions.tsx apps/web/src/pages/admin/AccountSessions.test.tsx apps/web/src/pages/admin/AccountDetailPage.tsx
git commit -m "feat(console): a user's sessions, and ending one"
```

---

### Task 7: Portal — Your devices

**Files:**
- Create: `apps/web/src/pages/YourDevices.tsx`
- Create: `apps/web/src/pages/YourDevices.test.tsx`
- Modify: the portal profile page and `apps/web/src/components/PortalNav.tsx`

**Interfaces:**
- Consumes: `GET/DELETE /api/portal/sessions`
- Produces: `<YourDevices />`

- [ ] **Step 1: Write the failing test**

```tsx
it('marks the session you are using and does not offer to revoke it silently', async () => {
  server.use(http.get('/api/portal/sessions', () => json({ sessions: [
    { ...oneSession(), id: 's1', current: true },
    { ...oneSession(), id: 's2', current: false },
  ] })));
  render(<YourDevices />);
  expect(await screen.findByText(/this device/i)).toBeInTheDocument();
});

it('tells you plainly that revoking this device signs you out', async () => {
  server.use(
    http.get('/api/portal/sessions', () => json({ sessions: [{ ...oneSession(), id: 's1', current: true }] })),
    http.delete('/api/portal/sessions/s1', () => json({ signedOut: true })),
  );
  render(<YourDevices />);
  await userEvent.click(await screen.findByRole('button', { name: /sign out this device/i }));
  expect(await screen.findByText(/you have been signed out/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @syntra/web test -- YourDevices`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Same list, portal styling, following the existing portal pages. The current row is labelled **This device** and its button reads **Sign out this device** rather than "Revoke" — the label is the warning, so no confirmation dialog is needed. On a `signedOut: true` response, show the signed-out state and route to the login screen.

- [ ] **Step 4: Link it**

Add the route and a nav entry in `PortalNav.tsx`, matching how the existing portal pages are registered.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @syntra/web test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/YourDevices.tsx apps/web/src/pages/YourDevices.test.tsx apps/web/src/components/PortalNav.tsx
git commit -m "feat(portal): your devices, and signing one out"
```

---

## Phase 2 — OIDC revocation and introspection

### Task 8: Revocation with Syntra's own client authentication

**Files:**
- Modify: `apps/api/src/routes/oidc-token.ts`
- Create: `apps/api/src/routes/oidc-revocation.test.ts`

**Interfaces:**
- Consumes: `presentedCredentials`, the client-secret verification and `oidcProviderFor` already in this file
- Produces: `POST /oidc/token/revocation`

**Background the implementer needs.** `/token` is safe because Syntra authenticates the client itself — constant-time, against the stored SHA-256 hash — and then hands oidc-provider a *placeholder* secret (`PROVIDER_CLIENT_SECRET`, `oidc-op.ts:47`). Every other client-authenticated endpoint therefore answers `invalid_client` to a client presenting its real secret, because the provider compares against a value nobody holds. That is what this task fixes, for these two endpoints only.

**Resolve the presented token through oidc-provider's own model finders** — `provider.RefreshToken.find(value)` and `provider.AccessToken.find(value)`. Do not parse the opaque token or query `OidcArtifact` by its text: the token's internal format is oidc-provider's business and reimplementing it is how this breaks on a library upgrade.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/oidc-revocation.test.ts`. Build a confidential client and complete a code exchange to get a real refresh token — copy that setup from `oidc-grants.test.ts` rather than writing a new one.

```ts
it('authenticates a client presenting its real secret', async () => {
  const res = await postForm('/oidc/token/revocation', {
    token: refreshToken, client_id: clientId, client_secret: realSecret,
  });
  expect(res.statusCode).toBe(200);
});

it('revokes the refresh token and everything on its grant', async () => {
  await postForm('/oidc/token/revocation', {
    token: refreshToken, client_id: clientId, client_secret: realSecret,
  });
  const again = await postForm('/oidc/token', {
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: clientId, client_secret: realSecret,
  });
  expect(again.statusCode).toBe(400);
  expect(again.json().error).toBe('invalid_grant');
});

it('answers 200 for a token that never existed', async () => {
  // RFC 7009. A 404 here is an oracle for guessing tokens.
  const res = await postForm('/oidc/token/revocation', {
    token: 'not-a-token', client_id: clientId, client_secret: realSecret,
  });
  expect(res.statusCode).toBe(200);
});

it('will not revoke another client\'s token, and does not say so', async () => {
  const res = await postForm('/oidc/token/revocation', {
    token: otherClientsRefreshToken, client_id: clientId, client_secret: realSecret,
  });
  expect(res.statusCode).toBe(200);
  // Still usable by its owner.
  const still = await postForm('/oidc/token', {
    grant_type: 'refresh_token', refresh_token: otherClientsRefreshToken,
    client_id: otherClientId, client_secret: otherSecret,
  });
  expect(still.statusCode).toBe(200);
});

it('refuses a wrong secret', async () => {
  const res = await postForm('/oidc/token/revocation', {
    token: refreshToken, client_id: clientId, client_secret: 'wrong',
  });
  expect(res.statusCode).toBe(401);
  expect(res.json().error).toBe('invalid_client');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/oidc-revocation.test.ts`
Expected: FAIL — the first test gets 401 `invalid_client`, which is exactly the defect.

- [ ] **Step 3: Implement**

Inside `registerOidcTokenRoutes`, alongside the existing `/token` route, using the same rate limiter the other protocol routes use:

```ts
  /**
   * RFC 7009. Registered here, in the plugin that owns real client
   * authentication, rather than falling through to oidc-provider's catch-all
   * where the placeholder secret guarantees `invalid_client`.
   */
  app.post('/token/revocation', { preHandler: rateLimited }, async (request, reply) => {
    const params = new URLSearchParams(await readBody(request));
    const credentials = presentedCredentials(request, params);
    const client = await authenticateClient(request, credentials);
    if (!client) {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    const token = params.get('token');
    if (token) {
      const provider = await oidcProviderFor(request, options);
      const found =
        (await provider.RefreshToken.find(token)) ?? (await provider.AccessToken.find(token));
      // Only the issuing client may revoke. A mismatch is answered exactly as
      // a hit is -- see below.
      if (found && found.clientId === client.clientId && found.grantId) {
        await request.db((tx) => artifactRevokeByGrantId(tx, found.grantId!));
      }
    }

    // 200 whether the token existed, had already gone, or belonged to somebody
    // else. The spec requires it, and it is also the only answer that does not
    // turn this endpoint into an oracle for guessing other clients' tokens.
    return reply.code(200).send();
  });
```

`authenticateClient` and `readBody` are the helpers `/token` already uses in this file — reuse them under whatever names they carry there; do not write second copies.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/oidc-revocation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/oidc-token.ts apps/api/src/routes/oidc-revocation.test.ts
git commit -m "feat(oidc): revocation authenticates the client Syntra authenticates"
```

---

### Task 9: Introspection

**Files:**
- Modify: `apps/api/src/routes/oidc-token.ts`
- Modify: `apps/api/src/routes/oidc-revocation.test.ts`

**Interfaces:**
- Consumes: Task 8's route helpers
- Produces: `POST /oidc/token/introspection`

- [ ] **Step 1: Write the failing test**

```ts
describe('introspection', () => {
  it('describes the client\'s own live token', async () => {
    const res = await postForm('/oidc/token/introspection', {
      token: accessToken, client_id: clientId, client_secret: realSecret,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: true, client_id: clientId });
    expect(res.json().sub).toBe(userId);
  });

  it('answers active:false for another client\'s token, and describes nothing', async () => {
    // The security property of this endpoint. A client holding one token must
    // not learn the subject or scope of another.
    const res = await postForm('/oidc/token/introspection', {
      token: otherClientsAccessToken, client_id: clientId, client_secret: realSecret,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('answers active:false for a revoked token', async () => {
    await postForm('/oidc/token/revocation', {
      token: refreshToken, client_id: clientId, client_secret: realSecret,
    });
    const res = await postForm('/oidc/token/introspection', {
      token: refreshToken, client_id: clientId, client_secret: realSecret,
    });
    expect(res.json()).toEqual({ active: false });
  });

  it('answers active:false for nonsense', async () => {
    const res = await postForm('/oidc/token/introspection', {
      token: 'nonsense', client_id: clientId, client_secret: realSecret,
    });
    expect(res.json()).toEqual({ active: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/oidc-revocation.test.ts -t "introspection"`
Expected: FAIL — 401 `invalid_client`.

- [ ] **Step 3: Implement**

```ts
  /** RFC 7662, with one rule: a client may introspect only its own tokens. */
  app.post('/token/introspection', { preHandler: rateLimited }, async (request, reply) => {
    const params = new URLSearchParams(await readBody(request));
    const credentials = presentedCredentials(request, params);
    const client = await authenticateClient(request, credentials);
    if (!client) {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    const inactive = { active: false as const };
    const token = params.get('token');
    if (!token) return reply.code(200).send(inactive);

    const provider = await oidcProviderFor(request, options);
    const found =
      (await provider.AccessToken.find(token)) ?? (await provider.RefreshToken.find(token));

    // Every "no" is the same "no". Distinguishing expired from revoked from
    // somebody else's would answer questions the caller has no standing to ask.
    if (!found || found.clientId !== client.clientId) {
      return reply.code(200).send(inactive);
    }

    return reply.code(200).send({
      active: true,
      sub: found.accountId,
      scope: found.scope,
      client_id: found.clientId,
      token_type: 'Bearer',
      exp: found.exp,
      iat: found.iat,
    });
  });
```

`provider.AccessToken.find` returns undefined for an expired or consumed token, so expiry needs no separate branch — but assert it with the revoked-token test above rather than assuming it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/oidc-revocation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/oidc-token.ts apps/api/src/routes/oidc-revocation.test.ts
git commit -m "feat(oidc): introspection, and only of your own tokens"
```

---

### Task 10: Replace the deliberate pin

**Files:**
- Modify: `apps/api/src/routes/oidc-boundary.test.ts:145-170`

**Interfaces:**
- Consumes: Tasks 8 and 9
- Produces: nothing

`oidc-boundary.test.ts:145` asserts the `invalid_client` behaviour **on purpose**, with a comment saying it is recorded "rather than discovered". Tasks 8 and 9 cross that boundary deliberately. This task replaces the pin rather than deleting it — the file's job is to state where the seam is, and the seam has moved, not vanished.

- [ ] **Step 1: Rewrite the test**

Replace the `cannot authenticate a client on those endpoints, and says so plainly` case with:

```ts
  it('authenticates a client on revocation and introspection, and nowhere else', async () => {
    // This replaces a test that pinned the opposite. The old boundary: Syntra
    // authenticates clients for `/token` and hands oidc-provider a placeholder
    // secret, so every other client-authenticated endpoint answered
    // `invalid_client` to a client presenting its real one.
    //
    // Revocation and introspection are now Syntra's too, registered in the
    // token plugin ahead of the catch-all. The seam has MOVED, not gone: any
    // other client-authenticated endpoint oidc-provider owns still cannot see
    // a real secret, and that is still correct.
    for (const path of ['/oidc/token/revocation', '/oidc/token/introspection']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: path,
        headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          token: 'nonsense', client_id: 'boundary', client_secret: boundarySecret,
        }).toString(),
      });
      expect(res.statusCode, path).toBe(200);
    }
  });

  it('still refuses a wrong secret on those endpoints', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token/revocation',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        token: 'nonsense', client_id: 'boundary', client_secret: 'not-the-secret',
      }).toString(),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_client');
  });
```

Leave the `lets a form-encoded POST reach the provider on the catch-all` test alone. It covers the catch-all, which still exists and still needs its parser.

- [ ] **Step 2: Run the whole OIDC suite**

Run: `pnpm vitest run apps/api/src/routes/oidc-`
Expected: PASS across boundary, token, grants, authorize and revocation.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/oidc-boundary.test.ts
git commit -m "test(oidc): the client-authentication seam moved, so move the pin"
```

---

## Phase 3 — Back-channel logout and the funnel

### Task 11: Schema for logout delivery

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`OidcClient` at :1357, plus a new model)
- Create: `packages/db/prisma/migrations/20260930000000_backchannel_logout/migration.sql`
- Modify: `packages/db/src/migration-order.ts`

**Interfaces:**
- Produces: `OidcClient.backchannelLogoutUri`, `OidcClient.backchannelLogoutSessionRequired`, and the `LogoutDelivery` model

- [ ] **Step 1: Extend the schema**

On `OidcClient`, after `postLogoutRedirectUris`:

```prisma
  /// Where a logout token is POSTed when a session this client's user holds
  /// ends. Null means this client is not told, which is the default and shows
  /// as such in the console.
  backchannelLogoutUri             String?
  /// Whether the logout token must carry `sid`. A client that asks for it and
  /// does not get it is required by spec to reject the token.
  backchannelLogoutSessionRequired Boolean @default(false)
```

And a new model:

```prisma
/// A logout token waiting to reach one relying party.
///
/// Its own table rather than a row in WebhookDelivery. An administrator
/// filters webhook deliveries by event group and configures endpoints per
/// integration; a logout token has neither, and sharing the table would put
/// rows on a screen whose every control is wrong for them. What IS shared is
/// the retry policy, imported from notify/webhook-retry.ts so the two cannot
/// drift.
model LogoutDelivery {
  id            String     @id @default(uuid()) @db.Uuid
  tenantId      String     @db.Uuid
  tenant        Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  clientId      String     @db.Uuid
  client        OidcClient @relation(fields: [clientId], references: [id], onDelete: Cascade)
  /// The signed token, frozen at enqueue. A retry an hour later sends what the
  /// logout said then, not what the rows say now.
  token         String
  attempts      Int        @default(0)
  nextAttemptAt DateTime
  deliveredAt   DateTime?
  lastStatus    Int?
  lastError     String?
  createdAt     DateTime   @default(now())

  @@index([tenantId])
  @@index([tenantId, deliveredAt, nextAttemptAt])
}
```

Add the matching `logoutDeliveries LogoutDelivery[]` back-relations on `Tenant` and `OidcClient`.

- [ ] **Step 2: Write the migration**

Create `packages/db/prisma/migrations/20260930000000_backchannel_logout/migration.sql`:

```sql
ALTER TABLE "OidcClient" ADD COLUMN "backchannelLogoutUri" TEXT;
ALTER TABLE "OidcClient" ADD COLUMN "backchannelLogoutSessionRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "LogoutDelivery" (
    "id"            UUID NOT NULL,
    "tenantId"      UUID NOT NULL,
    "clientId"      UUID NOT NULL,
    "token"         TEXT NOT NULL,
    "attempts"      INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt"   TIMESTAMP(3),
    "lastStatus"    INTEGER,
    "lastError"     TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogoutDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LogoutDelivery_tenantId_idx" ON "LogoutDelivery"("tenantId");
-- The sender's read: due, undelivered, this tenant. One indexed range scan.
CREATE INDEX "LogoutDelivery_due_idx"
  ON "LogoutDelivery"("tenantId", "deliveredAt", "nextAttemptAt");

ALTER TABLE "LogoutDelivery" ADD CONSTRAINT "LogoutDelivery_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LogoutDelivery" ADD CONSTRAINT "LogoutDelivery_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "OidcClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['LogoutDelivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
```

- [ ] **Step 3: Grandfather the directory**

Append `'20260930000000_backchannel_logout',` to `KNOWN_MIGRATIONS`.

- [ ] **Step 4: Apply, generate, and prove isolation**

Run:
```bash
pnpm db:migrate && pnpm db:generate
pnpm vitest run packages/db/src/migration-order.test.ts
```
Expected: PASS.

Then add the RLS assertion to whichever test file already holds the tenant-isolation cases — a `findMany` with no `where`, under one tenant, returning none of another tenant's `LogoutDelivery` rows. Copy the shape of the existing assertion; do not invent a new one.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma packages/db/src/migration-order.ts
git commit -m "feat(db): a relying party can be told a session ended"
```

---

### Task 12: Minting a logout token

**Files:**
- Create: `packages/core/src/access/logout-token.ts`
- Create: `packages/core/src/access/logout-token.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `loadActiveKey` from `../keys/signing-key-service.js`
- Produces:

```ts
export interface LogoutTokenInput {
  issuer: string;
  audience: string;   // the client_id
  subject: string;    // the end user
  sessionId: string | null;
  includeSid: boolean;
}
export function mintLogoutToken(input: LogoutTokenInput, key: ActiveKey): Promise<string>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { createLocalJWKSet, jwtVerify, decodeJwt } from 'jose';

describe('mintLogoutToken', () => {
  it('carries the events claim the spec defines', async () => {
    const token = await mintLogoutToken(input(), key);
    const claims = decodeJwt(token);
    expect(claims.events).toEqual({
      'http://schemas.openid.net/event/backchannel-logout': {},
    });
  });

  it('carries no nonce', async () => {
    // The spec FORBIDS it, and a conforming relying party must reject a logout
    // token that has one -- so including it would fail against exactly the
    // correct implementations.
    const token = await mintLogoutToken(input(), key);
    expect(decodeJwt(token)).not.toHaveProperty('nonce');
  });

  it('verifies against the published JWKS', async () => {
    const token = await mintLogoutToken(input(), key);
    const jwks = createLocalJWKSet({ keys: [publicJwkFor(key)] });
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'https://acme.test/oidc',
      audience: 'client-abc',
    });
    expect(payload.sub).toBe('user-1');
    expect(payload.jti).toEqual(expect.any(String));
  });

  it('includes sid only when the client asked for it', async () => {
    const withSid = await mintLogoutToken({ ...input(), includeSid: true }, key);
    expect(decodeJwt(withSid).sid).toBe('sess-1');
    const without = await mintLogoutToken({ ...input(), includeSid: false }, key);
    expect(decodeJwt(without)).not.toHaveProperty('sid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/access/logout-token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { randomUUID } from 'node:crypto';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import type { ActiveKey } from '../keys/signing-key-service.js';

const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export interface LogoutTokenInput {
  issuer: string;
  audience: string;
  subject: string;
  sessionId: string | null;
  includeSid: boolean;
}

/**
 * A logout token, signed with the tenant's active OIDC key.
 *
 * The same key the id tokens are signed with, so a relying party verifies this
 * against a JWKS it already fetches and rotates with everything else. A second
 * key for one message type would be a second rotation to get wrong.
 *
 * NO `nonce`. Section 2.4 of Back-Channel Logout 1.0 forbids it and requires a
 * conforming relying party to REJECT a logout token carrying one -- so adding
 * it would break delivery against precisely the implementations that read the
 * spec.
 */
export async function mintLogoutToken(
  input: LogoutTokenInput,
  key: ActiveKey,
): Promise<string> {
  const jwt = new SignJWT({
    events: { [BACKCHANNEL_EVENT]: {} },
    ...(input.includeSid && input.sessionId ? { sid: input.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'logout+jwt' })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setJti(randomUUID())
    // Short: a logout token is delivered or it is retried, and one that turns
    // up two hours later describes a session nobody is holding.
    .setExpirationTime('2m');

  return jwt.sign(createPrivateKey(key.privateKeyPem));
}
```

Match `ActiveKey`'s real property names — read `signing-key-service.ts:41` and use what is there rather than the names above if they differ.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/access/logout-token.test.ts`
Expected: PASS

- [ ] **Step 5: Export and commit**

Add `export * from './access/logout-token.js';` to `packages/core/src/index.ts`.

```bash
git add packages/core/src/access/logout-token.ts packages/core/src/access/logout-token.test.ts packages/core/src/index.ts
git commit -m "feat(core): mint a back-channel logout token"
```

---

### Task 13: Delivering it

**Files:**
- Create: `packages/core/src/access/logout-delivery.ts`
- Create: `packages/core/src/access/logout-delivery.test.ts`
- Create: `packages/core/src/access/logout-jobs.ts`
- Modify: `packages/core/src/index.ts`, `apps/api/src/scheduler.ts`

**Interfaces:**
- Consumes: `classifyStatus`, `RETRY_DELAYS_MS`, `WEBHOOK_MAX_ATTEMPTS` from `../notify/webhook-retry.js`; `guardedFetch` from `../net/guarded-fetch.js`; `mintLogoutToken`
- Produces:

```ts
export async function enqueueLogoutDeliveries(
  tx: TenantClient,
  input: { userId: string; sessionId: string | null; issuer: string },
): Promise<number>;
export async function runLogoutDeliveryJob(
  tenantId: string,
  options: { allowPrivateAddresses: boolean },
): Promise<{ delivered: number; failed: number }>;
export const LOGOUT_DELIVER_JOB = 'access.logout_deliver';
```

- [ ] **Step 1: Write the failing test**

Use a real HTTP server, in the style of the SFTP fixture — the point is that a signed token arrives and verifies, which a mock cannot show.

```ts
describe('logout delivery', () => {
  it('enqueues one delivery per client with a uri and a live grant', async () => {
    const { userId, tenantId } = await seedUserWithGrants([
      { clientId: 'a', backchannelLogoutUri: 'https://rp-a.test/logout' },
      { clientId: 'b', backchannelLogoutUri: null },  // not told
    ]);
    const count = await withTenant(tenantId, (tx) =>
      enqueueLogoutDeliveries(tx, { userId, sessionId: null, issuer: ISSUER }),
    );
    expect(count).toBe(1);
  });

  it('POSTs a verifiable token and marks the delivery done', async () => {
    const received: string[] = [];
    const server = await listen((req, body) => { received.push(body); return 200; });
    await seedClientWithUri(`${server.url}/logout`);
    await enqueue();

    await runLogoutDeliveryJob(tenantId, { allowPrivateAddresses: true });

    expect(received).toHaveLength(1);
    const params = new URLSearchParams(received[0]!);
    await jwtVerify(params.get('logout_token')!, jwks, { issuer: ISSUER, audience: clientId });
    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.deliveredAt).not.toBeNull();
  });

  it('retries a 500 on the ladder and does not retry a 400', async () => {
    const server = await listen(() => 500);
    await seedAndEnqueue(server.url);
    await runLogoutDeliveryJob(tenantId, { allowPrivateAddresses: true });
    let row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    const permanent = await listen(() => 400);
    await seedAndEnqueue(permanent.url);
    await runLogoutDeliveryJob(tenantId, { allowPrivateAddresses: true });
    row = await withTenant(tenantId, (tx) =>
      tx.logoutDelivery.findFirstOrThrow({ orderBy: { createdAt: 'desc' } }));
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);  // spent, not retried
  });

  it('refuses a uri pointing at a private address', async () => {
    await expect(
      runLogoutDeliveryJob(tenantId, { allowPrivateAddresses: false }),
    ).resolves.toMatchObject({ failed: 1 });
    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.lastError).toMatch(/private|refused/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/access/logout-delivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`logout-delivery.ts`:

- `enqueueLogoutDeliveries` finds every `OidcClient` in the tenant with a non-null `backchannelLogoutUri` that holds a live `OidcArtifact` grant for `userId`, mints a token per client via `mintLogoutToken` (`includeSid` from `backchannelLogoutSessionRequired`), and inserts a `LogoutDelivery` with `nextAttemptAt = now` so the first attempt needs no special case — the same choice `WebhookDelivery` documents.
- `runLogoutDeliveryJob` reads due rows (`deliveredAt: null`, `nextAttemptAt <= now`), POSTs `logout_token=<jwt>` as `application/x-www-form-urlencoded` through `guardedFetch({ allowPrivateAddresses })`, and classifies with `classifyStatus`:
  - `delivered` → set `deliveredAt`, `lastStatus`
  - `retry` → `attempts += 1`; if `attempts >= WEBHOOK_MAX_ATTEMPTS` stop, else `nextAttemptAt = now + RETRY_DELAYS_MS[attempts - 1]`
  - `permanent` → set `attempts = WEBHOOK_MAX_ATTEMPTS` and record `lastStatus`, so a spent row is spent whichever way it got there
- A transport error (which is what `guardedFetch` raises for a refused address or a redirect) records `lastError` and is treated as `retry`.

**Import the policy, do not restate it.** `classifyStatus` and `RETRY_DELAYS_MS` come from `../notify/webhook-retry.js`. A copied ladder is two ladders that will disagree.

`logout-jobs.ts` registers `LOGOUT_DELIVER_JOB` on the scheduler exactly as `registerWebhookJobs` (`packages/core/src/notify/webhook-jobs.ts:316`) registers its sender — copy that file's structure, including how it derives its schedule key.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/access/logout-delivery.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the scheduler**

Register the job in `apps/api/src/scheduler.ts` beside the webhook one, and confirm `pnpm vitest run apps/api/src/scheduler.test.ts` still passes — that file asserts which jobs are registered.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/access/logout-delivery.ts packages/core/src/access/logout-delivery.test.ts packages/core/src/access/logout-jobs.ts packages/core/src/index.ts apps/api/src/scheduler.ts
git commit -m "feat(core): deliver a logout token, and keep trying"
```

---

### Task 14: Configuring a relying party's logout endpoint

**Files:**
- Modify: `packages/contracts/src/protocol-admin.ts`
- Modify: `apps/api/src/routes/admin/protocol-apps.ts` + `.test.ts`
- Modify: `apps/api/src/routes/oidc-op.ts` (discovery)
- Modify: `apps/web/src/pages/admin/ApplicationSso.tsx`

**Interfaces:**
- Consumes: Task 11's columns
- Produces: the two fields on the OIDC client admin API and console form

- [ ] **Step 1: Write the failing test**

```ts
it('stores a back-channel logout uri', async () => {
  const res = await patchClient({ backchannelLogoutUri: 'https://rp.example/logout' });
  expect(res.statusCode).toBe(200);
  expect(res.json().backchannelLogoutUri).toBe('https://rp.example/logout');
});

it('refuses a uri that is not https', async () => {
  const res = await patchClient({ backchannelLogoutUri: 'http://rp.example/logout' });
  expect(res.statusCode).toBe(400);
});

it('refuses a uri aimed at a private address', async () => {
  // The same address check the webhook endpoints get. A logout uri is an
  // outbound request Syntra makes on somebody else's say-so.
  const res = await patchClient({ backchannelLogoutUri: 'https://127.0.0.1/logout' });
  expect(res.statusCode).toBe(400);
});

it('advertises back-channel logout in discovery', async () => {
  const res = await ctx.app.inject({
    method: 'GET', url: '/oidc/.well-known/openid-configuration',
    headers: { host: TEST_HOST },
  });
  expect(res.json()).toMatchObject({
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/protocol-apps.test.ts -t "logout uri"`
Expected: FAIL — the field is rejected as unknown by the Zod schema.

- [ ] **Step 3: Implement**

Add both fields to the OIDC client Zod schema in `packages/contracts/src/protocol-admin.ts`, validating the URI with the same address check the webhook endpoint schema uses — find it in the webhook contract and reuse it rather than writing a second validator.

Set `features.backchannelLogout = { enabled: true }` in the oidc-provider configuration in `oidc-op.ts` so discovery advertises it, and map `backchannelLogoutUri` / `backchannelLogoutSessionRequired` into the client metadata where `loadClients` builds it.

Add both to the SSO form in `ApplicationSso.tsx`, following the existing field layout. The URI field's helper text says where the token goes, not what back-channel logout is.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm vitest run apps/api/src/routes/admin/protocol-apps.test.ts
pnpm --filter @syntra/web test
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/protocol-admin.ts apps/api/src/routes/admin/protocol-apps.ts apps/api/src/routes/admin/protocol-apps.test.ts apps/api/src/routes/oidc-op.ts apps/web/src/pages/admin/ApplicationSso.tsx
git commit -m "feat(access): tell an application where to hear about a logout"
```

---

### Task 15: The funnel

**Files:**
- Create: `packages/core/src/auth/end-sessions.ts`
- Create: `packages/core/src/auth/end-sessions.test.ts`
- Modify: `packages/core/src/auth/session-service.ts` (stop exporting two functions)
- Modify: `packages/core/src/auth/password-change.ts:141,436`, `password-renewal.ts:99`, `password-reset.ts:527`, `directory/directory-writeback.ts:377`, `directory/user-service.ts:102`, `sync/apply.ts:238`
- Modify: `apps/api/src/routes/admin/sessions.ts`, `apps/api/src/routes/portal.ts`, `apps/api/src/routes/auth.ts:468`

**Interfaces:**
- Consumes: `enqueueLogoutDeliveries`, `revokeAllRefreshTokensForUser`, `revokeAllForUser`, `revokeAllForUserExcept`, `revokeSessionById`
- Produces:

```ts
export type RevocationTrigger =
  | 'admin' | 'self' | 'logout'
  | 'password_reset' | 'password_change' | 'deactivation';

export interface EndSessionsOptions {
  trigger: RevocationTrigger;
  actorUserId: string | null;
  sourceIp: string | null;
  issuer: string;
  exceptSessionId?: string;
  onlySessionId?: string;
}

export async function endSessions(
  tx: TenantClient,
  userId: string,
  options: EndSessionsOptions,
): Promise<{ sessionsRevoked: number; logoutsEnqueued: number }>;
```

- [ ] **Step 1: Write the failing test**

```ts
describe('endSessions', () => {
  it('revokes sessions, revokes refresh tokens, and enqueues logouts', async () => {
    const { userId, tenantId } = await seedUserWithSessionsAndGrant();
    const result = await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, { trigger: 'admin', actorUserId: 'a', sourceIp: null, issuer: ISSUER }),
    );
    expect(result).toEqual({ sessionsRevoked: 2, logoutsEnqueued: 1 });

    await withTenant(tenantId, async (tx) => {
      expect(await listSessionsForUser(tx, userId)).toEqual([]);
      expect(await tx.oidcArtifact.count({ where: { revokedAt: null } })).toBe(0);
      expect(await tx.logoutDelivery.count()).toBe(1);
    });
  });

  it('spares the session a password change is being made from', async () => {
    const { userId, tenantId, keep } = await seedUserWithSessionsAndGrant();
    await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, {
        trigger: 'password_change', actorUserId: userId, sourceIp: null,
        issuer: ISSUER, exceptSessionId: keep,
      }),
    );
    await withTenant(tenantId, async (tx) => {
      const left = await listSessionsForUser(tx, userId);
      expect(left.map((s) => s.id)).toEqual([keep]);
    });
  });

  it('records one audit event naming the trigger', async () => {
    const { userId, tenantId } = await seedUserWithSessionsAndGrant();
    await withTenant(tenantId, (tx) =>
      endSessions(tx, userId, {
        trigger: 'deactivation', actorUserId: 'a', sourceIp: null, issuer: ISSUER,
      }),
    );
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'session.revoked' } }));
    expect((event.payload as Record<string, unknown>).trigger).toBe('deactivation');
  });
});

describe('every caller propagates', () => {
  // These are written against the CALLERS, not against endSessions. The defect
  // this guards was never in the function -- it was in who called it.
  it.each([
    ['a completed password reset', completeReset],
    ['a self-service password change', changePassword],
    ['a deactivation', deactivate],
    ['signing out', signOut],
  ])('%s enqueues a logout token', async (_name, act) => {
    const { tenantId } = await seedUserWithSessionsAndGrant();
    await act();
    const count = await withTenant(tenantId, (tx) => tx.logoutDelivery.count());
    expect(count).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/auth/end-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the funnel**

`end-sessions.ts` does, in the caller's transaction and in this order:

1. Revoke sessions — `revokeSessionById` when `onlySessionId` is set, `revokeAllForUserExcept` when `exceptSessionId` is, otherwise `revokeAllForUser`.
2. `revokeAllRefreshTokensForUser(tx, userId)`.
3. `enqueueLogoutDeliveries(tx, { userId, sessionId: options.onlySessionId ?? null, issuer })`.
4. `recordEvent` with `action: 'session.revoked'` and a payload carrying `trigger`, `count` and `logoutsEnqueued`.

All four inside the one transaction. A revocation that failed to enqueue is the same defect as a reset that failed to revoke, and `refresh-token.ts` already documents that one having happened.

- [ ] **Step 4: Migrate every caller**

Replace the call at each of these sites with `endSessions`, passing the right trigger:

| Site | Trigger | Notes |
|---|---|---|
| `password-reset.ts:527` | `password_reset` | |
| `password-change.ts:141` | `password_change` | keeps `exceptSessionId` |
| `password-change.ts:436` | `password_reset` | admin-set password; nothing is spared |
| `password-renewal.ts:99` | `password_change` | |
| `directory/user-service.ts:102` | `deactivation` | |
| `directory/directory-writeback.ts:377` | `deactivation` | |
| `sync/apply.ts:238` | `deactivation` | |
| `admin/sessions.ts` (both writes) | `admin` | replaces the direct calls from Task 4 |
| `portal.ts` delete | `self` | |
| `auth.ts:468` (sign-out) | `logout` | `onlySessionId` — this session only |

`auth.ts:468` is the widening the spec calls out: signing out propagates. It uses `onlySessionId` so it ends one session, not all of them, but the relying parties that session reached are told.

- [ ] **Step 5: Un-export the old functions**

In `session-service.ts`, remove `export` from `revokeAllForUser` and `revokeAllForUserExcept`, and import them into `end-sessions.ts` directly. Leave `revokeSession(tx, token)` exported — ending one session by its token is a different act, still used by the SAML and OIDC logout routes.

```bash
pnpm typecheck
```
Anything that still calls them fails to compile, and that is the check: the migration is complete when `tsc -b` is clean. **Do not re-export them to make an error go away** — that is the whole mechanism.

- [ ] **Step 6: Run the full suite**

Run:
```bash
pnpm vitest run
pnpm typecheck
```
Expected: PASS, clean. Existing tests asserting `sessionsRevoked` counts should still pass; if one now sees a different count, read it before changing it — the count changing is a real behaviour change worth understanding.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/auth apps/api/src/routes packages/core/src/directory packages/core/src/sync
git commit -m "feat(core): one way to end sessions, and no way to end them quietly"
```

---

### Task 16: Documentation

**Files:**
- Modify: `docs/configure.md:479`, `:493`, `:518`
- Modify: `docs/operate.md`
- Modify: `README.md`

- [ ] **Step 1: Rewrite the three passages**

- `:479` — keep the trade (a policy change does not reach live sessions) and replace "revoke the sessions as well" with the actual route: the Sessions tab on the account, or `POST /api/admin/users/:id/sessions/revoke`.
- `:518` — delete the 415 description entirely; it describes a bug fixed before this work. Replace with what is true: both endpoints authenticate against Syntra's stored hash, revocation answers 200 unconditionally, introspection describes only the calling client's own tokens.
- `:493` — rewrite the single-logout paragraph so it says OIDC relying parties with a `backchannelLogoutUri` are now told, **and keeps saying that SAML service providers are not**. An offboarding procedure still cannot rely on SAML SLO, and removing that sentence would be the most damaging edit in this task.

- [ ] **Step 2: Document the new personal data**

In `docs/operate.md`, next to the deactivate-never-delete section: `Session.ip` and `Session.userAgent`, what they are for, that they age out with the session row rather than on a separate retention schedule, and that revoking a session marks it revoked rather than deleting it.

- [ ] **Step 3: Update the module table**

In `README.md`, the **Access** row gains session inventory and revocation, working token revocation and introspection, and OIDC back-channel logout. Keep the link to "what it does not do" — that page still has plenty on it.

- [ ] **Step 4: Verify the claims**

Re-read each rewritten paragraph against the code. A docs commit asserting behaviour nobody checked is how `:518` came to describe a cured symptom for weeks.

- [ ] **Step 5: Commit**

```bash
git add docs/configure.md docs/operate.md README.md
git commit -m "docs: access can now be made to stop, so say how"
```

---

## Self-Review

**Spec coverage.** Every section maps to tasks: session schema and origin → 1–2; core list/revoke → 3; admin and portal APIs → 4–5; console → 6–7; client authentication → 8–10 (including the pin replacement the spec calls out); registration, token, delivery → 11–14; the funnel and caller migration → 15; the three documentation rewrites → 16. The spec's "Not in this document" items (SAML SLO in any binding, policy re-evaluation, Syntra's own empty `RefreshToken` table) have no tasks, correctly.

**Type consistency.** `SessionOrigin`, `SessionSummary`, `listSessionsForUser`, `revokeSessionById`, `mintLogoutToken`, `enqueueLogoutDeliveries`, `runLogoutDeliveryJob`, `LOGOUT_DELIVER_JOB`, `endSessions`, `RevocationTrigger` and `EndSessionsOptions` are declared once in an Interfaces block and used with the same names and arities everywhere after. `createSession` is three-argument from Task 2 onward, including in every later test snippet.

**Known soft spots for the implementer.** Three places where this plan says what to do but the repository has the final say, and the plan defers to it: `ActiveKey`'s property names in Task 12; the exact helper names for client authentication and body reading in `oidc-token.ts` in Task 8; and whether `request.session` already carries `sessionId` in Task 5. Read the file first in each case.
