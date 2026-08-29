# Watching Syntra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the things Syntra records visible — security events reaching webhook endpoints, and a Prometheus endpoint for the queues, keys and backlogs that currently fail silently.

**Architecture:** Both halves hang off `recordEvent`, the funnel every security-relevant act already goes through. Part 1 adds three event groups and a fan-out inside `recordEvent` that enqueues a fixed projection of the event — never the audit payload. Part 2 adds a token-gated `/metrics` route with process metrics, an HTTP histogram, database-derived gauges behind a ten-second cache, and counters incremented by the same hook.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, Prisma 6 / PostgreSQL, `prom-client`, Zod contracts, Vitest against a real database, React 19 for the console.

**Spec:** `docs/superpowers/specs/2026-08-29-watching-syntra-design.md`

## Global Constraints

- **Node 22+, pnpm 9.12.0.**
- **`pnpm typecheck` (`tsc -b`) must stay clean.** `exactOptionalPropertyTypes` is on; there is no linter.
- **Tests run against a real PostgreSQL** (`pnpm db:up` first). Never run concurrent suites; never `docker compose down`.
- **The webhook body carries the projection only** — `action`, `outcome`, `occurredAt`, `sequence`, `actorUserId`, `targetType`, `targetId`. Never `payload`, never `sourceIp`. This is the security property of part 1.
- **No metric label may contain a tenant id, a tenant slug, or a uuid taken from a URL.** This is the security property of part 2.
- **`METRICS_TOKEN` unset means the route does not exist** — 404, not 403.
- Imports are extensionful ESM (`./webhook-event.js`).

## File Structure

**Part 1 — security events**
- Modify `packages/core/src/notify/webhook-event.ts` — three groups
- Create `packages/core/src/notify/security-events.ts` + test — the allowlist and the projection
- Modify `packages/core/src/audit/audit-service.ts` — the fan-out
- Modify `packages/contracts/src/webhook.ts` — allow dots in a selector
- Modify `apps/web/src/pages/admin/WebhooksTab.tsx` — the three new choices

**Part 2 — metrics**
- Modify `packages/core/src/config.ts` — `METRICS_TOKEN`
- Create `packages/core/src/health/metrics.ts` + test — gauges, cache, registry
- Create `apps/api/src/routes/metrics.ts` + test — the route and its token
- Modify `apps/api/src/app.ts` — register it, exclude from request logging

The allowlist lives in its own file rather than in `audit-service.ts` because it is a policy list that will be edited whenever an event is added, and `audit-service.ts` is the tamper-evident chain — a file people should have no routine reason to open.

---

## Part 1 — Security events on the wire

### Task 1: Three event groups

**Files:**
- Modify: `packages/core/src/notify/webhook-event.ts:15`
- Test: `packages/core/src/notify/webhook-event.test.ts`

**Interfaces:**
- Produces: `WEBHOOK_EVENT_GROUPS` gains `sign-in-security`, `credentials`, `configuration`; `WebhookEventGroup` widens to include them.

- [ ] **Step 1: Write the failing test**

```ts
describe('security groups', () => {
  it('matches a lockout for a sign-in-security subscriber', () => {
    expect(eventMatches(['sign-in-security'], 'auth.lockout')).toBe(true);
  });

  it('does not deliver security events to an Automate subscriber', () => {
    // The groups are how somebody says what they want. A ticketing system
    // subscribed to access requests must not start receiving lockouts.
    expect(eventMatches(['access-requests'], 'auth.lockout')).toBe(false);
    expect(eventMatches(['sign-in-security'], 'automate-approved')).toBe(false);
  });

  it('has no action in two groups', () => {
    // An action in two groups delivers twice to an endpoint subscribed to
    // both, and a receiver cannot tell that from a genuine duplicate.
    const seen = new Set<string>();
    for (const group of Object.values(WEBHOOK_EVENT_GROUPS)) {
      for (const template of group.templates) {
        expect(seen.has(template), template).toBe(false);
        seen.add(template);
      }
    }
  });

  it('does not carry auth.login in any group', () => {
    // Deliberate: it fires on success too, and a thousand-user tenant would
    // deliver a thousand webhooks on a Monday morning. auth.lockout is the
    // aggregated signal. See the design document.
    for (const group of Object.values(WEBHOOK_EVENT_GROUPS)) {
      expect(group.templates as readonly string[]).not.toContain('auth.login');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/notify/webhook-event.test.ts -t "security groups"`
Expected: FAIL — `eventMatches(['sign-in-security'], …)` is false because the group does not exist.

- [ ] **Step 3: Add the groups**

In `WEBHOOK_EVENT_GROUPS`, after `findings`, add the three groups exactly as the design document lists them, each with a `label` and a `description` in the same voice as the existing six. Keep `templates` arrays in the order the design document gives.

The key names are `'sign-in-security'`, `'credentials'`, `'configuration'`.

Add a comment above them recording that these entries are AUDIT ACTION names rather than notification template names, that `eventMatches` does not care because it is string matching, and that the `event` on a delivery is therefore the audit action.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/notify/webhook-event.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/notify/webhook-event.ts packages/core/src/notify/webhook-event.test.ts
git commit -m "feat(notify): three groups for the events security depends on"
```

---

### Task 2: The allowlist and the projection

**Files:**
- Create: `packages/core/src/notify/security-events.ts`
- Create: `packages/core/src/notify/security-events.test.ts`

**Interfaces:**
- Consumes: `WEBHOOK_EVENT_GROUPS`
- Produces:

```ts
export function isSecurityEvent(action: string): boolean;
export interface SecurityEventProjection {
  action: string;
  outcome: 'success' | 'failure';
  occurredAt: string;
  sequence: number;
  actorUserId: string | null;
  targetType: string;
  targetId: string | null;
}
export function securityProjection(input: {
  action: string; outcome: 'success' | 'failure'; occurredAt: Date;
  sequence: number; actorUserId: string | null;
  targetType: string; targetId: string | null;
}): SecurityEventProjection;
```

- [ ] **Step 1: Write the failing test**

```ts
describe('isSecurityEvent', () => {
  it('is true for every action in the three security groups', () => {
    expect(isSecurityEvent('auth.lockout')).toBe(true);
    expect(isSecurityEvent('mfa.removed')).toBe(true);
    expect(isSecurityEvent('policy.rule_added')).toBe(true);
  });

  it('is false for ordinary traffic', () => {
    expect(isSecurityEvent('application.launch')).toBe(false);
    expect(isSecurityEvent('auth.login')).toBe(false);
  });

  it('is derived from the groups, not a second list', () => {
    // Two lists would disagree the first time somebody added an action to a
    // group and not to the allowlist -- a subscription that matches an event
    // nothing ever fans out.
    for (const key of ['sign-in-security', 'credentials', 'configuration'] as const) {
      for (const action of WEBHOOK_EVENT_GROUPS[key].templates) {
        expect(isSecurityEvent(action), action).toBe(true);
      }
    }
  });
});

describe('securityProjection', () => {
  it('carries exactly the seven fields and no others', () => {
    // The whole security property of this feature. An audit payload is
    // written for an authenticated console reader; this goes to a URL an
    // administrator typed.
    const projection = securityProjection({
      action: 'auth.lockout', outcome: 'failure', occurredAt: new Date(),
      sequence: 41, actorUserId: null, targetType: 'User', targetId: 'u-1',
    });
    expect(Object.keys(projection).sort()).toEqual([
      'action', 'actorUserId', 'occurredAt', 'outcome',
      'sequence', 'targetId', 'targetType',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/notify/security-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { WEBHOOK_EVENT_GROUPS } from './webhook-event.js';

/**
 * The security groups, named once.
 *
 * Derived FROM the groups rather than restated beside them. Two lists would
 * disagree the first time somebody added an action to a group and forgot the
 * allowlist -- and the symptom would be a subscription that matches an event
 * nothing ever fans out, which looks exactly like a broken receiver.
 */
const SECURITY_GROUPS = ['sign-in-security', 'credentials', 'configuration'] as const;

const SECURITY_ACTIONS: ReadonlySet<string> = new Set(
  SECURITY_GROUPS.flatMap((key) => [...WEBHOOK_EVENT_GROUPS[key].templates]),
);

export function isSecurityEvent(action: string): boolean {
  return SECURITY_ACTIONS.has(action);
}
```

Then `SecurityEventProjection` and `securityProjection`, with a docstring stating that the field list is a closed set, that `payload` and `sourceIp` are excluded deliberately, and that adding a field is a decision to disclose it to every configured endpoint. `occurredAt` is `.toISOString()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/notify/security-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/notify/security-events.ts packages/core/src/notify/security-events.test.ts
git commit -m "feat(notify): what a security event looks like on the wire"
```

---

### Task 3: The fan-out in recordEvent

**Files:**
- Modify: `packages/core/src/audit/audit-service.ts:111`
- Test: `packages/core/src/audit/audit-service.test.ts`

**Interfaces:**
- Consumes: `isSecurityEvent`, `securityProjection`, `enqueueWebhooks`
- Produces: no new export; `recordEvent` keeps its signature

- [ ] **Step 1: Write the failing test**

```ts
describe('security fan-out', () => {
  it('enqueues a delivery for a subscribed endpoint', async () => {
    await seedEndpoint(['sign-in-security']);
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null, action: 'auth.lockout', targetType: 'User',
        targetId: userId, outcome: 'failure', sourceIp: '198.51.100.9',
        payload: { secretish: 'do-not-forward-me' },
      }),
    );
    const rows = await withTenant(tenantId, (tx) => tx.webhookDelivery.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe('auth.lockout');
  });

  it('never puts the audit payload or the address on the wire', async () => {
    // The security property, asserted over the delivery body rather than by
    // reading the projection -- what matters is what leaves the building.
    await seedEndpoint(['sign-in-security']);
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null, action: 'auth.lockout', targetType: 'User',
        targetId: userId, outcome: 'failure', sourceIp: '198.51.100.9',
        payload: { secretish: 'do-not-forward-me' },
      }),
    );
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    const body = JSON.stringify(row.payload);
    expect(body).not.toContain('do-not-forward-me');
    expect(body).not.toContain('198.51.100.9');
    expect(body).toContain('auth.lockout');
  });

  it('does not fan out an ordinary event', async () => {
    await seedEndpoint(['sign-in-security']);
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: userId, action: 'application.launch', targetType: 'Application',
        targetId: appId, outcome: 'success', sourceIp: null, payload: {},
      }),
    );
    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('carries the sequence the audit row got', async () => {
    await seedEndpoint(['sign-in-security']);
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, { /* auth.lockout as above */ } as never),
    );
    const event = await withTenant(tenantId, (tx) => tx.auditEvent.findFirstOrThrow());
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(JSON.stringify(row.payload)).toContain(`"sequence":${event.sequence}`);
  });

  it('costs a tenant with no endpoints nothing it can observe', async () => {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, { /* auth.lockout */ } as never),
    );
    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/audit/audit-service.test.ts -t "security fan-out"`
Expected: FAIL — no deliveries are written.

- [ ] **Step 3: Implement**

At the end of `recordEvent`, after the audit row is created and inside the same transaction:

```ts
  // The fan-out. AFTER the row, because the projection carries the sequence
  // and the sequence does not exist until it is written; INSIDE the
  // transaction, because an event that was audited and not announced -- or
  // announced and not audited -- is two records disagreeing about one thing
  // that happened.
  //
  // Here rather than at the twenty-odd security `recordEvent` call sites,
  // because a fan-out a caller has to remember is a fan-out a caller will
  // forget. `refresh-token.ts` is the docstring of the last time that was
  // learned here.
  if (isSecurityEvent(input.action)) {
    await enqueueWebhooks(tx, [
      {
        event: input.action,
        requestId: null,
        // A security event is not addressed to anybody. The Automate events
        // carry recipients because a person was mailed; nobody was mailed
        // here.
        recipients: [],
        data: securityProjection({
          action: input.action,
          outcome: input.outcome,
          occurredAt,
          sequence,
          actorUserId: input.actorUserId,
          targetType: input.targetType,
          targetId: input.targetId,
        }) as unknown as Record<string, unknown>,
      },
    ], occurredAt);
  }
```

**Watch the import direction.** `webhook-service.ts` documents that it must not import from `automate/notify.ts` because that module imports it. `audit-service.ts` importing `webhook-service.ts` is a new edge — check with `pnpm typecheck` that it does not close a cycle, and if it does, move `enqueueWebhooks` behind a dynamic import rather than restructuring the notify package.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm vitest run packages/core/src/audit/audit-service.test.ts
pnpm typecheck
```
Expected: PASS, clean.

- [ ] **Step 5: Run the broader suite for fallout**

Run: `pnpm vitest run packages/core/src apps/api/src`
Expected: PASS. Any test that counted `webhookDelivery` rows and now sees more is a real behaviour change — read it before changing it.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/audit/audit-service.ts packages/core/src/audit/audit-service.test.ts
git commit -m "feat(audit): a security event reaches the endpoints that asked"
```

---

### Task 4: Subscribing to one, and the console

**Files:**
- Modify: `packages/contracts/src/webhook.ts:30`
- Modify: `apps/web/src/pages/admin/WebhooksTab.tsx:37`
- Test: `apps/api/src/routes/admin/webhooks.test.ts`, `apps/web/src/pages/admin/WebhooksTab.test.tsx`

**Interfaces:**
- Produces: `eventSelector` accepting dotted names; three new console choices

- [ ] **Step 1: Write the failing test**

In `webhooks.test.ts`:

```ts
it('accepts a security group and an exact audit action', async () => {
  // The contract's own docstring promises an exact name works. The regex
  // forbade dots, and every audit action has one -- so "finer control than
  // the six groups offer" was unreachable for exactly the events that most
  // want it.
  const res = await post('/api/admin/webhooks', cookie, {
    name: 'SIEM', url: 'https://siem.example/in',
    events: ['sign-in-security', 'auth.lockout', 'policy.*'],
  });
  expect(res.statusCode).toBe(201);
});

it('still refuses a selector that is not a name', async () => {
  const res = await post('/api/admin/webhooks', cookie, {
    name: 'Bad', url: 'https://siem.example/in', events: ['Auth Lockout'],
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/webhooks.test.ts -t "exact audit action"`
Expected: FAIL — 400, because the regex has no `.`.

- [ ] **Step 3: Widen the selector**

In `packages/contracts/src/webhook.ts`, change the regex to `/^[a-z][a-z0-9.-]*\*?$/` and extend the comment: dots are allowed because every audit action carries one, and the docstring above already promises an exact name is accepted. The narrowness that matters — no spaces, no uppercase, no leading punctuation — is unchanged.

- [ ] **Step 4: Add the console choices**

In `WebhooksTab.tsx`, append to `GROUPS`:

```tsx
  { key: 'sign-in-security', label: 'Sign-in security' },
  { key: 'credentials', label: 'Credentials' },
  { key: 'configuration', label: 'Configuration changes' },
```

Labels only. The file's docstring records that captions were removed because every one restated its label; do not add descriptions back.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm vitest run apps/api/src/routes/admin/webhooks.test.ts
pnpm --filter @syntra/web test -- WebhooksTab
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/webhook.ts apps/web/src/pages/admin/WebhooksTab.tsx apps/api/src/routes/admin/webhooks.test.ts
git commit -m "feat(console): subscribe to the security groups, or to one action"
```

---

## Part 2 — Metrics

### Task 5: The token, and a route that is absent without it

**Files:**
- Modify: `packages/core/src/config.ts:135`
- Create: `apps/api/src/routes/metrics.ts`
- Create: `apps/api/src/routes/metrics.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.metricsToken: string | null`; `registerMetricsRoutes(app, options)`

- [ ] **Step 1: Add the config**

In the Zod schema beside `RELEASE_TOKEN`:

```ts
  /**
   * The bearer token a scraper presents at `/metrics`.
   *
   * Optional, and its absence is the OFF SWITCH: with no token the route is
   * never registered, so an installation that never opted in answers 404 like
   * any other path that does not exist. A route that answered 403 would be a
   * route whose existence -- and therefore this deployment's shape -- is
   * discoverable by anybody.
   */
  METRICS_TOKEN: z.string().trim().min(16).optional(),
```

`min(16)`, because a token short enough to guess is worse than no metrics. Add `metricsToken: string | null` to the config interface and `v.METRICS_TOKEN ?? null` to the object, following `releaseToken` exactly. Document it in `.env.example` in the voice the neighbouring entries use.

- [ ] **Step 2: Write the failing test**

```ts
describe('/metrics', () => {
  it('does not exist when no token is configured', async () => {
    const ctx = await buildTestApp({ metricsToken: null });
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics', headers: { host: ctx.host } });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a wrong token', async () => {
    const ctx = await buildTestApp({ metricsToken: TOKEN });
    const res = await ctx.app.inject({
      method: 'GET', url: '/metrics',
      headers: { host: ctx.host, authorization: 'Bearer not-the-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a caller with no credential', async () => {
    const ctx = await buildTestApp({ metricsToken: TOKEN });
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics', headers: { host: ctx.host } });
    expect(res.statusCode).toBe(401);
  });

  it('serves Prometheus text exposition to the right token', async () => {
    const ctx = await buildTestApp({ metricsToken: TOKEN });
    const res = await ctx.app.inject({
      method: 'GET', url: '/metrics',
      headers: { host: ctx.host, authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toMatch(/^# HELP /m);
    expect(res.body).toContain('syntra_build_info');
  });
});
```

`buildTestApp` needs to accept a `metricsToken` override — add it the way its existing overrides are added; read `apps/api/src/test-support.ts` first.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/metrics.test.ts`
Expected: FAIL — 404 on every case.

- [ ] **Step 4: Add the dependency and implement**

```bash
pnpm --filter @syntra/api add prom-client
```

`metrics.ts`:

- `registerMetricsRoutes(app, { token })` returns immediately when `token` is null — **registering nothing**, which is what makes the 404 true.
- A `Registry` with `collectDefaultMetrics({ register })` for process and runtime metrics.
- `syntra_build_info` as a Gauge labelled `version`, set to 1 from `buildInfo().version`.
- The handler compares the presented token with `timingSafeEqual` over equal-length buffers, answering 401 with no body detail for absent, malformed and wrong alike.
- Route config: `rateLimit: { max: 60, timeWindow: '1 minute' }`, matching `/health/ready`.

In `app.ts`, register it and extend the existing `disableRequestLogging` predicate to cover `/metrics` — a scrape every fifteen seconds does not belong in the journal.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/metrics.test.ts && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts apps/api/src/routes/metrics.ts apps/api/src/routes/metrics.test.ts apps/api/src/app.ts apps/api/package.json pnpm-lock.yaml .env.example
git commit -m "feat(api): a metrics endpoint that does not exist until you ask for one"
```

---

### Task 6: HTTP timings, without leaking a URL

**Files:**
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `apps/api/src/routes/metrics.test.ts`

**Interfaces:**
- Produces: `syntra_http_request_duration_seconds`

- [ ] **Step 1: Write the failing test**

```ts
it('labels timings by route pattern, never by URL', async () => {
  // THE property. `request.url` would put user ids and tenant hostnames into
  // label values -- unbounded cardinality and a disclosure in one move.
  const ctx = await buildTestApp({ metricsToken: TOKEN });
  await ctx.app.inject({
    method: 'GET', url: '/api/admin/users/11111111-2222-4333-8444-555555555555/sessions',
    headers: { host: ctx.host },
  });

  const body = (await scrape(ctx)).body;
  expect(body).toContain('syntra_http_request_duration_seconds');
  expect(body).not.toContain('11111111-2222-4333-8444-555555555555');
});

it('puts no tenant hostname in any label', async () => {
  const ctx = await buildTestApp({ metricsToken: TOKEN });
  await ctx.app.inject({ method: 'GET', url: '/api/portal/applications', headers: { host: ctx.host } });
  expect((await scrape(ctx)).body).not.toContain(ctx.host);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/metrics.test.ts -t "route pattern"`
Expected: FAIL — the metric does not exist.

- [ ] **Step 3: Implement**

A `Histogram` named `syntra_http_request_duration_seconds`, labels `method`, `route`, `status`, buckets `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.

Observed in an `onResponse` hook. **`route` comes from `request.routeOptions.url`** — Fastify's registered pattern, `/api/admin/users/:id/sessions` — and falls back to the literal string `'unrouted'` when there is none, never to `request.url`. Put that reason in a comment: a 404 for a scanned path would otherwise mint a label per probe and hand an attacker a way to grow the series set without limit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/metrics.ts apps/api/src/routes/metrics.test.ts
git commit -m "feat(api): request timings, labelled by route and not by URL"
```

---

### Task 7: The gauges, and the cache in front of them

**Files:**
- Create: `packages/core/src/health/metrics.ts`
- Create: `packages/core/src/health/metrics.test.ts`
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface MetricsSnapshot {
  webhookDeliveriesPending: number;
  webhookDeliveriesAbandoned: number;
  logoutDeliveriesPending: number;
  logoutDeliveriesAbandoned: number;
  sessionsActive: number;
  usersActive: number;
  usersInactive: number;
  accountsLocked: number;
  jobsPending: number;
  signingKeyExpiresInSeconds: number | null;
}
export async function collectMetrics(now?: Date): Promise<MetricsSnapshot>;
export function cachedMetrics(ttlMs?: number): () => Promise<MetricsSnapshot>;
```

`collectMetrics` is installation-wide and therefore reads with `prisma`, not `withTenant`. Say so in its docstring, and say why: a per-tenant series would let a scrape enumerate customers, and the reads here are counts with no rows returned.

- [ ] **Step 1: Write the failing test**

```ts
describe('collectMetrics', () => {
  it('counts backlogs across the installation', async () => {
    await seedPendingWebhookDeliveries(3);
    await seedSpentLogoutDelivery();
    const snapshot = await collectMetrics();
    expect(snapshot.webhookDeliveriesPending).toBe(3);
    expect(snapshot.logoutDeliveriesAbandoned).toBe(1);
  });

  it('reports the nearest signing key expiry', async () => {
    await ensureActiveKey(tenantId, provider, 'oidc');
    const snapshot = await collectMetrics();
    expect(snapshot.signingKeyExpiresInSeconds).toBeGreaterThan(0);
  });

  it('reports null when there is no key rather than zero', async () => {
    // Zero would read as "expires now" on a dashboard and page somebody at
    // three in the morning for a tenant that has issued no tokens.
    expect((await collectMetrics()).signingKeyExpiresInSeconds).toBeNull();
  });

  it('counts across tenants, because the series is installation-wide', async () => {
    await seedSessionsIn(tenantA, 2);
    await seedSessionsIn(tenantB, 3);
    expect((await collectMetrics()).sessionsActive).toBe(5);
  });
});

describe('cachedMetrics', () => {
  it('does not re-read inside the window', async () => {
    const read = cachedMetrics(10_000);
    const first = await read();
    await seedPendingWebhookDeliveries(5);
    expect((await read()).webhookDeliveriesPending).toBe(first.webhookDeliveriesPending);
  });

  it('re-reads once the window has passed', async () => {
    const read = cachedMetrics(0);
    await read();
    await seedPendingWebhookDeliveries(5);
    expect((await read()).webhookDeliveriesPending).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/health/metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Every field is one `count` over an indexed predicate:

- pending: `deliveredAt: null, attempts: { lt: WEBHOOK_MAX_ATTEMPTS }`
- abandoned: `deliveredAt: null, attempts: { gte: WEBHOOK_MAX_ATTEMPTS }`
- `sessionsActive`: `revokedAt: null, absoluteExpiresAt: { gt: now }`
- `accountsLocked`: the lockout table, `lockedUntil: null` or `> now`, matching `isLocked` in `login-lockout.ts` — read it and reuse the predicate rather than restating it
- `jobsPending`: pg-boss keeps its queue in the same database; count its job table where state is `created` or `retry`. If that table is not reachable through Prisma, use `$queryRaw` and say in a comment that the schema belongs to pg-boss and this is a read of somebody else's table.
- `signingKeyExpiresInSeconds`: the minimum `notAfter` across active keys, minus now, floored at 0; `null` when there are none.

`cachedMetrics(ttlMs = 10_000)` returns a closure holding the last snapshot and its timestamp, and **shares one in-flight promise** so a burst of scrapes issues one set of queries rather than one per request.

- [ ] **Step 4: Wire the gauges**

In `metrics.ts`, one `Gauge` per field, set from the snapshot inside the registry's collect hook — or set immediately before rendering, which is simpler and equivalent for a single handler. `syntra_users_total` is one gauge labelled `status` with `active` and `inactive`.

Add `syntra_readiness` from the existing `readiness()` report, 1 or 0.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm vitest run packages/core/src/health/metrics.test.ts apps/api/src/routes/metrics.test.ts
pnpm typecheck
```
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/health/metrics.ts packages/core/src/health/metrics.test.ts packages/core/src/index.ts apps/api/src/routes/metrics.ts
git commit -m "feat(core): the backlogs and the key expiry, as numbers"
```

---

### Task 8: Counting the security events

**Files:**
- Modify: `packages/core/src/health/metrics.ts`
- Modify: `packages/core/src/audit/audit-service.ts`
- Modify: `apps/api/src/routes/metrics.test.ts`

**Interfaces:**
- Produces: `countSecurityEvent(action: string, outcome: string): void`, and `syntra_audit_events_total`

- [ ] **Step 1: Write the failing test**

```ts
it('counts security events by action and outcome', async () => {
  const ctx = await buildTestApp({ metricsToken: TOKEN });
  await withTenant(ctx.tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId: null, action: 'auth.lockout', targetType: 'User',
      targetId: userId, outcome: 'failure', sourceIp: null, payload: {},
    }),
  );

  const body = (await scrape(ctx)).body;
  expect(body).toContain('syntra_audit_events_total');
  expect(body).toMatch(/syntra_audit_events_total\{[^}]*action="auth\.lockout"/);
});

it('does not count ordinary traffic, so the label set stays bounded', async () => {
  const ctx = await buildTestApp({ metricsToken: TOKEN });
  await withTenant(ctx.tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId: userId, action: 'application.launch', targetType: 'Application',
      targetId: appId, outcome: 'success', sourceIp: null, payload: {},
    }),
  );
  expect((await scrape(ctx)).body).not.toContain('application.launch');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/metrics.test.ts -t "counts security events"`
Expected: FAIL — the metric does not exist.

- [ ] **Step 3: Implement**

A module-level `Counter` in `metrics.ts` named `syntra_audit_events_total`, labels `action` and `outcome`, and a `countSecurityEvent` that increments it. Call it from the same `isSecurityEvent` branch in `recordEvent` that does the fan-out — one condition, two consumers, so the counter and the deliveries cannot disagree.

Document that the counter is process-local and resets on restart: that is what a counter is, and Prometheus handles it. Document that the label set is bounded by the allowlist and that labelling every action would grow it with the audit vocabulary.

The counter must live in core, beside `collectMetrics`, so `audit-service.ts` does not import from `apps/api`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/metrics.test.ts packages/core/src/audit/audit-service.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/health/metrics.ts packages/core/src/audit/audit-service.ts apps/api/src/routes/metrics.test.ts
git commit -m "feat(core): one condition, a delivery and a count"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/configure.md`
- Modify: `docs/operate.md`
- Modify: `README.md`

- [ ] **Step 1: Make the alerting instruction true**

`docs/configure.md` says of the security audit events: "Nothing watches these by default… **wire these into your alerting.**" Follow that sentence with how: the three groups, what a body contains, and — explicitly — that the audit payload and source address are **not** on the wire, so a receiver that needs them reads the audit log by sequence number.

- [ ] **Step 2: Document the metrics endpoint**

A section in `docs/operate.md`: `METRICS_TOKEN`, that no token means no route, a scrape config fragment with `bearer_token`, the metric table from the design document, and the four worth alerting on first — `syntra_logout_deliveries_abandoned`, `syntra_webhook_deliveries_abandoned`, `syntra_signing_key_expires_in_seconds`, `syntra_readiness`.

State plainly that there are no per-tenant labels and why, so nobody files it as a gap.

- [ ] **Step 3: Update the environment variable table**

`docs/configure.md` documents every environment variable; add `METRICS_TOKEN` where it belongs, noting the 16-character floor.

- [ ] **Step 4: README**

The Core row gains security webhook groups and a metrics endpoint.

- [ ] **Step 5: Verify every claim against the code**

Re-read each paragraph against what was built. The stale revocation paragraph found in cluster A is what happens when this step is skipped.

- [ ] **Step 6: Commit**

```bash
git add docs/configure.md docs/operate.md README.md
git commit -m "docs: what to watch, and how to watch it"
```

---

## Self-Review

**Spec coverage.** Three groups → Task 1. Allowlist and projection → Task 2. The `recordEvent` hook → Task 3 (fan-out) and Task 8 (counter), which is the spec's "one hook, two consumers". Selector and console → Task 4. Token-gated route → Task 5. HTTP histogram and the no-URL-label rule → Task 6. Database gauges and the ten-second cache → Task 7. Documentation → Task 9. The spec's non-goals (tracing, per-tenant labels, shipped alert rules, SIEM formats) have no tasks, correctly.

**Type consistency.** `isSecurityEvent`, `securityProjection`, `SecurityEventProjection`, `MetricsSnapshot`, `collectMetrics`, `cachedMetrics`, `countSecurityEvent` and `registerMetricsRoutes` are each declared once in an Interfaces block and used with those names and arities everywhere after.

**Known soft spots.** Three places where the repository has the final say: whether `audit-service.ts → webhook-service.ts` closes an import cycle (Task 3 says what to do if it does); how `buildTestApp` takes overrides (Task 5); and whether pg-boss's job table is reachable through Prisma or needs `$queryRaw` (Task 7). Read the file first in each case.
