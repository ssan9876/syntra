# Syntra Access II — Protocol Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Syntra a SAML 2.0 identity provider and an OpenID Connect provider for downstream applications, and a SAML service provider and OIDC relying party against upstream identity providers — with every one of those paths issuing its token or assertion only after `authorize()` in `@syntra/core` has returned an allow.

**Architecture:** A new `packages/protocols` package holds protocol message construction, parsing and signature work and knows nothing about the database; it reaches storage only through functions `@syntra/core` exports that take a `tenantId` and open their own `withTenant`. Adapters mount in `apps/api` as Fastify plugins under `/saml/*`, `/oidc/*` and `/federation/*`. The SAML identity provider builds assertions and signs them with `xml-crypto`; the OIDC provider is `oidc-provider` configured so that it owns neither the user store (a `findAccount` callback reads Syntra's tables) nor the session decision (a custom interaction prompt forces every authorization request out to a Syntra route that calls `authorize()`). Upstream federation runs the reverse: a routing rule picks an upstream before the user is known, the upstream asserts an identity, and that identity enters `authorize()` as `Principal.external` — so policy, MFA and audit still apply on top of the upstream.

**Tech Stack:** TypeScript, Fastify 5, Prisma 6 / PostgreSQL 16, Vitest 3, `oidc-provider` 9.11.3 (+ `@types/oidc-provider` 9.11.1), `@node-saml/node-saml` 5.1.0, `xml-crypto` 6.1.2, `@xmldom/xmldom` 0.9.11, `xml-encryption` 6.0.0 (+ `@types/xml-encryption` 1.2.4), `openid-client` 6.8.5, `jose` 6.2.9, `@peculiar/x509` 2.0.0, `reflect-metadata` 0.2.2.

**Spec:** `docs/superpowers/specs/2026-08-14-syntra-core-access-design.md` — sections 7, 4, and the `ClaimMapping` / `UpstreamIdp` parts of section 6. Scoping rationale: `.superpowers/sdd/access-scoping.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **No network I/O, no long-running I/O, no Argon2, no signature verification inside a Prisma interactive transaction.** `withTenant` is `prisma.$transaction(fn)` with the 5000 ms default. This shipped as a Critical once and was found inside `authorize()` itself once. Signature verification, XML canonicalization, key generation, upstream metadata fetches and `openid-client` calls all happen **outside** `withTenant`; the transaction opens only to read the inputs and again to write the result.
2. **Row-level security on every tenant-scoped table.** The app connects as `syntra_app`, NOSUPERUSER NOBYPASSRLS. Every new table gets `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **and** `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, plus a `tenant_isolation` policy whose USING and WITH CHECK are `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`. Fixtures and seeds go through `withTenant`, never bare `prisma.<model>.create` — the one exception is `prisma.tenant.create`, which is unscoped by design.
3. **Unique constraints do not constrain NULLs in PostgreSQL.** Any uniqueness rule involving a nullable column needs a hand-written partial index (`CREATE UNIQUE INDEX ... WHERE <col> IS NOT NULL`). A plain `@@unique` on a nullable column is a plan failure.
4. **Migration directory names must sort after every migration they depend on.** The newest existing migration is `20260816000000_access_1`. This plan's migration is `20260817000000_access_2`. Never renumber below an existing one: the test helper truncates rather than re-migrating, so a mis-sorted migration passes the whole suite and breaks every fresh install.
5. **Nothing derives a relying party, an issuer, an entity ID, an audience, a destination or a redirect target from the `Host` header.** `tenant-context.ts` resolves a tenant from the leftmost label, so `acme.attacker.example` resolves tenant `acme`. Every protocol identifier comes from `Tenant.primaryDomain` with `PUBLIC_URL` as fallback — the pattern `apps/api/src/routes/relying-party.ts` established for WebAuthn — and a request whose `Host` does not match is refused.
6. **`z.string().url()` accepts `javascript:` URIs.** Use `isLaunchableUrl` from `@syntra/contracts` (http/https only) for every URL a browser will be sent to, and the stricter `isProtocolEndpoint` this plan adds for ACS URLs and redirect URIs.
7. **Redirect URIs and assertion consumer service URLs are matched by exact string equality against a stored allowlist.** No prefix match, no wildcard, no normalization beyond what was stored.
8. **`packages/core`'s export map is deliberately narrow.** `authenticate` and `issueAttempt` are withheld so a protocol adapter has no second door into an allow. Do not widen `packages/core/package.json`'s `exports`, do not export `authenticate` or `issueAttempt`, and do not add a deep-import path for them.
9. **`issueSession` and `createSession` take the allow object, not loose arguments.** Do not widen either signature.
10. **A second `app.rateLimit()` hook on one route is silently inert** — `@fastify/rate-limit` marks the request on its first hook and later hooks return without counting. Use `config.rateLimit` for the per-address dimension and `perTenantRateLimit(app, max)` (built on `app.createRateLimit`) for the per-tenant dimension, exactly as `apps/api/src/routes/portal.ts` does.
11. **Package boundaries (spec §5):** `protocols` depends on `core` and never imports `@syntra/db` — not even `import type`. Core functions that `protocols` calls take a `tenantId: string` and open their own `withTenant`.
12. **`exactOptionalPropertyTypes` is on.** `{ foo: undefined }` does not satisfy `{ foo?: string }`. Spread conditionally: `...(x === undefined ? {} : { foo: x })`.
13. **Nothing issues a token or an assertion without an allow from `authorize()`, and there is exactly one exemption.** The exemption is the OAuth 2.0 client credentials grant, which authenticates a client rather than a person — accepted by ruling A2-5, bounded by per-client opt-in, scope separation and its own audit event in Task 13, and named in the README in Task 17. **Do not add a second.** If a new flow seems to need one, that is a design question and not an implementation decision.
14. **Every outbound fetch to an address a tenant administrator supplied goes through the guard.** SAML metadata import and upstream OIDC discovery both fetch a URL somebody typed into the console. Use `fetchExternalDocument` (Task 2) or the `guardedFetch` wrapper it shares its classifier with; never a bare `fetch`. Loopback, link-local, private and unique-local ranges are refused unless `OUTBOUND_ALLOW_PRIVATE` is set, the check happens after DNS resolution, and redirects are not followed.
15. **Tests run in a single fork against one PostgreSQL** (`vitest.config.ts`, `poolOptions.forks.singleFork`). `resetDatabase()` truncates between tests. Never assume parallel isolation.

---

## Library findings — verified against the registry and the shipped type definitions

Every package below was installed at the pinned version and its API read before this plan was written. Three of the spec's assumptions did not survive that check; they are recorded here because they change what the tasks do.

| Package | Pinned | Verified how | Finding |
|---|---|---|---|
| `oidc-provider` | `9.11.3` | installed; read `lib/provider.js`, `lib/helpers/defaults.js`, `lib/helpers/interaction_policy/*`, `lib/models/client.js`, `lib/helpers/initialize_adapter.js` | Ships **no** bundled types in v9. Types come from `@types/oidc-provider@9.11.1` (DefinitelyTyped). Extends `Koa` (koa ^3.2.1), so it mounts via `provider.callback()`. |
| `@types/oidc-provider` | `9.11.1` | `npm view` | Required. Without it every `Provider` call is `any`. |
| `@node-saml/node-saml` | `5.1.0` | installed; read `lib/index.d.ts`, `lib/saml.d.ts`, `lib/types.d.ts`, `lib/xml.js` | **Service-provider only.** It has `getAuthorizeUrlAsync`, `getAuthorizeFormAsync`, `validatePostResponseAsync`, `validateRedirectAsync`, `validatePostRequestAsync`, `getLogoutUrlAsync`, `generateServiceProviderMetadata`. It has **no** method that issues a signed SAML Response or Assertion and **no** IdP metadata generator. It covers upstream federation completely and the identity provider not at all. Spec §4 hedged this ("and equivalent assertion signing"); this plan names the equivalent. |
| `xml-crypto` | `6.1.2` | installed; read `lib/signed-xml.d.ts` | The IdP-side signing and verification primitive. `SignedXml` exposes `addReference`, `computeSignature`, `getSignedXml`, `loadSignature`, `checkSignature`, `getReferences`, **`getSignedReferences()`**. It is the same library `@node-saml/node-saml` uses internally, so using it directly is *using an audited implementation*, not hand-rolling one. |
| `@xmldom/xmldom` | `0.9.11` | installed; **ran** a billion-laughs internal-entity payload and an external `SYSTEM "file:///etc/passwd"` payload | Neither entity is expanded — both come back as the literal text `&b;` / `&x;`. Entity expansion is off by construction. (`node-saml` bundles `0.8.10`, which errors `entity not found` on the same payload — also safe.) Task 5 pins a regression test on this so a future swap to an expanding parser fails loudly. |
| `xml-encryption` | `6.0.0` | installed; enumerated exports | `{ decrypt, encrypt, encryptKeyInfo, decryptKeyInfo }`, all callback-style. Types come from `@types/xml-encryption@1.2.4`. Used for optional assertion encryption. |
| `openid-client` | `6.8.5` | installed; read `build/index.d.ts` | v6 is functional, not the v5 class API. The functions this plan uses are `discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`, `refreshTokenGrant`, `fetchUserInfo`, `buildEndSessionUrl`, `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`, `randomState`, `randomNonce`, `ClientSecretPost`, `ClientSecretBasic`, `None`. |
| `jose` | `6.2.9` | installed; used `exportJWK` and `calculateJwkThumbprint` in a spike | JWKS publication and RFC 7638 `kid` derivation. |
| `@peculiar/x509` | `2.0.0` | installed; **ran** `X509CertificateGenerator.createSelfSigned` end to end | Generates the self-signed X.509 certificate SAML metadata requires. **Gotcha:** it pulls `tsyringe`, which throws `tsyringe requires a reflect polyfill` unless `import 'reflect-metadata'` executes first. The import must be the first line of the module that imports it. |
| `reflect-metadata` | `0.2.2` | `npm view` | Required solely by the line above. |

### Verdict on `oidc-provider` — adaptable, with three named conditions

It **can** be adapted to a Syntra-owned session and policy layer without forking it and without letting it own the user store, because three of its four ownership questions are already configuration seams:

- **User store:** `findAccount(ctx, sub, token)` is a callback. It returns `{ accountId, claims() }`. Syntra's tables stay authoritative. Confirmed at `lib/helpers/defaults.js:506`, where the built-in default calls `mustChange('findAccount', 'use your own account model')`.
- **Storage:** `adapter` accepts a constructor or factory (`lib/helpers/initialize_adapter.js`). Every artifact it persists goes into a Syntra table.
- **Authentication:** `interactions.url(ctx, interaction)` redirects to a Syntra route; `provider.interactionDetails(req, res)` reads the pending interaction and `provider.interactionFinished(req, res, { login: { accountId, ... } })` resumes it. That route is where `authorize()` is called, and there is no other way to resolve an interaction.

The three conditions:

1. **The issuer is fixed at construction.** `new Provider(issuer, setup)` asserts the issuer is a single web URI (`lib/provider.js:70-82`). Syntra is multi-tenant with per-tenant hostnames, so this means **one `Provider` instance per tenant**, built lazily and cached, with the issuer derived per Global Constraint 5. Task 10 builds that factory and its invalidation.
2. **It keeps its own session cookie, and a live one skips the interaction.** The built-in `login` prompt's `no_session` check returns `NO_NEED_TO_PROMPT` whenever `oidc.session.accountId` is set (`lib/helpers/interaction_policy/prompts/login.js`). Left alone, the *second* authorization request from any client reuses that session and issues tokens without ever re-entering Syntra — which is a per-application policy bypass, because spec §7 requires a fresh decision per application launch. Task 10 adds a custom `Prompt` whose `Check` returns `REQUEST_PROMPT` unless the current request carries a decision made in this interaction. This is the single most important control in the OIDC half of this plan and it has its own test.
3. **It is a Koa app.** Mounting means `reply.hijack()` plus `provider.callback()(request.raw, reply.raw)` inside a Fastify plugin that does not consume the request body first.

Neither condition requires a fork, and none of them lets `oidc-provider` own the user model. Section 4's constraint holds.

### Verdict on `@node-saml/node-saml` — half the requirement, and the other half is named

Upstream SAML federation (Syntra as SP) is entirely `node-saml`. The identity provider is `xml-crypto` + `@xmldom/xmldom` + `xml-encryption`, following the verification recipe `node-saml`'s own `getVerifiedXml` implements (sign-then-check-`getSignedReferences()`, one reference, enveloped only, referenced node must be the signature's parent, ID must resolve to exactly one element). `samlify` was considered and rejected: it needs an out-of-process schema validator with native or Java dependencies, and CVE-2025-47949 was a signature-verification bypass in samlify itself.

The IdP-side signing recipe in Task 7 was **executed as a spike before this plan was written**: an assertion built by the code in that task, signed with `xml-crypto`, was accepted by `@node-saml/node-saml` acting as a service provider, and rejected with `Invalid signature` after a single attribute value was altered post-signature. That round trip is the task's primary test.

---

## File Structure

### Created

**`packages/db`**
- `prisma/migrations/20260817000000_access_2/migration.sql` — the tables below, their RLS, their partial indexes.
- `src/access-2-schema.test.ts` — defaults, partial-index behaviour, and RLS cross-tenant refusal for every new table.

**`packages/core`** (all DB access lives here; `protocols` never touches Prisma)
- `src/keys/signing-key-service.ts` — generate, read, rotate and publish per-tenant signing keys. One `active`, at most one `outgoing` during a rollover.
- `src/keys/signing-key-service.test.ts`
- `src/access/claim-mapping-service.ts` — CRUD for `ClaimMapping`.
- `src/access/claims/resolve.ts` — **pure**: given a resolved attribute bundle and a mapping list, produce the claim set. Omits, never emits empty.
- `src/access/claims/collect.ts` — reads user, person, contract, group and attribute rows into the bundle `resolve.ts` consumes.
- `src/access/claims/resolve.test.ts`, `src/access/claims/collect.test.ts`
- `src/access/saml-config-service.ts` — `SamlConfig` CRUD, ACS allowlist checking.
- `src/access/oidc-client-service.ts` — `OidcClient` CRUD, secret hashing and verification, exact redirect-URI matching.
- `src/access/oidc-store.ts` — the storage functions `oidc-provider`'s adapter calls. Every one takes `tenantId: string`.
- `src/access/authorization-decision-service.ts` — one `authorize()` allow, recorded by the OIDC interaction route and spent by the token endpoint. The second of the two chokepoint controls.
- `src/net/outbound.ts` — `classifyAddress` and `fetchExternalDocument`: the guard on every fetch to an administrator-supplied address.
- `src/net/outbound.test.ts`
- `src/access/saml-session-service.ts` — `SamlSsoSession` rows, so single logout knows which service providers to notify.
- `src/federation/upstream-service.ts` — `UpstreamIdp` CRUD, secret storage via the vault.
- `src/federation/routing.ts` — **pure**: pick an upstream from routing rules using only pre-authentication facts.
- `src/federation/routing.test.ts`
- `src/federation/federation-request-service.ts` — issue, find and consume the single-use in-flight request row.
- `src/federation/jit-service.ts` — create or refresh a local `User` from mapped upstream attributes, and link it.
- `src/federation/jit-service.test.ts`

**`packages/protocols`** (new package; depends on `@syntra/core` and the protocol libraries only)
- `package.json`, `tsconfig.json`, `src/index.ts`
- `src/xml/parse.ts` — the only DOM parser in the codebase, entity expansion proven off.
- `src/xml/verify.ts` — `verifySignedFragment`, the XSW-hardened wrapper over `xml-crypto`.
- `src/xml/sign.ts` — `signFragment`.
- `src/xml/escape.ts` — `xmlText`, `xmlAttr`.
- `src/xml/*.test.ts`
- `src/saml/idp-metadata.ts` — build the IdP `EntityDescriptor`.
- `src/saml/authn-request.ts` — decode and validate an incoming `AuthnRequest` on both bindings.
- `src/saml/assertion.ts` — build, sign and optionally encrypt the `Response`.
- `src/saml/logout.ts` — build and parse `LogoutRequest` / `LogoutResponse`.
- `src/saml/sp-metadata.ts` — parse an uploaded or fetched SP `EntityDescriptor`.
- `src/saml/*.test.ts`
- `src/oidc/provider-factory.ts` — build and cache one `Provider` per tenant.
- `src/oidc/adapter.ts` — the `oidc-provider` adapter over `@syntra/core`'s `oidc-store`.
- `src/oidc/interaction-prompt.ts` — the custom `Prompt` that forces every authorization request through Syntra.
- `src/oidc/*.test.ts`
- `src/upstream/oidc-client.ts` — `openid-client` wrapper.
- `src/upstream/saml-sp.ts` — `@node-saml/node-saml` wrapper.

**`packages/contracts`**
- `src/protocol.ts` — `isProtocolEndpoint`, and the zod schemas for `SamlConfig`, `OidcClient`, `ClaimMapping` and `UpstreamIdp` administration.

**`apps/api`**
- `src/routes/protocol-identity.ts` — `tenantProtocolBase`, `samlEntityId`, `oidcIssuer`, `assertProtocolHost`. The Constraint-5 chokepoint.
- `src/routes/saml-idp.ts` — `/saml/metadata`, `/saml/sso` (GET+POST), `/saml/continue`, `/saml/slo` (GET+POST).
- `src/routes/oidc-op.ts` — the per-tenant `Provider`, the mount adaptation, `/oidc/jwks`, and the catch-all that hands oidc-provider an untouched raw stream.
- `src/routes/oidc-interaction.ts` — `/oidc/interaction/:uid`, the route that calls `authorize()` and writes the decision.
- `src/routes/oidc-authorize.test.ts` — everything up to the authorization code arriving on the redirect URI, including Control 1.
- `src/routes/oidc-token.ts` — `/oidc/token` alone: constant-time client authentication, the authorization-decision check (Control 2), the client-credentials guard, and the body replay. Its own plugin so its body parser cannot escape into the catch-all's scope.
- `src/routes/oidc-token.test.ts` — the exchange, Control 2, and the pinned `oidc-provider` model-API contract.
- `src/routes/oidc-boundary.test.ts` — asserts the body-parsing encapsulation directly, not merely that the routes work.
- `src/routes/federation.ts` — `/federation/start`, `/federation/oidc/callback`, `/federation/saml/acs`.
- `src/routes/admin/protocol-apps.ts` — SAML and OIDC application configuration and claim mappings.
- `src/routes/admin/upstreams.ts` — `UpstreamIdp` configuration.
- corresponding `*.test.ts` beside each.

### Modified

- `packages/db/prisma/schema.prisma` — the new models.
- `packages/core/src/index.ts` — export the new services. **`authenticate` and `issueAttempt` stay unexported.**
- `packages/core/src/policy/types.ts` — add the `RoutingRule` type. `PolicyOutcome` is **not** widened.
- `packages/core/src/policy/policy-service.ts` — `loadPolicy` returns `routes` alongside `rules`, and filters `federate` rows out of `rules`.
- `packages/core/package.json`, `apps/api/package.json`, root `package.json` — dependencies.
- `packages/contracts/src/index.ts` — export `./protocol.js`.
- `packages/contracts/src/access.ts` — widen `createApplicationRequest.type` from `z.literal('bookmark')` to `z.enum(['bookmark','saml','oidc'])`, and make `launchUrl` optional for the two protocol types.
- `apps/api/src/app.ts` — register the new plugins.
- `apps/api/src/routes/portal.ts` — a `saml` or `oidc` application launches to its protocol start URL rather than a stored bookmark.
- `tsconfig.json` — add `{ "path": "packages/protocols" }`.

---

## Data model added by `20260817000000_access_2`

| Model | Purpose | Notes that matter |
|---|---|---|
| `SamlConfig` | one per SAML `Application` | `acsUrls String[]` is the exact-match allowlist. `spCertificates String[]` verify signed AuthnRequests. |
| `OidcClient` | one per OIDC `Application` | `clientSecretHash` is SHA-256, not Argon2 — see Task 10's note. `redirectUris String[]` is the exact-match allowlist. `clientCredentialsEnabled` defaults false: it is the one grant that bypasses `authorize()`, so it gets its own field rather than a string in an array. |
| `ClaimMapping` | per application, per protocol | `contractStrategy` is `'primary' \| 'lowestSequence'`, feeding `resolveContractForMapping`. |
| `UpstreamIdp` | an external IdP this tenant federates to | Client secret and SAML private key live in the vault under `secretName`; the row holds only the name. |
| `UpstreamLink` | ties a local `User` to an upstream subject | `@@unique([upstreamIdpId, subject])`. Both columns NOT NULL, so a plain unique is sufficient. |
| `FederationRequest` | one in-flight upstream login | Single-use. Carries `state`, `nonce`, `requestId`, `returnTo`, `applicationId`. |
| `SigningKey` | per tenant, per kind (`oidc` \| `saml`) | `status` is `active` \| `outgoing` \| `retired`. Partial unique index enforces one `active` per (tenant, kind). |
| `OidcArtifact` | every artifact `oidc-provider` persists | `model` + `artifactId` primary key. `uid`, `userCode`, `grantId` all nullable — three partial indexes. |
| `SamlSsoSession` | which SPs a Syntra session has signed into | Feeds single logout. |
| `SamlAuthnRequest` | a validated AuthnRequest parked while the user signs in | Single-use. Everything on it was checked before it was written, so nothing is re-derived from the browser on the way back. |
| `AuthorizationDecision` | one `authorize()` allow, written by the OIDC interaction route | Single-use, and the token endpoint spends it. The second of the two independent controls behind spec §7's chokepoint — see Task 11. |

---

## Task 1: Schema and migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (append after `RefreshToken`)
- Create: `packages/db/prisma/migrations/20260817000000_access_2/migration.sql`
- Test: `packages/db/src/access-2-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `SamlConfig`, `OidcClient`, `ClaimMapping`, `UpstreamIdp`, `UpstreamLink`, `FederationRequest`, `SigningKey`, `OidcArtifact`, `SamlSsoSession`, `SamlAuthnRequest`, `AuthorizationDecision`, reachable as `tx.samlConfig`, `tx.oidcClient`, `tx.claimMapping`, `tx.upstreamIdp`, `tx.upstreamLink`, `tx.federationRequest`, `tx.signingKey`, `tx.oidcArtifact`, `tx.samlSsoSession`, `tx.samlAuthnRequest`, `tx.authorizationDecision`. Adds `AuthPolicyRule.upstreamIdpId String?`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/db/src/access-2-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;
let applicationId: string;

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
  applicationId = await withTenant(tenantId, async (tx) => {
    const app = await tx.application.create({
      data: { tenantId, name: 'CRM', slug: 'crm', type: 'saml' },
    });
    return app.id;
  });
});

const key = (over: Record<string, unknown>) => ({
  tenantId,
  kind: 'oidc',
  alg: 'RS256',
  publicJwk: {},
  status: 'active',
  notBefore: new Date(),
  notAfter: new Date(Date.now() + 60_000),
  ...over,
});

describe('access 2 schema', () => {
  it('gives an OIDC client PKCE on, client credentials off, and no redirect URIs', async () => {
    const client = await withTenant(tenantId, (tx) =>
      tx.oidcClient.create({
        data: { tenantId, applicationId, clientId: 'crm', clientSecretHash: 'x' },
      }),
    );
    expect(client.requirePkce).toBe(true);
    // The grant that bypasses authorize() is never on by default (A2-5).
    expect(client.clientCredentialsEnabled).toBe(false);
    // Empty rather than a permissive default: an unconfigured client can
    // complete no flow at all, which is the safe starting state.
    expect(client.redirectUris).toEqual([]);
  });

  it('allows one active signing key per tenant and kind, with an outgoing one beside it', async () => {
    await withTenant(tenantId, (tx) =>
      tx.signingKey.create({ data: key({ kid: 'k1', secretName: 's1' }) }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.signingKey.create({ data: key({ kid: 'k2', secretName: 's2' }) }),
      ),
    ).rejects.toThrow();
    // The half a plain UNIQUE(tenantId, kind) would fail: a rollover needs
    // both keys present at once.
    const outgoing = await withTenant(tenantId, (tx) =>
      tx.signingKey.create({
        data: key({ kid: 'k3', secretName: 's3', status: 'outgoing' }),
      }),
    );
    expect(outgoing.status).toBe('outgoing');
  });

  it('lets two tenants each hold an active oidc key', async () => {
    for (const t of [tenantId, otherTenantId]) {
      await withTenant(t, (tx) =>
        tx.signingKey.create({
          data: { ...key({ kid: `k-${t}`, secretName: `s-${t}` }), tenantId: t },
        }),
      );
    }
    const rows = await prisma.signingKey.findMany({ where: { status: 'active' } });
    expect(rows).toHaveLength(2);
  });

  it('constrains an oidc artifact uid only when the uid is present', async () => {
    const base = {
      tenantId,
      model: 'Session',
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
    };
    // Two rows with a null uid coexist, which is the ordinary case for every
    // model that has no uid at all.
    await withTenant(tenantId, (tx) =>
      tx.oidcArtifact.createMany({
        data: [
          { ...base, artifactId: 'a' },
          { ...base, artifactId: 'b' },
        ],
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.oidcArtifact.create({ data: { ...base, artifactId: 'c', uid: 'u1' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.oidcArtifact.create({ data: { ...base, artifactId: 'd', uid: 'u1' } }),
      ),
    ).rejects.toThrow();
  });

  it('refuses to read another tenant rows even when the query names them', async () => {
    await withTenant(tenantId, (tx) =>
      tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      }),
    );
    const seen = await withTenant(otherTenantId, (tx) =>
      // Deliberately written wrongly: naming the other tenant's id explicitly.
      tx.upstreamIdp.findMany({ where: { tenantId } }),
    );
    expect(seen).toEqual([]);
  });

  it('refuses to write a row into another tenant', async () => {
    await expect(
      withTenant(otherTenantId, (tx) =>
        tx.upstreamIdp.create({
          data: { tenantId, slug: 'smuggled', name: 'Smuggled', protocol: 'oidc' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a federate rule with no upstream, and a non-federate rule with one', async () => {
    const policyId = await withTenant(tenantId, async (tx) => {
      const p = await tx.authPolicy.create({ data: { tenantId } });
      return p.id;
    });
    const upstreamId = await withTenant(tenantId, async (tx) => {
      const u = await tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      });
      return u.id;
    });
    await expect(
      withTenant(tenantId, (tx) =>
        tx.authPolicyRule.create({
          data: { tenantId, policyId, position: 1, name: 'r', outcome: 'federate' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.authPolicyRule.create({
          data: {
            tenantId, policyId, position: 2, name: 'r2',
            outcome: 'allow', upstreamIdpId: upstreamId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/db/src/access-2-schema.test.ts`
Expected: FAIL — `tx.oidcClient is undefined`; none of the models exist yet.

- [ ] **Step 3: Add the models to `schema.prisma`**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// A SAML service provider Syntra issues assertions to. One per Application
/// of type 'saml'.
model SamlConfig {
  id                      String      @id @default(uuid()) @db.Uuid
  tenantId                String      @db.Uuid
  applicationId           String      @unique @db.Uuid
  application             Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  /// The SP's entity ID. Goes into saml:Audience verbatim.
  spEntityId              String
  /// The exact-match allowlist. An ACS URL that is not byte-identical to one
  /// of these is refused; there is no prefix or wildcard matching anywhere.
  acsUrls                 String[]    @default([])
  defaultAcsUrl           String?
  acsBinding              String      @default("HTTP-POST")
  nameIdFormat            String      @default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress")
  /// Which mapped claim supplies the NameID. Null means the user's email.
  nameIdClaim             String?
  /// PEM certificates that may have signed an incoming AuthnRequest or
  /// LogoutRequest. Empty means unsigned requests are accepted.
  spCertificates          String[]    @default([])
  wantAuthnRequestsSigned Boolean     @default(false)
  encryptAssertions       Boolean     @default(false)
  /// PEM certificate whose public key wraps the assertion's data key.
  encryptionCertificate   String?
  sloUrl                  String?
  sloBinding              String      @default("HTTP-POST")
  /// Whether an IdP-initiated Response, with no AuthnRequest behind it, may
  /// be issued to this SP.
  allowIdpInitiated       Boolean     @default(false)
  assertionLifetimeMs     Int         @default(300000)
  createdAt               DateTime    @default(now())
  updatedAt               DateTime    @updatedAt

  @@index([tenantId])
  @@index([tenantId, spEntityId])
}

/// An OIDC relying party. One per Application of type 'oidc'.
model OidcClient {
  id                       String      @id @default(uuid()) @db.Uuid
  tenantId                 String      @db.Uuid
  applicationId            String      @unique @db.Uuid
  application              Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  clientId                 String
  /// SHA-256 of a 256-bit random secret. Task 11 records why this is not
  /// Argon2id.
  clientSecretHash         String
  /// Exact-match allowlist. Never prefix-matched, never wildcarded.
  redirectUris             String[]    @default([])
  postLogoutRedirectUris   String[]    @default([])
  grantTypes               String[]    @default(["authorization_code", "refresh_token"])
  /// Whether this client may use the client credentials grant.
  ///
  /// Its own column rather than a member of `grantTypes`, and default false.
  /// This is the one grant that issues a token without a decision from
  /// `authorize()` — see ruling A2-5 and Task 13 — so turning it on is a
  /// deliberate act on one client, not an edit to an array where it could
  /// arrive by accident alongside an unrelated change. `loadClients` derives
  /// the protocol-level grant type from this flag; the admin API refuses
  /// `client_credentials` in `grantTypes` outright.
  clientCredentialsEnabled Boolean     @default(false)
  scopes                   String[]    @default(["openid", "profile", "email"])
  requirePkce              Boolean     @default(true)
  tokenEndpointAuthMethod  String      @default("client_secret_basic")
  idTokenSignedResponseAlg String      @default("RS256")
  accessTokenTtlSeconds    Int         @default(3600)
  refreshTokenTtlSeconds   Int         @default(1209600)
  createdAt                DateTime    @default(now())
  updatedAt                DateTime    @updatedAt

  @@unique([tenantId, clientId])
  @@index([tenantId])
}

/// Maps a directory, person or contract attribute to a SAML attribute or an
/// OIDC claim, for one application.
model ClaimMapping {
  id               String      @id @default(uuid()) @db.Uuid
  tenantId         String      @db.Uuid
  applicationId    String      @db.Uuid
  application      Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  /// 'saml' | 'oidc'
  protocol         String
  /// The outgoing name: a SAML Attribute Name, or an OIDC claim name.
  claimName        String
  /// SAML only. Ignored for OIDC.
  nameFormat       String      @default("urn:oasis:names:tc:SAML:2.0:attrname-format:basic")
  /// 'user' | 'person' | 'contract' | 'attribute' | 'groups' | 'literal'
  sourceKind       String
  /// The field on the source, or the UserAttribute key.
  sourceField      String?
  /// 'primary' | 'lowestSequence'. Read only when sourceKind is 'contract'.
  contractStrategy String      @default("primary")
  literalValue     String?
  /// OIDC only: the scope that releases this claim. Null releases it under
  /// 'profile'.
  releaseScope     String?
  multiValued      Boolean     @default(false)
  createdAt        DateTime    @default(now())

  @@unique([applicationId, protocol, claimName])
  @@index([tenantId])
  @@index([applicationId])
}

/// An external identity provider this tenant federates to.
model UpstreamIdp {
  id                   String   @id @default(uuid()) @db.Uuid
  tenantId             String   @db.Uuid
  slug                 String
  name                 String
  /// 'saml' | 'oidc'
  protocol             String
  enabled              Boolean  @default(true)
  issuerUrl            String?
  clientId             String?
  /// Vault secret name holding the client secret. Never the secret itself.
  clientSecretName     String?
  scopes               String[] @default(["openid", "profile", "email"])
  idpEntityId          String?
  ssoUrl               String?
  idpSloUrl            String?
  ssoBinding           String   @default("HTTP-Redirect")
  /// PEM certificates trusted to have signed an upstream assertion.
  idpCertificates      String[] @default([])
  wantAssertionsSigned Boolean  @default(true)
  loginAttribute       String   @default("preferred_username")
  emailAttribute       String   @default("email")
  displayNameAttribute String   @default("name")
  groupsAttribute      String?
  createUsers          Boolean  @default(true)
  refreshOnLogin       Boolean  @default(true)
  defaultOrgUnitId     String?  @db.Uuid
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  links UpstreamLink[]

  @@unique([tenantId, slug])
  @@index([tenantId])
}

/// Ties a local User to the subject an upstream asserts. This — not the email
/// address — is how a returning federated user is found.
model UpstreamLink {
  id            String      @id @default(uuid()) @db.Uuid
  tenantId      String      @db.Uuid
  upstreamIdpId String      @db.Uuid
  upstream      UpstreamIdp @relation(fields: [upstreamIdpId], references: [id], onDelete: Cascade)
  userId        String      @db.Uuid
  /// The upstream `sub`, or the SAML NameID.
  subject       String
  lastLoginAt   DateTime?
  createdAt     DateTime    @default(now())

  @@unique([upstreamIdpId, subject])
  @@index([tenantId])
  @@index([userId])
}

/// One in-flight upstream login. Single-use: consuming it is what stops a
/// captured callback being replayed.
model FederationRequest {
  id            String    @id @default(uuid()) @db.Uuid
  tenantId      String    @db.Uuid
  upstreamIdpId String    @db.Uuid
  /// OIDC `state`, or the SAML AuthnRequest ID.
  state         String
  nonce         String?
  /// Vault secret name holding the PKCE code_verifier, for OIDC.
  verifierName  String?
  /// Where the browser goes after authorize() allows. Always same-origin.
  returnTo      String
  applicationId String?   @db.Uuid
  createdAt     DateTime  @default(now())
  expiresAt     DateTime
  consumedAt    DateTime?

  @@index([tenantId])
  @@index([tenantId, state])
}

/// A signing key. One 'active' per tenant and kind; an 'outgoing' one sits
/// beside it for the length of a rollover so tokens already issued still
/// verify.
model SigningKey {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String    @db.Uuid
  /// 'oidc' | 'saml'
  kind        String
  /// RFC 7638 thumbprint. The JWKS `kid`, and the SAML KeyDescriptor id.
  kid         String
  alg         String    @default("RS256")
  publicJwk   Json
  /// PEM, self-signed. SAML metadata needs a certificate; OIDC does not.
  certificate String?
  /// Vault secret name holding the PKCS#8 private key.
  secretName  String
  /// 'active' | 'outgoing' | 'retired'
  status      String    @default("active")
  notBefore   DateTime
  notAfter    DateTime
  retiredAt   DateTime?
  createdAt   DateTime  @default(now())

  @@unique([tenantId, kind, kid])
  @@index([tenantId])
}

/// Everything oidc-provider persists. One table rather than nine, because the
/// adapter's contract is uniform and nine tables would be nine sets of RLS
/// policies to keep in step.
model OidcArtifact {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @db.Uuid
  /// The oidc-provider model name: 'AccessToken', 'Grant', 'Session', ...
  model      String
  artifactId String
  uid        String?
  userCode   String?
  grantId    String?
  accountId  String?
  payload    Json
  expiresAt  DateTime?
  consumedAt DateTime?
  createdAt  DateTime  @default(now())

  @@unique([tenantId, model, artifactId])
  @@index([tenantId])
  @@index([tenantId, grantId])
}

/// Which service providers a Syntra session has signed into, so single logout
/// can reach them.
model SamlSsoSession {
  id            String    @id @default(uuid()) @db.Uuid
  tenantId      String    @db.Uuid
  sessionId     String    @db.Uuid
  applicationId String    @db.Uuid
  nameId        String
  sessionIndex  String
  createdAt     DateTime  @default(now())
  endedAt       DateTime?

  @@index([tenantId])
  @@index([sessionId])
}

/// One `authorize()` allow, recorded by the OIDC interaction route so the
/// token endpoint can require it independently of `oidc-provider`.
///
/// This is the second of the two controls that keep spec section 7's
/// chokepoint true for OIDC. The first is the forced-interaction prompt, which
/// lives inside `oidc-provider`'s configuration; this one lives in Syntra's
/// own route and its own table, so no single edit removes both. Single-use,
/// and its lifetime matches the authorization code's exactly — see Task 11.
model AuthorizationDecision {
  id             String    @id @default(uuid()) @db.Uuid
  tenantId       String    @db.Uuid
  userId         String    @db.Uuid
  /// The OIDC client this decision was made for. A decision for one
  /// application never satisfies another.
  clientId       String
  /// The interaction it resolved, for the audit trail.
  interactionUid String
  satisfiedFactor String?
  createdAt      DateTime  @default(now())
  expiresAt      DateTime
  consumedAt     DateTime?

  @@index([tenantId])
  @@index([tenantId, userId, clientId])
}

/// A SAML authentication request that has been validated but not yet
/// answered, because the user still has to sign in or present a factor.
///
/// The request is parked here rather than carried through the browser,
/// because everything on it has already been checked — the ACS URL against
/// the allowlist, the signature against the SP's certificate — and a value
/// that travels through the browser has to be checked again on the way back.
model SamlAuthnRequest {
  id            String    @id @default(uuid()) @db.Uuid
  tenantId      String    @db.Uuid
  applicationId String    @db.Uuid
  /// Syntra's own opaque handle. This is what travels in the URL.
  handle        String
  /// The SP's AuthnRequest ID, echoed back as InResponseTo. Null when the
  /// flow is identity-provider-initiated and there was no request.
  requestId     String?
  /// Already matched against the allowlist when this row was written.
  acsUrl        String
  relayState    String?
  forceAuthn    Boolean   @default(false)
  createdAt     DateTime  @default(now())
  expiresAt     DateTime
  consumedAt    DateTime?

  @@index([tenantId])
  @@index([tenantId, handle])
}
```

Add three relation fields to the existing `Application` model, beside `assignments`:

```prisma
  samlConfig    SamlConfig?
  oidcClient    OidcClient?
  claimMappings ClaimMapping[]
```

Add two columns to the existing `AuthPolicyRule` model:

```prisma
  /// Set only on rules whose outcome is 'federate'. See Task 14.
  upstreamIdpId String?  @db.Uuid
  /// The login identifier's domain part, for a 'federate' rule. Its own
  /// column rather than a reuse of `contractValues`: the two match on
  /// different things, and overloading one array is how a later reader
  /// concludes a routing rule can carry a contract condition.
  loginDomains  String[] @default([])
```

- [ ] **Step 4: Write the migration**

Generate the DDL body:

```bash
pnpm --filter @syntra/db exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > /tmp/access2-body.sql
```

Create `packages/db/prisma/migrations/20260817000000_access_2/migration.sql` containing that output followed by this hand-written tail. The directory name sorts after `20260816000000_access_1`; do not renumber it below anything.

```sql
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'SamlConfig','OidcClient','ClaimMapping','UpstreamIdp','UpstreamLink',
    'FederationRequest','SigningKey','OidcArtifact','SamlSsoSession',
    'SamlAuthnRequest','AuthorizationDecision'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- PostgreSQL treats NULL as distinct from NULL, so a uniqueness rule that
-- involves a nullable column has to be a partial index or it constrains
-- nothing at all.

-- At most one active signing key per tenant and kind. 'outgoing' and
-- 'retired' rows are deliberately unconstrained: a rollover needs the
-- outgoing key to sit beside the active one.
CREATE UNIQUE INDEX signing_key_one_active
  ON "SigningKey" ("tenantId", "kind") WHERE "status" = 'active';

-- oidc-provider looks artifacts up by uid (Session, Interaction) and by
-- userCode (DeviceCode). Both columns are null on every other model, so a
-- plain UNIQUE would constrain neither.
CREATE UNIQUE INDEX oidc_artifact_unique_uid
  ON "OidcArtifact" ("tenantId", "model", "uid") WHERE "uid" IS NOT NULL;
CREATE UNIQUE INDEX oidc_artifact_unique_user_code
  ON "OidcArtifact" ("tenantId", "model", "userCode") WHERE "userCode" IS NOT NULL;

-- One live federation request per state. A consumed row must not block a
-- later request that happens to draw the same value.
CREATE UNIQUE INDEX federation_request_one_live
  ON "FederationRequest" ("tenantId", "state") WHERE "consumedAt" IS NULL;

-- One live SSO session per Syntra session and application, so a repeat launch
-- refreshes the row rather than accumulating rows single logout would notify
-- twice.
CREATE UNIQUE INDEX saml_sso_session_one_live
  ON "SamlSsoSession" ("sessionId", "applicationId") WHERE "endedAt" IS NULL;

-- One live parked AuthnRequest per handle. Consuming it is what stops a
-- captured handle being replayed into a second assertion.
CREATE UNIQUE INDEX saml_authn_request_one_live
  ON "SamlAuthnRequest" ("tenantId", "handle") WHERE "consumedAt" IS NULL;

-- One live decision per interaction. The interaction route writes one row per
-- resolved interaction, and the token endpoint spends it; a second write for
-- the same interaction would be a second token from one decision.
CREATE UNIQUE INDEX authorization_decision_one_live
  ON "AuthorizationDecision" ("tenantId", "interactionUid") WHERE "consumedAt" IS NULL;

-- A blank SP entity ID makes every audience restriction match.
ALTER TABLE "SamlConfig" ADD CONSTRAINT saml_config_entity_id_present
  CHECK (length("spEntityId") > 0);

-- A federate rule with no upstream cannot be honoured, and a non-federate
-- rule carrying one is a rule someone half-edited.
ALTER TABLE "AuthPolicyRule" ADD CONSTRAINT auth_policy_rule_federate_target CHECK (
  ("outcome" = 'federate') = ("upstreamIdpId" IS NOT NULL)
);
```

- [ ] **Step 5: Apply and regenerate**

```bash
pnpm db:up && pnpm db:migrate && pnpm db:generate
```
Expected: `20260817000000_access_2` applied; the Prisma client regenerates with nine new models.

- [ ] **Step 6: Run the schema test**

Run: `pnpm vitest run packages/db/src/access-2-schema.test.ts`
Expected: PASS, all seven cases.

**Why these tests are not degenerate.** The two RLS cases each create the row in its owning tenant first, so the row provably exists before it is proved invisible — a missing table would fail the create, not pass the assertion. The signing-key case asserts both halves of the partial index: a second `active` is refused *and* an `outgoing` beside it succeeds, so a plain `UNIQUE("tenantId","kind")` fails the second half and a missing index fails the first. The uid case creates a null-uid pair first, so an index written without the `WHERE` clause fails there rather than silently passing.

- [ ] **Step 7: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260817000000_access_2 packages/db/src/access-2-schema.test.ts
git commit -m "feat(db): access 2 protocol tables, RLS and partial indexes"
```

---

## Task 2: Protocol identity — the only place an issuer, entity ID or audience comes from

**Files:**
- Create: `apps/api/src/routes/protocol-identity.ts`
- Create: `apps/api/src/routes/protocol-identity.test.ts`
- Create: `packages/contracts/src/protocol.ts`
- Create: `packages/core/src/net/outbound.ts`
- Create: `packages/core/src/net/outbound.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/core/src/config.ts` (add `OUTBOUND_ALLOW_PRIVATE`), `packages/core/src/index.ts`
- Modify: `apps/api/src/test-support.ts` (default the new variable on)

**Interfaces:**
- Consumes: `ProblemError` from `apps/api/src/plugins/problem-json.js`; the pattern in `apps/api/src/routes/relying-party.ts`; `ipaddr.js`, already a dependency of `@syntra/core` from Access I's policy conditions.
- Produces:
  - `export interface ProtocolIdentity { base: string; issuer: string; entityId: string; ssoUrl: string; sloUrl: string; acsHost: string }`
  - `export function tenantProtocolIdentity(tenant: { primaryDomain: string | null }, publicUrl: string): ProtocolIdentity`
  - `export function assertProtocolHost(request: FastifyRequest, identity: ProtocolIdentity): void`
  - `export function isProtocolEndpoint(value: string): boolean` (from `@syntra/contracts`)
  - `export function matchesAllowlist(candidate: string, allowlist: readonly string[]): boolean` (from `@syntra/contracts`)
  - `export function classifyAddress(address: string): 'allowed' | 'blocked'` (from `@syntra/core`)
  - `export function fetchExternalDocument(rawUrl: string, options: OutboundOptions): Promise<string>` (from `@syntra/core`)
  - `Config.outboundAllowPrivate: boolean`, from `OUTBOUND_ALLOW_PRIVATE`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/protocol-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isProtocolEndpoint, matchesAllowlist } from '@syntra/contracts';
import {
  assertProtocolHost,
  tenantProtocolIdentity,
} from './protocol-identity.js';
import { ProblemError } from '../plugins/problem-json.js';

const asRequest = (host: string) =>
  ({ headers: { host } } as Parameters<typeof assertProtocolHost>[0]);

describe('tenantProtocolIdentity', () => {
  it('derives every identifier from the tenant primary domain', () => {
    const id = tenantProtocolIdentity(
      { primaryDomain: 'sso.acme.test' },
      'https://syntra.example:8443',
    );
    expect(id.base).toBe('https://sso.acme.test:8443');
    expect(id.issuer).toBe('https://sso.acme.test:8443/oidc');
    expect(id.entityId).toBe('https://sso.acme.test:8443/saml/idp');
    expect(id.ssoUrl).toBe('https://sso.acme.test:8443/saml/sso');
    expect(id.sloUrl).toBe('https://sso.acme.test:8443/saml/slo');
  });

  it('falls back to PUBLIC_URL when the tenant has no primary domain', () => {
    const id = tenantProtocolIdentity({ primaryDomain: null }, 'https://syntra.example');
    expect(id.base).toBe('https://syntra.example');
    expect(id.issuer).toBe('https://syntra.example/oidc');
  });

  it('never reads the Host header — the same tenant yields the same issuer whatever the request claims', () => {
    const tenant = { primaryDomain: 'sso.acme.test' };
    const a = tenantProtocolIdentity(tenant, 'https://syntra.example');
    const b = tenantProtocolIdentity(tenant, 'https://syntra.example');
    expect(a.issuer).toBe(b.issuer);
    // The signature takes no request at all, which is what makes the
    // vulnerability unrepresentable rather than merely avoided.
    expect(tenantProtocolIdentity.length).toBe(2);
  });
});

describe('assertProtocolHost', () => {
  const id = tenantProtocolIdentity({ primaryDomain: 'sso.acme.test' }, 'https://syntra.example');

  it('accepts a request that arrived on the tenant own host', () => {
    expect(() => assertProtocolHost(asRequest('sso.acme.test'), id)).not.toThrow();
    expect(() => assertProtocolHost(asRequest('SSO.ACME.TEST:443'), id)).not.toThrow();
  });

  it('refuses the sibling-label attack that tenant resolution admits', () => {
    // tenant-context.ts resolves a tenant from the leftmost label, so this
    // host resolves tenant "sso" — and without this check an assertion would
    // be minted naming an issuer the attacker chose.
    expect(() => assertProtocolHost(asRequest('sso.acme.test.attacker.example'), id))
      .toThrow(ProblemError);
  });

  it('refuses a bare missing Host', () => {
    expect(() => assertProtocolHost(asRequest(''), id)).toThrow(ProblemError);
  });
});

describe('isProtocolEndpoint', () => {
  it('accepts https and http', () => {
    expect(isProtocolEndpoint('https://sp.example.test/acs')).toBe(true);
    expect(isProtocolEndpoint('http://localhost:3000/callback')).toBe(true);
  });

  it('refuses javascript, data and file URIs that z.string().url() accepts', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(isProtocolEndpoint(bad)).toBe(false);
    }
  });

  it('refuses a URI carrying a fragment, which RFC 6749 forbids on a redirect_uri', () => {
    expect(isProtocolEndpoint('https://sp.example.test/cb#frag')).toBe(false);
  });
});

describe('matchesAllowlist', () => {
  const allow = ['https://sp.example.test/acs', 'https://sp.example.test/acs2'];

  it('accepts an exact match', () => {
    expect(matchesAllowlist('https://sp.example.test/acs', allow)).toBe(true);
  });

  it('refuses a prefix, a suffix, a case change and a trailing slash', () => {
    for (const bad of [
      'https://sp.example.test/acs/../../evil',
      'https://sp.example.test/acs/',
      'https://sp.example.test/acsX',
      'https://sp.example.test/ACS',
      'https://sp.example.test',
      'https://evil.test/acs',
    ]) {
      expect(matchesAllowlist(bad, allow)).toBe(false);
    }
  });

  it('refuses everything when the allowlist is empty', () => {
    expect(matchesAllowlist('https://sp.example.test/acs', [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run apps/api/src/routes/protocol-identity.test.ts`
Expected: FAIL — `Cannot find module './protocol-identity.js'`.

- [ ] **Step 3: Write `packages/contracts/src/protocol.ts`**

```ts
/**
 * Whether a URL may be registered as a protocol endpoint: an assertion
 * consumer service URL, a redirect URI, a post-logout redirect URI, or an
 * upstream single sign-on URL.
 *
 * Stricter than `isLaunchableUrl`, which is about a tile a person clicks.
 * These are addresses a *protocol message* is delivered to, so on top of the
 * http(s) scheme rule two more apply:
 *
 * - No fragment. RFC 6749 section 3.1.2 forbids one on a redirect_uri, and a
 *   SAML ACS URL with a fragment cannot receive an HTTP-POST body at all.
 * - No credentials in the authority. `https://user:pass@sp.test/acs` and
 *   `https://sp.test/acs` are different strings that many SP libraries
 *   normalize to the same request, which is exactly the kind of gap an exact
 *   allowlist exists to close.
 */
export function isProtocolEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.hash !== '' || value.includes('#')) return false;
  if (url.username !== '' || url.password !== '') return false;
  return true;
}

/**
 * Exact string equality against a stored allowlist.
 *
 * Deliberately a plain `includes`, and deliberately not a URL comparison.
 * Spec section 7 says redirect URIs are matched exactly against the registered
 * allowlist, with no wildcard or prefix matching, and every documented
 * open-redirect in an identity product comes from a comparison that was
 * cleverer than this one: a `startsWith` that admits `/acs/../evil`, a
 * case-insensitive host compare that admits a homograph, a parsed comparison
 * that treats a trailing slash as equivalent. Storage normalizes on the way
 * in (Task 17 validates with `isProtocolEndpoint` and stores the string as
 * given); comparison does nothing at all.
 */
export function matchesAllowlist(
  candidate: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.includes(candidate);
}
```

Add to `packages/contracts/src/index.ts`:

```ts
export * from './protocol.js';
```

- [ ] **Step 4: Write `apps/api/src/routes/protocol-identity.ts`**

```ts
import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../plugins/problem-json.js';

/**
 * Every protocol identifier this tenant publishes.
 *
 * All of them are derived from the tenant's own configuration and from
 * `PUBLIC_URL`. None of them is derived from the request, and this function
 * takes no request, so the wrong thing does not compile.
 *
 * `tenant-context.ts` resolves a tenant from the leftmost label of the Host
 * header, so `acme.attacker.example` resolves tenant `acme`. An issuer, an
 * entity ID, an audience or a Destination built from that header would let an
 * attacker choose the value a relying party checks against — which is the
 * whole content of the identifier. `relying-party.ts` made the same decision
 * for WebAuthn; this is that decision applied to every remaining protocol
 * identifier.
 *
 * The scheme and port come from `PUBLIC_URL` because behind a TLS-terminating
 * proxy Fastify reports `http` unless told to trust forwarded headers, and an
 * issuer that says `http` where the relying party saw `https` fails discovery
 * with a message that points nowhere useful.
 */
export interface ProtocolIdentity {
  /** Scheme, host and port. No trailing slash. */
  base: string;
  /** The OIDC issuer. `oidc-provider` is constructed with exactly this. */
  issuer: string;
  /** The SAML IdP entity ID. */
  entityId: string;
  ssoUrl: string;
  sloUrl: string;
  /** The host the request must have arrived on. Lower case, no port. */
  acsHost: string;
}

export function tenantProtocolIdentity(
  tenant: { primaryDomain: string | null },
  publicUrl: string,
): ProtocolIdentity {
  const fallback = new URL(publicUrl);
  const host = tenant.primaryDomain ?? fallback.hostname;
  const port = fallback.port ? `:${fallback.port}` : '';
  const base = `${fallback.protocol}//${host}${port}`;

  return {
    base,
    issuer: `${base}/oidc`,
    entityId: `${base}/saml/idp`,
    ssoUrl: `${base}/saml/sso`,
    sloUrl: `${base}/saml/slo`,
    acsHost: host.toLowerCase(),
  };
}

/**
 * Refuses a protocol request that did not arrive on the host the tenant's own
 * identifiers name.
 *
 * Without this the derivation above is only half a control: an assertion
 * built with the correct issuer is still delivered over a connection the
 * browser believes belongs to `sso.acme.test.attacker.example`, and every
 * cookie and every relay-state round trip in the flow happens on that origin.
 * Applied at the first hook of every protocol route.
 */
export function assertProtocolHost(
  request: FastifyRequest,
  identity: ProtocolIdentity,
): void {
  const host = (request.headers.host ?? '').split(':')[0]!.toLowerCase();
  if (host !== '' && host === identity.acsHost) return;

  throw new ProblemError(
    421,
    'wrong-protocol-host',
    'Wrong address for this organization',
    `Single sign-on for this organization is served at ${identity.acsHost}. This request arrived at ${host || '(no host)'}.`,
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/api/src/routes/protocol-identity.test.ts`
Expected: PASS, all cases.

**Why these tests are not degenerate:** `matchesAllowlist`'s negative list contains the six specific strings a prefix, suffix, case-folding or URL-normalizing implementation would each accept, so no plausible wrong implementation passes. `assertProtocolHost`'s sibling-label case is the exact string the tenant resolver admits, so deleting the check fails that case rather than merely reducing coverage. The `tenantProtocolIdentity.length === 2` assertion fails the moment anyone adds a request parameter, which is the only way the Host header can get back in.

- [ ] **Step 6: Write the outbound-address guard, and its failing test**

The second boundary rule about addresses, and it lives here with the first for the same reason: it is a rule about what an administrator-supplied value is allowed to reach, with no dependency on any protocol.

SAML metadata import (Task 17) and upstream OIDC discovery (Task 15) are both server-side fetches to an address an administrator supplies. That is a server-side request forgery primitive: the deployment's own network is reachable from it, including cloud instance-metadata endpoints on `169.254.169.254`, and the import path *echoes the response back* — entity IDs, ACS URLs, certificates — which turns it from a blind primitive into a read.

A self-hosted product does legitimately federate to identity providers on private networks, so this is a refusal an operator can lift rather than a prohibition, and it is off by default.

Create `packages/core/src/net/outbound.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyAddress, fetchExternalDocument } from './outbound.js';

describe('classifyAddress', () => {
  it('refuses loopback, link-local, private, unique-local and unspecified', () => {
    for (const address of [
      '127.0.0.1', '127.5.5.5', '::1',
      '169.254.169.254', 'fe80::1',
      '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      'fc00::1', 'fd12::1',
      '0.0.0.0', '255.255.255.255', '224.0.0.1', '100.64.0.1',
    ]) {
      expect(classifyAddress(address)).toBe('blocked');
    }
  });

  it('refuses an IPv4-mapped IPv6 address that wraps a private one', () => {
    // ::ffff:10.0.0.1 IS 10.0.0.1. Measured: `ipaddr.parse` classifies all
    // three of these as `ipv4Mapped` and nothing more specific, so a
    // block-list naming only loopback, linkLocal and private lets every one of
    // them through. `ipaddr.process` unwraps them to their IPv4 form first —
    // verified to return loopback, private and linkLocal respectively — which
    // is why `classifyAddress` uses `process` and not `parse`.
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('blocked');
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('blocked');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('blocked');
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '203.0.113.5', '2606:4700::1111']) {
      expect(classifyAddress(address)).toBe('allowed');
    }
  });

  it('refuses anything it cannot parse rather than allowing it', () => {
    expect(classifyAddress('not-an-address')).toBe('blocked');
    expect(classifyAddress('')).toBe('blocked');
  });
});

describe('fetchExternalDocument', () => {
  let server: Server;

  const start = async (handler: Parameters<typeof createServer>[0]) => {
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));

  it('refuses a loopback host by default, naming the address it refused', async () => {
    const base = await start((_q, res) => res.end('should never be read'));
    try {
      await expect(fetchExternalDocument(`${base}/metadata`, {})).rejects.toThrow(
        /127\.0\.0\.1/,
      );
    } finally {
      await stop();
    }
  });

  it('fetches it when the deployment has allowed private addresses', async () => {
    const base = await start((_q, res) => {
      res.setHeader('content-type', 'application/xml');
      res.end('<EntityDescriptor/>');
    });
    try {
      const body = await fetchExternalDocument(`${base}/metadata`, {
        allowPrivateAddresses: true,
      });
      expect(body).toBe('<EntityDescriptor/>');
    } finally {
      await stop();
    }
  });

  it('refuses a redirect rather than following it', async () => {
    const base = await start((_q, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    });
    try {
      // A followed redirect is how a public hostname reaches a private one.
      await expect(
        fetchExternalDocument(`${base}/metadata`, { allowPrivateAddresses: true }),
      ).rejects.toThrow(/redirect/i);
    } finally {
      await stop();
    }
  });

  it('refuses a body past the ceiling', async () => {
    const base = await start((_q, res) => res.end('x'.repeat(200_000)));
    try {
      await expect(
        fetchExternalDocument(`${base}/metadata`, {
          allowPrivateAddresses: true, maxBytes: 1000,
        }),
      ).rejects.toThrow(/too large/i);
    } finally {
      await stop();
    }
  });

  it('refuses a scheme that is not http or https', async () => {
    await expect(fetchExternalDocument('file:///etc/passwd', {})).rejects.toThrow();
    await expect(fetchExternalDocument('gopher://x/', {})).rejects.toThrow();
  });
});
```

Create `packages/core/src/net/outbound.ts`:

```ts
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';

/** Ranges nothing an administrator types may resolve to, unless allowed. */
const BLOCKED_RANGES = new Set([
  'unspecified',
  'broadcast',
  'loopback',
  'linkLocal',
  'private',
  'uniqueLocal',
  'carrierGradeNat',
  'multicast',
  'reserved',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
]);

/**
 * Whether an address is one an outbound fetch may connect to.
 *
 * `ipaddr.process` unwraps an IPv4-mapped IPv6 address to its IPv4 form before
 * classifying. `ipaddr.parse` would answer `ipv4Mapped` for
 * `::ffff:169.254.169.254` and for every other wrapped address alike, so a
 * block-list written against `parse` and naming the ranges an operator thinks
 * of — loopback, linkLocal, private — lets all of them through. `ipv4Mapped`
 * is in the set below as well, so the control holds either way.
 *
 * Anything that will not parse is blocked, not allowed. A classifier that
 * fails open is not a control.
 */
export function classifyAddress(address: string): 'allowed' | 'blocked' {
  let parsed: ReturnType<typeof ipaddr.process>;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return 'blocked';
  }
  return BLOCKED_RANGES.has(parsed.range()) ? 'blocked' : 'allowed';
}

export interface OutboundOptions {
  /** Lifts the private-address refusal. From `OUTBOUND_ALLOW_PRIVATE`. */
  allowPrivateAddresses?: boolean | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetches a document from an address an administrator supplied.
 *
 * **Every resolved address is checked, and the connection is then pinned to
 * the one that was checked.** Resolving, checking, and then handing the
 * hostname to a fetch would leave a DNS-rebinding window: a name that answered
 * with a public address for the check can answer with `169.254.169.254` for
 * the connection microseconds later, and that is the usual way this is
 * exploited rather than an exotic one. Connecting to the literal address, with
 * the `Host` header and TLS `servername` still set to the original hostname,
 * closes it — certificate validation is unaffected because `servername` drives
 * both SNI and the name check.
 *
 * Redirects are refused rather than followed: a public hostname that redirects
 * inward defeats the check just as thoroughly as a rebinding one, and no
 * legitimate metadata document needs a redirect.
 *
 * Never called inside a transaction — this is network I/O and Global
 * Constraint 1 applies.
 */
export async function fetchExternalDocument(
  rawUrl: string,
  options: OutboundOptions,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a usable address: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https addresses may be fetched, not ${url.protocol}`);
  }

  const resolved = await lookup(url.hostname, { all: true });
  if (resolved.length === 0) {
    throw new Error(`${url.hostname} resolves to no address`);
  }

  if (!options.allowPrivateAddresses) {
    for (const entry of resolved) {
      if (classifyAddress(entry.address) === 'blocked') {
        throw new Error(
          `${url.hostname} resolves to ${entry.address}, which is inside this deployment's own network. ` +
            'Set OUTBOUND_ALLOW_PRIVATE=true if that is intended.',
        );
      }
    }
  }

  // The first resolved address, and the connection is pinned to it.
  const address = resolved[0]!.address;
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<string>((resolve, reject) => {
    const req = send(
      {
        host: address,
        servername: secure ? url.hostname : undefined,
        port: url.port !== '' ? Number(url.port) : secure ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, accept: 'application/xml, text/xml, application/json' },
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new Error(`${url.href} answered with a redirect, which is not followed`));
          return;
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          reject(new Error(`${url.href} answered ${status}`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new Error(`${url.href} returned a document that is too large`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`${url.href} did not answer in time`));
    });
    req.on('error', reject);
    req.end();
  });
}
```

Add `OUTBOUND_ALLOW_PRIVATE` to `packages/core/src/config.ts`:

```ts
  /**
   * Whether outbound fetches to an administrator-supplied address may reach
   * this deployment's own network.
   *
   * Off by default. SAML metadata import and upstream OIDC discovery both
   * fetch a URL an administrator typed, and the import path echoes what it
   * read back to them — so by default a hostname resolving to loopback,
   * link-local, a private range or a unique-local range is refused, naming the
   * address so an operator can see why.
   *
   * A self-hosted deployment federating to an on-premises identity provider
   * genuinely needs this on, which is why it is a switch and not a rule.
   */
  OUTBOUND_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
```

and to the `Config` interface and the returned object as `outboundAllowPrivate: v.OUTBOUND_ALLOW_PRIVATE`. Export the module from `packages/core/src/index.ts`. `apps/api/src/test-support.ts` sets `OUTBOUND_ALLOW_PRIVATE: 'true'` in the env it hands `loadConfig`, because Task 15's stub upstream listens on `127.0.0.1`. Two tests override it back to `'false'` — one in Step 3 of this task and one in Task 15 — so the shipped default is the one under test in both places. `buildTestApp` already merges `options.env` over its defaults, so no change to the helper is needed beyond the new default.

Run: `pnpm vitest run packages/core/src/net/outbound.test.ts`
Expected: PASS, all nine cases.

**Why these tests are not degenerate.** The IPv4-mapped cases are the ones a classifier written against `ipaddr.parse().range()` alone fails — `::ffff:10.0.0.1` reads as `unicast` there, and `ipaddr.process` is what unwraps it. The unparseable case pins fail-closed. The redirect case uses a real server answering a 302 to the instance-metadata address, which is the actual exploitation route rather than a hypothetical one.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/net packages/core/src/config.ts packages/core/src/index.ts packages/contracts/src/protocol.ts packages/contracts/src/index.ts apps/api/src/routes/protocol-identity.ts apps/api/src/routes/protocol-identity.test.ts
git commit -m "feat(access): protocol identity from tenant config, and the outbound address guard"
```

---

## Task 3: Signing keys and rotation with overlap

**Files:**
- Create: `packages/core/src/keys/signing-key-service.ts`
- Create: `packages/core/src/keys/signing-key-service.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json` (add `@peculiar/x509` `2.0.0`, `reflect-metadata` `0.2.2`, `jose` `6.2.9`)

**Interfaces:**
- Consumes: `withTenant` from `@syntra/db`; `putSecret` / `getSecret` / `MasterKeyProvider` from `packages/core/src/vault/`.
- Produces:
  ```ts
  export type KeyKind = 'oidc' | 'saml';
  export interface PublishedKey {
    kid: string; alg: string; status: 'active' | 'outgoing';
    publicJwk: Record<string, unknown>; certificate: string | null;
    notBefore: Date; notAfter: Date;
  }
  export interface ActiveKey extends PublishedKey {
    status: 'active';
    /** PKCS#8 PEM. Read from the vault; never stored on the row. */
    privateKeyPem: string;
  }
  export function ensureActiveKey(tenantId: string, provider: MasterKeyProvider, kind: KeyKind, opts?: { commonName?: string; now?: Date }): Promise<ActiveKey>;
  export function loadActiveKey(tenantId: string, provider: MasterKeyProvider, kind: KeyKind): Promise<ActiveKey | null>;
  export function publishedKeys(tenantId: string, kind: KeyKind, now?: Date): Promise<PublishedKey[]>;
  export function rotateKey(tenantId: string, provider: MasterKeyProvider, kind: KeyKind, opts?: { overlapMs?: number; commonName?: string; now?: Date }): Promise<{ incoming: ActiveKey; outgoing: PublishedKey | null }>;
  export function retireExpiredKeys(tenantId: string, kind: KeyKind, now?: Date): Promise<number>;
  export function readSigningKeyPem(tenantId: string, provider: MasterKeyProvider, kind: KeyKind, kid: string): Promise<string | null>;
  ```

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter @syntra/core add @peculiar/x509@2.0.0 reflect-metadata@0.2.2 jose@6.2.9
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/keys/signing-key-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPublicKey, createVerify, X509Certificate } from 'node:crypto';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  ensureActiveKey,
  loadActiveKey,
  publishedKeys,
  readSigningKeyPem,
  retireExpiredKeys,
  rotateKey,
} from './signing-key-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('signing keys', () => {
  it('creates one on demand and returns the same one next time', async () => {
    const a = await ensureActiveKey(tenantId, provider, 'oidc');
    const b = await ensureActiveKey(tenantId, provider, 'oidc');
    expect(b.kid).toBe(a.kid);
    const rows = await withTenant(tenantId, (tx) => tx.signingKey.findMany());
    expect(rows).toHaveLength(1);
  });

  it('never stores the private key on the row', async () => {
    const key = await ensureActiveKey(tenantId, provider, 'oidc');
    const row = await withTenant(tenantId, (tx) =>
      tx.signingKey.findFirstOrThrow({ where: { kid: key.kid } }),
    );
    // The row carries a vault reference, not the material. Serialised whole
    // it must contain nothing that looks like a private key.
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    expect(row.secretName).toBe(`signing:oidc:${key.kid}`);
  });

  it('produces a private key whose signature verifies under the published JWK', async () => {
    const key = await ensureActiveKey(tenantId, provider, 'oidc');
    const message = Buffer.from('the assertion bytes');
    const signature = createVerify; // placeholder to keep the import honest
    void signature;
    const { createSign } = await import('node:crypto');
    const sig = createSign('RSA-SHA256').update(message).sign(key.privateKeyPem);
    const pub = createPublicKey({ key: key.publicJwk as never, format: 'jwk' });
    expect(createVerify('RSA-SHA256').update(message).verify(pub, sig)).toBe(true);
  });

  it('issues a self-signed certificate for the saml kind and none for oidc', async () => {
    const saml = await ensureActiveKey(tenantId, provider, 'saml', {
      commonName: 'sso.acme.test',
    });
    expect(saml.certificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(new X509Certificate(saml.certificate!).subject).toContain('sso.acme.test');
    const oidc = await ensureActiveKey(tenantId, provider, 'oidc');
    expect(oidc.certificate).toBeNull();
  });

  it('publishes the outgoing key alongside the incoming one for the length of a rollover', async () => {
    const first = await ensureActiveKey(tenantId, provider, 'oidc');
    const { incoming, outgoing } = await rotateKey(tenantId, provider, 'oidc', {
      overlapMs: 60_000,
    });

    expect(incoming.kid).not.toBe(first.kid);
    expect(outgoing?.kid).toBe(first.kid);

    const published = await publishedKeys(tenantId, 'oidc');
    // Both, and the incoming one first — a relying party that takes the head
    // of the list must land on the key new tokens are signed with.
    expect(published.map((k) => k.kid)).toEqual([incoming.kid, first.kid]);
    expect(published.map((k) => k.status)).toEqual(['active', 'outgoing']);

    // And the one that signs is the new one.
    const live = await loadActiveKey(tenantId, provider, 'oidc');
    expect(live?.kid).toBe(incoming.kid);
  });

  it('stops publishing the outgoing key once the overlap has passed', async () => {
    await ensureActiveKey(tenantId, provider, 'oidc');
    const { outgoing } = await rotateKey(tenantId, provider, 'oidc', { overlapMs: 1000 });
    const later = new Date(Date.now() + 5000);

    const published = await publishedKeys(tenantId, 'oidc', later);
    expect(published.map((k) => k.kid)).not.toContain(outgoing!.kid);

    const retired = await retireExpiredKeys(tenantId, 'oidc', later);
    expect(retired).toBe(1);
    const row = await withTenant(tenantId, (tx) =>
      tx.signingKey.findFirstOrThrow({ where: { kid: outgoing!.kid } }),
    );
    expect(row.status).toBe('retired');
  });

  it('reads a published key private half by kid, and refuses a retired one', async () => {
    const first = await ensureActiveKey(tenantId, provider, 'oidc');
    const { outgoing } = await rotateKey(tenantId, provider, 'oidc', { overlapMs: 1000 });

    // Both published keys are readable during the rollover — the OIDC
    // provider signs with one and must still verify the other.
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', first.kid))
      .toContain('PRIVATE KEY');
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', outgoing!.kid))
      .toContain('PRIVATE KEY');

    await retireExpiredKeys(tenantId, 'oidc', new Date(Date.now() + 5000));
    // Retired means gone, not merely unpublished.
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', outgoing!.kid)).toBeNull();
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', 'no-such-kid')).toBeNull();
  });

  it('keeps two tenants keys apart', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    const a = await ensureActiveKey(tenantId, provider, 'oidc');
    const b = await ensureActiveKey(other.id, provider, 'oidc');
    expect(a.kid).not.toBe(b.kid);
    const seen = await publishedKeys(other.id, 'oidc');
    expect(seen.map((k) => k.kid)).toEqual([b.kid]);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm vitest run packages/core/src/keys/signing-key-service.test.ts`
Expected: FAIL — `Cannot find module './signing-key-service.js'`.

- [ ] **Step 4: Write the service**

Create `packages/core/src/keys/signing-key-service.ts`. Note the first line: `@peculiar/x509` pulls `tsyringe`, which throws `tsyringe requires a reflect polyfill` unless `reflect-metadata` has already executed. This was reproduced during planning; the import must come first and must not be reordered by a formatter.

```ts
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  webcrypto,
} from 'node:crypto';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import { withTenant, type TenantClient } from '@syntra/db';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export type KeyKind = 'oidc' | 'saml';

const ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

/** Three years. A SAML SP typically pins the certificate for its lifetime. */
const LIFETIME_MS = 3 * 365 * 24 * 60 * 60 * 1000;
/** How long an outgoing key stays published by default. */
const DEFAULT_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

export interface PublishedKey {
  kid: string;
  alg: string;
  status: 'active' | 'outgoing';
  publicJwk: Record<string, unknown>;
  certificate: string | null;
  notBefore: Date;
  notAfter: Date;
}

export interface ActiveKey extends PublishedKey {
  status: 'active';
  /** PKCS#8 PEM, read from the vault. Never stored on the row. */
  privateKeyPem: string;
}

interface GeneratedKey {
  kid: string;
  publicJwk: Record<string, unknown>;
  privateKeyPem: string;
  certificate: string | null;
  notBefore: Date;
  notAfter: Date;
}

/**
 * Generates a key pair and, for SAML, a self-signed certificate.
 *
 * Deliberately outside any transaction and called before one opens. RSA-2048
 * generation is hundreds of milliseconds and certificate signing is more;
 * inside `withTenant` that is a meaningful fraction of Prisma's 5000 ms
 * interactive-transaction budget, spent on work that touches no row.
 */
async function generate(
  kind: KeyKind,
  commonName: string,
  now: Date,
): Promise<GeneratedKey> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const pkcs8 = Buffer.from(
    await webcrypto.subtle.exportKey('pkcs8', keys.privateKey),
  );
  const privateKeyObject = createPrivateKey({
    key: pkcs8,
    format: 'der',
    type: 'pkcs8',
  });
  const privateKeyPem = privateKeyObject
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

  const jwk = (await exportJWK(createPublicKey(privateKeyObject))) as Record<
    string,
    unknown
  >;
  // RFC 7638 over the public members only, so the kid is stable and carries
  // no secret. jose refuses to thumbprint a JWK holding private members,
  // which is the check that would catch exporting the wrong key here.
  const kid = await calculateJwkThumbprint(jwk as never, 'sha256');
  const publicJwk = { ...jwk, kid, alg: 'RS256', use: 'sig' };

  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + LIFETIME_MS);

  let certificate: string | null = null;
  if (kind === 'saml') {
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomUUID().replace(/-/g, ''),
      name: `CN=${commonName}`,
      notBefore,
      notAfter,
      signingAlgorithm: ALG,
      keys,
      extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
    });
    certificate = cert.toString('pem');
  }

  return { kid, publicJwk, privateKeyPem, certificate, notBefore, notAfter };
}

const secretNameFor = (kind: KeyKind, kid: string) => `signing:${kind}:${kid}`;

async function insert(
  tx: TenantClient,
  tenantId: string,
  kind: KeyKind,
  generated: GeneratedKey,
  provider: MasterKeyProvider,
  status: 'active',
): Promise<void> {
  const secretName = secretNameFor(kind, generated.kid);
  // The material goes to the vault and the row gets only its name. AES-GCM
  // wrapping is microseconds, so this one belongs inside the transaction:
  // a row that names a secret which was never written is a key that cannot
  // sign, and the two must commit together.
  await putSecret(tx, provider, secretName, generated.privateKeyPem);
  await tx.signingKey.create({
    data: {
      tenantId,
      kind,
      kid: generated.kid,
      alg: 'RS256',
      publicJwk: generated.publicJwk as never,
      certificate: generated.certificate,
      secretName,
      status,
      notBefore: generated.notBefore,
      notAfter: generated.notAfter,
    },
  });
}

const toPublished = (row: {
  kid: string;
  alg: string;
  status: string;
  publicJwk: unknown;
  certificate: string | null;
  notBefore: Date;
  notAfter: Date;
}): PublishedKey => ({
  kid: row.kid,
  alg: row.alg,
  status: row.status === 'outgoing' ? 'outgoing' : 'active',
  publicJwk: row.publicJwk as Record<string, unknown>,
  certificate: row.certificate,
  notBefore: row.notBefore,
  notAfter: row.notAfter,
});

/** The active key, with its private material, or null if there is none. */
export async function loadActiveKey(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
): Promise<ActiveKey | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.signingKey.findFirst({
      where: { kind, status: 'active' },
    });
    if (!row) return null;
    const privateKeyPem = await getSecret(tx, provider, row.secretName);
    if (!privateKeyPem) {
      throw new Error(
        `signing key ${row.kid} names vault secret ${row.secretName}, which does not exist`,
      );
    }
    return { ...toPublished(row), status: 'active' as const, privateKeyPem };
  });
}

/**
 * The active key, creating one if the tenant has none.
 *
 * Generation happens outside the transaction; the insert races only against
 * another process doing the same thing, and `signing_key_one_active` decides
 * that race. The loser re-reads rather than failing, so a first sign-in that
 * arrives on two workers at once still signs.
 */
export async function ensureActiveKey(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
  opts: { commonName?: string; now?: Date } = {},
): Promise<ActiveKey> {
  const existing = await loadActiveKey(tenantId, provider, kind);
  if (existing) return existing;

  const generated = await generate(
    kind,
    opts.commonName ?? 'syntra',
    opts.now ?? new Date(),
  );

  try {
    await withTenant(tenantId, (tx) =>
      insert(tx, tenantId, kind, generated, provider, 'active'),
    );
  } catch {
    // Another worker won. Its key is as good as this one.
  }

  const active = await loadActiveKey(tenantId, provider, kind);
  if (!active) throw new Error(`could not establish a ${kind} signing key`);
  return active;
}

/**
 * What the JWKS document and the SAML metadata publish: the active key, and
 * the outgoing one while its overlap is still running.
 *
 * Ordered active-first. A relying party that caches by `kid` reads both; one
 * that naively takes the first key must land on the one new tokens are signed
 * with, or every fresh token fails validation for the length of the rollover.
 */
export async function publishedKeys(
  tenantId: string,
  kind: KeyKind,
  now: Date = new Date(),
): Promise<PublishedKey[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.signingKey.findMany({
      where: {
        kind,
        OR: [
          { status: 'active' },
          { status: 'outgoing', notAfter: { gt: now } },
        ],
      },
    });
    return rows
      .map(toPublished)
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
  });
}

/**
 * Rolls the key over.
 *
 * The old key becomes `outgoing` and its `notAfter` is pulled in to the end of
 * the overlap window, which is what `publishedKeys` filters on. Spec section 7
 * asks for the outgoing key to be published alongside the incoming one for the
 * duration of the rollover; this is that duration, written on the row rather
 * than held in a scheduler's memory, so a restart mid-rollover does not drop
 * the old key and invalidate every token in flight.
 */
export async function rotateKey(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
  opts: { overlapMs?: number; commonName?: string; now?: Date } = {},
): Promise<{ incoming: ActiveKey; outgoing: PublishedKey | null }> {
  const now = opts.now ?? new Date();
  const overlapMs = opts.overlapMs ?? DEFAULT_OVERLAP_MS;
  const generated = await generate(kind, opts.commonName ?? 'syntra', now);

  const outgoing = await withTenant(tenantId, async (tx) => {
    const previous = await tx.signingKey.findFirst({
      where: { kind, status: 'active' },
    });
    if (previous) {
      await tx.signingKey.update({
        where: { id: previous.id },
        data: {
          status: 'outgoing',
          notAfter: new Date(now.getTime() + overlapMs),
        },
      });
    }
    // Only after the previous row has left 'active' — signing_key_one_active
    // is what makes this ordering load-bearing rather than stylistic.
    await insert(tx, tenantId, kind, generated, provider, 'active');
    return previous
      ? toPublished({
          ...previous,
          status: 'outgoing',
          notAfter: new Date(now.getTime() + overlapMs),
        })
      : null;
  });

  const incoming = await loadActiveKey(tenantId, provider, kind);
  if (!incoming) throw new Error('rotation left no active key');
  return { incoming, outgoing };
}

/**
 * The private PEM for one published key, named by its kid.
 *
 * Null once the key is retired, so a rollover that has finished cannot be
 * talked into signing with the old material. Task 11's OIDC provider needs
 * every *published* key's private half — it signs with the active one and must
 * still be able to verify a token signed with the outgoing one — which is the
 * one caller `loadActiveKey` cannot serve.
 */
export async function readSigningKeyPem(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
  kid: string,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.signingKey.findFirst({ where: { kind, kid } });
    if (!row || row.status === 'retired') return null;
    return getSecret(tx, provider, row.secretName);
  });
}

/** Marks overlapped-out keys retired. Returns how many. */
export async function retireExpiredKeys(
  tenantId: string,
  kind: KeyKind,
  now: Date = new Date(),
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.signingKey.updateMany({
      where: { kind, status: 'outgoing', notAfter: { lte: now } },
      data: { status: 'retired', retiredAt: now },
    });
    return result.count;
  });
}
```

- [ ] **Step 5: Export from core**

Add to `packages/core/src/index.ts`, after the vault exports:

```ts
export * from './keys/signing-key-service.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/keys/signing-key-service.test.ts`
Expected: PASS, all eight cases.

**Why these tests are not degenerate.** The sign-and-verify case actually signs bytes with the returned private key and verifies them against the *published* JWK, so a service that returned a mismatched pair — the easiest way to get this wrong — fails rather than passing on a shape check. The rollover case asserts the ordering of `publishedKeys` and that `loadActiveKey` returns the *new* kid, so an implementation that published both keys but kept signing with the old one fails. The "never stores the private key" case serialises the whole row, so it fails if the material is added to any column later.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/keys packages/core/src/index.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): per-tenant signing keys with overlapping rotation"
```

---

## Task 4: Claim mappings — multi-contract resolution, and omission rather than emptiness

**Files:**
- Create: `packages/core/src/access/claims/types.ts`
- Create: `packages/core/src/access/claims/resolve.ts` (pure)
- Create: `packages/core/src/access/claims/resolve.test.ts`
- Create: `packages/core/src/access/claims/collect.ts` (reads rows)
- Create: `packages/core/src/access/claims/collect.test.ts`
- Create: `packages/core/src/access/claim-mapping-service.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `resolveContractForMapping(tx, personId, strategy, on)` and `activeContracts` from `packages/core/src/identity/contract-service.js`; `listGroupsForUser` from `packages/core/src/directory/group-service.js`; `withTenant`, `TenantClient` from `@syntra/db`.
- Produces:
  ```ts
  export type ClaimProtocol = 'saml' | 'oidc';
  export type ClaimSourceKind = 'user' | 'person' | 'contract' | 'attribute' | 'groups' | 'literal';
  export interface ClaimMappingSpec {
    id: string; protocol: ClaimProtocol; claimName: string; nameFormat: string;
    sourceKind: ClaimSourceKind; sourceField: string | null;
    contractStrategy: 'primary' | 'lowestSequence';
    literalValue: string | null; releaseScope: string | null; multiValued: boolean;
  }
  export interface SubjectFacts {
    user: Record<string, string | null>;
    person: Record<string, string | null> | null;
    /** The contract each strategy selects, or null when none is in force. */
    contract: { primary: Record<string, string | null> | null; lowestSequence: Record<string, string | null> | null };
    attributes: Record<string, string>;
    groups: string[];
  }
  export interface ResolvedClaim { name: string; nameFormat: string; values: string[]; releaseScope: string | null }
  export function resolveClaims(mappings: ClaimMappingSpec[], facts: SubjectFacts, protocol: ClaimProtocol): ResolvedClaim[];
  export function collectSubjectFacts(tx: TenantClient, userId: string, now?: Date): Promise<SubjectFacts>;
  export function listClaimMappings(tx: TenantClient, applicationId: string, protocol: ClaimProtocol): Promise<ClaimMappingSpec[]>;
  export function createClaimMapping(tx: TenantClient, applicationId: string, input: Omit<ClaimMappingSpec, 'id'>): Promise<ClaimMappingSpec>;
  export function deleteClaimMapping(tx: TenantClient, id: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing pure test**

Create `packages/core/src/access/claims/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveClaims } from './resolve.js';
import type { ClaimMappingSpec, SubjectFacts } from './types.js';

const mapping = (over: Partial<ClaimMappingSpec>): ClaimMappingSpec => ({
  id: 'm1',
  protocol: 'oidc',
  claimName: 'department',
  nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
  sourceKind: 'contract',
  sourceField: 'department',
  contractStrategy: 'primary',
  literalValue: null,
  releaseScope: null,
  multiValued: false,
  ...over,
});

const facts = (over: Partial<SubjectFacts> = {}): SubjectFacts => ({
  user: { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' },
  person: { givenName: 'J', familyName: 'Doe', businessEmail: 'j@acme.test' },
  contract: { primary: null, lowestSequence: null },
  attributes: {},
  groups: [],
  ...over,
});

describe('resolveClaims', () => {
  it('reads the primary contract when the mapping says primary', () => {
    const out = resolveClaims(
      [mapping({ contractStrategy: 'primary' })],
      facts({
        contract: {
          primary: { department: 'Finance', jobTitle: 'Controller' },
          lowestSequence: { department: 'Care', jobTitle: 'Nurse' },
        },
      }),
      'oidc',
    );
    expect(out).toEqual([
      { name: 'department', nameFormat: expect.any(String), values: ['Finance'], releaseScope: null },
    ]);
  });

  it('reads the lowest-sequence active contract when the mapping says so', () => {
    const out = resolveClaims(
      [mapping({ contractStrategy: 'lowestSequence' })],
      facts({
        contract: {
          primary: { department: 'Finance' },
          lowestSequence: { department: 'Care' },
        },
      }),
      'oidc',
    );
    expect(out[0]!.values).toEqual(['Care']);
  });

  it('omits the claim entirely when the strategy resolves to no contract', () => {
    const out = resolveClaims([mapping({})], facts(), 'oidc');
    // Not [{ name: 'department', values: [] }] and not values: ['']. The
    // claim is absent. A relying party that branches on presence must see
    // absence, and an SP that renders an empty <AttributeValue/> shows a
    // person a blank department they never had.
    expect(out).toEqual([]);
  });

  it('omits the claim when the selected contract has the field but it is null', () => {
    const out = resolveClaims(
      [mapping({})],
      facts({ contract: { primary: { department: null }, lowestSequence: null } }),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('omits the claim when the selected contract has an empty string', () => {
    const out = resolveClaims(
      [mapping({})],
      facts({ contract: { primary: { department: '  ' }, lowestSequence: null } }),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('emits a person with concurrent contracts once per mapping, not once per contract', () => {
    const out = resolveClaims(
      [
        mapping({ id: 'a', claimName: 'dept_primary', contractStrategy: 'primary' }),
        mapping({ id: 'b', claimName: 'dept_first', contractStrategy: 'lowestSequence' }),
      ],
      facts({
        contract: {
          primary: { department: 'Finance' },
          lowestSequence: { department: 'Care' },
        },
      }),
      'oidc',
    );
    expect(out.map((c) => [c.name, c.values])).toEqual([
      ['dept_primary', ['Finance']],
      ['dept_first', ['Care']],
    ]);
  });

  it('reads user, person, attribute, groups and literal sources', () => {
    const out = resolveClaims(
      [
        mapping({ id: '1', claimName: 'email', sourceKind: 'user', sourceField: 'email' }),
        mapping({ id: '2', claimName: 'family_name', sourceKind: 'person', sourceField: 'familyName' }),
        mapping({ id: '3', claimName: 'costCentre', sourceKind: 'attribute', sourceField: 'cost_centre' }),
        mapping({ id: '4', claimName: 'groups', sourceKind: 'groups', sourceField: null, multiValued: true }),
        mapping({ id: '5', claimName: 'tenant', sourceKind: 'literal', sourceField: null, literalValue: 'acme' }),
      ],
      facts({ attributes: { cost_centre: 'CC-1' }, groups: ['Finance', 'All Staff'] }),
      'oidc',
    );
    expect(out.map((c) => [c.name, c.values])).toEqual([
      ['email', ['j@acme.test']],
      ['family_name', ['Doe']],
      ['costCentre', ['CC-1']],
      ['groups', ['Finance', 'All Staff']],
      ['tenant', ['acme']],
    ]);
  });

  it('omits a groups claim for a user in no groups', () => {
    const out = resolveClaims(
      [mapping({ claimName: 'groups', sourceKind: 'groups', sourceField: null, multiValued: true })],
      facts({ groups: [] }),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('takes only the first value when the mapping is not multi-valued', () => {
    const out = resolveClaims(
      [mapping({ claimName: 'group', sourceKind: 'groups', sourceField: null, multiValued: false })],
      facts({ groups: ['Finance', 'All Staff'] }),
      'oidc',
    );
    expect(out[0]!.values).toEqual(['Finance']);
  });

  it('ignores mappings belonging to the other protocol', () => {
    const out = resolveClaims(
      [mapping({ protocol: 'saml', claimName: 'onlySaml', sourceKind: 'literal', literalValue: 'x' })],
      facts(),
      'oidc',
    );
    expect(out).toEqual([]);
  });

  it('omits an unknown source kind rather than emitting undefined', () => {
    const out = resolveClaims(
      [mapping({ sourceKind: 'nonsense' as never })],
      facts(),
      'oidc',
    );
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/core/src/access/claims/resolve.test.ts`
Expected: FAIL — `Cannot find module './resolve.js'`.

- [ ] **Step 3: Write `types.ts` and `resolve.ts`**

`packages/core/src/access/claims/types.ts`:

```ts
export type ClaimProtocol = 'saml' | 'oidc';

export type ClaimSourceKind =
  | 'user'
  | 'person'
  | 'contract'
  | 'attribute'
  | 'groups'
  | 'literal';

export type ContractStrategy = 'primary' | 'lowestSequence';

export interface ClaimMappingSpec {
  id: string;
  protocol: ClaimProtocol;
  claimName: string;
  nameFormat: string;
  sourceKind: ClaimSourceKind;
  sourceField: string | null;
  contractStrategy: ContractStrategy;
  literalValue: string | null;
  releaseScope: string | null;
  multiValued: boolean;
}

/**
 * Everything a mapping may read, assembled once by `collect.ts`.
 *
 * The two contract slots are pre-resolved rather than a list, and that is the
 * point: spec section 6 says the *mapping* declares which contract supplies
 * the value, so the choice belongs to `resolveContractForMapping` in the
 * identity layer — which already implements both strategies and is already
 * tested — and not to a second reading of the rule inside the claim engine.
 * Either slot is null when that strategy selects no active contract.
 */
export interface SubjectFacts {
  user: Record<string, string | null>;
  person: Record<string, string | null> | null;
  contract: {
    primary: Record<string, string | null> | null;
    lowestSequence: Record<string, string | null> | null;
  };
  attributes: Record<string, string>;
  groups: string[];
}

export interface ResolvedClaim {
  name: string;
  /** SAML AttributeNameFormat. Ignored by the OIDC side. */
  nameFormat: string;
  values: string[];
  releaseScope: string | null;
}
```

`packages/core/src/access/claims/resolve.ts`:

```ts
import type {
  ClaimMappingSpec,
  ClaimProtocol,
  ResolvedClaim,
  SubjectFacts,
} from './types.js';

/**
 * A value counts as present only if it is a non-empty string once trimmed.
 *
 * Null, undefined and whitespace all mean "this person has no such value",
 * and spec section 6 says such a claim is omitted rather than emitted empty.
 * Emitting an empty attribute is worse than omitting it in both directions: a
 * relying party that branches on presence takes the wrong branch, and one that
 * renders the value shows a person a blank field they never had.
 */
function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function valuesFor(
  mapping: ClaimMappingSpec,
  facts: SubjectFacts,
): string[] {
  switch (mapping.sourceKind) {
    case 'literal':
      return present(mapping.literalValue) ? [mapping.literalValue] : [];

    case 'groups':
      return facts.groups.filter(present);

    case 'user': {
      if (!mapping.sourceField) return [];
      const value = facts.user[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    case 'person': {
      if (!mapping.sourceField || !facts.person) return [];
      const value = facts.person[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    case 'attribute': {
      if (!mapping.sourceField) return [];
      const value = facts.attributes[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    case 'contract': {
      if (!mapping.sourceField) return [];
      // The mapping declares the strategy; the strategy declares the
      // contract. A person holding several concurrent contracts gets the one
      // their administrator named, and a person holding none gets nothing.
      const contract = facts.contract[mapping.contractStrategy];
      if (!contract) return [];
      const value = contract[mapping.sourceField];
      return present(value) ? [value] : [];
    }

    default:
      // A source kind this build does not know. Omitted rather than guessed:
      // a row written by a newer version must not become an empty claim in an
      // older one.
      return [];
  }
}

/**
 * Turns a tenant's mappings into the claims one application receives.
 *
 * Pure. Everything it may read is in `facts`, which is what makes the
 * multi-contract matrix exhaustively testable without a database, as spec
 * section 13 requires.
 *
 * Mappings for the other protocol are skipped, and a mapping that resolves to
 * no value produces no entry at all.
 */
export function resolveClaims(
  mappings: ClaimMappingSpec[],
  facts: SubjectFacts,
  protocol: ClaimProtocol,
): ResolvedClaim[] {
  const out: ResolvedClaim[] = [];

  for (const mapping of mappings) {
    if (mapping.protocol !== protocol) continue;

    const all = valuesFor(mapping, facts);
    if (all.length === 0) continue;

    const values = mapping.multiValued ? all : [all[0]!];
    out.push({
      name: mapping.claimName,
      nameFormat: mapping.nameFormat,
      values,
      releaseScope: mapping.releaseScope,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run the pure tests**

Run: `pnpm vitest run packages/core/src/access/claims/resolve.test.ts`
Expected: PASS, all eleven cases.

**Why these tests are not degenerate:** four separate cases pin *omission* against the three ways an implementation naturally emits emptiness (`values: []`, `values: ['']`, a whitespace value), and the two-mapping case would pass for an implementation that ignored `contractStrategy` only if both strategies happened to select the same contract — so it is written with them selecting different ones.

- [ ] **Step 5: Write the failing collector test**

Create `packages/core/src/access/claims/collect.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import { createGroup, addMember } from '../../directory/group-service.js';
import { createPerson } from '../../identity/person-service.js';
import { createContract } from '../../identity/contract-service.js';
import { collectSubjectFacts } from './collect.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('collectSubjectFacts', () => {
  it('selects a different contract for each strategy when they disagree', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      // Sequence 1 is Care and is not primary; sequence 2 is Finance and is.
      await createContract(tx, person.id, {
        sequence: 1, startDate: new Date('2020-01-01'), department: 'Care',
      });
      await createContract(tx, person.id, {
        sequence: 2, isPrimary: true, startDate: new Date('2021-01-01'), department: 'Finance',
      });
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return collectSubjectFacts(tx, user.id, new Date('2024-06-01'));
    });

    expect(facts.contract.primary?.department).toBe('Finance');
    expect(facts.contract.lowestSequence?.department).toBe('Care');
  });

  it('leaves both contract slots null when every contract has ended', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await createContract(tx, person.id, {
        sequence: 1, isPrimary: true,
        startDate: new Date('2020-01-01'), endDate: new Date('2021-01-01'),
        department: 'Care',
      });
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return collectSubjectFacts(tx, user.id, new Date('2024-06-01'));
    });

    expect(facts.contract.primary).toBeNull();
    expect(facts.contract.lowestSequence).toBeNull();
  });

  it('leaves the primary slot null when the primary contract has ended but another has not', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await createContract(tx, person.id, {
        sequence: 1, isPrimary: true,
        startDate: new Date('2020-01-01'), endDate: new Date('2021-01-01'),
        department: 'Care',
      });
      await createContract(tx, person.id, {
        sequence: 2, startDate: new Date('2021-01-01'), department: 'Finance',
      });
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return collectSubjectFacts(tx, user.id, new Date('2024-06-01'));
    });

    // resolveContractForMapping('primary') looks for isPrimary among the
    // ACTIVE contracts. The ended primary is not among them, so this is null
    // and every claim mapped to the primary contract is omitted — which is
    // the behaviour spec section 6 asks for, not a fallback to the other one.
    expect(facts.contract.primary).toBeNull();
    expect(facts.contract.lowestSequence?.department).toBe('Finance');
  });

  it('collects a user with no person at all', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'svc', email: 's@acme.test', displayName: 'Service',
      });
      return collectSubjectFacts(tx, user.id);
    });
    expect(facts.person).toBeNull();
    expect(facts.contract).toEqual({ primary: null, lowestSequence: null });
    expect(facts.user.login).toBe('svc');
  });

  it('collects group names and user attributes', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      const group = await createGroup(tx, { name: 'Finance' });
      await addMember(tx, group.id, user.id);
      await tx.userAttribute.create({
        data: { tenantId, userId: user.id, key: 'cost_centre', type: 'string', value: 'CC-1' },
      });
      return collectSubjectFacts(tx, user.id);
    });
    expect(facts.groups).toEqual(['Finance']);
    expect(facts.attributes.cost_centre).toBe('CC-1');
  });
});
```

- [ ] **Step 6: Write `collect.ts`**

```ts
import type { TenantClient } from '@syntra/db';
import { listGroupsForUser } from '../../directory/group-service.js';
import { resolveContractForMapping } from '../../identity/contract-service.js';
import type { SubjectFacts } from './types.js';

/** The Contract columns a claim may read. Cost centre and FTE included. */
const CONTRACT_FIELDS = [
  'jobTitle',
  'department',
  'costCentre',
  'employer',
  'location',
] as const;

const PERSON_FIELDS = [
  'givenName',
  'familyName',
  'nameConvention',
  'businessEmail',
  'personalEmail',
  'externalId',
] as const;

const USER_FIELDS = ['login', 'email', 'displayName'] as const;

function pick<T extends Record<string, unknown>>(
  row: T | null,
  fields: readonly string[],
): Record<string, string | null> | null {
  if (!row) return null;
  const out: Record<string, string | null> = {};
  for (const field of fields) {
    const value = row[field];
    out[field] = typeof value === 'string' ? value : null;
  }
  return out;
}

/**
 * Reads everything the claim engine may see, and nothing else.
 *
 * Both contract strategies are resolved here, through the identity layer's
 * `resolveContractForMapping`, so the multi-contract rule has exactly one
 * implementation. Either may come back null — a person whose contracts have
 * all ended, or one whose primary contract ended while another continues —
 * and null is what makes `resolveClaims` omit the claim.
 *
 * Read-only, so it takes the caller's transaction. Nothing here is expensive:
 * five indexed lookups, no crypto, no network.
 */
export async function collectSubjectFacts(
  tx: TenantClient,
  userId: string,
  now: Date = new Date(),
): Promise<SubjectFacts> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

  const person = user.personId
    ? await tx.person.findUnique({ where: { id: user.personId } })
    : null;

  const primary = user.personId
    ? await resolveContractForMapping(tx, user.personId, 'primary', now)
    : null;
  const lowestSequence = user.personId
    ? await resolveContractForMapping(tx, user.personId, 'lowestSequence', now)
    : null;

  const groups = await listGroupsForUser(tx, userId);
  const attributeRows = await tx.userAttribute.findMany({ where: { userId } });

  const attributes: Record<string, string> = {};
  for (const row of attributeRows) attributes[row.key] = row.value;

  return {
    user: pick(user as unknown as Record<string, unknown>, USER_FIELDS)!,
    person: pick(person as unknown as Record<string, unknown> | null, PERSON_FIELDS),
    contract: {
      primary: pick(primary as unknown as Record<string, unknown> | null, CONTRACT_FIELDS),
      lowestSequence: pick(
        lowestSequence as unknown as Record<string, unknown> | null,
        CONTRACT_FIELDS,
      ),
    },
    attributes,
    groups: groups.map((g) => g.name),
  };
}
```

- [ ] **Step 7: Write `claim-mapping-service.ts`**

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import type { ClaimMappingSpec, ClaimProtocol } from './claims/types.js';

const toSpec = (row: {
  id: string; protocol: string; claimName: string; nameFormat: string;
  sourceKind: string; sourceField: string | null; contractStrategy: string;
  literalValue: string | null; releaseScope: string | null; multiValued: boolean;
}): ClaimMappingSpec => ({
  id: row.id,
  protocol: row.protocol === 'saml' ? 'saml' : 'oidc',
  claimName: row.claimName,
  nameFormat: row.nameFormat,
  sourceKind: row.sourceKind as ClaimMappingSpec['sourceKind'],
  sourceField: row.sourceField,
  contractStrategy:
    row.contractStrategy === 'lowestSequence' ? 'lowestSequence' : 'primary',
  literalValue: row.literalValue,
  releaseScope: row.releaseScope,
  multiValued: row.multiValued,
});

export async function listClaimMappings(
  tx: TenantClient,
  applicationId: string,
  protocol: ClaimProtocol,
): Promise<ClaimMappingSpec[]> {
  const rows = await tx.claimMapping.findMany({
    where: { applicationId, protocol },
    orderBy: { claimName: 'asc' },
  });
  return rows.map(toSpec);
}

export async function createClaimMapping(
  tx: TenantClient,
  applicationId: string,
  input: Omit<ClaimMappingSpec, 'id'>,
): Promise<ClaimMappingSpec> {
  const tenantId = await currentTenant(tx);
  const row = await tx.claimMapping.create({
    data: {
      tenantId,
      applicationId,
      protocol: input.protocol,
      claimName: input.claimName,
      nameFormat: input.nameFormat,
      sourceKind: input.sourceKind,
      sourceField: input.sourceField,
      contractStrategy: input.contractStrategy,
      literalValue: input.literalValue,
      releaseScope: input.releaseScope,
      multiValued: input.multiValued,
    },
  });
  return toSpec(row);
}

export async function deleteClaimMapping(
  tx: TenantClient,
  id: string,
): Promise<void> {
  await tx.claimMapping.deleteMany({ where: { id } });
}
```

Place this file at `packages/core/src/access/claim-mapping-service.ts`; the relative import above assumes that location.

- [ ] **Step 8: Export from core and run everything**

Add to `packages/core/src/index.ts`:

```ts
export * from './access/claims/types.js';
export * from './access/claims/resolve.js';
export * from './access/claims/collect.js';
export * from './access/claim-mapping-service.js';
```

Run: `pnpm vitest run packages/core/src/access/claims`
Expected: PASS.

**Why the collector tests are not degenerate:** each contract case sets the two strategies to select *different* contracts, so an implementation that resolved one and reused it for both fails. The "ended primary, live secondary" case is the one that distinguishes correct behaviour (`primary` is null, claim omitted) from the plausible wrong behaviour (falling back to the other contract), and it asserts the null explicitly.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/access/claims packages/core/src/access/claim-mapping-service.ts packages/core/src/index.ts
git commit -m "feat(core): claim mappings with per-mapping contract selection and omission"
```

---

## Task 5: The `protocols` package and the XML safety layer

**Files:**
- Create: `packages/protocols/package.json`, `packages/protocols/tsconfig.json`, `packages/protocols/src/index.ts`
- Create: `packages/protocols/src/xml/escape.ts`
- Create: `packages/protocols/src/xml/parse.ts`
- Create: `packages/protocols/src/xml/verify.ts`
- Create: `packages/protocols/src/xml/sign.ts`
- Create: `packages/protocols/src/xml/xml.test.ts`
- Modify: `tsconfig.json` (add the project reference)

**Interfaces:**
- Consumes: nothing from Syntra. This package's XML layer is pure.
- Produces:
  ```ts
  export function xmlText(value: string): string;
  export function xmlAttr(value: string): string;
  export function parseXml(xml: string): Document;          // entity expansion off
  export function selectElements(node: Node, xpath: string): Element[];
  export function verifySignedFragment(fullXml: string, node: Element, certificates: string[]): string | null;
  export function signFragment(xml: string, opts: SignOptions): string;
  export interface SignOptions { privateKeyPem: string; certificatePem: string; referenceXPath: string; insertAfterXPath: string }
  ```

- [ ] **Step 1: Create the package**

`packages/protocols/package.json`:

```json
{
  "name": "@syntra/protocols",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "license": "Apache-2.0",
  "dependencies": {
    "@node-saml/node-saml": "5.1.0",
    "@syntra/core": "workspace:*",
    "@xmldom/xmldom": "0.9.11",
    "jose": "6.2.9",
    "oidc-provider": "9.11.3",
    "openid-client": "6.8.5",
    "xml-crypto": "6.1.2",
    "xml-encryption": "6.0.0",
    "xpath": "0.0.34"
  },
  "devDependencies": {
    "@types/oidc-provider": "9.11.1",
    "@types/xml-encryption": "1.2.4"
  }
}
```

`packages/protocols/tsconfig.json` (copy `packages/core/tsconfig.json` and change the references):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

`tsconfig.json` at the root: add `{ "path": "packages/protocols" }` after `packages/core`.

Install:

```bash
pnpm --filter @syntra/protocols install
pnpm install
```

Verify the versions actually resolved — the plan pins them, and a caret would let a future install drift:

```bash
pnpm --filter @syntra/protocols list --depth 0
```
Expected: `oidc-provider 9.11.3`, `@node-saml/node-saml 5.1.0`, `xml-crypto 6.1.2`, `@xmldom/xmldom 0.9.11`, `openid-client 6.8.5`, `xml-encryption 6.0.0`.

- [ ] **Step 2: Write the failing XML tests**

Create `packages/protocols/src/xml/xml.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { parseXml, selectElements } from './parse.js';
import { verifySignedFragment } from './verify.js';
import { signFragment } from './sign.js';
import { xmlAttr, xmlText } from './escape.js';

describe('parseXml', () => {
  it('does not expand an internal entity', () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY a "AAAAAAAAAA"> ]><r>&a;</r>`,
    );
    // @xmldom/xmldom returns the reference as literal text. This assertion is
    // the regression guard: swapping in a parser that resolves entities makes
    // it fail, which is the only way a billion-laughs or an XXE read reaches
    // this codebase.
    expect(doc.documentElement!.textContent).toBe('&a;');
  });

  it('does not resolve an external entity', () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]><r>&x;</r>`,
    );
    expect(doc.documentElement!.textContent).toBe('&x;');
    expect(doc.documentElement!.textContent).not.toContain('root:');
  });

  it('rejects XML that is not well formed rather than returning a partial document', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('not xml at all')).toThrow();
    expect(() => parseXml('')).toThrow();
  });
});

describe('escaping', () => {
  it('escapes the five text and attribute metacharacters', () => {
    expect(xmlText(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
    expect(xmlAttr(`"><script>`)).toBe('&quot;&gt;&lt;script&gt;');
  });

  it('strips characters XML 1.0 cannot carry at all', () => {
    // A NUL in a display name would otherwise abort the parse at the far end.
    expect(xmlText('a\u0000b\u0008c')).toBe('abc');
  });
});

describe('signFragment / verifySignedFragment', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // A certificate is what SAML carries; for this unit test a bare public key
  // in PEM is what xml-crypto verifies against, and node-saml's SAML wrapper
  // accepts either. Task 7 exercises the certificate path end to end.
  const certificatePem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const doc = (id: string, body: string) =>
    `<Envelope xmlns="urn:test"><Thing ID="${id}"><Issuer>me</Issuer>${body}</Thing></Envelope>`;

  const sign = (xml: string) =>
    signFragment(xml, {
      privateKeyPem,
      certificatePem,
      referenceXPath: "//*[local-name(.)='Thing']",
      insertAfterXPath: "//*[local-name(.)='Thing']/*[local-name(.)='Issuer']",
    });

  const verify = (xml: string) => {
    const parsed = parseXml(xml);
    const [thing] = selectElements(parsed, "//*[local-name(.)='Thing']");
    return verifySignedFragment(xml, thing!, [certificatePem]);
  };

  it('round-trips: what it signs, it verifies, and it returns the signed bytes', () => {
    const signed = sign(doc('_1', '<Value>ok</Value>'));
    const verified = verify(signed);
    expect(verified).not.toBeNull();
    expect(verified).toContain('<Value>ok</Value>');
  });

  it('refuses a document whose signed content was altered after signing', () => {
    const signed = sign(doc('_1', '<Value>ok</Value>')).replace(
      '<Value>ok</Value>',
      '<Value>tampered</Value>',
    );
    expect(verify(signed)).toBeNull();
  });

  it('refuses a signature made by a key that is not on the trusted list', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signed = signFragment(doc('_1', '<Value>ok</Value>'), {
      privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      certificatePem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      referenceXPath: "//*[local-name(.)='Thing']",
      insertAfterXPath: "//*[local-name(.)='Thing']/*[local-name(.)='Issuer']",
    });
    expect(verify(signed)).toBeNull();
  });

  it('refuses an unsigned document', () => {
    expect(verify(doc('_1', '<Value>ok</Value>'))).toBeNull();
  });

  it('refuses a signature wrapping attack: a valid signed fragment smuggled beside a forged one', () => {
    // XSW. The attacker keeps the genuinely signed Thing, hides it inside the
    // envelope, and adds a forged Thing carrying the same ID that the reader
    // would naturally pick up. Every historical SAML bypass has this shape.
    const signed = sign(doc('_1', '<Value>ok</Value>'));
    const forged = signed.replace(
      '<Envelope xmlns="urn:test">',
      '<Envelope xmlns="urn:test"><Thing ID="_1"><Issuer>me</Issuer><Value>tampered</Value></Thing>',
    );
    const parsed = parseXml(forged);
    // Take the FIRST Thing, which is what a naive reader does.
    const [first] = selectElements(parsed, "//*[local-name(.)='Thing']");
    expect(verifySignedFragment(forged, first!, [certificatePem])).toBeNull();

    // And even asking about the genuinely signed one must fail, because the
    // ID now resolves to two elements and nothing can say which was signed.
    const things = selectElements(parsed, "//*[local-name(.)='Thing']");
    expect(verifySignedFragment(forged, things[1]!, [certificatePem])).toBeNull();
  });

  it('returns the signed bytes rather than the caller node, so a caller cannot read around the signature', () => {
    const signed = sign(doc('_1', '<Value>ok</Value>'));
    const forged = signed.replace('</Envelope>', '<Extra>attacker</Extra></Envelope>');
    const parsed = parseXml(forged);
    const [thing] = selectElements(parsed, "//*[local-name(.)='Thing']");
    const verified = verifySignedFragment(forged, thing!, [certificatePem]);
    expect(verified).not.toBeNull();
    // The Extra element is in the document but not in what was signed, and
    // the caller only ever gets what was signed.
    expect(verified).not.toContain('attacker');
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm vitest run packages/protocols/src/xml/xml.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 4: Write `escape.ts`**

```ts
/**
 * Characters XML 1.0 cannot carry in content at all. A display name pulled
 * from LDAP can hold them, and a document containing one aborts the parse at
 * the far end with an error the tenant cannot act on.
 */
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const escape = (value: string) =>
  value.replace(ILLEGAL, '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/**
 * Escapes a value going into element content.
 *
 * Every value the SAML builder interpolates goes through this or `xmlAttr`.
 * The assertion is built as a string rather than through a DOM because it must
 * be byte-stable for canonicalization, and a string builder with an
 * un-escaped interpolation is XML injection — a display name of
 * `</saml:AttributeValue><saml:AttributeValue>admin` would otherwise add an
 * attribute value the administrator never mapped.
 */
export const xmlText = escape;

/** Escapes a value going into an attribute. Same rules; named for the sink. */
export const xmlAttr = escape;
```

- [ ] **Step 5: Write `parse.ts`**

```ts
import { DOMParser } from '@xmldom/xmldom';
import { select } from 'xpath';

/**
 * The only XML parser in this codebase.
 *
 * `@xmldom/xmldom` resolves no entities at all — neither an internal general
 * entity nor an external one. That was verified empirically at version 0.9.11
 * against a billion-laughs payload and a `SYSTEM "file:///etc/passwd"`
 * payload; both come back as the literal reference text. Spec section 7 asks
 * for entity expansion disabled, and here it is disabled by the parser's
 * construction rather than by a flag someone can flip. `xml.test.ts` pins
 * that as a regression test so a swap to a parser that *does* expand entities
 * fails loudly rather than quietly reintroducing XXE.
 *
 * A parse error throws. The default xmldom behaviour is to report the error
 * and hand back a partial document, which is how a truncated or malformed
 * assertion becomes a Response with no Status and an empty Subject that some
 * downstream check reads as "no failure recorded".
 */
export function parseXml(xml: string): Document {
  if (xml.trim() === '') throw new Error('empty XML document');

  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level === 'error' || level === 'fatalError') errors.push(message);
    },
  }).parseFromString(xml, 'text/xml');

  if (errors.length > 0) {
    throw new Error(`malformed XML: ${errors.join('; ')}`);
  }
  if (!doc.documentElement) throw new Error('XML document has no root element');
  return doc as unknown as Document;
}

/** An XPath select narrowed to elements, so a caller cannot get a string back. */
export function selectElements(node: Node, xpath: string): Element[] {
  const result = select(xpath, node as never);
  if (!Array.isArray(result)) throw new Error(`xpath did not select nodes: ${xpath}`);
  return result.filter(
    (n): n is Element => typeof n === 'object' && n !== null && 'nodeType' in n && (n as Node).nodeType === 1,
  ) as unknown as Element[];
}
```

- [ ] **Step 6: Write `verify.ts`**

```ts
import { SignedXml } from 'xml-crypto';
import { selectElements } from './parse.js';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const SIGNATURE_XPATH = `./*[local-name(.)='Signature' and namespace-uri(.)='${DSIG}']`;
const TRANSFORM_XPATH = `.//*[local-name(.)='Transform' and namespace-uri(.)='${DSIG}']`;

/**
 * Verifies the enveloped signature on `node` and returns the bytes that were
 * actually signed — or null.
 *
 * **The return value is the security boundary.** Callers must parse and read
 * the returned string and must never read `node`, the surrounding document, or
 * anything else. That is what defeats XML Signature Wrapping: an attacker can
 * always arrange for a document to contain one genuinely signed element and
 * one forged element that a naive reader picks up instead, and "the signature
 * checked out" is true of the document while being false of what was read.
 * `xml-crypto`'s `getSignedReferences()` returns the canonicalized bytes of
 * the reference it verified, and nothing else in the document can influence
 * them.
 *
 * The checks before the cryptography are conformance checks, taken from the
 * recipe `@node-saml/node-saml` implements in its own `getVerifiedXml`
 * (`lib/xml.js`). They are reproduced rather than imported because that module
 * is not part of node-saml's public surface. The cryptography itself is
 * `xml-crypto`'s — none of it is hand-rolled.
 *
 * `certificates` is the trusted set: the SP's registered certificates when
 * checking an AuthnRequest, or the upstream IdP's when checking an assertion.
 * An empty list verifies nothing and returns null.
 */
export function verifySignedFragment(
  fullXml: string,
  node: Element,
  certificates: string[],
): string | null {
  if (certificates.length === 0) return null;

  const signatures = selectElements(node, SIGNATURE_XPATH);
  // Exactly one. Zero is unsigned; more than one lets an attacker supply a
  // signature the verifier picks and a payload the reader picks.
  if (signatures.length !== 1) return null;
  const signature = signatures[0]!;

  // At most the enveloped-signature transform and a canonicalization. A third
  // transform is how an XPath or XSLT transform is smuggled in to make the
  // signed bytes differ from the bytes anyone would read.
  if (selectElements(signature, TRANSFORM_XPATH).length > 2) return null;

  for (const certificate of certificates) {
    const sig = new SignedXml();
    sig.publicCert = certificate;
    try {
      sig.loadSignature(signature as never);
    } catch {
      continue;
    }

    const references = sig.getReferences();
    // One reference. Several would mean the signature covers several regions
    // and "the signed bytes" is not a single answer.
    if (references.length !== 1) continue;

    const uri = references[0]!.uri ?? '';
    const refId = uri.startsWith('#') ? uri.slice(1) : uri;
    if (refId === '') continue;
    // The ID goes into an XPath predicate below. Quote characters in it are
    // XPath injection.
    if (refId.includes("'") || refId.includes('"')) return null;

    const referenced = selectElements(
      signature.ownerDocument as unknown as Node,
      `//*[@ID="${refId}"]`,
    );
    // Exactly one element may carry the ID. Two is the wrapping attack: the
    // signature names an ID and the document offers two candidates.
    if (referenced.length !== 1) return null;
    // And it must be the element the signature is enveloped in. A signature
    // that references a sibling is a signature over something other than the
    // thing it appears to authenticate.
    if (referenced[0] !== signature.parentNode) return null;

    try {
      if (!sig.checkSignature(fullXml)) continue;
    } catch {
      continue;
    }

    const signed = sig.getSignedReferences();
    if (signed.length !== 1) return null;
    return signed[0]!;
  }

  return null;
}
```

- [ ] **Step 7: Write `sign.ts`**

```ts
import { SignedXml } from 'xml-crypto';

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

export interface SignOptions {
  /** PKCS#8 PEM. */
  privateKeyPem: string;
  /** PEM certificate, published in ds:KeyInfo so an SP can pin it. */
  certificatePem: string;
  /** Selects the element the signature covers. */
  referenceXPath: string;
  /**
   * The signature is inserted immediately after this element. SAML requires
   * ds:Signature to follow saml:Issuer inside the element it signs.
   */
  insertAfterXPath: string;
}

/**
 * Signs one element of a document with an enveloped RSA-SHA256 signature.
 *
 * SHA-256 and exclusive canonicalization throughout: SHA-1 signatures are
 * still accepted by some service providers and are not offered here, because
 * the only party who benefits from a downgrade option is an attacker.
 *
 * The exact parameter set below was verified end to end during planning: an
 * assertion signed with it was accepted by `@node-saml/node-saml` acting as a
 * service provider, and rejected with "Invalid signature" after one attribute
 * value was altered. Task 7 keeps that round trip as a test.
 */
export function signFragment(xml: string, opts: SignOptions): string {
  const sig = new SignedXml({
    privateKey: opts.privateKeyPem,
    publicCert: opts.certificatePem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: EXC_C14N,
  });

  sig.addReference({
    xpath: opts.referenceXPath,
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: SHA256,
  });

  sig.computeSignature(xml, {
    prefix: 'ds',
    location: { reference: opts.insertAfterXPath, action: 'after' },
  });

  return sig.getSignedXml();
}
```

`packages/protocols/src/index.ts`:

```ts
export * from './xml/escape.js';
export * from './xml/parse.js';
export * from './xml/verify.js';
export * from './xml/sign.js';
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run packages/protocols/src/xml/xml.test.ts`
Expected: PASS, all twelve cases.

**Why these tests are not degenerate.** The two entity cases assert on the literal reference text, so an implementation that expanded entities produces `AAAAAAAAAA` and fails — the naive shape of this test (`expect(() => parse(payload)).not.toThrow()`) would pass under both behaviours and prove nothing. The wrapping case verifies *both* candidate nodes and requires both to fail, so an implementation that got lucky on node selection still fails. The last case proves the return value is the signed bytes and not the document: it appends content after signing and asserts the verified string does not contain it, which fails for any implementation that returns a boolean and lets the caller read `node`.

- [ ] **Step 9: Commit**

```bash
git add packages/protocols tsconfig.json pnpm-lock.yaml
git commit -m "feat(protocols): XML safety layer with XSW-hardened signature verification"
```

---

## Task 6: SAML configuration, IdP metadata, and service-provider metadata import

**Files:**
- Create: `packages/core/src/access/saml-config-service.ts`
- Create: `packages/protocols/src/saml/idp-metadata.ts`
- Create: `packages/protocols/src/saml/sp-metadata.ts`
- Create: `packages/protocols/src/saml/metadata.test.ts`
- Create: `apps/api/src/routes/saml-idp.ts` (metadata route only; SSO arrives in Task 7)
- Create: `apps/api/src/routes/saml-metadata.test.ts`
- Modify: `apps/api/src/app.ts`, `packages/core/src/index.ts`, `packages/protocols/src/index.ts`

**Interfaces:**
- Consumes: `tenantProtocolIdentity`, `assertProtocolHost` (Task 2); `ensureActiveKey`, `publishedKeys`, `PublishedKey` (Task 3); `parseXml`, `selectElements`, `xmlAttr`, `xmlText` (Task 5); `matchesAllowlist`, `isProtocolEndpoint` from `@syntra/contracts`.
- Produces:
  ```ts
  // @syntra/core
  export interface SamlConfigRecord {
    id: string; applicationId: string; spEntityId: string; acsUrls: string[];
    defaultAcsUrl: string | null; acsBinding: 'HTTP-POST' | 'HTTP-Redirect';
    nameIdFormat: string; nameIdClaim: string | null; spCertificates: string[];
    wantAuthnRequestsSigned: boolean; encryptAssertions: boolean;
    encryptionCertificate: string | null; sloUrl: string | null;
    sloBinding: 'HTTP-POST' | 'HTTP-Redirect'; allowIdpInitiated: boolean;
    assertionLifetimeMs: number;
  }
  export function upsertSamlConfig(tx: TenantClient, applicationId: string, input: Omit<SamlConfigRecord,'id'|'applicationId'>): Promise<SamlConfigRecord>;
  export function findSamlConfigByEntityId(tx: TenantClient, spEntityId: string): Promise<SamlConfigRecord | null>;
  export function findSamlConfigForApplication(tx: TenantClient, applicationId: string): Promise<SamlConfigRecord | null>;
  export function resolveAcsUrl(config: SamlConfigRecord, requested: string | null): string | null;

  // @syntra/protocols
  export function buildIdpMetadata(input: { entityId: string; ssoUrl: string; sloUrl: string; nameIdFormats: string[]; certificates: string[] }): string;
  export interface ParsedSpMetadata { entityId: string; acsUrls: string[]; defaultAcsUrl: string; sloUrl: string | null; wantAssertionsSigned: boolean; certificates: string[]; nameIdFormats: string[] }
  export function parseSpMetadata(xml: string): ParsedSpMetadata;
  ```

- [ ] **Step 1: Write the failing metadata tests**

Create `packages/protocols/src/saml/metadata.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildIdpMetadata } from './idp-metadata.js';
import { parseSpMetadata } from './sp-metadata.js';
import { parseXml, selectElements } from '../xml/parse.js';

const CERT_BODY =
  'MIIByjCCATOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlsb2NhbGhvc3Q=';

describe('buildIdpMetadata', () => {
  const xml = buildIdpMetadata({
    entityId: 'https://sso.acme.test/saml/idp',
    ssoUrl: 'https://sso.acme.test/saml/sso',
    sloUrl: 'https://sso.acme.test/saml/slo',
    nameIdFormats: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
    certificates: [
      `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----\n`,
    ],
  });

  it('is well-formed and names the entity', () => {
    const doc = parseXml(xml);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(
      'https://sso.acme.test/saml/idp',
    );
  });

  it('publishes both bindings for single sign-on', () => {
    const doc = parseXml(xml);
    const sso = selectElements(
      doc,
      "//*[local-name(.)='SingleSignOnService']",
    ).map((e) => e.getAttribute('Binding'));
    expect(sso).toEqual([
      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
    ]);
  });

  it('strips the PEM armour from the certificate, as SAML metadata requires', () => {
    const doc = parseXml(xml);
    const [cert] = selectElements(doc, "//*[local-name(.)='X509Certificate']");
    expect(cert!.textContent).toBe(CERT_BODY);
    expect(xml).not.toContain('BEGIN CERTIFICATE');
  });

  it('publishes every key it is given, so a rollover is visible to a service provider', () => {
    const two = buildIdpMetadata({
      entityId: 'https://sso.acme.test/saml/idp',
      ssoUrl: 'https://sso.acme.test/saml/sso',
      sloUrl: 'https://sso.acme.test/saml/slo',
      nameIdFormats: ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'],
      certificates: [
        `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----`,
        `-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----`,
      ],
    });
    const doc = parseXml(two);
    expect(
      selectElements(doc, "//*[local-name(.)='KeyDescriptor']"),
    ).toHaveLength(2);
  });

  it('escapes a hostile entity id rather than emitting it raw', () => {
    const hostile = buildIdpMetadata({
      entityId: 'https://a.test/"><evil x="',
      ssoUrl: 'https://a.test/sso',
      sloUrl: 'https://a.test/slo',
      nameIdFormats: [],
      certificates: [],
    });
    expect(hostile).not.toContain('<evil');
    expect(() => parseXml(hostile)).not.toThrow();
  });
});

describe('parseSpMetadata', () => {
  const sp = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test/metadata">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${CERT_BODY}</X509Certificate></X509Data></KeyInfo>
    </KeyDescriptor>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/slo"/>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs"/>
    <AssertionConsumerService index="1" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs2"/>
  </SPSSODescriptor>
</EntityDescriptor>`;

  it('reads the entity id, both ACS URLs, the SLO URL and the certificate', () => {
    const parsed = parseSpMetadata(sp);
    expect(parsed.entityId).toBe('https://sp.example.test/metadata');
    expect(parsed.acsUrls).toEqual([
      'https://sp.example.test/acs',
      'https://sp.example.test/acs2',
    ]);
    // The SP marked the first one isDefault. `resolveAcsUrl` has no implicit
    // fallback, so this is the value an unsolicited assertion is delivered to
    // and it has to come from the document rather than from list order.
    expect(parsed.defaultAcsUrl).toBe('https://sp.example.test/acs');
    expect(parsed.sloUrl).toBe('https://sp.example.test/slo');
    expect(parsed.wantAssertionsSigned).toBe(true);
    expect(parsed.certificates[0]).toContain('BEGIN CERTIFICATE');
    expect(parsed.certificates[0]).toContain(CERT_BODY);
  });

  it('honours isDefault rather than document order when picking the default', () => {
    // Move isDefault to the second entry and leave the order alone. An
    // implementation that returned acsUrls[0] passes the case above and fails
    // this one.
    const moved = sp
      .replace(' index="0" isDefault="true"', ' index="0"')
      .replace(' index="1"', ' index="1" isDefault="true"');
    expect(parseSpMetadata(moved).defaultAcsUrl).toBe('https://sp.example.test/acs2');
  });

  it('drops an ACS URL that is not an http(s) endpoint', () => {
    // An uploaded metadata file is attacker-controlled input the moment an
    // administrator is talked into importing one. A javascript: ACS URL that
    // reached the allowlist would be a stored redirect into script.
    const hostile = sp.replace(
      'https://sp.example.test/acs2',
      'javascript:alert(1)',
    );
    expect(parseSpMetadata(hostile).acsUrls).toEqual([
      'https://sp.example.test/acs',
    ]);
  });

  it('refuses metadata with no ACS URL at all rather than storing an empty allowlist', () => {
    const none = sp.replace(/<AssertionConsumerService[\s\S]*?\/>/g, '');
    expect(() => parseSpMetadata(none)).toThrow(/assertion consumer service/i);
  });

  it('does not expand an entity smuggled into metadata', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE EntityDescriptor [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>
${sp.replace('https://sp.example.test/metadata', '&x;').replace(/^<\?xml[^>]*\?>\n/, '')}`;
    expect(parseSpMetadata(xxe).entityId).not.toContain('root:');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/protocols/src/saml/metadata.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write `idp-metadata.ts`**

```ts
import { xmlAttr, xmlText } from '../xml/escape.js';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
export const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
export const BINDING_REDIRECT =
  'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/**
 * SAML metadata carries the DER bytes, base64, with no PEM armour and no line
 * breaks. A certificate pasted in with its armour intact is the single most
 * common reason an SP rejects an IdP's metadata, and the failure at the far
 * end is an opaque parse error.
 */
export function derBody(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

export interface IdpMetadataInput {
  entityId: string;
  ssoUrl: string;
  sloUrl: string;
  nameIdFormats: string[];
  /** PEM certificates, active first. Every published key appears. */
  certificates: string[];
}

/**
 * The IdP EntityDescriptor a service provider imports.
 *
 * Every key from `publishedKeys` appears as its own KeyDescriptor, which is
 * what makes a rollover survivable for an SP that fetches metadata: during the
 * overlap it sees both, and an assertion signed with either verifies.
 *
 * The document is not itself signed. Signed metadata is worth having and is
 * out of scope for this slice; what stands in for it is that the document is
 * served over TLS from the tenant's own host, which Task 2's
 * `assertProtocolHost` enforces.
 */
export function buildIdpMetadata(input: IdpMetadataInput): string {
  const keys = input.certificates
    .map(
      (pem) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${DS}"><ds:X509Data><ds:X509Certificate>${xmlText(
          derBody(pem),
        )}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join('');

  const formats = input.nameIdFormats
    .map((f) => `<md:NameIDFormat>${xmlText(f)}</md:NameIDFormat>`)
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="${MD}" entityID="${xmlAttr(input.entityId)}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">` +
    keys +
    `<md:SingleLogoutService Binding="${BINDING_REDIRECT}" Location="${xmlAttr(input.sloUrl)}"/>` +
    `<md:SingleLogoutService Binding="${BINDING_POST}" Location="${xmlAttr(input.sloUrl)}"/>` +
    formats +
    // Redirect first, then POST: spec section 7 requires both, and an SP that
    // takes the first offered binding gets the one that survives a browser's
    // URL length limits least badly for a request and best for a response.
    `<md:SingleSignOnService Binding="${BINDING_REDIRECT}" Location="${xmlAttr(input.ssoUrl)}"/>` +
    `<md:SingleSignOnService Binding="${BINDING_POST}" Location="${xmlAttr(input.ssoUrl)}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
}
```

- [ ] **Step 4: Write `sp-metadata.ts`**

```ts
import { isProtocolEndpoint } from '@syntra/contracts';
import { parseXml, selectElements } from '../xml/parse.js';

export interface ParsedSpMetadata {
  entityId: string;
  acsUrls: string[];
  /** The SP's own `isDefault` entry, or its first, and always on `acsUrls`. */
  defaultAcsUrl: string;
  sloUrl: string | null;
  wantAssertionsSigned: boolean;
  /** PEM, armour restored. */
  certificates: string[];
  nameIdFormats: string[];
}

const pem = (body: string) =>
  `-----BEGIN CERTIFICATE-----\n${
    body.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? ''
  }\n-----END CERTIFICATE-----\n`;

/**
 * Reads an uploaded or fetched service-provider EntityDescriptor.
 *
 * Every value here becomes configuration a later assertion is checked
 * against, so this is untrusted input in the strongest sense: an
 * administrator talked into importing one file must not end up with a
 * `javascript:` ACS URL on the allowlist, which is why each location is put
 * through `isProtocolEndpoint` before it is kept. Metadata with no usable ACS
 * URL throws rather than producing an empty allowlist, because an empty
 * allowlist is a configuration that silently fails every login later, at a
 * point nobody connects to the import.
 *
 * Parsed through `parseXml`, so entity expansion is off here as it is
 * everywhere else.
 */
export function parseSpMetadata(xml: string): ParsedSpMetadata {
  const doc = parseXml(xml);

  const entityId =
    doc.documentElement?.getAttribute('entityID')?.trim() ?? '';
  if (entityId === '') throw new Error('metadata has no entityID');

  const descriptors = selectElements(
    doc,
    "//*[local-name(.)='SPSSODescriptor']",
  );
  if (descriptors.length === 0) {
    throw new Error('metadata contains no SPSSODescriptor');
  }
  const sp = descriptors[0]!;

  const acsNodes = selectElements(
    sp,
    ".//*[local-name(.)='AssertionConsumerService']",
  ).filter((e) => isProtocolEndpoint(e.getAttribute('Location') ?? ''));

  const acsUrls = acsNodes.map((e) => e.getAttribute('Location')!);

  if (acsUrls.length === 0) {
    throw new Error(
      'metadata contains no usable assertion consumer service URL',
    );
  }

  // The service provider's own choice, when it made one. `resolveAcsUrl` has
  // no implicit fallback, so this is what an unsolicited assertion uses, and
  // reading it from the document rather than from list order is what keeps a
  // re-import from silently moving it.
  const defaultAcsUrl =
    acsNodes.find((e) => e.getAttribute('isDefault') === 'true')?.getAttribute('Location') ??
    acsUrls[0]!;

  const sloUrl =
    selectElements(sp, ".//*[local-name(.)='SingleLogoutService']")
      .map((e) => e.getAttribute('Location') ?? '')
      .find((url) => isProtocolEndpoint(url)) ?? null;

  const certificates = selectElements(
    sp,
    ".//*[local-name(.)='X509Certificate']",
  )
    .map((e) => (e.textContent ?? '').trim())
    .filter((body) => body !== '')
    .map(pem);

  const nameIdFormats = selectElements(sp, ".//*[local-name(.)='NameIDFormat']")
    .map((e) => (e.textContent ?? '').trim())
    .filter((f) => f !== '');

  return {
    entityId,
    acsUrls,
    defaultAcsUrl,
    sloUrl,
    // Absent means false per the schema default, but a service provider that
    // said nothing is one whose assertions Syntra signs anyway — Syntra always
    // signs. This flag only records what the SP asked for.
    wantAssertionsSigned: sp.getAttribute('WantAssertionsSigned') === 'true',
    certificates,
    nameIdFormats,
  };
}
```

- [ ] **Step 5: Write `saml-config-service.ts`**

`packages/core/src/access/saml-config-service.ts`:

```ts
import { matchesAllowlist } from '@syntra/contracts';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type SamlBinding = 'HTTP-POST' | 'HTTP-Redirect';

export interface SamlConfigRecord {
  id: string;
  applicationId: string;
  spEntityId: string;
  acsUrls: string[];
  defaultAcsUrl: string | null;
  acsBinding: SamlBinding;
  nameIdFormat: string;
  nameIdClaim: string | null;
  spCertificates: string[];
  wantAuthnRequestsSigned: boolean;
  encryptAssertions: boolean;
  encryptionCertificate: string | null;
  sloUrl: string | null;
  sloBinding: SamlBinding;
  allowIdpInitiated: boolean;
  assertionLifetimeMs: number;
}

const asBinding = (value: string): SamlBinding =>
  value === 'HTTP-Redirect' ? 'HTTP-Redirect' : 'HTTP-POST';

const toRecord = (row: Record<string, unknown>): SamlConfigRecord => ({
  id: row.id as string,
  applicationId: row.applicationId as string,
  spEntityId: row.spEntityId as string,
  acsUrls: row.acsUrls as string[],
  defaultAcsUrl: (row.defaultAcsUrl as string | null) ?? null,
  acsBinding: asBinding(row.acsBinding as string),
  nameIdFormat: row.nameIdFormat as string,
  nameIdClaim: (row.nameIdClaim as string | null) ?? null,
  spCertificates: row.spCertificates as string[],
  wantAuthnRequestsSigned: row.wantAuthnRequestsSigned as boolean,
  encryptAssertions: row.encryptAssertions as boolean,
  encryptionCertificate: (row.encryptionCertificate as string | null) ?? null,
  sloUrl: (row.sloUrl as string | null) ?? null,
  sloBinding: asBinding(row.sloBinding as string),
  allowIdpInitiated: row.allowIdpInitiated as boolean,
  assertionLifetimeMs: row.assertionLifetimeMs as number,
});

export async function upsertSamlConfig(
  tx: TenantClient,
  applicationId: string,
  input: Omit<SamlConfigRecord, 'id' | 'applicationId'>,
): Promise<SamlConfigRecord> {
  const tenantId = await currentTenant(tx);
  const data = { tenantId, applicationId, ...input };
  const row = await tx.samlConfig.upsert({
    where: { applicationId },
    create: data,
    update: input,
  });
  return toRecord(row as unknown as Record<string, unknown>);
}

export async function findSamlConfigByEntityId(
  tx: TenantClient,
  spEntityId: string,
): Promise<SamlConfigRecord | null> {
  const row = await tx.samlConfig.findFirst({ where: { spEntityId } });
  return row ? toRecord(row as unknown as Record<string, unknown>) : null;
}

export async function findSamlConfigForApplication(
  tx: TenantClient,
  applicationId: string,
): Promise<SamlConfigRecord | null> {
  const row = await tx.samlConfig.findUnique({ where: { applicationId } });
  return row ? toRecord(row as unknown as Record<string, unknown>) : null;
}

/**
 * The address an assertion may be delivered to, or null.
 *
 * A requested URL is honoured only if it is byte-identical to one on the
 * allowlist. This is the SAML half of spec section 7's allowlisting
 * requirement, and it is the control that stops an AuthnRequest naming
 * `AssertionConsumerServiceURL="https://attacker.test/"` from having Syntra
 * post a valid, signed assertion for a real user straight to the attacker.
 *
 * A request that names no ACS URL uses `defaultAcsUrl`, and if there is none
 * it resolves to null and the flow refuses.
 *
 * THERE IS DELIBERATELY NO FALL BACK TO `acsUrls[0]`. An earlier draft had
 * one, and it fails in a way nobody would notice: the allowlist is an
 * unordered set as far as an administrator is concerned, and metadata import
 * rewrites it wholesale from whatever order the service provider's document
 * happened to list its endpoints in. A reordered import would silently change
 * where unsolicited assertions are delivered, with no write, no audit event
 * and nothing on screen. Choosing the default is a decision, so it is made
 * once at write time where it is visible and audited — `parseSpMetadata`
 * records the SP's own `isDefault="true"` entry, and the admin schema refuses
 * a default that is not on the allowlist.
 */
export function resolveAcsUrl(
  config: SamlConfigRecord,
  requested: string | null,
): string | null {
  if (requested !== null && requested !== '') {
    return matchesAllowlist(requested, config.acsUrls) ? requested : null;
  }
  if (config.defaultAcsUrl && matchesAllowlist(config.defaultAcsUrl, config.acsUrls)) {
    return config.defaultAcsUrl;
  }
  return null;
}
```

- [ ] **Step 6: Write the metadata route**

Create `apps/api/src/routes/saml-idp.ts`. Task 7 adds `/sso` and Task 9 adds `/slo` to this same file.

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  ensureActiveKey,
  findApplication,
  localMasterKeyProvider,
  publishedKeys,
} from '@syntra/core';
import { buildIdpMetadata } from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';

export interface SamlRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
}

/** Reads the tenant row every SAML route needs, once. */
export async function samlContext(
  request: FastifyRequest,
  options: { publicUrl: string },
) {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const identity = tenantProtocolIdentity(tenant, options.publicUrl);
  assertProtocolHost(request, identity);
  return { tenant, identity };
}

export async function registerSamlIdpRoutes(
  app: FastifyInstance,
  options: SamlRouteOptions,
): Promise<void> {
  /**
   * The tenant's IdP metadata.
   *
   * Also served at `/metadata/:applicationId`, because spec section 7 asks for
   * a per-application endpoint: the document is identical for every
   * application in a tenant — one entity ID, one key set — but an
   * administrator wiring up one service provider wants a URL they can copy
   * from that application's page and hand to its vendor, and a shared URL
   * invites the question of whether it is really shared. The path parameter is
   * validated so a mistyped id is a 404 rather than a document naming an
   * application that does not exist.
   */
  const metadata = async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenant, identity } = await samlContext(request, options);
    const applicationId = (request.params as { applicationId?: string }).applicationId;
    if (applicationId !== undefined) {
      const application = await request.db((tx) => findApplication(tx, applicationId));
      if (!application || application.type !== 'saml') {
        throw new ProblemError(404, 'not-found', 'No such SAML application');
      }
    }

    // Generation is expensive and must not sit inside a transaction; the
    // service opens its own. Fetching metadata is the first thing an
    // administrator does when wiring an SP, so this is where the tenant's
    // SAML key comes into existence.
    await ensureActiveKey(request.tenantId, localMasterKeyProvider(options.masterKey), 'saml', {
      commonName: identity.acsHost,
    });
    const keys = await publishedKeys(request.tenantId, 'saml');

    const xml = buildIdpMetadata({
      entityId: identity.entityId,
      ssoUrl: identity.ssoUrl,
      sloUrl: identity.sloUrl,
      nameIdFormats: [
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
      ],
      certificates: keys.flatMap((k) => (k.certificate ? [k.certificate] : [])),
    });

    void tenant;
    return reply
      .type('application/samlmetadata+xml')
      .header('cache-control', 'public, max-age=300')
      .send(xml);
  };

  app.get('/metadata', metadata);
  app.get('/metadata/:applicationId', metadata);
}
```

`app.ts` registers the plugin:

```ts
  await app.register(registerSamlIdpRoutes, {
    prefix: '/saml',
    publicUrl: config.publicUrl,
    masterKey: config.masterKey,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  });
```

Also add `"@syntra/protocols": "workspace:*"` to `apps/api/package.json` dependencies, and export the new core service from `packages/core/src/index.ts`:

```ts
export * from './access/saml-config-service.js';
```

and the new protocol modules from `packages/protocols/src/index.ts`:

```ts
export * from './saml/idp-metadata.js';
export * from './saml/sp-metadata.js';
```

- [ ] **Step 7: Write the route test**

Create `apps/api/src/routes/saml-metadata.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { parseXml, selectElements } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /saml/metadata', () => {
  it('serves metadata whose entity ID is built from the tenant, not the Host header', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/saml/metadata',
      headers: { host: TEST_HOST },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/samlmetadata+xml');
    const doc = parseXml(res.body);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(
      `http://${TEST_HOST}/saml/idp`,
    );
    expect(selectElements(doc, "//*[local-name(.)='X509Certificate']").length)
      .toBeGreaterThan(0);
  });

  it('refuses a request that arrived on a sibling of the tenant host', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/saml/metadata',
      // Resolves tenant "acme" through the leftmost label, and would
      // otherwise publish an entity ID under the attacker's domain.
      headers: { host: `${TEST_HOST}.attacker.example` },
    });
    expect(res.statusCode).toBe(421);
  });

  it('is stable across calls, so an SP that pins the entity ID keeps working', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { primaryDomain: TEST_HOST },
    });
    const one = await ctx.app.inject({ method: 'GET', url: '/saml/metadata', headers: { host: TEST_HOST } });
    const two = await ctx.app.inject({ method: 'GET', url: '/saml/metadata', headers: { host: TEST_HOST } });
    expect(one.body).toBe(two.body);
    // And exactly one key was created, not one per request.
    const keys = await prisma.signingKey.findMany({ where: { kind: 'saml' } });
    expect(keys).toHaveLength(1);
  });
});
```

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run packages/protocols/src/saml/metadata.test.ts apps/api/src/routes/saml-metadata.test.ts`
Expected: PASS.

**Why these tests are not degenerate:** the metadata route test asserts the exact entity ID string rather than merely "200 OK", so an implementation that built it from `request.headers.host` produces `http://acme.syntra.test.attacker.example/saml/idp` in the second case and fails there; and the "stable across calls" case asserts a single `SigningKey` row, which fails for an implementation that regenerates a key per request — a bug that otherwise shows up only as SPs mysteriously rejecting assertions.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/access/saml-config-service.ts packages/protocols/src/saml packages/protocols/src/index.ts packages/core/src/index.ts apps/api/src/routes/saml-idp.ts apps/api/src/routes/saml-metadata.test.ts apps/api/src/app.ts apps/api/package.json
git commit -m "feat(saml): IdP metadata, SP metadata import, and the ACS allowlist"
```

---

## Task 7: SAML single sign-on over HTTP-POST, through `authorize()`

**Files:**
- Create: `packages/protocols/src/saml/authn-request.ts` (the POST half; Task 8 adds the Redirect half to the same file)
- Create: `packages/protocols/src/saml/assertion.ts`
- Create: `packages/protocols/src/saml/saml-assertion.test.ts`
- Create: `packages/core/src/access/saml-request-service.ts`
- Create: `packages/core/src/access/saml-session-service.ts`
- Modify: `apps/api/src/routes/saml-idp.ts` (add `POST /sso` and `GET /continue`)
- Create: `apps/api/src/routes/saml-sso-post.test.ts`
- Modify: `packages/protocols/src/index.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `parseXml`, `selectElements`, `verifySignedFragment`, `signFragment`, `xmlText`, `xmlAttr` (Task 5); `resolveAcsUrl`, `findSamlConfigByEntityId`, `findSamlConfigForApplication`, `SamlConfigRecord`, `samlContext` (Task 6); `loadActiveKey` (Task 3); `collectSubjectFacts`, `resolveClaims`, `listClaimMappings` (Task 4); `authorize`, `resolveSession`, `isApplicationAssigned`, `recordEvent` from `@syntra/core`; `tenantRelyingParty` from `apps/api/src/routes/relying-party.js`.
- Produces:
  ```ts
  // @syntra/protocols
  export interface IncomingAuthnRequest {
    id: string; issuer: string; acsUrl: string | null;
    nameIdFormat: string | null; forceAuthn: boolean;
    destination: string | null; issueInstant: Date;
  }
  export const MAX_MESSAGE_BYTES: number;                       // Task 8 reuses it
  export function decodePostMessage(param: string): string;     // base64 only
  export function parseAuthnRequest(xml: string): IncomingAuthnRequest;
  export function verifyPostSignature(xml: string, certificates: string[]): string | null;

  export interface AssertionAttribute { name: string; nameFormat: string; values: string[] }
  export interface AssertionInput {
    idpEntityId: string; spEntityId: string; acsUrl: string;
    nameId: string; nameIdFormat: string; sessionIndex: string;
    inResponseTo: string | null; attributes: AssertionAttribute[];
    lifetimeMs: number; authnInstant: Date; authnContextClassRef: string; now: Date;
  }
  export interface SigningMaterial { privateKeyPem: string; certificatePem: string }
  export function buildSignedResponse(input: AssertionInput, key: SigningMaterial): string;
  export function postBindingForm(input: { acsUrl: string; samlResponse: string; relayState: string | null }): string;

  // @syntra/core
  export interface ParkedAuthnRequest { id: string; applicationId: string; handle: string; requestId: string | null; acsUrl: string; relayState: string | null; forceAuthn: boolean }
  export function parkAuthnRequest(tenantId: string, input: Omit<ParkedAuthnRequest, 'id' | 'handle'> & { ttlMs?: number }): Promise<ParkedAuthnRequest>;
  export function findParkedAuthnRequest(tenantId: string, handle: string, now?: Date): Promise<ParkedAuthnRequest | null>;
  export function consumeParkedAuthnRequest(tenantId: string, id: string, now?: Date): Promise<boolean>;
  export function startSamlSsoSession(tx: TenantClient, input: { sessionId: string; applicationId: string; nameId: string; sessionIndex: string }): Promise<void>;
  export function listSsoSessionsForSession(tx: TenantClient, sessionId: string): Promise<{ id: string; applicationId: string; nameId: string; sessionIndex: string }[]>;
  export function endSsoSessions(tx: TenantClient, sessionId: string): Promise<void>;
  ```
- Produced for Task 8: `beginSso`, `completeSso`, the `AUTHN_CONTEXT` map and the `rateLimited` route options object all live in `saml-idp.ts`. Task 8 adds the Redirect arm and reuses them unchanged.

- [ ] **Step 1: Write the failing assertion tests**

Create `packages/protocols/src/saml/saml-assertion.test.ts`. The conformance block drives `@node-saml/node-saml` as a real service provider — an independent implementation of the verification Syntra does not write, which is what spec section 13 asks for.

```ts
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pkg from '@node-saml/node-saml';
import { buildSignedResponse, postBindingForm } from './assertion.js';
import { decodePostMessage, parseAuthnRequest } from './authn-request.js';

const { SAML } = pkg;

const IDP = 'https://sso.acme.test/saml/idp';
const SP = 'https://sp.example.test/metadata';
const ACS = 'https://sp.example.test/acs';

const authnRequestXml = (id: string, acs = ACS) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="https://sso.acme.test/saml/sso" AssertionConsumerServiceURL="${acs}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

describe('decodePostMessage', () => {
  it('decodes base64 and does not inflate', () => {
    const xml = authnRequestXml('_a');
    expect(decodePostMessage(Buffer.from(xml).toString('base64'))).toBe(xml);
  });

  it('refuses an empty message and one past the ceiling', () => {
    expect(() => decodePostMessage('')).toThrow();
    expect(() =>
      decodePostMessage(Buffer.alloc(600 * 1024, 0x20).toString('base64')),
    ).toThrow(/too large/i);
  });
});

describe('parseAuthnRequest', () => {
  it('reads the id, issuer, ACS URL and ForceAuthn', () => {
    const parsed = parseAuthnRequest(authnRequestXml('_abc'));
    expect(parsed.id).toBe('_abc');
    expect(parsed.issuer).toBe(SP);
    expect(parsed.acsUrl).toBe(ACS);
    expect(parsed.forceAuthn).toBe(false);
  });

  it('refuses a request with no Issuer rather than returning an empty one', () => {
    const noIssuer = authnRequestXml('_abc').replace(`<saml:Issuer>${SP}</saml:Issuer>`, '');
    // An empty issuer would look up no SamlConfig and the flow would refuse
    // anyway. Throwing is what stops a later change turning "no issuer" into
    // "the first config in the table".
    expect(() => parseAuthnRequest(noIssuer)).toThrow(/issuer/i);
  });

  it('refuses a document that is not an AuthnRequest', () => {
    expect(() =>
      parseAuthnRequest(
        '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_1"><x/></samlp:LogoutRequest>',
      ),
    ).toThrow(/AuthnRequest/);
  });

  it('does not expand an entity hidden in the request', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE samlp:AuthnRequest [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>${authnRequestXml('_abc').replace(SP, '&x;')}`;
    expect(parseAuthnRequest(xxe).issuer).not.toContain('root:');
  });
});

describe('buildSignedResponse — validated by a real service provider', () => {
  /** A certificate produced exactly the way Task 3 produces one. */
  const makeKey = async () => {
    await import('reflect-metadata');
    const x509 = await import('@peculiar/x509');
    const { webcrypto, createPrivateKey } = await import('node:crypto');
    x509.cryptoProvider.set(webcrypto as never);
    const alg = {
      name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
      publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048,
    } as const;
    const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const privateKeyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01', name: 'CN=sso.acme.test',
      notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: alg, keys,
      extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
    });
    return { privateKeyPem, certificatePem: cert.toString('pem') };
  };

  const input = (over: Partial<Parameters<typeof buildSignedResponse>[0]> = {}) => ({
    idpEntityId: IDP,
    spEntityId: SP,
    acsUrl: ACS,
    nameId: 'j@acme.test',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    sessionIndex: `_${randomUUID()}`,
    inResponseTo: '_req1',
    attributes: [
      { name: 'mail', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic', values: ['j@acme.test'] },
      { name: 'groups', nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic', values: ['Finance', 'All Staff'] },
    ],
    lifetimeMs: 300_000,
    authnInstant: new Date(),
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
    now: new Date(),
    ...over,
  });

  const sp = (certificatePem: string) =>
    new SAML({
      idpCert: certificatePem,
      issuer: SP, callbackUrl: ACS, audience: SP,
      wantAuthnResponseSigned: false, wantAssertionsSigned: true,
      validateInResponseTo: 'never' as never, acceptedClockSkewMs: 5000,
    });

  it('issues a response a real service provider validates, with the mapped attributes', async () => {
    const key = await makeKey();
    const xml = buildSignedResponse(input(), key);
    const { profile } = await sp(key.certificatePem).validatePostResponseAsync({
      SAMLResponse: Buffer.from(xml).toString('base64'),
    });
    expect(profile!.nameID).toBe('j@acme.test');
    expect(profile!.issuer).toBe(IDP);
    expect(profile!.mail).toBe('j@acme.test');
    expect(profile!.groups).toEqual(['Finance', 'All Staff']);
  });

  it('is rejected by that service provider once one attribute value is altered', async () => {
    const key = await makeKey();
    const xml = buildSignedResponse(input(), key).replace(
      'j@acme.test</saml:AttributeValue>',
      'attacker@evil.test</saml:AttributeValue>',
    );
    await expect(
      sp(key.certificatePem).validatePostResponseAsync({
        SAMLResponse: Buffer.from(xml).toString('base64'),
      }),
    ).rejects.toThrow(/Invalid signature/i);
  });

  it('is rejected when the audience is somebody else', async () => {
    const key = await makeKey();
    const xml = buildSignedResponse(input({ spEntityId: 'https://someone-else.test' }), key);
    await expect(
      sp(key.certificatePem).validatePostResponseAsync({
        SAMLResponse: Buffer.from(xml).toString('base64'),
      }),
    ).rejects.toThrow();
  });

  it('is rejected once its NotOnOrAfter has passed', async () => {
    const key = await makeKey();
    const past = new Date(Date.now() - 3_600_000);
    const xml = buildSignedResponse(
      input({ now: past, authnInstant: past, lifetimeMs: 60_000 }),
      key,
    );
    await expect(
      sp(key.certificatePem).validatePostResponseAsync({
        SAMLResponse: Buffer.from(xml).toString('base64'),
      }),
    ).rejects.toThrow();
  });

  it('escapes a hostile display name instead of letting it inject an element', async () => {
    const key = await makeKey();
    const hostile = '</saml:AttributeValue><saml:AttributeValue>injected';
    const xml = buildSignedResponse(
      input({
        attributes: [{
          name: 'displayName',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          values: [hostile],
        }],
      }),
      key,
    );
    const { profile } = await sp(key.certificatePem).validatePostResponseAsync({
      SAMLResponse: Buffer.from(xml).toString('base64'),
    });
    // One value carrying the literal text — not two values.
    expect(profile!.displayName).toBe(hostile);
  });
});

describe('postBindingForm', () => {
  it('posts to the ACS URL and escapes the relay state', () => {
    const html = postBindingForm({
      acsUrl: ACS, samlResponse: '<Response/>', relayState: '"><script>x</script>',
    });
    expect(html).toContain(`action="${ACS}"`);
    expect(html).not.toContain('<script>');
    expect(html).toContain('name="SAMLResponse"');
  });

  it('omits RelayState entirely when there is none, rather than sending an empty one', () => {
    const html = postBindingForm({ acsUrl: ACS, samlResponse: '<Response/>', relayState: null });
    expect(html).not.toContain('RelayState');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/protocols/src/saml/saml-assertion.test.ts`
Expected: FAIL — `Cannot find module './assertion.js'`.

- [ ] **Step 3: Write `authn-request.ts` (the POST half)**

```ts
import { parseXml, selectElements } from '../xml/parse.js';
import { verifySignedFragment } from '../xml/verify.js';

/**
 * No legitimate AuthnRequest is anywhere near this. Task 8's Redirect decoder
 * uses the same ceiling as its decompression bound.
 */
export const MAX_MESSAGE_BYTES = 512 * 1024;

/** Decodes an HTTP-POST binding message: base64 only, never deflated. */
export function decodePostMessage(param: string): string {
  const raw = Buffer.from(param, 'base64');
  if (raw.length === 0) throw new Error('empty SAML message');
  if (raw.length > MAX_MESSAGE_BYTES) throw new Error('SAML message too large');
  return raw.toString('utf8');
}

export interface IncomingAuthnRequest {
  id: string;
  issuer: string;
  /** As requested. Not yet checked against any allowlist. */
  acsUrl: string | null;
  nameIdFormat: string | null;
  forceAuthn: boolean;
  destination: string | null;
  issueInstant: Date;
}

/**
 * Reads an AuthnRequest.
 *
 * Nothing here is trusted. This is a read of an attacker-controlled document:
 * the ACS URL it names is checked against the allowlist by `resolveAcsUrl`,
 * and the signature — if the service provider registered certificates — is
 * checked by `verifyPostSignature` here or `verifyRedirectSignature` in Task 8
 * before any of it is acted on.
 */
export function parseAuthnRequest(xml: string): IncomingAuthnRequest {
  const doc = parseXml(xml);
  const root = doc.documentElement!;
  if (root.localName !== 'AuthnRequest') {
    throw new Error(`expected an AuthnRequest, got ${root.localName}`);
  }

  const id = root.getAttribute('ID') ?? '';
  if (id === '') throw new Error('AuthnRequest has no ID');

  const [issuerNode] = selectElements(root, "./*[local-name(.)='Issuer']");
  const issuer = (issuerNode?.textContent ?? '').trim();
  if (issuer === '') throw new Error('AuthnRequest has no Issuer');

  const [policy] = selectElements(root, "./*[local-name(.)='NameIDPolicy']");

  const instant = root.getAttribute('IssueInstant');
  const issueInstant = instant ? new Date(instant) : new Date(NaN);
  if (Number.isNaN(issueInstant.getTime())) {
    throw new Error('AuthnRequest has no usable IssueInstant');
  }

  return {
    id,
    issuer,
    acsUrl: root.getAttribute('AssertionConsumerServiceURL'),
    nameIdFormat: policy?.getAttribute('Format') ?? null,
    forceAuthn: root.getAttribute('ForceAuthn') === 'true',
    destination: root.getAttribute('Destination'),
    issueInstant,
  };
}

/**
 * Verifies an HTTP-POST binding signature and returns the bytes that were
 * signed.
 *
 * Delegates to the XSW-hardened wrapper, so the caller must re-parse the
 * returned string and read *that* — never the document it passed in. A
 * document can always be arranged to contain one genuinely signed
 * AuthnRequest and one forged one that a naive reader picks up instead.
 */
export function verifyPostSignature(
  xml: string,
  certificates: string[],
): string | null {
  const doc = parseXml(xml);
  return verifySignedFragment(xml, doc.documentElement!, certificates);
}
```

- [ ] **Step 4: Write `assertion.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { xmlAttr, xmlText } from '../xml/escape.js';
import { signFragment } from '../xml/sign.js';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';

/** SAML wants seconds; a fractional part upsets some SPs' parsers. */
const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${randomUUID()}`;

export interface AssertionAttribute {
  name: string;
  nameFormat: string;
  values: string[];
}

export interface AssertionInput {
  idpEntityId: string;
  spEntityId: string;
  acsUrl: string;
  nameId: string;
  nameIdFormat: string;
  sessionIndex: string;
  /** The SP's AuthnRequest ID, or null for an IdP-initiated response. */
  inResponseTo: string | null;
  attributes: AssertionAttribute[];
  lifetimeMs: number;
  authnInstant: Date;
  authnContextClassRef: string;
  now: Date;
}

export interface SigningMaterial {
  privateKeyPem: string;
  certificatePem: string;
}

/**
 * Builds and signs a SAML Response.
 *
 * **The Assertion is signed, not the Response.** Both are permitted; signing
 * the assertion is what `wantAssertionsSigned` asks for — the setting almost
 * every service provider defaults to true — and Task 9's encryption replaces
 * the Assertion element with an EncryptedAssertion, so the signature has to be
 * inside it.
 *
 * The document is assembled as a string rather than through a DOM because the
 * bytes must be stable across canonicalization, and because a DOM
 * serialization that reorders a namespace declaration invalidates the digest.
 * Every interpolated value goes through `xmlText` or `xmlAttr`: a display name
 * of `</saml:AttributeValue><saml:AttributeValue>admin` is otherwise an extra
 * attribute value the administrator never mapped, inside a document the
 * service provider will trust completely.
 *
 * `NotBefore` is set one minute back. Clock skew between an IdP and an SP is
 * routine, and an assertion refused for being one second early is a support
 * ticket nobody can reproduce.
 *
 * This exact parameter set was executed as a spike before this plan was
 * written: the output was accepted by `@node-saml/node-saml` acting as a
 * service provider and rejected with `Invalid signature` after one attribute
 * value was altered.
 */
export function buildSignedResponse(
  input: AssertionInput,
  key: SigningMaterial,
): string {
  const assertionId = newId();
  const responseId = newId();
  const notBefore = new Date(input.now.getTime() - 60_000);
  const notOnOrAfter = new Date(input.now.getTime() + input.lifetimeMs);

  const inResponseToAttr = input.inResponseTo
    ? ` InResponseTo="${xmlAttr(input.inResponseTo)}"`
    : '';

  const attributes = input.attributes
    .map(
      (attribute) =>
        `<saml:Attribute Name="${xmlAttr(attribute.name)}" NameFormat="${xmlAttr(
          attribute.nameFormat,
        )}">` +
        attribute.values
          .map(
            (value) =>
              `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${xmlText(
                value,
              )}</saml:AttributeValue>`,
          )
          .join('') +
        `</saml:Attribute>`,
    )
    .join('');

  const attributeStatement =
    attributes === ''
      ? ''
      : `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>`;

  const assertion =
    `<saml:Assertion xmlns:saml="${SAML_NS}" ID="${assertionId}" Version="2.0" IssueInstant="${instant(
      input.now,
    )}">` +
    `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${xmlAttr(input.nameIdFormat)}">${xmlText(input.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${instant(
      notOnOrAfter,
    )}" Recipient="${xmlAttr(input.acsUrl)}"${inResponseToAttr}/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${instant(notBefore)}" NotOnOrAfter="${instant(notOnOrAfter)}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlText(input.spEntityId)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant(
      input.authnInstant,
    )}" SessionIndex="${xmlAttr(input.sessionIndex)}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>${xmlText(
      input.authnContextClassRef,
    )}</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    attributeStatement +
    `</saml:Assertion>`;

  // Signed on its own, before it is placed in the Response, so the reference
  // XPath has exactly one candidate and the enveloped-signature transform has
  // nothing else to strip.
  const signedAssertion = signFragment(assertion, {
    privateKeyPem: key.privateKeyPem,
    certificatePem: key.certificatePem,
    referenceXPath: "/*[local-name(.)='Assertion']",
    insertAfterXPath: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
  });

  return (
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${responseId}" Version="2.0" IssueInstant="${instant(
      input.now,
    )}" Destination="${xmlAttr(input.acsUrl)}"${inResponseToAttr}>` +
    `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signedAssertion +
    `</samlp:Response>`
  );
}

/** The HTML auto-post form that delivers a Response over HTTP-POST. */
export function postBindingForm(input: {
  acsUrl: string;
  samlResponse: string;
  relayState: string | null;
}): string {
  const relay =
    input.relayState === null
      ? ''
      : `<input type="hidden" name="RelayState" value="${xmlAttr(input.relayState)}"/>`;

  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Signing you in</title></head>` +
    `<body onload="document.forms[0].submit()">` +
    `<form method="post" action="${xmlAttr(input.acsUrl)}">` +
    `<input type="hidden" name="SAMLResponse" value="${xmlAttr(
      Buffer.from(input.samlResponse, 'utf8').toString('base64'),
    )}"/>` +
    relay +
    `<noscript><button type="submit">Continue</button></noscript>` +
    `</form></body></html>`
  );
}
```

Add to `packages/protocols/src/index.ts`:

```ts
export * from './saml/authn-request.js';
export * from './saml/assertion.js';
```

- [ ] **Step 5: Run the protocol tests**

Run: `pnpm vitest run packages/protocols/src/saml/saml-assertion.test.ts`
Expected: PASS, all thirteen cases.

**Why these tests are not degenerate.** The conformance block does not assert on our own output shape; it hands the document to an independent implementation and asserts on what *that* extracts, so a subtly wrong canonicalization, a misplaced signature or a wrong digest algorithm fails rather than passing a string comparison we also wrote. The tamper case asserts the specific rejection (`Invalid signature`), so a response that failed for an unrelated reason — a wrong audience, an expired condition — does not count as the security property holding.

- [ ] **Step 6: Write `saml-request-service.ts`**

`packages/core/src/access/saml-request-service.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { withTenant } from '@syntra/db';

export interface ParkedAuthnRequest {
  id: string;
  applicationId: string;
  handle: string;
  requestId: string | null;
  acsUrl: string;
  relayState: string | null;
  forceAuthn: boolean;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Parks a validated AuthnRequest while the user signs in.
 *
 * Everything on the row has already been checked — the ACS URL against the
 * allowlist, the signature against the SP's registered certificates — and the
 * browser carries only `handle`, which is opaque and means nothing anywhere
 * else. The alternative, round-tripping the request through the browser,
 * means re-checking every field on the way back, and the check that gets
 * forgotten is the ACS allowlist.
 */
export async function parkAuthnRequest(
  tenantId: string,
  input: Omit<ParkedAuthnRequest, 'id' | 'handle'> & { ttlMs?: number },
): Promise<ParkedAuthnRequest> {
  const handle = randomBytes(32).toString('base64url');
  const row = await withTenant(tenantId, (tx) =>
    tx.samlAuthnRequest.create({
      data: {
        tenantId,
        applicationId: input.applicationId,
        handle,
        requestId: input.requestId,
        acsUrl: input.acsUrl,
        relayState: input.relayState,
        forceAuthn: input.forceAuthn,
        expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    }),
  );
  return {
    id: row.id,
    applicationId: row.applicationId,
    handle: row.handle,
    requestId: row.requestId,
    acsUrl: row.acsUrl,
    relayState: row.relayState,
    forceAuthn: row.forceAuthn,
  };
}

export async function findParkedAuthnRequest(
  tenantId: string,
  handle: string,
  now: Date = new Date(),
): Promise<ParkedAuthnRequest | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.samlAuthnRequest.findFirst({
      where: { handle, consumedAt: null, expiresAt: { gt: now } },
    });
    if (!row) return null;
    return {
      id: row.id,
      applicationId: row.applicationId,
      handle: row.handle,
      requestId: row.requestId,
      acsUrl: row.acsUrl,
      relayState: row.relayState,
      forceAuthn: row.forceAuthn,
    };
  });
}

/**
 * Spends the request. Returns false if someone else already did.
 *
 * `updateMany` with `consumedAt: null` in the predicate, so two concurrent
 * completions cannot both issue an assertion for one request. The count is
 * the answer, not a re-read.
 */
export async function consumeParkedAuthnRequest(
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.samlAuthnRequest.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: now },
    });
    return result.count === 1;
  });
}
```

- [ ] **Step 7: Write `saml-session-service.ts`**

`packages/core/src/access/saml-session-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

/** Records that a session has signed into an application, for single logout. */
export async function startSamlSsoSession(
  tx: TenantClient,
  input: {
    sessionId: string;
    applicationId: string;
    nameId: string;
    sessionIndex: string;
  },
): Promise<void> {
  const tenantId = await currentTenant(tx);
  // A repeat launch refreshes rather than accumulating rows the logout would
  // notify twice. `saml_sso_session_one_live` is what makes this safe.
  await tx.samlSsoSession.updateMany({
    where: {
      sessionId: input.sessionId,
      applicationId: input.applicationId,
      endedAt: null,
    },
    data: { endedAt: new Date() },
  });
  await tx.samlSsoSession.create({ data: { tenantId, ...input } });
}

export async function listSsoSessionsForSession(
  tx: TenantClient,
  sessionId: string,
) {
  return tx.samlSsoSession.findMany({ where: { sessionId, endedAt: null } });
}

export async function endSsoSessions(
  tx: TenantClient,
  sessionId: string,
): Promise<void> {
  await tx.samlSsoSession.updateMany({
    where: { sessionId, endedAt: null },
    data: { endedAt: new Date() },
  });
}
```

Export both services from `packages/core/src/index.ts`.

- [ ] **Step 8: Add `POST /sso`, `GET /continue` and `completeSso` to `saml-idp.ts`**

Add these imports to the file Task 6 created:

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import {
  authorize,
  collectSubjectFacts,
  consumeParkedAuthnRequest,
  findParkedAuthnRequest,
  findSamlConfigByEntityId,
  findSamlConfigForApplication,
  isApplicationAssigned,
  listClaimMappings,
  loadActiveKey,
  localMasterKeyProvider,
  parkAuthnRequest,
  recordEvent,
  resolveAcsUrl,
  resolveClaims,
  resolveSession,
  startSamlSsoSession,
  type ParkedAuthnRequest,
  type SamlConfigRecord,
} from '@syntra/core';
import {
  buildSignedResponse,
  decodePostMessage,
  parseAuthnRequest,
  postBindingForm,
  verifyPostSignature,
} from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { tenantRelyingParty } from './relying-party.js';

/**
 * The SAML authentication context class that corresponds to the factor the
 * session was actually established with. A service provider that makes its own
 * decisions from the AuthnContext gets an honest answer rather than a constant.
 */
const AUTHN_CONTEXT: Record<string, string> = {
  totp: 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken',
  webauthn: 'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
  recovery_code: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
};
const DEFAULT_AUTHN_CONTEXT =
  'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
```

At the top of `registerSamlIdpRoutes`, register the form-body parser **inside this plugin only**:

```ts
  // Scoped to this plugin by Fastify's encapsulation. Registering it at the
  // root would drain the body of every `/oidc/*` request, which oidc-provider
  // reads from the raw stream itself — Task 11 depends on that, and Task 11's
  // boundary test asserts the root has no such parser.
  await app.register(formbody);
```

Then the shared route options and the POST handler. Task 8 adds `GET /sso` beside it and reuses both.

```ts
  const rateLimited = {
    // A SAML SSO endpoint evaluates policy and can mint an attempt, so it is a
    // credential-issuing endpoint whatever the URL suggests. Both dimensions,
    // exactly as portal.ts does: the per-address half alone is bounded only by
    // how many addresses the attacker has, and a second `app.rateLimit()` hook
    // would be silently inert.
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

  /**
   * Validates an incoming AuthnRequest, parks it, and continues.
   *
   * `verify` is the binding-specific half: XML-DSig over the document for
   * HTTP-POST, a detached signature over the raw query string for
   * HTTP-Redirect (Task 8). It returns the bytes that were signed, or `''`
   * when the binding's signature does not carry the document — and null on
   * failure. Everything after `resolveAcsUrl` is identical for both bindings.
   */
  const beginSso = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      xml: string;
      relayState: string | null;
      verify: (config: SamlConfigRecord) => string | null;
    },
  ) => {
    const { tenant, identity } = await samlContext(request, options);

    // Parsed only to find out who is asking. Nothing on it is acted on until
    // the signature check below, and the ACS URL is not acted on until
    // `resolveAcsUrl`.
    const unverified = parseAuthnRequest(input.xml);

    const config = await request.db((tx) =>
      findSamlConfigByEntityId(tx, unverified.issuer),
    );
    if (!config) {
      // An unknown service provider and a disabled one read alike, so the
      // catalogue cannot be enumerated from an unauthenticated endpoint.
      throw new ProblemError(404, 'saml-unknown-sp', 'Unknown service provider');
    }

    let trusted = unverified;
    if (config.wantAuthnRequestsSigned) {
      if (config.spCertificates.length === 0) {
        throw new ProblemError(
          409, 'saml-no-certificate',
          'This service provider requires signed requests but has no certificate registered',
        );
      }
      const verified = input.verify(config);
      if (verified === null) {
        throw new ProblemError(400, 'saml-bad-signature', 'Invalid request signature');
      }
      // Re-parsed from the VERIFIED bytes, never from the document that
      // arrived. That document may carry a second, forged AuthnRequest beside
      // the signed one.
      if (verified !== '') trusted = parseAuthnRequest(verified);
    }

    const acsUrl = resolveAcsUrl(config, trusted.acsUrl);
    if (acsUrl === null) {
      // The request named a delivery address that is not on the allowlist.
      // Refusing rather than falling back is the whole point: a fallback would
      // post a valid signed assertion for a real user to whatever address the
      // request asked for.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'saml.acs_refused',
          targetType: 'Application',
          targetId: config.applicationId,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { requested: trusted.acsUrl, spEntityId: config.spEntityId },
        }),
      );
      throw new ProblemError(
        400, 'saml-acs-not-allowed',
        'That assertion consumer service URL is not registered for this application',
      );
    }

    const parked = await parkAuthnRequest(request.tenantId, {
      applicationId: config.applicationId,
      requestId: trusted.id,
      acsUrl,
      relayState: input.relayState,
      forceAuthn: trusted.forceAuthn,
    });

    return completeSso(request, reply, { tenant, identity, config, parked });
  };

  app.post('/sso', rateLimited, async (request, reply) => {
    const body = request.body as Record<string, string | undefined> | undefined;
    const encoded = body?.SAMLRequest;
    if (typeof encoded !== 'string' || encoded === '') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = decodePostMessage(encoded);
    return beginSso(request, reply, {
      xml,
      relayState: typeof body?.RelayState === 'string' ? body.RelayState : null,
      verify: (config) => verifyPostSignature(xml, config.spCertificates),
    });
  });

  /**
   * Where the login and MFA screens return to. The handle names a parked
   * request; everything else about the flow is read off that row.
   */
  app.get('/continue', rateLimited, async (request, reply) => {
    const { tenant, identity } = await samlContext(request, options);
    const handle = (request.query as Record<string, string | undefined>).handle;
    if (typeof handle !== 'string') {
      throw new ProblemError(400, 'saml-bad-request', 'No handle');
    }
    const parked = await findParkedAuthnRequest(request.tenantId, handle);
    if (!parked) {
      throw new ProblemError(410, 'saml-request-expired', 'That sign-in request has expired');
    }
    const config = await request.db((tx) =>
      findSamlConfigForApplication(tx, parked.applicationId),
    );
    if (!config) throw new ProblemError(409, 'saml-not-configured', 'Not configured');
    return completeSso(request, reply, { tenant, identity, config, parked });
  });
```

And the shared completion, in the same file:

```ts
  /**
   * The only place a SAML assertion is issued, and it issues one only from an
   * `allow`.
   *
   * Everything protocol-specific happened before this point; from here the
   * flow is the same decision every other entry point makes. There is no path
   * to `buildSignedResponse` that does not pass through `authorize()`, which
   * is spec section 7's requirement made structural.
   */
  async function completeSso(
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: {
      tenant: { primaryDomain: string | null };
      identity: ReturnType<typeof tenantProtocolIdentity>;
      config: SamlConfigRecord;
      parked: ParkedAuthnRequest;
    },
  ) {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await request.db((tx) => resolveSession(tx, token)) : null;

    // No Syntra session yet, or the service provider demanded a fresh
    // authentication. Send the user to the login screen; it returns here.
    if (!session || ctx.parked.forceAuthn) {
      const next = encodeURIComponent(`/saml/continue?handle=${ctx.parked.handle}`);
      return reply.redirect(`/login?next=${next}`, 302);
    }

    const assigned = await request.db((tx) =>
      isApplicationAssigned(tx, session.userId, ctx.parked.applicationId),
    );
    if (!assigned) {
      throw new ProblemError(403, 'not-assigned', 'Not available to you');
    }

    const decision = await authorize(request.tenantId, {
      kind: 'primary',
      // The session id only. `authorize()` reads the factor that established
      // the session off the row itself, so a launch that came back as a
      // challenge and was answered does not challenge again forever.
      principal: { kind: 'session', userId: session.userId, sessionId: session.sessionId },
      applicationId: ctx.parked.applicationId,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(ctx.tenant, options.publicUrl),
      // Entering an application never elevates.
      scope: 'portal',
    });

    if (decision.status === 'deny') {
      throw new ProblemError(403, 'not-assigned', 'Not available to you');
    }

    if (decision.status === 'challenge' || decision.status === 'enrol') {
      // The MFA screen answers the attempt and returns to /saml/continue,
      // where this function runs again and re-evaluates policy.
      const next = encodeURIComponent(`/saml/continue?handle=${ctx.parked.handle}`);
      const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
      return reply.redirect(
        `${path}?attempt=${encodeURIComponent(decision.attemptToken)}&next=${next}`,
        302,
      );
    }

    // Spend the parked request before anything is signed. A second concurrent
    // completion loses the update and gets a 410 rather than a second
    // assertion for the same request id.
    if (!(await consumeParkedAuthnRequest(request.tenantId, ctx.parked.id))) {
      throw new ProblemError(
        410, 'saml-request-expired', 'That sign-in request has already been used',
      );
    }

    const now = new Date();
    const sessionIndex = `_${randomUUID()}`;

    const { facts, mappings } = await request.db(async (tx) => ({
      facts: await collectSubjectFacts(tx, decision.userId, now),
      mappings: await listClaimMappings(tx, ctx.parked.applicationId, 'saml'),
    }));
    const claims = resolveClaims(mappings, facts, 'saml');

    // The NameID: a mapped claim if the tenant named one, otherwise the
    // account's email. A mapped claim that resolved to nothing is a
    // configuration error the service provider cannot recover from, so it is
    // refused here rather than sent as an empty NameID.
    const nameId =
      ctx.config.nameIdClaim === null
        ? facts.user.email
        : (claims.find((c) => c.name === ctx.config.nameIdClaim)?.values[0] ?? null);
    if (!nameId) {
      throw new ProblemError(
        409, 'saml-no-name-id',
        `This application identifies users by "${ctx.config.nameIdClaim ?? 'email'}", and this account has no such value.`,
      );
    }

    // Key material is loaded outside any transaction, and signing happens
    // outside one too.
    const key = await loadActiveKey(
      request.tenantId,
      localMasterKeyProvider(options.masterKey),
      'saml',
    );
    if (!key?.certificate) {
      throw new ProblemError(409, 'saml-no-key', 'This organization has no SAML signing key yet');
    }

    const xml = buildSignedResponse(
      {
        idpEntityId: ctx.identity.entityId,
        spEntityId: ctx.config.spEntityId,
        acsUrl: ctx.parked.acsUrl,
        nameId,
        nameIdFormat: ctx.config.nameIdFormat,
        sessionIndex,
        inResponseTo: ctx.parked.requestId,
        attributes: claims.map((c) => ({
          name: c.name, nameFormat: c.nameFormat, values: c.values,
        })),
        lifetimeMs: ctx.config.assertionLifetimeMs,
        authnInstant: now,
        authnContextClassRef:
          AUTHN_CONTEXT[decision.satisfiedFactor ?? ''] ?? DEFAULT_AUTHN_CONTEXT,
        now,
      },
      { privateKeyPem: key.privateKeyPem, certificatePem: key.certificate },
    );

    await request.db(async (tx) => {
      await startSamlSsoSession(tx, {
        sessionId: session.sessionId,
        applicationId: ctx.parked.applicationId,
        nameId,
        sessionIndex,
      });
      await recordEvent(tx, {
        actorUserId: decision.userId,
        action: 'saml.assertion_issued',
        targetType: 'Application',
        targetId: ctx.parked.applicationId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          spEntityId: ctx.config.spEntityId,
          acsUrl: ctx.parked.acsUrl,
          inResponseTo: ctx.parked.requestId,
          satisfiedFactor: decision.satisfiedFactor,
        },
      });
    });

    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(postBindingForm({
        acsUrl: ctx.parked.acsUrl,
        samlResponse: xml,
        relayState: ctx.parked.relayState,
      }));
  }
```

- [ ] **Step 9: Write the route test**

Create `apps/api/src/routes/saml-sso-post.test.ts`. Task 8's Redirect test imports `SP`, `ACS`, `authnRequest`, `samlConfig` and `extractResponse` from this file, so they are exported.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import pkg from '@node-saml/node-saml';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  createApplication,
  createClaimMapping,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { signFragment } from '@syntra/protocols';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const { SAML } = pkg;

export const SP = 'https://sp.example.test/metadata';
export const ACS = 'https://sp.example.test/acs';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let applicationId: string;
let cookie: string;

const spKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const spPrivatePem = spKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const spPublicPem = spKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** The default configuration, so each test overrides only what it means. */
export const samlConfig = (over: Record<string, unknown> = {}) => ({
  spEntityId: SP,
  acsUrls: [ACS],
  defaultAcsUrl: ACS,
  acsBinding: 'HTTP-POST' as const,
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  nameIdClaim: null,
  spCertificates: [] as string[],
  wantAuthnRequestsSigned: false,
  encryptAssertions: false,
  encryptionCertificate: null,
  sloUrl: null,
  sloBinding: 'HTTP-POST' as const,
  allowIdpInitiated: false,
  assertionLifetimeMs: 300_000,
  ...over,
});

export const authnRequest = (over: { id?: string; acs?: string | null } = {}) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${over.id ?? '_req1'}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="http://${TEST_HOST}/saml/sso"${
    over.acs === null ? '' : ` AssertionConsumerServiceURL="${over.acs ?? ACS}"`
  }><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

export const extractResponse = (html: string) => {
  const match = html.match(/name="SAMLResponse" value="([^"]+)"/);
  if (!match) throw new Error('no SAMLResponse in the returned form');
  return match[1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  ({ userId, applicationId } = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, {
      name: 'CRM', slug: 'crm', type: 'saml',
    });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    await upsertSamlConfig(tx, application.id, samlConfig());
    await createClaimMapping(tx, application.id, {
      protocol: 'saml',
      claimName: 'department',
      nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
      sourceKind: 'contract',
      sourceField: 'department',
      contractStrategy: 'primary',
      literalValue: null,
      releaseScope: null,
      multiValued: false,
    });
    return { userId: user.id, applicationId: application.id };
  }));

  const login = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const postSso = (xml: string, relayState?: string, withCookie = true) =>
  ctx.app.inject({
    method: 'POST', url: '/saml/sso',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/x-www-form-urlencoded',
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
    payload: new URLSearchParams({
      SAMLRequest: Buffer.from(xml).toString('base64'),
      ...(relayState === undefined ? {} : { RelayState: relayState }),
    }).toString(),
  });

const get = (url: string, withCookie = true) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

describe('SAML single sign-on over HTTP-POST', () => {
  it('issues an assertion a real service provider validates', async () => {
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="${ACS}"`);

    const metadata = await get('/saml/metadata', false);
    const certificate = `-----BEGIN CERTIFICATE-----\n${
      metadata.body.match(/<ds:X509Certificate>([^<]+)</)![1]!
    }\n-----END CERTIFICATE-----`;

    const sp = new SAML({
      idpCert: certificate,
      issuer: SP, callbackUrl: ACS, audience: SP,
      wantAuthnResponseSigned: false, wantAssertionsSigned: true,
      validateInResponseTo: 'never' as never, acceptedClockSkewMs: 5000,
    });
    const { profile } = await sp.validatePostResponseAsync({
      SAMLResponse: extractResponse(res.body),
    });
    expect(profile!.nameID).toBe('j@acme.test');
    // The mapping resolved to no contract, so the claim is absent — not
    // present and empty.
    expect(profile!.department).toBeUndefined();
  });

  it('echoes InResponseTo and RelayState back to the service provider', async () => {
    const res = await postSso(authnRequest({ id: '_abc123' }), 'deep/link');
    expect(res.body).toContain('name="RelayState" value="deep/link"');
    const xml = Buffer.from(extractResponse(res.body), 'base64').toString('utf8');
    expect(xml).toContain('InResponseTo="_abc123"');
  });

  it('refuses an ACS URL that is not on the allowlist, issues nothing, and audits it', async () => {
    const res = await postSso(authnRequest({ acs: 'https://attacker.test/acs' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
    const events = await prisma.auditEvent.findMany({ where: { action: 'saml.acs_refused' } });
    expect(events).toHaveLength(1);
  });

  it('refuses an ACS URL that merely starts with, or extends, an allowed one', async () => {
    for (const bad of [`${ACS}.attacker.test`, `${ACS}/`, `${ACS}/../evil`, ACS.toUpperCase()]) {
      const res = await postSso(authnRequest({ acs: bad }));
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('SAMLResponse');
    }
  });

  it('refuses when the request names no ACS URL and the application has no default', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({ defaultAcsUrl: null })),
    );
    const res = await postSso(authnRequest({ acs: null }));
    // No implicit fall back to the first registered URL — see Task 6.
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('sends an unauthenticated caller to the login screen rather than issuing anything', async () => {
    const res = await postSso(authnRequest(), undefined, false);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?next=/);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('challenges rather than issuing when policy demands a second factor', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'mfa for crm', outcome: 'require_mfa', applicationIds: [applicationId] }),
    );
    const res = await postSso(authnRequest());
    // No factor is enrolled, so the chokepoint offers enrolment. Either way it
    // is a redirect, and either way no assertion exists.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('issues nothing when policy denies', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('issues nothing for an application the user is not assigned', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.appAssignment.findMany({ where: { applicationId } });
      await tx.appAssignment.deleteMany({ where: { id: rows[0]!.id } });
    });
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('accepts a correctly signed request and refuses one whose signed content was swapped', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );

    const sign = (xml: string) =>
      signFragment(xml, {
        privateKeyPem: spPrivatePem,
        certificatePem: spPublicPem,
        referenceXPath: "/*[local-name(.)='AuthnRequest']",
        insertAfterXPath: "/*[local-name(.)='AuthnRequest']/*[local-name(.)='Issuer']",
      });

    // The positive path first, so a verifier that rejected everything fails
    // here rather than passing the security case for the wrong reason.
    const ok = await postSso(sign(authnRequest()));
    expect(ok.statusCode).toBe(200);

    // Signature intact, payload altered: the ACS URL now points elsewhere.
    const swapped = sign(authnRequest()).replace(ACS, 'https://attacker.test/acs');
    const bad = await postSso(swapped);
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('SAMLResponse');
  });

  it('refuses an unsigned request when the application requires signed ones', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const res = await postSso(authnRequest());
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('spends a parked request once, so a replayed handle issues no second assertion', async () => {
    const first = await postSso(authnRequest());
    expect(first.statusCode).toBe(200);
    const handle = await withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.samlAuthnRequest.findFirstOrThrow();
      return row.handle;
    });
    const replay = await get(`/saml/continue?handle=${encodeURIComponent(handle)}`);
    expect(replay.statusCode).toBe(410);
    expect(replay.body).not.toContain('SAMLResponse');
  });

  it('refuses when the request arrives on a sibling of the tenant host', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/saml/sso',
      headers: {
        host: `${TEST_HOST}.attacker.example`,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `syntra_session=${cookie}`,
      },
      payload: new URLSearchParams({
        SAMLRequest: Buffer.from(authnRequest()).toString('base64'),
      }).toString(),
    });
    expect(res.statusCode).toBe(421);
  });
});
```

- [ ] **Step 10: Run the route tests**

Run: `pnpm vitest run apps/api/src/routes/saml-sso-post.test.ts`
Expected: PASS, all thirteen cases.

**Why these tests are not degenerate.** Eight of them assert `not.toContain('SAMLResponse')` on top of the status code, so a handler that returned a 403 *and* still rendered the form would fail — a status code alone is not evidence that nothing was issued. The signature case asserts the positive path first, so a verifier that rejected everything fails there rather than passing the security case for the wrong reason. The MFA case accepts either `/mfa` or `/enrol` because the chokepoint legitimately chooses between them, and pins the property that matters — a redirect and no assertion — rather than the branch. The claim assertion is `toBeUndefined()` rather than `toBe('')`, which is the difference spec section 6 asks for.

- [ ] **Step 11: Commit**

```bash
git add packages/protocols/src/saml/authn-request.ts packages/protocols/src/saml/assertion.ts packages/protocols/src/saml/saml-assertion.test.ts packages/protocols/src/index.ts packages/core/src/access/saml-request-service.ts packages/core/src/access/saml-session-service.ts packages/core/src/index.ts apps/api/src/routes/saml-idp.ts apps/api/src/routes/saml-sso-post.test.ts
git commit -m "feat(saml): SP-initiated SSO over HTTP-POST, issuing only from an authorize() allow"
```

---

## Task 8: SAML single sign-on over HTTP-Redirect, with the detached query signature

**Files:**
- Modify: `packages/protocols/src/saml/authn-request.ts` (add `decodeRedirectMessage` and `verifyRedirectSignature`)
- Create: `packages/protocols/src/saml/saml-redirect.test.ts`
- Modify: `apps/api/src/routes/saml-idp.ts` (add `signedRedirectQuery` and `GET /sso`)
- Create: `apps/api/src/routes/saml-sso-redirect.test.ts`

**Interfaces:**
- Consumes: `parseAuthnRequest`, `MAX_MESSAGE_BYTES`, `beginSso`, `completeSso`, `rateLimited`, `samlContext` — all from Task 7 and Task 6, unchanged.
- Produces:
  ```ts
  // @syntra/protocols
  export function decodeRedirectMessage(param: string): string;  // base64 + raw inflate, bounded
  export function verifyRedirectSignature(input: {
    rawQuery: string; signature: string; sigAlg: string; certificates: string[];
  }): boolean;

  // apps/api/src/routes/saml-idp.ts
  function signedRedirectQuery(rawUrl: string, parameter: 'SAMLRequest' | 'SAMLResponse'): string;
  ```
  `signedRedirectQuery` is exported from the module so Task 9's single-logout handler can reuse it for `SAMLRequest` and `SAMLResponse` alike.

### Why this is a separate task from the POST binding

The two bindings share a message and share nothing else about how it is authenticated. HTTP-POST carries an XML-DSig enveloped signature inside the document, verified by canonicalizing the signed reference. HTTP-Redirect carries a **detached** signature over the raw query string — no XML, no canonicalization, and a byte-for-byte dependence on the sender's own percent-encoding. They fail differently, they are attacked differently, and the mistakes are not the same mistakes.

- [ ] **Step 1: Write the failing protocol tests**

Create `packages/protocols/src/saml/saml-redirect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { decodeRedirectMessage, verifyRedirectSignature } from './authn-request.js';

const SP = 'https://sp.example.test/metadata';
const ACS = 'https://sp.example.test/acs';
const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

const authnRequestXml = (acs = ACS) =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${acs}"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

const encode = (xml: string) => deflateRawSync(Buffer.from(xml)).toString('base64');

describe('decodeRedirectMessage', () => {
  it('inflates a raw DEFLATE stream', () => {
    const xml = authnRequestXml();
    expect(decodeRedirectMessage(encode(xml))).toBe(xml);
  });

  it('refuses a message that inflates past the ceiling', () => {
    // A 30 MB run of spaces deflates to a few kilobytes. Without a ceiling the
    // decoder allocates the whole thing before anything else runs, which is a
    // decompression bomb against an unauthenticated endpoint.
    const bomb = deflateRawSync(Buffer.alloc(30 * 1024 * 1024, 0x20)).toString('base64');
    expect(() => decodeRedirectMessage(bomb)).toThrow(/too large/i);
  });

  it('refuses an empty parameter and one that is not a DEFLATE stream', () => {
    expect(() => decodeRedirectMessage('')).toThrow();
    expect(() => decodeRedirectMessage(Buffer.from('not deflated').toString('base64')))
      .toThrow(/decompress/i);
  });
});

describe('verifyRedirectSignature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sign = (rawQuery: string) =>
    createSign('RSA-SHA256').update(rawQuery).sign(privatePem).toString('base64');

  it('accepts a signature over the exact raw query substring', () => {
    const raw = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml()))}&RelayState=${encodeURIComponent('r1')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({
        rawQuery: raw, signature: sign(raw), sigAlg: SIG_ALG, certificates: [publicPem],
      }),
    ).toBe(true);
  });

  it('refuses when the request the signature covered has been swapped for another', () => {
    // The attack: the signature stays, the SAMLRequest changes so that the ACS
    // URL points at the attacker. This is what the whole check exists for.
    const raw = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml()))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const signature = sign(raw);
    const swapped = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml('https://attacker.test/acs')))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({ rawQuery: swapped, signature, sigAlg: SIG_ALG, certificates: [publicPem] }),
    ).toBe(false);
  });

  it('refuses when the RelayState the signature covered has been altered', () => {
    const request = encodeURIComponent(encode(authnRequestXml()));
    const raw = `SAMLRequest=${request}&RelayState=${encodeURIComponent('r1')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const signature = sign(raw);
    const altered = `SAMLRequest=${request}&RelayState=${encodeURIComponent('r2')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({ rawQuery: altered, signature, sigAlg: SIG_ALG, certificates: [publicPem] }),
    ).toBe(false);
  });

  it('refuses a SigAlg this build does not implement rather than defaulting to one', () => {
    const raw = 'SAMLRequest=x&SigAlg=whatever';
    // A verifier that treats an unknown algorithm as "probably SHA-1" is how
    // an algorithm-confusion bypass gets in, and SHA-1 is not offered at all.
    for (const alg of ['whatever', 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', '']) {
      expect(
        verifyRedirectSignature({ rawQuery: raw, signature: sign(raw), sigAlg: alg, certificates: [publicPem] }),
      ).toBe(false);
    }
  });

  it('refuses an empty certificate list and an empty signature', () => {
    const raw = `SAMLRequest=x&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({ rawQuery: raw, signature: sign(raw), sigAlg: SIG_ALG, certificates: [] }),
    ).toBe(false);
    expect(
      verifyRedirectSignature({ rawQuery: raw, signature: '', sigAlg: SIG_ALG, certificates: [publicPem] }),
    ).toBe(false);
  });

  it('accepts when any one of several registered certificates verifies, so a rollover works', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const raw = `SAMLRequest=${encodeURIComponent(encode(authnRequestXml()))}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    expect(
      verifyRedirectSignature({
        rawQuery: raw, signature: sign(raw), sigAlg: SIG_ALG, certificates: [otherPem, publicPem],
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/protocols/src/saml/saml-redirect.test.ts`
Expected: FAIL — `decodeRedirectMessage is not a function`.

- [ ] **Step 3: Add the two functions to `authn-request.ts`**

Append to the file Task 7 created:

```ts
import { createVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const RSA_SHA512 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512';

/**
 * Decodes an HTTP-Redirect binding message: base64, then a raw DEFLATE stream
 * with no zlib header.
 *
 * `maxOutputLength` is the whole point. Redirect-binding messages arrive on an
 * unauthenticated endpoint and are attacker-supplied, and a few kilobytes of
 * base64 can inflate to hundreds of megabytes. Node's zlib throws once the
 * ceiling is passed rather than allocating the rest.
 */
export function decodeRedirectMessage(param: string): string {
  const compressed = Buffer.from(param, 'base64');
  if (compressed.length === 0) throw new Error('empty SAML message');
  try {
    return inflateRawSync(compressed, {
      maxOutputLength: MAX_MESSAGE_BYTES,
    }).toString('utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/buffer|maxOutputLength|length/i.test(message)) {
      throw new Error('SAML message too large once decompressed');
    }
    throw new Error(`SAML message could not be decompressed: ${message}`);
  }
}

/**
 * Verifies an HTTP-Redirect binding signature.
 *
 * This is not XML-DSig. The signature covers the raw query string —
 * `SAMLRequest=...&RelayState=...&SigAlg=...` in exactly that order, with
 * exactly the percent-encoding the sender used. Re-encoding the parameters
 * from a parsed object produces different bytes and every legitimate signature
 * fails, which is why the caller passes the raw substring lifted out of
 * `request.raw.url` rather than anything Fastify parsed.
 *
 * An unrecognised `SigAlg` returns false rather than falling back to a
 * default. A verifier that treats an unknown algorithm as "probably SHA-1" is
 * how an algorithm-confusion bypass gets in, and SHA-1 is not offered here at
 * all.
 *
 * Every registered certificate is tried, so a service provider rotating its
 * signing key can register both for the overlap. `certificates` being empty
 * verifies nothing and returns false — the caller has already refused that
 * case with a clearer message, and this is the backstop.
 */
export function verifyRedirectSignature(input: {
  rawQuery: string;
  signature: string;
  sigAlg: string;
  certificates: string[];
}): boolean {
  if (input.certificates.length === 0) return false;

  const digest =
    input.sigAlg === RSA_SHA256
      ? 'RSA-SHA256'
      : input.sigAlg === RSA_SHA512
        ? 'RSA-SHA512'
        : null;
  if (digest === null) return false;

  const signature = Buffer.from(input.signature, 'base64');
  if (signature.length === 0) return false;

  return input.certificates.some((certificate) => {
    try {
      return createVerify(digest)
        .update(input.rawQuery)
        .verify(certificate, signature);
    } catch {
      return false;
    }
  });
}
```

- [ ] **Step 4: Run the protocol tests**

Run: `pnpm vitest run packages/protocols/src/saml/saml-redirect.test.ts`
Expected: PASS, all nine cases.

**Why these tests are not degenerate.** The swap case alters the *ACS URL inside the request* rather than flipping a byte in the signature, which is the actual attack and which a verifier comparing the wrong bytes would still accept. The SigAlg case includes the SHA-1 algorithm URI explicitly, so an implementation that quietly supports it fails. The multi-certificate case puts the wrong certificate first, so an implementation that tries only the first entry fails.

- [ ] **Step 5: Add `signedRedirectQuery` and `GET /sso` to `saml-idp.ts`**

Add the import and the helper at module scope, beside `AUTHN_CONTEXT`:

```ts
import {
  decodeRedirectMessage,
  verifyRedirectSignature,
} from '@syntra/protocols';

/**
 * The raw query substring an HTTP-Redirect signature covers.
 *
 * Lifted out of `request.raw.url` rather than rebuilt from `request.query`,
 * because the signature is over the sender's exact bytes: their
 * percent-encoding, their parameter order, and only the parameters the
 * standard names — `SAMLRequest` (or `SAMLResponse`), then `RelayState` if it
 * is present, then `SigAlg`, in that order and no other. Re-encoding a parsed
 * object produces different bytes and every legitimately signed request fails.
 *
 * `RelayState` is included only when it actually appears, because the sender
 * signed what it sent: adding an empty one changes the bytes.
 *
 * Exported so Task 9's single-logout handler can call it for `SAMLResponse`.
 */
export function signedRedirectQuery(
  rawUrl: string,
  parameter: 'SAMLRequest' | 'SAMLResponse',
): string {
  const start = rawUrl.indexOf('?');
  const query = start < 0 ? '' : rawUrl.slice(start + 1);

  const take = (name: string): string | null => {
    const match = query.match(new RegExp(`(?:^|&)(${name}=[^&]*)`));
    return match ? match[1]! : null;
  };

  const message = take(parameter);
  const sigAlg = take('SigAlg');
  if (message === null || sigAlg === null) {
    throw new ProblemError(400, 'saml-bad-request', 'Malformed SAML request');
  }

  const relayState = take('RelayState');
  return relayState === null
    ? `${message}&${sigAlg}`
    : `${message}&${relayState}&${sigAlg}`;
}
```

And the route, beside `app.post('/sso', ...)`:

```ts
  app.get('/sso', rateLimited, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const encoded = query.SAMLRequest;
    if (typeof encoded !== 'string' || encoded === '') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = decodeRedirectMessage(encoded);

    return beginSso(request, reply, {
      xml,
      relayState: typeof query.RelayState === 'string' ? query.RelayState : null,
      // The detached signature authenticates the query string, not the
      // document, so there are no verified bytes to re-parse — hence `''`
      // rather than the XML. `beginSso` keeps its already-parsed request in
      // that case, which is correct here and only here: the signature covered
      // the encoded form of exactly that document.
      verify: (config) => {
        const signature = query.Signature;
        const sigAlg = query.SigAlg;
        if (typeof signature !== 'string' || typeof sigAlg !== 'string') return null;
        const ok = verifyRedirectSignature({
          rawQuery: signedRedirectQuery(request.raw.url ?? '', 'SAMLRequest'),
          signature,
          sigAlg,
          certificates: config.spCertificates,
        });
        return ok ? '' : null;
      },
    });
  });
```

- [ ] **Step 6: Write the route test**

Create `apps/api/src/routes/saml-sso-redirect.test.ts`. It imports the fixture helpers Task 7 exported, so the two suites cannot drift apart on what a valid request looks like.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createSign } from 'node:crypto';
import pkg from '@node-saml/node-saml';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  createApplication,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertSamlConfig,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import {
  ACS, SP, authnRequest, extractResponse, samlConfig, spPrivatePem, spPublicPem,
} from './saml-sso-post.test.js';

const { SAML } = pkg;
const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let applicationId: string;
let cookie: string;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  applicationId = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, {
      name: 'CRM', slug: 'crm', type: 'saml',
    });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    await upsertSamlConfig(tx, application.id, samlConfig());
    return application.id;
  });

  const login = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const encode = (xml: string) => deflateRawSync(Buffer.from(xml)).toString('base64');
const sign = (rawQuery: string) =>
  createSign('RSA-SHA256').update(rawQuery).sign(spPrivatePem).toString('base64');

const get = (url: string, withCookie = true) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

const redirectUrl = (xml: string, relayState?: string) =>
  `/saml/sso?SAMLRequest=${encodeURIComponent(encode(xml))}` +
  (relayState === undefined ? '' : `&RelayState=${encodeURIComponent(relayState)}`);

describe('SAML single sign-on over HTTP-Redirect', () => {
  it('issues an assertion a real service provider validates', async () => {
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="${ACS}"`);

    const metadata = await get('/saml/metadata', false);
    const certificate = `-----BEGIN CERTIFICATE-----\n${
      metadata.body.match(/<ds:X509Certificate>([^<]+)</)![1]!
    }\n-----END CERTIFICATE-----`;

    const sp = new SAML({
      idpCert: certificate,
      issuer: SP, callbackUrl: ACS, audience: SP,
      wantAuthnResponseSigned: false, wantAssertionsSigned: true,
      validateInResponseTo: 'never' as never, acceptedClockSkewMs: 5000,
    });
    const { profile } = await sp.validatePostResponseAsync({
      SAMLResponse: extractResponse(res.body),
    });
    expect(profile!.nameID).toBe('j@acme.test');
  });

  it('answers a redirect-binding request with a POST-binding response', async () => {
    // The binding of the request does not decide the binding of the response;
    // the ACS entry does, and a Response is far too large for a URL.
    const res = await get(redirectUrl(authnRequest()));
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('method="post"');
  });

  it('refuses an ACS URL that is not on the allowlist and issues nothing', async () => {
    const res = await get(redirectUrl(authnRequest({ acs: 'https://attacker.test/acs' })));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('refuses a decompression bomb', async () => {
    const bomb = deflateRawSync(Buffer.alloc(30 * 1024 * 1024, 0x20)).toString('base64');
    const res = await get(`/saml/sso?SAMLRequest=${encodeURIComponent(bomb)}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('accepts a correctly signed request and refuses the same signature over a different one', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );

    const good = encode(authnRequest());
    const signedQuery = `SAMLRequest=${encodeURIComponent(good)}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const signature = sign(signedQuery);

    // Positive path first, so a verifier that rejects everything fails here.
    const ok = await get(`/saml/sso?${signedQuery}&Signature=${encodeURIComponent(signature)}`);
    expect(ok.statusCode).toBe(200);

    // The attack: same signature, different request, attacker's ACS URL.
    const swapped = encode(authnRequest({ acs: 'https://attacker.test/acs' }));
    const bad = await get(
      `/saml/sso?SAMLRequest=${encodeURIComponent(swapped)}&SigAlg=${encodeURIComponent(SIG_ALG)}&Signature=${encodeURIComponent(signature)}`,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('SAMLResponse');
  });

  it('includes RelayState in the signed bytes only when it was sent', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const request = encodeURIComponent(encode(authnRequest()));
    const withRelay = `SAMLRequest=${request}&RelayState=${encodeURIComponent('deep/link')}&SigAlg=${encodeURIComponent(SIG_ALG)}`;

    const ok = await get(`/saml/sso?${withRelay}&Signature=${encodeURIComponent(sign(withRelay))}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('name="RelayState" value="deep/link"');

    // A signature computed WITHOUT the relay state must not authenticate a
    // request that carries one — that is how an attacker injects a landing
    // page into somebody else's signed sign-in.
    const withoutRelay = `SAMLRequest=${request}&SigAlg=${encodeURIComponent(SIG_ALG)}`;
    const mismatched = await get(
      `/saml/sso?SAMLRequest=${request}&RelayState=${encodeURIComponent('https://attacker.test')}&SigAlg=${encodeURIComponent(SIG_ALG)}&Signature=${encodeURIComponent(sign(withoutRelay))}`,
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.body).not.toContain('SAMLResponse');
  });

  it('refuses a signed-request application when no Signature is present at all', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, samlConfig({
        spCertificates: [spPublicPem], wantAuthnRequestsSigned: true,
      })),
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('challenges rather than issuing when policy demands a second factor', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'mfa for crm', outcome: 'require_mfa', applicationIds: [applicationId] }),
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('issues nothing when policy denies', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );
    const res = await get(redirectUrl(authnRequest()));
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SAMLResponse');
  });

  it('refuses when the request arrives on a sibling of the tenant host', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: redirectUrl(authnRequest()),
      headers: {
        host: `${TEST_HOST}.attacker.example`,
        cookie: `syntra_session=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(421);
  });
});
```

- [ ] **Step 7: Run the route tests**

Run: `pnpm vitest run apps/api/src/routes/saml-sso-redirect.test.ts`
Expected: PASS, all ten cases.

**Why these tests are not degenerate.** The RelayState case is the one a naive `signedRedirectQuery` fails: an implementation that always appends `RelayState=` — or that always omits it — passes the plain signed case and fails one half of this one. The swap case is the real attack rather than a corrupted signature. Both signature cases assert the positive path first, so a verifier that refuses everything cannot pass them.

- [ ] **Step 8: Commit**

```bash
git add packages/protocols/src/saml/authn-request.ts packages/protocols/src/saml/saml-redirect.test.ts apps/api/src/routes/saml-idp.ts apps/api/src/routes/saml-sso-redirect.test.ts
git commit -m "feat(saml): HTTP-Redirect binding with the detached query signature"
```

---

## Task 9: IdP-initiated SSO, assertion encryption, and single logout

**Files:**
- Create: `packages/protocols/src/saml/encrypt.ts`
- Create: `packages/protocols/src/saml/logout.ts`
- Create: `packages/protocols/src/saml/saml-logout.test.ts`
- Modify: `apps/api/src/routes/saml-idp.ts` (add `/start/:applicationId`, and `/slo` on both bindings)
- Create: `apps/api/src/routes/saml-slo.test.ts`
- Modify: `packages/protocols/src/index.ts`, `packages/protocols/package.json`

**Interfaces:**
- Consumes: everything from Task 7; `revokeSession`, `resolveSession`, `listSsoSessionsForSession`, `endSsoSessions`, `findApplication`, `findSamlConfigForApplication`.
- Produces:
  ```ts
  export function encryptAssertion(signedAssertion: string, certificatePem: string): Promise<string>;
  export interface IncomingLogoutRequest { id: string; issuer: string; nameId: string; sessionIndex: string | null; destination: string | null }
  export function parseLogoutRequest(xml: string): IncomingLogoutRequest;
  export function buildLogoutRequest(input: { idpEntityId: string; destination: string; nameId: string; nameIdFormat: string; sessionIndex: string; now: Date }): { id: string; xml: string };
  export function buildLogoutResponse(input: { idpEntityId: string; destination: string; inResponseTo: string; success: boolean; now: Date }): string;
  export function logoutPostForm(input: { destination: string; field: 'SAMLRequest' | 'SAMLResponse'; xml: string; relayState: string | null }): string;
  ```

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @syntra/protocols add xml-encryption@6.0.0
pnpm --filter @syntra/protocols add -D @types/xml-encryption@1.2.4
```

- [ ] **Step 2: Write the failing tests**

Create `packages/protocols/src/saml/saml-logout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import xmlenc from 'xml-encryption';
import { encryptAssertion } from './encrypt.js';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  parseLogoutRequest,
} from './logout.js';
import { parseXml, selectElements } from '../xml/parse.js';

const IDP = 'https://sso.acme.test/saml/idp';

describe('encryptAssertion', () => {
  it('produces an EncryptedAssertion the holder of the private key can open again', async () => {
    // A certificate is what an SP publishes; xml-encryption takes the public
    // key out of it. A bare SPKI PEM works the same way for this test.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const assertion = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_1"><saml:Issuer>x</saml:Issuer></saml:Assertion>';

    const encrypted = await encryptAssertion(
      assertion,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );

    const doc = parseXml(`<r xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encrypted}</r>`);
    expect(selectElements(doc, "//*[local-name(.)='EncryptedAssertion']")).toHaveLength(1);
    // And there is no cleartext assertion left anywhere in it.
    expect(encrypted).not.toContain('<saml:Issuer>x</saml:Issuer>');

    const [encryptedData] = selectElements(doc, "//*[local-name(.)='EncryptedData']");
    const back = await new Promise<string>((resolve, reject) =>
      xmlenc.decrypt(
        encryptedData!.toString(),
        { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
        (err, result) => (err ? reject(err) : resolve(result)),
      ),
    );
    expect(back).toContain('<saml:Issuer>x</saml:Issuer>');
  });

  it('uses AES-256-GCM and RSA-OAEP, not CBC or PKCS#1 v1.5', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encrypted = await encryptAssertion(
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_1"/>',
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    // CBC without an authenticated mode is the padding-oracle shape that has
    // produced real SAML decryption attacks, and rsa-1_5 is Bleichenbacher.
    expect(encrypted).toContain('http://www.w3.org/2009/xmlenc11#aes256-gcm');
    expect(encrypted).toContain('http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p');
    expect(encrypted).not.toContain('aes256-cbc');
    expect(encrypted).not.toContain('xmlenc#rsa-1_5');
  });
});

describe('logout messages', () => {
  it('parses a LogoutRequest', () => {
    const xml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${IDP}"><saml:Issuer>https://sp.example.test/metadata</saml:Issuer><saml:NameID>j@acme.test</saml:NameID><samlp:SessionIndex>_si1</samlp:SessionIndex></samlp:LogoutRequest>`;
    const parsed = parseLogoutRequest(xml);
    expect(parsed).toMatchObject({
      id: '_lr1',
      issuer: 'https://sp.example.test/metadata',
      nameId: 'j@acme.test',
      sessionIndex: '_si1',
    });
  });

  it('refuses a document that is not a LogoutRequest', () => {
    expect(() =>
      parseLogoutRequest('<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_1"/>'),
    ).toThrow(/LogoutRequest/);
  });

  it('builds a LogoutRequest and a LogoutResponse that parse and carry the right ids', () => {
    const { id, xml } = buildLogoutRequest({
      idpEntityId: IDP,
      destination: 'https://sp.example.test/slo',
      nameId: 'j@acme.test',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      sessionIndex: '_si1',
      now: new Date(),
    });
    expect(id).toMatch(/^_/);
    expect(parseLogoutRequest(xml).nameId).toBe('j@acme.test');

    const response = buildLogoutResponse({
      idpEntityId: IDP,
      destination: 'https://sp.example.test/slo',
      inResponseTo: '_lr1',
      success: true,
      now: new Date(),
    });
    const doc = parseXml(response);
    expect(doc.documentElement!.getAttribute('InResponseTo')).toBe('_lr1');
    expect(
      selectElements(doc, "//*[local-name(.)='StatusCode']")[0]!.getAttribute('Value'),
    ).toBe('urn:oasis:names:tc:SAML:2.0:status:Success');
  });

  it('escapes a hostile NameID rather than letting it close the element', () => {
    const { xml } = buildLogoutRequest({
      idpEntityId: IDP,
      destination: 'https://sp.example.test/slo',
      nameId: '</saml:NameID><evil/>',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      sessionIndex: '_si1',
      now: new Date(),
    });
    expect(xml).not.toContain('<evil/>');
    expect(parseLogoutRequest(xml).nameId).toBe('</saml:NameID><evil/>');
  });
});
```

- [ ] **Step 3: Write `encrypt.ts`**

```ts
import xmlenc from 'xml-encryption';

/**
 * Wraps a signed assertion in an EncryptedAssertion.
 *
 * AES-256-GCM for the content and RSA-OAEP for the key. Neither choice is
 * negotiable and neither is configurable: CBC without an authenticated mode
 * is the shape that produced real padding-oracle attacks against SAML
 * decryption, and `rsa-1_5` is Bleichenbacher. A tenant that needs a legacy
 * SP to work needs a different SP.
 *
 * The assertion is signed *before* it is encrypted, so the SP verifies the
 * signature on what it decrypts. Encrypting first and signing the ciphertext
 * would authenticate the envelope and not the claim.
 *
 * `xml-encryption` is callback-style; this is the promise wrapper. It runs
 * outside every transaction — it is RSA work, and Global Constraint 1 applies.
 */
export async function encryptAssertion(
  signedAssertion: string,
  certificatePem: string,
): Promise<string> {
  const encryptedData = await new Promise<string>((resolve, reject) => {
    xmlenc.encrypt(
      signedAssertion,
      {
        rsa_pub: certificatePem,
        pem: certificatePem,
        encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: true,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });

  return `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encryptedData}</saml:EncryptedAssertion>`;
}
```

- [ ] **Step 4: Write `logout.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { xmlAttr, xmlText } from '../xml/escape.js';
import { parseXml, selectElements } from '../xml/parse.js';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${randomUUID()}`;

export interface IncomingLogoutRequest {
  id: string;
  issuer: string;
  nameId: string;
  sessionIndex: string | null;
  destination: string | null;
}

export function parseLogoutRequest(xml: string): IncomingLogoutRequest {
  const doc = parseXml(xml);
  const root = doc.documentElement!;
  if (root.localName !== 'LogoutRequest') {
    throw new Error(`expected a LogoutRequest, got ${root.localName}`);
  }
  const id = root.getAttribute('ID') ?? '';
  if (id === '') throw new Error('LogoutRequest has no ID');

  const [issuerNode] = selectElements(root, "./*[local-name(.)='Issuer']");
  const [nameIdNode] = selectElements(root, "./*[local-name(.)='NameID']");
  const [indexNode] = selectElements(root, "./*[local-name(.)='SessionIndex']");

  const issuer = (issuerNode?.textContent ?? '').trim();
  const nameId = (nameIdNode?.textContent ?? '').trim();
  if (issuer === '') throw new Error('LogoutRequest has no Issuer');
  if (nameId === '') throw new Error('LogoutRequest has no NameID');

  return {
    id,
    issuer,
    nameId,
    sessionIndex: (indexNode?.textContent ?? '').trim() || null,
    destination: root.getAttribute('Destination'),
  };
}

export function buildLogoutRequest(input: {
  idpEntityId: string;
  destination: string;
  nameId: string;
  nameIdFormat: string;
  sessionIndex: string;
  now: Date;
}): { id: string; xml: string } {
  const id = newId();
  return {
    id,
    xml:
      `<samlp:LogoutRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0" IssueInstant="${instant(
        input.now,
      )}" Destination="${xmlAttr(input.destination)}">` +
      `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
      `<saml:NameID Format="${xmlAttr(input.nameIdFormat)}">${xmlText(input.nameId)}</saml:NameID>` +
      `<samlp:SessionIndex>${xmlText(input.sessionIndex)}</samlp:SessionIndex>` +
      `</samlp:LogoutRequest>`,
  };
}

export function buildLogoutResponse(input: {
  idpEntityId: string;
  destination: string;
  inResponseTo: string;
  success: boolean;
  now: Date;
}): string {
  const status = input.success
    ? 'urn:oasis:names:tc:SAML:2.0:status:Success'
    : 'urn:oasis:names:tc:SAML:2.0:status:Requester';
  return (
    `<samlp:LogoutResponse xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${newId()}" Version="2.0" IssueInstant="${instant(
      input.now,
    )}" Destination="${xmlAttr(input.destination)}" InResponseTo="${xmlAttr(input.inResponseTo)}">` +
    `<saml:Issuer>${xmlText(input.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>` +
    `</samlp:LogoutResponse>`
  );
}

/** The auto-post form used for both logout directions on the POST binding. */
export function logoutPostForm(input: {
  destination: string;
  field: 'SAMLRequest' | 'SAMLResponse';
  xml: string;
  relayState: string | null;
}): string {
  const relay =
    input.relayState === null
      ? ''
      : `<input type="hidden" name="RelayState" value="${xmlAttr(input.relayState)}"/>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Signing you out</title></head>` +
    `<body onload="document.forms[0].submit()">` +
    `<form method="post" action="${xmlAttr(input.destination)}">` +
    `<input type="hidden" name="${input.field}" value="${xmlAttr(
      Buffer.from(input.xml, 'utf8').toString('base64'),
    )}"/>` +
    relay +
    `<noscript><button type="submit">Continue</button></noscript>` +
    `</form></body></html>`
  );
}
```

- [ ] **Step 5: Add the three routes to `saml-idp.ts`**

**IdP-initiated start.** The portal launches a SAML application by sending the browser here.

```ts
  /**
   * Identity-provider-initiated sign-on.
   *
   * There is no AuthnRequest, so there is no InResponseTo and nothing for the
   * service provider to correlate against. That is exactly why it is off by
   * default per application (`allowIdpInitiated`): an unsolicited response is
   * an assertion the SP cannot tie to a request its own user started, which is
   * the login-CSRF shape SAML's own security considerations warn about. A
   * tenant that needs it turns it on for the applications that support it.
   *
   * The parked row is created here with `requestId: null`, so the rest of the
   * flow — assignment check, authorize(), assertion — is byte-for-byte the
   * SP-initiated path.
   */
  // `idParam` comes from `@syntra/contracts`; add it to this file's imports.
  app.get('/start/:applicationId', rateLimited, async (request, reply) => {
    const { tenant, identity } = await samlContext(request, options);
    const { id: applicationId } = idParam.parse({ id: (request.params as { applicationId: string }).applicationId });

    const config = await request.db((tx) => findSamlConfigForApplication(tx, applicationId));
    if (!config) throw new ProblemError(404, 'saml-unknown-sp', 'Not a SAML application');
    if (!config.allowIdpInitiated) {
      throw new ProblemError(
        409, 'saml-idp-initiated-disabled',
        'This application only accepts sign-ins that start at the application itself.',
      );
    }

    const acsUrl = resolveAcsUrl(config, null);
    if (acsUrl === null) {
      throw new ProblemError(409, 'saml-no-acs', 'This application has no assertion consumer service URL');
    }

    const relayState =
      typeof (request.query as Record<string, unknown>).RelayState === 'string'
        ? ((request.query as Record<string, string>).RelayState)
        : null;

    const parked = await parkAuthnRequest(request.tenantId, {
      applicationId,
      requestId: null,
      acsUrl,
      relayState,
      forceAuthn: false,
    });
    return completeSso(request, reply, { tenant, identity, config, parked });
  });
```

**Encryption in `completeSso`.** After `buildSignedResponse`, replace the assertion when the SP asked for encryption. Insert this immediately before the `reply.type('text/html')` return, and send `deliverable` instead of `xml`:

```ts
    let deliverable = xml;
    if (ctx.config.encryptAssertions) {
      if (!ctx.config.encryptionCertificate) {
        throw new ProblemError(
          409, 'saml-no-encryption-certificate',
          'This application is configured to receive encrypted assertions but has no certificate registered',
        );
      }
      // Outside every transaction: RSA plus AES over the whole assertion.
      const assertion = xml.slice(
        xml.indexOf('<saml:Assertion'),
        xml.lastIndexOf('</saml:Assertion>') + '</saml:Assertion>'.length,
      );
      const encrypted = await encryptAssertion(assertion, ctx.config.encryptionCertificate);
      deliverable = xml.replace(assertion, encrypted);
    }
```

**Single logout.** Both directions on both bindings:

```ts
  const handleSlo = async (
    request: FastifyRequest,
    reply: FastifyReply,
    binding: 'HTTP-Redirect' | 'HTTP-POST',
  ) => {
    const { identity } = await samlContext(request, options);
    const source = (binding === 'HTTP-POST' ? request.body : request.query) as
      | Record<string, string | undefined>
      | undefined;

    // A LogoutResponse coming back from a service provider we notified. There
    // is nothing left to do; the session is already gone.
    if (typeof source?.SAMLResponse === 'string') {
      return reply.redirect('/logged-out', 302);
    }

    const encoded = source?.SAMLRequest;
    if (typeof encoded !== 'string') {
      throw new ProblemError(400, 'saml-bad-request', 'No SAMLRequest');
    }
    const xml = binding === 'HTTP-POST' ? decodePostMessage(encoded) : decodeRedirectMessage(encoded);
    const unverified = parseLogoutRequest(xml);

    const config = await request.db((tx) => findSamlConfigByEntityId(tx, unverified.issuer));
    if (!config) throw new ProblemError(404, 'saml-unknown-sp', 'Unknown service provider');

    // A logout request is destructive, so it is verified on exactly the same
    // terms as an authentication request. An SP that registered certificates
    // and asked for signed requests gets its signature checked; one that did
    // not is trusted only to end its own user's session, which is what it
    // could do by other means anyway.
    let trusted = unverified;
    if (config.wantAuthnRequestsSigned) {
      if (binding === 'HTTP-POST') {
        const signed = verifyPostSignature(xml, config.spCertificates);
        if (signed === null) {
          throw new ProblemError(400, 'saml-bad-signature', 'Invalid logout signature');
        }
        trusted = parseLogoutRequest(signed);
      } else {
        const rawQuery = signedRedirectQuery(request.raw.url ?? '', 'SAMLRequest');
        const q = request.query as Record<string, string | undefined>;
        if (
          typeof q.Signature !== 'string' || typeof q.SigAlg !== 'string' ||
          !verifyRedirectSignature({
            rawQuery, signature: q.Signature, sigAlg: q.SigAlg,
            certificates: config.spCertificates,
          })
        ) {
          throw new ProblemError(400, 'saml-bad-signature', 'Invalid logout signature');
        }
      }
    }

    // End the Syntra session and every SSO session it opened. Sessions are
    // found by the session index the assertion carried, never by the NameID
    // alone — a NameID is not a secret, and ending "every session for this
    // email address" on an unauthenticated request is a denial of service any
    // registered SP could aim at any user.
    const ended = await request.db(async (tx) => {
      const row = await tx.samlSsoSession.findFirst({
        where: {
          applicationId: config.applicationId,
          sessionIndex: trusted.sessionIndex ?? '__none__',
          endedAt: null,
        },
      });
      if (!row) return null;
      await endSsoSessions(tx, row.sessionId);
      await tx.session.updateMany({
        where: { id: row.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'saml.logout',
        targetType: 'Application',
        targetId: config.applicationId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { spEntityId: config.spEntityId, sessionIndex: trusted.sessionIndex },
      });
      return row;
    });

    reply.clearCookie(SESSION_COOKIE, { path: '/' });

    const destination = config.sloUrl;
    if (!destination) {
      // Nowhere to answer. The session is still gone, which is the part that
      // matters.
      return reply.redirect('/logged-out', 302);
    }

    const response = buildLogoutResponse({
      idpEntityId: identity.entityId,
      destination,
      inResponseTo: trusted.id,
      success: ended !== null,
      now: new Date(),
    });

    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(
      logoutPostForm({
        destination,
        field: 'SAMLResponse',
        xml: response,
        relayState: typeof source?.RelayState === 'string' ? source.RelayState : null,
      }),
    );
  };

  app.get('/slo', rateLimited, (request, reply) => handleSlo(request, reply, 'HTTP-Redirect'));
  app.post('/slo', rateLimited, (request, reply) => handleSlo(request, reply, 'HTTP-POST'));
```

- [ ] **Step 6: Write the route test**

Create `apps/api/src/routes/saml-slo.test.ts`. Import `ACS`, `SP`, `authnRequest`, `samlConfig` and `extractResponse` from `./saml-sso-post.test.js` (Task 7 exports them), copy that file's `beforeEach` block verbatim — it closes over module-level state, so it cannot be shared — and define the two local helpers this suite uses:

```ts
const get = (url: string, withCookie = true) =>
  ctx.app.inject({
    method: 'GET', url,
    headers: {
      host: TEST_HOST,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

const redirectUrl = (xml: string) =>
  `/saml/sso?SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString('base64'))}`;
```

Then:

```ts
describe('SAML single logout', () => {
  it('ends the Syntra session named by the session index, and answers the service provider', async () => {
    const sso = await get(redirectUrl(authnRequest()));
    expect(sso.statusCode).toBe(200);

    const { sessionIndex, sessionId } = await withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.samlSsoSession.findFirstOrThrow();
      return { sessionIndex: row.sessionIndex, sessionId: row.sessionId };
    });

    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, {
        spEntityId: SP, acsUrls: [ACS], defaultAcsUrl: ACS, acsBinding: 'HTTP-POST',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null, spCertificates: [], wantAuthnRequestsSigned: false,
        encryptAssertions: false, encryptionCertificate: null,
        sloUrl: 'https://sp.example.test/slo', sloBinding: 'HTTP-POST',
        allowIdpInitiated: false, assertionLifetimeMs: 300_000,
      }),
    );

    const logoutXml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${SP}</saml:Issuer><saml:NameID>j@acme.test</saml:NameID><samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex></samlp:LogoutRequest>`;

    const res = await get(
      `/saml/slo?SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(logoutXml)).toString('base64'))}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="SAMLResponse"');
    expect(res.body).toContain('action="https://sp.example.test/slo"');

    const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.revokedAt).not.toBeNull();

    // And the session really is unusable, not merely marked.
    const after = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('does not end a session when the session index does not match', async () => {
    await get(redirectUrl(authnRequest()));
    const logoutXml = `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${SP}</saml:Issuer><saml:NameID>j@acme.test</saml:NameID><samlp:SessionIndex>_not_a_real_index</samlp:SessionIndex></samlp:LogoutRequest>`;
    await get(
      `/saml/slo?SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(logoutXml)).toString('base64'))}`,
    );
    // A NameID is not a secret. Ending every session for an email address on
    // an unauthenticated request would let any registered SP sign any user
    // out of everything.
    const still = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(still.statusCode).toBe(200);
  });

  it('refuses identity-provider-initiated sign-on unless the application allows it', async () => {
    const off = await get(`/saml/start/${applicationId}`);
    expect(off.statusCode).toBe(409);
    expect(off.body).not.toContain('SAMLResponse');

    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, {
        spEntityId: SP, acsUrls: [ACS], defaultAcsUrl: ACS, acsBinding: 'HTTP-POST',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null, spCertificates: [], wantAuthnRequestsSigned: false,
        encryptAssertions: false, encryptionCertificate: null, sloUrl: null,
        sloBinding: 'HTTP-POST', allowIdpInitiated: true, assertionLifetimeMs: 300_000,
      }),
    );

    const on = await get(`/saml/start/${applicationId}`);
    expect(on.statusCode).toBe(200);
    const xml = Buffer.from(extractResponse(on.body), 'base64').toString('utf8');
    // Unsolicited: no InResponseTo anywhere in the document.
    expect(xml).not.toContain('InResponseTo');
  });

  it('delivers an encrypted assertion when the application asks for one', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await withTenant(ctx.tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, {
        spEntityId: SP, acsUrls: [ACS], defaultAcsUrl: ACS, acsBinding: 'HTTP-POST',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null, spCertificates: [], wantAuthnRequestsSigned: false,
        encryptAssertions: true,
        encryptionCertificate: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        sloUrl: null, sloBinding: 'HTTP-POST', allowIdpInitiated: false,
        assertionLifetimeMs: 300_000,
      }),
    );
    const res = await get(redirectUrl(authnRequest()));
    const xml = Buffer.from(extractResponse(res.body), 'base64').toString('utf8');
    expect(xml).toContain('EncryptedAssertion');
    // The subject must not be readable in the delivered document.
    expect(xml).not.toContain('j@acme.test');
  });
});
```

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run packages/protocols/src/saml apps/api/src/routes/saml-slo.test.ts apps/api/src/routes/saml-sso-post.test.ts apps/api/src/routes/saml-sso-redirect.test.ts`
Expected: PASS.

**Why these tests are not degenerate:** the logout test asserts the session is unusable by making a real authenticated request afterwards, not merely that `revokedAt` is set — a revocation the session reader ignores would pass the column check and fail this one. The mismatched-session-index test asserts the *opposite* direction, so an implementation that ended sessions by NameID passes the first test and fails this one. The encryption test asserts the plaintext subject is absent from the delivered document, which fails for an implementation that wrapped the assertion but left the original beside it.

- [ ] **Step 8: Commit**

```bash
git add packages/protocols/src/saml apps/api/src/routes/saml-idp.ts apps/api/src/routes/saml-slo.test.ts packages/protocols/package.json pnpm-lock.yaml
git commit -m "feat(saml): IdP-initiated flow, GCM assertion encryption, single logout"
```

---

## Task 10: The OIDC provider — client registry, storage adapter, and the prompt that forces every request through `authorize()`

**Files:**
- Create: `packages/core/src/access/oidc-client-service.ts`
- Create: `packages/core/src/access/oidc-store.ts`
- Create: `packages/core/src/access/oidc-store.test.ts`
- Create: `packages/protocols/src/oidc/adapter.ts`
- Create: `packages/protocols/src/oidc/interaction-prompt.ts`
- Create: `packages/protocols/src/oidc/provider-factory.ts`
- Create: `packages/protocols/src/oidc/provider-factory.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/protocols/src/index.ts`

**Interfaces:**
- Consumes: `withTenant` (`@syntra/db`); `collectSubjectFacts`, `resolveClaims`, `listClaimMappings` (Task 4); `publishedKeys`, `loadActiveKey` (Task 3); `matchesAllowlist` (`@syntra/contracts`).
- Produces:
  ```ts
  // @syntra/core
  export interface OidcClientRecord {
    id: string; applicationId: string; clientId: string; redirectUris: string[];
    postLogoutRedirectUris: string[]; grantTypes: string[]; scopes: string[];
    requirePkce: boolean; clientCredentialsEnabled: boolean;
    tokenEndpointAuthMethod: string;
    idTokenSignedResponseAlg: string; accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  }
  export function upsertOidcClient(tx, applicationId: string, input: Omit<OidcClientRecord,'id'|'applicationId'> & { clientSecret?: string }): Promise<{ record: OidcClientRecord; clientSecret: string | null }>;
  export function listOidcClients(tenantId: string): Promise<OidcClientRecord[]>;
  export function findOidcClient(tenantId: string, clientId: string): Promise<OidcClientRecord | null>;
  export function verifyClientSecret(tenantId: string, clientId: string, presented: string): Promise<boolean>;
  export function hashClientSecret(secret: string): string;

  export interface StoredArtifact { payload: Record<string, unknown>; consumedAt: Date | null }
  export function artifactUpsert(tenantId: string, model: string, id: string, payload: Record<string, unknown>, expiresIn: number | undefined): Promise<void>;
  export function artifactFind(tenantId: string, model: string, id: string): Promise<StoredArtifact | null>;
  export function artifactFindByUid(tenantId: string, model: string, uid: string): Promise<StoredArtifact | null>;
  export function artifactFindByUserCode(tenantId: string, model: string, userCode: string): Promise<StoredArtifact | null>;
  export function artifactConsume(tenantId: string, model: string, id: string): Promise<void>;
  export function artifactDestroy(tenantId: string, model: string, id: string): Promise<void>;
  export function artifactRevokeByGrantId(tenantId: string, grantId: string): Promise<void>;

  // @syntra/protocols
  export function makeAdapterFactory(tenantId: string): (name: string) => Adapter;
  export function syntraAuthorizePrompt(): Prompt;
  export interface ProviderDeps { findAccount: ...; loadClient: ...; jwks: ...; interactionUrl: (uid: string) => string }
  export function providerFor(tenantId: string, issuer: string, deps: ProviderDeps): Promise<Provider>;
  export function invalidateProvider(tenantId: string): void;
  ```

- [ ] **Step 1: Write the failing storage test**

Create `packages/core/src/access/oidc-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  artifactConsume,
  artifactDestroy,
  artifactFind,
  artifactFindByUid,
  artifactRevokeByGrantId,
  artifactUpsert,
} from './oidc-store.js';

let tenantId: string;
let otherTenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
});

describe('oidc artifact store', () => {
  it('round-trips a payload', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'tok1', { accountId: 'u1', scope: 'openid' }, 3600);
    const found = await artifactFind(tenantId, 'AccessToken', 'tok1');
    expect(found?.payload).toMatchObject({ accountId: 'u1', scope: 'openid' });
  });

  it('finds a session by its uid', async () => {
    await artifactUpsert(tenantId, 'Session', 's1', { uid: 'u-abc', accountId: 'u1' }, 3600);
    const found = await artifactFindByUid(tenantId, 'Session', 'u-abc');
    expect(found?.payload).toMatchObject({ accountId: 'u1' });
  });

  it('returns null for an expired artifact rather than a stale payload', async () => {
    await artifactUpsert(tenantId, 'AuthorizationCode', 'c1', { accountId: 'u1' }, -1);
    expect(await artifactFind(tenantId, 'AuthorizationCode', 'c1')).toBeNull();
  });

  it('records consumption without destroying the row, so a replayed code is detectable', async () => {
    await artifactUpsert(tenantId, 'AuthorizationCode', 'c2', { accountId: 'u1' }, 600);
    await artifactConsume(tenantId, 'AuthorizationCode', 'c2');
    const found = await artifactFind(tenantId, 'AuthorizationCode', 'c2');
    // oidc-provider reads `consumed` off the payload it gets back and refuses
    // the second exchange itself. Deleting the row here would make a replayed
    // code look merely unknown, and the replay would go unlogged.
    expect(found).not.toBeNull();
    expect(found!.consumedAt).not.toBeNull();
  });

  it('destroys a single artifact', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'tok2', {}, 3600);
    await artifactDestroy(tenantId, 'AccessToken', 'tok2');
    expect(await artifactFind(tenantId, 'AccessToken', 'tok2')).toBeNull();
  });

  it('revokes every artifact of a grant at once', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'a', { grantId: 'g1' }, 3600);
    await artifactUpsert(tenantId, 'RefreshToken', 'r', { grantId: 'g1' }, 3600);
    await artifactUpsert(tenantId, 'AccessToken', 'b', { grantId: 'g2' }, 3600);
    await artifactRevokeByGrantId(tenantId, 'g1');
    expect(await artifactFind(tenantId, 'AccessToken', 'a')).toBeNull();
    expect(await artifactFind(tenantId, 'RefreshToken', 'r')).toBeNull();
    expect(await artifactFind(tenantId, 'AccessToken', 'b')).not.toBeNull();
  });

  it('cannot see another tenant artifact under the same id', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'shared-id', { accountId: 'acme-user' }, 3600);
    await artifactUpsert(otherTenantId, 'AccessToken', 'shared-id', { accountId: 'beta-user' }, 3600);
    // Identical artifact ids in two tenants. A store that keyed on id alone
    // would hand one tenant the other's token.
    expect((await artifactFind(tenantId, 'AccessToken', 'shared-id'))!.payload)
      .toMatchObject({ accountId: 'acme-user' });
    expect((await artifactFind(otherTenantId, 'AccessToken', 'shared-id'))!.payload)
      .toMatchObject({ accountId: 'beta-user' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/core/src/access/oidc-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `oidc-store.ts`**

```ts
import { withTenant } from '@syntra/db';

export interface StoredArtifact {
  payload: Record<string, unknown>;
  consumedAt: Date | null;
}

/**
 * The storage `oidc-provider` writes through.
 *
 * Every function takes a tenantId and opens its own `withTenant`, because
 * `packages/protocols` may not import `@syntra/db` (spec section 5's package
 * boundary) and because `oidc-provider` constructs its adapter with a model
 * name and nothing else — there is no request context to carry a transaction
 * through. Tenancy is closed over by the adapter factory instead.
 *
 * These calls are all single indexed statements. None of them does crypto or
 * network work, so opening a transaction per call is cheap and Global
 * Constraint 1 is not in play.
 */

/**
 * Lifts the columns the schema indexes out of the payload.
 *
 * oidc-provider hands the adapter one opaque payload and separately expects
 * `findByUid`, `findByUserCode` and `revokeByGrantId` to work. Rather than
 * scanning JSON, the three keys it looks things up by are promoted to
 * columns; the payload remains the authority and these are a copy.
 */
function indexed(payload: Record<string, unknown>) {
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    uid: str(payload.uid),
    userCode: str(payload.userCode),
    grantId: str(payload.grantId),
    accountId: str(payload.accountId),
  };
}

export async function artifactUpsert(
  tenantId: string,
  model: string,
  id: string,
  payload: Record<string, unknown>,
  expiresIn: number | undefined,
): Promise<void> {
  const expiresAt =
    expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000);
  await withTenant(tenantId, async (tx) => {
    await tx.oidcArtifact.upsert({
      where: { tenantId_model_artifactId: { tenantId, model, artifactId: id } },
      create: { tenantId, model, artifactId: id, payload: payload as never, expiresAt, ...indexed(payload) },
      update: { payload: payload as never, expiresAt, ...indexed(payload) },
    });
  });
}

export async function artifactFind(
  tenantId: string,
  model: string,
  id: string,
): Promise<StoredArtifact | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.oidcArtifact.findFirst({ where: { model, artifactId: id } });
    if (!row) return null;
    // Expiry is enforced on read as well as by the sweeper, so a token whose
    // row has not been swept yet is still dead.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    return { payload: row.payload as Record<string, unknown>, consumedAt: row.consumedAt };
  });
}

const findBy = (column: 'uid' | 'userCode') =>
  async function find(
    tenantId: string,
    model: string,
    value: string,
  ): Promise<StoredArtifact | null> {
    return withTenant(tenantId, async (tx) => {
      const row = await tx.oidcArtifact.findFirst({
        where: { model, [column]: value } as never,
      });
      if (!row) return null;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
      return { payload: row.payload as Record<string, unknown>, consumedAt: row.consumedAt };
    });
  };

export const artifactFindByUid = findBy('uid');
export const artifactFindByUserCode = findBy('userCode');

/**
 * Marks an artifact consumed without deleting it.
 *
 * oidc-provider reads `consumed` off the payload and refuses a second
 * exchange itself. Deleting the row instead would turn a replayed
 * authorization code into an unknown code — the same 400 either way, but with
 * no record that a replay happened, and code replay is the signal that a
 * redirect leaked.
 */
export async function artifactConsume(
  tenantId: string,
  model: string,
  id: string,
): Promise<void> {
  const now = new Date();
  await withTenant(tenantId, async (tx) => {
    const row = await tx.oidcArtifact.findFirst({ where: { model, artifactId: id } });
    if (!row) return;
    const payload = { ...(row.payload as Record<string, unknown>), consumed: Math.floor(now.getTime() / 1000) };
    await tx.oidcArtifact.update({
      where: { id: row.id },
      data: { consumedAt: now, payload: payload as never },
    });
  });
}

export async function artifactDestroy(
  tenantId: string,
  model: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.oidcArtifact.deleteMany({ where: { model, artifactId: id } });
  });
}

/**
 * Every artifact of one grant, gone at once. This is what makes a revoked
 * consent actually revoke the access and refresh tokens issued under it.
 */
export async function artifactRevokeByGrantId(
  tenantId: string,
  grantId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.oidcArtifact.deleteMany({ where: { grantId } });
  });
}

/** Housekeeping. Called by the scheduler; expiry is enforced on read anyway. */
export async function sweepExpiredArtifacts(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.oidcArtifact.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  });
}
```

- [ ] **Step 4: Write `oidc-client-service.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { matchesAllowlist } from '@syntra/contracts';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface OidcClientRecord {
  id: string;
  applicationId: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  requirePkce: boolean;
  /** See ruling A2-5. Off unless an administrator turned it on. */
  clientCredentialsEnabled: boolean;
  tokenEndpointAuthMethod: string;
  idTokenSignedResponseAlg: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

/**
 * SHA-256, deliberately not Argon2id.
 *
 * A client secret is 256 bits drawn from `randomBytes` — it is not a human
 * password and there is no dictionary to grind. A memory-hard KDF buys nothing
 * against a uniformly random 256-bit secret, and it costs something real: the
 * token endpoint verifies a secret on **every** token request, and Argon2id
 * there is both a latency floor on every client and, if anyone ever moved the
 * verification inside a transaction, a direct violation of Global Constraint
 * 1. The comparison below is constant-time so the hash is not a timing oracle.
 *
 * This reasoning does not transfer to `PasswordCredential`, which stays
 * Argon2id, because a human-chosen password is exactly the case a memory-hard
 * KDF exists for.
 */
export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const toRecord = (row: Record<string, unknown>): OidcClientRecord => ({
  id: row.id as string,
  applicationId: row.applicationId as string,
  clientId: row.clientId as string,
  redirectUris: row.redirectUris as string[],
  postLogoutRedirectUris: row.postLogoutRedirectUris as string[],
  grantTypes: row.grantTypes as string[],
  scopes: row.scopes as string[],
  requirePkce: row.requirePkce as boolean,
  clientCredentialsEnabled: row.clientCredentialsEnabled as boolean,
  tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as string,
  idTokenSignedResponseAlg: row.idTokenSignedResponseAlg as string,
  accessTokenTtlSeconds: row.accessTokenTtlSeconds as number,
  refreshTokenTtlSeconds: row.refreshTokenTtlSeconds as number,
});

/**
 * Creates or updates a client. A new secret is returned exactly once and never
 * again — spec section 12 says a secret, once written, is replaced rather than
 * read back.
 */
export async function upsertOidcClient(
  tx: TenantClient,
  applicationId: string,
  input: Omit<OidcClientRecord, 'id' | 'applicationId'> & { rotateSecret?: boolean },
): Promise<{ record: OidcClientRecord; clientSecret: string | null }> {
  const tenantId = await currentTenant(tx);
  const existing = await tx.oidcClient.findUnique({ where: { applicationId } });

  const clientSecret =
    !existing || input.rotateSecret ? randomBytes(32).toString('base64url') : null;

  const { rotateSecret: _ignored, ...fields } = input;
  const data = {
    ...fields,
    ...(clientSecret ? { clientSecretHash: hashClientSecret(clientSecret) } : {}),
  };

  const row = await tx.oidcClient.upsert({
    where: { applicationId },
    create: { tenantId, applicationId, ...data, clientSecretHash: hashClientSecret(clientSecret!) },
    update: data,
  });

  return { record: toRecord(row as unknown as Record<string, unknown>), clientSecret };
}

export async function findOidcClient(
  tenantId: string,
  clientId: string,
): Promise<OidcClientRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.oidcClient.findFirst({ where: { clientId } });
    return row ? toRecord(row as unknown as Record<string, unknown>) : null;
  });
}

export async function listOidcClients(tenantId: string): Promise<OidcClientRecord[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.oidcClient.findMany();
    return rows.map((row) => toRecord(row as unknown as Record<string, unknown>));
  });
}

/** Constant-time. A length mismatch is answered false without comparing. */
export async function verifyClientSecret(
  tenantId: string,
  clientId: string,
  presented: string,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.oidcClient.findFirst({ where: { clientId } });
    if (!row) return false;
    const expected = Buffer.from(row.clientSecretHash, 'utf8');
    const actual = Buffer.from(hashClientSecret(presented), 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  });
}

/**
 * Whether a redirect URI is registered for this client.
 *
 * Exact string equality, via `matchesAllowlist`. `oidc-provider` performs the
 * same check itself with the `redirect_uris` this service feeds it; this
 * function exists for the RP-initiated logout path and the admin API, so
 * there is exactly one answer to the question in the codebase.
 */
export function isRegisteredRedirectUri(
  client: OidcClientRecord,
  candidate: string,
): boolean {
  return matchesAllowlist(candidate, client.redirectUris);
}

export function isRegisteredPostLogoutUri(
  client: OidcClientRecord,
  candidate: string,
): boolean {
  return matchesAllowlist(candidate, client.postLogoutRedirectUris);
}
```

- [ ] **Step 5: Write the adapter and the forced prompt**

`packages/protocols/src/oidc/adapter.ts`:

```ts
import {
  artifactConsume,
  artifactDestroy,
  artifactFind,
  artifactFindByUid,
  artifactFindByUserCode,
  artifactRevokeByGrantId,
  artifactUpsert,
} from '@syntra/core';

/**
 * The shape `oidc-provider` calls. Typed structurally rather than imported
 * from `@types/oidc-provider` so this module does not depend on the provider
 * at all — it depends only on Syntra's store.
 */
export interface OidcAdapter {
  upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
  find(id: string): Promise<Record<string, unknown> | undefined>;
  findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined>;
  findByUid(uid: string): Promise<Record<string, unknown> | undefined>;
  consume(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  revokeByGrantId(grantId: string): Promise<void>;
}

/**
 * Builds the adapter constructor for one tenant.
 *
 * `oidc-provider` calls `new Adapter(modelName)` and gives the adapter no
 * further context — no request, no tenant, nothing (`lib/helpers/
 * initialize_adapter.js`). Tenancy therefore has to be closed over here, at
 * the point where a Provider instance is built for a tenant, which is the
 * same reason `provider-factory.ts` builds one Provider per tenant. An adapter
 * that read a tenant from ambient state would be one async context leak away
 * from handing one tenant's token to another.
 */
export function makeAdapterFactory(tenantId: string) {
  return class SyntraAdapter implements OidcAdapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: Record<string, unknown>, expiresIn: number) {
      await artifactUpsert(tenantId, this.model, id, payload, expiresIn);
    }

    async find(id: string) {
      const row = await artifactFind(tenantId, this.model, id);
      return row?.payload;
    }

    async findByUserCode(userCode: string) {
      const row = await artifactFindByUserCode(tenantId, this.model, userCode);
      return row?.payload;
    }

    async findByUid(uid: string) {
      const row = await artifactFindByUid(tenantId, this.model, uid);
      return row?.payload;
    }

    async consume(id: string) {
      await artifactConsume(tenantId, this.model, id);
    }

    async destroy(id: string) {
      await artifactDestroy(tenantId, this.model, id);
    }

    async revokeByGrantId(grantId: string) {
      await artifactRevokeByGrantId(tenantId, grantId);
    }
  };
}
```

`packages/protocols/src/oidc/interaction-prompt.ts`:

```ts
import { interactionPolicy } from 'oidc-provider';

const { Check, Prompt, base } = interactionPolicy;

/** Where the interaction route stamps its decision. */
export const SYNTRA_DECISION_KEY = 'syntraDecision';

/**
 * The prompt that makes spec section 7's chokepoint structural rather than
 * aspirational.
 *
 * `oidc-provider` keeps its own session cookie. Its built-in `login` prompt
 * returns `NO_NEED_TO_PROMPT` the moment `oidc.session.accountId` is set
 * (`lib/helpers/interaction_policy/prompts/login.js`), so without this the
 * *second* authorization request from any client — the same client, or a
 * different one — is answered straight out of that session and tokens are
 * issued without ever re-entering Syntra. Syntra's policy engine evaluates per
 * application, and a `require_mfa` rule scoped to one application would then
 * apply on the first launch of the day and never again.
 *
 * This check requests the prompt unless the *current* interaction was resolved
 * by Syntra's own interaction route, for this exact client. The route sets it
 * only after `authorize()` returned an allow, so:
 *
 *   every token oidc-provider issues  =>  an interaction was resolved
 *                                     =>  authorize() returned allow
 *
 * A test asserts the second authorization request still reaches the
 * interaction route. Deleting this prompt makes that test fail, which is the
 * only reason it is worth writing.
 */
export function syntraAuthorizePrompt() {
  return new Prompt(
    { name: 'syntra_authorize', requestable: false },
    (ctx) => ({ clientId: ctx.oidc.client?.clientId ?? null }),
    new Check(
      'syntra_decision_required',
      'Syntra must decide this authorization',
      (ctx) => {
        const decision = (ctx.oidc.result as Record<string, unknown> | undefined)?.[
          SYNTRA_DECISION_KEY
        ] as { clientId?: string } | undefined;
        if (decision && decision.clientId === ctx.oidc.client?.clientId) {
          return Check.NO_NEED_TO_PROMPT;
        }
        return Check.REQUEST_PROMPT;
      },
    ),
  );
}

/**
 * The interaction policy: Syntra's prompt first, then the stock login and
 * consent prompts.
 *
 * Ours goes first so the browser is sent to Syntra before oidc-provider has a
 * chance to decide the session is enough.
 */
export function syntraInteractionPolicy() {
  const policy = base();
  policy.add(syntraAuthorizePrompt(), 0);
  return policy;
}
```

- [ ] **Step 6: Write `provider-factory.ts`**

```ts
import Provider, { type Configuration } from 'oidc-provider';
import { makeAdapterFactory } from './adapter.js';
import { syntraInteractionPolicy } from './interaction-prompt.js';

export interface AccountClaims {
  accountId: string;
  claims: Record<string, unknown>;
}

export interface ProviderDeps {
  /** Reads the user and their mapped claims. Returns null if unknown. */
  findAccount(accountId: string, clientId: string | null): Promise<AccountClaims | null>;
  /** Every OIDC client this tenant has, in oidc-provider's metadata shape. */
  loadClients(): Promise<Record<string, unknown>[]>;
  /** The tenant's published JWKS: active key first, outgoing beside it. */
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
  /** Where an unresolved interaction sends the browser. */
  interactionUrl(uid: string): string;
  cookieKeys: string[];
}

const providers = new Map<string, Promise<Provider>>();

/** Drop a tenant's Provider after its clients, keys or domain change. */
export function invalidateProvider(tenantId: string): void {
  providers.delete(tenantId);
}

export function invalidateAllProviders(): void {
  providers.clear();
}

/**
 * One `Provider` per tenant, built lazily and cached.
 *
 * `new Provider(issuer, setup)` fixes the issuer at construction and asserts
 * it is a single web URI (`lib/provider.js:70-82`). Syntra serves many tenants
 * with their own hostnames, so a single shared Provider would have to publish
 * one issuer for all of them — and a relying party validates the `iss` claim
 * against the issuer it discovered, so that is not a cosmetic problem. One
 * instance per tenant is the adaptation, and the issuer handed in comes from
 * `tenantProtocolIdentity`, never from a request header.
 *
 * `clients` is loaded at construction because oidc-provider validates client
 * metadata once. Any change to a tenant's clients calls `invalidateProvider`,
 * so the next request rebuilds. That is why client administration is a write
 * that has a cache to invalidate rather than a read the provider does per
 * request.
 */
export async function providerFor(
  tenantId: string,
  issuer: string,
  deps: ProviderDeps,
): Promise<Provider> {
  const cached = providers.get(tenantId);
  if (cached) return cached;

  const built = (async () => {
    const [clients, jwks] = await Promise.all([deps.loadClients(), deps.jwks()]);

    const configuration: Configuration = {
      adapter: makeAdapterFactory(tenantId) as never,
      clients: clients as never,
      jwks: jwks as never,
      cookies: { keys: deps.cookieKeys },

      // The user store stays Syntra's. This callback is the only way
      // oidc-provider learns anything about a person.
      findAccount: async (ctx, sub) => {
        const account = await deps.findAccount(sub, ctx.oidc?.client?.clientId ?? null);
        if (!account) return undefined;
        return {
          accountId: account.accountId,
          async claims() {
            return { sub: account.accountId, ...account.claims };
          },
        };
      },

      interactions: {
        url: async (_ctx, interaction) => deps.interactionUrl(interaction.uid),
        policy: syntraInteractionPolicy(),
      },

      // PKCE for every client, not only public ones. oidc-provider's default
      // requires it when the client authenticates with 'none'
      // (lib/helpers/defaults.js:319); spec section 7 asks for the
      // authorization code flow with PKCE without qualification, and a
      // confidential client that omits it is still vulnerable to code
      // interception on a shared device.
      pkce: { required: () => true },

      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        introspection: { enabled: true },
        userinfo: { enabled: true },
        rpInitiatedLogout: {
          enabled: true,
          // Syntra's own session is ended by the logout route before
          // oidc-provider is handed control, so there is nothing to confirm.
          logoutSource: async (ctx, form) => {
            ctx.body = `<!doctype html><html><head><meta charset="utf-8"><title>Signing out</title></head><body onload="document.forms[0].submit()">${form}<noscript><button type="submit" form="op.logoutForm" name="logout" value="yes">Continue</button></noscript></body></html>`;
          },
        },
        clientCredentials: { enabled: true },
        resourceIndicators: { enabled: false },
      },

      // Consent is administrative here: an application a user is assigned is
      // one the organization has already decided they may use, and a consent
      // screen per launch is friction with no decision behind it. The grant
      // is created for whatever the client is registered for.
      loadExistingGrant: async (ctx) => {
        const grantId =
          (ctx.oidc.result?.consent as { grantId?: string } | undefined)?.grantId ??
          ctx.oidc.session?.grantIdFor(ctx.oidc.client!.clientId);
        if (grantId) return ctx.oidc.provider.Grant.find(grantId);

        const grant = new ctx.oidc.provider.Grant({
          clientId: ctx.oidc.client!.clientId,
          accountId: ctx.oidc.session!.accountId,
        });
        grant.addOIDCScope(ctx.oidc.params!.scope as string);
        await grant.save();
        return grant;
      },

      claims: {
        openid: ['sub'],
        email: ['email', 'email_verified'],
        profile: ['name', 'preferred_username', 'given_name', 'family_name', 'updated_at'],
      },

      // RS256 only. `none` is not an algorithm and HS256 with a client secret
      // invites the alg-confusion class of bug outright.
      enabledJWA: {
        idTokenSigningAlgValues: ['RS256'],
        userinfoSigningAlgValues: ['RS256'],
        requestObjectSigningAlgValues: ['RS256'],
      },

      ttl: {
        AccessToken: 3600,
        AuthorizationCode: 120,
        IdToken: 3600,
        RefreshToken: 1209600,
        Interaction: 900,
        Session: 43200,
        Grant: 1209600,
      },

      rotateRefreshToken: true,
    };

    const provider = new Provider(issuer, configuration);
    // Behind a TLS-terminating proxy the raw request looks like HTTP. Fastify
    // is already told what to trust via TRUST_PROXY; this tells Koa the same
    // thing, or every cookie oidc-provider sets is dropped as insecure.
    provider.proxy = true;
    return provider;
  })();

  providers.set(tenantId, built);
  try {
    return await built;
  } catch (error) {
    // A failed build must not be cached, or one bad client configuration
    // takes the tenant's OIDC offline until a restart.
    providers.delete(tenantId);
    throw error;
  }
}
```

- [ ] **Step 7: Write the factory test**

Create `packages/protocols/src/oidc/provider-factory.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { invalidateAllProviders, providerFor } from './provider-factory.js';
import { SYNTRA_DECISION_KEY, syntraAuthorizePrompt } from './interaction-prompt.js';

afterEach(() => invalidateAllProviders());

const deps = async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  void publicKey;
  return {
    findAccount: async () => ({ accountId: 'u1', claims: { email: 'j@acme.test' } }),
    loadClients: async () => [
      {
        client_id: 'crm',
        client_secret: 'not-used-here',
        redirect_uris: ['https://crm.acme.test/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    ],
    jwks: async () => ({ keys: [{ ...jwk, alg: 'RS256', use: 'sig' }] }),
    interactionUrl: (uid: string) => `/oidc/interaction/${uid}`,
    cookieKeys: ['k'.repeat(32)],
  };
};

describe('providerFor', () => {
  it('constructs with the issuer it is given and caches per tenant', async () => {
    const d = await deps();
    const a = await providerFor('t1', 'https://sso.acme.test/oidc', d);
    const again = await providerFor('t1', 'https://sso.acme.test/oidc', d);
    const other = await providerFor('t2', 'https://sso.beta.test/oidc', d);

    expect(a.issuer).toBe('https://sso.acme.test/oidc');
    expect(again).toBe(a);
    // Two tenants, two issuers, two instances. One shared Provider could
    // publish only one `iss`, and a relying party checks it.
    expect(other).not.toBe(a);
    expect(other.issuer).toBe('https://sso.beta.test/oidc');
  });

  it('refuses an issuer that is not a web URI rather than starting with a broken one', async () => {
    const d = await deps();
    await expect(providerFor('t3', 'not-a-url', d)).rejects.toThrow();
    // And a failed build is not cached, so fixing the configuration works
    // without a restart.
    await expect(providerFor('t3', 'https://ok.test/oidc', d)).resolves.toBeDefined();
  });
});

describe('syntraAuthorizePrompt', () => {
  const prompt = syntraAuthorizePrompt();
  const check = prompt.checks[0]!;

  const ctx = (result: unknown, clientId: string) =>
    ({ oidc: { result, client: { clientId } } }) as never;

  it('requests the prompt when no Syntra decision is present', () => {
    expect(check.check(ctx(undefined, 'crm'))).toBe(true);
    expect(check.check(ctx({}, 'crm'))).toBe(true);
  });

  it('requests the prompt when a decision names a different client', () => {
    // Otherwise one launch of a low-risk application would satisfy the
    // requirement for a high-risk one in the same browser session.
    expect(
      check.check(ctx({ [SYNTRA_DECISION_KEY]: { clientId: 'other' } }, 'crm')),
    ).toBe(true);
  });

  it('lets the request through only when this interaction carries a decision for this client', () => {
    expect(
      check.check(ctx({ [SYNTRA_DECISION_KEY]: { clientId: 'crm' } }, 'crm')),
    ).toBe(false);
  });

  it('is first in the policy, ahead of the built-in login prompt', () => {
    const { syntraInteractionPolicy } = require('./interaction-prompt.js');
    const policy = syntraInteractionPolicy();
    expect(policy[0]!.name).toBe('syntra_authorize');
    expect(policy.map((p: { name: string }) => p.name)).toContain('login');
  });
});
```

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run packages/core/src/access/oidc-store.test.ts packages/protocols/src/oidc/provider-factory.test.ts`
Expected: PASS.

**Why these tests are not degenerate.** The store's cross-tenant case writes the *same artifact id* into two tenants and asserts each reads its own — a store keyed on id alone passes every other case in the file and fails only this one. The prompt tests call `check.check` directly with the three states that matter, including the different-client state, which is the case an implementation that merely checked "was there any decision" would fail. The ordering test would catch someone appending the prompt after `login`, which silently restores the bypass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/access/oidc-store.ts packages/core/src/access/oidc-store.test.ts packages/core/src/access/oidc-client-service.ts packages/core/src/index.ts packages/protocols/src/oidc packages/protocols/src/index.ts
git commit -m "feat(oidc): tenant-scoped adapter, client registry, and the prompt that forces authorize()"
```

---

## Task 11: Mounting the OIDC provider — the mount adaptation, discovery, JWKS, and the interaction route

**Files:**
- Create: `apps/api/src/routes/oidc-op.ts`
- Create: `apps/api/src/routes/oidc-interaction.ts`
- Create: `packages/core/src/access/authorization-decision-service.ts`
- Create: `apps/api/src/routes/oidc-authorize.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/package.json`, `packages/core/src/index.ts`
- Modify: `packages/protocols/src/oidc/provider-factory.ts` (take the code TTL from the shared constant)

**Interfaces:**
- Consumes: `providerFor`, `invalidateProvider`, `SYNTRA_DECISION_KEY` (Task 10); `tenantProtocolIdentity`, `assertProtocolHost` (Task 2); `publishedKeys`, `ensureActiveKey`, `readSigningKeyPem` (Task 3); `collectSubjectFacts`, `resolveClaims`, `listClaimMappings` (Task 4); `listOidcClients` (Task 10); `authorize`, `resolveSession`, `isApplicationAssigned`, `recordEvent` from `@syntra/core`.
- Produces:
  ```ts
  // apps/api
  export interface OidcRouteOptions { publicUrl: string; masterKey: Buffer; sessionSecret: string; authRateLimitMax: number; authRateLimitTenantMax: number }
  export const OIDC_MOUNT: string;
  export function oidcProviderFor(request: FastifyRequest, options: OidcRouteOptions): Promise<Provider>;
  export function requestForProvider(raw: IncomingMessage, body: Buffer | null): IncomingMessage;
  export function registerOidcRoutes(app: FastifyInstance, options: OidcRouteOptions): Promise<void>;
  export function registerOidcInteractionRoutes(app: FastifyInstance, options: OidcRouteOptions): Promise<void>;

  // @syntra/core
  export const AUTHORIZATION_CODE_TTL_SECONDS: number;
  export function recordAuthorizationDecision(tenantId: string, input: { userId: string; clientId: string; interactionUid: string; satisfiedFactor: string | null }): Promise<void>;
  export function consumeAuthorizationDecision(tenantId: string, userId: string, clientId: string, now?: Date): Promise<boolean>;
  ```
- Produced for Task 12: `oidcProviderFor` and `requestForProvider`, which the token endpoint reuses unchanged, and the `AuthorizationDecision` rows this task's interaction route writes and Task 12's token endpoint spends.

### What this task deliberately stops short of

**The token endpoint does not work when this task is done, and its tests do not pretend otherwise.** Every case here stops at the authorization code arriving on the redirect URI. Exchanging that code needs client authentication against the stored SHA-256 hash, which `loadClients` cannot do — it hands `oidc-provider` a placeholder — and that, together with the second chokepoint control at the same endpoint, is Task 12's whole subject. Splitting there keeps the two halves separately reviewable, and means a reviewer of this task never has to hold the body-replay mechanics in mind while checking the mount adaptation.

### Two facts established by spike before this task was written

Both were reproduced against `oidc-provider@9.11.3` mounted in Fastify 5, and both are load-bearing enough that getting them wrong would have cost a day mid-task.

**1. `oidc-provider` must be handed a request whose path has the mount prefix removed, and whose `originalUrl` still has it.** Its router registers `/token`, `/auth`, `/jwks` and matches them against `ctx.path` (`lib/helpers/initialize_app.js`). Handing it `/oidc/auth` unchanged returns a bare Koa **404 for every OIDC route**. Separately, `ctx.oidc.urlFor` derives the mount path as `originalUrl.substring(0, originalUrl.indexOf(request.url))` (`lib/helpers/oidc_context.js:86`), so stripping the prefix without setting `originalUrl` publishes a discovery document advertising `http://host/token` — the prefix silently disappears from every URL a relying party consumes. Both halves are required; each alone is broken in a different direction.

**2. The catch-all must not parse the request body.** `oidc-provider` reads it from the raw stream itself. Fastify core parses only `application/json` and `text/plain`, so the `application/x-www-form-urlencoded` bodies these endpoints receive pass through untouched — provided nothing registers a parser for that type at the root. Task 12 introduces the one plugin that legitimately does, inside its own scope, and its boundary test asserts the separation directly.

- [ ] **Step 1: Add the shared TTL constant and the decision service**

Create `packages/core/src/access/authorization-decision-service.ts`:

```ts
import { withTenant } from '@syntra/db';

/**
 * How long an authorization code lives, and therefore how long the decision
 * behind it lives.
 *
 * One constant with two consumers — `provider-factory.ts` passes it as
 * `ttl.AuthorizationCode`, and this module uses it as the decision's lifetime
 * — because if the decision outlived the code there would be a window in
 * which a code obtained some other way could spend a decision left over from a
 * legitimate authorization that was never exchanged. Making them one value
 * makes that window exactly zero rather than "small".
 */
export const AUTHORIZATION_CODE_TTL_SECONDS = 120;

/**
 * Records that `authorize()` returned an allow for this user and this client.
 *
 * Written by the OIDC interaction route and by nothing else, immediately after
 * the chokepoint allows and immediately before the interaction is resolved.
 * The token endpoint requires and spends one; see `consumeAuthorizationDecision`.
 */
export async function recordAuthorizationDecision(
  tenantId: string,
  input: {
    userId: string;
    clientId: string;
    interactionUid: string;
    satisfiedFactor: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.authorizationDecision.create({
      data: {
        tenantId,
        userId: input.userId,
        clientId: input.clientId,
        interactionUid: input.interactionUid,
        satisfiedFactor: input.satisfiedFactor,
        expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
      },
    });
  });
}

/**
 * Spends one live decision for this user and client. False if there is none.
 *
 * Single-use, decided by the `updateMany` count rather than by a read followed
 * by a write, so two concurrent exchanges cannot both spend one decision.
 *
 * Two concurrent authorizations for the same user and client produce two
 * decisions and two codes, and the two exchanges take one each — they are
 * interchangeable, so which exchange gets which row does not matter.
 */
export async function consumeAuthorizationDecision(
  tenantId: string,
  userId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const candidate = await tx.authorizationDecision.findFirst({
      where: { userId, clientId, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return false;
    const claimed = await tx.authorizationDecision.updateMany({
      where: { id: candidate.id, consumedAt: null },
      data: { consumedAt: now },
    });
    return claimed.count === 1;
  });
}
```

Export it from `packages/core/src/index.ts`, and change `provider-factory.ts`'s `ttl` block so the two cannot drift:

```ts
import { AUTHORIZATION_CODE_TTL_SECONDS } from '@syntra/core';
// ...
      ttl: {
        AccessToken: 3600,
        // The same constant `AuthorizationDecision` uses for its own lifetime.
        AuthorizationCode: AUTHORIZATION_CODE_TTL_SECONDS,
        IdToken: 3600,
        RefreshToken: 1209600,
        Interaction: 900,
        Session: 43200,
        Grant: 1209600,
      },
```
- [ ] **Step 2: Write the failing authorization-endpoint test**

Create `apps/api/src/routes/oidc-authorize.test.ts`. It drives `openid-client` — a real relying party, as spec section 13 requires — against the running Fastify app through a fetch shim over `app.inject`, and stops at the code.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  createApplication,
  createClaimMapping,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertOidcClient,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const REDIRECT = 'https://crm.acme.test/cb';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let applicationId: string;
let clientSecret: string;
let cookie: string;

/**
 * openid-client speaks fetch; the app under test speaks app.inject. This is the
 * bridge, and it is deliberately faithful: it does not follow redirects, it
 * preserves the status, and it carries every header both ways. A shim that
 * quietly followed a 302 would hide the very hop this suite is about.
 */
const injectFetch = (): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const res = await ctx.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: {
        host: TEST_HOST,
        ...Object.fromEntries(new Headers(init?.headers).entries()),
      },
      ...(init?.body ? { payload: init.body as string } : {}),
    });
    return new Response(res.rawPayload, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  }) as typeof fetch;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  ({ userId, applicationId, clientSecret } = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, { name: 'CRM', slug: 'crm', type: 'oidc' });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    const { clientSecret: secret } = await upsertOidcClient(tx, application.id, {
      clientId: 'crm',
      redirectUris: [REDIRECT],
      postLogoutRedirectUris: ['https://crm.acme.test/bye'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['openid', 'profile', 'email'],
      requirePkce: true,
      clientCredentialsEnabled: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      idTokenSignedResponseAlg: 'RS256',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 1209600,
    });
    await createClaimMapping(tx, application.id, {
      protocol: 'oidc', claimName: 'email', nameFormat: '',
      sourceKind: 'user', sourceField: 'email', contractStrategy: 'primary',
      literalValue: null, releaseScope: 'email', multiValued: false,
    });
    return { userId: user.id, applicationId: application.id, clientSecret: secret! };
  }));

  const login = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

/** Discovery through the shim. Task 12 copies this helper verbatim. */
const discover = (id = 'crm', secret?: string) =>
  client.discovery(
    new URL(`http://${TEST_HOST}/oidc`),
    id,
    secret ?? clientSecret,
    undefined,
    { [client.customFetch]: injectFetch(), execute: [client.allowInsecureRequests] },
  );

/** Walks the authorization request the way a browser would, with the cookie. */
const walk = async (url: URL, withCookie = true) => {
  let current = url;
  for (let hop = 0; hop < 8; hop += 1) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: current.pathname + current.search,
      headers: {
        host: TEST_HOST,
        ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
      },
    });
    if (res.statusCode !== 302 && res.statusCode !== 303) return { res, url: current };
    const location = res.headers.location as string;
    if (location.startsWith(REDIRECT)) return { res, url: new URL(location) };
    current = new URL(location, `http://${TEST_HOST}`);
  }
  throw new Error('too many redirects');
};

const authUrlWithPkce = async (config: client.Configuration) => {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: REDIRECT, scope: 'openid email', state,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return { url, verifier, state };
};

describe('OIDC discovery and JWKS', () => {
  it('publishes a discovery document whose endpoints keep the /oidc mount prefix', async () => {
    const config = await discover();
    const meta = config.serverMetadata();
    expect(meta.issuer).toBe(`http://${TEST_HOST}/oidc`);
    // The mount adaptation: strip the prefix from the path oidc-provider
    // routes on, keep it on the URLs it advertises. Getting only half of it
    // right publishes `http://host/token` and every relying party breaks.
    expect(meta.authorization_endpoint).toBe(`http://${TEST_HOST}/oidc/auth`);
    expect(meta.token_endpoint).toBe(`http://${TEST_HOST}/oidc/token`);
    expect(meta.jwks_uri).toBe(`http://${TEST_HOST}/oidc/jwks`);
    expect(meta.end_session_endpoint).toBe(`http://${TEST_HOST}/oidc/session/end`);
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('publishes the outgoing key alongside the incoming one during a rollover, and no private material', async () => {
    const { rotateKey, localMasterKeyProvider } = await import('@syntra/core');
    const before = await ctx.app.inject({
      method: 'GET', url: '/oidc/jwks', headers: { host: TEST_HOST },
    });
    expect(JSON.parse(before.body).keys).toHaveLength(1);

    await rotateKey(ctx.tenantId, localMasterKeyProvider(Buffer.alloc(32, 7)), 'oidc', {
      overlapMs: 60_000,
    });
    const after = await ctx.app.inject({
      method: 'GET', url: '/oidc/jwks', headers: { host: TEST_HOST },
    });
    const keys = JSON.parse(after.body).keys;
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.d).toBeUndefined();
      expect(key.p).toBeUndefined();
      expect(key.q).toBeUndefined();
    }
  });

  it('refuses a discovery request that arrived on a sibling of the tenant host', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/oidc/.well-known/openid-configuration',
      headers: { host: `${TEST_HOST}.attacker.example` },
    });
    expect(res.statusCode).toBe(421);
  });
});

describe('the authorization endpoint', () => {
  it('refuses an authorization request with no PKCE challenge at all', async () => {
    const config = await discover();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope: 'openid', state: client.randomState(),
    });
    const { url: landed } = await walk(url);
    // Refused at the authorization endpoint, so the error comes back on the
    // registered redirect URI rather than as a code.
    expect(landed.searchParams.get('code')).toBeNull();
    expect(landed.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a redirect URI that is not exactly one of the registered ones', async () => {
    const config = await discover();
    for (const bad of [
      'https://crm.acme.test/cb/',
      'https://crm.acme.test/cb/../evil',
      'https://crm.acme.test/cbX',
      'https://crm.acme.test.attacker.example/cb',
      'https://crm.acme.test/CB',
    ]) {
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: bad, scope: 'openid', state: client.randomState(),
        code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
      });
      const res = await ctx.app.inject({
        method: 'GET', url: url.pathname + url.search,
        headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
      });
      // Never a redirect to the unregistered URI: an unregistered redirect
      // target is answered in place, so it cannot be used as an open redirect.
      expect(res.statusCode).not.toBe(302);
      expect(res.headers.location ?? '').not.toContain(bad);
    }
  });

  it('sends an unauthenticated caller to the login screen and issues no code', async () => {
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    const { res } = await walk(url, false);
    expect(res.statusCode).toBe(200);
    expect(res.headers.location ?? '').not.toContain(REDIRECT);
  });

  it('issues nothing for an application the user is not assigned', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.appAssignment.findMany({ where: { applicationId } });
      await tx.appAssignment.deleteMany({ where: { id: rows[0]!.id } });
    });
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    const { res } = await walk(url);
    expect(res.statusCode).toBe(403);
});

describe('the chokepoint holds on every authorization request, not only the first', () => {
  it('CONTROL 1 — a rule added between two launches applies to the second', async () => {
    // The bypass this pins: oidc-provider keeps its own session cookie, and its
    // built-in login prompt would answer the second request out of that session
    // without ever re-entering Syntra. Syntra evaluates policy per application,
    // so a rule added between two launches must apply to the second.
    const config = await discover();
    const flow = async () => walk((await authUrlWithPkce(config)).url);

    const first = await flow();
    expect(first.url.searchParams.get('code')).toBeTruthy();

    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );

    const second = await flow();
    expect(second.url.searchParams.get('code')).toBeNull();
    expect(second.res.statusCode).toBe(403);
  });

  it('records one decision per resolved interaction, for the right user and client', async () => {
    // The row Task 12's token endpoint independently requires. Asserted here
    // because this is the task that writes it: if the interaction route stops
    // writing it, that is this task's failure and not Task 12's.
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    expect(landed.searchParams.get('code')).toBeTruthy();

    const rows = await prisma.authorizationDecision.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);
    expect(rows[0]!.clientId).toBe('crm');
    expect(rows[0]!.consumedAt).toBeNull();
    // Its lifetime is the authorization code's, not longer. A decision that
    // outlived its code would be spendable by a code obtained another way.
    const { AUTHORIZATION_CODE_TTL_SECONDS } = await import('@syntra/core');
    const lifetimeMs = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(Math.round(lifetimeMs / 1000)).toBe(AUTHORIZATION_CODE_TTL_SECONDS);
  });

  it('records no decision when policy denies', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    await walk(url);
    expect(await prisma.authorizationDecision.count()).toBe(0);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm vitest run apps/api/src/routes/oidc-authorize.test.ts`
Expected: FAIL — nothing is mounted at `/oidc`.

- [ ] **Step 4: Write `apps/api/src/routes/oidc-op.ts`**

```ts
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { createPrivateKey } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { exportJWK } from 'jose';
import {
  collectSubjectFacts,
  ensureActiveKey,
  listClaimMappings,
  listOidcClients,
  localMasterKeyProvider,
  publishedKeys,
  readSigningKeyPem,
  resolveClaims,
} from '@syntra/core';
import { providerFor } from '@syntra/protocols';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';

export interface OidcRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  sessionSecret: string;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
}

/** The path everything OIDC is mounted under, and the prefix stripped below. */
export const OIDC_MOUNT = '/oidc';

/**
 * The request object `oidc-provider` is handed.
 *
 * Two adaptations, both required, both established by spike:
 *
 * 1. **`url` has the mount prefix removed.** oidc-provider's router registers
 *    `/token`, `/auth`, `/jwks` and matches them against `ctx.path`
 *    (`lib/helpers/initialize_app.js`). Handing it `/oidc/token` unchanged
 *    returns a bare Koa 404 for every OIDC route.
 * 2. **`originalUrl` keeps the prefix.** `ctx.oidc.urlFor` derives the mount
 *    path as `originalUrl.substring(0, originalUrl.indexOf(request.url))`
 *    (`lib/helpers/oidc_context.js:86`). Strip the prefix without this and the
 *    discovery document advertises `http://host/token` — the prefix silently
 *    vanishes from every URL a relying party consumes.
 *
 * `body` is non-null only for the token endpoint, which had to parse the form
 * to check the client secret and the authorization decision first. A consumed
 * stream cannot be read again, so the bytes are replayed through a
 * `PassThrough` carrying the properties Koa reads. Everything else hands
 * oidc-provider the untouched raw request.
 */
export function requestForProvider(
  raw: IncomingMessage,
  body: Buffer | null,
): IncomingMessage {
  const originalUrl = raw.url ?? '/';
  const url = originalUrl.startsWith(OIDC_MOUNT)
    ? originalUrl.slice(OIDC_MOUNT.length) || '/'
    : originalUrl;

  if (body === null) return Object.assign(raw, { url, originalUrl });

  const replay = new PassThrough();
  replay.end(body);
  return Object.assign(replay, {
    method: raw.method,
    headers: raw.headers,
    httpVersion: raw.httpVersion,
    httpVersionMajor: raw.httpVersionMajor,
    httpVersionMinor: raw.httpVersionMinor,
    rawHeaders: raw.rawHeaders,
    socket: raw.socket,
    connection: raw.socket,
    trailers: {},
    rawTrailers: [],
    complete: false,
    url,
    originalUrl,
  }) as unknown as IncomingMessage;
}

/**
 * The tenant's `Provider`, built on first use and cached.
 *
 * The issuer comes from `tenantProtocolIdentity` and the request's Host is
 * checked against it first. `oidc-provider` stamps the issuer into every `iss`
 * claim and into the discovery document, and a relying party validates it — so
 * deriving it from the header would let an attacker choose the value their own
 * token is checked against.
 */
export async function oidcProviderFor(
  request: FastifyRequest,
  options: OidcRouteOptions,
) {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const identity = tenantProtocolIdentity(tenant, options.publicUrl);
  assertProtocolHost(request, identity);

  const tenantId = request.tenantId;
  const provider = localMasterKeyProvider(options.masterKey);

  return providerFor(tenantId, identity.issuer, {
    findAccount: async (accountId, clientId) => {
      // The user store stays Syntra's. This is the only thing oidc-provider
      // ever learns about a person, and it learns it from the same claim
      // engine SAML uses.
      const result = await request.db(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: accountId } });
        if (!user || user.status !== 'active') return null;
        const oidcClient = clientId
          ? await tx.oidcClient.findFirst({ where: { clientId } })
          : null;
        const facts = await collectSubjectFacts(tx, accountId);
        const mappings = oidcClient
          ? await listClaimMappings(tx, oidcClient.applicationId, 'oidc')
          : [];
        return { user, facts, mappings };
      });
      if (!result) return null;

      const claims: Record<string, unknown> = {};
      for (const claim of resolveClaims(result.mappings, result.facts, 'oidc')) {
        claims[claim.name] = claim.values.length === 1 ? claim.values[0] : claim.values;
      }
      // Two claims are always present because a relying party has nowhere else
      // to get them; everything else is what the tenant mapped.
      claims.preferred_username ??= result.user.login;
      claims.name ??= result.user.displayName;
      return { accountId, claims };
    },

    loadClients: async () => {
      const clients = await listOidcClients(tenantId);
      return clients.map((c) => ({
        client_id: c.clientId,
        // A placeholder, never compared. `registerOidcTokenRoutes` performs
        // client authentication against the stored SHA-256 hash in constant
        // time before oidc-provider sees the request; oidc-provider requires
        // the metadata field to exist for a confidential client, and putting
        // the real secret here would mean holding it recoverably.
        client_secret: 'syntra-verified',
        redirect_uris: c.redirectUris,
        post_logout_redirect_uris: c.postLogoutRedirectUris,
        // Derived, never read straight off `grantTypes`. The admin API refuses
        // `client_credentials` there, so the flag is the only way it can be on
        // — one place to look when asking which clients bypass authorize().
        grant_types: c.clientCredentialsEnabled
          ? [...c.grantTypes, 'client_credentials']
          : c.grantTypes,
        response_types: c.grantTypes.includes('authorization_code') ? ['code'] : [],
        scope: c.scopes.join(' '),
        token_endpoint_auth_method: c.tokenEndpointAuthMethod,
        id_token_signed_response_alg: c.idTokenSignedResponseAlg,
      }));
    },

    // The PRIVATE JWKs, because oidc-provider signs with them. The published
    // `/oidc/jwks` route below serves only the public halves, and a test
    // asserts no `d` appears there. Both published keys are handed over, so a
    // token signed with the outgoing key during a rollover still verifies.
    jwks: async () => {
      await ensureActiveKey(tenantId, provider, 'oidc');
      const published = await publishedKeys(tenantId, 'oidc');
      const keys: Record<string, unknown>[] = [];
      for (const key of published) {
        const pem = await readSigningKeyPem(tenantId, provider, 'oidc', key.kid);
        if (!pem) continue;
        const jwk = (await exportJWK(createPrivateKey(pem))) as Record<string, unknown>;
        keys.push({ ...jwk, kid: key.kid, alg: key.alg, use: 'sig' });
      }
      return { keys };
    },

    interactionUrl: (uid) => `${OIDC_MOUNT}/interaction/${uid}`,
    cookieKeys: [options.sessionSecret],
  });
}

export async function registerOidcRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  // Served by Syntra rather than by oidc-provider, so the Host check runs
  // first and so the published document contains only public key halves.
  app.get('/jwks', async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    assertProtocolHost(request, tenantProtocolIdentity(tenant, options.publicUrl));

    await ensureActiveKey(
      request.tenantId, localMasterKeyProvider(options.masterKey), 'oidc',
    );
    const keys = await publishedKeys(request.tenantId, 'oidc');
    return reply
      .type('application/jwk-set+json')
      .header('cache-control', 'public, max-age=300')
      .send({ keys: keys.map((key) => key.publicJwk) });
  });

  /**
   * Everything else — discovery, authorization, userinfo, revocation,
   * introspection, end_session — is oidc-provider's.
   *
   * `reply.hijack()` tells Fastify to stop managing the response; from that
   * point oidc-provider owns the socket. **This plugin registers no body
   * parser**, so the raw stream reaches oidc-provider untouched. Fastify core
   * parses only `application/json` and `text/plain`; the
   * `application/x-www-form-urlencoded` bodies these endpoints receive pass
   * through, and `oidc-boundary.test.ts` asserts nothing has added a parser at
   * the root.
   */
  app.all('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const provider = await oidcProviderFor(request, options);
    reply.hijack();
    await provider.callback()(requestForProvider(request.raw, null), reply.raw);
  });
}
```

- [ ] **Step 5: Write `apps/api/src/routes/oidc-interaction.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import {
  authorize,
  isApplicationAssigned,
  recordAuthorizationDecision,
  recordEvent,
  resolveSession,
} from '@syntra/core';
import { SYNTRA_DECISION_KEY } from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { tenantRelyingParty } from './relying-party.js';
import { oidcProviderFor, type OidcRouteOptions } from './oidc-op.js';

/**
 * The only place an OIDC interaction is resolved.
 *
 * `oidc-provider` cannot issue a code for a request whose interaction is
 * unresolved, and `syntraAuthorizePrompt` guarantees every authorization
 * request has one. This route resolves it, and only from an `allow` out of
 * `authorize()`. There is no other call to `provider.interactionFinished`
 * anywhere in the codebase.
 *
 * It also writes the `AuthorizationDecision` the token endpoint independently
 * requires. The two writes are the two halves of one fact — the chokepoint
 * allowed — recorded in two places on purpose.
 */
export async function registerOidcInteractionRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  app.get(
    '/interaction/:uid',
    {
      // A launch evaluates policy and can mint an attempt, so both dimensions,
      // as at every other authorize() entry point.
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
      onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
    },
    async (request, reply) => {
      const provider = await oidcProviderFor(request, options);
      const { uid, prompt, params } = await provider.interactionDetails(
        request.raw, reply.raw,
      );

      const clientId = String(params.client_id ?? '');
      const oidcClient = await request.db((tx) =>
        tx.oidcClient.findFirst({ where: { clientId } }),
      );
      if (!oidcClient) {
        throw new ProblemError(400, 'oidc-unknown-client', 'Unknown client');
      }

      const token = request.cookies[SESSION_COOKIE];
      const session = token ? await request.db((tx) => resolveSession(tx, token)) : null;
      if (!session) {
        const next = encodeURIComponent(`/oidc/interaction/${uid}`);
        return reply.redirect(`/login?next=${next}`, 302);
      }

      const assigned = await request.db((tx) =>
        isApplicationAssigned(tx, session.userId, oidcClient.applicationId),
      );
      if (!assigned) {
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      const tenant = await request.db((tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
      );

      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        // Session id only; authorize() reads the satisfied factor off the row.
        principal: { kind: 'session', userId: session.userId, sessionId: session.sessionId },
        applicationId: oidcClient.applicationId,
        sourceIp: request.ip,
        relyingParty: tenantRelyingParty(tenant, options.publicUrl),
        scope: 'portal',
      });

      if (decision.status === 'deny') {
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      if (decision.status === 'challenge' || decision.status === 'enrol') {
        const next = encodeURIComponent(`/oidc/interaction/${uid}`);
        const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
        return reply.redirect(
          `${path}?attempt=${encodeURIComponent(decision.attemptToken)}&next=${next}`,
          302,
        );
      }

      // Written BEFORE the interaction is resolved. If this throws, no code is
      // ever minted; if it succeeded and the resolve then failed, the decision
      // simply expires unspent. The order that could issue a code with no
      // decision behind it is the other one.
      await recordAuthorizationDecision(request.tenantId, {
        userId: decision.userId,
        clientId,
        interactionUid: uid,
        satisfiedFactor: decision.satisfiedFactor,
      });

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: decision.userId,
          action: 'oidc.interaction_resolved',
          targetType: 'Application',
          targetId: oidcClient.applicationId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            clientId,
            prompt: prompt.name,
            interactionUid: uid,
            satisfiedFactor: decision.satisfiedFactor,
          },
        }),
      );

      reply.hijack();
      // `login.accountId` is the Syntra user id and nothing else — never a
      // value taken off the request. The `syntraDecision` key is what
      // `syntraAuthorizePrompt` looks for; without it the prompt fires again
      // and the request loops rather than issuing anything.
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        {
          login: {
            accountId: decision.userId,
            remember: false,
            ...(decision.satisfiedFactor ? { amr: [decision.satisfiedFactor] } : {}),
          },
          [SYNTRA_DECISION_KEY]: { clientId, at: Date.now() },
        } as never,
        { mergeWithLastSubmission: false },
      );
    },
  );
}
```

- [ ] **Step 6: Register the interaction route and the catch-all in `app.ts`**

```ts
  const oidcOptions = {
    publicUrl: config.publicUrl,
    masterKey: config.masterKey,
    sessionSecret: config.sessionSecret,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  };
  await app.register(registerOidcInteractionRoutes, { prefix: '/oidc', ...oidcOptions });
  // The catch-all last: every specific route must be matched first, and this is
  // the only one that hands oidc-provider an unparsed body. Task 12 inserts its
  // token plugin between these two lines.
  await app.register(registerOidcRoutes, { prefix: '/oidc', ...oidcOptions });
```

Add `"@syntra/protocols": "workspace:*"` to `apps/api/package.json` dependencies and `"openid-client": "6.8.5"` to its devDependencies (the test's relying party).

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/api/src/routes/oidc-authorize.test.ts`
Expected: PASS.

**Why these tests are not degenerate.**

- The **discovery** case pins all four endpoint URLs including the `/oidc` prefix, which fails if either half of the mount adaptation is missing — one half 404s everything, the other publishes URLs with the prefix stripped. A test asserting only `statusCode === 200` would pass under the second failure.
- The **JWKS** case asserts `d`, `p` and `q` are absent, which fails for the obvious mistake of publishing the private JWKs `oidc-provider` is configured with.
- **CONTROL 1** completes one successful authorization, adds a deny rule, and requires the second to fail. An implementation without `syntraAuthorizePrompt` passes every other case in the file and fails only this one, because `oidc-provider` would answer the second request out of its own session cookie.
- The **decision-row** case asserts the user, the client and the exact TTL rather than mere existence, so an implementation writing a decision for the wrong subject — or one whose lifetime has drifted from the code's — fails here rather than surfacing as a mysterious refusal in Task 12.
- The **redirect-URI** case walks five near-miss strings and asserts the response is *not* a redirect to any of them, so an implementation that refused but redirected the error to the unregistered URI — an open redirect — still fails.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/oidc-op.ts apps/api/src/routes/oidc-interaction.ts apps/api/src/routes/oidc-authorize.test.ts apps/api/src/app.ts apps/api/package.json packages/core/src/access/authorization-decision-service.ts packages/core/src/index.ts packages/protocols/src/oidc/provider-factory.ts pnpm-lock.yaml
git commit -m "feat(oidc): mount adaptation, discovery, JWKS, and the interaction route"
```

---

## Task 12: The OIDC token endpoint — client authentication, and the second chokepoint control

**Files:**
- Create: `apps/api/src/routes/oidc-token.ts`
- Create: `apps/api/src/routes/oidc-token.test.ts`
- Create: `apps/api/src/routes/oidc-boundary.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `oidcProviderFor`, `requestForProvider`, `OidcRouteOptions`, and the `AuthorizationDecision` rows the interaction route writes (Task 11); `verifyClientSecret` (Task 10); `consumeAuthorizationDecision` (Task 11); `recordEvent` from `@syntra/core`; `perTenantRateLimit` from `apps/api/src/plugins/rate-limit.js`.
- Produces: `registerOidcTokenRoutes(app: FastifyInstance, options: OidcRouteOptions): Promise<void>`, mounted at `/oidc` **before** Task 11's catch-all.

### Why this is a separate task from the mount

Task 11 gets a browser to an authorization code. This task is everything that happens when that code comes back, and it is where the second of the two controls behind spec section 7's chokepoint lives. It also carries the one piece of framework surgery in the OIDC half — the token endpoint has to read the request body to authenticate the client, and `oidc-provider` then has to read the same body from the raw stream — so it is the only OIDC route with its own content-type parser and its own replay. Reviewing that alongside the mount adaptation means reviewing neither properly.

- [ ] **Step 1: Write the failing token-endpoint test**

Create `apps/api/src/routes/oidc-token.test.ts`. Copy the `beforeEach`, `injectFetch`, `discover`, `walk` and `authUrlWithPkce` helpers from `oidc-authorize.test.ts` verbatim — they close over that file's module-level `ctx`, `cookie` and `clientSecret`, so they are not importable and sharing them would mean sharing mutable test state. Then:

```ts
describe('the authorization code exchange', () => {
  it('completes the code flow with PKCE and returns claims from the mapping', async () => {
    const config = await discover();
    const { url, verifier, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    expect(landed.searchParams.get('code')).toBeTruthy();

    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });
    expect(tokens.access_token).toBeTruthy();
    const idClaims = tokens.claims()!;
    expect(idClaims.sub).toBe(userId);
    expect(idClaims.aud).toBe('crm');
    expect(idClaims.iss).toBe(`http://${TEST_HOST}/oidc`);
    expect((idClaims as Record<string, unknown>).email).toBe('j@acme.test');
  });

  it('refuses the token exchange when the PKCE verifier does not match', async () => {
    const config = await discover();
    const { url, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    await expect(
      client.authorizationCodeGrant(config, landed, {
        pkceCodeVerifier: client.randomPKCECodeVerifier(), expectedState: state,
      }),
    ).rejects.toThrow();
  });

  it('refuses the token exchange with the wrong client secret', async () => {
    const config = await discover();
    const { url, verifier, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    const wrong = await discover('crm', 'not-the-secret');
    await expect(
      client.authorizationCodeGrant(wrong, landed, {
        pkceCodeVerifier: verifier, expectedState: state,
      }),
    ).rejects.toThrow();
  });
});

/**
 * The library contract Control 2 rests on.
 *
 * Ruling A2-7 accepted the dependency on `provider.AuthorizationCode.find` —
 * public API, verified round trip, version pinned exactly — on the condition
 * that it fail loudly and specifically if the library stops returning what it
 * returns today. A pinned dependency that breaks quietly on upgrade is how a
 * control disappears between releases, and without this the symptom would be
 * the security test below failing with a bare "expected 400, got 200".
 */
describe('the oidc-provider model API Control 2 depends on', () => {
  const CONTRACT = [
    'CONTRACT BROKEN: oidc-provider AuthorizationCode.find no longer behaves as',
    'apps/api/src/routes/oidc-token.ts assumes. That function is the second of the',
    'two controls behind the spec section 7 chokepoint: without it the token',
    'endpoint cannot tell which user and client a code belongs to, and therefore',
    'cannot require an AuthorizationDecision before issuing a token.',
    'Do NOT relax this test. Either adapt oidc-token.ts to the new behaviour and',
    'update this contract, or pin oidc-provider back to the version below.',
  ].join(' ');

  it('returns the stored accountId, clientId and grantId for a code it just minted', async () => {
    await discover(); // builds and caches the Provider this tenant is served from
    const provider = await providerForCached(ctx.tenantId);

    const grant = new provider.Grant({ clientId: 'crm', accountId: userId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();

    const verifier = client.randomPKCECodeVerifier();
    const code = new provider.AuthorizationCode({
      accountId: userId, clientId: 'crm', grantId,
      redirectUri: REDIRECT, scope: 'openid',
      codeChallenge: await client.calculatePKCECodeChallenge(verifier),
      codeChallengeMethod: 'S256',
    });
    const value = await code.save();

    const found = await provider.AuthorizationCode.find(value);
    expect(found, CONTRACT).toBeTruthy();
    expect(found!.accountId, CONTRACT).toBe(userId);
    expect(found!.clientId, CONTRACT).toBe('crm');
    expect(found!.grantId, CONTRACT).toBe(grantId);
    // Falsy on a live code is what lets the check know it has not been spent.
    expect(found!.consumed, CONTRACT).toBeFalsy();
  });

  it('returns undefined for an unknown code rather than throwing', async () => {
    // The token endpoint steps aside for an unknown or spent code so that
    // oidc-provider's own replay detection can revoke the grant. A throw here
    // would turn that into a 500 and lose the revocation.
    await discover();
    const provider = await providerForCached(ctx.tenantId);
    await expect(
      provider.AuthorizationCode.find('not-a-real-code'),
    ).resolves.toBeUndefined();
  });

  it('is still the exact version this contract was verified against', async () => {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('oidc-provider/package.json') as {
      version: string;
    };
    // Named separately from the behaviour cases so an upgrade reads as "the
    // pin moved" rather than as a mysterious behavioural failure.
    expect(pkg.version, CONTRACT).toBe('9.11.3');
  });
});

describe('CONTROL 2 — the token endpoint requires a decision from authorize()', () => {
  it('CONTROL 2 — a code minted with no interaction at all is refused at the token endpoint', async () => {
    // What deleting `syntraAuthorizePrompt` would produce: a genuine, valid,
    // oidc-provider-minted authorization code for a real user and a real
    // client, with no Syntra decision behind it. Rather than editing the
    // source, this mints exactly that code through the provider's own model
    // API — the strongest form of "the prompt is gone".
    //
    // `providerFor` returns the cached instance for a tenant and ignores its
    // deps on a cache hit, so this is the same Provider the app is serving
    // from. The discovery call above is what put it in the cache.
    const config = await discover();
    void config;
    const { providerFor } = await import('@syntra/protocols');
    const provider = await providerFor(
      ctx.tenantId,
      `http://${TEST_HOST}/oidc`,
      null as never,
    );

    const grant = new provider.Grant({ clientId: 'crm', accountId: userId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();

    const verifier = client.randomPKCECodeVerifier();
    const code = new provider.AuthorizationCode({
      accountId: userId, clientId: 'crm', grantId,
      redirectUri: REDIRECT, scope: 'openid',
      codeChallenge: await client.calculatePKCECodeChallenge(verifier),
      codeChallengeMethod: 'S256',
    });
    const value = await code.save();

    // Sanity: the code is real and oidc-provider can find it. If this fails
    // the test is not exercising what it claims to.
    expect(await provider.AuthorizationCode.find(value)).toBeTruthy();

    const res = await ctx.app.inject({
      method: 'POST', url: '/oidc/token',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`crm:${clientSecret}`).toString('base64')}`,
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: value,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
    expect(res.body).not.toContain('access_token');
    expect(res.body).not.toContain('id_token');

    // And it is visible afterwards rather than only refused.
    const events = await prisma.auditEvent.findMany({
      where: { action: 'oidc.decision_missing' },
    });
    expect(events).toHaveLength(1);
  });

  it('CONTROL 2 — a decision is single-use, so one interaction cannot buy two tokens', async () => {
    const config = await discover();
    const { url, verifier, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);

    await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });
    // Replaying the same code: oidc-provider's own replay detection answers
    // this one, because the decision check deliberately steps aside for a code
    // that is already consumed.
    await expect(
      client.authorizationCodeGrant(config, landed, {
        pkceCodeVerifier: verifier, expectedState: state,
      }),
    ).rejects.toThrow();

    const rows = await prisma.authorizationDecision.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
  });

  it('CONTROL 2 — a decision made for one client does not satisfy another', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const other = await createApplication(tx, { name: 'HR', slug: 'hr', type: 'oidc' });
      await assignApplication(tx, other.id, { type: 'user', id: userId });
      await upsertOidcClient(tx, other.id, {
        clientId: 'hr', redirectUris: ['https://hr.acme.test/cb'],
        postLogoutRedirectUris: [], grantTypes: ['authorization_code'],
        scopes: ['openid'], requirePkce: true, clientCredentialsEnabled: false,
        tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256',
        accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 0,
      });
    });
    const { invalidateProvider } = await import('@syntra/protocols');
    invalidateProvider(ctx.tenantId);

    // One legitimate flow for CRM, left unexchanged, so its decision is live.
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    await walk(url);
    expect(await prisma.authorizationDecision.count()).toBe(1);

    // Now mint an HR code with no interaction. The live CRM decision must not
    // pay for it — otherwise a launch of a low-risk application would satisfy
    // the requirement for a high-risk one.
    const provider = await providerForCached(ctx.tenantId);
    const grant = new provider.Grant({ clientId: 'hr', accountId: userId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();
    const verifier = client.randomPKCECodeVerifier();
    const code = new provider.AuthorizationCode({
      accountId: userId, clientId: 'hr', grantId,
      redirectUri: 'https://hr.acme.test/cb', scope: 'openid',
      codeChallenge: await client.calculatePKCECodeChallenge(verifier),
      codeChallengeMethod: 'S256',
    });
    const value = await code.save();

    const hrSecret = await withTenant(ctx.tenantId, async (tx) => {
      const application = await tx.application.findFirstOrThrow({ where: { slug: 'hr' } });
      const { clientSecret: s } = await upsertOidcClient(tx, application.id, {
        clientId: 'hr', redirectUris: ['https://hr.acme.test/cb'],
        postLogoutRedirectUris: [], grantTypes: ['authorization_code'],
        scopes: ['openid'], requirePkce: true, clientCredentialsEnabled: false,
        tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256',
        accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 0,
        rotateSecret: true,
      });
      return s!;
    });

    const res = await ctx.app.inject({
      method: 'POST', url: '/oidc/token',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`hr:${hrSecret}`).toString('base64')}`,
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code', code: value,
        redirect_uri: 'https://hr.acme.test/cb', code_verifier: verifier,
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('access_token');
    // The CRM decision is untouched.
    const rows = await prisma.authorizationDecision.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe('crm');
    expect(rows[0]!.consumedAt).toBeNull();
  });
});

/** The Provider the app is serving from, out of `providerFor`'s cache. */
async function providerForCached(tenantId: string) {
  // `providerFor` returns the cached instance for a tenant and ignores its
  // deps on a cache hit, so this is the same Provider the app serves from.
  // A `discover()` call is what puts it in the cache.
  const { providerFor } = await import('@syntra/protocols');
  return providerFor(tenantId, `http://${TEST_HOST}/oidc`, null as never);
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run apps/api/src/routes/oidc-token.test.ts`
Expected: FAIL — `/oidc/token` is answered by Task 11's catch-all, which cannot authenticate a client against a stored hash.

- [ ] **Step 3: Write `apps/api/src/routes/oidc-token.ts`**

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  consumeAuthorizationDecision,
  recordEvent,
  verifyClientSecret,
} from '@syntra/core';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { oidcProviderFor, requestForProvider, type OidcRouteOptions } from './oidc-op.js';

interface ClientCredentials {
  clientId: string;
  secret: string;
}

/**
 * The client credentials a token request presented, or null for a public
 * client authenticating with PKCE alone.
 *
 * Both `client_secret_basic` (the Authorization header) and
 * `client_secret_post` (a form field) are read, because a client may use
 * either and refusing the one a client happens to use is a support ticket.
 * RFC 6749 section 2.3.1 percent-encodes both halves of the Basic credential.
 */
function presentedCredentials(
  request: FastifyRequest,
  params: URLSearchParams,
): ClientCredentials | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index <= 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, index)),
      secret: decodeURIComponent(decoded.slice(index + 1)),
    };
  }
  const clientId = params.get('client_id');
  const secret = params.get('client_secret');
  if (clientId === null || secret === null) return null;
  return { clientId, secret };
}

/**
 * The second of the two independent controls behind spec section 7's
 * chokepoint.
 *
 * The first is `syntraAuthorizePrompt`, which forces every authorization
 * request out to Syntra's interaction route. It is one deleted line in a file
 * whose purpose is not obvious, and it depends on `ctx.oidc.result` semantics
 * internal to `oidc-provider`. This one is in Syntra's own route, reads
 * Syntra's own table, and does not touch `oidc-provider`'s configuration at
 * all — so no single edit removes both, which is the whole point of having
 * two. `oidc-token.test.ts` mints a genuine authorization code with no
 * interaction behind it and asserts this refuses it.
 *
 * The ordering is deliberate. A code that is **unknown, expired or already
 * consumed** is handed to oidc-provider untouched, because its own replay
 * detection revokes the entire grant when a consumed code is presented a
 * second time — refusing here first would answer with the same status and lose
 * that revocation. Only a code that is live, and for which no decision exists,
 * is refused here.
 *
 * `refresh_token` and `client_credentials` are not checked. A refresh token
 * descends from a code that was checked, and re-checking would demand a fresh
 * interaction for every refresh. Client credentials authenticate a *client*
 * and involve no user, no session and no policy decision to bypass; the
 * control there is the client secret.
 */
async function refuseWithoutDecision(
  request: FastifyRequest,
  provider: Awaited<ReturnType<typeof oidcProviderFor>>,
  params: URLSearchParams,
): Promise<{ error: string; error_description: string } | null> {
  const code = params.get('code');
  if (code === null || code === '') return null;

  const stored = await provider.AuthorizationCode.find(code);
  if (!stored || stored.consumed) return null;

  const accountId = stored.accountId;
  const clientId = stored.clientId;
  if (typeof accountId !== 'string' || typeof clientId !== 'string') return null;

  if (await consumeAuthorizationDecision(request.tenantId, accountId, clientId)) {
    return null;
  }

  await request.db((tx) =>
    recordEvent(tx, {
      actorUserId: accountId,
      action: 'oidc.decision_missing',
      targetType: 'User',
      targetId: accountId,
      outcome: 'failure',
      sourceIp: request.ip,
      payload: {
        clientId,
        reason: 'no live authorize() decision for this authorization code',
      },
    }),
  );

  return {
    error: 'invalid_grant',
    error_description: 'This authorization was not granted by this identity provider',
  };
}

/**
 * The token endpoint.
 *
 * Its own plugin because it is the one OIDC route that must read the body
 * before oidc-provider does. The buffer parser is registered **inside this
 * plugin only** — Fastify's encapsulation keeps it away from
 * `registerOidcRoutes`, whose catch-all must hand oidc-provider an untouched
 * stream. `oidc-boundary.test.ts` asserts that separation directly rather than
 * trusting the registration order to stay right.
 */
export async function registerOidcTokenRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/token',
    {
      // A token request presents a credential, so both rate-limit dimensions,
      // as at every other credential-presenting route.
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
      onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
    },
    async (request, reply) => {
      const provider = await oidcProviderFor(request, options);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const params = new URLSearchParams(body.toString('utf8'));

      const credentials = presentedCredentials(request, params);
      if (credentials !== null) {
        // Constant-time, against the stored SHA-256 hash. oidc-provider never
        // sees the real secret.
        const ok = await verifyClientSecret(
          request.tenantId, credentials.clientId, credentials.secret,
        );
        if (!ok) {
          return reply.status(401).type('application/json').send({
            error: 'invalid_client',
            error_description: 'Client authentication failed',
          });
        }
      }

      if (params.get('grant_type') === 'authorization_code') {
        const refusal = await refuseWithoutDecision(request, provider, params);
        if (refusal) return reply.status(400).type('application/json').send(refusal);
      }

      reply.hijack();
      // The body was consumed above, so it is replayed. See
      // `requestForProvider`.
      await provider.callback()(requestForProvider(request.raw, body), reply.raw);
    },
  );
}
```

- [ ] **Step 4: Register it ahead of the catch-all in `app.ts`**

The token plugin goes between the interaction plugin and the catch-all Task 11 registered. Order matters twice over: the specific routes must be matched before the wildcard, and the token plugin must be its own encapsulated scope so its body parser cannot escape into the catch-all's.

```ts
  await app.register(registerOidcInteractionRoutes, { prefix: '/oidc', ...oidcOptions });
  await app.register(registerOidcTokenRoutes, { prefix: '/oidc', ...oidcOptions });
  // The catch-all last: every specific route above must be matched first, and
  // this is the only one that hands oidc-provider an unparsed body.
  await app.register(registerOidcRoutes, { prefix: '/oidc', ...oidcOptions });
```

- [ ] **Step 5: Write the body-parsing boundary test**

Create `apps/api/src/routes/oidc-boundary.test.ts`. This asserts the *encapsulation*, not merely that the routes work — those are different failures and only one of them is loud.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });
});

describe('the body-parsing boundary', () => {
  it('has no urlencoded parser at the root instance', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. `/oidc/*` hands oidc-provider the raw
    // stream, and oidc-provider reads the body itself. A urlencoded parser at
    // the root drains that stream for every OIDC endpoint. Three plugins
    // legitimately parse form bodies — the SAML IdP, the OIDC token endpoint
    // and federation — and each registers its own inside its own scope;
    // Fastify's encapsulation is what keeps them there.
    //
    // Fastify core registers parsers only for application/json and text/plain,
    // so this is false unless somebody added one.
    expect(ctx.app.hasContentTypeParser('application/x-www-form-urlencoded')).toBe(false);
    // And the encapsulated ones are still absent from the root, which is the
    // same statement from the other direction.
    expect(ctx.app.hasContentTypeParser('application/json')).toBe(true);
  });

  it('builds at all — a duplicate parser registration fails at boot', async () => {
    // Registering `@fastify/formbody` at the root makes the SAML and token
    // plugins' own `addContentTypeParser` throw FST_ERR_CTP_ALREADY_PRESENT
    // while the app is being built. Asserting the build resolves is what turns
    // that from a runtime surprise into a failed test.
    await expect(buildTestApp()).resolves.toBeDefined();
  });

  it('delivers the token endpoint body to oidc-provider, not a drained stream', async () => {
    // The discriminator, measured: with the body replayed, oidc-provider sees
    // grant_type and answers `unsupported_grant_type`. Without the replay it
    // sees an empty body and answers `invalid_request / no client
    // authentication mechanism provided`. Asserting the first AND denying the
    // second is what distinguishes "the replay works" from "the route
    // happened to return 400".
    const res = await ctx.app.inject({
      method: 'POST', url: '/oidc/token',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ grant_type: 'bogus' }).toString(),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('unsupported_grant_type');
    expect(body.error_description ?? '').not.toContain('client authentication');
  });

  it('routes an OIDC path to oidc-provider at all, proving the mount prefix is stripped', async () => {
    // Without the prefix strip, oidc-provider's router matches nothing and
    // answers a bare Koa 404 with the text "Not Found" for every route here.
    const res = await ctx.app.inject({
      method: 'GET', url: '/oidc/.well-known/openid-configuration',
      headers: { host: TEST_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toBe('Not Found');
    expect(JSON.parse(res.body).issuer).toBe(`http://${TEST_HOST}/oidc`);
  });

  it('parses a form body inside the SAML plugin, where one is registered', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/saml/sso',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ SAMLRequest: '' }).toString(),
    });
    // The handler read `request.body` and found an empty SAMLRequest. A 415
    // would mean no parser; a 500 would mean `request.body` was undefined.
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(415);
  });
});
```

- [ ] **Step 6: Run everything**

Run: `pnpm vitest run apps/api/src/routes/oidc-token.test.ts apps/api/src/routes/oidc-boundary.test.ts apps/api/src/routes/oidc-authorize.test.ts`
Expected: PASS. Task 11's suite must still pass unchanged — this task adds a route ahead of the catch-all and must not alter anything the authorization endpoint does.

**Why these tests are not degenerate.**

- **CONTROL 2** does not simulate a bypass; it *performs* one. It mints a genuine authorization code through `provider.AuthorizationCode` — the same object `oidc-provider` mints — for a real user and a real client, with no interaction anywhere in its history, and asserts the token endpoint answers `invalid_grant` and returns neither an access token nor an id_token. That is the state a deleted prompt produces, reached without editing the source. It also asserts the audit event, so the refusal is visible rather than silent. **Delete `syntraAuthorizePrompt` and Task 11's CONTROL 1 fails while this passes; delete the decision check and this fails while CONTROL 1 passes. One edit cannot take both, which is the property the two controls exist to have.**
- The **different-client** case leaves a live decision for CRM and presents an HR code, so an implementation keying the decision on the user alone passes everything else and fails here.
- The **single-use** case exchanges legitimately, replays, and asserts the replay is refused *and* that exactly one decision row exists and is consumed — so an implementation that never spent the decision, or that spent two, fails.
- The **contract** block is not a security test and is deliberately separated from one. Its failure message names the file that depends on the behaviour and forbids relaxing the assertion, so an upgrade that changes `find` produces a message a reader can act on instead of a 400-versus-200 mystery three tests away.
- The **boundary** test asserts `hasContentTypeParser` at the root directly, so it fails on the registration itself rather than on a downstream symptom, and its token-endpoint case asserts the specific error that distinguishes a replayed body from a drained one.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/oidc-token.ts apps/api/src/routes/oidc-token.test.ts apps/api/src/routes/oidc-boundary.test.ts apps/api/src/app.ts
git commit -m "feat(oidc): token endpoint with constant-time client auth and the decision check"
```

---

## Task 13: Refresh tokens, client credentials, UserInfo, and RP-initiated logout

**Files:**
- Modify: `packages/protocols/src/oidc/provider-factory.ts` (grant behaviour and route paths)
- Modify: `apps/api/src/routes/oidc-token.ts` (the client-credentials guard and its audit event)
- Create: `apps/api/src/routes/oidc-logout.ts`
- Create: `apps/api/src/routes/oidc-grants.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: everything from Tasks 10 and 11; `isRegisteredPostLogoutUri`, `findOidcClient` (Task 10); `revokeSession`, `resolveSession`, `recordEvent` from `@syntra/core`; `oidcProviderFor`, `OidcRouteOptions` (Task 11).
- Produces: `registerOidcLogoutRoutes(app: FastifyInstance, options: OidcRouteOptions): Promise<void>`, mounted at `/oidc`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/oidc-grants.test.ts`. Copy the `beforeEach`, `injectFetch`, `discover`, `walk` and `authUrlWithPkce` helpers from `oidc-authorize.test.ts` verbatim — they close over that file's module-level `ctx`, `cookie` and `clientSecret`, so they are not importable and sharing them would mean sharing mutable test state. Then:

```ts
describe('refresh tokens', () => {
  const codeFlow = async (scope: string) => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope, state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
    return { config, tokens };
  };

  it('issues a refresh token when offline_access is requested, and exchanges it', async () => {
    const { config, tokens } = await codeFlow('openid email offline_access');
    expect(tokens.refresh_token).toBeTruthy();

    const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    // Rotation is on, so the old refresh token is replaced rather than reused.
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  });

  it('refuses a rotated-out refresh token and revokes the whole grant', async () => {
    const { config, tokens } = await codeFlow('openid offline_access');
    const first = await client.refreshTokenGrant(config, tokens.refresh_token!);

    // Replaying the original is the signal that a refresh token leaked.
    await expect(client.refreshTokenGrant(config, tokens.refresh_token!)).rejects.toThrow();
    // And the replacement is dead too, because the grant behind both is gone.
    await expect(client.refreshTokenGrant(config, first.refresh_token!)).rejects.toThrow();
  });

  it('issues no refresh token without offline_access', async () => {
    const { tokens } = await codeFlow('openid email');
    expect(tokens.refresh_token).toBeUndefined();
  });

  it('stops honouring a refresh token once the user is deactivated', async () => {
    const { config, tokens } = await codeFlow('openid offline_access');
    const { deactivateUser } = await import('@syntra/core');
    await withTenant(ctx.tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    // findAccount returns null for an inactive user, and oidc-provider
    // refuses to mint an id_token for an account it cannot find.
    await expect(client.refreshTokenGrant(config, tokens.refresh_token!)).rejects.toThrow();
  });
});

describe('client credentials — the one grant that bypasses authorize()', () => {
  /** Registers a machine client and returns its secret. */
  const machineClient = async (over: Record<string, unknown> = {}) => {
    const secret = await withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.application.findFirst({ where: { slug: 'job' } });
      const application =
        existing ?? (await createApplication(tx, { name: 'Job', slug: 'job', type: 'oidc' }));
      const { clientSecret } = await upsertOidcClient(tx, application.id, {
        clientId: 'job', redirectUris: [], postLogoutRedirectUris: [],
        grantTypes: [], clientCredentialsEnabled: true, scopes: ['reports.read'],
        requirePkce: true, tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256', accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 0, rotateSecret: true, ...over,
      });
      return clientSecret!;
    });
    const { invalidateProvider } = await import('@syntra/protocols');
    invalidateProvider(ctx.tenantId);
    return client.discovery(
      new URL(`http://${TEST_HOST}/oidc`), 'job', secret, undefined,
      { [client.customFetch]: injectFetch(), execute: [client.allowInsecureRequests] },
    );
  };

  it('issues a token to a client an administrator enabled, and audits it distinctly', async () => {
    const config = await machineClient();
    const tokens = await client.clientCredentialsGrant(config, { scope: 'reports.read' });
    expect(tokens.access_token).toBeTruthy();
    // No user behind it, so no id_token and no subject.
    expect(tokens.id_token).toBeUndefined();

    // A2-5 condition 2. "What was issued with no policy decision behind it"
    // has to be an answerable question, and a generic token event would not
    // answer it.
    const events = await prisma.auditEvent.findMany({
      where: { action: 'oidc.client_credentials_authorized' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBeNull();
    expect(JSON.stringify(events[0]!.payload)).toContain('job');
    // And nothing pretends a decision happened.
    expect(await prisma.authorizationDecision.count()).toBe(0);
  });

  it('refuses the grant when the flag is off, even if the request is otherwise perfect', async () => {
    // A2-5 condition 1. The client exists, the secret is right, the scope is
    // registered — and the grant is off, which is the default.
    const config = await machineClient({ clientCredentialsEnabled: false });
    await expect(client.clientCredentialsGrant(config, { scope: 'reports.read' }))
      .rejects.toThrow();
    expect(
      await prisma.auditEvent.count({ where: { action: 'oidc.client_credentials_authorized' } }),
    ).toBe(0);
  });

  it('refuses a scope that would let the token stand in for a user token', async () => {
    // A2-5 condition 3. If a machine token could carry `openid` it would be
    // presentable wherever a user token is accepted, and the exemption would
    // stop being bounded.
    const config = await machineClient({ scopes: ['reports.read', 'openid'] });
    await expect(client.clientCredentialsGrant(config, { scope: 'openid' })).rejects.toThrow();
    await expect(client.clientCredentialsGrant(config, { scope: 'reports.read openid' }))
      .rejects.toThrow();
    // The machine scope on its own is still fine.
    await expect(client.clientCredentialsGrant(config, { scope: 'reports.read' }))
      .resolves.toBeTruthy();
  });

  it('issues a token that UserInfo refuses', async () => {
    // The other half of condition 3, from the resource side: there is no
    // subject, so the endpoint that answers about a subject must refuse it.
    const config = await machineClient();
    const tokens = await client.clientCredentialsGrant(config, { scope: 'reports.read' });
    const res = await ctx.app.inject({
      method: 'GET', url: '/oidc/me',
      headers: { host: TEST_HOST, authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('sub');
  });

  it('refuses client credentials with the wrong secret', async () => {
    const config = await client.discovery(
      new URL(`http://${TEST_HOST}/oidc`), 'crm', 'wrong-secret', undefined,
      { [client.customFetch]: injectFetch(), execute: [client.allowInsecureRequests] },
    );
    await expect(client.clientCredentialsGrant(config)).rejects.toThrow();
  });

  it('refuses client credentials from an ordinary user-facing client', async () => {
    const config = await discover();
    await expect(client.clientCredentialsGrant(config)).rejects.toThrow();
  });
});

describe('UserInfo', () => {
  it('returns the mapped claims for the token subject', async () => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope: 'openid email', state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });

    const info = await client.fetchUserInfo(config, tokens.access_token, userId);
    expect(info.sub).toBe(userId);
    expect(info.email).toBe('j@acme.test');
  });

  it('refuses a UserInfo call with no token and with a made-up one', async () => {
    const none = await ctx.app.inject({
      method: 'GET', url: '/oidc/me', headers: { host: TEST_HOST },
    });
    expect(none.statusCode).toBe(401);
    const bogus = await ctx.app.inject({
      method: 'GET', url: '/oidc/me',
      headers: { host: TEST_HOST, authorization: 'Bearer not-a-token' },
    });
    expect(bogus.statusCode).toBe(401);
  });
});

describe('RP-initiated logout', () => {
  it('ends the Syntra session and returns to a registered post-logout URI', async () => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope: 'openid', state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });

    const endSession = client.buildEndSessionUrl(config, {
      id_token_hint: tokens.id_token!,
      post_logout_redirect_uri: 'https://crm.acme.test/bye',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: endSession.pathname + endSession.search,
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect([200, 302, 303]).toContain(res.statusCode);

    // The Syntra session is gone, not merely oidc-provider's.
    const after = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses an unregistered post-logout redirect URI', async () => {
    const config = await discover();
    const endSession = client.buildEndSessionUrl(config, {
      post_logout_redirect_uri: 'https://attacker.test/bye',
      client_id: 'crm',
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: endSession.pathname + endSession.search,
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers.location ?? '').not.toContain('attacker.test');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run apps/api/src/routes/oidc-grants.test.ts`
Expected: FAIL — refresh tokens are not offered, `/oidc/me` is unmounted, logout does not end the Syntra session.

### The one path that does not pass through `authorize()`

`client_credentials` issues a token with no `authorize()` decision behind it, and ruling A2-5 accepts that: the chokepoint exists so that authentication of a *person* has one door, and this grant authenticates a client. There is no subject for a policy to be about — no group membership, no contract, no enrolled factor — and forcing one through would mean inventing a service-account user, a user-shaped principal that no policy meaningfully governs, appearing in the directory, resolvable by assignment, and counted in two other subsystems' guard denominators. That is worse than the exemption.

The exemption is bounded by four things, and all four are implemented in this task:

1. **Per-client opt-in.** `OidcClient.clientCredentialsEnabled`, default false, its own column rather than a member of `grantTypes` so it cannot arrive alongside an unrelated edit to an array. The admin API (Task 17) refuses `client_credentials` in `grantTypes` outright, so the flag is the only way it can be on.
2. **Audited distinctly** as `oidc.client_credentials_authorized`, so "what was issued with no policy decision behind it" is one `grep` rather than an inference.
3. **Scope-separated.** A machine token may not carry `openid`, `profile`, `email` or `offline_access`, so it cannot be presented anywhere a user token is accepted, and UserInfo refuses it because there is no subject.
4. **Documented as the exemption it is** in the README, beside the audit-event list (Task 17).

- [ ] **Step 3: Add the client-credentials guard to `oidc-token.ts`**

Task 12 built the token endpoint with the client-authentication check and the authorization-code decision check. This adds the third arm. It goes in `registerOidcTokenRoutes`, after client authentication has succeeded and before the request is handed on:

```ts
/** The scopes a user token carries. A machine token may never carry one. */
const USER_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

/**
 * The client credentials arm.
 *
 * This grant issues a token with no `authorize()` decision behind it — the one
 * path in the product that does, accepted deliberately by ruling A2-5 because
 * it authenticates a client rather than a person. The exemption is only
 * defensible while it stays bounded, and these are the bounds:
 *
 * - The client must have been enabled for it explicitly. Checked here against
 *   Syntra's own row rather than relying on `oidc-provider`'s `grant_types`,
 *   which is derived from the same flag — two reads of one fact, so a bug in
 *   the derivation fails closed rather than opening the grant.
 * - The requested scopes must not include any a user token carries, so the
 *   result cannot be presented where a user token is accepted.
 * - Whatever is authorized is audited under its own action, so the set of
 *   tokens issued without a policy decision is enumerable.
 *
 * The event records that *Syntra* permitted issuance. `oidc-provider` may
 * still refuse afterwards for a protocol reason — an unregistered scope, a
 * malformed request — so the event means "this passed the checks that stand in
 * for a policy decision", which is exactly the question it exists to answer.
 */
async function guardClientCredentials(
  request: FastifyRequest,
  params: URLSearchParams,
): Promise<{ error: string; error_description: string } | null> {
  const clientId = presentedCredentials(request, params)?.clientId ?? params.get('client_id');
  if (clientId === null || clientId === '') {
    return { error: 'invalid_client', error_description: 'Client authentication failed' };
  }

  const record = await findOidcClient(request.tenantId, clientId);
  if (!record?.clientCredentialsEnabled) {
    return {
      error: 'unauthorized_client',
      error_description: 'This client is not enabled for the client credentials grant',
    };
  }

  const requested = (params.get('scope') ?? '').split(' ').filter((s) => s !== '');
  const overlap = requested.filter((s) => USER_SCOPES.has(s));
  if (overlap.length > 0) {
    return {
      error: 'invalid_scope',
      error_description: `A client credentials token may not carry ${overlap.join(', ')}`,
    };
  }

  await request.db((tx) =>
    recordEvent(tx, {
      // No user. That is the point, and a null actor is the honest record of
      // it rather than an invented service account.
      actorUserId: null,
      action: 'oidc.client_credentials_authorized',
      targetType: 'Application',
      targetId: record.applicationId,
      outcome: 'success',
      sourceIp: request.ip,
      payload: { clientId, scope: requested, noPolicyDecision: true },
    }),
  );
  return null;
}
```

and the call, beside the authorization-code arm:

```ts
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const refusal = await refuseWithoutDecision(request, provider, params);
        if (refusal) return reply.status(400).type('application/json').send(refusal);
      } else if (grantType === 'client_credentials') {
        const refusal = await guardClientCredentials(request, params);
        if (refusal) {
          const status = refusal.error === 'invalid_client' ? 401 : 400;
          return reply.status(status).type('application/json').send(refusal);
        }
      }
```

Add `findOidcClient` and `recordEvent` to the file's imports from `@syntra/core`.

- [ ] **Step 4: Extend the provider configuration**

Add these to the `Configuration` object in `packages/protocols/src/oidc/provider-factory.ts`. They are protocol behaviour rather than route wiring, so they belong beside the rest of it.

```ts
      // A refresh token is issued when the client asked for offline_access and
      // is registered for the grant — the standard's rule, stated explicitly
      // rather than left to a default that has changed between versions.
      issueRefreshToken: async (_ctx, client, code) =>
        client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),

      // Rotate on every use, not on oidc-provider's default 70%-of-lifetime
      // heuristic. Rotation is what makes a leaked refresh token detectable:
      // the legitimate client and the attacker both present the same token,
      // the second presentation is a replay, and oidc-provider revokes the
      // whole grant. A token that is not rotated is a bearer credential valid
      // for two weeks with no way to notice it was copied.
      rotateRefreshToken: true,

      // Syntra's own paths. `end_session` is answered by
      // `registerOidcLogoutRoutes` first — it ends the Syntra session — and
      // then handed on to oidc-provider.
      routes: { end_session: '/session/end', userinfo: '/me' },
```

Client authentication needs **no** change here: Task 11's `registerOidcTokenRoutes` already verifies the presented secret against the stored SHA-256 hash in constant time, before oidc-provider sees the request, and `loadClients` hands oidc-provider a placeholder it never compares. The refresh and client-credentials grants arrive at that same route and are authenticated by that same check.

- [ ] **Step 5: Write `apps/api/src/routes/oidc-logout.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import {
  findOidcClient,
  isRegisteredPostLogoutUri,
  recordEvent,
  resolveSession,
  revokeSession,
} from '@syntra/core';
import { isProtocolEndpoint } from '@syntra/contracts';
import { ProblemError } from '../plugins/problem-json.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { oidcProviderFor, type OidcRouteOptions } from './oidc-op.js';

/**
 * RP-initiated logout.
 *
 * Registered ahead of the catch-all so Syntra's own session is ended before
 * `oidc-provider` handles the OIDC half. Ending only oidc-provider's session
 * would leave the Syntra cookie live: the user would appear signed out of the
 * application and be signed straight back in on the next launch, which is the
 * opposite of what "log me out" means and is the sort of thing a customer
 * finds rather than a test.
 *
 * The post-logout redirect URI is matched exactly against the client's
 * registered list. `oidc-provider` performs the same check, and it is
 * performed here too because this handler answers first and could otherwise
 * become an open redirect on its own.
 */
export async function registerOidcLogoutRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  app.get('/session/end', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const target = query.post_logout_redirect_uri;

    if (target !== undefined) {
      if (!isProtocolEndpoint(target)) {
        throw new ProblemError(400, 'oidc-bad-redirect', 'Unusable post-logout redirect URI');
      }
      const clientId = query.client_id;
      const client = clientId ? await findOidcClient(request.tenantId, clientId) : null;
      // No client id and no id_token_hint means nothing identifies which
      // allowlist to check, so there is no allowlist this can be on.
      if (!client || !isRegisteredPostLogoutUri(client, target)) {
        throw new ProblemError(
          400, 'oidc-bad-redirect',
          'That post-logout redirect URI is not registered for this client',
        );
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = await request.db((tx) => resolveSession(tx, token));
      await request.db(async (tx) => {
        await revokeSession(tx, token);
        if (session) {
          await recordEvent(tx, {
            actorUserId: session.userId,
            action: 'oidc.logout',
            targetType: 'User',
            targetId: session.userId,
            outcome: 'success',
            sourceIp: request.ip,
            payload: { clientId: query.client_id ?? null },
          });
        }
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    }

    // Hand the rest to oidc-provider, which ends its own session and performs
    // the redirect with the state parameter the client sent.
    const provider = await oidcProviderFor(request, options);
    reply.hijack();
    await provider.callback()(request.raw, reply.raw);
  });
}
```

Register it in `app.ts` **before** `registerOidcRoutes`:

```ts
  await app.register(registerOidcInteractionRoutes, { prefix: '/oidc', ...oidcOptions });
  await app.register(registerOidcLogoutRoutes, { prefix: '/oidc', ...oidcOptions });
  await app.register(registerOidcTokenRoutes, { prefix: '/oidc', ...oidcOptions });
  // The catch-all last: every specific route above must be matched first, and
  // this is the only one that hands oidc-provider an unparsed body.
  await app.register(registerOidcRoutes, { prefix: '/oidc', ...oidcOptions });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run apps/api/src/routes/oidc-grants.test.ts`
Expected: PASS, all eleven cases.

**Why these tests are not degenerate.** The rotation case asserts that *both* the replayed original and its replacement stop working — an implementation that rotated but did not revoke the grant on replay passes the first assertion and fails the second, and that second assertion is the whole security value of rotation. The deactivation case proves the token stops working through `findAccount` returning null, which is the only mechanism that ties an OIDC refresh to Syntra's account state; without it a deactivated employee keeps a live refresh token for two weeks. The logout case asserts the *Syntra* session is dead by making a real portal request, not merely that the OIDC endpoint answered. The post-logout case asserts the response is not a redirect to the attacker's URI, so refusing-but-redirecting fails.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/oidc-token.ts apps/api/src/routes/oidc-logout.ts apps/api/src/routes/oidc-grants.test.ts apps/api/src/app.ts packages/protocols/src/oidc/provider-factory.ts
git commit -m "feat(oidc): refresh rotation, bounded client credentials, UserInfo, RP-initiated logout"
```

---

## Task 14: Upstream routing — the policy decides which identity provider a login uses

**Files:**
- Create: `packages/core/src/federation/routing.ts` (pure)
- Create: `packages/core/src/federation/routing.test.ts`
- Modify: `packages/core/src/policy/types.ts`
- Modify: `packages/core/src/policy/policy-service.ts`
- Create: `packages/core/src/federation/upstream-service.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `PolicyRule`, `evaluateIpRanges`, `evaluateTimeWindow`, `loadPolicy`, `addRule`, `assertFactorUsable` from `packages/core/src/policy/`.
- Produces:
  ```ts
  export interface RoutingRule {
    id: string; name: string; enabled: boolean; position: number;
    upstreamIdpId: string;
    applicationIds: string[]; loginDomains: string[];
    ipRanges: string[]; daysOfWeek: number[];
    startMinute: number | null; endMinute: number | null; timezone: string | null;
  }
  export interface RoutingContext { login: string | null; applicationId: string | null; sourceIp: string | null; now: Date }
  export interface RoutingDecision { upstreamIdpId: string; ruleId: string; ruleName: string }
  export function evaluateRouting(rules: RoutingRule[], context: RoutingContext): RoutingDecision | null;
  export interface LoadedPolicy { rules: PolicyRule[]; routes: RoutingRule[]; fallback: PolicyFallback }  // widened
  // Routing rules are written through the existing addRule/updateRule, whose
  // RuleInput.outcome widens to RuleOutcome and gains upstreamIdpId and
  // loginDomains. There is no separate writer.
  export function listUpstreams(tx: TenantClient): Promise<UpstreamIdpRecord[]>;
  export function findUpstream(tenantId: string, id: string): Promise<UpstreamIdpRecord | null>;
  export function findUpstreamBySlug(tenantId: string, slug: string): Promise<UpstreamIdpRecord | null>;
  export function upsertUpstream(tx: TenantClient, provider: MasterKeyProvider, input: UpstreamInput): Promise<UpstreamIdpRecord>;
  export function upstreamClientSecret(tenantId: string, provider: MasterKeyProvider, upstreamId: string): Promise<string | null>;
  ```

### The design decision this task encodes, stated plainly

Spec section 7 says *which upstream a login uses is chosen by the authentication policy*. Taken literally that is circular: the policy engine matches on group membership and contract attributes, and neither is knowable until the user has been identified — but choosing an upstream is precisely the step that happens *before* they are identified.

The resolution is to split the two questions rather than to weaken either:

- **Routing** is a `federate` rule. It matches only on facts available before authentication: the target application, the login identifier's domain, the source address, and the time window. It grants nothing. Its output is "send this browser to Entra ID".
- **Authorization** is `authorize()`, unchanged, entered afterwards with `Principal.external` — the mount point Access I left for exactly this. The full policy runs there, with the user known: group and contract conditions apply, `require_mfa` applies on top of whatever the upstream did, and `deny` refuses.

So a `deny` from routing is not a security control and is never written as one; the security control is the second step, and it is the same one every other path uses. `PolicyOutcome` is **not** widened to include `federate`: `authorize.ts` exhaustively maps `PolicyOutcome` in its `STRENGTH` table, and adding a fifth member there would change the meaning of a floor, of `satisfiesRequirement`, and of the fallback. Instead `loadPolicy` splits the rows, and a test pins that a `federate` row can never reach `evaluatePolicy`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/federation/routing.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { evaluateRouting } from './routing.js';
import type { RoutingContext, RoutingRule } from './routing.js';
import { addRule, loadPolicy } from '../policy/policy-service.js';
import { evaluatePolicy } from '../policy/evaluate.js';

const rule = (over: Partial<RoutingRule>): RoutingRule => ({
  id: 'r1',
  name: 'entra for staff',
  enabled: true,
  position: 1,
  upstreamIdpId: 'up-1',
  applicationIds: [],
  loginDomains: [],
  ipRanges: [],
  daysOfWeek: [],
  startMinute: null,
  endMinute: null,
  timezone: null,
  ...over,
});

const context = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  login: 'jdoe@acme.test',
  applicationId: null,
  sourceIp: '203.0.113.5',
  now: new Date('2024-06-05T10:00:00Z'),
  ...over,
});

describe('evaluateRouting', () => {
  it('returns null when there are no rules, so the login stays local', () => {
    expect(evaluateRouting([], context())).toBeNull();
  });

  it('matches an unconditional rule', () => {
    expect(evaluateRouting([rule({})], context())).toEqual({
      upstreamIdpId: 'up-1', ruleId: 'r1', ruleName: 'entra for staff',
    });
  });

  it('matches on the login domain, case-insensitively, and not on a suffix', () => {
    const rules = [rule({ loginDomains: ['acme.test'] })];
    expect(evaluateRouting(rules, context({ login: 'JDOE@ACME.TEST' }))).not.toBeNull();
    // "notacme.test" ends with "acme.test". A suffix match would federate a
    // stranger's login to this tenant's upstream.
    expect(evaluateRouting(rules, context({ login: 'x@notacme.test' }))).toBeNull();
    expect(evaluateRouting(rules, context({ login: 'nobody' }))).toBeNull();
    expect(evaluateRouting(rules, context({ login: null }))).toBeNull();
  });

  it('matches on the target application', () => {
    const rules = [rule({ applicationIds: ['app-1'] })];
    expect(evaluateRouting(rules, context({ applicationId: 'app-1' }))).not.toBeNull();
    expect(evaluateRouting(rules, context({ applicationId: 'app-2' }))).toBeNull();
    expect(evaluateRouting(rules, context({ applicationId: null }))).toBeNull();
  });

  it('matches on the source address', () => {
    const rules = [rule({ ipRanges: ['203.0.113.0/24'] })];
    expect(evaluateRouting(rules, context({ sourceIp: '203.0.113.5' }))).not.toBeNull();
    expect(evaluateRouting(rules, context({ sourceIp: '198.51.100.1' }))).toBeNull();
  });

  it('does not federate when a condition cannot be evaluated', () => {
    // No source address to test against an address condition. Routing fails
    // towards LOCAL authentication, which is the direction that keeps a user
    // able to sign in — the opposite of a deny rule, and correct here because
    // this decision grants nothing and refusing to route costs a login only
    // if the local password no longer exists.
    const rules = [rule({ ipRanges: ['203.0.113.0/24'] })];
    expect(evaluateRouting(rules, context({ sourceIp: null }))).toBeNull();
    expect(evaluateRouting([rule({ ipRanges: ['not-a-cidr'] })], context())).toBeNull();
  });

  it('takes the first matching rule by position, and skips disabled ones', () => {
    const rules = [
      rule({ id: 'b', position: 2, upstreamIdpId: 'up-2' }),
      rule({ id: 'a', position: 1, upstreamIdpId: 'up-1', enabled: false }),
    ];
    expect(evaluateRouting(rules, context())?.upstreamIdpId).toBe('up-2');
  });

  it('requires every condition a rule sets, not any of them', () => {
    const rules = [rule({ loginDomains: ['acme.test'], applicationIds: ['app-1'] })];
    expect(evaluateRouting(rules, context({ applicationId: 'app-1' }))).not.toBeNull();
    // Domain matches, application does not. Conjunctive, like every other
    // rule in this product.
    expect(evaluateRouting(rules, context({ applicationId: 'app-2' }))).toBeNull();
  });
});

describe('loadPolicy keeps routing rules out of the authorization engine', () => {
  let tenantId: string;
  let upstreamId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    upstreamId = await withTenant(tenantId, async (tx) => {
      const u = await tx.upstreamIdp.create({
        data: { tenantId, slug: 'entra', name: 'Entra ID', protocol: 'oidc' },
      });
      return u.id;
    });
  });

  it('splits federate rows into routes and leaves rules untouched', async () => {
    const loaded = await withTenant(tenantId, async (tx) => {
      await tx.authPolicy.create({ data: { tenantId } });
      await addRule(tx, { name: 'mfa everywhere', outcome: 'require_mfa' });
      const policy = await tx.authPolicy.findFirstOrThrow();
      await tx.authPolicyRule.create({
        data: {
          tenantId, policyId: policy.id, position: 0, name: 'entra',
          outcome: 'federate', upstreamIdpId: upstreamId,
        },
      });
      return loadPolicy(tx);
    });

    expect(loaded.routes.map((r) => r.upstreamIdpId)).toEqual([upstreamId]);
    expect(loaded.rules.map((r) => r.outcome)).toEqual(['require_mfa']);
    // The federate row sits at position 0 — ahead of the MFA rule. If it
    // leaked into `rules` it would be the first match, its outcome would be
    // narrowed to 'deny' by `asOutcome`, and every sign-in would be refused.
    // Or, worse, a future change to asOutcome would make it an allow.
    const decision = evaluatePolicy(loaded.rules, loaded.fallback, {
      userId: 'u1', applicationId: null, groupIds: [], contracts: [],
      sourceIp: null, now: new Date(),
    });
    expect(decision.outcome).toBe('require_mfa');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/core/src/federation/routing.test.ts`
Expected: FAIL — module missing, and `loadPolicy` has no `routes`.

- [ ] **Step 3: Write `routing.ts`**

```ts
import { evaluateIpRanges } from '../policy/ip-match.js';
import { evaluateTimeWindow } from '../policy/time-window.js';

/**
 * A rule that says which upstream identity provider a login goes to.
 *
 * Stored in `AuthPolicyRule` with `outcome = 'federate'` so an administrator
 * sees one ordered list, but loaded into its own type and evaluated by its own
 * function. Its conditions are only the ones knowable before a user has been
 * identified — spec section 8's group and contract conditions are deliberately
 * absent, because at routing time there is no user to look them up for.
 * `policy-service.ts` refuses to save a federate rule that carries one.
 */
export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  upstreamIdpId: string;
  applicationIds: string[];
  /** The domain part of the login identifier, lower case, no leading '@'. */
  loginDomains: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

export interface RoutingContext {
  /** What the user typed. Null when nothing was typed — an app launch. */
  login: string | null;
  applicationId: string | null;
  sourceIp: string | null;
  now: Date;
}

export interface RoutingDecision {
  upstreamIdpId: string;
  ruleId: string;
  ruleName: string;
}

/** The part after the last '@', lower-cased. Null when there is no '@'. */
function loginDomain(login: string | null): string | null {
  if (login === null) return null;
  const at = login.lastIndexOf('@');
  if (at < 0 || at === login.length - 1) return null;
  return login.slice(at + 1).toLowerCase();
}

function matchesDomain(rule: RoutingRule, login: string | null): boolean {
  if (rule.loginDomains.length === 0) return true;
  const domain = loginDomain(login);
  if (domain === null) return false;
  // Exact equality on the whole domain label set. A suffix match would send
  // `x@notacme.test` to acme's upstream, which hands a stranger's browser to
  // a tenant's identity provider and leaks the tenant's federation topology.
  return rule.loginDomains.some((allowed) => allowed.toLowerCase() === domain);
}

function matchesApplication(rule: RoutingRule, applicationId: string | null): boolean {
  if (rule.applicationIds.length === 0) return true;
  if (applicationId === null) return false;
  return rule.applicationIds.includes(applicationId);
}

/**
 * Picks the upstream for a login that has not happened yet, or null for local
 * authentication.
 *
 * Pure, like `evaluatePolicy`, and for the same reason.
 *
 * **An undecidable condition means no match.** This is the opposite of
 * `ruleMatches`'s treatment of a `deny` rule, and deliberately so: routing
 * grants nothing, so failing towards "do not federate" leaves the user at the
 * local login screen rather than at a provider whose conditions could not be
 * checked. A tenant whose users have no local password sees a failed login
 * rather than a wrongly-routed one, and a failed login is visible.
 *
 * **This function never authorizes anything.** Its result decides where the
 * browser goes. Whether the person who comes back may have a session is
 * `authorize()`'s decision and nothing here anticipates it.
 */
export function evaluateRouting(
  rules: RoutingRule[],
  context: RoutingContext,
): RoutingDecision | null {
  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.position - b.position);

  for (const rule of ordered) {
    if (!matchesApplication(rule, context.applicationId)) continue;
    if (!matchesDomain(rule, context.login)) continue;
    if (evaluateIpRanges(context.sourceIp, rule.ipRanges) !== 'match') continue;
    if (evaluateTimeWindow(rule, context.now) !== 'match') continue;

    return { upstreamIdpId: rule.upstreamIdpId, ruleId: rule.id, ruleName: rule.name };
  }

  return null;
}
```

> `evaluateIpRanges` and `evaluateTimeWindow` return `'match' | 'no-match' | 'unevaluable'`; comparing against `'match'` is what makes `unevaluable` fail towards local, per the paragraph above. `evaluateTimeWindow` takes an object with `daysOfWeek`, `startMinute`, `endMinute` and `timezone`, which `RoutingRule` carries with the same names — no adapter is needed.

- [ ] **Step 4: Widen `loadPolicy`**

In `packages/core/src/policy/policy-service.ts`, add `upstreamIdpId: string | null` and `loginDomains: string[]` to `RuleRow`, change `LoadedPolicy`, and split the rows:

```ts
export interface LoadedPolicy {
  rules: PolicyRule[];
  /** Rows whose outcome is 'federate'. Never seen by evaluatePolicy. */
  routes: RoutingRule[];
  fallback: PolicyFallback;
}

function toRoute(row: RuleRow): RoutingRule | null {
  if (!row.upstreamIdpId) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    upstreamIdpId: row.upstreamIdpId,
    applicationIds: row.applicationIds,
    loginDomains: row.loginDomains,
    ipRanges: row.ipRanges,
    daysOfWeek: row.daysOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: row.timezone,
  };
}

export async function loadPolicy(tx: TenantClient): Promise<LoadedPolicy> {
  const policy = await tx.authPolicy.findFirst();
  if (!policy) {
    return { rules: [], routes: [], fallback: { outcome: 'allow', factorType: null } };
  }

  const rows = await tx.authPolicyRule.findMany({
    where: { policyId: policy.id },
    orderBy: { position: 'asc' },
  });

  // The split. A federate row must never reach evaluatePolicy: `asOutcome`
  // would narrow its unknown outcome to 'deny', and a routing rule sitting at
  // position 0 would then refuse every sign-in in the tenant.
  const federate = rows.filter((row) => row.outcome === 'federate');
  const authorization = rows.filter((row) => row.outcome !== 'federate');

  const outcome = asOutcome(policy.defaultOutcome);
  return {
    rules: authorization.map(toRule),
    routes: federate.map(toRoute).filter((route): route is RoutingRule => route !== null),
    fallback: {
      outcome,
      factorType: outcome === 'require_factor' ? asFactor(policy.defaultFactorType) : null,
    },
  };
}
```

Extend `validate()` in the same file:

```ts
  if (input.outcome === 'federate') {
    if (!input.upstreamIdpId) {
      throw new Error('upstreamIdpId is required when the outcome is federate');
    }
    if (input.groupIds && input.groupIds.length > 0) {
      throw new Error(
        'a federate rule cannot match on group membership: the upstream is chosen before the user is known',
      );
    }
    if (input.contractField) {
      throw new Error(
        'a federate rule cannot match on a contract attribute: the upstream is chosen before the user is known',
      );
    }
    if (input.factorType) {
      throw new Error(
        'a federate rule cannot require a factor: requirements are decided by authorize() after the upstream returns',
      );
    }
  } else if (input.upstreamIdpId) {
    throw new Error('upstreamIdpId is only meaningful on a federate rule');
  }
```

Add `'federate'` to the `RuleInput['outcome']` union as a separate type — **not** to `POLICY_OUTCOMES`, which `asOutcome` and `authorize.ts` both read:

```ts
// packages/core/src/policy/types.ts
/** What a stored rule row may say. A superset of PolicyOutcome. */
export type RuleOutcome = PolicyOutcome | 'federate';
export const RULE_OUTCOMES: RuleOutcome[] = [...POLICY_OUTCOMES, 'federate'];
```

and change `RuleInput.outcome` to `RuleOutcome`, adding `upstreamIdpId?: string | null | undefined` and `loginDomains?: string[] | undefined` (the latter written through `data()` alongside the other array fields). `PolicyOutcome`, `POLICY_OUTCOMES`, `asOutcome` and every use in `authorize.ts` and `evaluate.ts` are untouched.

- [ ] **Step 5: Write `upstream-service.ts`**

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

export type UpstreamProtocol = 'saml' | 'oidc';

export interface UpstreamIdpRecord {
  id: string;
  slug: string;
  name: string;
  protocol: UpstreamProtocol;
  enabled: boolean;
  issuerUrl: string | null;
  clientId: string | null;
  scopes: string[];
  idpEntityId: string | null;
  ssoUrl: string | null;
  idpSloUrl: string | null;
  ssoBinding: 'HTTP-Redirect' | 'HTTP-POST';
  idpCertificates: string[];
  wantAssertionsSigned: boolean;
  loginAttribute: string;
  emailAttribute: string;
  displayNameAttribute: string;
  groupsAttribute: string | null;
  createUsers: boolean;
  refreshOnLogin: boolean;
  defaultOrgUnitId: string | null;
}

const toRecord = (row: Record<string, unknown>): UpstreamIdpRecord => ({
  id: row.id as string,
  slug: row.slug as string,
  name: row.name as string,
  protocol: row.protocol === 'saml' ? 'saml' : 'oidc',
  enabled: row.enabled as boolean,
  issuerUrl: (row.issuerUrl as string | null) ?? null,
  clientId: (row.clientId as string | null) ?? null,
  scopes: row.scopes as string[],
  idpEntityId: (row.idpEntityId as string | null) ?? null,
  ssoUrl: (row.ssoUrl as string | null) ?? null,
  idpSloUrl: (row.idpSloUrl as string | null) ?? null,
  ssoBinding: row.ssoBinding === 'HTTP-POST' ? 'HTTP-POST' : 'HTTP-Redirect',
  idpCertificates: row.idpCertificates as string[],
  wantAssertionsSigned: row.wantAssertionsSigned as boolean,
  loginAttribute: row.loginAttribute as string,
  emailAttribute: row.emailAttribute as string,
  displayNameAttribute: row.displayNameAttribute as string,
  groupsAttribute: (row.groupsAttribute as string | null) ?? null,
  createUsers: row.createUsers as boolean,
  refreshOnLogin: row.refreshOnLogin as boolean,
  defaultOrgUnitId: (row.defaultOrgUnitId as string | null) ?? null,
});

export type UpstreamInput = Omit<UpstreamIdpRecord, 'id'> & {
  /** Written to the vault, never to a column. */
  clientSecret?: string | undefined;
};

export async function upsertUpstream(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: UpstreamInput,
): Promise<UpstreamIdpRecord> {
  const tenantId = await currentTenant(tx);
  const { clientSecret, ...fields } = input;
  const secretName = `upstream:${input.slug}:client_secret`;

  if (clientSecret !== undefined) {
    // AES-GCM wrapping only — microseconds, so it belongs inside the same
    // transaction as the row that names it. A row naming a secret that was
    // never written is an upstream that cannot complete a token exchange.
    await putSecret(tx, provider, secretName, clientSecret);
  }

  const row = await tx.upstreamIdp.upsert({
    where: { tenantId_slug: { tenantId, slug: input.slug } },
    create: {
      tenantId,
      ...fields,
      ...(clientSecret !== undefined ? { clientSecretName: secretName } : {}),
    },
    update: {
      ...fields,
      ...(clientSecret !== undefined ? { clientSecretName: secretName } : {}),
    },
  });
  return toRecord(row as unknown as Record<string, unknown>);
}

export async function listUpstreams(tx: TenantClient): Promise<UpstreamIdpRecord[]> {
  const rows = await tx.upstreamIdp.findMany({ orderBy: { name: 'asc' } });
  return rows.map((row) => toRecord(row as unknown as Record<string, unknown>));
}

export async function findUpstream(
  tenantId: string,
  id: string,
): Promise<UpstreamIdpRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.upstreamIdp.findFirst({ where: { id, enabled: true } });
    return row ? toRecord(row as unknown as Record<string, unknown>) : null;
  });
}

export async function findUpstreamBySlug(
  tenantId: string,
  slug: string,
): Promise<UpstreamIdpRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.upstreamIdp.findFirst({ where: { slug, enabled: true } });
    return row ? toRecord(row as unknown as Record<string, unknown>) : null;
  });
}

/** Internal only. No route returns this value. */
export async function upstreamClientSecret(
  tenantId: string,
  provider: MasterKeyProvider,
  upstreamId: string,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.upstreamIdp.findUnique({ where: { id: upstreamId } });
    if (!row?.clientSecretName) return null;
    return getSecret(tx, provider, row.clientSecretName);
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/federation/routing.test.ts packages/core/src/policy`
Expected: PASS — including every existing policy test, which must be unaffected.

**Why these tests are not degenerate.** The `loadPolicy` case puts the federate row at **position 0**, ahead of the authorization rule, and asserts the resulting decision is `require_mfa` — an implementation that failed to split the rows would evaluate the federate row first, `asOutcome` would narrow it to `deny`, and the assertion would fail with a `deny`. The domain case includes `notacme.test`, which a `endsWith` implementation accepts. The undecidable case asserts `null` in both directions (no address, and a malformed range), which is the opposite of what `ruleMatches` does for a deny rule — an implementer copying that function wholesale fails here.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/federation packages/core/src/policy packages/core/src/index.ts packages/db/prisma/schema.prisma
git commit -m "feat(core): upstream routing rules, evaluated before the user is known"
```

---

## Task 15: Upstream OIDC — Syntra as a relying party, with just-in-time provisioning through `authorize()`

**Files:**
- Create: `packages/core/src/federation/federation-request-service.ts`
- Create: `packages/core/src/federation/jit-service.ts`
- Create: `packages/core/src/federation/jit-service.test.ts`
- Create: `packages/protocols/src/upstream/oidc-client.ts`
- Create: `apps/api/src/routes/federation.ts`
- Create: `apps/api/src/routes/federation-oidc.test.ts`
- Modify: `apps/api/src/app.ts`, `packages/core/src/index.ts`, `packages/protocols/src/index.ts`, `packages/protocols/package.json`

**Interfaces:**
- Consumes: `classifyAddress` (Task 2); `evaluateRouting`, `loadPolicy`, `findUpstream`, `upstreamClientSecret` (Task 14); `authorize`, `createUser`, `updateUser`, `deactivateUser`, `recordEvent`, `putSecret`, `getSecret` from `@syntra/core`; `issueSession` from `apps/api/src/routes/session-reply.js`; `tenantProtocolIdentity`, `assertProtocolHost` (Task 2).
- Produces:
  ```ts
  // @syntra/core
  export interface FederationTicket { id: string; state: string; nonce: string | null; verifierName: string | null; upstreamIdpId: string; returnTo: string; applicationId: string | null }
  export function openFederationRequest(tenantId, input: { upstreamIdpId: string; returnTo: string; applicationId: string | null; nonce?: string; verifier?: string; provider?: MasterKeyProvider; ttlMs?: number }): Promise<FederationTicket>;
  export function takeFederationRequest(tenantId, state: string, provider: MasterKeyProvider, now?: Date): Promise<(FederationTicket & { verifier: string | null }) | null>;

  export interface UpstreamProfile { subject: string; login: string | null; email: string | null; displayName: string | null; groups: string[] }
  export function linkOrProvision(tenantId: string, upstream: UpstreamIdpRecord, profile: UpstreamProfile): Promise<{ userId: string; created: boolean } | { userId: null; reason: 'no_local_user' | 'incomplete_profile' }>;

  // @syntra/protocols
  export function upstreamOidcConfig(upstream: { issuerUrl: string; clientId: string }, clientSecret: string | null, outbound: { allowPrivateAddresses: boolean }): Promise<Configuration>;
  export function upstreamAuthorizationUrl(config, input: { redirectUri: string; scopes: string[]; state: string; nonce: string; codeChallenge: string }): URL;
  export function upstreamExchange(config, currentUrl: URL, checks: { verifier: string; state: string; nonce: string }): Promise<{ claims: Record<string, unknown>; accessToken: string }>;
  ```

- [ ] **Step 1: Write the failing JIT test**

Create `packages/core/src/federation/jit-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { upsertUpstream } from './upstream-service.js';
import { linkOrProvision } from './jit-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import type { UpstreamIdpRecord } from './upstream-service.js';

const keyProvider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let upstream: UpstreamIdpRecord;

const base = {
  slug: 'entra', name: 'Entra ID', protocol: 'oidc' as const, enabled: true,
  issuerUrl: 'https://login.example/entra', clientId: 'syntra',
  scopes: ['openid', 'profile', 'email'],
  idpEntityId: null, ssoUrl: null, idpSloUrl: null,
  ssoBinding: 'HTTP-Redirect' as const, idpCertificates: [], wantAssertionsSigned: true,
  loginAttribute: 'preferred_username', emailAttribute: 'email',
  displayNameAttribute: 'name', groupsAttribute: null,
  createUsers: true, refreshOnLogin: true, defaultOrgUnitId: null,
};

const profile = (over: Record<string, unknown> = {}) => ({
  subject: 'upstream-sub-1',
  login: 'jdoe@acme.test',
  email: 'jdoe@acme.test',
  displayName: 'J Doe',
  groups: [],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  upstream = await withTenant(tenantId, (tx) => upsertUpstream(tx, keyProvider, base));
});

describe('linkOrProvision', () => {
  it('creates a local user on first login and marks the password as upstream', async () => {
    const result = await linkOrProvision(tenantId, upstream, profile());
    expect(result).toMatchObject({ created: true });

    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: (result as { userId: string }).userId } }),
    );
    expect(user.login).toBe('jdoe@acme.test');
    expect(user.displayName).toBe('J Doe');
    // Self-service reset must send them to the upstream, not mail a token.
    expect(user.passwordSource).toBe('upstream');
    expect(user.passwordSourceHint).toBe('Entra ID');
  });

  it('finds the same user again by upstream subject, not by email', async () => {
    const first = await linkOrProvision(tenantId, upstream, profile());
    // The upstream renamed them. A lookup by email would create a second
    // account; a lookup by subject is the whole reason UpstreamLink exists.
    const second = await linkOrProvision(
      tenantId, upstream,
      profile({ email: 'jane.doe@acme.test', login: 'jane.doe@acme.test', displayName: 'Jane Doe' }),
    );
    expect(second).toMatchObject({ userId: (first as { userId: string }).userId, created: false });

    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe('jane.doe@acme.test');
    expect(users[0]!.displayName).toBe('Jane Doe');
  });

  it('leaves the local user alone when refreshOnLogin is off', async () => {
    const noRefresh = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, refreshOnLogin: false }),
    );
    await linkOrProvision(tenantId, noRefresh, profile());
    await linkOrProvision(tenantId, noRefresh, profile({ displayName: 'Renamed' }));
    const users = await prisma.user.findMany();
    expect(users[0]!.displayName).toBe('J Doe');
  });

  it('refuses to create a user when createUsers is off, and reports why', async () => {
    const noCreate = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, keyProvider, { ...base, createUsers: false }),
    );
    expect(await linkOrProvision(tenantId, noCreate, profile())).toEqual({
      userId: null, reason: 'no_local_user',
    });
    expect(await prisma.user.findMany()).toHaveLength(0);
  });

  it('links an existing local account by login when the subject is new', async () => {
    const existing = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe@acme.test', email: 'x@acme.test', displayName: 'Old' }),
    );
    const result = await linkOrProvision(tenantId, upstream, profile());
    expect(result).toMatchObject({ userId: existing.id, created: false });
    const links = await prisma.upstreamLink.findMany();
    expect(links).toHaveLength(1);
    expect(links[0]!.subject).toBe('upstream-sub-1');
  });

  it('refuses a profile with no usable login identifier rather than inventing one', async () => {
    expect(await linkOrProvision(tenantId, upstream, profile({ login: null, email: null })))
      .toEqual({ userId: null, reason: 'incomplete_profile' });
    expect(await prisma.user.findMany()).toHaveLength(0);
  });

  it('does not reactivate a deactivated account', async () => {
    const result = await linkOrProvision(tenantId, upstream, profile());
    const userId = (result as { userId: string }).userId;
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left the company'));

    const again = await linkOrProvision(tenantId, upstream, profile());
    // The link still resolves, and the account is returned as it is. Nothing
    // here reactivates it — `authorize()` refuses an inactive user, which is
    // the correct place for that decision and the only place it is made. An
    // offboarded employee who still holds an upstream account must not be
    // signed back in by their own login.
    expect(again).toMatchObject({ userId, created: false });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe('inactive');
  });

  it('keeps two tenants apart even when the upstream subject is identical', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    const otherUpstream = await withTenant(other.id, (tx) =>
      upsertUpstream(tx, keyProvider, base),
    );
    const a = await linkOrProvision(tenantId, upstream, profile());
    const b = await linkOrProvision(other.id, otherUpstream, profile());
    expect((a as { userId: string }).userId).not.toBe((b as { userId: string }).userId);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/core/src/federation/jit-service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `jit-service.ts`**

```ts
import { withTenant } from '@syntra/db';
import { createUser } from '../directory/user-service.js';
import type { UpstreamIdpRecord } from './upstream-service.js';

export interface UpstreamProfile {
  /** The upstream `sub` or SAML NameID. The identity, not the attributes. */
  subject: string;
  login: string | null;
  email: string | null;
  displayName: string | null;
  groups: string[];
}

export type ProvisionResult =
  | { userId: string; created: boolean }
  | { userId: null; reason: 'no_local_user' | 'incomplete_profile' };

/**
 * Turns an upstream identity into a local `User`, creating one on first login
 * and refreshing the mapped attributes on later ones.
 *
 * **The subject is the identity; everything else is an attribute.** A
 * returning user is found through `UpstreamLink`, never by matching the email
 * address the upstream sent — an upstream that renames a mailbox would
 * otherwise create a second account on the next login, and an upstream that
 * can be talked into asserting somebody else's email would take over their
 * Syntra account. Matching by login happens exactly once, when a subject is
 * seen for the first time and a local account of that name already exists,
 * which is the migration case a tenant switching to federation needs.
 *
 * **It grants nothing.** It returns a user id. Whether that user may have a
 * session is `authorize()`'s decision, made afterwards with
 * `Principal.external`. In particular this function does not reactivate a
 * deactivated account: an offboarded employee whose upstream account still
 * works must not sign themselves back in, and `authorize()` refuses an
 * inactive user in one place for every path.
 */
export async function linkOrProvision(
  tenantId: string,
  upstream: UpstreamIdpRecord,
  profile: UpstreamProfile,
): Promise<ProvisionResult> {
  return withTenant(tenantId, async (tx): Promise<ProvisionResult> => {
    const link = await tx.upstreamLink.findFirst({
      where: { upstreamIdpId: upstream.id, subject: profile.subject },
    });

    if (link) {
      if (upstream.refreshOnLogin) {
        await tx.user.update({
          where: { id: link.userId },
          data: {
            ...(profile.email ? { email: profile.email } : {}),
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
          },
        });
      }
      await tx.upstreamLink.update({
        where: { id: link.id },
        data: { lastLoginAt: new Date() },
      });
      return { userId: link.userId, created: false };
    }

    const login = profile.login ?? profile.email;
    if (!login) return { userId: null, reason: 'incomplete_profile' };

    // First time this subject has been seen. An account already carrying the
    // login is adopted — the migration case — and otherwise one is created if
    // the tenant permits it.
    const existing = await tx.user.findFirst({ where: { login } });

    let userId: string;
    let created = false;

    if (existing) {
      userId = existing.id;
    } else {
      if (!upstream.createUsers) return { userId: null, reason: 'no_local_user' };
      const user = await createUser(tx, {
        login,
        email: profile.email ?? login,
        displayName: profile.displayName ?? login,
        ...(upstream.defaultOrgUnitId ? { orgUnitId: upstream.defaultOrgUnitId } : {}),
      });
      userId = user.id;
      created = true;
    }

    // The password lives upstream, so self-service reset must send them there
    // rather than mailing a token for a credential Syntra does not hold.
    await tx.user.update({
      where: { id: userId },
      data: { passwordSource: 'upstream', passwordSourceHint: upstream.name },
    });

    await tx.upstreamLink.create({
      data: {
        tenantId,
        upstreamIdpId: upstream.id,
        userId,
        subject: profile.subject,
        lastLoginAt: new Date(),
      },
    });

    return { userId, created };
  });
}
```

- [ ] **Step 4: Write `federation-request-service.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { withTenant } from '@syntra/db';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

export interface FederationTicket {
  id: string;
  state: string;
  nonce: string | null;
  upstreamIdpId: string;
  returnTo: string;
  applicationId: string | null;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Opens one in-flight upstream login.
 *
 * The PKCE verifier goes into the vault rather than a column: it is a
 * short-lived secret whose disclosure lets anyone holding a stolen
 * authorization code complete the exchange, and the vault is where this
 * codebase puts secrets. The row holds its name.
 *
 * `returnTo` is stored, not carried through the browser, and Task 15's route
 * refuses to store anything but a same-origin path — an open redirect through
 * a federation callback is the classic one.
 */
export async function openFederationRequest(
  tenantId: string,
  input: {
    upstreamIdpId: string;
    returnTo: string;
    applicationId: string | null;
    nonce?: string | undefined;
    verifier?: string | undefined;
    provider?: MasterKeyProvider | undefined;
    ttlMs?: number | undefined;
  },
): Promise<FederationTicket> {
  const state = randomBytes(32).toString('base64url');
  const verifierName = input.verifier ? `federation:${state}:verifier` : null;

  return withTenant(tenantId, async (tx) => {
    if (input.verifier && input.provider) {
      await putSecret(tx, input.provider, verifierName!, input.verifier);
    }
    const row = await tx.federationRequest.create({
      data: {
        tenantId,
        upstreamIdpId: input.upstreamIdpId,
        state,
        nonce: input.nonce ?? null,
        verifierName,
        returnTo: input.returnTo,
        applicationId: input.applicationId,
        expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    });
    return {
      id: row.id,
      state: row.state,
      nonce: row.nonce,
      upstreamIdpId: row.upstreamIdpId,
      returnTo: row.returnTo,
      applicationId: row.applicationId,
    };
  });
}

/**
 * Spends the in-flight request and returns it, or null.
 *
 * Single-use, decided by the `updateMany` count rather than by a read
 * followed by a write. Two callbacks arriving with the same state — a user
 * double-clicking, or an attacker replaying a captured redirect — produce one
 * winner and one null. This is the replay defence; `state` matching alone is
 * only a CSRF defence.
 */
export async function takeFederationRequest(
  tenantId: string,
  state: string,
  provider: MasterKeyProvider,
  now: Date = new Date(),
): Promise<(FederationTicket & { verifier: string | null }) | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.federationRequest.findFirst({
      where: { state, consumedAt: null, expiresAt: { gt: now } },
    });
    if (!row) return null;

    const claimed = await tx.federationRequest.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return null;

    const verifier = row.verifierName
      ? await getSecret(tx, provider, row.verifierName)
      : null;

    return {
      id: row.id,
      state: row.state,
      nonce: row.nonce,
      upstreamIdpId: row.upstreamIdpId,
      returnTo: row.returnTo,
      applicationId: row.applicationId,
      verifier,
    };
  });
}
```

- [ ] **Step 5: Write `packages/protocols/src/upstream/oidc-client.ts`**

```ts
import * as client from 'openid-client';
import { classifyAddress } from '@syntra/core';

/**
 * Discovers an upstream provider and builds a client configuration.
 *
 * `openid-client` v6 is functional, not the v5 class API: `discovery()`
 * fetches `.well-known/openid-configuration`, validates the issuer, and
 * returns a `Configuration` every other call takes as its first argument.
 *
 * This performs a network fetch, so it is called outside every transaction —
 * Global Constraint 1, and this is the exact shape that violated it before:
 * an HTTP round trip to a third party, on a link Syntra does not control,
 * inside a 5000 ms transaction budget.
 */
export async function upstreamOidcConfig(
  upstream: { issuerUrl: string; clientId: string },
  clientSecret: string | null,
  outbound: { allowPrivateAddresses: boolean },
): Promise<client.Configuration> {
  return client.discovery(
    new URL(upstream.issuerUrl),
    upstream.clientId,
    undefined,
    clientSecret === null ? client.None() : client.ClientSecretBasic(clientSecret),
    {
      // Discovery, the JWKS fetch and the token exchange all go through this,
      // and the issuer URL came from an administrator. Same guard as metadata
      // import (Task 2) and the same switch: a self-hosted
      // deployment federating to an on-premises provider sets
      // OUTBOUND_ALLOW_PRIVATE, and one that has not set it does not reach its
      // own network by accident.
      [client.customFetch]: guardedFetch(outbound.allowPrivateAddresses),
      ...(outbound.allowPrivateAddresses ? { execute: [client.allowInsecureRequests] } : {}),
    },
  );
}

/**
 * `fetch`, refusing any host that resolves inside the deployment.
 *
 * `classifyAddress` is the same classifier `fetchExternalDocument` uses, so
 * there is one answer in the codebase to "may this address be reached". This
 * wrapper checks and then delegates to the platform fetch rather than pinning
 * the connection the way `fetchExternalDocument` does — `openid-client` needs
 * a `fetch`, and rebuilding its request against a literal address would mean
 * reimplementing it. The residual rebinding window is accepted here and not
 * there: discovery is long-lived configuration an administrator set up
 * deliberately, and its response is not echoed back to them.
 */
function guardedFetch(allowPrivateAddresses: boolean): typeof fetch {
  if (allowPrivateAddresses) return fetch;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const { lookup } = await import('node:dns/promises');
    const resolved = await lookup(url.hostname, { all: true });
    for (const entry of resolved) {
      if (classifyAddress(entry.address) === 'blocked') {
        throw new Error(
          `${url.hostname} resolves to ${entry.address}, which is inside this deployment's own network. ` +
            'Set OUTBOUND_ALLOW_PRIVATE=true if that is intended.',
        );
      }
    }
    return fetch(input, init);
  };
}

export function upstreamAuthorizationUrl(
  config: client.Configuration,
  input: {
    redirectUri: string;
    scopes: string[];
    state: string;
    nonce: string;
    codeChallenge: string;
  },
): URL {
  return client.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
}

export const newVerifier = client.randomPKCECodeVerifier;
export const challengeFor = client.calculatePKCECodeChallenge;
export const newNonce = client.randomNonce;

/**
 * Exchanges the code and returns the verified id_token claims.
 *
 * `state`, `nonce` and the PKCE verifier are all passed as expectations rather
 * than checked afterwards: `authorizationCodeGrant` refuses the exchange if
 * any of them fails, and a check that happens inside the library cannot be
 * forgotten by a caller. The claims come out of a signature the library
 * verified against the upstream's JWKS.
 */
export async function upstreamExchange(
  config: client.Configuration,
  currentUrl: URL,
  checks: { verifier: string; state: string; nonce: string },
): Promise<{ claims: Record<string, unknown>; accessToken: string }> {
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: checks.verifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('upstream returned no id_token');
  return { claims: claims as Record<string, unknown>, accessToken: tokens.access_token };
}

/** UserInfo, for an upstream whose id_token carries a thin claim set. */
export async function upstreamUserInfo(
  config: client.Configuration,
  accessToken: string,
  expectedSubject: string,
): Promise<Record<string, unknown>> {
  return (await client.fetchUserInfo(config, accessToken, expectedSubject)) as Record<
    string,
    unknown
  >;
}
```

Add `"openid-client": "6.8.5"` to `packages/protocols/package.json` (already listed in Task 5) and export the module from `packages/protocols/src/index.ts`.

- [ ] **Step 6: Write `apps/api/src/routes/federation.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import {
  authorize,
  findUpstream,
  linkOrProvision,
  loadPolicy,
  localMasterKeyProvider,
  openFederationRequest,
  recordEvent,
  takeFederationRequest,
  evaluateRouting,
  upstreamClientSecret,
  type UpstreamIdpRecord,
} from '@syntra/core';
import {
  challengeFor,
  newNonce,
  newVerifier,
  upstreamAuthorizationUrl,
  upstreamExchange,
  upstreamOidcConfig,
} from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';
import { tenantRelyingParty } from './relying-party.js';
import { issueSession } from './session-reply.js';

export interface FederationRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
  /** From `OUTBOUND_ALLOW_PRIVATE`. See Task 2. */
  outboundAllowPrivate: boolean;
}

/**
 * Where the browser may be sent back to after federation.
 *
 * A path on this origin and nothing else. A callback that redirects to
 * whatever `returnTo` said is an open redirect on an endpoint an attacker can
 * aim at any user, and it is the specific bug that turns a federation flow
 * into a phishing tool. Protocol-relative (`//evil.test`) and backslash forms
 * are rejected explicitly because `new URL('//evil.test', base)` resolves to
 * the attacker's host.
 */
function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

export async function registerFederationRoutes(
  app: FastifyInstance,
  options: FederationRouteOptions,
): Promise<void> {
  const rateLimited = {
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };
  const keyProvider = () => localMasterKeyProvider(options.masterKey);

  /**
   * Asks the policy which upstream this login uses, and starts it.
   *
   * The routing rules decide — spec section 7 — and they decide on facts
   * available before the user is known. Nothing here authorizes anything; the
   * decision that matters is `authorize()` in the callback below.
   */
  app.get('/start', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const query = request.query as Record<string, string | undefined>;
    const returnTo = safeReturnTo(query.next);

    const { routes } = await request.db((tx) => loadPolicy(tx));
    const routed = evaluateRouting(routes, {
      login: query.login ?? null,
      applicationId: query.applicationId ?? null,
      sourceIp: request.ip,
      now: new Date(),
    });
    if (!routed) {
      // No rule matched. Local authentication, which is the default and is
      // never an error.
      return reply.redirect(`/login?next=${encodeURIComponent(returnTo)}`, 302);
    }

    const upstream = await findUpstream(request.tenantId, routed.upstreamIdpId);
    if (!upstream || upstream.protocol !== 'oidc') {
      throw new ProblemError(409, 'federation-misconfigured', 'That identity provider is not usable');
    }
    if (!upstream.issuerUrl || !upstream.clientId) {
      throw new ProblemError(409, 'federation-misconfigured', 'That identity provider is not configured');
    }

    // Network I/O, outside every transaction.
    const secret = await upstreamClientSecret(request.tenantId, keyProvider(), upstream.id);
    const config = await upstreamOidcConfig(
      { issuerUrl: upstream.issuerUrl, clientId: upstream.clientId },
      secret,
      { allowPrivateAddresses: options.outboundAllowPrivate },
    );

    const verifier = newVerifier();
    const nonce = newNonce();
    const ticket = await openFederationRequest(request.tenantId, {
      upstreamIdpId: upstream.id,
      returnTo,
      applicationId: query.applicationId ?? null,
      nonce,
      verifier,
      provider: keyProvider(),
    });

    const url = upstreamAuthorizationUrl(config, {
      // The redirect URI is built from the tenant's own identity, so the
      // upstream sends the code back to Syntra's real host rather than to
      // whatever the Host header said.
      redirectUri: `${identity.base}/federation/oidc/callback`,
      scopes: upstream.scopes,
      state: ticket.state,
      nonce,
      codeChallenge: await challengeFor(verifier),
    });

    return reply.redirect(url.href, 302);
  });

  app.get('/oidc/callback', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const query = request.query as Record<string, string | undefined>;
    if (typeof query.state !== 'string') {
      throw new ProblemError(400, 'federation-bad-callback', 'Missing state');
    }

    // Single-use. A replayed callback finds nothing.
    const ticket = await takeFederationRequest(request.tenantId, query.state, keyProvider());
    if (!ticket) {
      throw new ProblemError(400, 'federation-bad-callback', 'That sign-in has expired or was already used');
    }

    const upstream = await findUpstream(request.tenantId, ticket.upstreamIdpId);
    if (!upstream?.issuerUrl || !upstream.clientId || !ticket.verifier || !ticket.nonce) {
      throw new ProblemError(409, 'federation-misconfigured', 'That identity provider is not usable');
    }

    const secret = await upstreamClientSecret(request.tenantId, keyProvider(), upstream.id);
    const config = await upstreamOidcConfig(
      { issuerUrl: upstream.issuerUrl, clientId: upstream.clientId },
      secret,
      { allowPrivateAddresses: options.outboundAllowPrivate },
    );

    // The exchange verifies the id_token signature against the upstream's
    // JWKS and checks state, nonce and the PKCE verifier. All network work,
    // all outside any transaction.
    const { claims } = await upstreamExchange(
      config,
      new URL(request.raw.url ?? '', identity.base),
      { verifier: ticket.verifier, state: ticket.state, nonce: ticket.nonce },
    );

    const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
    const provisioned = await linkOrProvision(request.tenantId, upstream, {
      subject: String(claims.sub),
      login: str(claims[upstream.loginAttribute]),
      email: str(claims[upstream.emailAttribute]),
      displayName: str(claims[upstream.displayNameAttribute]),
      groups: upstream.groupsAttribute && Array.isArray(claims[upstream.groupsAttribute])
        ? (claims[upstream.groupsAttribute] as unknown[]).filter(
            (g): g is string => typeof g === 'string',
          )
        : [],
    });

    if (provisioned.userId === null) {
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'federation.provision_refused',
          targetType: 'UpstreamIdp',
          targetId: upstream.id,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { reason: provisioned.reason, subject: String(claims.sub) },
        }),
      );
      throw new ProblemError(
        403, 'federation-no-account',
        provisioned.reason === 'no_local_user'
          ? 'You signed in successfully, but this organization has no account for you. Ask an administrator to create one.'
          : 'That identity provider did not send enough information to identify you.',
      );
    }

    // THE CHOKEPOINT. The upstream asserted who they are; whether they may
    // have a Syntra session is decided here, with the full policy — including
    // a second factor on top of the upstream, and including deny. Nothing
    // above this line mints anything.
    const decision = await authorize(request.tenantId, {
      kind: 'primary',
      principal: {
        kind: 'external',
        userId: provisioned.userId,
        // Goes into the audit event, so a decision traces back to who
        // vouched for the identity.
        issuer: upstream.issuerUrl,
      },
      applicationId: ticket.applicationId,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
      scope: 'portal',
    });

    if (decision.status === 'deny') {
      throw new ProblemError(403, 'federation-denied', 'Sign-in refused');
    }

    if (decision.status === 'challenge' || decision.status === 'enrol') {
      const next = encodeURIComponent(ticket.returnTo);
      const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
      return reply.redirect(
        `${path}?attempt=${encodeURIComponent(decision.attemptToken)}&next=${next}`,
        302,
      );
    }

    // `issueSession` takes the allow object and nothing else, so this cannot
    // mint a session for a user the decision did not name.
    await issueSession(request, reply, decision);
    return reply.redirect(ticket.returnTo, 302);
  });
}
```

Register in `app.ts`:

```ts
  await app.register(registerFederationRoutes, {
    prefix: '/federation',
    publicUrl: config.publicUrl,
    masterKey: config.masterKey,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    outboundAllowPrivate: config.outboundAllowPrivate,
  });
```

- [ ] **Step 7: Write the route test**

Create `apps/api/src/routes/federation-oidc.test.ts`. The upstream is a stub OpenID provider served by a real `http` server on localhost, so `openid-client` performs genuine discovery, a genuine token exchange, and genuine JWT verification.

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  createUser,
  localMasterKeyProvider,
  upsertUpstream,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let upstreamServer: Server;
let issuer: string;
let signedNonce: string | null = null;
let subject = 'upstream-sub-1';

const keyProvider = localMasterKeyProvider(Buffer.alloc(32, 7));

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'up-1', alg: 'RS256', use: 'sig' };

  upstreamServer = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === '/token') {
      const idToken = await new SignJWT({
        nonce: signedNonce,
        preferred_username: 'jdoe@acme.test',
        email: 'jdoe@acme.test',
        name: 'J Doe',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'up-1' })
        .setIssuer(issuer)
        .setSubject(subject)
        .setAudience('syntra')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        access_token: 'up-access', token_type: 'Bearer', expires_in: 300, id_token: idToken,
      }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;

  await withTenant(ctx.tenantId, async (tx) => {
    const upstream = await upsertUpstream(tx, keyProvider, {
      slug: 'entra', name: 'Entra ID', protocol: 'oidc', enabled: true,
      issuerUrl: issuer, clientId: 'syntra', clientSecret: 'up-secret',
      scopes: ['openid', 'profile', 'email'],
      idpEntityId: null, ssoUrl: null, idpSloUrl: null, ssoBinding: 'HTTP-Redirect',
      idpCertificates: [], wantAssertionsSigned: true,
      loginAttribute: 'preferred_username', emailAttribute: 'email',
      displayNameAttribute: 'name', groupsAttribute: null,
      createUsers: true, refreshOnLogin: true, defaultOrgUnitId: null,
    });
    await tx.authPolicy.create({ data: { tenantId: ctx.tenantId } });
    const policy = await tx.authPolicy.findFirstOrThrow();
    await tx.authPolicyRule.create({
      data: {
        tenantId: ctx.tenantId, policyId: policy.id, position: 0, name: 'entra for acme',
        outcome: 'federate', upstreamIdpId: upstream.id, loginDomains: ['acme.test'],
      },
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: TEST_HOST } });

/** Drives the whole round trip, standing in for the upstream's redirect. */
const federate = async (login = 'jdoe@acme.test') => {
  const start = await get(`/federation/start?login=${encodeURIComponent(login)}`);
  if (start.statusCode !== 302) return { start, callback: null };
  const authUrl = new URL(start.headers.location as string);
  signedNonce = authUrl.searchParams.get('nonce');
  const state = authUrl.searchParams.get('state')!;
  const callback = await get(`/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state)}`);
  return { start, callback, state };
};

describe('upstream OIDC federation', () => {
  it('creates the local user on first login and issues a Syntra session', async () => {
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(302);
    expect(callback!.cookies.some((c) => c.name === 'syntra_session')).toBe(true);

    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]!.login).toBe('jdoe@acme.test');
    expect(users[0]!.passwordSource).toBe('upstream');

    // And the decision is in the audit log, naming who vouched.
    const events = await prisma.auditEvent.findMany({ where: { action: 'auth.login' } });
    expect(events.some((e) => JSON.stringify(e.payload).includes('external'))).toBe(true);
    expect(events.some((e) => JSON.stringify(e.payload).includes(issuer))).toBe(true);
  });

  it('refreshes the same user on the second login rather than creating another', async () => {
    await federate();
    await federate();
    expect(await prisma.user.findMany()).toHaveLength(1);
  });

  it('sends a login that matches no routing rule to the local screen', async () => {
    const start = await get('/federation/start?login=someone@other.test');
    expect(start.headers.location).toMatch(/^\/login\?next=/);
  });

  it('challenges rather than issuing a session when policy requires a factor', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'mfa always', outcome: 'require_mfa' }),
    );
    const { callback } = await federate();
    // The upstream authenticated them. Syntra still wants its own factor,
    // which is the whole reason federation runs THROUGH authorize().
    expect(callback!.statusCode).toBe(302);
    expect(callback!.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(callback!.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });

  it('issues no session when policy denies, even though the upstream said yes', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'nobody', outcome: 'deny' }),
    );
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(callback!.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });

  it('refuses a replayed callback', async () => {
    const { state } = await federate();
    const replay = await get(`/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state!)}`);
    expect(replay.statusCode).toBe(400);
    expect(replay.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });

  it('refuses a callback with a state nobody issued', async () => {
    const res = await get('/federation/oidc/callback?code=x&state=made-up');
    expect(res.statusCode).toBe(400);
  });

  it('never redirects off-origin after federation', async () => {
    for (const bad of ['https://attacker.test/', '//attacker.test/', '/\\attacker.test']) {
      const start = await get(
        `/federation/start?login=jdoe@acme.test&next=${encodeURIComponent(bad)}`,
      );
      const authUrl = new URL(start.headers.location as string);
      signedNonce = authUrl.searchParams.get('nonce');
      const callback = await get(
        `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`,
      );
      const location = callback.headers.location as string;
      expect(location.startsWith('/')).toBe(true);
      expect(location).not.toContain('attacker.test');
      subject = `sub-${bad}`;
    }
  });

  it('refuses an upstream whose issuer resolves inside the deployment, by default', async () => {
    // The stub above listens on 127.0.0.1, which is why buildTestApp allows
    // private addresses. With the shipped default the same configuration is
    // refused, and discovery never happens.
    const strict = await buildTestApp({ env: { OUTBOUND_ALLOW_PRIVATE: 'false' } });
    await strict.app.ready();
    await prisma.tenant.update({
      where: { id: strict.tenantId },
      data: { primaryDomain: TEST_HOST },
    });
    await withTenant(strict.tenantId, async (tx) => {
      const upstream = await upsertUpstream(tx, keyProvider, {
        slug: 'entra', name: 'Entra ID', protocol: 'oidc', enabled: true,
        issuerUrl: issuer, clientId: 'syntra', clientSecret: 'up-secret',
        scopes: ['openid'], idpEntityId: null, ssoUrl: null, idpSloUrl: null,
        ssoBinding: 'HTTP-Redirect', idpCertificates: [], wantAssertionsSigned: true,
        loginAttribute: 'preferred_username', emailAttribute: 'email',
        displayNameAttribute: 'name', groupsAttribute: null,
        createUsers: true, refreshOnLogin: true, defaultOrgUnitId: null,
      });
      await tx.authPolicy.create({ data: { tenantId: strict.tenantId } });
      const policy = await tx.authPolicy.findFirstOrThrow();
      await tx.authPolicyRule.create({
        data: {
          tenantId: strict.tenantId, policyId: policy.id, position: 0,
          name: 'entra', outcome: 'federate', upstreamIdpId: upstream.id,
          loginDomains: ['acme.test'],
        },
      });
    });

    const res = await strict.app.inject({
      method: 'GET', url: '/federation/start?login=jdoe@acme.test',
      headers: { host: TEST_HOST },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(302);
    expect(await prisma.federationRequest.count()).toBe(0);
  });

  it('refuses to sign in a deactivated account the upstream still recognises', async () => {
    await federate();
    const user = await prisma.user.findFirstOrThrow();
    const { deactivateUser } = await import('@syntra/core');
    await withTenant(ctx.tenantId, (tx) => deactivateUser(tx, user.id, 'left'));

    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(callback!.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });
});
```

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run packages/core/src/federation apps/api/src/routes/federation-oidc.test.ts`
Expected: PASS.

**Why these tests are not degenerate.** The deny and require_mfa cases are the ones that prove federation runs *through* the chokepoint rather than beside it: an implementation that minted a session directly from the upstream's assertion passes the happy path and fails both of these, and both additionally assert the absence of the session cookie rather than only the status code. The replay case exercises the `updateMany` count, not the expiry. The off-origin case walks the three forms — absolute, protocol-relative and backslash — that a `startsWith('/')` check alone lets through. The deactivated-account case proves `linkOrProvision` does not reactivate, which is the mistake that turns offboarding into a formality.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/federation packages/protocols/src/upstream apps/api/src/routes/federation.ts apps/api/src/routes/federation-oidc.test.ts apps/api/src/app.ts packages/core/src/index.ts packages/protocols/src/index.ts
git commit -m "feat(federation): upstream OIDC relying party with JIT provisioning behind authorize()"
```

---

## Task 16: Upstream SAML — Syntra as a service provider

**Files:**
- Create: `packages/protocols/src/upstream/saml-sp.ts`
- Create: `packages/protocols/src/upstream/saml-sp.test.ts`
- Modify: `apps/api/src/routes/federation.ts` (add `/saml/acs`, `/saml/metadata`, and the SAML branch of `/start`)
- Create: `apps/api/src/routes/federation-saml.test.ts`

**Interfaces:**
- Consumes: `@node-saml/node-saml` 5.1.0; `openFederationRequest`, `takeFederationRequest`, `linkOrProvision`, `findUpstream`, `evaluateRouting`, `loadPolicy`, `authorize` (Tasks 14 and 15); `tenantProtocolIdentity` (Task 2).
- Produces:
  ```ts
  export interface UpstreamSamlOptions { idpCertificates: string[]; idpEntityId: string | null; ssoUrl: string; sloUrl: string | null; spEntityId: string; acsUrl: string; wantAssertionsSigned: boolean }
  export function upstreamSaml(options: UpstreamSamlOptions): SAML;
  export function upstreamSpMetadata(options: UpstreamSamlOptions): string;
  export function upstreamAuthnRedirect(saml: SAML, relayState: string): Promise<string>;
  export interface UpstreamAssertion { subject: string; sessionIndex: string | null; attributes: Record<string, string[]>; inResponseTo: string | null }
  export function readUpstreamResponse(saml: SAML, samlResponse: string): Promise<UpstreamAssertion>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/protocols/src/upstream/saml-sp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { generateKeyPairSync } from 'node:crypto';
import { signFragment } from '../xml/sign.js';
import { parseXml, selectElements } from '../xml/parse.js';
import {
  readUpstreamResponse,
  upstreamAuthnRedirect,
  upstreamSaml,
  upstreamSpMetadata,
} from './saml-sp.js';

const IDP = 'https://idp.example.test/metadata';
const SSO = 'https://idp.example.test/sso';
const SP = 'https://sso.acme.test/federation/saml/metadata';
const ACS = 'https://sso.acme.test/federation/saml/acs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const certificatePem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const options = {
  idpCertificates: [certificatePem],
  idpEntityId: IDP,
  ssoUrl: SSO,
  sloUrl: null,
  spEntityId: SP,
  acsUrl: ACS,
  wantAssertionsSigned: true,
};

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Builds and signs an assertion the way a real upstream IdP would. */
const upstreamResponse = (over: { subject?: string; audience?: string; now?: Date; sign?: boolean } = {}) => {
  const now = over.now ?? new Date();
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${over.subject ?? 'jdoe@acme.test'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(new Date(now.getTime() + 300000))}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60000))}" NotOnOrAfter="${iso(new Date(now.getTime() + 300000))}">` +
    `<saml:AudienceRestriction><saml:Audience>${over.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_si1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="mail"><saml:AttributeValue>jdoe@acme.test</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="groups"><saml:AttributeValue>Finance</saml:AttributeValue><saml:AttributeValue>All Staff</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>`;

  const body = over.sign === false
    ? assertion
    : signFragment(assertion, {
        privateKeyPem,
        certificatePem,
        referenceXPath: "/*[local-name(.)='Assertion']",
        insertAfterXPath: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      });

  return Buffer.from(
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS}">` +
      `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${body}</samlp:Response>`,
  ).toString('base64');
};

describe('upstream SAML service provider', () => {
  it('builds a redirect that carries a deflated AuthnRequest to the IdP', async () => {
    const url = await upstreamAuthnRedirect(upstreamSaml(options), 'relay-1');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(SSO);
    expect(parsed.searchParams.get('RelayState')).toBe('relay-1');
    const xml = inflateRawSync(
      Buffer.from(parsed.searchParams.get('SAMLRequest')!, 'base64'),
    ).toString('utf8');
    const doc = parseXml(xml);
    expect(doc.documentElement!.localName).toBe('AuthnRequest');
    expect(
      selectElements(doc, "//*[local-name(.)='Issuer']")[0]!.textContent,
    ).toBe(SP);
  });

  it('publishes SP metadata naming the ACS URL', () => {
    const xml = upstreamSpMetadata(options);
    const doc = parseXml(xml);
    expect(doc.documentElement!.getAttribute('entityID')).toBe(SP);
    expect(
      selectElements(doc, "//*[local-name(.)='AssertionConsumerService']")[0]!.getAttribute('Location'),
    ).toBe(ACS);
  });

  it('reads a signed assertion and returns the subject, session index and attributes', async () => {
    const result = await readUpstreamResponse(upstreamSaml(options), upstreamResponse());
    expect(result.subject).toBe('jdoe@acme.test');
    expect(result.sessionIndex).toBe('_si1');
    expect(result.attributes.mail).toEqual(['jdoe@acme.test']);
    expect(result.attributes.groups).toEqual(['Finance', 'All Staff']);
  });

  it('refuses an unsigned assertion when the upstream is configured to require one', async () => {
    await expect(
      readUpstreamResponse(upstreamSaml(options), upstreamResponse({ sign: false })),
    ).rejects.toThrow();
  });

  it('refuses an assertion signed by a key that is not registered', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const withOtherKey = upstreamSaml({
      ...options,
      idpCertificates: [other.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
    });
    await expect(readUpstreamResponse(withOtherKey, upstreamResponse())).rejects.toThrow();
  });

  it('refuses an assertion whose audience is somebody else', async () => {
    await expect(
      readUpstreamResponse(upstreamSaml(options), upstreamResponse({ audience: 'https://someone-else.test' })),
    ).rejects.toThrow();
  });

  it('refuses an assertion whose conditions have expired', async () => {
    await expect(
      readUpstreamResponse(upstreamSaml(options), upstreamResponse({ now: new Date(Date.now() - 3_600_000) })),
    ).rejects.toThrow();
  });

  it('refuses an assertion altered after signing', async () => {
    const good = Buffer.from(upstreamResponse(), 'base64').toString('utf8');
    const tampered = Buffer.from(
      good.replace('jdoe@acme.test</saml:NameID>', 'admin@acme.test</saml:NameID>'),
    ).toString('base64');
    await expect(readUpstreamResponse(upstreamSaml(options), tampered)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/protocols/src/upstream/saml-sp.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `saml-sp.ts`**

```ts
import { SAML, generateServiceProviderMetadata } from '@node-saml/node-saml';

/**
 * Syntra acting as a SAML service provider against an upstream identity
 * provider.
 *
 * This is `@node-saml/node-saml`'s whole job and it does all of it: it builds
 * the AuthnRequest, and `validatePostResponseAsync` verifies the signature,
 * the audience, the recipient, the conditions and the subject confirmation.
 * None of that is reimplemented here — the identity-provider half of this
 * product needed `xml-crypto` because node-saml has no assertion issuance, but
 * the service-provider half needs nothing beyond node-saml.
 */
export interface UpstreamSamlOptions {
  /** PEM certificates trusted to have signed an assertion. */
  idpCertificates: string[];
  idpEntityId: string | null;
  ssoUrl: string;
  sloUrl: string | null;
  /** Syntra's entity ID for this upstream. Becomes the expected audience. */
  spEntityId: string;
  acsUrl: string;
  wantAssertionsSigned: boolean;
}

export function upstreamSaml(options: UpstreamSamlOptions): SAML {
  return new SAML({
    idpCert: options.idpCertificates,
    issuer: options.spEntityId,
    callbackUrl: options.acsUrl,
    entryPoint: options.ssoUrl,
    // The audience Syntra requires the assertion to name. `false` would
    // disable the audience check entirely, which turns any assertion the
    // upstream ever issued — including one meant for a different service
    // provider — into a valid Syntra login.
    audience: options.spEntityId,
    ...(options.idpEntityId ? { idpIssuer: options.idpEntityId } : {}),
    ...(options.sloUrl ? { logoutUrl: options.sloUrl } : {}),
    wantAssertionsSigned: options.wantAssertionsSigned,
    // The Response envelope itself need not be signed as long as the
    // Assertion inside it is — signing the assertion is what almost every
    // upstream does, and it is the stronger of the two.
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    // Syntra keeps its own single-use `FederationRequest` row and checks the
    // RelayState against it, which is a stronger replay defence than
    // node-saml's in-memory InResponseTo cache and survives a restart and a
    // second process. Turning node-saml's cache on as well would refuse every
    // response on whichever worker did not issue the request.
    validateInResponseTo: 'never' as never,
    acceptedClockSkewMs: 5000,
  });
}

export function upstreamSpMetadata(options: UpstreamSamlOptions): string {
  return generateServiceProviderMetadata({
    issuer: options.spEntityId,
    callbackUrl: options.acsUrl,
    wantAssertionsSigned: options.wantAssertionsSigned,
    identifierFormat: null,
  });
}

/**
 * The redirect that starts an upstream login. `RelayState` carries Syntra's
 * own `FederationRequest` state, which is what the callback matches against.
 */
export async function upstreamAuthnRedirect(
  saml: SAML,
  relayState: string,
): Promise<string> {
  return saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

export interface UpstreamAssertion {
  subject: string;
  sessionIndex: string | null;
  attributes: Record<string, string[]>;
  inResponseTo: string | null;
}

/**
 * Verifies an upstream Response and returns what it asserted.
 *
 * Throws on any failure — an unsigned assertion when one was required, an
 * untrusted signing key, a wrong audience, an expired condition, a wrong
 * recipient. Every one of those is a rejection rather than a warning, and the
 * caller has no way to proceed past one, which is the point of returning a
 * value rather than a result object here.
 *
 * `profile` is node-saml's flattened view: attribute names become keys, and a
 * single-valued attribute becomes a string rather than an array. This
 * normalizes back to arrays so the caller has one shape.
 */
export async function readUpstreamResponse(
  saml: SAML,
  samlResponse: string,
): Promise<UpstreamAssertion> {
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) throw new Error('upstream response carried no assertion');

  const reserved = new Set([
    'issuer', 'nameID', 'nameIDFormat', 'nameQualifier', 'spNameQualifier',
    'sessionIndex', 'ID', 'getAssertionXml', 'getAssertion', 'getSamlResponseXml',
    'inResponseTo',
  ]);

  const attributes: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (reserved.has(key)) continue;
    if (typeof value === 'string') attributes[key] = [value];
    else if (Array.isArray(value)) {
      attributes[key] = value.filter((v): v is string => typeof v === 'string');
    }
  }

  return {
    subject: profile.nameID,
    sessionIndex: profile.sessionIndex ?? null,
    attributes,
    inResponseTo: (profile.inResponseTo as string | undefined) ?? null,
  };
}
```

- [ ] **Step 4: Add the SAML branch to `federation.ts`**

In `/start`, after the upstream is loaded, branch on protocol:

```ts
    if (upstream.protocol === 'saml') {
      if (!upstream.ssoUrl) {
        throw new ProblemError(409, 'federation-misconfigured', 'That identity provider is not configured');
      }
      const ticket = await openFederationRequest(request.tenantId, {
        upstreamIdpId: upstream.id,
        returnTo,
        applicationId: query.applicationId ?? null,
      });
      const saml = upstreamSaml({
        idpCertificates: upstream.idpCertificates,
        idpEntityId: upstream.idpEntityId,
        ssoUrl: upstream.ssoUrl,
        sloUrl: upstream.idpSloUrl,
        // Built from the tenant's own identity, never from the request.
        spEntityId: `${identity.base}/federation/saml/metadata`,
        acsUrl: `${identity.base}/federation/saml/acs`,
        wantAssertionsSigned: upstream.wantAssertionsSigned,
      });
      // Signing and deflating, outside every transaction.
      return reply.redirect(await upstreamAuthnRedirect(saml, ticket.state), 302);
    }
```

Add the ACS and metadata routes:

```ts
  app.get('/saml/metadata', async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const slug = (request.query as Record<string, string | undefined>).upstream;
    const upstream = slug ? await findUpstreamBySlug(request.tenantId, slug) : null;
    if (!upstream || upstream.protocol !== 'saml') {
      throw new ProblemError(404, 'federation-unknown-upstream', 'Unknown identity provider');
    }

    return reply.type('application/samlmetadata+xml').send(
      upstreamSpMetadata({
        idpCertificates: upstream.idpCertificates,
        idpEntityId: upstream.idpEntityId,
        ssoUrl: upstream.ssoUrl ?? '',
        sloUrl: upstream.idpSloUrl,
        spEntityId: `${identity.base}/federation/saml/metadata`,
        acsUrl: `${identity.base}/federation/saml/acs`,
        wantAssertionsSigned: upstream.wantAssertionsSigned,
      }),
    );
  });

  app.post('/saml/acs', rateLimited, async (request, reply) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    const identity = tenantProtocolIdentity(tenant, options.publicUrl);
    assertProtocolHost(request, identity);

    const body = request.body as Record<string, string | undefined> | undefined;
    const relayState = body?.RelayState;
    const samlResponse = body?.SAMLResponse;
    if (typeof relayState !== 'string' || typeof samlResponse !== 'string') {
      throw new ProblemError(400, 'federation-bad-callback', 'Malformed response');
    }

    // Single-use, and it is what ties this response to a request Syntra
    // started. Without it an unsolicited assertion — one the upstream issued
    // for a different service, or one an attacker captured and replayed —
    // would be a valid login.
    const ticket = await takeFederationRequest(request.tenantId, relayState, keyProvider());
    if (!ticket) {
      throw new ProblemError(400, 'federation-bad-callback', 'That sign-in has expired or was already used');
    }

    const upstream = await findUpstream(request.tenantId, ticket.upstreamIdpId);
    if (!upstream?.ssoUrl || upstream.protocol !== 'saml') {
      throw new ProblemError(409, 'federation-misconfigured', 'That identity provider is not usable');
    }

    // Signature verification, outside every transaction. It throws on any
    // failure and there is no path past it.
    const saml = upstreamSaml({
      idpCertificates: upstream.idpCertificates,
      idpEntityId: upstream.idpEntityId,
      ssoUrl: upstream.ssoUrl,
      sloUrl: upstream.idpSloUrl,
      spEntityId: `${identity.base}/federation/saml/metadata`,
      acsUrl: `${identity.base}/federation/saml/acs`,
      wantAssertionsSigned: upstream.wantAssertionsSigned,
    });

    let assertion;
    try {
      assertion = await readUpstreamResponse(saml, samlResponse);
    } catch (cause) {
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: null,
          action: 'federation.assertion_refused',
          targetType: 'UpstreamIdp',
          targetId: upstream.id,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: { reason: cause instanceof Error ? cause.message : 'invalid' },
        }),
      );
      throw new ProblemError(400, 'federation-bad-assertion', 'That sign-in could not be verified');
    }

    const first = (name: string | null) =>
      name && assertion.attributes[name]?.[0] ? assertion.attributes[name]![0]! : null;

    const provisioned = await linkOrProvision(request.tenantId, upstream, {
      subject: assertion.subject,
      login: first(upstream.loginAttribute) ?? assertion.subject,
      email: first(upstream.emailAttribute),
      displayName: first(upstream.displayNameAttribute),
      groups: upstream.groupsAttribute
        ? (assertion.attributes[upstream.groupsAttribute] ?? [])
        : [],
    });

    if (provisioned.userId === null) {
      throw new ProblemError(
        403, 'federation-no-account',
        provisioned.reason === 'no_local_user'
          ? 'You signed in successfully, but this organization has no account for you. Ask an administrator to create one.'
          : 'That identity provider did not send enough information to identify you.',
      );
    }

    // The same chokepoint the OIDC branch uses, with the same principal kind.
    const decision = await authorize(request.tenantId, {
      kind: 'primary',
      principal: {
        kind: 'external',
        userId: provisioned.userId,
        issuer: upstream.idpEntityId ?? upstream.ssoUrl,
      },
      applicationId: ticket.applicationId,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
      scope: 'portal',
    });

    if (decision.status === 'deny') {
      throw new ProblemError(403, 'federation-denied', 'Sign-in refused');
    }
    if (decision.status === 'challenge' || decision.status === 'enrol') {
      const next = encodeURIComponent(ticket.returnTo);
      const path = decision.status === 'challenge' ? '/mfa' : '/enrol';
      return reply.redirect(
        `${path}?attempt=${encodeURIComponent(decision.attemptToken)}&next=${next}`,
        302,
      );
    }

    await issueSession(request, reply, decision);
    return reply.redirect(ticket.returnTo, 302);
  });
```

> The ACS endpoint receives `application/x-www-form-urlencoded`, so `@fastify/formbody` must be registered inside this plugin. Register it at the top of `registerFederationRoutes`: `await app.register(formbody)`. It is scoped to this plugin and does not affect `/oidc/*`, which must keep its raw body — Fastify's encapsulation is what makes that true, and registering `formbody` at the root instead would break the OIDC mount.

- [ ] **Step 5: Write the route test**

Create `apps/api/src/routes/federation-saml.test.ts`, mirroring `federation-oidc.test.ts` but with a locally-signed assertion instead of a stub HTTP server. Reuse the `upstreamResponse` helper from `saml-sp.test.ts` (copy it in; the plan does not share fixtures across packages), configure the upstream with `protocol: 'saml'`, `ssoUrl: 'https://idp.example.test/sso'`, `idpCertificates: [certificatePem]`, and assert:

```ts
  it('signs a user in from a signed upstream assertion', async () => {
    const start = await get('/federation/start?login=jdoe@acme.test');
    const relayState = new URL(start.headers.location as string).searchParams.get('RelayState')!;
    const res = await ctx.app.inject({
      method: 'POST', url: '/federation/saml/acs',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ SAMLResponse: upstreamResponse(), RelayState: relayState }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(res.cookies.some((c) => c.name === 'syntra_session')).toBe(true);
    expect(await prisma.user.findMany()).toHaveLength(1);
  });

  it('refuses an unsolicited assertion with no matching relay state', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/federation/saml/acs',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ SAMLResponse: upstreamResponse(), RelayState: 'never-issued' }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });

  it('refuses a replayed assertion even with the relay state it was issued for', async () => {
    const start = await get('/federation/start?login=jdoe@acme.test');
    const relayState = new URL(start.headers.location as string).searchParams.get('RelayState')!;
    const payload = new URLSearchParams({ SAMLResponse: upstreamResponse(), RelayState: relayState }).toString();
    const headers = { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' };
    const first = await ctx.app.inject({ method: 'POST', url: '/federation/saml/acs', headers, payload });
    expect(first.statusCode).toBe(302);
    const second = await ctx.app.inject({ method: 'POST', url: '/federation/saml/acs', headers, payload });
    expect(second.statusCode).toBe(400);
    expect(second.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });

  it('refuses an assertion signed by a key the upstream did not register, and audits it', async () => {
    const start = await get('/federation/start?login=jdoe@acme.test');
    const relayState = new URL(start.headers.location as string).searchParams.get('RelayState')!;
    const res = await ctx.app.inject({
      method: 'POST', url: '/federation/saml/acs',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: forgedResponse(), RelayState: relayState,
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
    const events = await prisma.auditEvent.findMany({
      where: { action: 'federation.assertion_refused' },
    });
    expect(events).toHaveLength(1);
  });

  it('still requires a Syntra second factor when policy asks for one', async () => {
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'mfa', outcome: 'require_mfa' }));
    const start = await get('/federation/start?login=jdoe@acme.test');
    const relayState = new URL(start.headers.location as string).searchParams.get('RelayState')!;
    const res = await ctx.app.inject({
      method: 'POST', url: '/federation/saml/acs',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ SAMLResponse: upstreamResponse(), RelayState: relayState }).toString(),
    });
    expect(res.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(res.cookies.some((c) => c.name === 'syntra_session')).toBe(false);
  });
```

where `forgedResponse()` is `upstreamResponse()` built with a second key pair generated in the test file.

- [ ] **Step 6: Run everything**

Run: `pnpm vitest run packages/protocols/src/upstream apps/api/src/routes/federation-saml.test.ts`
Expected: PASS.

**Why these tests are not degenerate.** The unsolicited-assertion case is the one that matters most: the assertion is genuinely valid and correctly signed, and it is refused purely because Syntra did not start the flow — an implementation that verified the signature and stopped there passes every other case and fails this one. The replay case reuses a relay state that *was* issued, so it exercises the single-use consumption rather than the existence check. The require_mfa case proves the upstream's word is not the end of the decision.

- [ ] **Step 7: Commit**

```bash
git add packages/protocols/src/upstream apps/api/src/routes/federation.ts apps/api/src/routes/federation-saml.test.ts
git commit -m "feat(federation): upstream SAML service provider behind the same chokepoint"
```

---

## Task 17: Administration, portal launch, and the end-to-end path

**Files:**
- Create: `packages/contracts/src/protocol-admin.ts`
- Create: `apps/api/src/routes/admin/protocol-apps.ts`
- Create: `apps/api/src/routes/admin/upstreams.ts`
- Create: `apps/api/src/routes/admin/protocol-apps.test.ts`
- Modify: `packages/contracts/src/access.ts`, `packages/contracts/src/index.ts`
- Modify: `apps/api/src/routes/portal.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `README.md` (the audit-event table, and the `client_credentials` exemption)
- Create: `e2e/sso.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 6, 10, 14; `requireSession('admin')`, `requirePermission(PERMISSIONS.ACCESS_MANAGE)`; `invalidateProvider` (Task 10); `parseSpMetadata` (Task 6); `fetchExternalDocument` (Task 2).
- Produces: `registerAdminProtocolRoutes(app)`, `registerAdminUpstreamRoutes(app, { masterKey })`, and the zod schemas below.

- [ ] **Step 1: Widen the application type and write the schemas**

In `packages/contracts/src/access.ts`, replace the `type` and `launchUrl` fields of `createApplicationRequest`:

```ts
export const createApplicationRequest = z
  .object({
    name: z.string().min(1).max(128),
    slug: applicationSlug,
    description: z.string().max(1024).optional(),
    iconUrl: webUrl.optional(),
    // Access II widens this. The column has always been a free string, so
    // this is a code change and not a migration.
    type: z.enum(['bookmark', 'saml', 'oidc']).default('bookmark'),
    // Required for a bookmark and meaningless for the other two, whose launch
    // address is derived from the tenant's own protocol identity.
    launchUrl: webUrl.optional(),
    visibility: z.enum(['assigned', 'hidden']).default('assigned'),
  })
  .refine((value) => value.type !== 'bookmark' || value.launchUrl !== undefined, {
    message: 'A bookmark application needs a launch URL',
    path: ['launchUrl'],
  });
```

Create `packages/contracts/src/protocol-admin.ts`:

```ts
import { z } from 'zod';
import { isProtocolEndpoint } from './protocol.js';

/**
 * Every URL an administrator may register as a protocol endpoint.
 *
 * `z.string().url()` accepts `javascript:`, so it is never used alone
 * anywhere in this codebase. `isProtocolEndpoint` additionally refuses a
 * fragment and embedded credentials, both of which make an exact-match
 * allowlist ambiguous.
 */
const endpoint = z
  .string()
  .max(2048)
  .refine(isProtocolEndpoint, { message: 'Must be an http or https URL with no fragment' });

const pemCertificate = z
  .string()
  .max(16384)
  .refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), {
    message: 'Must be a PEM certificate',
  });

const binding = z.enum(['HTTP-POST', 'HTTP-Redirect']);

export const samlConfigRequest = z.object({
  spEntityId: z.string().min(1).max(1024),
  // At least one, because an empty allowlist is a configuration that fails
  // every login later at a point nobody connects back to this form.
  acsUrls: z.array(endpoint).min(1).max(16),
  defaultAcsUrl: endpoint.nullable().default(null),
  acsBinding: binding.default('HTTP-POST'),
  nameIdFormat: z.string().max(256)
    .default('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'),
  nameIdClaim: z.string().max(128).nullable().default(null),
  spCertificates: z.array(pemCertificate).max(8).default([]),
  wantAuthnRequestsSigned: z.boolean().default(false),
  encryptAssertions: z.boolean().default(false),
  encryptionCertificate: pemCertificate.nullable().default(null),
  sloUrl: endpoint.nullable().default(null),
  sloBinding: binding.default('HTTP-POST'),
  allowIdpInitiated: z.boolean().default(false),
  assertionLifetimeMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
})
  .refine((v) => v.defaultAcsUrl === null || v.acsUrls.includes(v.defaultAcsUrl), {
    message: 'The default ACS URL must be one of the registered ones',
    path: ['defaultAcsUrl'],
  })
  .refine((v) => !v.wantAuthnRequestsSigned || v.spCertificates.length > 0, {
    message: 'Requiring signed requests needs at least one certificate to check them against',
    path: ['spCertificates'],
  })
  .refine((v) => !v.encryptAssertions || v.encryptionCertificate !== null, {
    message: 'Encrypting assertions needs a certificate to encrypt to',
    path: ['encryptionCertificate'],
  });
export type SamlConfigRequest = z.input<typeof samlConfigRequest>;

/** The scopes a user token carries, which a machine token may never request. */
const USER_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

export const oidcClientRequest = z.object({
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  redirectUris: z.array(endpoint).max(16).default([]),
  postLogoutRedirectUris: z.array(endpoint).max(16).default([]),
  // `client_credentials` is deliberately absent from this enum. It is the one
  // grant that issues a token with no `authorize()` decision behind it, so it
  // is turned on by its own field below rather than by adding a string to an
  // array — see ruling A2-5 and Task 13.
  grantTypes: z.array(z.enum(['authorization_code', 'refresh_token']))
    .max(2).default(['authorization_code', 'refresh_token']),
  clientCredentialsEnabled: z.boolean().default(false),
  scopes: z.array(z.string().max(64)).max(32).default(['openid', 'profile', 'email']),
  // Settable but not to false: spec section 7 asks for the code flow with
  // PKCE without qualification, and a client registered without it is a
  // client the provider would then have to accept without it.
  requirePkce: z.literal(true).default(true),
  tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'none'])
    .default('client_secret_basic'),
  idTokenSignedResponseAlg: z.literal('RS256').default('RS256'),
  accessTokenTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
  refreshTokenTtlSeconds: z.number().int().min(0).max(7_776_000).default(1_209_600),
  rotateSecret: z.boolean().default(false),
})
  .refine(
    (v) => v.clientCredentialsEnabled || v.grantTypes.length > 0,
    { message: 'A client needs at least one grant', path: ['grantTypes'] },
  )
  .refine(
    (v) => !v.grantTypes.includes('authorization_code') || v.redirectUris.length > 0,
    {
      message: 'A client using the authorization code flow needs a redirect URI',
      path: ['redirectUris'],
    },
  )
  .refine(
    // A2-5 condition 3, at write time as well as at the token endpoint. A
    // machine token carrying `openid` would be presentable wherever a user
    // token is accepted, and the exemption would stop being bounded.
    (v) => !v.clientCredentialsEnabled || !v.scopes.some((s) => USER_SCOPES.includes(s as never)),
    {
      message: `A client credentials client may not be registered for ${USER_SCOPES.join(', ')} — that token must not be usable where a user token is`,
      path: ['scopes'],
    },
  )
  .refine(
    (v) => !v.clientCredentialsEnabled || v.scopes.length > 0,
    {
      message: 'A client credentials client needs at least one scope of its own',
      path: ['scopes'],
    },
  );
export type OidcClientRequest = z.input<typeof oidcClientRequest>;

export const claimMappingRequest = z.object({
  protocol: z.enum(['saml', 'oidc']),
  claimName: z.string().min(1).max(128),
  nameFormat: z.string().max(256)
    .default('urn:oasis:names:tc:SAML:2.0:attrname-format:basic'),
  sourceKind: z.enum(['user', 'person', 'contract', 'attribute', 'groups', 'literal']),
  sourceField: z.string().max(128).nullable().default(null),
  contractStrategy: z.enum(['primary', 'lowestSequence']).default('primary'),
  literalValue: z.string().max(1024).nullable().default(null),
  releaseScope: z.string().max(64).nullable().default(null),
  multiValued: z.boolean().default(false),
})
  .refine((v) => v.sourceKind === 'literal' || v.sourceKind === 'groups' || v.sourceField !== null, {
    message: 'This source needs a field name',
    path: ['sourceField'],
  })
  .refine((v) => v.sourceKind !== 'literal' || v.literalValue !== null, {
    message: 'A literal mapping needs a value',
    path: ['literalValue'],
  });
export type ClaimMappingRequest = z.input<typeof claimMappingRequest>;

export const upstreamIdpRequest = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(128),
  protocol: z.enum(['saml', 'oidc']),
  enabled: z.boolean().default(true),
  issuerUrl: endpoint.nullable().default(null),
  clientId: z.string().max(256).nullable().default(null),
  clientSecret: z.string().min(1).max(1024).optional(),
  scopes: z.array(z.string().max(64)).max(32).default(['openid', 'profile', 'email']),
  idpEntityId: z.string().max(1024).nullable().default(null),
  ssoUrl: endpoint.nullable().default(null),
  idpSloUrl: endpoint.nullable().default(null),
  ssoBinding: z.enum(['HTTP-Redirect', 'HTTP-POST']).default('HTTP-Redirect'),
  idpCertificates: z.array(pemCertificate).max(8).default([]),
  wantAssertionsSigned: z.boolean().default(true),
  loginAttribute: z.string().max(128).default('preferred_username'),
  emailAttribute: z.string().max(128).default('email'),
  displayNameAttribute: z.string().max(128).default('name'),
  groupsAttribute: z.string().max(128).nullable().default(null),
  createUsers: z.boolean().default(true),
  refreshOnLogin: z.boolean().default(true),
  defaultOrgUnitId: z.string().uuid().nullable().default(null),
})
  .refine((v) => v.protocol !== 'oidc' || (v.issuerUrl !== null && v.clientId !== null), {
    message: 'An OIDC upstream needs an issuer URL and a client id',
    path: ['issuerUrl'],
  })
  .refine((v) => v.protocol !== 'saml' || v.ssoUrl !== null, {
    message: 'A SAML upstream needs a single sign-on URL',
    path: ['ssoUrl'],
  })
  .refine((v) => v.protocol !== 'saml' || !v.wantAssertionsSigned || v.idpCertificates.length > 0, {
    message: 'Requiring signed assertions needs at least one certificate to check them against',
    path: ['idpCertificates'],
  });
export type UpstreamIdpRequest = z.input<typeof upstreamIdpRequest>;

export const spMetadataImportRequest = z.union([
  z.object({ xml: z.string().min(1).max(1_048_576) }),
  z.object({ url: endpoint }),
]);
```

Export it from `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing admin test**

Create `apps/api/src/routes/admin/protocol-apps.test.ts`. Copy the admin-session fixture from an existing admin test (`apps/api/src/routes/admin/applications.test.ts` if present, otherwise sign in and elevate to an administrative session). The helpers below take the app and its cookie explicitly, because two cases build a second app with a different environment:

```ts
let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let portalCookie: string;

/** Signs in, elevates, and returns the administrative session cookie. */
const adminSession = async (app: Awaited<ReturnType<typeof buildTestApp>>): Promise<string> => {
  // ... the existing admin fixture, parameterised on `app` rather than on a
  // module-level `ctx`, so a second app can be given one too.
};

type App = Awaited<ReturnType<typeof buildTestApp>>;

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  app: App = ctx,
  cookie: string = adminCookie,
) =>
  app.app.inject({
    method, url,
    headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    ...(body === undefined ? {} : { payload: body }),
  });

const get = (url: string, app?: App, cookie?: string) => call('GET', url, undefined, app, cookie);
const post = (url: string, body: unknown, app?: App, cookie?: string) => call('POST', url, body, app, cookie);
const put = (url: string, body: unknown, app?: App, cookie?: string) => call('PUT', url, body, app, cookie);
```

Then:

```ts
describe('admin protocol configuration', () => {
  it('registers a SAML application and reads the configuration back', async () => {
    const created = await post('/api/admin/applications', {
      name: 'CRM', slug: 'crm', type: 'saml',
    });
    expect(created.statusCode).toBe(201);
    const applicationId = created.json().id;

    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      spEntityId: 'https://sp.example.test/metadata',
      acsUrls: ['https://sp.example.test/acs'],
      defaultAcsUrl: 'https://sp.example.test/acs',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acsUrls).toEqual(['https://sp.example.test/acs']);
  });

  it('refuses a javascript: ACS URL', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'X', slug: 'x', type: 'saml',
    })).json().id;
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      spEntityId: 'https://sp.example.test/metadata',
      acsUrls: ['javascript:alert(1)'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty ACS allowlist', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'Y', slug: 'y', type: 'saml',
    })).json().id;
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      spEntityId: 'https://sp.example.test/metadata', acsUrls: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a default ACS URL that is not on the allowlist', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'Z', slug: 'z', type: 'saml',
    })).json().id;
    const res = await put(`/api/admin/applications/${applicationId}/saml`, {
      spEntityId: 'https://sp.example.test/metadata',
      acsUrls: ['https://sp.example.test/acs'],
      defaultAcsUrl: 'https://elsewhere.test/acs',
    });
    expect(res.statusCode).toBe(400);
  });

  it('imports service-provider metadata into the allowlist', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'M', slug: 'm', type: 'saml',
    })).json().id;
    const res = await post(`/api/admin/applications/${applicationId}/saml/import`, {
      xml: SP_METADATA_FIXTURE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().acsUrls).toEqual([
      'https://sp.example.test/acs', 'https://sp.example.test/acs2',
    ]);
    expect(res.json().spEntityId).toBe('https://sp.example.test/metadata');
  });

  it('refuses to fetch metadata from an address inside the deployment', async () => {
    // buildTestApp allows private addresses by default so the federation
    // suites can run against a loopback stub; this one turns it back off,
    // which is the shipped default.
    const strict = await buildTestApp({ env: { OUTBOUND_ALLOW_PRIVATE: 'false' } });
    await strict.app.ready();
    const strictCookie = await adminSession(strict);
    const applicationId = (await post('/api/admin/applications', {
      name: 'S', slug: 's', type: 'saml',
    }, strict, strictCookie)).json().id;

    const res = await post(
      `/api/admin/applications/${applicationId}/saml/import`,
      { url: 'http://127.0.0.1:9/metadata' },
      strict,
      strictCookie,
    );
    expect(res.statusCode).toBe(502);
    // Named, so an operator can see which address was refused and decide.
    expect(res.body).toContain('127.0.0.1');

    // And nothing was written from it.
    const configured = await prisma.samlConfig.findMany();
    expect(configured).toHaveLength(0);
  });

  it('returns an OIDC client secret exactly once', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'API', slug: 'api', type: 'oidc',
    })).json().id;

    const first = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'api', redirectUris: ['https://api.example.test/cb'],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().clientSecret).toMatch(/.{20,}/);

    // Reading it back never yields the secret again — spec section 12.
    const read = await get(`/api/admin/applications/${applicationId}/oidc`);
    expect(read.json().clientSecret).toBeUndefined();
    expect(JSON.stringify(read.json())).not.toContain('clientSecretHash');

    // Updating without asking for rotation does not mint a new one.
    const update = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'api', redirectUris: ['https://api.example.test/cb', 'https://api.example.test/cb2'],
    });
    expect(update.json().clientSecret).toBeNull();

    const rotated = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'api', redirectUris: ['https://api.example.test/cb'], rotateSecret: true,
    });
    expect(rotated.json().clientSecret).toMatch(/.{20,}/);
    expect(rotated.json().clientSecret).not.toBe(first.json().clientSecret);
  });

  it('refuses client_credentials as a grant type, and takes it only as its own flag', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'M', slug: 'machine', type: 'oidc',
    })).json().id;

    // A2-5 condition 1: it cannot arrive by editing the grants array.
    const smuggled = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'm', redirectUris: [], grantTypes: ['client_credentials'],
    });
    expect(smuggled.statusCode).toBe(400);

    const enabled = await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'm', redirectUris: [], grantTypes: [],
      clientCredentialsEnabled: true, scopes: ['reports.read'],
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().clientCredentialsEnabled).toBe(true);
  });

  it('refuses a client credentials client registered for a user scope', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'N', slug: 'machine2', type: 'oidc',
    })).json().id;
    for (const scope of ['openid', 'profile', 'email', 'offline_access']) {
      const res = await put(`/api/admin/applications/${applicationId}/oidc`, {
        clientId: 'n', redirectUris: [], grantTypes: [],
        clientCredentialsEnabled: true, scopes: ['reports.read', scope],
      });
      // A2-5 condition 3, refused at the console rather than only at the
      // token endpoint, so the configuration cannot exist in the first place.
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a wildcard or prefix redirect URI', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'W', slug: 'w', type: 'oidc',
    })).json().id;
    for (const bad of ['https://*.example.test/cb', 'https://api.example.test/cb#x', 'javascript:x']) {
      const res = await put(`/api/admin/applications/${applicationId}/oidc`, {
        clientId: 'w', redirectUris: [bad],
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('never returns an upstream client secret once written', async () => {
    const created = await post('/api/admin/upstreams', {
      slug: 'entra', name: 'Entra ID', protocol: 'oidc',
      issuerUrl: 'https://login.example/entra', clientId: 'syntra',
      clientSecret: 'super-secret-value',
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain('super-secret-value');

    const list = await get('/api/admin/upstreams');
    expect(JSON.stringify(list.json())).not.toContain('super-secret-value');
    expect(JSON.stringify(list.json())).not.toContain('clientSecretName');
  });

  it('refuses every protocol route to a portal session', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'P', slug: 'p', type: 'saml',
    })).json().id;
    const res = await put(
      `/api/admin/applications/${applicationId}/saml`,
      { spEntityId: 'x', acsUrls: ['https://sp.example.test/acs'] },
      ctx,
      portalCookie,
    );
    // A portal session is refused by requireSession('admin') before any
    // permission is even looked up.
    expect(res.statusCode).toBe(403);
  });

  it('drops the cached provider when a client changes', async () => {
    const applicationId = (await post('/api/admin/applications', {
      name: 'C', slug: 'c', type: 'oidc',
    })).json().id;
    await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'c', redirectUris: ['https://c.example.test/cb'],
    });
    // Discovery works, which means a Provider was built.
    const before = await ctx.app.inject({
      method: 'GET', url: '/oidc/.well-known/openid-configuration',
      headers: { host: TEST_HOST },
    });
    expect(before.statusCode).toBe(200);

    await put(`/api/admin/applications/${applicationId}/oidc`, {
      clientId: 'c', redirectUris: ['https://c.example.test/cb', 'https://c.example.test/cb2'],
    });
    // The new redirect URI is honoured without a restart, which is only true
    // if the write invalidated the cache — clients are loaded once at
    // construction.
    const authorize = await ctx.app.inject({
      method: 'GET',
      url: `/oidc/auth?client_id=c&response_type=code&scope=openid&redirect_uri=${encodeURIComponent('https://c.example.test/cb2')}&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=s`,
      headers: { host: TEST_HOST },
    });
    expect(authorize.statusCode).not.toBe(400);
  });
});
```

- [ ] **Step 3: Write the admin routes**

`apps/api/src/routes/admin/protocol-apps.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  claimMappingRequest,
  idParam,
  oidcClientRequest,
  samlConfigRequest,
  spMetadataImportRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createClaimMapping,
  deleteClaimMapping,
  findApplication,
  findSamlConfigForApplication,
  listClaimMappings,
  recordEvent,
  upsertOidcClient,
  upsertSamlConfig,
} from '@syntra/core';
import { fetchExternalDocument } from '@syntra/core';
import { invalidateProvider, parseSpMetadata } from '@syntra/protocols';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export interface AdminProtocolRouteOptions {
  /** From `OUTBOUND_ALLOW_PRIVATE`. See Task 2. */
  outboundAllowPrivate: boolean;
}

export async function registerAdminProtocolRoutes(
  app: FastifyInstance,
  options: AdminProtocolRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const manage = { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) };
  const read = { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) };

  app.put('/applications/:id/saml', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = samlConfigRequest.parse(request.body);

    const application = await request.db((tx) => findApplication(tx, id));
    if (!application) throw new ProblemError(404, 'not-found', 'No such application');
    if (application.type !== 'saml') {
      throw new ProblemError(409, 'wrong-application-type', 'That application is not a SAML application');
    }

    const record = await request.db(async (tx) => {
      const saved = await upsertSamlConfig(tx, id, body);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.saml_configured',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        // The allowlist is the security-relevant field, so it goes in the
        // log: a widened ACS list is the change a reviewer needs to see.
        payload: { spEntityId: body.spEntityId, acsUrls: body.acsUrls },
      });
      return saved;
    });
    return record;
  });

  app.get('/applications/:id/saml', read, async (request) => {
    const { id } = idParam.parse(request.params);
    const record = await request.db((tx) => findSamlConfigForApplication(tx, id));
    if (!record) throw new ProblemError(404, 'not-found', 'Not configured');
    return record;
  });

  app.post('/applications/:id/saml/import', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = spMetadataImportRequest.parse(request.body);

    // A fetch, so it happens before any transaction opens, and it goes
    // through the outbound guard: the URL came from whoever is holding an
    // administrative session, and this endpoint hands the response back.
    const xml =
      'xml' in body
        ? body.xml
        : await fetchExternalDocument(body.url, {
            allowPrivateAddresses: options.outboundAllowPrivate,
          }).catch((cause: unknown) => {
            throw new ProblemError(
              502, 'metadata-fetch-failed',
              'That metadata address could not be read',
              cause instanceof Error ? cause.message : undefined,
            );
          });
    const parsed = parseSpMetadata(xml);

    return request.db(async (tx) => {
      const saved = await upsertSamlConfig(tx, id, {
        spEntityId: parsed.entityId,
        acsUrls: parsed.acsUrls,
        defaultAcsUrl: parsed.defaultAcsUrl,
        acsBinding: 'HTTP-POST',
        nameIdFormat:
          parsed.nameIdFormats[0] ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        nameIdClaim: null,
        spCertificates: parsed.certificates,
        wantAuthnRequestsSigned: parsed.certificates.length > 0,
        encryptAssertions: false,
        encryptionCertificate: null,
        sloUrl: parsed.sloUrl,
        sloBinding: 'HTTP-POST',
        allowIdpInitiated: false,
        assertionLifetimeMs: 300_000,
      });
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.saml_metadata_imported',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { spEntityId: parsed.entityId, acsUrls: parsed.acsUrls },
      });
      return saved;
    });
  });

  app.put('/applications/:id/oidc', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = oidcClientRequest.parse(request.body);

    const application = await request.db((tx) => findApplication(tx, id));
    if (!application) throw new ProblemError(404, 'not-found', 'No such application');
    if (application.type !== 'oidc') {
      throw new ProblemError(409, 'wrong-application-type', 'That application is not an OIDC application');
    }

    const result = await request.db(async (tx) => {
      const saved = await upsertOidcClient(tx, id, body);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.oidc_configured',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          clientId: body.clientId,
          redirectUris: body.redirectUris,
          secretRotated: saved.clientSecret !== null,
        },
      });
      return saved;
    });

    // The Provider loaded this tenant's clients once, at construction. Without
    // this the new redirect URI is invisible until the process restarts.
    invalidateProvider(request.tenantId);

    // The secret is in this response and in no other, ever.
    return { ...result.record, clientSecret: result.clientSecret };
  });

  app.get('/applications/:id/oidc', read, async (request) => {
    const { id } = idParam.parse(request.params);
    const row = await request.db((tx) => tx.oidcClient.findUnique({ where: { applicationId: id } }));
    if (!row) throw new ProblemError(404, 'not-found', 'Not configured');
    // The hash never leaves the server either. It is not a secret, but it is
    // one offline guess away from being one for a client that chose its own.
    const { clientSecretHash: _hidden, ...rest } = row;
    return rest;
  });

  app.get('/applications/:id/claims', read, async (request) => {
    const { id } = idParam.parse(request.params);
    const [saml, oidc] = await request.db(async (tx) => [
      await listClaimMappings(tx, id, 'saml'),
      await listClaimMappings(tx, id, 'oidc'),
    ]);
    return { saml, oidc };
  });

  app.post('/applications/:id/claims', manage, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = claimMappingRequest.parse(request.body);
    const created = await request.db((tx) => createClaimMapping(tx, id, body));
    return reply.status(201).send(created);
  });

  app.delete('/applications/:id/claims/:claimId', manage, async (request, reply) => {
    const { claimId } = request.params as { claimId: string };
    await request.db((tx) => deleteClaimMapping(tx, claimId));
    return reply.status(204).send();
  });
}

```

`apps/api/src/routes/admin/upstreams.ts` follows the same shape: `requireSession('admin')`, `requirePermission(PERMISSIONS.ACCESS_MANAGE)`, `upstreamIdpRequest.parse`, `upsertUpstream(tx, localMasterKeyProvider(options.masterKey), body)`, an audit event, and a `GET` that returns `listUpstreams(tx)` with `clientSecretName` stripped from every row.

Register both in `app.ts`:

```ts
  await app.register(registerAdminProtocolRoutes, {
    prefix: '/api/admin',
    outboundAllowPrivate: config.outboundAllowPrivate,
  });
  await app.register(registerAdminUpstreamRoutes, {
    prefix: '/api/admin',
    masterKey: config.masterKey,
  });
```

- [ ] **Step 4: Teach the portal to launch a protocol application**

In `apps/api/src/routes/portal.ts`, replace the final block of the launch handler — the one that reads `application.launchUrl` — with:

```ts
      const application = await request.db((tx) => findApplication(tx, id));
      if (!application) {
        throw new ProblemError(409, 'not-launchable', 'That application has no launch address configured');
      }

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: userId,
          action: 'application.launch',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: application.slug, type: application.type },
        }),
      );

      // A protocol application's launch address is derived from the tenant's
      // own identity, never stored and never taken from the request. The
      // browser is sent to a Syntra path, which re-enters authorize() — the
      // decision made here does not carry over, and that is deliberate: the
      // protocol endpoint is reachable directly and has to stand on its own.
      if (application.type === 'saml' || application.type === 'oidc') {
        const tenantRow = await request.db((tx) =>
          tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
        );
        const identity = tenantProtocolIdentity(tenantRow, options.publicUrl);
        return {
          status: 'launch' as const,
          url:
            application.type === 'saml'
              ? `${identity.base}/saml/start/${application.id}`
              : `${identity.base}/portal/oidc-start/${application.id}`,
        };
      }

      // A bookmark. The admin API only accepts http(s) launch URLs, but that
      // check runs on write; a row created before it existed would otherwise
      // reach this response, and this is the URL the browser is sent to
      // unconditionally.
      if (!application.launchUrl || !isLaunchableUrl(application.launchUrl)) {
        throw new ProblemError(409, 'not-launchable', 'That application has no launch address configured');
      }
      return { status: 'launch' as const, url: application.launchUrl };
```

> An OIDC application has no IdP-initiated flow in the standard: the relying party must start it, because only the relying party knows its own `state`, `nonce` and PKCE verifier. `/portal/oidc-start/:id` therefore redirects to the application's own start URL — the `launchUrl` an administrator records for an OIDC application, validated by `webUrl` — and the application then begins the code flow against Syntra. Add that one route to `portal.ts`:
>
> ```ts
>   app.get('/oidc-start/:id', async (request, reply) => {
>     const { id } = idParam.parse(request.params);
>     const assigned = await request.db((tx) =>
>       isApplicationAssigned(tx, request.session.userId, id),
>     );
>     if (!assigned) throw new ProblemError(403, 'not-assigned', 'Not available to you');
>     const application = await request.db((tx) => findApplication(tx, id));
>     // Re-checked on the way out rather than trusted because it was
>     // validated on the way in.
>     if (!application?.launchUrl || !isLaunchableUrl(application.launchUrl)) {
>       throw new ProblemError(409, 'not-launchable', 'That application has no start address configured');
>     }
>     return reply.redirect(application.launchUrl, 302);
>   });
> ```
>
> and relax `createApplicationRequest`'s refinement so an `oidc` application also requires `launchUrl`: change the predicate to `value.type === 'saml' || value.launchUrl !== undefined`.

- [ ] **Step 5: Document the slice, and name the exemption**

Add to `README.md`. The audit-event table gains this slice's events, and — ruling A2-5 condition 4 — the one path that does not pass through `authorize()` is named beside it rather than left for a reader to infer from the code.

Replace the closing paragraph of the Access section (**"The federation half of Access is not built."**) with:

```markdown
### Signing in to applications

Syntra is a SAML 2.0 identity provider and an OpenID Connect provider, and it
can delegate authentication upstream to a SAML identity provider or an OIDC
one. Every one of those paths — a service provider's `AuthnRequest`, a relying
party's authorization request, and a login that came back from an upstream
provider — reaches the same `authorize()` call in `packages/core` that a local
sign-in does, and none of them issues an assertion or a token without an
`allow` from it. Policy, second factors and the audit trail apply the same way
whichever door somebody came in by.

**One grant is an exemption, deliberately.** The OAuth 2.0 *client credentials*
grant issues an access token with no `authorize()` decision behind it, because
there is no person for a decision to be about: it authenticates a client, and
a policy that matches on group membership, contract attributes and enrolled
factors has nothing to say about one. The alternative would be to invent a
service-account user — a user-shaped principal no policy meaningfully governs,
appearing in the directory, resolvable by assignment, and counted in other
subsystems' guard denominators — which is worse than naming the exemption and
bounding it. It is bounded by four things:

- It is **off unless an administrator turns it on for that client**
  (`OidcClient.clientCredentialsEnabled`, its own field, default false). The
  API refuses `client_credentials` as a grant type outright, so that flag is
  the only way it can be on.
- Every issuance is audited as **`oidc.client_credentials_authorized`**, so
  "what was issued without a policy decision" is one query.
- The token is **scope-separated**: it may not carry `openid`, `profile`,
  `email` or `offline_access`, and UserInfo refuses it. It cannot be presented
  anywhere a user token is accepted.
- It carries **no subject**, so nothing downstream can mistake it for a person.

If you are auditing this deployment, `oidc.client_credentials_authorized` is
the event to read, and `clientCredentialsEnabled` is the column to list.
```

Add these rows to the audit-event table, after `application.launch`:

```markdown
| `saml.assertion_issued` | An assertion was issued to a service provider, naming it and the factor behind the session |
| `saml.acs_refused` | A request named an assertion consumer service URL that is not on the application's allowlist. **Somebody is probing, or a service provider changed its address without telling anyone** |
| `saml.logout` | A service provider ended a session through single logout |
| `oidc.interaction_resolved` | `authorize()` allowed an OIDC authorization request |
| `oidc.decision_missing` | **A token was requested for an authorization code with no `authorize()` decision behind it.** The second chokepoint control fired. This should never happen in normal operation — alert on it |
| `oidc.client_credentials_authorized` | A machine token was authorized. The one path with no policy decision behind it — see above |
| `oidc.logout` | An application ended a Syntra session through RP-initiated logout |
| `federation.provision_refused` | An upstream authenticated somebody Syntra has no account for, or sent too little to identify them |
| `federation.assertion_refused` | An upstream assertion failed verification |
| `access.saml_configured` / `access.saml_metadata_imported` / `access.oidc_configured` | An application's protocol configuration changed, carrying the allowlist that changed with it |
```

Update the status table at the top of the README: **Access** moves from the row describing MFA and policy to one that also names the SAML IdP, the OIDC provider and upstream federation.

- [ ] **Step 6: Write the end-to-end spec**

Create `e2e/sso.spec.ts`, following the shape of the existing Playwright specs:

```ts
import { test, expect } from '@playwright/test';

/**
 * The user-visible half of the slice: a tile that signs somebody into a real
 * service provider, and an MFA challenge that interrupts it.
 *
 * The service provider is a Playwright route handler that accepts the POST and
 * echoes what it received, which is enough to prove the browser was sent
 * there with a SAMLResponse — the assertion's contents are pinned by the unit
 * and integration suites.
 */
test('a SAML tile signs the user into the service provider', async ({ page }) => {
  await page.route('https://sp.example.test/acs', async (route) => {
    const post = route.request().postData() ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<h1 id="sp">signed in</h1><pre id="body">${post.slice(0, 64)}</pre>`,
    });
  });

  await page.goto('/login');
  await page.getByLabel('Login').fill('jdoe');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'CRM' }).click();
  await expect(page.locator('#sp')).toHaveText('signed in');
  await expect(page.locator('#body')).toContainText('SAMLResponse');
});

test('an MFA rule interrupts the SAML launch and the assertion follows the code', async ({ page }) => {
  // Seeded by the fixture: a require_mfa rule scoped to CRM, and a TOTP
  // credential for jdoe.
  await page.goto('/login');
  await page.getByLabel('Login').fill('jdoe');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'CRM' }).click();

  await expect(page.getByText('Enter the code from your authenticator')).toBeVisible();
});
```

- [ ] **Step 7: Run the whole suite**

```bash
pnpm typecheck
pnpm test
pnpm e2e
```
Expected: everything passes, including every Access I test — no existing test may change to accommodate this slice.

**Why these tests are not degenerate.** The client-secret case asserts three separate things a naive implementation gets wrong: that the secret is returned once, that reading the record back does not include it *or the hash*, and that a plain update does not silently rotate it (which would break every deployed client). The provider-cache case performs a real authorization request with the *newly added* redirect URI, so an implementation that saved the row but did not invalidate the cache fails with a 400 — a bug that otherwise appears only in production, after a restart makes it disappear. The portal launch case asserts the derived URL rather than a stored one.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/protocol-admin.ts packages/contracts/src/access.ts packages/contracts/src/index.ts apps/api/src/routes/admin/protocol-apps.ts apps/api/src/routes/admin/upstreams.ts apps/api/src/routes/admin/protocol-apps.test.ts apps/api/src/routes/portal.ts apps/api/src/app.ts README.md e2e/sso.spec.ts
git commit -m "feat(access): protocol administration, metadata import, and protocol launches from the portal"
```

---

## Spec coverage

Run over the spec with fresh eyes after the plan was written. Every requirement in scope maps to a task.

### Section 7 — SAML 2.0 identity provider

| Requirement | Task |
|---|---|
| HTTP-POST binding for authentication requests | 7 (`decodePostMessage`, `POST /saml/sso`) |
| HTTP-Redirect binding for authentication requests | 8 (`decodeRedirectMessage`, `GET /saml/sso`, bounded against a decompression bomb) |
| Service-provider-initiated flow | 7 and 8 |
| Identity-provider-initiated flow | 9 (`GET /saml/start/:applicationId`, off unless `allowIdpInitiated`) |
| Signed assertions | 7 (`signFragment` on the Assertion, validated by a real SP in the test) |
| Optional assertion encryption | 9 (`encryptAssertion`, AES-256-GCM + RSA-OAEP) |
| Single logout | 9 (`GET` and `POST /saml/slo`, both bindings) |
| Per-application IdP metadata endpoint | 6 (`/saml/metadata` and `/saml/metadata/:applicationId`) |
| SP metadata import by upload or URL | 6 (`parseSpMetadata`) and 17 (`POST /applications/:id/saml/import`, both forms, the URL form behind the outbound guard) |
| ACS URLs validated against a per-application allowlist | 6 (`resolveAcsUrl` + `matchesAllowlist`, no implicit fallback), enforced in 7 and 8, four near-miss strings tested in each |
| XML parsed with entity expansion disabled | 5 (`parseXml`, verified empirically, regression-tested) |
| Signatures verified before any part of the document is trusted | 5 (`verifySignedFragment` returns the signed bytes; callers read only those), applied in 7 for XML-DSig and 8 for the detached query signature |

### Section 7 — OpenID Connect provider

| Requirement | Task |
|---|---|
| Authorization code flow with PKCE | 11 (the authorization half, `pkce: { required: () => true }`) and 12 (the exchange, both driven by `openid-client`) |
| Refresh tokens | 13 (`issueRefreshToken`, `rotateRefreshToken: true`) |
| Client credentials | 13, opt-in per client, scope-separated, audited distinctly — the one path with no `authorize()` decision behind it (ruling A2-5) |
| Discovery document | 11 (including the mount adaptation that keeps the `/oidc` prefix on every advertised URL) |
| JWKS endpoint with key rotation, publishing the outgoing key beside the incoming one for the rollover | 3 (`rotateKey`, `publishedKeys`) and 11 (`/oidc/jwks`, asserted during a rollover, no private members) |
| UserInfo | 13 (`/oidc/me`) |
| RP-initiated logout | 13 (`/oidc/session/end`, ends the Syntra session first) |
| Redirect URIs matched exactly, no wildcard or prefix | 10 (`matchesAllowlist`) and 11 (five near-miss strings, none of them redirected to) |

### Section 7 — Upstream federation and the chokepoint

| Requirement | Task |
|---|---|
| Syntra as a SAML service provider | 16 |
| Syntra as an OIDC relying party | 15 |
| Local `User` created on first upstream login | 15 (`linkOrProvision`) |
| Mapped attributes refreshed on later logins | 15 (`refreshOnLogin`) |
| Which upstream a login uses is chosen by the authentication policy | 14 (`federate` rules, `evaluateRouting`) |
| Every path funnels through one `authorize()`; no adapter issues anything without a decision | 7, 8, 9, 11, 15, 16 — each asserts the deny and challenge cases produce no assertion, no code and no cookie. The single exemption, `client_credentials`, is bounded in 13 and named in the README in 17 |
| …and for OIDC specifically, two independent controls | 10 (`syntraAuthorizePrompt`, inside `oidc-provider`'s interaction policy) **and** 12 (`AuthorizationDecision`, in Syntra's own route and table; the row is written in 11). Task 12 mints a genuine code with no interaction behind it and asserts the token endpoint refuses it, so neither control can be removed by the edit that removes the other. |

### Section 4 — Embedded protocol libraries

| Requirement | Where |
|---|---|
| `oidc-provider` supplies the OIDC provider | Tasks 10–13, pinned at 9.11.3, mounted behind a Syntra-owned session and policy layer |
| `@node-saml/node-saml` and equivalent assertion signing supply the SAML IdP | Task 16 uses node-saml for the SP half; Tasks 5–9 are the "equivalent assertion signing" — `xml-crypto` — because node-saml has no IdP side. Recorded in the library findings above. |
| Syntra retains the user model, login experience, application catalog and policy engine | Task 10's `findAccount` callback and Task 11's interaction route. No foreign user store, no fork. |

### Section 12 — Security posture items in this slice's scope

| Item | Where |
|---|---|
| Signing keys rotated with overlap so existing tokens verify | Task 3 |
| Strict allowlisting of redirect URIs and ACS URLs | Tasks 6, 10, 11, and the `isProtocolEndpoint` / `matchesAllowlist` pair in Task 2 |
| XML signature verification with entity expansion disabled | Task 5 |
| Per-tenant and per-IP rate limiting on all authentication endpoints | Every protocol route uses `config.rateLimit` plus `perTenantRateLimit`, per Global Constraint 10 |
| Every privileged action in the hash-chained audit log | `recordEvent` in Tasks 7, 9, 13, 15, 16, 17 |
| RLS as the primary tenant isolation control | Task 1, with cross-tenant tests |
| Secrets never returned once written, only replaced | Task 17 (client secret returned once; upstream secret never; the stored hash never) |
| No server-side request forgery from an administrator-supplied address | Task 2 (`classifyAddress`, `fetchExternalDocument`), applied to upstream discovery in Task 15 and to metadata import in Task 17 |

### Section 13 — Testing strategy

| Item | Where |
|---|---|
| Pure functions covered exhaustively | Task 4 (`resolveClaims`), Task 14 (`evaluateRouting`) |
| Multi-contract cases: concurrent, one ended, none active | Task 4, `collect.test.ts` |
| Integration against real PostgreSQL, with explicit cross-tenant tests | Tasks 1 and 10 |
| Protocol conformance: a real SAML SP and a real OIDC RP driven against Syntra | Task 7 (`@node-saml/node-saml` validates our assertions), Tasks 11–13 (`openid-client` drives the whole code flow), Task 15 (a real stub OP with genuine JWT verification) |
| End-to-end over launch and MFA | Task 17 (`e2e/sso.spec.ts`) |
| The framework boundaries the protocol mounts depend on | Task 12 (`oidc-boundary.test.ts`: the root has no urlencoded parser, the token body is replayed rather than drained, the mount prefix is stripped) |

### Deliberately not in this plan

- **Signed SAML metadata.** The IdP metadata document is unsigned. It is served over TLS from the tenant's own host, which `assertProtocolHost` enforces. Worth adding; not required by the spec and not free.
- **Back-channel single logout.** Task 9 implements front-channel SLO — the browser carries the LogoutRequest. Back-channel logout needs an outbound HTTP client per SP and a retry queue, which is a scheduler job rather than a route.
- **A consent screen.** Assignment is the consent decision in an enterprise IAM product, and Task 10's `loadExistingGrant` creates the grant from the client's registration. Spec section 7 does not ask for per-launch consent.
- **`sweepExpiredArtifacts` on a schedule.** The function exists in Task 10 and expiry is enforced on read; registering it with the pg-boss scheduler is a one-line addition whenever table growth becomes visible.
