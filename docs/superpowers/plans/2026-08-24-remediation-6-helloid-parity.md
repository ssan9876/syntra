# HelloID Feature-Parity Implementation Plan (Remediation 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining, concretely-scoped gap between Syntra and Tools4ever's HelloID identified by the 2026-08-24 comparison and the same day's audit, in three parts: (A) connector breadth — generalize Provision's target-connector coupling from "hard-coded to Active Directory" to "selected by `TargetSystem.type`", proven with a real second connector (SCIM 2.0 REST, the standard HelloID itself leans on for the bulk of its 200+ integrations); (B) the one console defect the comparison surfaced that no existing remediation task covers — the business-rules editor cannot build or display a compound (AND/OR/NOT) condition, though the engine underneath has supported one from the start; (C) the single audit finding with zero task coverage anywhere in Remediations 1–5 — X4, CI has no dependency caching.

**Architecture:**
- **Part A (Tasks 1–9).** `packages/connectors` already defines a connector-agnostic `Connector<C>` / `TargetConnector<C>` interface (`packages/connectors/src/types.ts:304-362`) and has exactly one implementation, `adTargetConnector`. Every caller in `@syntra/core` reaches for that implementation by name rather than by looking it up — `target-service.ts`, `apply.ts`, `run-service.ts` and `entitlement-service.ts` all import `adTargetConnector`/`adTargetConfigSchema` directly. This plan adds a second implementation (`scimTargetConnector`), a small registry that maps `TargetSystem.type` to a connector and its config schema, and rewires the four call sites to go through the registry instead of the hard-coded import. No change to the interface itself, no change to `ProvisionAction`, the guard, the ladder, or the plan/reconcile stages — they already operate on `WriteOperation`/`SourceRecord`/`WriteResult`, which are already connector-neutral.
- **Part B (Tasks 10–14).** `packages/core/src/provision/condition.ts` already defines `Condition` as a fully recursive `{all:[]} | {any:[]} | {not:} | leaf` type (lines 52-59), validated by a recursive `conditionSchema` (lines 163-170), and evaluated by a recursive `evaluate()` (lines 268-340) with three-valued logic so an unrecognised shape never silently grants access. None of that is being touched — it already works and is already tested. The defect is entirely in `apps/web/src/pages/admin/BusinessRulesPage.tsx`: its `Draft` type (lines 110-119) is a single flat leaf, `draftFrom()` (132-158) collapses any stored condition to one leaf on load, and `describe()` (190-200) renders anything that isn't a single leaf as the opaque string `'a compound condition'` with no way to inspect or edit it further. This plan replaces the flat `Draft` with a tree mirroring `Condition`, adds a recursive editor component, and makes `draftFrom`/`conditionOf`/`describe` round-trip losslessly.
- **Part C (Task 15).** `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` and, in the `e2e` job, `pnpm exec playwright install --with-deps chromium` on every run with no `actions/cache` step anywhere in the file — confirmed by reading it in full. This plan adds pnpm-store and Playwright-browser caching to both jobs.

**Tech Stack:** TypeScript 5.7, Node 22+, Zod 3.24, Vitest 3, React 19. No new runtime dependency for the connector itself (built on `node:http`/`node:https` and the `Request`/`Response`/`Headers` globals, the same primitives `guarded-fetch.ts` already uses); `ipaddr.js` is added to `@syntra/connectors` as a direct dependency (it is already a transitive dependency of `@syntra/core` today).

**Spec:** `docs/superpowers/specs/2026-08-16-syntra-provision-design.md` is the binding spec for the interface this plan builds on (§14, §15 on the connector contract and the no-delete rule) and is unchanged by this plan. No separate spec document was authored for the SCIM connector or the registry; this file's Architecture section and each task's rationale are the spec for that incremental work — the pattern the audit (`docs/superpowers/specs/2026-08-24-audit-findings.md`) and the existing remediation plans do not need repeating since they establish no new subsystem, only a second implementation of one that already existed.

**Where this sits relative to the rest of the programme:** see the **Priority Roadmap** section immediately below, which sequences all three parts of this plan against Remediations 1–5 and states what is deliberately not being built and why.

## Global Constraints

Everything in the Core, Directory Sync, Access and Provision plans' Global Constraints still applies to every file this plan touches inside `@syntra/core`. The ones that bite here, plus what this plan adds:

1. **Provision never deletes.** The SCIM connector gets no delete operation to call, mirroring the Active Directory connector exactly (spec §9, §15). `archive_account` on a SCIM target sets `active: false` and strips the group memberships Provision manages; it never issues `DELETE /Users/{id}`.
2. **No network I/O inside a Prisma transaction.** The SCIM connector's HTTP calls happen exactly where `adTargetConnector`'s LDAP calls happen today: outside `withTenant`, in `apply.ts` step 2 and in `run-service.ts`'s load phase. This plan adds no new call site that violates it.
3. **The anchor is the target's own immutable identifier, never a mutable name.** For SCIM this is the resource's server-assigned `id` (RFC 7644 §3.3), never `userName`. `userName` is the correlation key, exactly as `sAMAccountName` is for Active Directory.
4. **A layering rule this plan is the first to hit:** `@syntra/connectors` has no dependency on `@syntra/core` (`packages/core/package.json:13` depends on `@syntra/connectors`, never the reverse), and `escapeDnValue` is already duplicated byte-for-byte across the boundary for exactly this reason (`packages/core/src/provision/apply.ts:19-23`). `guardedFetch` — the SSRF-safe fetch wrapper the SCIM connector needs — lives in `@syntra/core` (`packages/core/src/net/guarded-fetch.ts`) and is also consumed by `@syntra/protocols`, which depends on `@syntra/core` directly. Relocating it would ripple into a package this plan has no other reason to touch. Task 1 duplicates it into `@syntra/connectors` instead, following the established precedent rather than inventing a new one.
5. **Vitest does not type-check.** Every task's verification runs `pnpm typecheck` as its own step, separately from `pnpm vitest run`.
6. **A run proposes, a human confirms, nothing irreversible happens unattended** (Ruling P2). This plan changes which connector `apply.ts` calls; it does not change when it is allowed to call one. The guard, the ladder and the confirmation gates are untouched.

---

## Priority Roadmap

This is the answer to "close the HelloID gap, prioritized, everything included." It sequences the 61 tasks already planned across Remediations 1–5 against the new work in this document, and states explicitly what is being left out and why.

### Tier 0 — already sequenced, do not reorder

Remediations 1–5 (`docs/superpowers/plans/2026-08-24-remediation-{1..5}-*.md`, 61 tasks, ~19,400 lines) fix defects the audit found in code that already exists and is already marketed as working: a critical defect that halts every governance snapshot permanently (Remediation 1, Task 2), a database-reset guard that does not guard the lab database (Remediation 1, Task 3), an update mechanism that cannot complete a single release (Remediation 5, all 11 tasks), and dozens of governance/provisioning/auth findings where the console or the API claims a capability the code behind it does not deliver (evidence bundles that verify empty, SoD detection that can hang the job queue, a product editor that never loads the product it edits, and so on).

**None of that is superseded or reordered by this plan.** A platform whose existing, marketed features are unreliable should not be sold on breadth before it is sold on correctness — HelloID's advantage is not just its connector count, it is that the connectors it has work. Remediations 1–5 close that gap first. This plan is additive: it can be executed in parallel with any of Remediation 2–4 (different files, no shared tasks) but should not ship — meaning: a `scim2` target type should not be offered to a real tenant — ahead of Remediation 1 (the snapshot-halting critical and the `db:reset` guard) and Remediation 5 (an update mechanism that cannot install what this plan produces).

### Tier 1 — this plan (Remediation 6)

Three gaps in the 2026-08-24 comparison and audit with no existing remediation task addressing them, ordered by size:

**Part A, Tasks 1–9 — connector breadth.** `TargetSystem.type` and `DirectorySource.type` are free strings built for a second connector (`packages/db/prisma/schema.prisma:1042-1044`, `:306`) and none exists. This is the largest gap in the whole comparison: HelloID's value is substantially *in* its 200+ connector library. Tasks 1–9 close it for target systems: a connector registry plus a SCIM 2.0 target connector, the standard most modern SaaS applications and identity platforms speak, and the same one HelloID itself relies on for most of its integration count rather than hand-writing 200 bespoke clients.

**Scope boundary, stated plainly:** Part A generalizes the *target* side only (`TargetSystem`, provisioning). `DirectorySource` (the sync *source* side — reading a SCIM-speaking HR or identity system inward) shares the same layering problem and would follow the identical pattern (a `SourceConnector` registry keyed on `DirectorySource.type`), but touches `packages/core/src/sync/*` instead of `packages/core/src/provision/*` and is a second, separate plan. Building it is a small increment once this one lands (the SCIM HTTP client and config schema this plan produces are reusable as-is), but it is out of scope here because `packages/core/src/sync/run-service.ts` and `source-service.ts` were not part of the grounding this plan did, and a plan that touches files nobody read is a plan with invented content in it.

**Part B, Tasks 10–14 — the business-rules editor cannot build a compound condition.** Verified directly against `condition.ts` and `BusinessRulesPage.tsx`: the engine's `Condition` type, its Zod schema and its evaluator are all fully recursive (`all`/`any`/`not` over arbitrarily nested children) and none of that is in question. The console's `Draft` type is a single flat leaf; loading a rule that was created some other way with a compound condition into the editor silently collapses it, and the read-only list renders it as the literal string `'a compound condition'`. An administrator can request one via a raw API call and can never again see or safely edit it through the console. This is not in the audit's finding register (it surfaced only from the HelloID comparison, since HelloID's business-rules engine is explicitly conditional), so it has no finding ID and no existing task.

**Part C, Task 15 — CI has no dependency caching.** Audit finding X4, the one finding across the entire 80-item register with zero task coverage in Remediations 1–5 (confirmed by an independent index of all five plans against the full finding register). Low severity, cheap to close, included here so nothing from the audit is left unplanned.

### Tier 2 — worth doing, not planned here, and why

- **A second and third target connector** (a generic SCIM source-side connector per above, then a REST/webhook catch-all in the shape of HelloID's PowerShell connector for systems with no SCIM support at all). Sequence after Tier 1 proves the registry pattern in production, not before — a second implementation is what proves an abstraction; a fourth one before the third has shipped is premature investment.
- **RBAC role editing** — already fully planned: Remediation 4, Tasks 6–9 (`docs/superpowers/plans/2026-08-24-remediation-4-auth-api-console.md:1651-2878`). Not duplicated here.
- **Self-service catalog: the missing workflow admin page** — already fully planned. Verified against Remediation 4: W6 ("server features with no console UI, including... workflows [no list route at all]") is covered by Remediation 4, Tasks 22–25. Not duplicated here.
- **Self-service application catalog / SSO tile dashboard** — already built, not a gap. `apps/web/src/pages/Portal.tsx` and `apps/web/src/pages/admin/ApplicationsPage.tsx` already give end users a tile launcher (including inline step-up MFA mid-launch, which HelloID's dashboard does not do) and admins an application catalog (`docs/superpowers/plans/2026-08-15-syntra-access-1.md`, Tasks 11 and 13). The earlier comparison against HelloID overstated this as missing; it is narrower than HelloID's *pre-built* catalog of hundreds of SaaS integrations (Syntra's tiles are whatever SAML/OIDC application an admin registers by hand), but the mechanism itself exists and needs no new plan.
- **AI-driven access recommendations** (HelloID Governance, 2025+) — deliberately not planned. It is the least-differentiating item in the comparison: it sits on top of the reconciliation and orphan-detection data Syntra already collects (`packages/core/src/govern/*`), several of the audit's Governance findings (G8, G9, G11, G18, W8) mean that underlying data is not yet trustworthy, and chasing an AI feature before the facts under it are correct would be building a recommendation engine on top of numbers the audit says are wrong. Revisit after Remediation 2 lands.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/connectors/src/net/outbound.ts` | Create. `classifyAddress`, duplicated from `packages/core/src/net/outbound.ts` (Global Constraint 4). |
| `packages/connectors/src/net/guarded-fetch.ts` | Create. `guardedFetch`, duplicated from `packages/core/src/net/guarded-fetch.ts`. |
| `packages/connectors/src/net/guarded-fetch.test.ts` | Create. Same test shape as core's, run against `@syntra/connectors`' copy. |
| `packages/connectors/src/scim/config.ts` | Create. `scim2TargetConfigSchema`, the SCIM target's configuration shape. |
| `packages/connectors/src/scim/client.ts` | Create. The bearer-authenticated SCIM HTTP client: request building, pagination, PATCH op construction. No connector logic — just RFC 7644 wire format. |
| `packages/connectors/src/scim/connector.ts` | Create. `scimTargetConnector: TargetConnector<Scim2TargetConfig>` — `test`, `discoverSchema`, `read`, `write`, `listEntitlements`, `listContainers`, `readEntitlementMembers`. |
| `packages/connectors/src/scim/connector.test.ts` | Create. Unit tests against an in-process fake SCIM HTTP server (Task 2's harness). |
| `packages/connectors/src/testing/fake-scim-server.ts` | Create. The fake SCIM server: `node:http`, in-memory `Users`/`Groups`, RFC 7644 wire shapes in and out. |
| `packages/connectors/src/registry.ts` | Create. `TARGET_CONNECTOR_TYPES`, `targetConnectorFor(type)`, `targetConfigSchemaFor(type)`. |
| `packages/connectors/src/registry.test.ts` | Create. |
| `packages/connectors/src/index.ts` | Modify. Export the new modules. |
| `packages/connectors/package.json` | Modify. Add `ipaddr.js` as a direct dependency. |
| `packages/core/src/provision/target-service.ts` | Modify. `TARGET_TYPES`, `createScalarsSchema`, `createTarget`, `updateTarget`, `targetWithCredential`, `testTargetConfiguration` go through the registry instead of `adTargetConfigSchema`/`adTargetConnector` by name. |
| `packages/core/src/provision/target-service.schemas.test.ts` | Modify. Add SCIM-typed create/update cases. |
| `packages/core/src/provision/apply.ts` | Modify. `applyProvisionRun` and `resolveInFlightActions` select the connector from the target's own `type` instead of defaulting to `adTargetConnector`. |
| `packages/core/src/provision/apply.test.ts` | Modify. Add a SCIM-target case proving the same apply loop drives a different connector. |
| `packages/core/src/provision/run-service.ts` | Modify. Same substitution at its one call site. |
| `packages/core/src/provision/entitlement-service.ts` | Modify. `EntitlementReader` default resolved from the registry. |
| `packages/core/src/provision/target-service.ts:795` (`LDAP_ATTRIBUTE_NAME`) | Modify. Broadened to accept a dotted sub-attribute path (`name.givenName`), needed by SCIM's core schema and harmless to Active Directory, which never produces one. |
| `apps/web/src/pages/admin/TargetDetailPage.tsx` | Modify. A `type` selector; the existing AD-shaped fields render only for `activeDirectory`, a new SCIM-shaped field group renders for `scim2`. |
| `apps/web/src/pages/admin/TargetDetailPage.test.tsx` | Modify. Add coverage for the SCIM field group and the type switch. |
| `apps/web/src/pages/admin/TargetsPage.tsx` | Modify. A type badge on the list, so an administrator can tell targets apart at a glance. |
| `apps/web/src/pages/admin/TargetsPage.test.tsx` | Modify. |
| `apps/web/src/pages/admin/ConditionGroupEditor.tsx` | Create. Recursive `all`/`any`/`not` condition-tree editor: add-leaf, add-group, remove, and per-leaf field/operator/value controls reusing `BusinessRulesPage.tsx`'s existing `FIELDS`/`OPERATORS` constants. |
| `apps/web/src/pages/admin/ConditionGroupEditor.test.tsx` | Create. |
| `apps/web/src/pages/admin/BusinessRulesPage.tsx` | Modify. `Draft.field/op/value` (lines 110-119) replaced by a `condition: ConditionNode` tree; `draftFrom` (132-158), `conditionOf` (160-177), `bodyOf` (179-188) and `describe` (190-200) rewritten to convert losslessly; renders `ConditionGroupEditor` instead of the flat field/operator/value row. |
| `apps/web/src/pages/admin/BusinessRulesPage.test.tsx` | Modify. Add compound-condition create/edit/round-trip cases. |
| `.github/workflows/ci.yml` | Modify. Add `actions/cache` steps for the pnpm store (both jobs) and the Playwright Chromium download (`e2e` job). |

---

### Task 1: Duplicate the SSRF-guarded fetch into `@syntra/connectors`

**Files:**
- Create: `packages/connectors/src/net/outbound.ts`
- Create: `packages/connectors/src/net/guarded-fetch.ts`
- Create: `packages/connectors/src/net/guarded-fetch.test.ts`
- Modify: `packages/connectors/src/index.ts`
- Modify: `packages/connectors/package.json`

**Interfaces:**
- Produces: `classifyAddress(address: string): 'allowed' | 'blocked'`, `guardedFetch(options?: GuardedFetchOptions): GuardedFetch`, `type GuardedFetch = (url: string | URL, init?: RequestInit) => Promise<Response>` — all re-exported from `@syntra/connectors`'s barrel, consumed by Task 4's SCIM client.

- [ ] **Step 1: Add `ipaddr.js` to `@syntra/connectors`**

`packages/connectors/package.json` — add to `dependencies`:

```json
    "ipaddr.js": "^2.2.0",
```

Run: `pnpm install`
Expected: lockfile updates, no version conflict (this is the same major version `@syntra/core` already resolves).

- [ ] **Step 2: Copy `outbound.ts` byte-for-byte**

Create `packages/connectors/src/net/outbound.ts` with the exact contents of `packages/core/src/net/outbound.ts` (the file read in full during this plan's grounding — `BLOCKED_RANGES`, `classifyAddress`, unchanged). No import in that file names anything outside `node:*` and `ipaddr.js`, so the copy compiles unmodified in the new location.

- [ ] **Step 3: Copy `guarded-fetch.ts`, repointing its one import**

Create `packages/connectors/src/net/guarded-fetch.ts` with the exact contents of `packages/core/src/net/guarded-fetch.ts`, with line 4's import rewritten from a relative path that already matches (`./outbound.js`) — no change needed, since both files sit in the same relative position (`net/guarded-fetch.ts` importing `./outbound.js`) in both packages.

- [ ] **Step 4: Copy the test file, importing the local copy**

Create `packages/connectors/src/net/guarded-fetch.test.ts` with the exact contents of `packages/core/src/net/guarded-fetch.test.ts` (its only import, `./guarded-fetch.js`, already resolves to the new local copy with no change).

- [ ] **Step 5: Run the duplicated tests**

Run: `pnpm --filter @syntra/connectors test -- guarded-fetch`
Expected: PASS, same count as `packages/core/src/net/guarded-fetch.test.ts` reports today.

- [ ] **Step 6: Export from the barrel**

`packages/connectors/src/index.ts` — add:

```ts
export * from './net/outbound.js';
export * from './net/guarded-fetch.js';
```

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add packages/connectors/src/net packages/connectors/src/index.ts packages/connectors/package.json pnpm-lock.yaml
git commit -m "connectors: duplicate the SSRF-guarded fetch across the core/connectors layering boundary"
```

---

### Task 2: SCIM 2.0 config schema, the fake SCIM server, and `test`/`discoverSchema`

**Files:**
- Create: `packages/connectors/src/scim/config.ts`
- Create: `packages/connectors/src/testing/fake-scim-server.ts`
- Create: `packages/connectors/src/scim/client.ts`
- Create: `packages/connectors/src/scim/connector.ts`
- Create: `packages/connectors/src/scim/connector.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: `guardedFetch` from Task 1.
- Produces: `scim2TargetConfigSchema: z.ZodType`, `type Scim2TargetConfig`, `scimRequest(config, method, path, body?): Promise<{ status: number; json: unknown }>` (Task 2's `client.ts`), `scimTargetConnector.test` and `.discoverSchema`. Later tasks in this file add the remaining `TargetConnector` methods to the same `scimTargetConnector` object.

- [ ] **Step 1: The config schema**

Create `packages/connectors/src/scim/config.ts`:

```ts
import { z } from 'zod';

/**
 * A configured URL or bearer token: trimmed, refused blank. Same reasoning as
 * `directoryString` in `ad/config.ts` — a padded value is invisible in a form
 * and compared exactly everywhere it is used.
 */
const configString = z.string().trim().min(1);

export const scim2TargetConfigSchema = z.object({
  /** Scheme + host, no trailing slash — e.g. `https://api.example.com/scim/v2`. */
  baseUrl: configString.refine(
    (v) => v.startsWith('http://') || v.startsWith('https://'),
    { message: 'baseUrl must start with http:// or https://' },
  ),
  /** RFC 7644 §3.2: the path segment under `baseUrl` for User resources. */
  userResourcePath: configString.default('/Users'),
  /** RFC 7644 §3.2: the path segment under `baseUrl` for Group resources. */
  groupResourcePath: configString.default('/Groups'),
  /**
   * RFC 7643 §3.1: the field a provisioning client stamps with its own
   * correlation identifier. This is what `provenanceAttribute` (`info`) is
   * for the Active Directory connector — except SCIM's core schema defines
   * this field for exactly this purpose, so there is no analogue of
   * `provenanceAttribute` to make configurable here.
   */
  pageSize: z.number().int().positive().max(1000).default(200),
  connectTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  /**
   * Whether this deployment may be reached at a private address. Mirrors
   * `GuardedFetchOptions.allowPrivateAddresses`; default false, same as every
   * other outbound-guarded call in this codebase (`ad/config.ts` has no
   * equivalent because LDAP does not go through `guardedFetch`).
   */
  allowPrivateAddresses: z.boolean().default(false),
});

export type Scim2TargetConfig = z.input<typeof scim2TargetConfigSchema>;
export type ResolvedScim2TargetConfig = z.output<typeof scim2TargetConfigSchema>;
```

- [ ] **Step 2: Write the failing connector test for `test()`**

Create `packages/connectors/src/scim/connector.test.ts`:

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { startFakeScimServer } from '../testing/fake-scim-server.js';
import { scimTargetConnector } from './connector.js';

describe('scimTargetConnector.test', () => {
  let server: Awaited<ReturnType<typeof startFakeScimServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('reports ok against a reachable, correctly authenticated server', async () => {
    server = await startFakeScimServer({ bearerToken: 'secret-token' });
    const result = await scimTargetConnector.test({
      baseUrl: server.baseUrl,
      bearerToken: 'secret-token',
      allowPrivateAddresses: true,
    } as never);
    expect(result.ok).toBe(true);
  });

  it('reports not ok when the bearer token is wrong', async () => {
    server = await startFakeScimServer({ bearerToken: 'secret-token' });
    const result = await scimTargetConnector.test({
      baseUrl: server.baseUrl,
      bearerToken: 'wrong-token',
      allowPrivateAddresses: true,
    } as never);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail on the missing modules**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: FAIL — `Cannot find module '../testing/fake-scim-server.js'` (and `./connector.js`).

- [ ] **Step 4: The fake SCIM server**

Create `packages/connectors/src/testing/fake-scim-server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeScimUser {
  id: string;
  userName: string;
  externalId: string | null;
  active: boolean;
  name?: { givenName?: string; familyName?: string };
  emails?: { value: string; primary?: boolean }[];
  title?: string;
}

export interface FakeScimGroup {
  id: string;
  displayName: string;
  members: { value: string }[];
}

export interface FakeScimServerOptions {
  bearerToken: string;
  users?: FakeScimUser[];
  groups?: FakeScimGroup[];
}

export interface FakeScimServer {
  baseUrl: string;
  users: Map<string, FakeScimUser>;
  groups: Map<string, FakeScimGroup>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw === '' ? undefined : JSON.parse(raw));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/scim+json' });
  res.end(payload);
}

const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

/**
 * A minimal, in-process RFC 7644 server: bearer auth, `Users` and `Groups`
 * collections, list/get/post/put/patch. No filter-query support beyond what
 * the connector itself needs to exercise (pagination, and PATCH add/remove of
 * group members) — this stands in for a real SCIM service in tests the way
 * `FakeTarget` (`testing/fake-target.ts`) stands in for a real directory, not
 * as a spec-complete SCIM implementation.
 */
export async function startFakeScimServer(
  options: FakeScimServerOptions,
): Promise<FakeScimServer> {
  const users = new Map<string, FakeScimUser>((options.users ?? []).map((u) => [u.id, u]));
  const groups = new Map<string, FakeScimGroup>(
    (options.groups ?? []).map((g) => [g.id, g]),
  );
  let nextId = users.size + groups.size + 1;

  const server = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${options.bearerToken}`) {
        send(res, 401, { detail: 'invalid bearer token' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://fake-scim.invalid');
      const segments = url.pathname.split('/').filter(Boolean);

      if (segments[0] === 'Users') {
        await handleCollection(req, res, url, segments, users, () => `u-${nextId++}`);
        return;
      }
      if (segments[0] === 'Groups') {
        await handleCollection(req, res, url, segments, groups, () => `g-${nextId++}`);
        return;
      }
      send(res, 404, { detail: `no such resource: ${url.pathname}` });
    })().catch((cause) => {
      send(res, 500, { detail: cause instanceof Error ? cause.message : String(cause) });
    });
  });

  async function handleCollection<T extends { id: string }>(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    segments: string[],
    store: Map<string, T>,
    genId: () => string,
  ): Promise<void> {
    const id = segments[1];
    if (id === undefined) {
      if (req.method === 'GET') {
        const startIndex = Number(url.searchParams.get('startIndex') ?? '1');
        const count = Number(url.searchParams.get('count') ?? '100');
        const all = [...store.values()];
        const page = all.slice(startIndex - 1, startIndex - 1 + count);
        send(res, 200, {
          schemas: [LIST_RESPONSE_SCHEMA],
          totalResults: all.length,
          startIndex,
          itemsPerPage: page.length,
          Resources: page,
        });
        return;
      }
      if (req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const created = { ...body, id: genId() } as unknown as T;
        store.set((created as { id: string }).id, created);
        send(res, 201, created);
        return;
      }
      send(res, 405, { detail: `${req.method} not supported on a collection` });
      return;
    }

    const existing = store.get(id);
    if (existing === undefined) {
      send(res, 404, { detail: `no such resource: ${id}` });
      return;
    }
    if (req.method === 'GET') {
      send(res, 200, existing);
      return;
    }
    if (req.method === 'PUT') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const updated = { ...body, id } as unknown as T;
      store.set(id, updated);
      send(res, 200, updated);
      return;
    }
    if (req.method === 'PATCH') {
      const body = (await readBody(req)) as {
        Operations: { op: string; path?: string; value?: unknown }[];
      };
      let record = existing as unknown as Record<string, unknown>;
      for (const operation of body.Operations) {
        record = applyPatchOperation(record, operation);
      }
      store.set(id, record as unknown as T);
      send(res, 200, record);
      return;
    }
    send(res, 405, { detail: `${req.method} not supported on a resource` });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    users,
    groups,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

/**
 * RFC 7644 §3.5.2, the subset this fake exercises: `replace` on a top-level or
 * dotted path, and `add`/`remove` on `members` (the operation the group
 * grant/revoke connector methods issue).
 */
function applyPatchOperation(
  record: Record<string, unknown>,
  operation: { op: string; path?: string; value?: unknown },
): Record<string, unknown> {
  const path = operation.path ?? '';
  if (operation.op === 'replace') {
    if (path === '') return { ...record, ...(operation.value as Record<string, unknown>) };
    return setPath(record, path, operation.value);
  }
  if (operation.op === 'add' && path === 'members') {
    const current = Array.isArray(record.members) ? (record.members as unknown[]) : [];
    return { ...record, members: [...current, ...(operation.value as unknown[])] };
  }
  if (operation.op === 'remove' && path.startsWith('members[value eq ')) {
    const targetId = path.slice('members[value eq "'.length, -2);
    const current = Array.isArray(record.members) ? (record.members as { value: string }[]) : [];
    return { ...record, members: current.filter((m) => m.value !== targetId) };
  }
  throw new Error(`fake SCIM server: unsupported patch operation ${operation.op} ${path}`);
}

function setPath(record: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { ...record, [head!]: value };
  const nested = (record[head!] as Record<string, unknown> | undefined) ?? {};
  return { ...record, [head!]: setPath(nested, rest.join('.'), value) };
}
```

- [ ] **Step 5: Run again to see the next failure**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: FAIL — `Cannot find module './connector.js'`.

- [ ] **Step 6: The SCIM HTTP client**

Create `packages/connectors/src/scim/client.ts`:

```ts
import { guardedFetch } from '../net/guarded-fetch.js';
import type { ResolvedScim2TargetConfig } from './config.js';

export interface ScimResponse {
  status: number;
  json: unknown;
}

/**
 * One authenticated SCIM request. Wire format only — no knowledge here of
 * what a User or a Group means to Provision, matching the split
 * `ldap/connection.ts` makes between "talk to the wire protocol" and
 * "connector.ts decides what to do with it".
 */
export async function scimRequest(
  config: ResolvedScim2TargetConfig & { bearerToken: string },
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<ScimResponse> {
  const fetcher = guardedFetch({
    allowPrivateAddresses: config.allowPrivateAddresses,
    timeoutMs: config.timeoutMs,
  });
  const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetcher(url, {
    method,
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      accept: 'application/scim+json',
      ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : JSON.parse(text) };
}
```

- [ ] **Step 7: The connector — `test` and `discoverSchema`**

Create `packages/connectors/src/scim/connector.ts`:

```ts
import type {
  ConnectionResult,
  SchemaDescriptor,
  TargetConnector,
} from '../types.js';
import { scim2TargetConfigSchema, type ResolvedScim2TargetConfig } from './config.js';
import { scimRequest } from './client.js';

type Config = ResolvedScim2TargetConfig & { bearerToken: string };

function normalise(raw: unknown): Config {
  const parsed = scim2TargetConfigSchema.parse(raw) as ResolvedScim2TargetConfig;
  const { bearerToken } = raw as { bearerToken: string };
  return { ...parsed, bearerToken };
}

export const scimTargetConnector: TargetConnector<Config> = {
  async test(rawConfig): Promise<ConnectionResult> {
    const config = normalise(rawConfig);
    try {
      const usersResult = await scimRequest(
        config,
        'GET',
        `${config.userResourcePath}?startIndex=1&count=1`,
      );
      if (usersResult.status === 401 || usersResult.status === 403) {
        return { ok: false, message: `the server refused the bearer token (HTTP ${usersResult.status})` };
      }
      if (usersResult.status >= 400) {
        return { ok: false, message: `${config.userResourcePath} answered HTTP ${usersResult.status}` };
      }
      const groupsResult = await scimRequest(
        config,
        'GET',
        `${config.groupResourcePath}?startIndex=1&count=1`,
      );
      return {
        ok: groupsResult.status < 400,
        message:
          groupsResult.status < 400
            ? 'connected; users and groups are both reachable'
            : `${config.groupResourcePath} answered HTTP ${groupsResult.status}`,
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  },

  async discoverSchema(rawConfig): Promise<SchemaDescriptor> {
    const config = normalise(rawConfig);
    // RFC 7643 §7 defines a `/Schemas` endpoint, but it is optional and many
    // real deployments do not implement it. Rather than fail discovery
    // outright on a server that omits it, this reports the fixed core-schema
    // attribute set every SCIM 2.0 User/Group resource is required to carry —
    // enough for the target-system form to validate an attribute template
    // name against, which is the only consumer of `discoverSchema` today
    // (`target-service.ts`'s `attributeTemplatesSchema` does not call it yet;
    // it is here because every other connector implements it and Task 6
    // wires the console up to it).
    const result = await scimRequest(config, 'GET', '/Schemas');
    if (result.status < 400 && Array.isArray((result.json as { Resources?: unknown[] })?.Resources)) {
      const resources = (result.json as { Resources: { attributes?: { name: string }[] }[] }).Resources;
      const attributes = resources.flatMap((r) => (r.attributes ?? []).map((a) => a.name));
      return { objectClasses: ['User', 'Group'], attributes: [...new Set(attributes)] };
    }
    return {
      objectClasses: ['User', 'Group'],
      attributes: ['userName', 'externalId', 'active', 'name.givenName', 'name.familyName', 'emails', 'title'],
    };
  },
} as unknown as TargetConnector<Config>;
```

- [ ] **Step 8: Run and see `test()` pass**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: PASS, 2/2 (the `discoverSchema` tests are added in a later step of this task; only `test()` is asserted so far).

- [ ] **Step 9: Add and run the `discoverSchema` cases**

Append to `packages/connectors/src/scim/connector.test.ts`:

```ts
describe('scimTargetConnector.discoverSchema', () => {
  let server: Awaited<ReturnType<typeof startFakeScimServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('falls back to the fixed core-schema attribute set when /Schemas is absent', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const result = await scimTargetConnector.discoverSchema({
      baseUrl: server.baseUrl,
      bearerToken: 't',
      allowPrivateAddresses: true,
    } as never);
    expect(result.attributes).toContain('userName');
    expect(result.attributes).toContain('externalId');
  });
});
```

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: PASS, 3/3.

- [ ] **Step 10: Export and typecheck**

`packages/connectors/src/index.ts` — add:

```ts
export * from './scim/config.js';
export * from './scim/client.js';
export * from './scim/connector.js';
export * from './testing/fake-scim-server.js';
```

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/connectors/src/scim packages/connectors/src/testing/fake-scim-server.ts packages/connectors/src/index.ts
git commit -m "connectors: SCIM 2.0 config, HTTP client, fake server, and connector test()/discoverSchema()"
```

---

### Task 3: SCIM connector — `read()`

**Files:**
- Modify: `packages/connectors/src/scim/connector.ts`
- Modify: `packages/connectors/src/scim/connector.test.ts`

**Interfaces:**
- Consumes: `scimRequest` (Task 2), `startFakeScimServer` (Task 2).
- Produces: `scimTargetConnector.read(config): AsyncIterable<SourceRecord>` — the shape `run-service.ts` and `resolveInFlightActions` (Task 7) iterate.

- [ ] **Step 1: Write the failing test**

Append to `packages/connectors/src/scim/connector.test.ts`:

```ts
describe('scimTargetConnector.read', () => {
  let server: Awaited<ReturnType<typeof startFakeScimServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('pages through every user and reports it as a SourceRecord', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: Array.from({ length: 3 }, (_, i) => ({
        id: `u-${i}`,
        userName: `person${i}`,
        externalId: null,
        active: true,
      })),
    });
    const records = [];
    for await (const record of scimTargetConnector.read({
      baseUrl: server.baseUrl,
      bearerToken: 't',
      pageSize: 2,
      allowPrivateAddresses: true,
    } as never)) {
      records.push(record);
    }
    expect(records).toHaveLength(3);
    expect(records[0]!.anchor).toBe('u-0');
    expect(records[0]!.objectType).toBe('user');
    expect(records[0]!.attributes.userName).toEqual(['person0']);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: FAIL — `scimTargetConnector.read is not a function`.

- [ ] **Step 3: Implement `read()`**

Add to the `scimTargetConnector` object literal in `packages/connectors/src/scim/connector.ts` (after `discoverSchema`, before the closing `} as unknown as TargetConnector<Config>;`):

```ts
  async *read(rawConfig) {
    const config = normalise(rawConfig);
    let startIndex = 1;
    for (;;) {
      const result = await scimRequest(
        config,
        'GET',
        `${config.userResourcePath}?startIndex=${startIndex}&count=${config.pageSize}`,
      );
      if (result.status >= 400) {
        throw new Error(`${config.userResourcePath} answered HTTP ${result.status} while reading`);
      }
      const page = result.json as {
        Resources: {
          id: string;
          userName: string;
          externalId?: string | null;
          active?: boolean;
          name?: { givenName?: string; familyName?: string };
          emails?: { value: string }[];
          title?: string;
        }[];
        totalResults: number;
      };
      for (const resource of page.Resources) {
        yield {
          anchor: resource.id,
          objectType: 'user' as const,
          dn: resource.id,
          attributes: {
            userName: [resource.userName],
            ...(resource.externalId ? { externalId: [resource.externalId] } : {}),
            active: [String(resource.active ?? true)],
            ...(resource.name?.givenName ? { 'name.givenName': [resource.name.givenName] } : {}),
            ...(resource.name?.familyName ? { 'name.familyName': [resource.name.familyName] } : {}),
            ...(resource.emails?.[0]?.value ? { emails: [resource.emails[0].value] } : {}),
            ...(resource.title ? { title: [resource.title] } : {}),
          },
        };
      }
      if (page.Resources.length < config.pageSize || startIndex + page.Resources.length > page.totalResults) {
        return;
      }
      startIndex += page.Resources.length;
    }
  },
```

Note on `dn`: SCIM has no distinguished-name concept. `SourceRecord.dn` is populated with the resource `id` (same as `anchor`) rather than left empty, because `valuesOf`/`first()` callers across `@syntra/core` treat an empty `dn` as "this object has no addressable location" in the Active Directory sense; for SCIM the `id` *is* the address, so this is the honest value rather than a placeholder.

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: PASS, 4/4.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add packages/connectors/src/scim/connector.ts packages/connectors/src/scim/connector.test.ts
git commit -m "connectors(scim): read() — paginated GET /Users mapped to SourceRecord"
```

---

### Task 4: SCIM connector — `write()`, create/update/enable/disable

**Files:**
- Modify: `packages/connectors/src/scim/connector.ts`
- Modify: `packages/connectors/src/scim/connector.test.ts`

**Interfaces:**
- Consumes: `WriteOperation`, `WriteResult` (`packages/connectors/src/types.ts`).
- Produces: `scimTargetConnector.write(config, op)` for `op.op` in `create_account | update_account | enable_account | disable_account`. `rename_account`, `archive_account`, `grant_entitlement`, `revoke_entitlement` are added in Task 5 — `write` throws `unsupported operation` for those until then, which the test in this task asserts explicitly so the gap is visible rather than silently falling through.

- [ ] **Step 1: Write the failing tests**

Append to `packages/connectors/src/scim/connector.test.ts`:

```ts
describe('scimTargetConnector.write — create, update, enable, disable', () => {
  let server: Awaited<ReturnType<typeof startFakeScimServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const baseConfig = (server: Awaited<ReturnType<typeof startFakeScimServer>>) => ({
    baseUrl: server.baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('creates a user and returns its server-assigned id as the anchor', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const result = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'create_account',
      actionId: 'action-1',
      correlationKey: 'jdoe',
      attributes: { 'name.givenName': ['Jane'], 'name.familyName': ['Doe'] },
      enabled: true,
      initialPassword: 'S3cret!',
    });
    expect(result.ok).toBe(true);
    expect(result.anchor).toBeDefined();
    const created = server.users.get(result.anchor!);
    expect(created?.userName).toBe('jdoe');
    expect(created?.externalId).toBe('syntra-provision action=action-1');
  });

  it('updates the complete managed attribute set on an existing user', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true, title: 'old' }],
    });
    const result = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'update_account',
      actionId: 'action-2',
      anchor: 'u-1',
      attributes: { title: ['new'] },
    });
    expect(result.ok).toBe(true);
    expect(server.users.get('u-1')?.title).toBe('new');
  });

  it('disables and re-enables a user by setting active', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true }],
    });
    const disabled = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'disable_account',
      actionId: 'action-3',
      anchor: 'u-1',
      reason: 'left the org',
    });
    expect(disabled.ok).toBe(true);
    expect(server.users.get('u-1')?.active).toBe(false);

    const enabled = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'enable_account',
      actionId: 'action-4',
      anchor: 'u-1',
    });
    expect(enabled.ok).toBe(true);
    expect(server.users.get('u-1')?.active).toBe(true);
  });

  it('reports not_found when the anchor names no resource', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const result = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'disable_account',
      actionId: 'action-5',
      anchor: 'no-such-id',
      reason: 'left the org',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });

  it('has not yet implemented rename or archive', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    await expect(
      scimTargetConnector.write(baseConfig(server) as never, {
        op: 'rename_account',
        actionId: 'action-6',
        anchor: 'u-1',
        correlationKey: 'new-name',
      }),
    ).rejects.toThrow(/unsupported operation/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: FAIL — `scimTargetConnector.write is not a function`.

- [ ] **Step 3: Implement `write()` for the four supported operations**

Add to the `scimTargetConnector` object literal, after `read`:

```ts
  async write(rawConfig, op) {
    const config = normalise(rawConfig);
    try {
      switch (op.op) {
        case 'create_account': {
          const body: Record<string, unknown> = {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: op.correlationKey,
            // RFC 7643 §3.1's `externalId`: the field the spec designates for
            // a provisioning client's own correlation marker, so this needs
            // no `provenanceAttribute`-style configuration the way the AD
            // connector does. `provenanceActionId`/`withProvenanceMarker`
            // from `@syntra/connectors`'s own `ad/provenance.ts` compose the
            // string; reused rather than restated so the two connectors'
            // markers parse identically and `resolveInFlightActions` (Task 7)
            // reads either with one function.
            externalId: withProvenanceMarker(null, op.actionId),
            active: op.enabled,
            password: op.initialPassword,
            ...attributesToScim(op.attributes),
          };
          const result = await scimRequest(config, 'POST', config.userResourcePath, body);
          if (result.status >= 400) {
            return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
          }
          const created = result.json as { id: string };
          return { ok: true, message: 'created', anchor: created.id };
        }
        case 'update_account': {
          const result = await scimRequest(
            config,
            'PATCH',
            `${config.userResourcePath}/${op.anchor}`,
            { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: attributesToPatchOps(op.attributes) },
          );
          if (result.status === 404) return { ok: false, message: 'no such account', failure: 'not_found' };
          if (result.status >= 400) {
            return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
          }
          return { ok: true, message: 'updated' };
        }
        case 'enable_account':
        case 'disable_account': {
          const result = await scimRequest(
            config,
            'PATCH',
            `${config.userResourcePath}/${op.anchor}`,
            {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op: 'replace', path: 'active', value: op.op === 'enable_account' }],
            },
          );
          if (result.status === 404) return { ok: false, message: 'no such account', failure: 'not_found' };
          if (result.status >= 400) {
            return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
          }
          return { ok: true, message: op.op === 'enable_account' ? 'enabled' : 'disabled' };
        }
        default:
          throw new Error(`unsupported operation for the SCIM connector (not yet implemented): ${op.op}`);
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('unsupported operation')) throw cause;
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        failure: 'transient',
      };
    }
  },
```

Add the three helpers used above, above the `scimTargetConnector` object literal:

```ts
function attributesToScim(attributes: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const name: Record<string, string> = {};
  for (const [key, values] of Object.entries(attributes)) {
    const value = values[0];
    if (value === undefined) continue;
    if (key === 'name.givenName') { name.givenName = value; continue; }
    if (key === 'name.familyName') { name.familyName = value; continue; }
    if (key === 'emails') { out.emails = [{ value, primary: true }]; continue; }
    out[key] = value;
  }
  if (Object.keys(name).length > 0) out.name = name;
  return out;
}

function attributesToPatchOps(
  attributes: Record<string, string[]>,
): { op: 'replace'; path: string; value: unknown }[] {
  const scim = attributesToScim(attributes);
  return Object.entries(scim).map(([path, value]) => ({ op: 'replace' as const, path, value }));
}

function scimErrorMessage(result: { status: number; json: unknown }): string {
  const detail = (result.json as { detail?: string } | null)?.detail;
  return detail ?? `the server answered HTTP ${result.status}`;
}

function classifyFailure(status: number): 'unauthorized' | 'conflict' | 'rejected' | 'transient' {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'transient';
  return 'rejected';
}
```

Add the import this step introduces, at the top of `packages/connectors/src/scim/connector.ts`:

```ts
import { withProvenanceMarker } from '../ad/provenance.js';
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: PASS, 9/9.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add packages/connectors/src/scim/connector.ts packages/connectors/src/scim/connector.test.ts
git commit -m "connectors(scim): write() — create, update, enable, disable"
```

---

### Task 5: SCIM connector — rename, archive, entitlements

**Files:**
- Modify: `packages/connectors/src/scim/connector.ts`
- Modify: `packages/connectors/src/scim/connector.test.ts`

**Interfaces:**
- Produces: the remaining `TargetConnector<Config>` members — `write` for `rename_account`, `archive_account`, `grant_entitlement`, `revoke_entitlement`; `listEntitlements`, `listContainers`, `readEntitlementMembers`. After this task `scimTargetConnector` satisfies the full interface and Task 2's `as unknown as TargetConnector<Config>` cast is removed (it becomes a real, checked implementation).

- [ ] **Step 1: Write the failing tests**

Append to `packages/connectors/src/scim/connector.test.ts`:

```ts
describe('scimTargetConnector.write — rename, archive, entitlements', () => {
  let server: Awaited<ReturnType<typeof startFakeScimServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const baseConfig = (server: Awaited<ReturnType<typeof startFakeScimServer>>) => ({
    baseUrl: server.baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('renames by replacing userName', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'old-name', externalId: null, active: true }],
    });
    const result = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'rename_account',
      actionId: 'action-1',
      anchor: 'u-1',
      correlationKey: 'new-name',
    });
    expect(result.ok).toBe(true);
    expect(server.users.get('u-1')?.userName).toBe('new-name');
  });

  it('archives by disabling and removing named group memberships, never deleting', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true }],
      groups: [{ id: 'g-1', displayName: 'staff', members: [{ value: 'u-1' }, { value: 'u-2' }] }],
    });
    const result = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'archive_account',
      actionId: 'action-2',
      anchor: 'u-1',
      entitlementDns: ['g-1'],
    });
    expect(result.ok).toBe(true);
    expect(server.users.get('u-1')?.active).toBe(false);
    expect(server.users.has('u-1')).toBe(true); // never deleted
    expect(server.groups.get('g-1')?.members).toEqual([{ value: 'u-2' }]);
  });

  it('grants and revokes group membership', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      users: [{ id: 'u-1', userName: 'jdoe', externalId: null, active: true }],
      groups: [{ id: 'g-1', displayName: 'staff', members: [] }],
    });
    const granted = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'grant_entitlement',
      actionId: 'action-3',
      anchor: 'u-1',
      entitlementId: 'g-1',
    });
    expect(granted.ok).toBe(true);
    expect(server.groups.get('g-1')?.members).toEqual([{ value: 'u-1' }]);

    const revoked = await scimTargetConnector.write(baseConfig(server) as never, {
      op: 'revoke_entitlement',
      actionId: 'action-4',
      anchor: 'u-1',
      entitlementId: 'g-1',
    });
    expect(revoked.ok).toBe(true);
    expect(server.groups.get('g-1')?.members).toEqual([]);
  });
});

describe('scimTargetConnector — entitlements and containers', () => {
  let server: Awaited<ReturnType<typeof startFakeScimServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const baseConfig = (server: Awaited<ReturnType<typeof startFakeScimServer>>) => ({
    baseUrl: server.baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('lists every group as a discovered entitlement', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      groups: [{ id: 'g-1', displayName: 'staff', members: [] }],
    });
    const found = [];
    for await (const entitlement of scimTargetConnector.listEntitlements(baseConfig(server) as never)) {
      found.push(entitlement);
    }
    expect(found).toEqual([
      { externalId: 'g-1', dn: 'g-1', type: 'group', displayName: 'staff' },
    ]);
  });

  it('has no containers to list — SCIM has no organizational-unit concept', async () => {
    server = await startFakeScimServer({ bearerToken: 't' });
    const found = [];
    for await (const container of scimTargetConnector.listContainers(baseConfig(server) as never)) {
      found.push(container);
    }
    expect(found).toEqual([]);
  });

  it('reads every member of one entitlement in full', async () => {
    server = await startFakeScimServer({
      bearerToken: 't',
      groups: [{ id: 'g-1', displayName: 'staff', members: [{ value: 'u-1' }, { value: 'u-2' }] }],
    });
    const members = await scimTargetConnector.readEntitlementMembers(baseConfig(server) as never, 'g-1');
    expect(members).toEqual(['u-1', 'u-2']);
  });
});
```

- [ ] **Step 2: Run to see the new cases fail**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: FAIL — `write` still throws `unsupported operation` for `rename_account`/`archive_account`/`grant_entitlement`/`revoke_entitlement`, and `listEntitlements`/`listContainers`/`readEntitlementMembers` do not exist.

- [ ] **Step 3: Extend `write`'s switch and add the three remaining interface members**

Replace the `default:` branch of the `switch (op.op)` inside `write` (added in Task 4) with the four new cases plus the same `default`:

```ts
        case 'rename_account': {
          const result = await scimRequest(
            config,
            'PATCH',
            `${config.userResourcePath}/${op.anchor}`,
            {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op: 'replace', path: 'userName', value: op.correlationKey }],
            },
          );
          if (result.status === 404) return { ok: false, message: 'no such account', failure: 'not_found' };
          if (result.status >= 400) {
            return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
          }
          return { ok: true, message: 'renamed' };
        }
        case 'archive_account': {
          // SCIM has no organizational container to move an object into, so
          // archiving here means exactly "disabled, and stripped of the
          // memberships Provision manages" — the same outcome as Active
          // Directory's archive minus the move, stated explicitly rather than
          // silently doing less than the operation's name suggests.
          const disableResult = await scimRequest(
            config,
            'PATCH',
            `${config.userResourcePath}/${op.anchor}`,
            {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op: 'replace', path: 'active', value: false }],
            },
          );
          if (disableResult.status === 404) return { ok: false, message: 'no such account', failure: 'not_found' };
          if (disableResult.status >= 400) {
            return { ok: false, message: scimErrorMessage(disableResult), failure: classifyFailure(disableResult.status) };
          }
          for (const groupId of op.entitlementDns) {
            const stripResult = await scimRequest(
              config,
              'PATCH',
              `${config.groupResourcePath}/${groupId}`,
              {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [{ op: 'remove', path: `members[value eq "${op.anchor}"]` }],
              },
            );
            if (stripResult.status >= 400 && stripResult.status !== 404) {
              return {
                ok: false,
                message: `disabled the account but could not strip group ${groupId}: ${scimErrorMessage(stripResult)}`,
                failure: classifyFailure(stripResult.status),
              };
            }
          }
          return { ok: true, message: 'archived: disabled and stripped managed group memberships' };
        }
        case 'grant_entitlement':
        case 'revoke_entitlement': {
          const result = await scimRequest(
            config,
            'PATCH',
            `${config.groupResourcePath}/${op.entitlementId}`,
            {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations:
                op.op === 'grant_entitlement'
                  ? [{ op: 'add', path: 'members', value: [{ value: op.anchor }] }]
                  : [{ op: 'remove', path: `members[value eq "${op.anchor}"]` }],
            },
          );
          if (result.status === 404) return { ok: false, message: 'no such entitlement', failure: 'not_found' };
          if (result.status >= 400) {
            return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
          }
          return { ok: true, message: op.op === 'grant_entitlement' ? 'granted' : 'revoked' };
        }
        default:
          throw new Error(`unsupported operation for the SCIM connector: ${(op as { op: string }).op}`);
```

Add the three remaining `TargetConnector` members to the object literal, after `write`, and remove the `as unknown as TargetConnector<Config>` cast at the end of the object literal (it is now a real, statically checked implementation):

```ts
  async *listEntitlements(rawConfig) {
    const config = normalise(rawConfig);
    let startIndex = 1;
    for (;;) {
      const result = await scimRequest(
        config,
        'GET',
        `${config.groupResourcePath}?startIndex=${startIndex}&count=${config.pageSize}`,
      );
      if (result.status >= 400) {
        throw new Error(`${config.groupResourcePath} answered HTTP ${result.status} while listing entitlements`);
      }
      const page = result.json as {
        Resources: { id: string; displayName: string }[];
        totalResults: number;
      };
      for (const group of page.Resources) {
        yield { externalId: group.id, dn: group.id, type: 'group' as const, displayName: group.displayName };
      }
      if (page.Resources.length < config.pageSize || startIndex + page.Resources.length > page.totalResults) {
        return;
      }
      startIndex += page.Resources.length;
    }
  },

  // eslint-disable-next-line require-yield -- SCIM has no organizational-unit
  // resource; an account is placed nowhere, so there is nothing to list. See
  // types.ts's own docstring: an empty set from a REACHABLE target has to be
  // returned as empty and not skipped, which this satisfies by construction —
  // there is no configuration flag that could make this connector behave
  // otherwise, unlike a target where an empty result is ambiguous.
  async *listContainers(_rawConfig) {
    return;
  },

  async readEntitlementMembers(rawConfig, entitlementDn) {
    const config = normalise(rawConfig);
    const result = await scimRequest(config, 'GET', `${config.groupResourcePath}/${entitlementDn}`);
    if (result.status >= 400) {
      throw new Error(`${config.groupResourcePath}/${entitlementDn} answered HTTP ${result.status}`);
    }
    const group = result.json as { members?: { value: string }[] };
    return (group.members ?? []).map((m) => m.value);
  },
```

- [ ] **Step 4: Run and confirm everything passes**

Run: `pnpm --filter @syntra/connectors test -- scim/connector`
Expected: PASS, 15/15.

- [ ] **Step 5: Typecheck — this is where the removed cast is checked for real**

Run: `pnpm typecheck`
Expected: PASS. If it fails, the error names exactly which `TargetConnector<Config>` member is missing or mismatched — the cast removed in Step 3 is what makes this check meaningful.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/scim/connector.ts packages/connectors/src/scim/connector.test.ts
git commit -m "connectors(scim): rename, archive, grant/revoke, and the entitlement/container reads — full TargetConnector"
```

---

### Task 6: The connector registry

**Files:**
- Create: `packages/connectors/src/registry.ts`
- Create: `packages/connectors/src/registry.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: `adTargetConnector`, `adTargetConfigSchema` (existing), `scimTargetConnector`, `scim2TargetConfigSchema` (Tasks 2–5).
- Produces: `TARGET_CONNECTOR_TYPES: readonly ['activeDirectory', 'scim2']`, `type TargetConnectorType`, `targetConnectorFor(type: string): TargetConnector<never>`, `targetConfigSchemaFor(type: string): z.ZodTypeAny`, `class UnknownTargetConnectorTypeError extends Error`. These four are what Tasks 7–8 replace every hard-coded `adTargetConnector`/`adTargetConfigSchema` reference with.

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/src/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TARGET_CONNECTOR_TYPES,
  targetConnectorFor,
  targetConfigSchemaFor,
  UnknownTargetConnectorTypeError,
} from './registry.js';
import { adTargetConnector } from './ad/connector.js';
import { scimTargetConnector } from './scim/connector.js';
import { adTargetConfigSchema } from './ad/config.js';
import { scim2TargetConfigSchema } from './scim/config.js';

describe('registry', () => {
  it('lists both connector types', () => {
    expect(TARGET_CONNECTOR_TYPES).toEqual(['activeDirectory', 'scim2']);
  });

  it('resolves activeDirectory to the AD connector and config schema', () => {
    expect(targetConnectorFor('activeDirectory')).toBe(adTargetConnector);
    expect(targetConfigSchemaFor('activeDirectory')).toBe(adTargetConfigSchema);
  });

  it('resolves scim2 to the SCIM connector and config schema', () => {
    expect(targetConnectorFor('scim2')).toBe(scimTargetConnector);
    expect(targetConfigSchemaFor('scim2')).toBe(scim2TargetConfigSchema);
  });

  it('refuses a type nothing implements, by name', () => {
    expect(() => targetConnectorFor('okta')).toThrow(UnknownTargetConnectorTypeError);
    expect(() => targetConnectorFor('okta')).toThrow(/okta/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/connectors test -- registry`
Expected: FAIL — `Cannot find module './registry.js'`.

- [ ] **Step 3: Implement the registry**

Create `packages/connectors/src/registry.ts`:

```ts
import type { z } from 'zod';
import type { TargetConnector } from './types.js';
import { adTargetConnector } from './ad/connector.js';
import { adTargetConfigSchema } from './ad/config.js';
import { scimTargetConnector } from './scim/connector.js';
import { scim2TargetConfigSchema } from './scim/config.js';

/**
 * Every `TargetSystem.type` this package can read. A plain lookup, not
 * reflection or a plugin loader — `target-service.ts`'s own comment on
 * `TARGET_TYPES` says why: "a second connector family needs no migration"
 * refers to the database column, not to this list, which is exactly as
 * closed as `adTargetConnector` being the only thing `target-service.ts`
 * imported before this file existed. Adding a third connector is one more
 * entry in each of the two records below, not a new mechanism.
 */
export const TARGET_CONNECTOR_TYPES = ['activeDirectory', 'scim2'] as const;
export type TargetConnectorType = (typeof TARGET_CONNECTOR_TYPES)[number];

export class UnknownTargetConnectorTypeError extends Error {
  constructor(readonly type: string) {
    super(
      `no target connector implements type "${type}"; known types are ${TARGET_CONNECTOR_TYPES.join(', ')}`,
    );
    this.name = 'UnknownTargetConnectorTypeError';
  }
}

const CONNECTORS: Record<TargetConnectorType, TargetConnector<never>> = {
  activeDirectory: adTargetConnector as unknown as TargetConnector<never>,
  scim2: scimTargetConnector as unknown as TargetConnector<never>,
};

const CONFIG_SCHEMAS: Record<TargetConnectorType, z.ZodTypeAny> = {
  activeDirectory: adTargetConfigSchema,
  scim2: scim2TargetConfigSchema,
};

function isKnownType(type: string): type is TargetConnectorType {
  return (TARGET_CONNECTOR_TYPES as readonly string[]).includes(type);
}

export function targetConnectorFor(type: string): TargetConnector<never> {
  if (!isKnownType(type)) throw new UnknownTargetConnectorTypeError(type);
  return CONNECTORS[type];
}

export function targetConfigSchemaFor(type: string): z.ZodTypeAny {
  if (!isKnownType(type)) throw new UnknownTargetConnectorTypeError(type);
  return CONFIG_SCHEMAS[type];
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @syntra/connectors test -- registry`
Expected: PASS, 4/4.

- [ ] **Step 5: Export and typecheck**

`packages/connectors/src/index.ts` — add:

```ts
export * from './registry.js';
```

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/registry.ts packages/connectors/src/registry.test.ts packages/connectors/src/index.ts
git commit -m "connectors: a type-to-connector registry, so a second target type needs no new mechanism"
```

---

### Task 7: `target-service.ts` selects by type instead of hard-coding Active Directory

**Files:**
- Modify: `packages/core/src/provision/target-service.ts`
- Modify: `packages/core/src/provision/target-service.schemas.test.ts`

**Interfaces:**
- Consumes: `targetConnectorFor`, `targetConfigSchemaFor`, `TARGET_CONNECTOR_TYPES` (Task 6).
- Produces: `createTarget`/`updateTarget`/`targetWithCredential`/`testTargetConfiguration` now accept and store either `activeDirectory` or `scim2` targets. `targetWithCredential`'s return type widens from `AdTargetConfig & { bindPassword: string }` to `Record<string, unknown> & { bindPassword: string }` — Task 8 is what narrows it back down per call site.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/provision/target-service.schemas.test.ts` (the file's existing imports and `withTenant`/fixture-setup helpers are reused as they already are for the `activeDirectory` cases in this file — read the file's top matter before writing this, since the exact fixture helper names must match what is already there):

```ts
describe('createTarget — scim2', () => {
  it('accepts a scim2 target with a scim2-shaped config', async () => {
    const created = await createTarget(tenantId, provider, actorUserId, {
      name: 'Example SaaS',
      type: 'scim2',
      config: { baseUrl: 'https://api.example.test/scim/v2', bearerToken: 'unused-at-create' },
      bindPassword: 'the-bearer-token',
    });
    expect(created.id).toBeDefined();
  });

  it('refuses a scim2 target configured with Active Directory fields', async () => {
    await expect(
      createTarget(tenantId, provider, actorUserId, {
        name: 'Bad',
        type: 'scim2',
        config: { url: 'ldaps://dc.acme.test', bindDn: 'CN=svc', baseDn: 'DC=acme' },
        bindPassword: 'x',
      }),
    ).rejects.toThrow();
  });
});
```

(This step assumes `tenantId`, `provider`, `actorUserId` fixtures already exist in the file for the `activeDirectory` describe block above it — confirm by reading the file; if the existing block uses different fixture names, use those instead, since Step 1's job is to fail for the right reason, not to introduce a second fixture convention.)

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/core test -- target-service.schemas`
Expected: FAIL — `createTarget` throws on `type: 'scim2'` because `createScalarsSchema`'s `z.enum(TARGET_TYPES)` (`target-service.ts:144`) only accepts `'activeDirectory'`.

- [ ] **Step 3: Replace the hard-coded type list and config parsing**

`packages/core/src/provision/target-service.ts` — imports at the top: replace

```ts
import {
  adTargetConfigSchema,
  adTargetConnector,
  type AdTargetConfig,
  type ConnectionResult,
} from '@syntra/connectors';
```

with

```ts
import {
  targetConnectorFor,
  targetConfigSchemaFor,
  TARGET_CONNECTOR_TYPES,
  type ConnectionResult,
} from '@syntra/connectors';
```

Replace the `TARGET_TYPES` constant and its comment (`target-service.ts:102-113`):

```ts
/**
 * Every `type` this service can honestly store — read from the connector
 * registry (`@syntra/connectors`) rather than restated here, so a third
 * connector is one entry in `registry.ts` and needs no change in this file.
 */
const TARGET_TYPES = TARGET_CONNECTOR_TYPES;
```

Replace every `adTargetConfigSchema.parse(...)` call site in this file — `createTarget` (`:349`), `updateTarget` (`:426`), `targetWithCredential` (`:639`), `testTargetConfiguration` (`:683`) — with a parse resolved from the target's own (or the input's own) `type`:

In `createTarget`:

```ts
export async function createTarget(
  tenantId: string,
  provider: MasterKeyProvider,
  actorUserId: string | null,
  input: CreateTargetInput,
  scheduler?: Scheduler,
): Promise<{ id: string }> {
  const scalars = createScalarsSchema.parse(input);
  const config = targetConfigSchemaFor(scalars.type).parse(input.config);
  // ... unchanged below this point except every later reference to
  // `scalars.type` (already present at the `type: scalars.type` line in the
  // `tx.targetSystem.create` call) is unchanged, since it already used the
  // parsed scalar rather than a literal.
```

In `updateTarget`, the parse becomes conditional on whichever type applies — the target's existing stored type when the caller does not change it, the input's new type when they do:

```ts
  const before = await withTenant(tenantId, (tx) => tx.targetSystem.findUnique({ where: { id: targetId } }));
  if (!before) throw new TargetNotFoundError(targetId);
  const effectiveType = input.type ?? before.type;
  const config =
    input.config === undefined ? undefined : targetConfigSchemaFor(effectiveType).parse(input.config);
```

This introduces a second `findUnique` ahead of the existing transaction in `updateTarget` (the existing one at `:452` inside `withTenant` still runs and is the one that actually gates the write — this new read is purely to learn `effectiveType` before parsing, and is not a substitute for the transactional read). Note this explicitly in a comment above it:

```ts
  // A read OUTSIDE the transaction, only to learn which schema to parse
  // `input.config` against before the transaction opens. The transactional
  // read at `withTenant`'s `before` below is still what the write is gated
  // on; a target deleted between these two reads fails there, as it always
  // did.
```

In `targetWithCredential`, resolve the schema from the stored row's own `type` rather than assuming Active Directory, and widen the return type:

```ts
export async function targetWithCredential(
  tx: TenantClient,
  provider: MasterKeyProvider,
  targetId: string,
): Promise<(Record<string, unknown> & { bindPassword: string }) | null> {
  const target = await tx.targetSystem.findUnique({ where: { id: targetId } });
  if (!target) return null;
  const bindPassword = await getSecret(tx, provider, target.secretName);
  if (bindPassword === null) return null;
  return {
    ...(targetConfigSchemaFor(target.type).parse(target.config) as Record<string, unknown>),
    bindPassword,
  };
}
```

In `testTargetConfiguration`, the caller now supplies `type` explicitly (it has no saved row to read one from when testing a not-yet-created target), and the borrow-comparison logic (`savedConfig.url`/`tlsMode`/`rejectUnauthorized`) is Active-Directory-specific and must only run when both sides are the same type:

```ts
export async function testTargetConfiguration(
  tenantId: string,
  provider: MasterKeyProvider,
  input: { type: string; config: unknown; bindPassword?: string; borrowFromTargetId?: string },
): Promise<ConnectionResult> {
  const config = targetConfigSchemaFor(input.type).parse(input.config);
  const scalars = testScalarsSchema.parse(input);

  let bindPassword = scalars.bindPassword;
  if (bindPassword === undefined) {
    if (scalars.borrowFromTargetId === undefined) {
      return { ok: false, message: 'no credential supplied and none to borrow' };
    }
    const borrowFromTargetId = scalars.borrowFromTargetId;
    const saved = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.findUnique({ where: { id: borrowFromTargetId } });
      if (!target) return null;
      if (target.type !== input.type) return 'mismatch' as const;
      // The Active-Directory-specific transport comparison — url, tlsMode,
      // rejectUnauthorized — only makes sense for that connector's own config
      // shape; a type match is asserted above first, so this cast is sound.
      if (input.type === 'activeDirectory') {
        const savedConfig = targetConfigSchemaFor(target.type).parse(target.config) as {
          url: string;
          tlsMode: string;
          rejectUnauthorized: boolean;
        };
        const requested = config as { url: string; tlsMode: string; rejectUnauthorized: boolean };
        if (
          savedConfig.url.trim() !== requested.url.trim() ||
          savedConfig.tlsMode !== requested.tlsMode ||
          savedConfig.rejectUnauthorized !== requested.rejectUnauthorized
        ) {
          return 'mismatch' as const;
        }
      }
      return getSecret(tx, provider, target.secretName);
    });
    if (saved === 'mismatch') {
      return {
        ok: false,
        message: 'a saved credential can only be borrowed for a target of the same type and, for Active Directory, the same transport',
      };
    }
    if (saved === null) return { ok: false, message: 'no saved credential' };
    bindPassword = saved;
  }

  return targetConnectorFor(input.type).test({ ...config, bindPassword } as never);
}
```

And `createScalarsSchema`'s `type` field (`:144`) changes from a hard-coded default to requiring the caller state it (a default of `'activeDirectory'` silently on every create is what let a `scim2`-shaped body accidentally validate as Active Directory before this task; explicit is safer once there are two):

```ts
  type: z.enum(TARGET_TYPES),
```

`CreateTargetInput.type` (`:120`) drops its `?` — it is no longer optional:

```ts
export interface CreateTargetInput {
  name: string;
  type: string;
  config: unknown;
  ...
```

- [ ] **Step 4: Run and confirm the new tests pass, then the whole file**

Run: `pnpm --filter @syntra/core test -- target-service.schemas`
Expected: PASS, including the two new `scim2` cases.

Run: `pnpm --filter @syntra/core test -- target-service`
Expected: PASS — this is where an existing `activeDirectory` test that relied on `type` defaulting is caught if one exists; if any fail for that reason, add `type: 'activeDirectory'` to that test's input rather than restoring the default, since the whole point of this step is that a create states its type.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. `AdTargetConfig` is no longer imported in this file — if any other file in `@syntra/core` imported it re-exported from `target-service.ts` (unlikely, since it was never re-exported from here, only imported), this step's failure would name it.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/provision/target-service.ts packages/core/src/provision/target-service.schemas.test.ts
git commit -m "provision: target-service selects the connector and config schema by TargetSystem.type"
```

---

### Task 8: `apply.ts`, `run-service.ts`, `entitlement-service.ts` select the connector by the target's own type

**Files:**
- Modify: `packages/core/src/provision/apply.ts`
- Modify: `packages/core/src/provision/apply.test.ts`
- Modify: `packages/core/src/provision/run-service.ts`
- Modify: `packages/core/src/provision/entitlement-service.ts`

**Interfaces:**
- Consumes: `targetConnectorFor` (Task 6).
- Produces: no signature change — `applyProvisionRun`, `resolveInFlightActions`, the preview/plan phase in `run-service.ts`, and `refreshEntitlements` in `entitlement-service.ts` all keep their existing exported signatures; only which connector they call by default changes, from a hard-coded `adTargetConnector` to one resolved from the run's own `target.type`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/provision/apply.test.ts` (reusing the file's existing `withTenant`/fixture/`FakeTarget`-style helpers — read the file's existing Active-Directory apply test immediately before this one to match its setup shape, since `applyProvisionRun`'s `options.connector` override is already exercised there and this test is its SCIM sibling):

```ts
it('applies a create_account action against a scim2 target using the registry-resolved connector, with no options.connector override', async () => {
  const server = await startFakeScimServer({ bearerToken: 'tok' });
  try {
    const { targetId, runId } = await seedScim2RunReadyToApply(server.baseUrl, 'tok');
    const result = await applyProvisionRun(tenantId, provider, runId, {
      confirm: true,
      confirmedByUserId: actorUserId,
    });
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({ where: { targetSystemId: targetId } }),
    );
    expect(account.status).toBe('active');
    expect(server.users.size).toBe(1);
  } finally {
    await server.close();
  }
});
```

This test calls a `seedScim2RunReadyToApply` helper that does not exist yet — write it in the same file, modelled directly on whatever existing helper seeds the Active-Directory apply tests' `targetId`/`runId` fixtures (read that helper first; the shape below assumes one named similarly to `seedRunReadyToApply` exists and takes a target config plus a `create_account` action):

```ts
async function seedScim2RunReadyToApply(
  baseUrl: string,
  bearerToken: string,
): Promise<{ targetId: string; runId: string }> {
  const { id: targetId } = await createTarget(tenantId, provider, actorUserId, {
    name: 'SCIM Test Target',
    type: 'scim2',
    config: { baseUrl, bearerToken },
    bindPassword: bearerToken,
  });
  // ... the remainder mirrors the existing Active-Directory helper: create a
  // ProvisionRun row, a ProvisionAction row of type create_account with
  // `after: { correlationKey: 'jdoe', container: '', attributes: {} }` and
  // `accountId` pointing at a reserved TargetAccount row — copy that shape
  // exactly from the AD helper rather than re-deriving it, since `apply.ts`'s
  // `toWriteOperation`/`readActionContext` read those columns by name and any
  // divergence from the AD fixture's shape fails for an unrelated reason.
  return { targetId, runId: /* the created ProvisionRun's id */ '' };
}
```

(Note for the engineer executing this task: the elided middle of `seedScim2RunReadyToApply` must be filled in by copying the equivalent Active-Directory fixture helper in this same test file, changing only the target's `type`/`config`/`bindPassword` — this is stated as a copy instruction rather than invented content because the exact `ProvisionRun`/`ProvisionAction`/`TargetAccount` row shapes this test needs already exist, verified, in that helper, and restating them here from outside the file risks drifting from Prisma's actual schema.)

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/core test -- apply.test`
Expected: FAIL — the SCIM target's `create_account` action is attempted against `adTargetConnector` (LDAP), which throws or times out trying to bind to a URL that is not a directory.

- [ ] **Step 3: `apply.ts` — resolve the connector from the target's type**

`packages/core/src/provision/apply.ts` — replace the import:

```ts
import {
  targetConnectorFor,
  isRetryable,
  provenanceActionId,
  SYNTRA_ONLY_ACTION_TYPES,
  type SourceRecord,
  type TargetConnector,
  type WriteOperation,
  type WriteResult,
} from '@syntra/connectors';
```

In `applyProvisionRun`, the connector is resolved from `prepared.target.type` once the target has been read (previously it was resolved before the transactional read, from nothing but the hard-coded import) — move connector resolution from before the `prepared` block to after it, and keep `options.connector` as the override it already is:

```ts
  const prepared = await withTenant(tenantId, async (tx) => {
    // ... unchanged body, still returns { run, target, config, profile, remit, grantedEntitlements }
  });

  const connector = (options.connector ??
    targetConnectorFor(prepared.target.type)) as unknown as TargetConnector<unknown>;
```

(This removes the old `const connector = (options.connector ?? adTargetConnector) as ...` line that previously sat before `prepared` was computed — resolving it after is what makes it type-aware instead of a fixed default, and it costs nothing since `connector` is not used until the per-action loop below, which already runs after `prepared` resolves.)

In `resolveInFlightActions`, the same substitution — the function already reads `targetSystemId` as a parameter, so the target's `type` is available from the same `withTenant` block that already reads `actions`:

```ts
export async function resolveInFlightActions(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  options: { connector?: TargetConnector<never> } = {},
): Promise<number> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const actions = await tx.provisionAction.findMany({
      where: { status: 'in_flight', run: { targetSystemId } },
      orderBy: { sequence: 'asc' },
    });
    if (actions.length === 0) return { config: null, actions, targetType: null };
    const target = await tx.targetSystem.findUniqueOrThrow({ where: { id: targetSystemId } });
    const config = await targetWithCredential(tx, provider, targetSystemId);
    if (!config) throw new Error('target configuration or credential missing');
    return { config, actions, targetType: target.type };
  });

  if (prepared.actions.length === 0) return 0;
  const connector = (options.connector ??
    targetConnectorFor(prepared.targetType!)) as unknown as TargetConnector<unknown>;
```

(replacing the earlier `const connector = (options.connector ?? adTargetConnector) as ...` line that sat above the `prepared` computation; every later reference to `connector` and `prepared.config` in this function is otherwise unchanged.)

- [ ] **Step 4: `run-service.ts` — same substitution at its one call site**

`packages/core/src/provision/run-service.ts:3-4,414` — replace the `adTargetConnector` import with `targetConnectorFor` from `@syntra/connectors`, and at line 414 replace

```ts
    adTargetConnector) as unknown as TargetConnector<unknown>;
```

with a version resolved from whatever local variable that function already holds the target's row in (read the surrounding ~20 lines of `run-service.ts:390-420` before editing, since the exact variable name — `target`, `row`, or similar — must match what is already in scope there rather than being invented):

```ts
    targetConnectorFor(target.type)) as unknown as TargetConnector<unknown>;
```

- [ ] **Step 5: `entitlement-service.ts` — the catalog-refresh default**

`packages/core/src/provision/entitlement-service.ts:3-4,156` — replace the `adTargetConnector` import with `targetConnectorFor`, and change

```ts
  connector: EntitlementReader = adTargetConnector,
```

A default *value* cannot be "resolved by type" without a type to resolve from, so this call site needs its caller to pass one explicitly rather than relying on a parameter default — read the function's signature and its callers first (grep `refreshEntitlements(` across `packages/core/src` and `apps/api/src`) to confirm every caller already has the target row in scope (it does: entitlement refresh is always invoked with a `targetId` a caller has just loaded the target for). Change the parameter from a defaulted value to a required one, and update every call site to pass `targetConnectorFor(target.type)`:

```ts
export async function refreshEntitlements(
  tenantId: string,
  targetId: string,
  connector: EntitlementReader,
  // ... rest of the existing signature, unchanged
```

- [ ] **Step 6: Run the full provision suite**

Run: `pnpm --filter @syntra/core test -- provision`
Expected: PASS, including the new SCIM apply test from Step 1 and every existing Active-Directory test (which now resolves `adTargetConnector` through the registry instead of by direct import, and must produce the identical outcome it did before this task — this is the zero-behavior-change guarantee the Priority Roadmap promises for Active Directory).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/provision/apply.ts packages/core/src/provision/apply.test.ts packages/core/src/provision/run-service.ts packages/core/src/provision/entitlement-service.ts
git commit -m "provision: apply, run-service and entitlement-service resolve their connector from the target's own type"
```

---

### Task 9: The attribute-name regex, and the console's type picker

**Files:**
- Modify: `packages/core/src/provision/target-service.ts` (the `LDAP_ATTRIBUTE_NAME` regex, `:795`)
- Modify: `apps/web/src/pages/admin/TargetDetailPage.tsx`
- Modify: `apps/web/src/pages/admin/TargetDetailPage.test.tsx`
- Modify: `apps/web/src/pages/admin/TargetsPage.tsx`
- Modify: `apps/web/src/pages/admin/TargetsPage.test.tsx`

**Interfaces:**
- Consumes: the `type` field `createTarget`/`updateTarget` now require (Task 7).
- Produces: an administrator can create and edit a `scim2` target from the console, with a form matching `scim2TargetConfigSchema`'s fields, and both target types are visually distinguishable in the list.

- [ ] **Step 1: Broaden the attribute-name pattern**

`packages/core/src/provision/target-service.ts:795` — the comment above `LDAP_ATTRIBUTE_NAME` explains it as "RFC 4512 `descr`: a letter, then letters, digits and hyphens", which SCIM's dotted sub-attribute paths (`name.givenName`) do not satisfy. Replace:

```ts
/** RFC 4512 `descr`: a letter, then letters, digits and hyphens. */
const LDAP_ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
```

with

```ts
/**
 * RFC 4512 `descr` (a letter, then letters, digits and hyphens) — Active
 * Directory's attribute names — OR a dotted path of the same shape (SCIM's
 * `name.givenName`, `name.familyName`). Active Directory never produces a
 * dotted name, so widening this to allow one changes nothing for that
 * connector; it is what lets a `scim2` target's attribute profile name a
 * sub-attribute of SCIM's core User schema at all.
 */
const LDAP_ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;
```

- [ ] **Step 2: Run the existing target-service tests to confirm no regression**

Run: `pnpm --filter @syntra/core test -- target-service`
Expected: PASS — every existing plain (non-dotted) attribute name still matches; add one direct unit assertion to `target-service.test.ts` if the file has a dedicated case for `attributeTemplatesSchema`, asserting `name.givenName` is now accepted and `..bad` is still refused.

- [ ] **Step 3: Read the existing AD-only form before changing it**

Read `apps/web/src/pages/admin/TargetDetailPage.tsx` in full (it was only grepped, not read, during this plan's grounding — the exact `form` state shape, the `set`/`mark` helpers, and the save handler's request body must be understood before this step edits them, since restating them from outside the file risks drifting from the component's real prop and state names).

- [ ] **Step 4: Write the failing test for the type picker**

Add to `apps/web/src/pages/admin/TargetDetailPage.test.tsx`, following that file's existing render/interaction pattern for the create-target flow:

```tsx
it('shows the SCIM field group instead of the Active Directory fields when scim2 is selected', async () => {
  renderTargetDetailPage({ mode: 'create' });
  await userEvent.selectOptions(screen.getByLabelText(/type/i), 'scim2');
  expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/bind dn/i)).not.toBeInTheDocument();
});

it('submits a scim2 create with the scim2-shaped config', async () => {
  const onSave = renderTargetDetailPage({ mode: 'create' });
  await userEvent.type(screen.getByLabelText(/name/i), 'Example SaaS');
  await userEvent.selectOptions(screen.getByLabelText(/type/i), 'scim2');
  await userEvent.type(screen.getByLabelText(/base url/i), 'https://api.example.test/scim/v2');
  await userEvent.type(screen.getByLabelText(/bearer token/i), 'tok-123');
  await userEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'scim2',
      config: expect.objectContaining({ baseUrl: 'https://api.example.test/scim/v2' }),
      bindPassword: 'tok-123',
    }),
  );
});
```

(`renderTargetDetailPage` here stands for whatever this test file's existing render helper is already named — use that name, not this one, once Step 3's read confirms it.)

- [ ] **Step 5: Run to see it fail**

Run: `pnpm --filter @syntra/web test -- TargetDetailPage`
Expected: FAIL — there is no `/type/i` labelled control yet; the form is unconditionally Active-Directory-shaped.

- [ ] **Step 6: Add the type picker and the SCIM field group**

In `TargetDetailPage.tsx`, add a `type` field to the component's existing form state (defaulting to `'activeDirectory'` on create, and to the loaded target's own `type` on edit — read-only on edit, since Task 7's `target-service.ts` still accepts a `type` change on update but changing a target's connector type after accounts exist is a decision this plan does not design a migration story for, so the console does not offer it):

```tsx
<label>
  Type
  <select
    aria-label="Type"
    value={form.type}
    onChange={(e) => set('type', e.target.value)}
    disabled={mode === 'edit'}
  >
    <option value="activeDirectory">Active Directory</option>
    <option value="scim2">SCIM 2.0</option>
  </select>
</label>

{form.type === 'activeDirectory' ? (
  <>
    {/* the existing bindDn/baseDn/entitlementSearchBase/... field group, unchanged */}
  </>
) : (
  <>
    <label>
      Base URL
      <input
        aria-label="Base URL"
        value={form.baseUrl}
        onChange={(e) => set('baseUrl', e.target.value)}
      />
    </label>
    <label>
      Bearer token
      <input
        aria-label="Bearer token"
        type="password"
        value={form.bearerToken}
        onChange={(e) => set('bearerToken', e.target.value)}
      />
    </label>
  </>
)}
```

Update the component's initial form state to include `type: 'activeDirectory'`, `baseUrl: ''`, `bearerToken: ''` alongside the existing AD fields (mirroring how `bindDn`/`baseDn`/`entitlementSearchBase` are already initialised at the file's existing default-state object).

Update the save handler to build `config`/`bindPassword` from whichever field group is active:

```tsx
const config =
  form.type === 'activeDirectory'
    ? {
        url: form.url.trim(),
        bindDn: form.bindDn.trim(),
        baseDn: form.baseDn.trim(),
        entitlementSearchBase: form.entitlementSearchBase.trim(),
        // ... the rest of the existing AD config assembly, unchanged
      }
    : { baseUrl: form.baseUrl.trim() };
const bindPassword = form.type === 'activeDirectory' ? form.bindPassword : form.bearerToken;
onSave({ name: form.name.trim(), type: form.type, config, bindPassword });
```

- [ ] **Step 7: Run and confirm it passes**

Run: `pnpm --filter @syntra/web test -- TargetDetailPage`
Expected: PASS.

- [ ] **Step 8: The list page's type badge**

Read `apps/web/src/pages/admin/TargetsPage.tsx` for its existing `TargetRow` interface and table-row rendering (already partly read during this plan's grounding — the `TargetRow` interface at lines 13-24 has no `type` field yet). Add one:

```ts
interface TargetRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  // ... unchanged
}
```

Add a badge cell rendering `target.type === 'activeDirectory' ? 'Active Directory' : 'SCIM 2.0'` beside the existing name cell, following this file's existing `Status`/badge component usage for the health column.

Add a corresponding assertion to `TargetsPage.test.tsx`'s existing fixture-row test, asserting the badge text renders for both a `type: 'activeDirectory'` and a `type: 'scim2'` row.

- [ ] **Step 9: Run the full web suite for these two files, then typecheck**

Run: `pnpm --filter @syntra/web test -- TargetDetailPage TargetsPage`
Expected: PASS.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/provision/target-service.ts apps/web/src/pages/admin/TargetDetailPage.tsx apps/web/src/pages/admin/TargetDetailPage.test.tsx apps/web/src/pages/admin/TargetsPage.tsx apps/web/src/pages/admin/TargetsPage.test.tsx
git commit -m "console: a target-system type picker and SCIM 2.0 field group; the AD-only attribute-name regex now allows a dotted SCIM sub-attribute path"
```

---

## Part B: Business Rules Console — Compound Condition Editor

### Task 10: Recursive `ConditionDraft` type and pure round-trip functions

**Files:**
- Modify: `apps/web/src/pages/admin/BusinessRulesPage.tsx`
- Modify: `apps/web/src/pages/admin/BusinessRulesPage.test.tsx`

**Interfaces:**
- Produces: `type ConditionDraft = LeafDraft | GroupDraft | NotDraft` (exported), `draftConditionFrom(raw: unknown): ConditionDraft`, `conditionOf(node: ConditionDraft): unknown`, `describeCondition(raw: unknown): string` — all exported for Task 12's `ConditionGroupEditor` and for direct unit testing.

The existing `Draft` type (lines 110-119) is single-leaf: `field`, `op`, `value` sit directly on it. `condition.ts`'s `Condition` (lines 52-59) is a recursive `{all:[]} | {any:[]} | {not:} | leaf`. This task adds the recursive draft shape and the three pure functions that convert between it and the stored JSON, without touching the component's render yet — that is Tasks 12–13. `Draft.field/op/value` stay in place until Task 11 removes them, so this task is additive only.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/pages/admin/BusinessRulesPage.test.tsx` (new `describe` block; the file already imports `render`/`screen` from testing-library and mocks `api` — follow its existing mock-setup pattern for the two new imports):

```tsx
import {
  conditionOf,
  describeCondition,
  draftConditionFrom,
  type ConditionDraft,
} from './BusinessRulesPage.js';

describe('condition draft round-trip', () => {
  it('converts a single leaf both ways, unchanged', () => {
    const stored = { field: 'contract.department', op: 'equals', value: 'Finance' };
    const draft = draftConditionFrom(stored);
    expect(draft).toEqual({
      kind: 'leaf',
      field: 'contract.department',
      op: 'equals',
      value: 'Finance',
    });
    expect(conditionOf(draft)).toEqual(stored);
  });

  it('converts a 3-level nested all/any/not tree both ways, unchanged', () => {
    const stored = {
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        {
          any: [
            { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
            { not: { field: 'person.status', op: 'isEmpty' } },
          ],
        },
      ],
    };
    const draft = draftConditionFrom(stored);
    expect(conditionOf(draft)).toEqual(stored);
  });

  it('falls back to a blank leaf for an unrecognised shape rather than throwing', () => {
    const draft = draftConditionFrom({ nonsense: true });
    expect(draft).toEqual({
      kind: 'leaf',
      field: 'contract.department',
      op: 'equals',
      value: '',
    });
  });

  it('describes a compound condition in full instead of the opaque placeholder', () => {
    const stored = {
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
      ],
    };
    expect(describeCondition(stored)).toBe(
      '(contract.department is Finance) AND (contract.fte is greater than 0.5)',
    );
  });

  it('matches evaluateCondition-\\`s own reading of an empty all as true, empty any as false', () => {
    expect(describeCondition({ all: [] })).toBe('always');
    expect(describeCondition({ any: [] })).toBe('never');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/web test -- BusinessRulesPage`
Expected: FAIL — `conditionOf`, `describeCondition`, `draftConditionFrom` are not exported yet.

- [ ] **Step 3: Add the types and functions**

In `apps/web/src/pages/admin/BusinessRulesPage.tsx`, immediately after the existing `Operator`/`kindOf` declarations (after line 108) and before the current `interface Draft` (line 110), add:

```ts
export interface LeafDraft {
  kind: 'leaf';
  field: (typeof FIELDS)[number];
  op: Operator;
  value: string;
}
export interface GroupDraft {
  kind: 'group';
  combinator: 'all' | 'any';
  children: ConditionDraft[];
}
export interface NotDraft {
  kind: 'not';
  child: ConditionDraft;
}
export type ConditionDraft = LeafDraft | GroupDraft | NotDraft;

const BLANK_LEAF: LeafDraft = {
  kind: 'leaf',
  field: 'contract.department',
  op: 'equals',
  value: '',
};

/** A stored condition (any shape `conditionSchema` in `condition.ts` accepts), into the tree this editor writes. Recognises nothing outside `all`/`any`/`not`/leaf and falls back to a blank leaf rather than throwing — a rule column written by an older version of this page, or by hand, must still open. */
export function draftConditionFrom(raw: unknown): ConditionDraft {
  const node = (raw ?? {}) as {
    all?: unknown[];
    any?: unknown[];
    not?: unknown;
    field?: string;
    op?: string;
    value?: unknown;
  };
  if (Array.isArray(node.all)) {
    return { kind: 'group', combinator: 'all', children: node.all.map(draftConditionFrom) };
  }
  if (Array.isArray(node.any)) {
    return { kind: 'group', combinator: 'any', children: node.any.map(draftConditionFrom) };
  }
  if (node.not !== undefined) {
    return { kind: 'not', child: draftConditionFrom(node.not) };
  }
  const field = (FIELDS as readonly string[]).includes(node.field ?? '')
    ? (node.field as LeafDraft['field'])
    : 'contract.department';
  const op = OPERATORS.some((o) => o.value === node.op) ? (node.op as Operator) : 'equals';
  return {
    kind: 'leaf',
    field,
    op,
    value: Array.isArray(node.value)
      ? node.value.join(', ')
      : node.value === undefined || node.value === null
        ? ''
        : String(node.value),
  };
}

/** The tree back into the JSON shape `conditionSchema` accepts. Mirrors the single-leaf conversion the old `conditionOf` did, plus the two combinators. */
export function conditionOf(node: ConditionDraft): unknown {
  if (node.kind === 'group') {
    return { [node.combinator]: node.children.map(conditionOf) };
  }
  if (node.kind === 'not') {
    return { not: conditionOf(node.child) };
  }
  const kind = kindOf(node.op);
  if (kind === 'none') return { field: node.field, op: node.op };
  if (kind === 'list') {
    return {
      field: node.field,
      op: node.op,
      value: node.value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    };
  }
  if (kind === 'number') return { field: node.field, op: node.op, value: Number(node.value) };
  return { field: node.field, op: node.op, value: node.value };
}

/** A human-readable rendering of any stored condition, replacing the old `'a compound condition'` placeholder. Matches `evaluate()`'s own reading in `condition.ts`: an empty `all` is `always` (true of everybody), an empty `any` is `never`. */
export function describeCondition(raw: unknown): string {
  const node = (raw ?? {}) as {
    all?: unknown[];
    any?: unknown[];
    not?: unknown;
    field?: string;
    op?: string;
    value?: unknown;
  };
  if (Array.isArray(node.all)) {
    if (node.all.length === 0) return 'always';
    return node.all.map(describeCondition).map((s) => `(${s})`).join(' AND ');
  }
  if (Array.isArray(node.any)) {
    if (node.any.length === 0) return 'never';
    return node.any.map(describeCondition).map((s) => `(${s})`).join(' OR ');
  }
  if (node.not !== undefined) return `NOT (${describeCondition(node.not)})`;
  const label = OPERATORS.find((o) => o.value === node.op)?.label ?? node.op;
  const value = Array.isArray(node.value) ? node.value.join(', ') : node.value;
  return `${node.field} ${label}${value === undefined ? '' : ` ${String(value)}`}`;
}
```

- [ ] **Step 4: Run and confirm the new tests pass**

Run: `pnpm --filter @syntra/web test -- BusinessRulesPage`
Expected: PASS on the new `describe('condition draft round-trip', ...)` block. The existing tests in this file still reference the old flat `Draft`/`draftFrom`/`conditionOf`/`describe` and are expected to still pass unmodified — they are rewired in Task 11.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src/pages/admin/BusinessRulesPage.tsx apps/web/src/pages/admin/BusinessRulesPage.test.tsx
git commit -m "console(business-rules): recursive ConditionDraft type and lossless round-trip functions, additive"
```

---

### Task 11: Wire `Draft.condition` in, retire the flat `field`/`op`/`value`

**Files:**
- Modify: `apps/web/src/pages/admin/BusinessRulesPage.tsx`
- Modify: `apps/web/src/pages/admin/BusinessRulesPage.test.tsx`

**Interfaces:**
- Consumes: `ConditionDraft`, `draftConditionFrom`, `conditionOf`, `describeCondition` (Task 10).
- Produces: `Draft.condition: ConditionDraft`, replacing `Draft.field`/`Draft.op`/`Draft.value`. `bodyOf`, `draftFrom`, `describe`, `BLANK` all updated to match — this is the interface every later task in Part B assumes.

- [ ] **Step 1: Update the failing tests first**

The existing tests in `BusinessRulesPage.test.tsx` construct fixture rules and assert on the rendered field/operator/value controls by their old flat shape. Update the fixture-construction helper (wherever this file builds a `StoredRule` for its render tests — read the file to find it; it already exists since the file has passing tests today) so a single-leaf fixture's `condition` is unchanged in shape (`{ field, op, value }`, the same wire format Task 10's `conditionOf` still produces for a plain leaf) — no fixture data changes, only the assertions that reached into `Draft.field` directly need to go through `screen.getByLabelText('Field')` etc., which they already should if the tests render the page rather than reach into component state.

Add one new assertion to the existing "loads an existing rule into the editor" test (or the nearest equivalent): after loading a rule whose stored `condition` is `{ all: [...] }`, the rendered read-only list row for that rule should show the full `describeCondition` output, not the string `'a compound condition'`. This is the regression test for the defect this plan exists to close:

```tsx
it('shows a compound condition in full, not the opaque placeholder', async () => {
  mockRules([
    {
      id: 'r1',
      name: 'Finance staff',
      description: null,
      condition: {
        all: [
          { field: 'contract.department', op: 'equals', value: 'Finance' },
          { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
        ],
      },
      grantsAccount: true,
      enabled: true,
      entitlements: [],
    },
  ]);
  render(<BusinessRulesPage />);
  expect(
    await screen.findByText(
      '(contract.department is Finance) AND (contract.fte is greater than 0.5)',
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText('a compound condition')).not.toBeInTheDocument();
});
```

(`mockRules` here stands for whatever this test file's existing helper for stubbing the `GET /api/admin/targets/:id/rules` response is already named — use that name, not this one, once Step 2's read confirms it.)

- [ ] **Step 2: Run to see the new test fail**

Run: `pnpm --filter @syntra/web test -- BusinessRulesPage`
Expected: FAIL — the placeholder string is still what renders.

- [ ] **Step 3: Replace `Draft` and rewire `BLANK`/`draftFrom`/`bodyOf`/`describe`**

Replace the existing `Draft` interface (lines 110-119) with:

```ts
interface Draft {
  id?: string;
  name: string;
  condition: ConditionDraft;
  grantsAccount: boolean;
  enabled: boolean;
  entitlementIds: string[];
}
```

Replace `BLANK` (lines 121-129):

```ts
const BLANK: Draft = {
  name: '',
  condition: BLANK_LEAF,
  grantsAccount: true,
  enabled: true,
  entitlementIds: [],
};
```

Replace `draftFrom` (lines 132-158):

```ts
function draftFrom(rule: StoredRule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    condition: draftConditionFrom(rule.condition),
    grantsAccount: rule.grantsAccount,
    enabled: rule.enabled,
    entitlementIds: rule.entitlements.map((e) => e.entitlementId),
  };
}
```

Delete the old module-level `conditionOf(draft: Draft)` (lines 160-177) — Task 10 already added a `conditionOf(node: ConditionDraft)` that supersedes it (same name, new signature, one definition).

Replace `bodyOf` (lines 179-188):

```ts
function bodyOf(draft: Draft) {
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name.trim(),
    condition: conditionOf(draft.condition),
    grantsAccount: draft.grantsAccount,
    enabled: draft.enabled,
    entitlementIds: draft.entitlementIds,
  };
}
```

Replace `describe` (lines 190-200):

```ts
const describe = (rule: StoredRule) => describeCondition(rule.condition);
```

`deletionOf` (lines 64-71) currently spreads `rule.condition` implicitly through `...rule`-shaped construction — read it directly; if it references `rule.condition` it needs no change, since it already passes the stored JSON through rather than a `Draft`.

- [ ] **Step 4: Fix the render section's reference to the retired flat fields**

The render section (around line 391, `const kind = kindOf(draft.op);`, and lines 558-592, the `Field`/`Select` grid reading `draft.field`/`draft.op`/`draft.value`) now reads a `ConditionDraft` tree instead of a flat leaf. Task 13 replaces this block with `<ConditionGroupEditor>`; for this task only, make it compile against the new `Draft` shape without changing behavior for the common case — replace line 391 and the grid at 558-592 with a version scoped to `draft.condition` when it is a leaf, and a plain non-editable summary (`describeCondition`) when it is not, so the page compiles and every single-leaf test still passes:

```tsx
{draft.condition.kind === 'leaf' ? (
  <div className="grid gap-3 sm:grid-cols-3">
    <Select
      label="Field"
      value={draft.condition.field}
      onChange={(v) =>
        set('condition', { ...(draft.condition as LeafDraft), field: v as LeafDraft['field'] })
      }
      options={FIELDS.map((field) => ({ value: field, label: field }))}
      {...mark('field')}
    />
    <Select
      label="Test"
      value={draft.condition.op}
      onChange={(v) =>
        set('condition', { ...(draft.condition as LeafDraft), op: v as Operator })
      }
      options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
      {...mark('op')}
    />
    {kindOf(draft.condition.op) !== 'none' && (
      <Field
        label="Value"
        value={draft.condition.value}
        onChange={(v) => set('condition', { ...(draft.condition as LeafDraft), value: v })}
        inputMode={kindOf(draft.condition.op) === 'number' ? 'decimal' : undefined}
        hint={
          kindOf(draft.condition.op) === 'list'
            ? 'Separated by commas. A blank list matches nobody and is refused.'
            : 'A blank value is refused: it would match every person in the tenant.'
        }
        {...mark('value')}
      />
    )}
  </div>
) : (
  <p className="text-muted">{describeCondition(conditionOf(draft.condition))}</p>
)}
```

- [ ] **Step 5: Run and confirm every existing single-leaf test still passes, and the new one does too**

Run: `pnpm --filter @syntra/web test -- BusinessRulesPage`
Expected: PASS, full file, including the new compound-condition rendering test from Step 1.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src/pages/admin/BusinessRulesPage.tsx apps/web/src/pages/admin/BusinessRulesPage.test.tsx
git commit -m "console(business-rules): Draft carries a ConditionDraft tree; compound conditions render in full instead of an opaque placeholder"
```

---

### Task 12: `ConditionGroupEditor` — the recursive editor component

**Files:**
- Create: `apps/web/src/pages/admin/ConditionGroupEditor.tsx`
- Create: `apps/web/src/pages/admin/ConditionGroupEditor.test.tsx`

**Interfaces:**
- Consumes: `ConditionDraft`, `LeafDraft`, `GroupDraft`, `NotDraft`, `FIELDS`, `OPERATORS`, `Operator`, `kindOf` — all exported from `BusinessRulesPage.tsx` (Task 10 already exports the three draft types; this task adds `export` to `FIELDS`, `OPERATORS`, `kindOf` and `type Operator`, which are module-private today).
- Produces: `<ConditionGroupEditor node={ConditionDraft} onChange={(next: ConditionDraft) => void} depth={number} />`, consumed by Task 13.

- [ ] **Step 1: Export the four names this component needs**

In `BusinessRulesPage.tsx`, add `export` to the existing `const FIELDS`, `const OPERATORS`, `type Operator`, and `function kindOf` declarations (lines 74, 93, 106, 107-108) — no other change to those four.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/pages/admin/ConditionGroupEditor.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConditionGroupEditor } from './ConditionGroupEditor.js';
import type { ConditionDraft, GroupDraft } from './BusinessRulesPage.js';

const leaf = (value: string): ConditionDraft => ({
  kind: 'leaf',
  field: 'contract.department',
  op: 'equals',
  value,
});

describe('ConditionGroupEditor', () => {
  it('edits a single leaf directly', () => {
    const onChange = vi.fn();
    render(<ConditionGroupEditor node={leaf('Finance')} onChange={onChange} depth={0} />);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Ops' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaf', value: 'Ops' }),
    );
  });

  it('turns a leaf into an AND group, keeping the leaf as the first child', () => {
    const onChange = vi.fn();
    render(<ConditionGroupEditor node={leaf('Finance')} onChange={onChange} depth={0} />);
    fireEvent.click(screen.getByRole('button', { name: /group with AND/i }));
    const next = onChange.mock.calls[0]![0] as GroupDraft;
    expect(next.kind).toBe('group');
    expect(next.combinator).toBe('all');
    expect(next.children).toEqual([leaf('Finance')]);
  });

  it('adds and removes a child within an existing group', () => {
    const onChange = vi.fn();
    const group: GroupDraft = { kind: 'group', combinator: 'all', children: [leaf('Finance')] };
    render(<ConditionGroupEditor node={group} onChange={onChange} depth={0} />);
    fireEvent.click(screen.getByRole('button', { name: /add condition/i }));
    expect((onChange.mock.calls[0]![0] as GroupDraft).children).toHaveLength(2);

    onChange.mockClear();
    render(<ConditionGroupEditor node={group} onChange={onChange} depth={0} />);
    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeButtons[0]!);
    expect((onChange.mock.calls[0]![0] as GroupDraft).children).toHaveLength(0);
  });

  it('wraps a node in NOT and can unwrap it again', () => {
    const onChange = vi.fn();
    render(<ConditionGroupEditor node={leaf('Finance')} onChange={onChange} depth={0} />);
    fireEvent.click(screen.getByRole('button', { name: /^negate$/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'not', child: leaf('Finance') });
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `pnpm --filter @syntra/web test -- ConditionGroupEditor`
Expected: FAIL — `Cannot find module './ConditionGroupEditor.js'`.

- [ ] **Step 4: Implement the component**

Create `apps/web/src/pages/admin/ConditionGroupEditor.tsx`:

```tsx
import { Button, Field, Select } from '@syntra/ui';
import {
  FIELDS,
  OPERATORS,
  kindOf,
  type ConditionDraft,
  type GroupDraft,
  type LeafDraft,
  type Operator,
} from './BusinessRulesPage.js';

const BLANK_LEAF: LeafDraft = {
  kind: 'leaf',
  field: 'contract.department',
  op: 'equals',
  value: '',
};

export interface ConditionGroupEditorProps {
  node: ConditionDraft;
  onChange: (next: ConditionDraft) => void;
  depth: number;
}

/**
 * A recursive editor over `condition.ts`'s `Condition` shape: a leaf renders
 * as the field/operator/value row this page always had; `all`/`any` render as
 * a labelled group of children with add/remove controls; `not` renders as a
 * single wrapped child with an unwrap control. Depth is passed through only
 * for indentation — there is no recursion-depth limit here because
 * `conditionSchema` in `condition.ts` has none either.
 */
export function ConditionGroupEditor({ node, onChange, depth }: ConditionGroupEditorProps) {
  const indent = { marginLeft: `${depth * 1.25}rem` };

  if (node.kind === 'leaf') {
    const kind = kindOf(node.op);
    return (
      <div style={indent} className="space-y-2 border-l border-border-subtle pl-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Field"
            value={node.field}
            onChange={(v) => onChange({ ...node, field: v as LeafDraft['field'] })}
            options={FIELDS.map((field) => ({ value: field, label: field }))}
          />
          <Select
            label="Test"
            value={node.op}
            onChange={(v) => onChange({ ...node, op: v as Operator })}
            options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
          />
          {kind !== 'none' && (
            <Field
              label="Value"
              value={node.value}
              onChange={(v) => onChange({ ...node, value: v })}
              inputMode={kind === 'number' ? 'decimal' : undefined}
              hint={
                kind === 'list'
                  ? 'Separated by commas. A blank list matches nobody and is refused.'
                  : 'A blank value is refused: it would match every person in the tenant.'
              }
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => onChange({ kind: 'group', combinator: 'all', children: [node] })}
          >
            Group with AND
          </Button>
          <Button
            size="sm"
            onClick={() => onChange({ kind: 'group', combinator: 'any', children: [node] })}
          >
            Group with OR
          </Button>
          <Button size="sm" onClick={() => onChange({ kind: 'not', child: node })}>
            Negate
          </Button>
        </div>
      </div>
    );
  }

  if (node.kind === 'not') {
    return (
      <div style={indent} className="space-y-2 border-l border-border-subtle pl-3">
        <p className="font-medium text-ink">NOT</p>
        <ConditionGroupEditor
          node={node.child}
          onChange={(child) => onChange({ kind: 'not', child })}
          depth={depth + 1}
        />
        <Button size="sm" onClick={() => onChange(node.child)}>
          Remove NOT, keep the condition inside it
        </Button>
      </div>
    );
  }

  const group = node as GroupDraft;
  return (
    <div style={indent} className="space-y-2 border-l border-border-subtle pl-3">
      <p className="font-medium text-ink">{group.combinator === 'all' ? 'ALL of' : 'ANY of'}</p>
      {group.children.map((child, index) => (
        <div key={index} className="space-y-1">
          <ConditionGroupEditor
            node={child}
            onChange={(next) => {
              const children = [...group.children];
              children[index] = next;
              onChange({ ...group, children });
            }}
            depth={depth + 1}
          />
          <Button
            size="sm"
            onClick={() => {
              const children = group.children.filter((_, i) => i !== index);
              onChange({ ...group, children });
            }}
          >
            Remove this condition
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        onClick={() => onChange({ ...group, children: [...group.children, BLANK_LEAF] })}
      >
        Add condition
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Run and confirm it passes**

Run: `pnpm --filter @syntra/web test -- ConditionGroupEditor`
Expected: PASS, 4/4.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src/pages/admin/BusinessRulesPage.tsx apps/web/src/pages/admin/ConditionGroupEditor.tsx apps/web/src/pages/admin/ConditionGroupEditor.test.tsx
git commit -m "console(business-rules): ConditionGroupEditor, a recursive AND/OR/NOT condition editor"
```

---

### Task 13: Wire `ConditionGroupEditor` into `BusinessRulesPage`

**Files:**
- Modify: `apps/web/src/pages/admin/BusinessRulesPage.tsx`
- Modify: `apps/web/src/pages/admin/BusinessRulesPage.test.tsx`

**Interfaces:**
- Consumes: `ConditionGroupEditor` (Task 12).

- [ ] **Step 1: Write the failing test**

Add to `BusinessRulesPage.test.tsx`:

```tsx
it('builds a 2-level AND/OR rule entirely through the editor and saves the correct JSON', async () => {
  const put = mockSaveRule(); // stands for this file's existing PUT-rule mock/spy — use its real name.
  render(<BusinessRulesPage />);
  fireEvent.click(screen.getByRole('button', { name: /group with AND/i }));
  fireEvent.click(screen.getByRole('button', { name: /add condition/i }));
  const values = screen.getAllByLabelText('Value');
  fireEvent.change(values[0]!, { target: { value: 'Finance' } });
  fireEvent.change(values[1]!, { target: { value: 'Ops' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await screen.findByText('Saved.');
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      condition: {
        all: [
          { field: 'contract.department', op: 'equals', value: 'Finance' },
          { field: 'contract.department', op: 'equals', value: 'Ops' },
        ],
      },
    }),
  );
});
```

(`mockSaveRule` stands for whatever this test file's existing `PUT /api/admin/targets/:id/rules` mock is named — read the file to find it, per this plan's convention of never inventing a fixture name.)

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @syntra/web test -- BusinessRulesPage`
Expected: FAIL — the page still renders Task 11's leaf-only/summary-only block, so there is no "Group with AND" button reachable from the top-level editor.

- [ ] **Step 3: Replace the Task-11 stopgap block with `ConditionGroupEditor`**

In the render section, replace the `draft.condition.kind === 'leaf' ? (...) : (...)` block Task 11 added with:

```tsx
<ConditionGroupEditor
  node={draft.condition}
  onChange={(next) => set('condition', next)}
  depth={0}
/>
```

Add the import:

```ts
import { ConditionGroupEditor } from './ConditionGroupEditor.js';
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm --filter @syntra/web test -- BusinessRulesPage`
Expected: PASS, full file.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add apps/web/src/pages/admin/BusinessRulesPage.tsx apps/web/src/pages/admin/BusinessRulesPage.test.tsx
git commit -m "console(business-rules): wire ConditionGroupEditor into the rule editor, replacing the single-leaf-only form"
```

---

### Task 14: End-to-end verification against the real API

**Files:**
- Modify: `e2e/provision.spec.ts` — confirmed the real location: `test('configure a target, write a rule, review a run, apply part of it', ...)` (line 228) already navigates to "Business rules" (line 297-298), reads the entitlement catalog, saves a rule and reads its impact preview (line 313-315). This plan's grounding read this file's rule-related lines directly rather than assuming a path.

**Interfaces:** none new — this task only adds coverage.

- [ ] **Step 1: Add a browser-level case**

In `e2e/provision.spec.ts`, add a case immediately after the existing `'configure a target, write a rule, review a run, apply part of it'` test, following the same setup pattern (same target configuration, same navigation to "Business rules" at line 297) that: creates a rule, clicks "Group with AND" (Task 12's button), adds a second condition (the "Add condition" button), fills both leaves' Field/Test/Value controls, saves, reloads the page, and asserts the rule's list-row text contains `AND` — Part B's `describeCondition` output — rather than any placeholder text.

- [ ] **Step 2: Run it**

Run: `pnpm e2e -- --grep "compound"` (the new test's title should contain "compound" so this filter selects it; `package.json`'s `e2e` script already forwards flags to Playwright, which the rest of this file's suite uses for scoped runs — confirm the exact existing invocation in `package.json` before assuming the flag passthrough shape).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/provision.spec.ts
git commit -m "e2e: compound-condition business rule created and reloaded through the console"
```

---

## Part C: CI Dependency Caching (Audit Finding X4)

### Task 15: Cache the pnpm store and Playwright's Chromium download

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:** none — this is CI configuration only, no code interface.

Confirmed by reading `.github/workflows/ci.yml` in full: neither the `test` job nor the `e2e` job has any `actions/cache` step. `test` runs `pnpm install --frozen-lockfile` cold every run; `e2e` runs that plus `pnpm exec playwright install --with-deps chromium` cold every run — a full Chromium download on every push and pull request.

- [ ] **Step 1: Cache the pnpm store in the `test` job**

In `.github/workflows/ci.yml`, immediately after the existing `- run: corepack enable` step in the `test` job (line 94) and before `- name: Start PostgreSQL, OpenLDAP, Samba and MailDev` (line 96), insert:

```yaml
      - name: Get the pnpm store path
        id: pnpm-store
        run: echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

      - name: Cache the pnpm store
        uses: actions/cache@v4
        with:
          path: ${{ steps.pnpm-store.outputs.path }}
          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-pnpm-store-
```

- [ ] **Step 2: Cache the pnpm store and Playwright's Chromium in the `e2e` job**

In the `e2e` job, after its own `- run: corepack enable` (line 164) and before `- name: Start PostgreSQL, OpenLDAP, Samba and MailDev` (line 166), insert the same pnpm-store cache block as Step 1 (this is a second job with its own runner and its own cache scope — the step is not shared, it is duplicated, matching how `- run: corepack enable` and the environment-writing step are already duplicated across both jobs in this file rather than factored into a shared job).

Then, after `- run: pnpm install --frozen-lockfile` (line 178) and before `- run: pnpm exec playwright install --with-deps chromium` (line 179), insert:

```yaml
      - name: Cache Playwright's Chromium download
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-playwright-chromium-${{ hashFiles('**/pnpm-lock.yaml') }}
```

Leave the existing `- run: pnpm exec playwright install --with-deps chromium` line unmodified: Playwright's own installer already skips re-downloading a browser build it finds at the expected path and version, so a cache hit makes this step fast rather than making it conditional — no `if:` needed, and no risk of skipping the `--with-deps` system-package step a cache hit does not cover.

- [ ] **Step 3: Verify the change syntactically**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` (or any available YAML linter/parser — this repo's CI has no dedicated `.yml` lint step today; a successful parse is the bar this task sets for itself, not a new lint gate).
Expected: no error.

- [ ] **Step 4: Push on a branch and confirm both jobs still pass, then confirm the cache hits on a second run**

This step cannot be verified locally — commit, push to a branch, open a draft PR (or push twice to the same branch) and read the Actions log for both runs: the first run's cache steps report `Cache not found`, and the *second* run's report a restored cache and a shorter `pnpm install`/`playwright install` step duration in the job summary.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cache the pnpm store (both jobs) and Playwright's Chromium download (e2e job)"
```

---

## Whole-Slice Verification

- [ ] Run: `pnpm typecheck` — PASS, all 8 project references.
- [ ] Run: `pnpm --filter @syntra/connectors test` — PASS, every `scim/*` and `registry` test alongside every pre-existing `ad/*` and `ldap/*` test unmodified.
- [ ] Run: `pnpm --filter @syntra/core test -- provision` — PASS, including the SCIM apply case from Task 8 and every pre-existing Active-Directory provision test with an unchanged outcome.
- [ ] Run: `pnpm --filter @syntra/web test` — PASS.
- [ ] Run: `pnpm vitest run` (root) — PASS, full suite, no regression against the count the audit recorded (3530/3530 core + 301/301 web, per `docs/superpowers/specs/2026-08-24-audit-findings.md` §1) plus this plan's new tests.
- [ ] Manual: create a `scim2` target against the fake SCIM server harness run standalone (`node --experimental-strip-types` a small script that calls `startFakeScimServer` and prints its `baseUrl`, or reuse Task 8's test fixture interactively), preview a run, confirm and apply it, and observe a created user in the fake server's in-memory store — the same end-to-end path `docs/superpowers/plans/2026-08-16-syntra-provision.md`'s Task 18 proved for Active Directory, now proved for a second connector.
- [ ] Confirm the Priority Roadmap's sequencing note: this plan's `scim2` target type is present in the codebase and covered by tests, but is not offered to a real tenant (feature-flagged or left undocumented in the admin runbook) until Remediation 1 and Remediation 5 have shipped, per this document's Tier 0 section.
- [ ] Manual: in the running console, open an existing single-leaf rule, group it with AND, add a second leaf, save, reload the page, and confirm the list row shows the full description rather than any placeholder text — Part B's regression case (Task 11) exercised through the real UI, not only the test suite.
- [ ] Run: `pnpm --filter @syntra/web test -- BusinessRulesPage ConditionGroupEditor` — PASS.
- [ ] Run: `pnpm e2e -- --grep "business rule"` — PASS (Task 14).
- [ ] Confirm `.github/workflows/ci.yml` still parses and both jobs are green on a pushed branch, with the second consecutive run's Actions log showing a restored cache for both the pnpm store and, in the `e2e` job, Playwright's Chromium download (Task 15).
