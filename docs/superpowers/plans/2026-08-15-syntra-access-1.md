# Syntra Access I Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every authentication path in Syntra behind one `authorize()` call in `core`, and give a tenant an application catalog, an ordered authentication policy, MFA (TOTP, WebAuthn, recovery codes) and self-service password reset behind it.

**Architecture:** One chokepoint and one pure function. `authorize()` in `packages/core/src/auth/authorize.ts` is the only place a caller can learn whether a principal may proceed; it establishes primary identity, assembles a request context, asks the policy engine, issues or resolves a step-up challenge, and writes the audit event. `evaluatePolicy()` is a pure function of `(rules, fallback, context)` with no database and no clock of its own, so the whole rule matrix is testable without a server. Second factors are plug-ins: each registers a `FactorVerifier` in one registry that `authorize()` consults, so adding a factor never edits the chokepoint. `authorize()` takes a `tenantId` rather than a caller's transaction and opens its own transaction per phase, which keeps signature verification and mail sending out of any interactive transaction.

**Tech Stack:** TypeScript 5.7, Node 22+, Fastify 5, Prisma 6, PostgreSQL 16, Vitest 3, React 19, Tailwind 4, `otpauth@9.5.1`, `@simplewebauthn/server@13.3.2`, `@simplewebauthn/browser@13.3.0`, `@nuintun/qrcode@5.0.3`, `ipaddr.js@2.5.0`.

**Spec:** `docs/superpowers/specs/2026-08-14-syntra-core-access-design.md` (sections 6 "Credentials" and "Access", 7 "Single chokepoint", 8, 9). Scope boundary: `.superpowers/sdd/access-scoping.md`.

## Global Constraints

Everything in the Core and Directory Sync plans' Global Constraints still applies. These are the ones that bite in this slice, plus the ones this slice adds.

- **`authorize()` is the only decision point.** No route, service or adapter may create a `Session`, a `RefreshToken`, or (in Access II) a token or assertion without an `AuthorizeResult` of `status: 'allow'` from `authorize()`. `packages/core/src/auth/login-service.ts` becomes an internal helper of `authorize()`, not a parallel entry point; nothing outside `packages/core/src/auth/` may import `authenticate` after Task 4, and `packages/core/src/index.ts` stops exporting it.
- **A policy that requires a factor the user lacks challenges for enrolment; it never denies.** `authorize()` answers `status: 'enrol'` with an attempt scoped to enrolling one factor of the required kind, and issues no session until that enrolment succeeds. `deny` with `factor_not_enrolled` survives in exactly two cases: the tenant has turned `selfEnrolmentEnabled` off, or no verifier for a required factor type is registered in the process at all. Without this, the first tenant-wide `require_mfa` rule locks out every un-enrolled user and MFA becomes a feature nobody can switch on.
- **An `AuthAttempt` and the audit event that explains it commit in the same transaction.** Both the issuing of an attempt and its consumption pair with their audit event inside one `withTenant`, the way every admin mutation on the previous slice does. A crash must not be able to leave an attempt with no record of why it exists.
- **Request-derived authentication context travels as an explicit field on `AuthorizeRequest`.** `sourceIp` and `relyingParty` are both request-derived and both required by the type; there is no ambient store, no `AsyncLocalStorage`, and no module-level mutable holding either. A background job that has no relying party fails to compile rather than failing confusingly at run time.
- **Never put network or long-running I/O inside a Prisma interactive transaction.** `withTenant` is `prisma.$transaction(fn)` and the client in `packages/db/src/client.ts` is constructed with no `transactionOptions`, so Prisma's default 5000 ms timeout applies. WebAuthn verification, Argon2 hashing, QR encoding and every SMTP send happen **between** transactions, never inside one. This is why `authorize()` takes a `tenantId` and opens its own transaction per phase, exactly as `previewRun` and `applyRun` do in `packages/core/src/sync/run-service.ts`.
- **`notify(tx, transport, …)` is deleted in Task 8, not called.** Its body reads the tenant row and then awaits `transport.send()`, so every call from inside `withTenant` puts an SMTP round trip inside a transaction — the exact Critical the previous slice shipped. It is replaced by `renderMessage(tenantName, …)`, which is pure, and `sendMessage(transport, message)`, which takes no transaction and therefore cannot be put inside one by accident. Read the tenant name in a transaction, render and send outside it.
- **Session scope is carried, never inferred.** `AuthAttempt.scope` records what the issuer intended, and the session created at the end of a step-up reads it. Deriving scope from ambient request state — "a session cookie is present, so this must be an elevation" — hands an administrative session to any portal user who completes a step-up, because the web client sends `credentials: 'include'` on every call.
- **The WebAuthn relying party comes from the tenant, never from the request.** `Tenant.primaryDomain` first, `PUBLIC_URL` as the fallback, and a request whose `Host` does not match is refused at the WebAuthn endpoints. `tenant-context.ts` resolves a tenant from the leftmost label of the `Host` header, so `acme.attacker.example` resolves tenant `acme`; taking the RP ID or the expected origin from that header lets a phisher choose what their own assertion is checked against, which is the entire property a security key exists to provide.
- **An unevaluable condition fails closed on a `deny` rule and open on every other outcome.** A malformed CIDR, an absent source address or an unresolvable timezone means the condition cannot be decided. On `allow`, `require_mfa` and `require_factor` the rule does not match; on `deny` it does. A rule written to refuse people must not stop refusing them because one of its own fields is broken. The asymmetry is deliberate and is documented in `evaluate.ts` where the matcher lives.
- **Never silently drop a record that failed to process.** Every rejected factor, expired attempt, replayed code and denied policy decision produces an audit event carrying a reason. A `catch {}` that returns `false` and records nothing is a plan violation.
- **Every tenant-scoped table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`** and a `tenant_isolation` policy using `NULLIF(current_setting('app.current_tenant', true), '')::uuid`. The GUC reverts to the empty string, not NULL, at transaction end; the `NULLIF` is not optional. Copy the `DO $$` block from `packages/db/prisma/migrations/20260815000500_auth/migration.sql`.
- **Every database access runs inside `withTenant`, including test fixtures.** The app connects as `syntra_app`, which is NOSUPERUSER NOBYPASSRLS deliberately, so a bare `prisma.*.create` on a tenant-scoped table is rejected by the policy's `WITH CHECK`. The only exceptions are `prisma.tenant.*` (Tenant is deliberately outside RLS) and `asDatabaseSuperuser` in tamper tests.
- **Migration directory names must sort after every migration they depend on.** The last existing migration is `20260815020000_mapping_failures`. This plan adds exactly one migration, named `20260816000000_access_1`, and Task 1 verifies the sort order before applying. A name that sorts early passes the entire suite and breaks every fresh install, because the test helper `resetDatabase()` truncates rather than re-migrating.
- **Unique constraints do not constrain NULLs in PostgreSQL.** Every nullable column that participates in uniqueness in this slice — `AppAssignment.userId` / `groupId` / `orgUnitId`, `WebAuthnChallenge.consumedAt`, `PasswordResetToken.consumedAt` — uses a **partial unique index** written by hand in the migration, never `@@unique`.
- **`zod` input versus output types matter at boundaries.** Where a schema carries `.default(...)`, the handler sees the output type but the caller sends the input type; `packages/contracts` exports `z.input<typeof schema>` for anything describing what a client may send.
- **pg-boss 12** is not touched by this slice. If a task ever needs a job: named export not default, `work()` takes an array handler, and retry options belong on `createQueue` — they are silently ignored anywhere else.
- **Rate limiting on every credential-presenting endpoint**, using the existing pattern in `apps/api/src/routes/auth.ts`: `{ config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } } }`. Anything that accepts a password, a TOTP code, a recovery code, a WebAuthn assertion, a reset token or an attempt token carries it.
- **Uniform responses.** Login, step-up and password-reset endpoints answer identically whether or not the account exists, and whether the failure was a wrong password, an unknown login, a disabled account, a bad factor or a policy denial. Which of them applied goes to the audit log, where an administrator can see it and an attacker cannot.
- **Secrets are never returned by any API once written.** The TOTP shared secret appears exactly once, in the enrolment response, and lives in the vault (`putSecret` / `getSecret`) thereafter. There is no second encryption path.
- **Tests:** TDD — a failing test precedes the code that satisfies it. Integration tests run against real PostgreSQL in Docker, never mocks. The policy engine and every pure helper are unit-tested exhaustively.
- **Commits:** conventional commits, one per task.

---

## File Structure

```
packages/db/prisma/
  schema.prisma                          + AuthPolicy, AuthPolicyRule, Application,
                                           AppAssignment, TotpCredential,
                                           WebAuthnCredential, WebAuthnChallenge,
                                           RecoveryCode, PasswordResetToken,
                                           AuthAttempt, RefreshToken;
                                           Tenant.adminMfaRequired, passwordMinLength,
                                           selfEnrolmentEnabled;
                                           User.passwordSource, User.passwordSourceHint;
                                           Session.satisfiedFactor;
                                           AuthAttempt.scope
  migrations/20260816000000_access_1/migration.sql

packages/core/src/policy/
  types.ts               PolicyRule, PolicyFallback, AuthContext, ContractFacts,
                         PolicyOutcome, FactorType, PolicyDecision
  ip-match.ts            evaluateIpRanges, isIpRangeUsable   (pure)
  time-window.ts         evaluateTimeWindow, isValidTimeZone  (pure)
  evaluate.ts            evaluatePolicy, ruleMatches  (pure, no I/O, no ambient clock)
  policy-service.ts      AuthPolicy + AuthPolicyRule storage; loadPolicy
  context.ts             buildAuthContext — groups, active contracts, org unit
  impact.ts              previewRuleImpact — who a rule would force to enrol

packages/core/src/notify/
  notification-service.ts  MODIFIED (Task 8) — notify() split into
                           renderMessage + sendMessage, so a send cannot sit
                           in a transaction
  templates/index.ts       + factor-added (Task 8), password-reset and
                           password-reset-upstream (Task 10)

packages/core/src/auth/
  authorize.ts           THE CHOKEPOINT
  attempt-service.ts     AuthAttempt issue / resolve, hashed single-use token
  refresh-token.ts       revokeAllRefreshTokensForUser
  password-policy.ts     validateNewPassword          (pure)
  password-reset.ts      request / complete, enumeration-safe
  mfa/relying-party.ts   RelyingParty, RelyingPartyIdentity
  mfa/types.ts           FactorPresentation, FactorVerifyContext, FactorVerifier
  mfa/registry.ts        FACTOR_VERIFIERS, enrolledFactors, verifyFactor
  mfa/totp.ts            enrol / confirm / verify, replay watermark
  mfa/webauthn.ts        challenge / register / verify, counter regression
  mfa/recovery-codes.ts  generate / consume atomically

packages/core/src/access/
  application-service.ts  Application CRUD
  assignment-service.ts   AppAssignment create / delete / list
  resolve.ts              resolveApplicationsForUser — the union

packages/contracts/src/
  access.ts              application + assignment schemas
  policy.ts              policy + rule schemas
  mfa.ts                 enrolment, challenge and verification schemas
  enrol.ts               forced-enrolment schemas
  reset.ts               password-reset schemas

apps/api/src/routes/
  relying-party.ts       tenantRelyingParty, assertWebAuthnUsable
  auth.ts                MODIFIED — login and elevate go through authorize()
  mfa.ts                 /api/auth/mfa/*  enrolment, listing, step-up verify
  enrol.ts               /api/auth/enrol/* enrolment under a forced-enrolment
                         attempt, with no session
  password-reset.ts      /api/auth/password-reset/*
  portal.ts              /api/portal/applications, .../launch
apps/api/src/routes/admin/
  applications.ts        catalog + assignments
  policies.ts            policy + ordered rules
  users.ts               MODIFIED — PATCH a user, DELETE a user's factor

apps/web/src/pages/
  Login.tsx              MODIFIED — handles a challenge response
  EnrolFactor.tsx        forced enrolment before a session is issued
  Portal.tsx             MODIFIED — application tiles
  MfaChallenge.tsx       step-up during sign-in
  Security.tsx           self-service MFA enrolment
  ForgotPassword.tsx     request a reset
  ResetPassword.tsx      complete a reset
  admin/ApplicationsPage.tsx    the catalog
  admin/ApplicationDetailPage.tsx  one application and its assignments
  admin/PoliciesPage.tsx        ordered rules, with the impact preview
apps/web/src/routes.tsx  MODIFIED — the new routes

e2e/access-mfa.spec.ts   the whole slice through a browser
```

`packages/core/src/policy/evaluate.ts` imports nothing from `@syntra/db`. If it ever needs to, the boundary is wrong: `context.ts` is what reads the database, and `evaluate.ts` only reasons over what it is handed.

---

## Task 1: Data model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260816000000_access_1/migration.sql`
- Test: `packages/db/src/access-schema.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `prisma`, `TenantClient` from `@syntra/db`; `resetDatabase` from `@syntra/db/src/test-support.js`.
- Produces: every Prisma model the rest of the plan reads and writes — `AuthPolicy`, `AuthPolicyRule`, `Application`, `AppAssignment`, `TotpCredential`, `WebAuthnCredential`, `WebAuthnChallenge`, `RecoveryCode`, `PasswordResetToken`, `AuthAttempt`, `RefreshToken` — plus `Tenant.adminMfaRequired`, `Tenant.passwordMinLength`, `Tenant.selfEnrolmentEnabled`, `User.passwordSource`, `User.passwordSourceHint`, `Session.satisfiedFactor` and `AuthAttempt.scope`.

- [ ] **Step 1: Add the tenant and user columns**

In `packages/db/prisma/schema.prisma`, inside `model Session`, after `scope`:

```prisma
  /// Which second factor, if any, was presented to establish this session.
  /// Read back when the session is used as a principal — launching an
  /// application re-enters authorize(), and without this the requirement it
  /// already satisfied would be demanded again on every launch, forever.
  satisfiedFactor String?
```

In `packages/db/prisma/schema.prisma`, inside `model Tenant`, after `status`:

```prisma
  /// When true, elevating to an administrative session requires a second
  /// factor on top of the password. Default false so an existing tenant's
  /// bootstrap owner is not locked out of the console by this migration.
  adminMfaRequired  Boolean @default(false)
  /// The tenant's password policy. One number today; a policy object when
  /// there is a second rule worth having.
  passwordMinLength Int     @default(12)
  /// Whether a user who is required to hold a second factor may enrol one
  /// themselves, mid-sign-in, after their password has been accepted.
  ///
  /// True by default, because the alternative is that the first tenant-wide
  /// require_mfa rule locks out everyone who has not enrolled and there is no
  /// self-service way back. A tenant that issues hardware keys by hand turns
  /// this off, and then a missing factor really is a refusal.
  selfEnrolmentEnabled Boolean @default(true)
```

Inside `model User`, after `statusReason`:

```prisma
  /// Where this account's password lives. 'local' means Syntra holds an
  /// Argon2id hash; 'upstream' means an external identity provider does, and
  /// self-service reset must send the user there instead of mailing a token.
  passwordSource     String  @default("local")
  /// Human-readable destination for an upstream user: a provider name or a
  /// URL, rendered into the "reset it over there" mail.
  passwordSourceHint String?
```

- [ ] **Step 2: Add the access models**

Append to `packages/db/prisma/schema.prisma`:

```prisma
/// One authentication policy per tenant: an ordered list of rules plus the
/// outcome that applies when none of them match.
model AuthPolicy {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId          String   @unique @db.Uuid
  defaultOutcome    String   @default("allow")
  defaultFactorType String?
  updatedAt         DateTime @updatedAt

  rules AuthPolicyRule[]
}

/// One rule. Every condition column that is empty or null is unconstrained;
/// the conditions that are set must all hold for the rule to match.
model AuthPolicyRule {
  id             String     @id @default(uuid()) @db.Uuid
  tenantId       String     @db.Uuid
  policyId       String     @db.Uuid
  policy         AuthPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)
  position       Int
  name           String
  enabled        Boolean    @default(true)
  /// 'allow' | 'require_mfa' | 'require_factor' | 'deny'
  outcome        String
  /// 'totp' | 'webauthn'. Required when outcome is 'require_factor'.
  factorType     String?
  applicationIds String[]   @default([])
  groupIds       String[]   @default([])
  /// 'department' | 'jobTitle' | 'employer' | 'location'
  contractField  String?
  contractValues String[]   @default([])
  /// CIDR ranges or bare addresses, IPv4 or IPv6.
  ipRanges       String[]   @default([])
  /// 0 = Sunday .. 6 = Saturday. Empty means every day.
  daysOfWeek     Int[]      @default([])
  /// Minutes from local midnight. A window may wrap past midnight.
  startMinute    Int?
  endMinute      Int?
  /// IANA zone the window is expressed in. Treated as UTC when null.
  timezone       String?

  @@unique([policyId, position])
  @@index([tenantId])
}

/// A SAML service provider, an OIDC relying party, or a plain bookmark tile.
/// Access I implements the bookmark; `type` is a free string so Access II
/// widens it without a migration.
model Application {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  name        String
  slug        String
  description String?
  iconUrl     String?
  launchUrl   String?
  type        String   @default("bookmark")
  /// 'assigned' shows the tile to users it resolves for; 'hidden' keeps it
  /// out of the portal entirely while leaving it assignable.
  visibility  String   @default("assigned")
  status      String   @default("active")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  assignments AppAssignment[]

  @@unique([tenantId, slug])
  @@index([tenantId])
}

/// Grants an application to a user, a group, or an organizational unit.
/// Resolution is a union of all matching assignments.
model AppAssignment {
  id            String      @id @default(uuid()) @db.Uuid
  tenantId      String      @db.Uuid
  applicationId String      @db.Uuid
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  /// 'user' | 'group' | 'orgUnit'
  subjectType   String
  userId        String?     @db.Uuid
  groupId       String?     @db.Uuid
  orgUnitId     String?     @db.Uuid
  createdAt     DateTime    @default(now())

  @@index([tenantId])
  @@index([applicationId])
}

/// The encrypted shared secret lives in the vault under `secretName`; this row
/// holds only the parameters and the replay watermark.
model TotpCredential {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String    @db.Uuid
  userId      String    @unique @db.Uuid
  secretName  String
  algorithm   String    @default("SHA1")
  digits      Int       @default(6)
  period      Int       @default(30)
  /// The highest counter step already accepted. A code from this step or an
  /// earlier one is a replay and is refused even though it is arithmetically
  /// valid for the current window.
  lastCounter Int?
  /// Null until the user proves possession by entering a code.
  confirmedAt DateTime?
  createdAt   DateTime  @default(now())

  @@index([tenantId])
}

model WebAuthnCredential {
  id              String    @id @default(uuid()) @db.Uuid
  tenantId        String    @db.Uuid
  userId          String    @db.Uuid
  /// base64url, as returned by @simplewebauthn/server.
  credentialId    String    @unique
  publicKey       Bytes
  /// BigInt, not Int. WebAuthn signature counters are uint32 and Prisma's Int
  /// is a signed int4, so a counter past 2^31 would fail to store on the one
  /// write that matters for cloned-key detection. Converted with Number() at
  /// the library boundary, which is exact well past uint32.
  counter         BigInt    @default(0)
  transports      String[]  @default([])
  attestationType String    @default("none")
  /// The relying-party ID this credential was registered against. An
  /// assertion presented under a different RP ID is refused.
  rpId            String
  label           String
  createdAt       DateTime  @default(now())
  lastUsedAt      DateTime?

  @@index([tenantId])
  @@index([userId])
}

/// At most one live challenge per user and purpose, enforced by a partial
/// unique index on (userId, purpose) WHERE "consumedAt" IS NULL.
model WebAuthnChallenge {
  id         String    @id @default(uuid()) @db.Uuid
  tenantId   String    @db.Uuid
  userId     String    @db.Uuid
  /// 'register' | 'authenticate'
  purpose    String
  challenge  String
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([tenantId])
  @@index([userId, purpose])
}

model RecoveryCode {
  id        String    @id @default(uuid()) @db.Uuid
  tenantId  String    @db.Uuid
  userId    String    @db.Uuid
  codeHash  String
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@unique([userId, codeHash])
  @@index([tenantId])
  @@index([userId])
}

model PasswordResetToken {
  id                String    @id @default(uuid()) @db.Uuid
  tenantId          String    @db.Uuid
  userId            String    @db.Uuid
  tokenHash         String    @unique
  expiresAt         DateTime
  consumedAt        DateTime?
  createdAt         DateTime  @default(now())

  /// Deliberately holds no WebAuthn challenge of its own. A reset that needs a
  /// second factor issues an ordinary `WebAuthnChallenge` with purpose
  /// 'authenticate', so there is one challenge store and one consumption rule
  /// rather than two the verifier would have to choose between.
  @@index([tenantId])
  @@index([userId])
}

/// A primary authentication that succeeded but is waiting on a second factor —
/// either one the user already holds, or one they are about to enrol.
/// It is a credential in its own right, so only its digest is stored.
model AuthAttempt {
  id              String    @id @default(uuid()) @db.Uuid
  tenantId        String    @db.Uuid
  userId          String    @db.Uuid
  tokenHash       String    @unique
  applicationId   String?   @db.Uuid
  sourceIp        String?
  /// 'verify' — present a factor you already hold.
  /// 'enrol'  — enrol a factor of the required kind, because you hold none.
  /// The two are not interchangeable: an enrolment attempt cannot be spent on
  /// a verification, or a user could be walked into enrolling one factor and
  /// signing in with another.
  purpose         String    @default("verify")
  /// The scope of the session to issue when this attempt is satisfied.
  ///
  /// Recorded by whoever issued the attempt, because they are the only party
  /// that knows. Inferring it at the end from "was a session cookie present"
  /// gives an administrative session to any portal user who completes a
  /// step-up, since the browser sends its cookie on every request.
  scope           String    @default("portal")
  /// 'require_mfa' | 'require_factor'
  requiredOutcome String
  requiredFactor  String?
  /// The rule that imposed the requirement, for the audit trail.
  ruleId          String?   @db.Uuid
  expiresAt       DateTime
  consumedAt      DateTime?
  createdAt       DateTime  @default(now())

  @@index([tenantId])
  @@index([userId])
}

/// Declared and revoked in Access I; issued by the OIDC provider in Access II.
/// Password reset must revoke refresh tokens as well as sessions, so the table
/// has to exist for that revocation to be real rather than aspirational.
model RefreshToken {
  id                String    @id @default(uuid()) @db.Uuid
  tenantId          String    @db.Uuid
  userId            String    @db.Uuid
  tokenHash         String    @unique
  clientId          String?
  scope             String    @default("portal")
  createdAt         DateTime  @default(now())
  absoluteExpiresAt DateTime
  revokedAt         DateTime?

  @@index([tenantId])
  @@index([userId])
}
```

- [ ] **Step 3: Generate the migration**

`migrate dev` is interactive and fails in a non-interactive shell. The directory
name is fixed rather than derived from the clock: `date +%H%M%S` before 02:00
would produce a name sorting *before* `20260815020000_mapping_failures`, which
breaks every fresh install while passing the whole suite, because
`resetDatabase()` truncates instead of re-migrating.

```bash
cd packages/db
D="prisma/migrations/20260816000000_access_1"
mkdir -p "$D"
pnpm prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://syntra_app:syntra_app@localhost:5432/syntra_shadow" \
  --script > "$D/migration.sql"
```

- [ ] **Step 4: Verify the sort order**

```bash
cd packages/db && ls prisma/migrations | grep -v migration_lock | sort | tail -2
```

Expected output, in this order:

```
20260815020000_mapping_failures
20260816000000_access_1
```

If the new directory is not last, rename it before going further.

- [ ] **Step 5: Read the generated SQL before appending to it**

```bash
cd packages/db && grep -n -i 'DROP INDEX\|DROP CONSTRAINT\|DROP TABLE\|DROP COLUMN' \
  prisma/migrations/20260816000000_access_1/migration.sql
```

Expected: no output.

`migrate diff --from-migrations` compares the *schema file* against a shadow
database built from the existing migrations, and `schema.prisma` cannot express
a partial index. Every partial index the previous slices created by hand —
`role_assignment_unscoped_unique`, `contract_one_primary_per_person`, and the
sync ones — is therefore invisible to the schema file and looks to the diff
like something the database has that the model does not. If any `DROP` appears,
delete those lines from the generated file before going further: applying them
would silently remove the constraint that stops one user holding the same
unscoped role twice, and nothing in the test suite would notice, because
`resetDatabase()` truncates rather than re-migrating.

The same is true of the five partial indexes this migration adds in the next
step. They live only in the hand-written tail, and a future `migrate diff` will
propose dropping them for exactly the same reason.

- [ ] **Step 6: Append row-level security and the hand-written indexes**

Append to `packages/db/prisma/migrations/20260816000000_access_1/migration.sql`:

```sql
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AuthPolicy','AuthPolicyRule','Application','AppAssignment',
    'TotpCredential','WebAuthnCredential','WebAuthnChallenge','RecoveryCode',
    'PasswordResetToken','AuthAttempt','RefreshToken'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- An assignment names exactly one subject. Without this, a row with every
-- subject column null is a grant to nobody that still resolves as a row.
ALTER TABLE "AppAssignment" ADD CONSTRAINT app_assignment_one_subject CHECK (
  (CASE WHEN "userId"    IS NULL THEN 0 ELSE 1 END) +
  (CASE WHEN "groupId"   IS NULL THEN 0 ELSE 1 END) +
  (CASE WHEN "orgUnitId" IS NULL THEN 0 ELSE 1 END) = 1
);

-- PostgreSQL treats NULL as distinct from NULL, so a plain
-- UNIQUE("applicationId","userId") would not constrain group or org-unit
-- assignments at all, and would let the same user be granted twice. Three
-- partial indexes, one per subject kind, is what actually constrains them.
CREATE UNIQUE INDEX app_assignment_unique_user
  ON "AppAssignment" ("applicationId", "userId") WHERE "userId" IS NOT NULL;
CREATE UNIQUE INDEX app_assignment_unique_group
  ON "AppAssignment" ("applicationId", "groupId") WHERE "groupId" IS NOT NULL;
CREATE UNIQUE INDEX app_assignment_unique_org_unit
  ON "AppAssignment" ("applicationId", "orgUnitId") WHERE "orgUnitId" IS NOT NULL;

-- At most one live WebAuthn challenge per user and purpose. Same reason:
-- "consumedAt" is nullable, so only a partial index constrains the live rows.
CREATE UNIQUE INDEX webauthn_challenge_one_live
  ON "WebAuthnChallenge" ("userId", "purpose") WHERE "consumedAt" IS NULL;

-- One live reset token per user, for the same reason. Requesting a second
-- reset consumes the first rather than leaving two valid tokens in the wild.
CREATE UNIQUE INDEX password_reset_token_one_live
  ON "PasswordResetToken" ("userId") WHERE "consumedAt" IS NULL;
```

- [ ] **Step 7: Apply and regenerate**

```bash
cd packages/db && pnpm prisma migrate deploy && pnpm prisma generate
```

- [ ] **Step 8: Write the failing test**

`packages/db/src/access-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await tx.user.create({
      data: { tenantId, login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' },
    });
    return u.id;
  });
});

const appRow = (slug = 'crm') => ({
  tenantId,
  name: 'CRM',
  slug,
  type: 'bookmark',
  launchUrl: 'https://crm.acme.test/',
});

describe('access schema', () => {
  it('defaults a tenant to no admin MFA, a 12-character minimum, and self-enrolment on', async () => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.adminMfaRequired).toBe(false);
    expect(t.passwordMinLength).toBe(12);
    // On by default: off means a require_mfa rule refuses everyone who has not
    // already enrolled, which is a decision a tenant makes, not a default.
    expect(t.selfEnrolmentEnabled).toBe(true);
  });

  it('defaults an auth attempt to the verify purpose and the portal scope', async () => {
    const attempt = await withTenant(tenantId, (tx) =>
      tx.authAttempt.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'digest',
          requiredOutcome: 'require_mfa',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    expect(attempt.purpose).toBe('verify');
    // Never inferred later from whether a cookie happened to be present.
    expect(attempt.scope).toBe('portal');
  });

  it('records which factor established a session, if any', async () => {
    const plain = await withTenant(tenantId, (tx) =>
      tx.session.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'a',
          scope: 'portal',
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    expect(plain.satisfiedFactor).toBeNull();

    const stepped = await withTenant(tenantId, (tx) =>
      tx.session.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'b',
          scope: 'admin',
          satisfiedFactor: 'totp',
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    expect(stepped.satisfiedFactor).toBe('totp');
  });

  it('stores a WebAuthn counter past the signed 32-bit limit', async () => {
    // Counters are uint32. An Int column would fail on this write, and it is
    // the write that cloned-key detection depends on.
    const row = await withTenant(tenantId, (tx) =>
      tx.webAuthnCredential.create({
        data: {
          tenantId,
          userId,
          credentialId: 'cred-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: BigInt(4_000_000_000),
          rpId: 'acme.syntra.test',
          label: 'Key',
        },
      }),
    );
    expect(row.counter).toBe(BigInt(4_000_000_000));
  });

  it('defaults a user password to local', async () => {
    const u = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(u.passwordSource).toBe('local');
    expect(u.passwordSourceHint).toBeNull();
  });

  it('isolates applications between tenants', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(tenantId, (tx) => tx.application.create({ data: appRow() }));
    const seen = await withTenant(other.id, (tx) => tx.application.findMany());
    expect(seen).toEqual([]);
  });

  it('refuses an assignment that names no subject', async () => {
    const id = await withTenant(tenantId, async (tx) =>
      (await tx.application.create({ data: appRow() })).id,
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.appAssignment.create({
          data: { tenantId, applicationId: id, subjectType: 'user' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an assignment that names two subjects', async () => {
    const ids = await withTenant(tenantId, async (tx) => {
      const a = await tx.application.create({ data: appRow() });
      const g = await tx.group.create({ data: { tenantId, name: 'Nurses' } });
      return { appId: a.id, groupId: g.id };
    });
    await expect(
      withTenant(tenantId, (tx) =>
        tx.appAssignment.create({
          data: {
            tenantId,
            applicationId: ids.appId,
            subjectType: 'user',
            userId,
            groupId: ids.groupId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses the same user assigned to the same application twice', async () => {
    const appId = await withTenant(tenantId, async (tx) =>
      (await tx.application.create({ data: appRow() })).id,
    );
    const row = { tenantId, applicationId: appId, subjectType: 'user', userId };
    await withTenant(tenantId, (tx) => tx.appAssignment.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.appAssignment.create({ data: row })),
    ).rejects.toThrow();
  });

  it('allows a user and a group assignment on the same application', async () => {
    const ids = await withTenant(tenantId, async (tx) => {
      const a = await tx.application.create({ data: appRow() });
      const g = await tx.group.create({ data: { tenantId, name: 'Nurses' } });
      return { appId: a.id, groupId: g.id };
    });
    await withTenant(tenantId, async (tx) => {
      await tx.appAssignment.create({
        data: { tenantId, applicationId: ids.appId, subjectType: 'user', userId },
      });
      await tx.appAssignment.create({
        data: {
          tenantId,
          applicationId: ids.appId,
          subjectType: 'group',
          groupId: ids.groupId,
        },
      });
    });
    expect(await withTenant(tenantId, (tx) => tx.appAssignment.count())).toBe(2);
  });

  it('allows only one live WebAuthn challenge per user and purpose', async () => {
    const row = {
      tenantId,
      userId,
      purpose: 'authenticate',
      expiresAt: new Date(Date.now() + 60_000),
    };
    await withTenant(tenantId, (tx) =>
      tx.webAuthnChallenge.create({ data: { ...row, challenge: 'one' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.webAuthnChallenge.create({ data: { ...row, challenge: 'two' } }),
      ),
    ).rejects.toThrow();

    // Consuming the first frees the slot; the index only covers live rows.
    await withTenant(tenantId, (tx) =>
      tx.webAuthnChallenge.updateMany({
        where: { userId },
        data: { consumedAt: new Date() },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.webAuthnChallenge.create({ data: { ...row, challenge: 'two' } }),
    );
    expect(await withTenant(tenantId, (tx) => tx.webAuthnChallenge.count())).toBe(2);
  });

  it('allows only one live password reset token per user', async () => {
    const row = { tenantId, userId, expiresAt: new Date(Date.now() + 60_000) };
    await withTenant(tenantId, (tx) =>
      tx.passwordResetToken.create({ data: { ...row, tokenHash: 'a' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.passwordResetToken.create({ data: { ...row, tokenHash: 'b' } }),
      ),
    ).rejects.toThrow();
  });

  it('keeps rule positions unique within a policy', async () => {
    const policyId = await withTenant(tenantId, async (tx) => {
      const p = await tx.authPolicy.create({ data: { tenantId } });
      await tx.authPolicyRule.create({
        data: { tenantId, policyId: p.id, position: 1, name: 'First', outcome: 'allow' },
      });
      return p.id;
    });
    await expect(
      withTenant(tenantId, (tx) =>
        tx.authPolicyRule.create({
          data: { tenantId, policyId, position: 1, name: 'Clash', outcome: 'deny' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('cascades rules when the policy is removed', async () => {
    await withTenant(tenantId, async (tx) => {
      const p = await tx.authPolicy.create({ data: { tenantId } });
      await tx.authPolicyRule.create({
        data: { tenantId, policyId: p.id, position: 1, name: 'First', outcome: 'allow' },
      });
      await tx.authPolicy.delete({ where: { id: p.id } });
    });
    expect(await withTenant(tenantId, (tx) => tx.authPolicyRule.count())).toBe(0);
  });
});
```

- [ ] **Step 9: Run the test**

Run: `pnpm vitest run packages/db/src/access-schema.test.ts`
Expected: PASS, 14 tests.

If "one live WebAuthn challenge" does not reject, the partial unique index was
not created. A plain `@@unique` would silently allow it, and every later
challenge-consumption test would pass while the real property was absent. Do not
proceed.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add access management data model"
```

---

## Task 2: The policy engine

**Files:**
- Create: `packages/core/src/policy/types.ts`
- Create: `packages/core/src/policy/ip-match.ts`
- Create: `packages/core/src/policy/time-window.ts`
- Create: `packages/core/src/policy/evaluate.ts`
- Modify: `packages/core/package.json` — add `ipaddr.js`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/policy/ip-match.test.ts`
- Test: `packages/core/src/policy/time-window.test.ts`
- Test: `packages/core/src/policy/evaluate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. This file touches no database.
- Produces:
  - `type PolicyOutcome = 'allow' | 'require_mfa' | 'require_factor' | 'deny'`
  - `type FactorType = 'totp' | 'webauthn'`
  - `type ContractField = 'department' | 'jobTitle' | 'employer' | 'location'`
  - `interface ContractFacts { department: string | null; jobTitle: string | null; employer: string | null; location: string | null }`
  - `interface PolicyRule { id: string; name: string; enabled: boolean; position: number; outcome: PolicyOutcome; factorType: FactorType | null; applicationIds: string[]; groupIds: string[]; contractField: ContractField | null; contractValues: string[]; ipRanges: string[]; daysOfWeek: number[]; startMinute: number | null; endMinute: number | null; timezone: string | null }`
  - `interface PolicyFallback { outcome: PolicyOutcome; factorType: FactorType | null }`
  - `interface AuthContext { userId: string; applicationId: string | null; groupIds: string[]; contracts: ContractFacts[]; sourceIp: string | null; now: Date }`
  - `interface PolicyDecision { outcome: PolicyOutcome; factorType: FactorType | null; ruleId: string | null; ruleName: string | null }`
  - `function evaluatePolicy(rules: PolicyRule[], fallback: PolicyFallback, context: AuthContext): PolicyDecision`
  - `function ruleMatches(rule: PolicyRule, context: AuthContext): boolean`
  - `type ConditionResult = 'match' | 'no-match' | 'unevaluable'`
  - `function evaluateIpRanges(sourceIp: string | null, ranges: string[]): ConditionResult`
  - `function isIpRangeUsable(range: string): boolean`
  - `function evaluateTimeWindow(window: TimeWindow, now: Date): ConditionResult`
  - `function matchesIpRanges(sourceIp: string | null, ranges: string[]): boolean` — `evaluateIpRanges(...) === 'match'`
  - `function matchesTimeWindow(window: TimeWindow, now: Date): boolean` — `evaluateTimeWindow(...) === 'match'`
  - `function isValidTimeZone(zone: string): boolean`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @syntra/core add ipaddr.js@2.5.0
```

`ipaddr.js` ships its own type declarations, has no runtime dependencies, and
handles IPv6 and IPv4-mapped IPv6 — which is what Fastify hands you behind a
dual-stack listener.

- [ ] **Step 2: Write the failing IP test**

`packages/core/src/policy/ip-match.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateIpRanges, isIpRangeUsable, matchesIpRanges } from './ip-match.js';

describe('matchesIpRanges', () => {
  it('treats an empty range list as unconstrained', () => {
    expect(matchesIpRanges('10.0.0.1', [])).toBe(true);
    expect(matchesIpRanges(null, [])).toBe(true);
  });

  it('refuses to match when the range list is set but the address is unknown', () => {
    expect(matchesIpRanges(null, ['10.0.0.0/8'])).toBe(false);
  });

  it('matches an IPv4 address inside a CIDR', () => {
    expect(matchesIpRanges('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(matchesIpRanges('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('matches a bare address exactly', () => {
    expect(matchesIpRanges('10.1.2.3', ['10.1.2.3'])).toBe(true);
    expect(matchesIpRanges('10.1.2.4', ['10.1.2.3'])).toBe(false);
  });

  it('matches any range in the list', () => {
    expect(matchesIpRanges('192.168.5.5', ['10.0.0.0/8', '192.168.0.0/16'])).toBe(true);
  });

  it('matches IPv6 CIDRs', () => {
    expect(matchesIpRanges('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(matchesIpRanges('2001:dba::1', ['2001:db8::/32'])).toBe(false);
  });

  it('normalises an IPv4-mapped IPv6 address to IPv4', () => {
    // Node hands this shape out of a dual-stack socket. Without normalisation
    // an office allowlist written in IPv4 would never match.
    expect(matchesIpRanges('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  it('does not throw when the families differ', () => {
    // ipaddr.js's match() throws across families rather than returning false.
    expect(matchesIpRanges('2001:db8::1', ['10.0.0.0/8'])).toBe(false);
    expect(matchesIpRanges('10.1.2.3', ['2001:db8::/32'])).toBe(false);
  });

  it('ignores a malformed range instead of failing the whole rule', () => {
    expect(matchesIpRanges('10.1.2.3', ['not-an-address', '10.0.0.0/8'])).toBe(true);
    expect(matchesIpRanges('10.1.2.3', ['not-an-address'])).toBe(false);
  });

  it('treats a malformed source address as no match', () => {
    expect(matchesIpRanges('unix:/tmp/sock', ['10.0.0.0/8'])).toBe(false);
  });

  it('matches the private and documentation ranges a real tenant writes', () => {
    // Every one of these was rejected by the first draft's validator, which
    // used a matcher as a syntax check. They are the ranges people actually
    // type into an office allowlist.
    expect(matchesIpRanges('192.168.5.5', ['192.168.0.0/16'])).toBe(true);
    expect(matchesIpRanges('172.16.4.1', ['172.16.0.0/12'])).toBe(true);
    expect(matchesIpRanges('198.51.100.7', ['198.51.100.0/24'])).toBe(true);
    expect(matchesIpRanges('8.8.8.8', ['8.8.8.8'])).toBe(true);
  });
});

describe('isIpRangeUsable', () => {
  it('accepts every well-formed range and address', () => {
    for (const range of [
      '10.0.0.0/8',
      '192.168.0.0/16',
      '172.16.0.0/12',
      '198.51.100.0/24',
      '0.0.0.0/0',
      '8.8.8.8',
      '2001:db8::/32',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isIpRangeUsable(range)).toBe(true);
    }
  });

  it('rejects a prefix length that is not a prefix length', () => {
    expect(isIpRangeUsable('10.0.0.0/33')).toBe(false);
    expect(isIpRangeUsable('10.0.0.0/-1')).toBe(false);
  });

  it('rejects an address that is not an address', () => {
    expect(isIpRangeUsable('999.1.1.1/8')).toBe(false);
    expect(isIpRangeUsable('10.0.0.256')).toBe(false);
    expect(isIpRangeUsable('the office')).toBe(false);
    expect(isIpRangeUsable('')).toBe(false);
  });
});

describe('evaluateIpRanges', () => {
  it('is unconstrained when no ranges are named', () => {
    expect(evaluateIpRanges('10.0.0.1', [])).toBe('match');
    expect(evaluateIpRanges(null, [])).toBe('match');
  });

  it('separates "did not match" from "could not be decided"', () => {
    expect(evaluateIpRanges('11.0.0.1', ['10.0.0.0/8'])).toBe('no-match');
    // No address to test: not a miss, an unanswerable question.
    expect(evaluateIpRanges(null, ['10.0.0.0/8'])).toBe('unevaluable');
    expect(evaluateIpRanges('unix:/tmp/sock', ['10.0.0.0/8'])).toBe('unevaluable');
    expect(evaluateIpRanges('10.0.0.1', ['nonsense'])).toBe('unevaluable');
  });

  it('reports unevaluable when a usable range misses and an unusable one remains', () => {
    // The rule meant to cover both. One of them cannot be read, so "no" is not
    // an honest answer.
    expect(evaluateIpRanges('11.0.0.1', ['10.0.0.0/8', 'nonsense'])).toBe('unevaluable');
    // …but a hit on the readable half settles it.
    expect(evaluateIpRanges('10.0.0.1', ['10.0.0.0/8', 'nonsense'])).toBe('match');
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/policy/ip-match.test.ts`
Expected: FAIL — cannot resolve `./ip-match.js`.

- [ ] **Step 4: Implement the IP matcher**

`packages/core/src/policy/ip-match.ts`:

```ts
import ipaddr from 'ipaddr.js';

/**
 * Three answers, not two. A condition can hold, fail to hold, or be
 * undecidable — and the third is not the second. `ruleMatches` resolves
 * `unevaluable` differently depending on the rule's outcome; see evaluate.ts.
 */
export type ConditionResult = 'match' | 'no-match' | 'unevaluable';

/**
 * Whether a stored range is syntactically a range at all.
 *
 * A parse in a try/catch, which is what a syntax check is. The first draft
 * asked instead whether the range contained one of four probe addresses, and
 * so rejected 192.168.0.0/16, 172.16.0.0/12, 198.51.100.0/24 and every literal
 * host address — a matcher used as a validator answers a different question
 * than the one being asked.
 */
export function isIpRangeUsable(range: string): boolean {
  try {
    if (range.includes('/')) ipaddr.parseCIDR(range);
    else ipaddr.process(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `sourceIp` falls in any of `ranges`, which may hold CIDR notation or
 * bare addresses, IPv4 or IPv6.
 *
 * An empty list is not a condition at all: a rule that names no ranges is
 * unconstrained by address and holds for everything.
 *
 * Everything else that is not a clean hit or a clean miss is `unevaluable`: no
 * source address to test, a source address that will not parse, or a range
 * that will not parse. The caller decides what an undecidable condition means,
 * because the answer differs between a rule that lets people in and one that
 * keeps them out.
 *
 * ipaddr.js's match() throws when the families differ rather than returning
 * false, so kinds are compared before it is called.
 */
export function evaluateIpRanges(
  sourceIp: string | null,
  ranges: string[],
): ConditionResult {
  if (ranges.length === 0) return 'match';

  const usable = ranges.filter(isIpRangeUsable);
  if (usable.length === 0) return 'unevaluable';
  if (!sourceIp) return 'unevaluable';

  let addr: ReturnType<typeof ipaddr.process>;
  try {
    // process(), not parse(): it folds ::ffff:10.0.0.1 down to 10.0.0.1, which
    // is the shape a dual-stack listener reports for an IPv4 client.
    addr = ipaddr.process(sourceIp);
  } catch {
    return 'unevaluable';
  }

  for (const range of usable) {
    try {
      if (range.includes('/')) {
        const cidr = ipaddr.parseCIDR(range);
        if (cidr[0].kind() !== addr.kind()) continue;
        if (addr.match(cidr)) return 'match';
      } else {
        const other = ipaddr.process(range);
        if (other.kind() !== addr.kind()) continue;
        if (addr.toNormalizedString() === other.toNormalizedString()) return 'match';
      }
    } catch {
      continue;
    }
  }

  // Nothing hit. If part of the list could not be read, the rule covered
  // addresses this cannot see, and "no" would be an overstatement.
  return usable.length === ranges.length ? 'no-match' : 'unevaluable';
}

export const matchesIpRanges = (sourceIp: string | null, ranges: string[]): boolean =>
  evaluateIpRanges(sourceIp, ranges) === 'match';
```

- [ ] **Step 5: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/policy/ip-match.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Write the failing time-window test**

`packages/core/src/policy/time-window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateTimeWindow, isValidTimeZone, matchesTimeWindow } from './time-window.js';

const at = (iso: string) => new Date(iso);

describe('isValidTimeZone', () => {
  it('accepts an IANA zone', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isValidTimeZone('Middle/Earth')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('matchesTimeWindow', () => {
  const unconstrained = {
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  it('matches when nothing is constrained', () => {
    expect(matchesTimeWindow(unconstrained, at('2026-08-12T03:00:00Z'))).toBe(true);
  });

  it('matches a weekday list', () => {
    // 2026-08-12 is a Wednesday (3); 2026-08-15 is a Saturday (6).
    const weekdays = { ...unconstrained, daysOfWeek: [1, 2, 3, 4, 5] };
    expect(matchesTimeWindow(weekdays, at('2026-08-12T09:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(weekdays, at('2026-08-15T09:00:00Z'))).toBe(false);
  });

  it('matches a same-day window inclusively at both ends', () => {
    const office = { ...unconstrained, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(matchesTimeWindow(office, at('2026-08-12T09:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(office, at('2026-08-12T17:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(office, at('2026-08-12T08:59:00Z'))).toBe(false);
    expect(matchesTimeWindow(office, at('2026-08-12T17:01:00Z'))).toBe(false);
  });

  it('matches a window that wraps past midnight', () => {
    const night = { ...unconstrained, startMinute: 22 * 60, endMinute: 6 * 60 };
    expect(matchesTimeWindow(night, at('2026-08-12T23:30:00Z'))).toBe(true);
    expect(matchesTimeWindow(night, at('2026-08-12T02:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(night, at('2026-08-12T12:00:00Z'))).toBe(false);
  });

  it('reads the clock in the rule timezone, not the server one', () => {
    // 07:30 UTC is 09:30 in Amsterdam in August (CEST, UTC+2).
    const office = {
      ...unconstrained,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: 'Europe/Amsterdam',
    };
    expect(matchesTimeWindow(office, at('2026-08-12T07:30:00Z'))).toBe(true);
    expect(matchesTimeWindow(office, at('2026-08-12T06:30:00Z'))).toBe(false);
  });

  it('reads the weekday in the rule timezone too', () => {
    // 2026-08-12T23:30Z is already Thursday in Amsterdam.
    const wednesday = { ...unconstrained, daysOfWeek: [3], timezone: 'Europe/Amsterdam' };
    expect(matchesTimeWindow(wednesday, at('2026-08-12T23:30:00Z'))).toBe(false);
    const thursday = { ...unconstrained, daysOfWeek: [4], timezone: 'Europe/Amsterdam' };
    expect(matchesTimeWindow(thursday, at('2026-08-12T23:30:00Z'))).toBe(true);
  });

  it('handles midnight as minute zero rather than 1440', () => {
    const earlyHours = { ...unconstrained, startMinute: 0, endMinute: 5 * 60 };
    expect(matchesTimeWindow(earlyHours, at('2026-08-12T00:00:00Z'))).toBe(true);
  });

  it('does not match when the timezone is unusable', () => {
    // Write-time validation is what keeps this from happening; if a row is
    // corrupt anyway, the rule fails to match rather than throwing into the
    // middle of a login.
    const broken = { ...unconstrained, daysOfWeek: [3], timezone: 'Middle/Earth' };
    expect(matchesTimeWindow(broken, at('2026-08-12T09:00:00Z'))).toBe(false);
  });

  it('ignores a half-specified window', () => {
    const halfOpen = { ...unconstrained, startMinute: 9 * 60, endMinute: null };
    expect(matchesTimeWindow(halfOpen, at('2026-08-12T03:00:00Z'))).toBe(true);
  });
});

describe('evaluateTimeWindow', () => {
  const unconstrained = {
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  it('separates "outside the window" from "could not be decided"', () => {
    const office = { ...unconstrained, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(evaluateTimeWindow(office, at('2026-08-12T12:00:00Z'))).toBe('match');
    expect(evaluateTimeWindow(office, at('2026-08-12T03:00:00Z'))).toBe('no-match');

    const broken = { ...office, timezone: 'Middle/Earth' };
    expect(evaluateTimeWindow(broken, at('2026-08-12T12:00:00Z'))).toBe('unevaluable');
  });

  it('is unconstrained when neither dimension is set', () => {
    expect(evaluateTimeWindow(unconstrained, at('2026-08-12T03:00:00Z'))).toBe('match');
  });
});
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/policy/time-window.test.ts`
Expected: FAIL — cannot resolve `./time-window.js`.

- [ ] **Step 8: Implement the time window**

`packages/core/src/policy/time-window.ts`:

```ts
import type { ConditionResult } from './ip-match.js';

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface LocalClock {
  day: number;
  minute: number;
}

/**
 * The weekday and minute-of-day at `now` in `zone`. hourCycle 'h23' is not
 * optional: with hour12 false, some ICU builds render midnight as 24 rather
 * than 00, which puts every early-hours request outside every window.
 */
function localClock(now: Date, zone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  let day = -1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') day = DAY_INDEX[part.value] ?? -1;
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }

  return { day, minute: hour * 60 + minute };
}

export interface TimeWindow {
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

/**
 * Whether `now` falls inside the rule's window.
 *
 * An empty day list and a missing start or end are not conditions: they leave
 * that dimension unconstrained. Both ends of the minute range are inclusive,
 * and a range whose end is below its start wraps past midnight — 22:00 to
 * 06:00 is one window, not an empty one.
 *
 * A timezone the platform cannot resolve means the condition cannot be
 * decided, and `unevaluable` says so rather than pretending it was a miss.
 * Write-time validation is what keeps that from happening; this is the
 * backstop, and it must not throw, because a throw here lands in the middle of
 * a login.
 */
export function evaluateTimeWindow(window: TimeWindow, now: Date): ConditionResult {
  const constrainsDays = window.daysOfWeek.length > 0;
  const constrainsHours =
    window.startMinute !== null && window.endMinute !== null;
  if (!constrainsDays && !constrainsHours) return 'match';

  const zone = window.timezone ?? 'UTC';
  let clock: LocalClock;
  try {
    clock = localClock(now, zone);
  } catch {
    return 'unevaluable';
  }
  if (clock.day < 0) return 'unevaluable';

  if (constrainsDays && !window.daysOfWeek.includes(clock.day)) return 'no-match';

  if (constrainsHours) {
    const start = window.startMinute!;
    const end = window.endMinute!;
    const inside =
      start <= end
        ? clock.minute >= start && clock.minute <= end
        : clock.minute >= start || clock.minute <= end;
    if (!inside) return 'no-match';
  }

  return 'match';
}

export const matchesTimeWindow = (window: TimeWindow, now: Date): boolean =>
  evaluateTimeWindow(window, now) === 'match';
```

- [ ] **Step 9: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/policy/time-window.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 10: Write the types**

`packages/core/src/policy/types.ts`:

```ts
export type PolicyOutcome = 'allow' | 'require_mfa' | 'require_factor' | 'deny';

export const POLICY_OUTCOMES: PolicyOutcome[] = [
  'allow',
  'require_mfa',
  'require_factor',
  'deny',
];

export type FactorType = 'totp' | 'webauthn';

export const FACTOR_TYPES: FactorType[] = ['totp', 'webauthn'];

export type ContractField = 'department' | 'jobTitle' | 'employer' | 'location';

export const CONTRACT_FIELDS: ContractField[] = [
  'department',
  'jobTitle',
  'employer',
  'location',
];

/** The subset of a Contract a policy rule may read. */
export interface ContractFacts {
  department: string | null;
  jobTitle: string | null;
  employer: string | null;
  location: string | null;
}

/**
 * One rule, already loaded and narrowed. Every condition that is empty or null
 * is unconstrained; the ones that are set must all hold.
 */
export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: PolicyOutcome;
  factorType: FactorType | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: ContractField | null;
  contractValues: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

/** What applies when no rule matches. */
export interface PolicyFallback {
  outcome: PolicyOutcome;
  factorType: FactorType | null;
}

/**
 * Everything the engine is allowed to know. Assembled once by
 * buildAuthContext; the engine never reaches past it.
 */
export interface AuthContext {
  userId: string;
  /** The application being entered, or null for the Syntra portal itself. */
  applicationId: string | null;
  groupIds: string[];
  /** One entry per contract in force right now. Empty is ordinary. */
  contracts: ContractFacts[];
  sourceIp: string | null;
  now: Date;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  factorType: FactorType | null;
  /** The rule that decided, or null when the fallback applied. */
  ruleId: string | null;
  ruleName: string | null;
}
```

- [ ] **Step 11: Write the failing evaluation test**

`packages/core/src/policy/evaluate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, ruleMatches } from './evaluate.js';
import type { AuthContext, PolicyFallback, PolicyRule } from './types.js';

const ALLOW: PolicyFallback = { outcome: 'allow', factorType: null };

let seq = 0;
const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: `rule-${++seq}`,
  name: `Rule ${seq}`,
  enabled: true,
  position: seq,
  outcome: 'deny',
  factorType: null,
  applicationIds: [],
  groupIds: [],
  contractField: null,
  contractValues: [],
  ipRanges: [],
  daysOfWeek: [],
  startMinute: null,
  endMinute: null,
  timezone: null,
  ...over,
});

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'user-1',
  applicationId: null,
  groupIds: [],
  contracts: [],
  sourceIp: '10.1.2.3',
  now: new Date('2026-08-12T09:00:00Z'),
  ...over,
});

describe('evaluatePolicy', () => {
  it('falls back when there are no rules', () => {
    expect(evaluatePolicy([], ALLOW, ctx())).toEqual({
      outcome: 'allow',
      factorType: null,
      ruleId: null,
      ruleName: null,
    });
  });

  it('falls back to a require_factor default', () => {
    const fallback: PolicyFallback = { outcome: 'require_factor', factorType: 'webauthn' };
    expect(evaluatePolicy([], fallback, ctx())).toEqual({
      outcome: 'require_factor',
      factorType: 'webauthn',
      ruleId: null,
      ruleName: null,
    });
  });

  it('takes the first matching rule and stops', () => {
    const first = rule({ position: 1, outcome: 'require_mfa' });
    const second = rule({ position: 2, outcome: 'deny' });
    const decision = evaluatePolicy([first, second], ALLOW, ctx());
    expect(decision.outcome).toBe('require_mfa');
    expect(decision.ruleId).toBe(first.id);
  });

  it('evaluates in position order regardless of array order', () => {
    const later = rule({ position: 9, outcome: 'deny' });
    const earlier = rule({ position: 1, outcome: 'allow' });
    const decision = evaluatePolicy([later, earlier], ALLOW, ctx());
    expect(decision.ruleId).toBe(earlier.id);
  });

  it('skips a disabled rule', () => {
    const off = rule({ position: 1, outcome: 'deny', enabled: false });
    expect(evaluatePolicy([off], ALLOW, ctx()).outcome).toBe('allow');
  });

  it('matches on group membership', () => {
    const r = rule({ outcome: 'require_mfa', groupIds: ['g-finance'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-finance'] })).outcome).toBe(
      'require_mfa',
    );
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-care'] })).outcome).toBe('allow');
  });

  it('matches when the user is in any one of several named groups', () => {
    const r = rule({ outcome: 'deny', groupIds: ['g-a', 'g-b'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-b'] })).outcome).toBe('deny');
  });

  it('matches on the target application', () => {
    const r = rule({ outcome: 'require_factor', factorType: 'webauthn', applicationIds: ['app-1'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ applicationId: 'app-1' })).outcome).toBe(
      'require_factor',
    );
    expect(evaluatePolicy([r], ALLOW, ctx({ applicationId: 'app-2' })).outcome).toBe('allow');
  });

  it('does not match an application-scoped rule when there is no application', () => {
    // Signing in to the portal is not signing in to any application, so a rule
    // written about one application must not govern it.
    const r = rule({ outcome: 'deny', applicationIds: ['app-1'] });
    expect(evaluatePolicy([r], ALLOW, ctx({ applicationId: null })).outcome).toBe('allow');
  });

  it('matches a contract condition when any active contract satisfies it', () => {
    const r = rule({
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    const twoContracts = ctx({
      contracts: [
        { department: 'Care', jobTitle: null, employer: null, location: null },
        { department: 'Finance', jobTitle: null, employer: null, location: null },
      ],
    });
    expect(evaluatePolicy([r], ALLOW, twoContracts).outcome).toBe('require_mfa');
  });

  it('does not match a contract condition when no active contract satisfies it', () => {
    const r = rule({
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    const ended = ctx({
      contracts: [{ department: 'Care', jobTitle: null, employer: null, location: null }],
    });
    expect(evaluatePolicy([r], ALLOW, ended).outcome).toBe('allow');
  });

  it('does not match a contract condition for a person with no active contract', () => {
    const r = rule({
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    expect(evaluatePolicy([r], ALLOW, ctx({ contracts: [] })).outcome).toBe('allow');
  });

  it('compares contract values case-insensitively and ignoring surrounding space', () => {
    const r = rule({
      outcome: 'deny',
      contractField: 'jobTitle',
      contractValues: ['Registered Nurse'],
    });
    const messy = ctx({
      contracts: [
        { department: null, jobTitle: '  registered nurse ', employer: null, location: null },
      ],
    });
    expect(evaluatePolicy([r], ALLOW, messy).outcome).toBe('deny');
  });

  it('does not match a contract condition against a null field', () => {
    const r = rule({ outcome: 'deny', contractField: 'employer', contractValues: ['Acme'] });
    const noEmployer = ctx({
      contracts: [{ department: 'Care', jobTitle: null, employer: null, location: null }],
    });
    expect(evaluatePolicy([r], ALLOW, noEmployer).outcome).toBe('allow');
  });

  it('matches on source address', () => {
    const r = rule({ outcome: 'allow', ipRanges: ['10.0.0.0/8'] });
    expect(evaluatePolicy([r], { outcome: 'deny', factorType: null }, ctx()).outcome).toBe(
      'allow',
    );
    const offsite = ctx({ sourceIp: '203.0.113.9' });
    expect(
      evaluatePolicy([r], { outcome: 'deny', factorType: null }, offsite).outcome,
    ).toBe('deny');
  });

  it('matches on a time window', () => {
    const r = rule({ outcome: 'deny', startMinute: 22 * 60, endMinute: 6 * 60 });
    expect(evaluatePolicy([r], ALLOW, ctx({ now: new Date('2026-08-12T23:00:00Z') })).outcome).toBe(
      'deny',
    );
    expect(evaluatePolicy([r], ALLOW, ctx({ now: new Date('2026-08-12T12:00:00Z') })).outcome).toBe(
      'allow',
    );
  });

  it('requires every condition a rule sets, not just one', () => {
    const r = rule({
      outcome: 'deny',
      groupIds: ['g-finance'],
      ipRanges: ['203.0.113.0/24'],
    });
    // In the group, but on the office network: the address condition fails.
    expect(evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-finance'] })).outcome).toBe('allow');
    // Both hold.
    const both = ctx({ groupIds: ['g-finance'], sourceIp: '203.0.113.9' });
    expect(evaluatePolicy([r], ALLOW, both).outcome).toBe('deny');
  });

  it('carries the deciding rule name so a denial can be explained', () => {
    const r = rule({ name: 'Block offsite finance', outcome: 'deny', groupIds: ['g-finance'] });
    const decision = evaluatePolicy([r], ALLOW, ctx({ groupIds: ['g-finance'] }));
    expect(decision.ruleName).toBe('Block offsite finance');
    expect(decision.ruleId).toBe(r.id);
  });

  it('carries the required factor for a require_factor outcome', () => {
    const r = rule({ outcome: 'require_factor', factorType: 'webauthn' });
    expect(evaluatePolicy([r], ALLOW, ctx())).toMatchObject({
      outcome: 'require_factor',
      factorType: 'webauthn',
    });
  });

  it('degrades a require_factor rule with no factor type to require_mfa', () => {
    // Write-time validation refuses this shape; if a row is corrupt anyway,
    // demanding *some* factor is the safe reading. It must never silently
    // become an allow.
    const r = rule({ outcome: 'require_factor', factorType: null });
    expect(evaluatePolicy([r], ALLOW, ctx())).toMatchObject({
      outcome: 'require_mfa',
      factorType: null,
    });
  });

  it('does not let a broken condition stop a deny rule applying', () => {
    // The only fail-closed branch in the engine. A malformed range in a rule
    // written to refuse people must not silently turn into "refuse nobody".
    const broken = rule({ outcome: 'deny', ipRanges: ['203.0.113.0/99'] });
    expect(evaluatePolicy([broken], ALLOW, ctx()).outcome).toBe('deny');

    // The same broken condition on an allow rule does not match, so the rule
    // does not let anyone past a condition it cannot check.
    const permissive = rule({ outcome: 'allow', ipRanges: ['203.0.113.0/99'] });
    expect(
      evaluatePolicy([permissive], { outcome: 'deny', factorType: null }, ctx()).outcome,
    ).toBe('deny');
  });

  it('denies when there is no source address to test a deny rule against', () => {
    const offsite = rule({ outcome: 'deny', ipRanges: ['203.0.113.0/24'] });
    // A request whose origin could not be determined is not evidence that it
    // came from somewhere allowed.
    expect(evaluatePolicy([offsite], ALLOW, ctx({ sourceIp: null })).outcome).toBe('deny');
  });

  it('does not let an unresolvable timezone stop a deny rule applying', () => {
    const nights = rule({
      outcome: 'deny',
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      timezone: 'Middle/Earth',
    });
    expect(evaluatePolicy([nights], ALLOW, ctx()).outcome).toBe('deny');
  });

  it('still evaluates a deny rule normally when its conditions are readable', () => {
    // Fail-closed is a backstop, not a shortcut: a well-formed deny rule that
    // simply does not match must still not match.
    const offsite = rule({ outcome: 'deny', ipRanges: ['203.0.113.0/24'] });
    expect(evaluatePolicy([offsite], ALLOW, ctx({ sourceIp: '10.1.2.3' })).outcome).toBe(
      'allow',
    );
  });

  it('exposes the per-rule match so the console can preview it', () => {
    const r = rule({ outcome: 'deny', groupIds: ['g-finance'] });
    expect(ruleMatches(r, ctx({ groupIds: ['g-finance'] }))).toBe(true);
    expect(ruleMatches(r, ctx({ groupIds: ['g-care'] }))).toBe(false);
  });

  it('is a pure function of its arguments', () => {
    const r = rule({ outcome: 'deny', groupIds: ['g-finance'] });
    const context = ctx({ groupIds: ['g-finance'] });
    const first = evaluatePolicy([r], ALLOW, context);
    const second = evaluatePolicy([r], ALLOW, context);
    expect(first).toEqual(second);
    expect(context.groupIds).toEqual(['g-finance']);
  });
});
```

- [ ] **Step 12: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/policy/evaluate.test.ts`
Expected: FAIL — cannot resolve `./evaluate.js`.

- [ ] **Step 13: Implement the engine**

`packages/core/src/policy/evaluate.ts`:

```ts
import { evaluateIpRanges, type ConditionResult } from './ip-match.js';
import { evaluateTimeWindow } from './time-window.js';
import type {
  AuthContext,
  ContractFacts,
  PolicyDecision,
  PolicyFallback,
  PolicyRule,
} from './types.js';

const norm = (value: string) => value.trim().toLowerCase();

/**
 * A contract condition matches if ANY of the person's currently active
 * contracts satisfies it. A person with two concurrent engagements is in
 * Finance if either of them is; a person whose Finance contract ended last
 * month is not.
 *
 * A null field never matches: "department is Finance" is a claim about a
 * department, and a contract with no department recorded does not make it.
 */
function matchesContracts(rule: PolicyRule, contracts: ContractFacts[]): boolean {
  if (!rule.contractField || rule.contractValues.length === 0) return true;

  const wanted = new Set(rule.contractValues.map(norm));
  return contracts.some((contract) => {
    const value = contract[rule.contractField!];
    return value !== null && wanted.has(norm(value));
  });
}

function matchesApplication(rule: PolicyRule, applicationId: string | null): boolean {
  if (rule.applicationIds.length === 0) return true;
  if (applicationId === null) return false;
  return rule.applicationIds.includes(applicationId);
}

function matchesGroups(rule: PolicyRule, groupIds: string[]): boolean {
  if (rule.groupIds.length === 0) return true;
  return rule.groupIds.some((id) => groupIds.includes(id));
}

/**
 * Whether one rule's conditions all hold for this context.
 *
 * Exported because the administration console asks the same question of a rule
 * that has not been saved yet, to count who it would affect before it is
 * stored. That preview and the live decision must agree, so they share this
 * function rather than each carrying their own reading of the conditions.
 *
 * THE ASYMMETRY, WHICH IS DELIBERATE. Two of the five conditions can be
 * undecidable rather than simply false: a source-address condition with no
 * address to test or a malformed range, and a time window in a timezone the
 * platform cannot resolve. An undecidable condition resolves to *false* on
 * `allow`, `require_mfa` and `require_factor`, and to *true* on `deny`.
 *
 * It looks like an inconsistency and it is not. Resolving to false everywhere
 * means a rule written to refuse people quietly stops refusing them the moment
 * one of its own fields is broken — a typo in a CIDR turns "block this range"
 * into "block nobody", and nothing anywhere reports it. Resolving to true
 * everywhere would be worse in the other direction: a broken `allow` rule
 * would start letting people past conditions it was supposed to enforce. Each
 * outcome fails towards refusing, which is the only direction that is safe in
 * both cases.
 *
 * Write-time validation in policy-service.ts is what keeps this from arising;
 * this is the backstop for a row that predates the check or arrives some other
 * way.
 */
export function ruleMatches(rule: PolicyRule, context: AuthContext): boolean {
  const failClosed = rule.outcome === 'deny';
  const decided = (result: ConditionResult): boolean =>
    result === 'match' || (result === 'unevaluable' && failClosed);

  return (
    matchesApplication(rule, context.applicationId) &&
    matchesGroups(rule, context.groupIds) &&
    matchesContracts(rule, context.contracts) &&
    decided(evaluateIpRanges(context.sourceIp, rule.ipRanges)) &&
    decided(evaluateTimeWindow(rule, context.now))
  );
}

/**
 * The authentication policy engine.
 *
 * A pure function of the rule set, the fallback and the request context: no
 * database, no ambient clock, no configuration. That is what makes the whole
 * matrix testable without a server, and it is why `now` is a field on the
 * context rather than a call to Date.now() in here.
 *
 * Rules are evaluated in ascending position and the first match decides. A
 * rule's conditions are conjunctive — every condition it sets must hold — and
 * a condition it leaves empty is not a condition at all.
 */
export function evaluatePolicy(
  rules: PolicyRule[],
  fallback: PolicyFallback,
  context: AuthContext,
): PolicyDecision {
  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.position - b.position);

  for (const rule of ordered) {
    if (!ruleMatches(rule, context)) continue;

    // A require_factor rule with no factor named cannot be honoured as
    // written. Demanding some factor is the safe reading; silently allowing
    // would turn a corrupt row into a bypass.
    if (rule.outcome === 'require_factor' && rule.factorType === null) {
      return {
        outcome: 'require_mfa',
        factorType: null,
        ruleId: rule.id,
        ruleName: rule.name,
      };
    }

    return {
      outcome: rule.outcome,
      factorType: rule.outcome === 'require_factor' ? rule.factorType : null,
      ruleId: rule.id,
      ruleName: rule.name,
    };
  }

  return {
    outcome: fallback.outcome,
    factorType: fallback.outcome === 'require_factor' ? fallback.factorType : null,
    ruleId: null,
    ruleName: null,
  };
}
```

- [ ] **Step 14: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/policy/evaluate.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 15: Export from core**

Add to `packages/core/src/index.ts`, after the `./auth/login-service.js` line:

```ts
export * from './policy/types.js';
export * from './policy/ip-match.js';
export * from './policy/time-window.js';
export * from './policy/evaluate.js';
```

- [ ] **Step 16: Typecheck and commit**

```bash
pnpm exec tsc -b
git add -A
git commit -m "feat: add the authentication policy engine"
```

---

## Task 3: Policy storage and request context

**Files:**
- Create: `packages/core/src/policy/policy-service.ts`
- Create: `packages/core/src/policy/context.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/policy/policy-service.test.ts`
- Test: `packages/core/src/policy/context.test.ts`

**Interfaces:**
- Consumes: from Task 2 — `PolicyRule`, `PolicyFallback`, `AuthContext`, `ContractFacts`, `PolicyOutcome`, `FactorType`, `ContractField`, `isValidTimeZone`. From the existing codebase — `TenantClient` and `withTenant` from `@syntra/db`, `currentTenant` from `../tenant-context.js`, `listGroupsForUser` from `../directory/group-service.js`, `activeContracts` from `../identity/contract-service.js`.
- Produces:
  - `interface LoadedPolicy { rules: PolicyRule[]; fallback: PolicyFallback }`
  - `function loadPolicy(tx: TenantClient): Promise<LoadedPolicy>`
  - `function setPolicyDefault(tx: TenantClient, fallback: PolicyFallback): Promise<void>`
  - `interface RuleInput { name: string; enabled?: boolean; outcome: PolicyOutcome; factorType?: FactorType | null; applicationIds?: string[]; groupIds?: string[]; contractField?: ContractField | null; contractValues?: string[]; ipRanges?: string[]; daysOfWeek?: number[]; startMinute?: number | null; endMinute?: number | null; timezone?: string | null }`
  - `function addRule(tx: TenantClient, input: RuleInput): Promise<PolicyRule>` — refuses a `require_factor: webauthn` rule when the tenant has no `primaryDomain`
  - `function updateRule(tx: TenantClient, ruleId: string, input: RuleInput): Promise<PolicyRule>`
  - `function deleteRule(tx: TenantClient, ruleId: string): Promise<void>`
  - `function reorderRules(tx: TenantClient, ruleIds: string[]): Promise<void>`
  - `function buildAuthContext(tx: TenantClient, input: { userId: string; applicationId: string | null; sourceIp: string | null; now: Date }): Promise<AuthContext>`

- [ ] **Step 1: Write the failing policy-storage test**

`packages/core/src/policy/policy-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addRule, deleteRule, loadPolicy, reorderRules, setPolicyDefault, updateRule } from './policy-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('loadPolicy', () => {
  it('returns an allow fallback and no rules for a tenant that has never configured one', async () => {
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy).toEqual({ rules: [], fallback: { outcome: 'allow', factorType: null } });
  });

  it('returns the configured fallback', async () => {
    await withTenant(tenantId, (tx) =>
      setPolicyDefault(tx, { outcome: 'require_mfa', factorType: null }),
    );
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.fallback).toEqual({ outcome: 'require_mfa', factorType: null });
  });
});

describe('addRule', () => {
  it('appends at the next position', async () => {
    const positions = await withTenant(tenantId, async (tx) => {
      const first = await addRule(tx, { name: 'First', outcome: 'allow' });
      const second = await addRule(tx, { name: 'Second', outcome: 'deny' });
      return [first.position, second.position];
    });
    expect(positions).toEqual([1, 2]);
  });

  it('creates the tenant policy row on first use', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'First', outcome: 'allow' }));
    expect(await withTenant(tenantId, (tx) => tx.authPolicy.count())).toBe(1);
  });

  it('defaults every condition to unconstrained', async () => {
    const rule = await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Bare', outcome: 'deny' }),
    );
    expect(rule).toMatchObject({
      enabled: true,
      applicationIds: [],
      groupIds: [],
      contractField: null,
      contractValues: [],
      ipRanges: [],
      daysOfWeek: [],
      startMinute: null,
      endMinute: null,
      timezone: null,
    });
  });

  it('refuses require_factor without a factor type', async () => {
    await expect(
      withTenant(tenantId, (tx) => addRule(tx, { name: 'Bad', outcome: 'require_factor' })),
    ).rejects.toThrow(/factorType/);
  });

  it('refuses an unusable timezone', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, {
          name: 'Bad zone',
          outcome: 'deny',
          startMinute: 0,
          endMinute: 60,
          timezone: 'Middle/Earth',
        }),
      ),
    ).rejects.toThrow(/timezone/);
  });

  it('refuses a malformed IP range rather than storing one that can never match', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'Bad range', outcome: 'deny', ipRanges: ['10.0.0.0/33'] }),
      ),
    ).rejects.toThrow(/ipRanges/);
  });

  it('refuses a security-key rule in a tenant that cannot use security keys', async () => {
    // The relying party comes from Tenant.primaryDomain, so without one there
    // is no way to register a key. Saving the rule anyway would leave every
    // matched user at an enrolment screen whose only button returns a 409.
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, {
          name: 'Keys only',
          outcome: 'require_factor',
          factorType: 'webauthn',
        }),
      ),
    ).rejects.toThrow(/primary domain/);
  });

  it('allows it once the tenant has a primary domain', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { primaryDomain: 'acme.syntra.test' },
    });
    const rule = await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Keys only', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    expect(rule.factorType).toBe('webauthn');
  });

  it('stores the ranges a real tenant actually writes', async () => {
    // The case whose absence let a validator that rejected 192.168.0.0/16 ship
    // in the first draft: every test asserted a *rejection*, so nothing noticed
    // that acceptance was broken too.
    const ranges = [
      '10.0.0.0/8',
      '192.168.0.0/16',
      '172.16.0.0/12',
      '198.51.100.0/24',
      '8.8.8.8',
      '2001:db8::/32',
    ];
    const rule = await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Office network', outcome: 'allow', ipRanges: ranges }),
    );
    expect(rule.ipRanges).toEqual(ranges);
  });

  it('refuses a day outside 0..6', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'Bad day', outcome: 'deny', daysOfWeek: [7] }),
      ),
    ).rejects.toThrow(/daysOfWeek/);
  });

  it('refuses a minute outside 0..1439', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        addRule(tx, { name: 'Bad minute', outcome: 'deny', startMinute: 0, endMinute: 1440 }),
      ),
    ).rejects.toThrow(/Minute/);
  });
});

describe('loadPolicy with rules', () => {
  it('returns rules in position order, narrowed to the engine types', async () => {
    await withTenant(tenantId, async (tx) => {
      await addRule(tx, {
        name: 'Finance needs a key',
        outcome: 'require_factor',
        factorType: 'webauthn',
        contractField: 'department',
        contractValues: ['Finance'],
      });
      await addRule(tx, { name: 'Everyone else', outcome: 'allow' });
    });

    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.rules.map((r) => r.name)).toEqual([
      'Finance needs a key',
      'Everyone else',
    ]);
    expect(policy.rules[0]).toMatchObject({
      outcome: 'require_factor',
      factorType: 'webauthn',
      contractField: 'department',
      contractValues: ['Finance'],
    });
  });
});

describe('updateRule / deleteRule / reorderRules', () => {
  it('updates in place without moving the rule', async () => {
    const rule = await withTenant(tenantId, async (tx) => {
      await addRule(tx, { name: 'First', outcome: 'allow' });
      return addRule(tx, { name: 'Second', outcome: 'allow' });
    });
    const updated = await withTenant(tenantId, (tx) =>
      updateRule(tx, rule.id, { name: 'Second, revised', outcome: 'deny' }),
    );
    expect(updated).toMatchObject({ name: 'Second, revised', outcome: 'deny', position: 2 });
  });

  it('closes the gap after a delete so positions stay contiguous', async () => {
    const ids = await withTenant(tenantId, async (tx) => [
      (await addRule(tx, { name: 'A', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'B', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'C', outcome: 'allow' })).id,
    ]);
    await withTenant(tenantId, (tx) => deleteRule(tx, ids[1]!));
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.rules.map((r) => [r.name, r.position])).toEqual([
      ['A', 1],
      ['C', 2],
    ]);
  });

  it('reorders to exactly the sequence given', async () => {
    const ids = await withTenant(tenantId, async (tx) => [
      (await addRule(tx, { name: 'A', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'B', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'C', outcome: 'allow' })).id,
    ]);
    await withTenant(tenantId, (tx) => reorderRules(tx, [ids[2]!, ids[0]!, ids[1]!]));
    const policy = await withTenant(tenantId, (tx) => loadPolicy(tx));
    expect(policy.rules.map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('refuses a reorder that does not name every rule exactly once', async () => {
    const ids = await withTenant(tenantId, async (tx) => [
      (await addRule(tx, { name: 'A', outcome: 'allow' })).id,
      (await addRule(tx, { name: 'B', outcome: 'allow' })).id,
    ]);
    await expect(
      withTenant(tenantId, (tx) => reorderRules(tx, [ids[0]!])),
    ).rejects.toThrow(/every rule/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/policy/policy-service.test.ts`
Expected: FAIL — cannot resolve `./policy-service.js`.

- [ ] **Step 3: Implement policy storage**

`packages/core/src/policy/policy-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { isIpRangeUsable } from './ip-match.js';
import { isValidTimeZone } from './time-window.js';
import {
  CONTRACT_FIELDS,
  FACTOR_TYPES,
  POLICY_OUTCOMES,
  type ContractField,
  type FactorType,
  type PolicyFallback,
  type PolicyOutcome,
  type PolicyRule,
} from './types.js';

export interface LoadedPolicy {
  rules: PolicyRule[];
  fallback: PolicyFallback;
}

export interface RuleInput {
  name: string;
  enabled?: boolean | undefined;
  outcome: PolicyOutcome;
  factorType?: FactorType | null | undefined;
  applicationIds?: string[] | undefined;
  groupIds?: string[] | undefined;
  contractField?: ContractField | null | undefined;
  contractValues?: string[] | undefined;
  ipRanges?: string[] | undefined;
  daysOfWeek?: number[] | undefined;
  startMinute?: number | null | undefined;
  endMinute?: number | null | undefined;
  timezone?: string | null | undefined;
}

type RuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: string;
  factorType: string | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: string | null;
  contractValues: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
};

const asOutcome = (value: string): PolicyOutcome =>
  (POLICY_OUTCOMES as string[]).includes(value) ? (value as PolicyOutcome) : 'deny';

const asFactor = (value: string | null): FactorType | null =>
  value !== null && (FACTOR_TYPES as string[]).includes(value)
    ? (value as FactorType)
    : null;

const asContractField = (value: string | null): ContractField | null =>
  value !== null && (CONTRACT_FIELDS as string[]).includes(value)
    ? (value as ContractField)
    : null;

/**
 * A stored row narrowed to what the engine accepts. An outcome the code does
 * not recognise becomes 'deny' rather than being dropped: a rule whose meaning
 * cannot be read must not quietly stop applying.
 */
function toRule(row: RuleRow): PolicyRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    outcome: asOutcome(row.outcome),
    factorType: asFactor(row.factorType),
    applicationIds: row.applicationIds,
    groupIds: row.groupIds,
    contractField: asContractField(row.contractField),
    contractValues: row.contractValues,
    ipRanges: row.ipRanges,
    daysOfWeek: row.daysOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    timezone: row.timezone,
  };
}

/**
 * Rejects a rule that could never be honoured as written. This is where a bad
 * rule is caught; the engine's backstops exist for rows that predate the check
 * or arrive some other way, not as a substitute for it.
 */
function validate(input: RuleInput): void {
  if (input.outcome === 'require_factor' && !input.factorType) {
    throw new Error('factorType is required when the outcome is require_factor');
  }
  if (input.factorType && !(FACTOR_TYPES as string[]).includes(input.factorType)) {
    throw new Error(`unknown factorType: ${input.factorType}`);
  }
  if (input.contractField && !(CONTRACT_FIELDS as string[]).includes(input.contractField)) {
    throw new Error(`unknown contractField: ${input.contractField}`);
  }
  for (const day of input.daysOfWeek ?? []) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`daysOfWeek must hold integers 0..6, got ${day}`);
    }
  }
  for (const minute of [input.startMinute, input.endMinute]) {
    if (minute === null || minute === undefined) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) {
      throw new Error(`Minute must be an integer 0..1439, got ${minute}`);
    }
  }
  if (input.timezone && !isValidTimeZone(input.timezone)) {
    throw new Error(`timezone is not a zone this platform knows: ${input.timezone}`);
  }
  for (const range of input.ipRanges ?? []) {
    // A parse, which is what a syntax check is. Asking instead whether the
    // range happens to contain some probe address answers a different
    // question, and rejects 192.168.0.0/16, 172.16.0.0/12, 198.51.100.0/24 and
    // every literal host address — which is to say most of what a tenant
    // actually types into an office allowlist.
    if (!isIpRangeUsable(range)) {
      throw new Error(`ipRanges holds something that is not an address or CIDR: ${range}`);
    }
  }
}

/**
 * Refuses a rule that names WebAuthn in a tenant that cannot use it.
 *
 * Ruling F derives the relying party from `Tenant.primaryDomain`, so a tenant
 * without one cannot register or assert a security key. A
 * `require_factor: webauthn` rule saved in that state is a dead end nothing
 * else catches: `authorize()` offers enrolment, the user reaches the enrolment
 * screen, and the WebAuthn endpoint refuses with a 409 they can do nothing
 * about. Catching it at write time, where an administrator is standing in front
 * of the message, is the only place the fix is actionable.
 */
async function assertFactorUsable(
  tx: TenantClient,
  outcome: PolicyOutcome,
  factorType: FactorType | null | undefined,
): Promise<void> {
  if (outcome !== 'require_factor' || factorType !== 'webauthn') return;
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!tenant.primaryDomain) {
    throw new Error(
      'this tenant has no primary domain set, so security keys cannot be registered — set one before requiring them',
    );
  }
}

async function policyId(tx: TenantClient): Promise<string> {
  const tenantId = await currentTenant(tx);
  const existing = await tx.authPolicy.findFirst({ where: { tenantId } });
  if (existing) return existing.id;
  const created = await tx.authPolicy.create({ data: { tenantId } });
  return created.id;
}

export async function loadPolicy(tx: TenantClient): Promise<LoadedPolicy> {
  const policy = await tx.authPolicy.findFirst();
  if (!policy) {
    return { rules: [], fallback: { outcome: 'allow', factorType: null } };
  }

  const rows = await tx.authPolicyRule.findMany({
    where: { policyId: policy.id },
    orderBy: { position: 'asc' },
  });

  const outcome = asOutcome(policy.defaultOutcome);
  return {
    rules: rows.map(toRule),
    fallback: {
      outcome,
      factorType: outcome === 'require_factor' ? asFactor(policy.defaultFactorType) : null,
    },
  };
}

export async function setPolicyDefault(
  tx: TenantClient,
  fallback: PolicyFallback,
): Promise<void> {
  if (fallback.outcome === 'require_factor' && !fallback.factorType) {
    throw new Error('factorType is required when the default outcome is require_factor');
  }
  await assertFactorUsable(tx, fallback.outcome, fallback.factorType);
  const id = await policyId(tx);
  await tx.authPolicy.update({
    where: { id },
    data: {
      defaultOutcome: fallback.outcome,
      defaultFactorType: fallback.factorType,
    },
  });
}

const data = (input: RuleInput) => ({
  name: input.name,
  enabled: input.enabled ?? true,
  outcome: input.outcome,
  factorType: input.factorType ?? null,
  applicationIds: input.applicationIds ?? [],
  groupIds: input.groupIds ?? [],
  contractField: input.contractField ?? null,
  contractValues: input.contractValues ?? [],
  ipRanges: input.ipRanges ?? [],
  daysOfWeek: input.daysOfWeek ?? [],
  startMinute: input.startMinute ?? null,
  endMinute: input.endMinute ?? null,
  timezone: input.timezone ?? null,
});

export async function addRule(tx: TenantClient, input: RuleInput): Promise<PolicyRule> {
  validate(input);
  await assertFactorUsable(tx, input.outcome, input.factorType);
  const tenantId = await currentTenant(tx);
  const id = await policyId(tx);

  const last = await tx.authPolicyRule.findFirst({
    where: { policyId: id },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  const row = await tx.authPolicyRule.create({
    data: { tenantId, policyId: id, position: (last?.position ?? 0) + 1, ...data(input) },
  });
  return toRule(row);
}

export async function updateRule(
  tx: TenantClient,
  ruleId: string,
  input: RuleInput,
): Promise<PolicyRule> {
  validate(input);
  await assertFactorUsable(tx, input.outcome, input.factorType);
  const row = await tx.authPolicyRule.update({ where: { id: ruleId }, data: data(input) });
  return toRule(row);
}

/**
 * Removes a rule and closes the gap, so positions stay 1..n. A gap would not
 * change evaluation order, but it makes "rule 4" in an audit event mean
 * something different from "the fourth rule on the screen".
 */
export async function deleteRule(tx: TenantClient, ruleId: string): Promise<void> {
  const row = await tx.authPolicyRule.findUnique({ where: { id: ruleId } });
  if (!row) return;

  await tx.authPolicyRule.delete({ where: { id: ruleId } });
  const rest = await tx.authPolicyRule.findMany({
    where: { policyId: row.policyId },
    orderBy: { position: 'asc' },
  });
  // Park them out of the way first: (policyId, position) is unique, so
  // renumbering in place collides with the rows not yet moved.
  await renumber(tx, rest.map((r) => r.id));
}

export async function reorderRules(tx: TenantClient, ruleIds: string[]): Promise<void> {
  const policy = await tx.authPolicy.findFirst();
  if (!policy) return;

  const existing = await tx.authPolicyRule.findMany({
    where: { policyId: policy.id },
    select: { id: true },
  });
  const wanted = new Set(ruleIds);
  if (wanted.size !== ruleIds.length || wanted.size !== existing.length) {
    throw new Error('reorderRules must name every rule in the policy exactly once');
  }
  for (const row of existing) {
    if (!wanted.has(row.id)) {
      throw new Error('reorderRules must name every rule in the policy exactly once');
    }
  }

  await renumber(tx, ruleIds);
}

async function renumber(tx: TenantClient, orderedIds: string[]): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await tx.authPolicyRule.update({
      where: { id },
      data: { position: -(index + 1) },
    });
  }
  for (const [index, id] of orderedIds.entries()) {
    await tx.authPolicyRule.update({
      where: { id },
      data: { position: index + 1 },
    });
  }
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/policy/policy-service.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Write the failing context test**

`packages/core/src/policy/context.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { createUser } from '../directory/user-service.js';
import { createContract } from '../identity/contract-service.js';
import { createPerson, linkUserToPerson } from '../identity/person-service.js';
import { buildAuthContext } from './context.js';

let tenantId: string;
let userId: string;

const NOW = new Date('2026-08-12T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const build = (over: { applicationId?: string | null; sourceIp?: string | null } = {}) =>
  withTenant(tenantId, (tx) =>
    buildAuthContext(tx, {
      userId,
      applicationId: over.applicationId ?? null,
      sourceIp: over.sourceIp ?? '10.1.2.3',
      now: NOW,
    }),
  );

describe('buildAuthContext', () => {
  it('carries the request facts through unchanged', async () => {
    const context = await build({ applicationId: null, sourceIp: '10.1.2.3' });
    expect(context).toMatchObject({
      userId,
      applicationId: null,
      sourceIp: '10.1.2.3',
      now: NOW,
    });
  });

  it('lists the groups the user belongs to', async () => {
    const groupId = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Finance');
      await addMember(tx, g.id, userId);
      return g.id;
    });
    const context = await build();
    expect(context.groupIds).toEqual([groupId]);
  });

  it('gives a user with no person an empty contract list', async () => {
    const context = await build();
    expect(context.contracts).toEqual([]);
  });

  it('carries every contract in force right now', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        isPrimary: true,
        startDate: day('2026-01-01'),
        department: 'Care',
        jobTitle: 'Nurse',
      });
      await createContract(tx, person.id, {
        sequence: 2,
        startDate: day('2026-06-01'),
        department: 'Finance',
        jobTitle: 'Controller',
      });
    });

    const context = await build();
    expect(context.contracts).toHaveLength(2);
    expect(context.contracts.map((c) => c.department).sort()).toEqual(['Care', 'Finance']);
  });

  it('leaves out a contract that has already ended', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2025-01-01'),
        endDate: day('2026-01-31'),
        department: 'Finance',
      });
      await createContract(tx, person.id, {
        sequence: 2,
        startDate: day('2026-02-01'),
        department: 'Care',
      });
    });

    const context = await build();
    expect(context.contracts.map((c) => c.department)).toEqual(['Care']);
  });

  it('gives an empty list when every contract has ended', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2025-01-01'),
        endDate: day('2026-01-31'),
        department: 'Finance',
      });
    });

    const context = await build();
    expect(context.contracts).toEqual([]);
  });

  it('leaves out a contract that has not started yet', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2026-12-01'),
        department: 'Finance',
      });
    });

    const context = await build();
    expect(context.contracts).toEqual([]);
  });

  it('carries only the four fields a rule may read', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2026-01-01'),
        department: 'Care',
        jobTitle: 'Nurse',
        employer: 'Acme Care',
        location: 'Utrecht',
        costCentre: 'CC-9',
      });
    });

    const context = await build();
    expect(Object.keys(context.contracts[0]!).sort()).toEqual([
      'department',
      'employer',
      'jobTitle',
      'location',
    ]);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/policy/context.test.ts`
Expected: FAIL — cannot resolve `./context.js`.

- [ ] **Step 7: Implement the context builder**

`packages/core/src/policy/context.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { listGroupsForUser } from '../directory/group-service.js';
import { activeContracts } from '../identity/contract-service.js';
import type { AuthContext, ContractFacts } from './types.js';

export interface AuthContextInput {
  userId: string;
  applicationId: string | null;
  sourceIp: string | null;
  now: Date;
}

/**
 * Assembles everything the policy engine is allowed to see, and nothing else.
 *
 * The contract list holds every contract in force at `now`, because a contract
 * condition matches if ANY active contract satisfies it. A user with no linked
 * person, or a person whose contracts have all ended, gets an empty list —
 * both are ordinary, and neither is an error.
 *
 * Only the four fields a rule may match on are copied across. Handing the
 * engine a whole Contract row would let a future rule reach for the cost
 * centre or the manager without anyone deciding that it should.
 */
export async function buildAuthContext(
  tx: TenantClient,
  input: AuthContextInput,
): Promise<AuthContext> {
  const groups = await listGroupsForUser(tx, input.userId);

  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { personId: true },
  });

  let contracts: ContractFacts[] = [];
  if (user?.personId) {
    const rows = await activeContracts(tx, user.personId, input.now);
    contracts = rows.map((row) => ({
      department: row.department,
      jobTitle: row.jobTitle,
      employer: row.employer,
      location: row.location,
    }));
  }

  return {
    userId: input.userId,
    applicationId: input.applicationId,
    groupIds: groups.map((g) => g.id),
    contracts,
    sourceIp: input.sourceIp,
    now: input.now,
  };
}
```

`listGroupsForUser` returns `Group` rows, so `g.id` is the group id — verified
against `packages/core/src/directory/group-service.ts`, which selects through
the membership join and returns the groups themselves.

- [ ] **Step 8: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/policy/context.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './policy/policy-service.js';
export * from './policy/context.js';
```

```bash
pnpm exec tsc -b
git add -A
git commit -m "feat: add policy storage and authentication request context"
```

---

## Task 4: `authorize()` — the single chokepoint

**Files:**
- Create: `packages/core/src/auth/mfa/relying-party.ts`
- Create: `packages/core/src/auth/mfa/types.ts`
- Create: `packages/core/src/auth/mfa/registry.ts`
- Create: `packages/core/src/auth/attempt-service.ts`
- Create: `packages/core/src/auth/authorize.ts`
- Modify: `packages/core/src/auth/login-service.ts` — stop exporting `authenticate` from the package
- Modify: `packages/core/src/auth/session-service.ts` — carry `satisfiedFactor`
- Modify: `packages/core/src/index.ts`
- Create: `apps/api/src/routes/relying-party.ts`
- Modify: `apps/api/src/routes/auth.ts` — `/login` and `/elevate` go through `authorize()`
- Test: `packages/core/src/auth/authorize.test.ts`
- Test: `apps/api/src/routes/auth.test.ts` — extend

**Interfaces:**
- Consumes: from Task 2 — `PolicyDecision`, `PolicyOutcome`, `FactorType`. From Task 3 — `loadPolicy`, `buildAuthContext`. From Task 1 — `AuthAttempt.scope`, `Session.satisfiedFactor`. From the existing codebase — `authenticate` (now internal), `recordEvent`, `isAdministrator`, `withTenant`, `SessionScope`, `createSession`, `resolveSession`, `ProblemError`.
- Produces:
  - `interface RelyingParty { id: string; origin: string }` and `interface RelyingPartyIdentity extends RelyingParty { name: string }`
  - `type FactorPresentation = { type: 'totp'; code: string } | { type: 'webauthn'; assertion: unknown } | { type: 'recovery_code'; code: string }`
  - `type FactorPresentationType = FactorPresentation['type']`
  - `type FactorVerifyResult = { ok: true } | { ok: false; reason: string }`
  - `interface FactorVerifyContext { now: Date; relyingParty: RelyingParty }`
  - `function tenantRelyingParty(tenant: { primaryDomain: string | null }, publicUrl: string): RelyingParty`
  - `function assertWebAuthnUsable(request: FastifyRequest, tenant: { primaryDomain: string | null }, rp: RelyingParty): void`
  - `createSession(tx, userId, scope, satisfiedFactor?)` and `ResolvedSession.satisfiedFactor`
  - `interface FactorVerifier { type: FactorPresentationType; enrollable: boolean; enrolled(tx: TenantClient, userId: string): Promise<boolean>; verify(tenantId: string, userId: string, presentation: FactorPresentation, context: FactorVerifyContext): Promise<FactorVerifyResult> }`
  - `function registerFactorVerifier(verifier: FactorVerifier): void`
  - `function resetFactorVerifiers(): void`
  - `function enrolledFactorTypes(tx: TenantClient, userId: string): Promise<FactorType[]>`
  - `function enrollableFactorTypes(): FactorType[]`
  - `function hasRecoveryCodes(tx: TenantClient, userId: string): Promise<boolean>`
  - `function verifyFactor(tenantId: string, userId: string, presentation: FactorPresentation, context: FactorVerifyContext): Promise<FactorVerifyResult>`
  - `type AttemptPurpose = 'verify' | 'enrol'`
  - `type Principal = { kind: 'password'; login: string; password: string } | { kind: 'session'; userId: string; sessionId: string; satisfiedFactor: FactorPresentationType | null } | { kind: 'external'; userId: string; issuer: string }`
  - `type AuthorizeRequest = { kind: 'primary'; principal: Principal; applicationId: string | null; sourceIp: string | null; relyingParty: RelyingParty; scope: SessionScope; floor?: PolicyOutcome | undefined; now?: Date | undefined } | { kind: 'continue'; attemptToken: string; factor: FactorPresentation; sourceIp: string | null; relyingParty: RelyingParty; now?: Date | undefined } | { kind: 'enrolled'; attemptToken: string; enrolledFactor: FactorType; sourceIp: string | null; relyingParty: RelyingParty; now?: Date | undefined }`
  - `type DenyReason = 'invalid_credentials' | 'user_inactive' | 'policy_denied' | 'factor_not_enrolled' | 'factor_invalid' | 'factor_used_for_enrolment' | 'attempt_invalid'`
  - `type AuthorizeResult = { status: 'allow'; userId: string; mayElevate: boolean; applicationId: string | null; scope: SessionScope; satisfiedFactor: FactorPresentationType | null } | { status: 'challenge'; attemptToken: string; expiresAt: Date; acceptableFactors: FactorPresentationType[]; enrolledFactors: FactorType[] } | { status: 'enrol'; attemptToken: string; expiresAt: Date; enrollableFactors: FactorType[] } | { status: 'deny'; reason: DenyReason }`
  - `function authorize(tenantId: string, request: AuthorizeRequest): Promise<AuthorizeResult>`
  - `function issueAttempt(tx: TenantClient, input: IssueAttemptInput): Promise<{ token: string; expiresAt: Date }>`, `findAttempt(tx, token, now): Promise<ResolvedAttempt | null>`, `consumeAttempt(tx, attemptId, now): Promise<boolean>` — where `ResolvedAttempt` carries `{ id; userId; applicationId; purpose: AttemptPurpose; scope: SessionScope; requiredOutcome; requiredFactor; ruleId }`

- [ ] **Step 1: Write the relying party and the factor plug-in types**

`packages/core/src/auth/mfa/relying-party.ts`:

```ts
/**
 * The WebAuthn relying party for one request: the host a credential is bound
 * to, and the exact origin the browser will report.
 *
 * Both are per request, because Syntra picks a tenant from the Host header and
 * a credential enrolled at one tenant's hostname must not assert at another's.
 * They travel as an explicit field on AuthorizeRequest rather than in an
 * ambient store: sourceIp is just as request-derived and is already a field,
 * and making this one implicit would mean a background job could compile and
 * then fail at run time inside the one chokepoint every authentication path
 * funnels through.
 */
export interface RelyingParty {
  /** The RP ID: the registrable host, no scheme and no port. */
  id: string;
  /** The exact origin, scheme and port included. */
  origin: string;
}

/** Registration also needs a human-readable name; verification does not. */
export interface RelyingPartyIdentity extends RelyingParty {
  name: string;
}
```

`packages/core/src/auth/mfa/types.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import type { RelyingParty } from './relying-party.js';

export type FactorPresentation =
  | { type: 'totp'; code: string }
  | { type: 'webauthn'; assertion: unknown }
  | { type: 'recovery_code'; code: string };

export type FactorPresentationType = FactorPresentation['type'];

export type FactorVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Everything a verifier may know about the request beyond the presentation
 * itself. One object rather than a growing tail of positional arguments, and
 * every field is supplied by the caller — a verifier reads no clock and no
 * ambient state of its own, which is what makes it testable.
 */
export interface FactorVerifyContext {
  now: Date;
  relyingParty: RelyingParty;
}

/**
 * One second factor.
 *
 * `verify` takes a tenantId, not a transaction, and opens whatever it needs
 * internally. WebAuthn verification is signature checking and may consult
 * external metadata; running it inside the caller's interactive transaction
 * would put network and CPU work under Prisma's 5000 ms transaction timeout,
 * which is how a slow authenticator becomes a failed login and an aborted
 * transaction.
 *
 * `enrollable` says whether a user may add this factor themselves during a
 * forced-enrolment challenge. Recovery codes are not enrollable: they are a
 * fallback you generate once you already hold a real factor, and offering them
 * as the way to satisfy a require_mfa rule would make the rule meaningless.
 */
export interface FactorVerifier {
  type: FactorPresentationType;
  enrollable: boolean;
  enrolled(tx: TenantClient, userId: string): Promise<boolean>;
  verify(
    tenantId: string,
    userId: string,
    presentation: FactorPresentation,
    context: FactorVerifyContext,
  ): Promise<FactorVerifyResult>;
}
```

- [ ] **Step 2: Write the registry**

`packages/core/src/auth/mfa/registry.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import type { FactorType } from '../../policy/types.js';
import type {
  FactorPresentation,
  FactorPresentationType,
  FactorVerifier,
  FactorVerifyContext,
  FactorVerifyResult,
} from './types.js';

const VERIFIERS = new Map<FactorPresentationType, FactorVerifier>();

/**
 * Adding a factor means adding an entry here, never editing authorize().
 * The chokepoint asks this registry what exists, what is enrolled and what
 * verifies; it does not know that TOTP and WebAuthn are the two that happen to
 * be registered.
 */
export function registerFactorVerifier(verifier: FactorVerifier): void {
  VERIFIERS.set(verifier.type, verifier);
}

export function factorVerifier(
  type: FactorPresentationType,
): FactorVerifier | undefined {
  return VERIFIERS.get(type);
}

/**
 * The policy-visible factor types the user has actually enrolled.
 *
 * Recovery codes are deliberately not a policy factor: a rule may require
 * WebAuthn, and a recovery code must not satisfy it. They are accepted as a
 * fallback for `require_mfa` only, which is decided in authorize().
 */
export async function enrolledFactorTypes(
  tx: TenantClient,
  userId: string,
): Promise<FactorType[]> {
  const found: FactorType[] = [];
  for (const type of ['totp', 'webauthn'] as const) {
    const verifier = VERIFIERS.get(type);
    if (verifier && (await verifier.enrolled(tx, userId))) found.push(type);
  }
  return found;
}

/**
 * The factor types a user could enrol right now, which is a property of the
 * process rather than of the user: a type with no verifier registered is not
 * something this deployment can offer, and offering it would produce a
 * challenge nobody can answer.
 */
export function enrollableFactorTypes(): FactorType[] {
  return (['totp', 'webauthn'] as const).filter((type) => {
    const verifier = VERIFIERS.get(type);
    return Boolean(verifier?.enrollable);
  });
}

export async function hasRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  const verifier = VERIFIERS.get('recovery_code');
  return verifier ? verifier.enrolled(tx, userId) : false;
}

export async function verifyFactor(
  tenantId: string,
  userId: string,
  presentation: FactorPresentation,
  context: FactorVerifyContext,
): Promise<FactorVerifyResult> {
  const verifier = VERIFIERS.get(presentation.type);
  if (!verifier) return { ok: false, reason: 'factor_not_available' };
  return verifier.verify(tenantId, userId, presentation, context);
}

/**
 * Test support only. The registry is module state and the whole suite runs in
 * one fork, so a suite that installs WebAuthn would otherwise change what a
 * later suite's `enrollableFactorTypes()` reports — and a test that passes
 * only because of what ran before it is worse than no test.
 */
export function resetFactorVerifiers(): void {
  VERIFIERS.clear();
}
```

- [ ] **Step 3: Write the attempt service**

`packages/core/src/auth/attempt-service.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { SessionScope } from './session-service.js';

/** A step-up attempt is short-lived on purpose: it is a half-open door. */
export const ATTEMPT_LIFETIME_MS = 5 * 60 * 1000;

/**
 * 'verify' — present a factor you already hold.
 * 'enrol'  — enrol a factor of the required kind, because you hold none.
 */
export type AttemptPurpose = 'verify' | 'enrol';

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface IssueAttemptInput {
  userId: string;
  applicationId: string | null;
  sourceIp: string | null;
  purpose: AttemptPurpose;
  /**
   * The scope of the session to issue once this attempt is satisfied.
   *
   * Recorded here because the issuer is the only party that knows: signing in
   * means 'portal', elevating means 'admin', and launching an application
   * means 'portal' even though the caller already holds a session. Working it
   * out at the far end from whether a cookie was present hands an
   * administrative session to any portal user who completes a step-up, because
   * the browser sends its cookie on every request.
   */
  scope: SessionScope;
  requiredOutcome: 'require_mfa' | 'require_factor';
  requiredFactor: string | null;
  ruleId: string | null;
  now: Date;
}

export interface ResolvedAttempt {
  id: string;
  userId: string;
  applicationId: string | null;
  purpose: AttemptPurpose;
  scope: SessionScope;
  requiredOutcome: 'require_mfa' | 'require_factor';
  requiredFactor: string | null;
  ruleId: string | null;
}

/**
 * The attempt token is a bearer credential for the second half of a sign-in,
 * so only its digest is stored — same reasoning as Session.
 *
 * The caller must record the audit event explaining the attempt in the same
 * transaction as this call. An attempt with no record of why it exists is a
 * half-open door nobody can account for.
 */
export async function issueAttempt(
  tx: TenantClient,
  input: IssueAttemptInput,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(input.now.getTime() + ATTEMPT_LIFETIME_MS);

  await tx.authAttempt.create({
    data: {
      tenantId,
      userId: input.userId,
      tokenHash: hashToken(token),
      applicationId: input.applicationId,
      sourceIp: input.sourceIp,
      purpose: input.purpose,
      scope: input.scope,
      requiredOutcome: input.requiredOutcome,
      requiredFactor: input.requiredFactor,
      ruleId: input.ruleId,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/** Reads a live attempt without consuming it. Null for anything unusable. */
export async function findAttempt(
  tx: TenantClient,
  token: string,
  now: Date,
): Promise<ResolvedAttempt | null> {
  const row = await tx.authAttempt.findFirst({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    applicationId: row.applicationId,
    purpose: row.purpose as AttemptPurpose,
    scope: row.scope as SessionScope,
    requiredOutcome: row.requiredOutcome as 'require_mfa' | 'require_factor',
    requiredFactor: row.requiredFactor,
    ruleId: row.ruleId,
  };
}

/**
 * Marks the attempt used. Conditional on it still being unused, and the caller
 * must check the count: two requests presenting the same attempt token
 * concurrently must not both proceed.
 */
export async function consumeAttempt(
  tx: TenantClient,
  attemptId: string,
  now: Date,
): Promise<boolean> {
  const result = await tx.authAttempt.updateMany({
    where: { id: attemptId, consumedAt: null },
    data: { consumedAt: now },
  });
  return result.count === 1;
}
```

- [ ] **Step 4: Write the failing chokepoint test**

`packages/core/src/auth/authorize.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { addRule, setPolicyDefault } from '../policy/policy-service.js';
import { setPassword } from './password.js';
import { resetFactorVerifiers } from './mfa/registry.js';
import { authorize } from './authorize.js';

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';
const NOW = new Date('2026-08-12T09:00:00Z');

/**
 * The relying party is a required field on every request. It is only read when
 * a WebAuthn assertion is verified, but it is not optional: an ambient store
 * would let a caller forget it and find out at run time, inside the one
 * chokepoint every authentication path funnels through.
 */
const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

beforeEach(async () => {
  // The registry is process-wide and the whole suite runs in one fork. Each
  // describe below installs exactly the verifiers it means to exercise, so
  // "the user has no factor" means that and not "some other file installed
  // one".
  resetFactorVerifiers();

  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });
});

const signIn = (password = PASSWORD, sourceIp: string | null = '10.1.2.3') =>
  authorize(tenantId, {
    kind: 'primary',
    principal: { kind: 'password', login: 'jdoe', password },
    applicationId: null,
    sourceIp,
    relyingParty: RP,
    scope: 'portal',
    now: NOW,
  });

const auditActions = () =>
  withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } }),
  );

describe('authorize — primary authentication', () => {
  it('allows a correct password when no policy is configured', async () => {
    const result = await signIn();
    expect(result).toEqual({
      status: 'allow',
      userId,
      mayElevate: false,
      applicationId: null,
      scope: 'portal',
      satisfiedFactor: null,
    });
  });

  it('denies a wrong password', async () => {
    expect(await signIn('wrong')).toEqual({
      status: 'deny',
      reason: 'invalid_credentials',
    });
  });

  it('reports an unknown login exactly as it reports a wrong password', async () => {
    const unknown = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'nobody', password: 'wrong' },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(unknown).toEqual({ status: 'deny', reason: 'invalid_credentials' });
  });

  it('denies an inactive user', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    expect(await signIn()).toEqual({ status: 'deny', reason: 'user_inactive' });
  });

  it('accepts an already-established principal without a password', async () => {
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'external', userId, issuer: 'entra:acme' },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'allow', userId });
  });

  it('still refuses an inactive user on an established principal', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'external', userId, issuer: 'entra:acme' },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'user_inactive' });
  });
});

describe('authorize — policy', () => {
  it('denies when a rule says deny, and records the rule in the audit log', async () => {
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Blocked outright', outcome: 'deny' }),
    );

    expect(await signIn()).toEqual({ status: 'deny', reason: 'policy_denied' });

    const events = await auditActions();
    const denial = events.find((e) => e.action === 'auth.policy_denied');
    expect(denial).toBeDefined();
    expect(denial!.outcome).toBe('failure');
    expect(denial!.payload).toMatchObject({ ruleName: 'Blocked outright' });
  });

  it('denies when the tenant default is deny and nothing matches', async () => {
    await withTenant(tenantId, (tx) =>
      setPolicyDefault(tx, { outcome: 'deny', factorType: null }),
    );
    expect(await signIn()).toEqual({ status: 'deny', reason: 'policy_denied' });
  });

  it('denies before evaluating policy when the password is wrong', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'Allow', outcome: 'allow' }));
    expect(await signIn('wrong')).toEqual({
      status: 'deny',
      reason: 'invalid_credentials',
    });
  });

  it('matches a rule on group membership', async () => {
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Finance');
      await addMember(tx, g.id, userId);
      await addRule(tx, { name: 'Finance blocked', outcome: 'deny', groupIds: [g.id] });
    });
    expect(await signIn()).toEqual({ status: 'deny', reason: 'policy_denied' });
  });

  it('matches a rule on source address', async () => {
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Offsite blocked', outcome: 'deny', ipRanges: ['203.0.113.0/24'] }),
    );
    expect(await signIn(PASSWORD, '203.0.113.9')).toEqual({
      status: 'deny',
      reason: 'policy_denied',
    });
    expect(await signIn(PASSWORD, '10.1.2.3')).toMatchObject({ status: 'allow' });
  });

  it('denies with factor_not_enrolled when nothing is enrollable in this process', async () => {
    // No verifier is registered in this test file, so enrollableFactorTypes()
    // is empty and there is genuinely nothing to offer. Task 5 registers TOTP
    // and asserts that the same rule produces an enrolment challenge instead.
    // That is the normal path; this is the degenerate one.
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Everyone needs MFA', outcome: 'require_mfa' }),
    );

    expect(await signIn()).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });

    const events = await auditActions();
    expect(events.some((e) => e.action === 'auth.mfa_unavailable')).toBe(true);
  });

  it('applies a caller-supplied floor on top of the policy outcome', async () => {
    // The policy says allow; the caller (elevation) demands MFA anyway.
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      floor: 'require_mfa',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('never lets a floor weaken a policy denial', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'Deny', outcome: 'deny' }));
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      floor: 'allow',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'policy_denied' });
  });
});

describe('authorize — continue and enrolled', () => {
  it('denies a continue against an attempt token that was never issued', async () => {
    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: 'nonsense',
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('denies an enrolled claim against an attempt token that was never issued', async () => {
    const result = await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: 'nonsense',
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });
});

describe('authorize — audit', () => {
  it('writes exactly one success event for a clean sign-in', async () => {
    await signIn();
    const events = await auditActions();
    expect(events.filter((e) => e.action === 'auth.login')).toHaveLength(1);
    expect(events[events.length - 1]!.outcome).toBe('success');
  });

  it('never records the password', async () => {
    await signIn('wrong');
    const events = await auditActions();
    expect(JSON.stringify(events)).not.toContain('wrong');
  });
});
```

- [ ] **Step 5: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/auth/authorize.test.ts`
Expected: FAIL — cannot resolve `./authorize.js`.

- [ ] **Step 6: Implement the chokepoint**

`packages/core/src/auth/authorize.ts`:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { buildAuthContext } from '../policy/context.js';
import { evaluatePolicy } from '../policy/evaluate.js';
import { loadPolicy } from '../policy/policy-service.js';
import type { FactorType, PolicyDecision, PolicyOutcome } from '../policy/types.js';
import { isAdministrator } from '../rbac/rbac-service.js';
import {
  consumeAttempt,
  findAttempt,
  issueAttempt,
  type ResolvedAttempt,
} from './attempt-service.js';
import { authenticate } from './login-service.js';
import type { SessionScope } from './session-service.js';
import {
  enrolledFactorTypes,
  enrollableFactorTypes,
  hasRecoveryCodes,
  verifyFactor,
} from './mfa/registry.js';
import type { RelyingParty } from './mfa/relying-party.js';
import type { FactorPresentation, FactorPresentationType } from './mfa/types.js';

export type Principal =
  | { kind: 'password'; login: string; password: string }
  /**
   * An existing Syntra session re-entering — used when launching an app.
   *
   * `satisfiedFactor` is what that session was established with, read off the
   * Session row. Without it every launch of an application covered by a
   * `require_mfa` rule re-issues the same challenge the user just answered,
   * and the application becomes permanently unreachable.
   */
  | {
      kind: 'session';
      userId: string;
      sessionId: string;
      satisfiedFactor: FactorPresentationType | null;
    }
  /**
   * Primary authentication happened somewhere else. Access II's upstream
   * federation adapter constructs this after the upstream provider has
   * asserted the identity; `issuer` goes into the audit event so a decision
   * can be traced back to who vouched for it.
   */
  | { kind: 'external'; userId: string; issuer: string };

export type AuthorizeRequest =
  | {
      kind: 'primary';
      principal: Principal;
      applicationId: string | null;
      sourceIp: string | null;
      relyingParty: RelyingParty;
      /**
       * What kind of session to issue if this succeeds, and what to record on
       * any attempt this has to open along the way. The caller knows; nothing
       * downstream can work it out from ambient state without getting it
       * wrong.
       */
      scope: SessionScope;
      /**
       * A minimum the caller imposes regardless of policy. Elevation to an
       * administrative session uses it. It can only strengthen the outcome —
       * a floor never turns a deny into an allow.
       */
      floor?: PolicyOutcome | undefined;
      now?: Date | undefined;
    }
  | {
      kind: 'continue';
      attemptToken: string;
      factor: FactorPresentation;
      sourceIp: string | null;
      relyingParty: RelyingParty;
      now?: Date | undefined;
    }
  | {
      /**
       * The user has just enrolled a factor under a forced-enrolment attempt.
       * The claim is not trusted: this re-reads what they actually hold before
       * treating the requirement as satisfied.
       */
      kind: 'enrolled';
      attemptToken: string;
      enrolledFactor: FactorType;
      sourceIp: string | null;
      relyingParty: RelyingParty;
      now?: Date | undefined;
    };

export type DenyReason =
  | 'invalid_credentials'
  | 'user_inactive'
  | 'policy_denied'
  | 'factor_not_enrolled'
  | 'factor_invalid'
  /**
   * The code was arithmetically correct but belongs to the counter step that
   * completed enrolment, and the replay watermark refuses it. Distinct from
   * `factor_invalid` because the caller must be able to say so: an unexplained
   * rejection of a code the user can see on their screen is a support ticket,
   * and an explained one is a sentence.
   */
  | 'factor_used_for_enrolment'
  | 'attempt_invalid';

export type AuthorizeResult =
  | {
      status: 'allow';
      userId: string;
      mayElevate: boolean;
      applicationId: string | null;
      /** Carried from the request, or from the attempt on a step-up. */
      scope: SessionScope;
      satisfiedFactor: FactorPresentationType | null;
    }
  | {
      /** Present a factor you already hold. */
      status: 'challenge';
      attemptToken: string;
      expiresAt: Date;
      /**
       * Includes 'recovery_code' when one would be accepted. It is a
       * `FactorPresentationType[]` rather than `FactorType[]` for exactly that
       * reason: a user whose only remaining factor is a printed code would
       * otherwise be handed an empty list, and the screen would open a
       * WebAuthn prompt for a key they do not have.
       */
      acceptableFactors: FactorPresentationType[];
      enrolledFactors: FactorType[];
    }
  | {
      /** Enrol a factor of the required kind. No session until you do. */
      status: 'enrol';
      attemptToken: string;
      expiresAt: Date;
      enrollableFactors: FactorType[];
    }
  | { status: 'deny'; reason: DenyReason };

const STRENGTH: Record<PolicyOutcome, number> = {
  allow: 0,
  require_mfa: 1,
  require_factor: 2,
  deny: 3,
};

/** A floor may only strengthen. Ordering the outcomes is what makes that true. */
function applyFloor(
  decision: PolicyDecision,
  floor: PolicyOutcome | undefined,
): PolicyDecision {
  if (!floor) return decision;
  if (STRENGTH[floor] <= STRENGTH[decision.outcome]) return decision;
  return { outcome: floor, factorType: null, ruleId: null, ruleName: null };
}

/**
 * Whether a factor that has already been presented or enrolled during this
 * flow satisfies what the policy is asking for.
 *
 * A recovery code satisfies "any second factor" and never a named one: a rule
 * that asks for WebAuthn is asking for the hardware, and a printed code is not
 * it.
 */
function satisfiesRequirement(
  decision: PolicyDecision,
  satisfied: FactorPresentationType | null,
): boolean {
  if (!satisfied) return false;
  if (decision.outcome === 'require_mfa') return true;
  if (decision.outcome === 'require_factor') return satisfied === decision.factorType;
  return false;
}

async function audit(
  tx: TenantClient,
  input: {
    userId: string | null;
    action: string;
    outcome: 'success' | 'failure';
    sourceIp: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: input.userId,
    action: input.action,
    targetType: 'User',
    targetId: input.userId,
    outcome: input.outcome,
    sourceIp: input.sourceIp,
    payload: input.payload,
  });
}

/**
 * The single authentication chokepoint.
 *
 * Every path that establishes who the caller is — local login, elevation,
 * application launch, and in Access II every protocol adapter and upstream
 * federation — comes through here. Policy evaluation, second-factor
 * requirements and the audit trail live here and nowhere else. A caller that
 * wants a session asks this function first; there is no second way to get an
 * allow, which is what stops a policy bypass hiding inside one adapter's code
 * path.
 *
 * It takes a tenantId rather than a caller's transaction, and opens one
 * transaction per phase. Factor verification is signature and hash work that
 * may reach outside the process, and Prisma's interactive transactions time
 * out at 5000 ms; running it inside the caller's transaction would make a slow
 * authenticator into an aborted transaction rather than a failed login.
 *
 * Everything request-derived that a decision depends on — the source address,
 * the relying party — is a field on the request rather than ambient state, so
 * a caller that cannot supply it fails to compile.
 */
export async function authorize(
  tenantId: string,
  request: AuthorizeRequest,
): Promise<AuthorizeResult> {
  const now = request.now ?? new Date();
  if (request.kind === 'primary') return primary(tenantId, request, now);
  if (request.kind === 'continue') return continueAttempt(tenantId, request, now);
  return completeEnrolment(tenantId, request, now);
}

async function primary(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'primary' }>,
  now: Date,
): Promise<AuthorizeResult> {
  // Phase 1 — establish the principal. authenticate() audits its own outcome.
  const identified = await withTenant(tenantId, async (tx) => {
    if (request.principal.kind === 'password') {
      const result = await authenticate(tx, {
        login: request.principal.login,
        password: request.principal.password,
        sourceIp: request.sourceIp,
      });
      return result.ok
        ? { ok: true as const, userId: result.userId }
        : {
            ok: false as const,
            reason:
              result.reason === 'user_inactive'
                ? ('user_inactive' as const)
                : ('invalid_credentials' as const),
          };
    }

    const userId = request.principal.userId;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      await audit(tx, {
        userId: null,
        action: 'auth.login',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: { reason: 'invalid_credentials', principal: request.principal.kind },
      });
      return { ok: false as const, reason: 'invalid_credentials' as const };
    }
    if (user.status !== 'active') {
      await audit(tx, {
        userId,
        action: 'auth.login',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: { reason: 'user_inactive', principal: request.principal.kind },
      });
      return { ok: false as const, reason: 'user_inactive' as const };
    }
    await audit(tx, {
      userId,
      action: 'auth.login',
      outcome: 'success',
      sourceIp: request.sourceIp,
      payload:
        request.principal.kind === 'external'
          ? { principal: 'external', issuer: request.principal.issuer }
          : { principal: 'session' },
    });
    return { ok: true as const, userId };
  });

  if (!identified.ok) return { status: 'deny', reason: identified.reason };

  return decide(tenantId, {
    userId: identified.userId,
    applicationId: request.applicationId,
    sourceIp: request.sourceIp,
    scope: request.scope,
    floor: request.floor,
    // A session principal brings whatever factor established it. Launching an
    // application is a fresh decision, but it is not a fresh sign-in, and the
    // factor the user already presented still counts.
    satisfied:
      request.principal.kind === 'session' ? request.principal.satisfiedFactor : null,
    now,
  });
}

interface DecideInput {
  userId: string;
  applicationId: string | null;
  sourceIp: string | null;
  /** What session to issue, and what to stamp on any attempt opened here. */
  scope: SessionScope;
  floor: PolicyOutcome | undefined;
  /**
   * A factor presented or enrolled during this flow, or the one that
   * established the caller's existing session.
   */
  satisfied: FactorPresentationType | null;
  now: Date;
}

async function decide(
  tenantId: string,
  input: DecideInput,
): Promise<AuthorizeResult> {
  // Phase 2 — evaluate policy and, if a factor is needed, open an attempt.
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const policy = await loadPolicy(tx);
    const context = await buildAuthContext(tx, {
      userId: input.userId,
      applicationId: input.applicationId,
      sourceIp: input.sourceIp,
      now: input.now,
    });

    const decision = applyFloor(
      evaluatePolicy(policy.rules, policy.fallback, context),
      input.floor,
    );

    if (decision.outcome === 'deny') {
      await audit(tx, {
        userId: input.userId,
        action: 'auth.policy_denied',
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: {
          reason: 'policy_denied',
          ruleId: decision.ruleId,
          ruleName: decision.ruleName ?? 'tenant default',
          applicationId: input.applicationId,
        },
      });
      return { status: 'deny', reason: 'policy_denied' } as const;
    }

    const allow = async () => {
      const mayElevate = await isAdministrator(tx, input.userId);
      return {
        status: 'allow',
        userId: input.userId,
        mayElevate,
        applicationId: input.applicationId,
        scope: input.scope,
        satisfiedFactor: input.satisfied,
      } as const;
    };

    if (decision.outcome === 'allow') return allow();

    // A factor presented or enrolled earlier in this flow settles the
    // requirement without a second round trip. Re-evaluating rather than
    // trusting the earlier decision is what makes a rule tightened mid-flow
    // still apply; this is what stops that costing an extra challenge when it
    // did not tighten.
    if (satisfiesRequirement(decision, input.satisfied)) return allow();

    const enrolled = await enrolledFactorTypes(tx, input.userId);
    const acceptable: FactorPresentationType[] =
      decision.outcome === 'require_factor' && decision.factorType
        ? enrolled.filter((type) => type === decision.factorType)
        : [...enrolled];

    // A recovery code substitutes for "any second factor", never for a named
    // one. It goes into the list the caller is shown, not just into the
    // decision to issue a challenge — a user whose codes are all that is left
    // must be offered them rather than shown an empty screen.
    const recovery =
      decision.outcome === 'require_mfa' && (await hasRecoveryCodes(tx, input.userId));
    if (recovery) acceptable.push('recovery_code');

    if (acceptable.length > 0) {
      // The attempt and the audit event that explains it commit together. An
      // attempt row with no record of why it exists is a half-open door
      // nobody can account for.
      const attempt = await issueAttempt(tx, {
        userId: input.userId,
        applicationId: input.applicationId,
        sourceIp: input.sourceIp,
        purpose: 'verify',
        scope: input.scope,
        requiredOutcome:
          decision.outcome === 'require_factor' ? 'require_factor' : 'require_mfa',
        requiredFactor: decision.factorType,
        ruleId: decision.ruleId,
        now: input.now,
      });
      await audit(tx, {
        userId: input.userId,
        action: 'auth.mfa_challenged',
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: {
          required: decision.outcome,
          requiredFactor: decision.factorType,
          ruleName: decision.ruleName ?? 'tenant default',
        },
      });
      return {
        status: 'challenge',
        attemptToken: attempt.token,
        expiresAt: attempt.expiresAt,
        acceptableFactors: acceptable,
        enrolledFactors: enrolled,
      } as const;
    }

    // The user holds nothing that satisfies the rule. Rather than refusing —
    // which would lock out everyone the first time a tenant switches MFA on,
    // with no self-service way back — offer to enrol one now.
    //
    // SECURITY TRADE, ACCEPTED DELIBERATELY: a stolen password now buys the
    // attacker the ability to enrol their own factor, because primary
    // authentication has already succeeded by the time we get here. The
    // alternative is a product no tenant can ever turn MFA on in. The same
    // stolen password previously bought a full session with no factor at all,
    // so this is not a step backwards — but it is visible after the fact,
    // which is why the enrolment writes its own audit event naming the
    // forced-enrolment challenge it happened under.
    const offerable = enrollableFactorTypes().filter((type) =>
      decision.outcome === 'require_factor' && decision.factorType
        ? type === decision.factorType
        : true,
    );

    if (tenant.selfEnrolmentEnabled && offerable.length > 0) {
      const attempt = await issueAttempt(tx, {
        userId: input.userId,
        applicationId: input.applicationId,
        sourceIp: input.sourceIp,
        purpose: 'enrol',
        scope: input.scope,
        requiredOutcome:
          decision.outcome === 'require_factor' ? 'require_factor' : 'require_mfa',
        requiredFactor: decision.factorType,
        ruleId: decision.ruleId,
        now: input.now,
      });
      await audit(tx, {
        userId: input.userId,
        action: 'auth.enrolment_required',
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: {
          required: decision.outcome,
          requiredFactor: decision.factorType,
          ruleName: decision.ruleName ?? 'tenant default',
          offered: offerable,
        },
      });
      return {
        status: 'enrol',
        attemptToken: attempt.token,
        expiresAt: attempt.expiresAt,
        enrollableFactors: offerable,
      } as const;
    }

    // Either the tenant issues factors by hand and has turned self-enrolment
    // off, or this deployment has no verifier for the required type. Both are
    // genuine dead ends, and saying so is honest.
    await audit(tx, {
      userId: input.userId,
      action: 'auth.mfa_unavailable',
      outcome: 'failure',
      sourceIp: input.sourceIp,
      payload: {
        reason: 'factor_not_enrolled',
        required: decision.outcome,
        requiredFactor: decision.factorType,
        ruleName: decision.ruleName ?? 'tenant default',
        selfEnrolmentEnabled: tenant.selfEnrolmentEnabled,
      },
    });
    return { status: 'deny', reason: 'factor_not_enrolled' } as const;
  });
}

/** Reads a live attempt of the expected purpose, or null. */
async function liveAttempt(
  tenantId: string,
  token: string,
  purpose: 'verify' | 'enrol',
  now: Date,
): Promise<ResolvedAttempt | null> {
  const attempt = await withTenant(tenantId, (tx) => findAttempt(tx, token, now));
  // An enrolment attempt cannot be spent on a verification, or a user could be
  // walked into enrolling one factor and signing in with another.
  if (!attempt || attempt.purpose !== purpose) return null;
  return attempt;
}

/** The user must still be there and still be active between the two calls. */
async function stillActive(tenantId: string, userId: string): Promise<boolean> {
  const user = await withTenant(tenantId, (tx) =>
    tx.user.findUnique({ where: { id: userId } }),
  );
  return Boolean(user && user.status === 'active');
}

async function continueAttempt(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'continue' }>,
  now: Date,
): Promise<AuthorizeResult> {
  // Phase 1 — read the attempt. Not consumed yet: a wrong code should cost the
  // user a retry, not the whole sign-in.
  const attempt = await liveAttempt(tenantId, request.attemptToken, 'verify', now);
  if (!attempt) return { status: 'deny', reason: 'attempt_invalid' };

  // A named factor cannot be satisfied by a different one, and a recovery code
  // never satisfies a named factor.
  if (
    attempt.requiredOutcome === 'require_factor' &&
    attempt.requiredFactor !== request.factor.type
  ) {
    await withTenant(tenantId, (tx) =>
      audit(tx, {
        userId: attempt.userId,
        action: 'auth.mfa_failed',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: {
          reason: 'wrong_factor_type',
          required: attempt.requiredFactor,
          presented: request.factor.type,
        },
      }),
    );
    return { status: 'deny', reason: 'factor_invalid' };
  }

  // Checked before the factor is verified, not after. A recovery code is spent
  // by the act of verifying it, so a user deactivated mid-flow would otherwise
  // burn one of their ten codes on a sign-in that was always going to be
  // refused. The window between this check and the consume below is still
  // non-zero — a deactivation landing inside it spends the code — and that is
  // accepted: the alternative is holding a transaction open across the
  // verification, which is the constraint this whole design exists to respect.
  if (!(await stillActive(tenantId, attempt.userId))) {
    return { status: 'deny', reason: 'user_inactive' };
  }

  // Phase 2 — verify. Outside any transaction: this is crypto and, for
  // WebAuthn, possibly a network read.
  const verification = await verifyFactor(tenantId, attempt.userId, request.factor, {
    now,
    relyingParty: request.relyingParty,
  });

  if (!verification.ok) {
    await withTenant(tenantId, (tx) =>
      audit(tx, {
        userId: attempt.userId,
        action: 'auth.mfa_failed',
        outcome: 'failure',
        sourceIp: request.sourceIp,
        payload: { reason: verification.reason, factor: request.factor.type },
      }),
    );
    // One verifier reason is surfaced rather than collapsed: the code that
    // completed enrolment is refused by the replay watermark, and a user
    // looking at a correct-looking code on their phone needs to be told that
    // rather than left to guess. It is safe to distinguish here and nowhere
    // else, because reaching this point already required a valid attempt token
    // issued after primary authentication succeeded — it discloses nothing an
    // attacker does not already hold.
    if (verification.reason === 'totp_used_for_enrolment') {
      return { status: 'deny', reason: 'factor_used_for_enrolment' };
    }
    return { status: 'deny', reason: 'factor_invalid' };
  }

  // Phase 3 — consume the attempt and audit it together, then re-decide.
  const consumed = await withTenant(tenantId, async (tx) => {
    const ok = await consumeAttempt(tx, attempt.id, now);
    if (ok) {
      await audit(tx, {
        userId: attempt.userId,
        action: 'auth.mfa_verified',
        outcome: 'success',
        sourceIp: request.sourceIp,
        payload: { factor: request.factor.type },
      });
    }
    return ok;
  });
  if (!consumed) return { status: 'deny', reason: 'attempt_invalid' };

  // Re-evaluating rather than trusting the stored decision means a rule
  // tightened while the user was reaching for their phone still applies.
  return decide(tenantId, {
    userId: attempt.userId,
    applicationId: attempt.applicationId,
    sourceIp: request.sourceIp,
    // From the attempt, which recorded what its issuer intended. Never from
    // whether this request happened to arrive with a cookie.
    scope: attempt.scope,
    floor: undefined,
    satisfied: request.factor.type,
    now,
  });
}

async function completeEnrolment(
  tenantId: string,
  request: Extract<AuthorizeRequest, { kind: 'enrolled' }>,
  now: Date,
): Promise<AuthorizeResult> {
  const attempt = await liveAttempt(tenantId, request.attemptToken, 'enrol', now);
  if (!attempt) return { status: 'deny', reason: 'attempt_invalid' };
  if (!(await stillActive(tenantId, attempt.userId))) {
    return { status: 'deny', reason: 'user_inactive' };
  }

  if (
    attempt.requiredOutcome === 'require_factor' &&
    attempt.requiredFactor !== request.enrolledFactor
  ) {
    return { status: 'deny', reason: 'factor_invalid' };
  }

  // The caller's claim is not evidence. Read what the user actually holds now:
  // the enrolment endpoint and this call are separate requests, and only the
  // database knows whether the enrolment committed.
  const enrolled = await withTenant(tenantId, (tx) =>
    enrolledFactorTypes(tx, attempt.userId),
  );
  if (!enrolled.includes(request.enrolledFactor)) {
    return { status: 'deny', reason: 'factor_not_enrolled' };
  }

  const consumed = await withTenant(tenantId, async (tx) => {
    const ok = await consumeAttempt(tx, attempt.id, now);
    if (ok) {
      // Named explicitly, so a factor enrolled by whoever held the password
      // during a forced-enrolment challenge is visible in the log afterwards
      // rather than looking like an ordinary self-service enrolment.
      await audit(tx, {
        userId: attempt.userId,
        action: 'auth.forced_enrolment_completed',
        outcome: 'success',
        sourceIp: request.sourceIp,
        payload: {
          factor: request.enrolledFactor,
          required: attempt.requiredOutcome,
          requiredFactor: attempt.requiredFactor,
          ruleId: attempt.ruleId,
          underForcedEnrolment: true,
        },
      });
    }
    return ok;
  });
  if (!consumed) return { status: 'deny', reason: 'attempt_invalid' };

  if (!(await stillActive(tenantId, attempt.userId))) {
    return { status: 'deny', reason: 'user_inactive' };
  }

  // Enrolling is itself proof of possession — a TOTP enrolment is confirmed by
  // a live code, and a WebAuthn registration carries an attestation the
  // authenticator signed. So the factor counts as presented for this sign-in,
  // and the user is not asked for it twice in a row.
  return decide(tenantId, {
    userId: attempt.userId,
    applicationId: attempt.applicationId,
    sourceIp: request.sourceIp,
    scope: attempt.scope,
    floor: undefined,
    satisfied: request.enrolledFactor,
    now,
  });
}
```

- [ ] **Step 7: Stop exporting the old entry point**

In `packages/core/src/index.ts`, replace the line

```ts
export * from './auth/login-service.js';
```

with

```ts
// authenticate() is deliberately NOT exported. It is the password half of
// authorize(), and a caller that reached it directly would skip policy
// evaluation, second factors and the audit event. authorize() is the door.
export type { AuthFailure, AuthResult } from './auth/login-service.js';
export * from './auth/authorize.js';
export * from './auth/attempt-service.js';
export * from './auth/mfa/relying-party.js';
export * from './auth/mfa/types.js';
export * from './auth/mfa/registry.js';
```

- [ ] **Step 8: Run the chokepoint test**

Run: `pnpm vitest run packages/core/src/auth/authorize.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 9: Derive the relying party from the tenant**

`apps/api/src/routes/relying-party.ts`:

```ts
import type { FastifyRequest } from 'fastify';
import type { RelyingParty } from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';

/**
 * The WebAuthn relying party for a tenant.
 *
 * From the tenant's own configuration, never from the request. `Host` is
 * attacker-controlled and `tenant-context.ts` resolves a tenant from its
 * leftmost label, so `acme.attacker.example` resolves tenant `acme` — deriving
 * the RP ID or the expected origin from that header lets a phisher choose what
 * their own assertion is checked against, which is precisely the property a
 * security key exists to provide. Checking the stored `rpId` on the credential
 * afterwards does not help, because a registration performed in the same
 * phishing flow stamps the attacker's RP ID onto the row.
 *
 * The scheme and port come from `PUBLIC_URL`: behind a TLS-terminating proxy
 * Fastify reports `http` unless it is told to trust the forwarded headers, and
 * a wrong expected origin fails every assertion with a message that points
 * nowhere useful.
 */
export function tenantRelyingParty(
  tenant: { primaryDomain: string | null },
  publicUrl: string,
): RelyingParty {
  const base = new URL(publicUrl);
  if (!tenant.primaryDomain) {
    // No primary domain configured. This is a usable relying party for a
    // single-tenant deployment served straight off PUBLIC_URL; for anything
    // else the Host check below refuses WebAuthn until an administrator sets
    // one. That refusal is correct — there is no safe way to guess a tenant's
    // own origin, and guessing it from the request is the vulnerability.
    return { id: base.hostname, origin: base.origin };
  }
  const port = base.port ? `:${base.port}` : '';
  return {
    id: tenant.primaryDomain,
    origin: `${base.protocol}//${tenant.primaryDomain}${port}`,
  };
}

/**
 * Refuses a WebAuthn operation whose request did not arrive on the tenant's own
 * host.
 *
 * Applied at the WebAuthn endpoints only. Password authentication does not care
 * what the relying party is, and refusing a sign-in because a tenant has not
 * configured a primary domain would be a worse failure than the one being
 * prevented.
 */
export function assertWebAuthnUsable(
  request: FastifyRequest,
  tenant: { primaryDomain: string | null },
  rp: RelyingParty,
): void {
  const host = (request.headers.host ?? '').split(':')[0]!.toLowerCase();
  if (host === rp.id.toLowerCase()) return;

  throw new ProblemError(
    409,
    'webauthn-unavailable',
    'Security keys are not available on this address',
    tenant.primaryDomain
      ? `This tenant registers security keys against ${rp.id}. Sign in at that address to use one.`
      : 'An administrator must set this tenant a primary domain before security keys can be used. Until then, use an authenticator app.',
  );
}
```

- [ ] **Step 10: Rewire the login and elevation routes**

In `apps/api/src/routes/auth.ts`, replace the `authenticate` import with
`authorize`. `registerAuthRoutes`'s options gain `publicUrl: string`; pass
`config.publicUrl` when it is registered in `apps/api/src/app.ts`.

Both handlers need the tenant row for its `primaryDomain`, so both read it
through one helper:

```ts
  const relyingPartyFor = async (request: FastifyRequest) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    return { tenant, rp: tenantRelyingParty(tenant, options.publicUrl) };
  };
```

```ts
  app.post('/login', { config: PASSWORD_RATE_LIMIT }, async (request, reply) => {
    const body = loginRequest.parse(request.body);
    const { rp } = await relyingPartyFor(request);

    const result = await authorize(request.tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: body.login, password: body.password },
      applicationId: null,
      sourceIp: request.ip,
      relyingParty: rp,
      scope: 'portal',
    });

    // Every failure reason collapses into one response. Which of them applied
    // is recorded in the audit log, where an administrator can see it and an
    // attacker cannot — a policy denial must not be distinguishable from a
    // wrong password, or the policy itself becomes an oracle.
    if (result.status === 'deny') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    if (result.status === 'challenge') {
      return reply.status(200).send({
        status: 'challenge',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        acceptableFactors: result.acceptableFactors,
      });
    }

    // The password was right and the policy wants a factor this user does not
    // have. They are not signed in — no cookie is set — and the token they get
    // back buys exactly one thing: enrolling a factor of the required kind.
    if (result.status === 'enrol') {
      return reply.status(200).send({
        status: 'enrol',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        enrollableFactors: result.enrollableFactors,
      });
    }

    const { token } = await request.db((tx) =>
      createSession(tx, result.userId, result.scope, result.satisfiedFactor),
    );
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);

    return {
      status: 'authenticated',
      ...(await sessionBody(request, result.userId, result.scope)),
    };
  });
```

Elevation goes through `authorize()` in this same step. There is no interim
where `/elevate` imports `authenticate` directly: the Global Constraint says
`authorize()` is the only door, and a twelve-task exception to it is the kind of
temporary arrangement that becomes permanent. Task 16 adds the MFA floor on top
of this; the routing is done here.

```ts
  app.post(
    '/elevate',
    { preHandler: requireSession('portal'), config: PASSWORD_RATE_LIMIT },
    async (request, reply) => {
      const body = elevateRequest.parse(request.body);
      const { userId } = request.session;

      const admin = await request.db((tx) => isAdministrator(tx, userId));
      if (!admin) {
        throw new ProblemError(403, 'not-an-administrator', 'Not an administrator');
      }

      const user = await request.db((tx) => tx.user.findUnique({ where: { id: userId } }));
      if (!user) throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');

      const { rp } = await relyingPartyFor(request);

      // The password is re-entered rather than trusted from the existing
      // session: elevation is a fresh authentication, not a flag flip.
      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        principal: { kind: 'password', login: user.login, password: body.password },
        applicationId: null,
        sourceIp: request.ip,
        relyingParty: rp,
        // The scope stamped on any attempt opened here, and the scope of the
        // session issued at the end of it. Recorded, never inferred.
        scope: 'admin',
      });

      if (decision.status === 'deny') {
        throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
      }
      if (decision.status === 'challenge') {
        return reply.status(200).send({
          status: 'challenge',
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          acceptableFactors: decision.acceptableFactors,
        });
      }
      if (decision.status === 'enrol') {
        return reply.status(200).send({
          status: 'enrol',
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          enrollableFactors: decision.enrollableFactors,
        });
      }

      const { token } = await request.db((tx) =>
        createSession(tx, userId, decision.scope, decision.satisfiedFactor),
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: userId,
          action: 'auth.elevate',
          targetType: 'Session',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {},
        }),
      );

      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      return { status: 'authenticated', ...(await sessionBody(request, userId, 'admin')) };
    },
  );
```

- [ ] **Step 11: Record what established a session**

`createSession` and `resolveSession` must carry `satisfiedFactor`, or the
application-launch path re-challenges forever. In
`packages/core/src/auth/session-service.ts`, widen `createSession`:

```ts
export async function createSession(
  tx: TenantClient,
  userId: string,
  scope: SessionScope,
  satisfiedFactor: string | null = null,
): Promise<{ token: string; expiresAt: Date }> {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = new Date(Date.now() + ABSOLUTE_LIFETIME_MS[scope]);

  await tx.session.create({
    data: {
      tenantId,
      userId,
      tokenHash: hashToken(token),
      scope,
      satisfiedFactor,
      absoluteExpiresAt,
    },
  });

  return { token, expiresAt: absoluteExpiresAt };
}
```

and widen `ResolvedSession`:

```ts
export interface ResolvedSession {
  sessionId: string;
  userId: string;
  scope: SessionScope;
  /**
   * The second factor this session was established with, if any.
   *
   * Read by anything that re-enters authorize() holding a session. Launching
   * an application is a fresh decision, but it is not a fresh sign-in, and the
   * factor the user already presented still counts. Without this, every launch
   * of an application covered by a require_mfa rule issues the same challenge
   * the user has just answered, and the application is unreachable forever.
   */
  satisfiedFactor: string | null;
}
```

with `resolveSession` returning `satisfiedFactor: row.satisfiedFactor` alongside
the fields it already returns.

- [ ] **Step 12: Extend the route test**

Append to `apps/api/src/routes/auth.test.ts`:

```ts
describe('POST /api/auth/login and policy', () => {
  it('reports a policy denial exactly as it reports a wrong password', async () => {
    await seedUser();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'No', outcome: 'deny' }));

    const denied = await login(PASSWORD);
    const wrong = await login('definitely-not-the-password');

    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual(wrong.json());
    expect(denied.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });

  it('marks a plain success as authenticated', async () => {
    await seedUser();
    const res = await login(PASSWORD);
    expect(res.json()).toMatchObject({ status: 'authenticated', scope: 'portal' });
  });

  it('refuses when nothing can be enrolled and the user holds no factor', async () => {
    // No factor verifier is installed by app.ts until Task 8, so there is
    // nothing to offer and the honest answer is a refusal. Task 9 asserts the
    // enrolment response once the verifiers are installed.
    await seedUser();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'MFA everywhere', outcome: 'require_mfa' }),
    );
    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });
});
```

Add `addRule` to the `@syntra/core` import at the top of that file.

- [ ] **Step 13: Run the API suite**

Run: `pnpm vitest run apps/api/src/routes/auth.test.ts`
Expected: PASS. The pre-existing login tests still pass — with no policy
configured the fallback is `allow`, so nothing about a plain sign-in changes.

- [ ] **Step 14: Update the web client for the new shape**

In `apps/web/src/session/SessionProvider.tsx`, the `login` callback currently
assigns the response straight into the session. The response can now be a
challenge or an enrolment demand, neither of which is a session. Change it to
return the response so the caller can branch:

```ts
  const login = useCallback(
    async (loginName: string, password: string): Promise<LoginOutcome> => {
      const result = await api<LoginOutcome>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: loginName, password }),
      });
      if (result.status === 'authenticated') setSession(result);
      return result;
    },
    [],
  );
```

and add above the provider:

```ts
export type FactorKind = 'totp' | 'webauthn';

export type LoginOutcome =
  | ({ status: 'authenticated' } & SessionResponse)
  | {
      /** Present a factor you already hold. */
      status: 'challenge';
      attemptToken: string;
      expiresAt: string;
      acceptableFactors: FactorKind[];
    }
  | {
      /** Enrol a factor of the required kind. Still no session. */
      status: 'enrol';
      attemptToken: string;
      expiresAt: string;
      enrollableFactors: FactorKind[];
    };
```

Change the interface member to
`login(login: string, password: string): Promise<LoginOutcome>`.

In `apps/web/src/pages/Login.tsx`, change the submit handler's success branch
to name both non-session outcomes for now — Task 14 gives each a screen:

```ts
      const outcome = await login(loginName, password);
      if (outcome.status === 'authenticated') {
        navigate('/', { replace: true });
      } else if (outcome.status === 'challenge') {
        // Task 14 replaces this with the step-up screen.
        setError('This account requires a second factor. That screen is not built yet.');
      } else {
        // Task 14 replaces this with the forced-enrolment screen.
        setError('This account must register a second factor. That screen is not built yet.');
      }
```

- [ ] **Step 15: Run everything and commit**

```bash
pnpm exec tsc -b
pnpm vitest run packages/core packages/db apps/api
pnpm --filter @syntra/web test
git add -A
git commit -m "feat: route every authentication through a single authorize() chokepoint"
```

---

## Task 5: TOTP

**Files:**
- Create: `packages/core/src/auth/mfa/totp.ts`
- Modify: `packages/core/package.json` — add `otpauth`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/auth/mfa/totp.test.ts`

**Interfaces:**
- Consumes: from Task 4 — `FactorVerifier`, `FactorPresentation`, `FactorVerifyResult`, `registerFactorVerifier`, `authorize`. From the existing codebase — `putSecret`, `getSecret`, `deleteSecret`, `MasterKeyProvider` from `../../vault/`, `currentTenant`, `withTenant`.
- Produces:
  - `const TOTP_PERIOD_SECONDS = 30`, `const TOTP_WINDOW_STEPS = 1`
  - `interface TotpEnrolment { secret: string; uri: string }`
  - `function beginTotpEnrolment(tx: TenantClient, provider: MasterKeyProvider, userId: string): Promise<TotpEnrolment>`
  - `function confirmTotpEnrolment(tenantId: string, provider: MasterKeyProvider, userId: string, code: string, now?: Date): Promise<boolean>`
  - `function hasTotp(tx: TenantClient, userId: string): Promise<boolean>`
  - `function removeTotp(tx: TenantClient, userId: string): Promise<void>`
  - `function totpVerifier(provider: MasterKeyProvider): FactorVerifier`
  - `function installTotpVerifier(provider: MasterKeyProvider): void`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @syntra/core add otpauth@9.5.1
```

`otpauth` is the TOTP implementation: actively maintained, pure TypeScript,
one runtime dependency (`@noble/hashes`), and it exposes both the code
generator and the counter arithmetic as static functions, which is what lets
this module do its own constant-time comparison and keep its own replay
watermark instead of trusting a boolean.

- [ ] **Step 2: Write the failing test**

`packages/core/src/auth/mfa/totp.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import { localMasterKeyProvider } from '../../vault/master-key.js';
import { getSecret } from '../../vault/vault-service.js';
import {
  TOTP_PERIOD_SECONDS,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  hasTotp,
  removeTotp,
  totpVerifier,
} from './totp.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

let tenantId: string;
let userId: string;

const NOW = new Date('2026-08-12T09:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const enrol = () =>
  withTenant(tenantId, (tx) => beginTotpEnrolment(tx, provider, userId));

const codeAt = (secret: string, at: Date) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: TOTP_PERIOD_SECONDS,
    digits: 6,
    algorithm: 'SHA1',
    timestamp: at.getTime(),
  });

/** TOTP never reads it, but the context shape is the same for every factor. */
const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

const verify = (code: string, at = NOW) =>
  totpVerifier(provider).verify(tenantId, userId, { type: 'totp', code }, {
    now: at,
    relyingParty: RP,
  });

describe('beginTotpEnrolment', () => {
  it('returns a base32 secret and an otpauth URI', async () => {
    const enrolment = await enrol();
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolment.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enrolment.uri).toContain(`secret=${enrolment.secret}`);
  });

  it('stores the secret in the vault, not on the row', async () => {
    const enrolment = await enrol();
    const row = await withTenant(tenantId, (tx) =>
      tx.totpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(JSON.stringify(row)).not.toContain(enrolment.secret);

    const stored = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, row.secretName),
    );
    expect(stored).toBe(enrolment.secret);
  });

  it('leaves the credential unconfirmed until a code is presented', async () => {
    await enrol();
    const row = await withTenant(tenantId, (tx) =>
      tx.totpCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(row.confirmedAt).toBeNull();
    expect(await withTenant(tenantId, (tx) => hasTotp(tx, userId))).toBe(false);
  });

  it('replaces an unconfirmed enrolment rather than failing', async () => {
    const first = await enrol();
    const second = await enrol();
    expect(second.secret).not.toBe(first.secret);
    expect(await withTenant(tenantId, (tx) => tx.totpCredential.count())).toBe(1);
  });
});

describe('confirmTotpEnrolment', () => {
  it('accepts a current code and marks the credential confirmed', async () => {
    const enrolment = await enrol();
    const ok = await confirmTotpEnrolment(
      tenantId,
      provider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );
    expect(ok).toBe(true);
    expect(await withTenant(tenantId, (tx) => hasTotp(tx, userId))).toBe(true);
  });

  it('refuses a wrong code and leaves the credential unconfirmed', async () => {
    await enrol();
    expect(await confirmTotpEnrolment(tenantId, provider, userId, '000000', NOW)).toBe(false);
    expect(await withTenant(tenantId, (tx) => hasTotp(tx, userId))).toBe(false);
  });
});

describe('totpVerifier', () => {
  let secret: string;

  beforeEach(async () => {
    const enrolment = await enrol();
    secret = enrolment.secret;
    await confirmTotpEnrolment(tenantId, provider, userId, codeAt(secret, NOW), NOW);
  });

  it('accepts a code from the current step', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(await verify(codeAt(secret, later), later)).toEqual({ ok: true });
  });

  it('accepts a code from one step back, for a slow phone', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const oneStepBack = new Date(later.getTime() - TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, oneStepBack), later)).toEqual({ ok: true });
  });

  it('accepts a code from one step forward, for a fast phone', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const oneStepOn = new Date(later.getTime() + TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, oneStepOn), later)).toEqual({ ok: true });
  });

  it('refuses a code two steps away', async () => {
    const later = new Date(NOW.getTime() + 300_000);
    const tooOld = new Date(later.getTime() - 2 * TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, tooOld), later)).toEqual({
      ok: false,
      reason: 'totp_invalid',
    });
  });

  it('refuses the same code twice', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const code = codeAt(secret, later);
    expect(await verify(code, later)).toEqual({ ok: true });
    expect(await verify(code, later)).toEqual({ ok: false, reason: 'totp_replayed' });
  });

  it('refuses a code from a step already used, even a valid earlier one', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await verify(codeAt(secret, later), later);
    const oneStepBack = new Date(later.getTime() - TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, oneStepBack), later)).toEqual({
      ok: false,
      reason: 'totp_replayed',
    });
  });

  it('names the enrolment code specifically when it is presented again', async () => {
    // Enrol, then try to sign in with the same code seconds later. The refusal
    // is correct; an unexplained one is a support ticket, so it carries its own
    // reason all the way out to a sentence on the screen.
    await withTenant(tenantId, (tx) => removeTotp(tx, userId));
    const fresh = await enrol();
    const code = codeAt(fresh.secret, NOW);
    expect(await confirmTotpEnrolment(tenantId, provider, userId, code, NOW)).toBe(true);

    expect(await verify(code, NOW)).toEqual({
      ok: false,
      reason: 'totp_used_for_enrolment',
    });
  });

  it('still reports an ordinary replay as a replay', async () => {
    const later = new Date(NOW.getTime() + 120_000);
    const code = codeAt(secret, later);
    expect(await verify(code, later)).toEqual({ ok: true });
    // Not the enrolment step, so not the enrolment message.
    expect(await verify(code, later)).toEqual({ ok: false, reason: 'totp_replayed' });
  });

  it('accepts the next step after one has been used', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await verify(codeAt(secret, later), later);
    const next = new Date(later.getTime() + TOTP_PERIOD_SECONDS * 1000);
    expect(await verify(codeAt(secret, next), next)).toEqual({ ok: true });
  });

  it('refuses a user with no TOTP credential', async () => {
    await withTenant(tenantId, (tx) => removeTotp(tx, userId));
    expect(await verify('000000')).toEqual({ ok: false, reason: 'totp_not_enrolled' });
  });

  it('refuses an unconfirmed credential', async () => {
    await withTenant(tenantId, (tx) => removeTotp(tx, userId));
    const fresh = await enrol();
    const later = new Date(NOW.getTime() + 60_000);
    expect(await verify(codeAt(fresh.secret, later), later)).toEqual({
      ok: false,
      reason: 'totp_not_enrolled',
    });
  });

  it('refuses a code of the wrong shape without touching the vault', async () => {
    expect(await verify('12345')).toEqual({ ok: false, reason: 'totp_invalid' });
    expect(await verify('abcdef')).toEqual({ ok: false, reason: 'totp_invalid' });
    expect(await verify('')).toEqual({ ok: false, reason: 'totp_invalid' });
  });
});

describe('removeTotp', () => {
  it('removes the credential and the vault secret together', async () => {
    const enrolment = await enrol();
    await confirmTotpEnrolment(tenantId, provider, userId, codeAt(enrolment.secret, NOW), NOW);
    const row = await withTenant(tenantId, (tx) =>
      tx.totpCredential.findUniqueOrThrow({ where: { userId } }),
    );

    await withTenant(tenantId, (tx) => removeTotp(tx, userId));

    expect(await withTenant(tenantId, (tx) => tx.totpCredential.count())).toBe(0);
    expect(await withTenant(tenantId, (tx) => getSecret(tx, provider, row.secretName))).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/auth/mfa/totp.test.ts`
Expected: FAIL — cannot resolve `./totp.js`.

- [ ] **Step 4: Implement TOTP**

`packages/core/src/auth/mfa/totp.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import type { MasterKeyProvider } from '../../vault/master-key.js';
import { deleteSecret, getSecret, putSecret } from '../../vault/vault-service.js';
import { registerFactorVerifier } from './registry.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = 'SHA1';

/**
 * One step either side of now. RFC 6238 calls a small window acceptable for
 * clock drift; every extra step is another code an attacker who shoulder-surfed
 * one gets to use, so this is deliberately the smallest useful value.
 */
export const TOTP_WINDOW_STEPS = 1;

const CODE_SHAPE = /^[0-9]{6}$/;

const secretNameFor = (userId: string) => `totp.${userId}`;

export interface TotpEnrolment {
  secret: string;
  uri: string;
}

/**
 * Starts enrolment: a fresh secret into the vault, an unconfirmed credential
 * row, and the shared secret returned to the caller exactly once. The
 * credential does not count as a factor until the user proves possession.
 */
export async function beginTotpEnrolment(
  tx: TenantClient,
  provider: MasterKeyProvider,
  userId: string,
): Promise<TotpEnrolment> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

  const existing = await tx.totpCredential.findUnique({ where: { userId } });
  if (existing?.confirmedAt) {
    throw new Error('a confirmed TOTP credential already exists for this user');
  }

  const secret = new OTPAuth.Secret({ size: 20 });
  const base32 = secret.base32;
  const secretName = secretNameFor(userId);

  await putSecret(tx, provider, secretName, base32);

  await tx.totpCredential.upsert({
    where: { userId },
    create: {
      tenantId,
      userId,
      secretName,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    },
    update: { secretName, lastCounter: null, confirmedAt: null },
  });

  const uri = new OTPAuth.TOTP({
    issuer: tenant.name,
    label: user.login,
    secret,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  }).toString();

  return { secret: base32, uri };
}

interface StepMatch {
  counter: number;
}

/**
 * Finds which counter step, if any, the presented code belongs to.
 *
 * Every candidate is compared with timingSafeEqual and the loop runs to the
 * end rather than returning early, so the time taken does not disclose which
 * step matched or whether any did. Comparing with === would leak the shared
 * prefix one byte at a time.
 */
function matchStep(
  secret: OTPAuth.Secret,
  code: string,
  period: number,
  digits: number,
  algorithm: string,
  now: Date,
): StepMatch | null {
  const presented = Buffer.from(code, 'utf8');
  const current = OTPAuth.TOTP.counter({ period, timestamp: now.getTime() });

  let found: StepMatch | null = null;
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const timestamp = (current + delta) * period * 1000;
    const expected = Buffer.from(
      OTPAuth.TOTP.generate({ secret, period, digits, algorithm, timestamp }),
      'utf8',
    );
    if (
      expected.length === presented.length &&
      timingSafeEqual(expected, presented) &&
      found === null
    ) {
      found = { counter: current + delta };
    }
  }
  return found;
}

/**
 * Confirms an enrolment. Takes a tenantId rather than a transaction: unwrapping
 * the vault key and generating three candidate codes is work that does not
 * belong inside a caller's interactive transaction.
 */
export async function confirmTotpEnrolment(
  tenantId: string,
  provider: MasterKeyProvider,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!CODE_SHAPE.test(code)) return false;

  const row = await withTenant(tenantId, (tx) =>
    tx.totpCredential.findUnique({ where: { userId } }),
  );
  if (!row || row.confirmedAt) return false;

  const base32 = await withTenant(tenantId, (tx) =>
    getSecret(tx, provider, row.secretName),
  );
  if (!base32) return false;

  const match = matchStep(
    OTPAuth.Secret.fromBase32(base32),
    code,
    row.period,
    row.digits,
    row.algorithm,
    now,
  );
  if (!match) return false;

  await withTenant(tenantId, (tx) =>
    tx.totpCredential.update({
      where: { userId },
      data: { confirmedAt: now, lastCounter: match.counter },
    }),
  );
  return true;
}

export async function hasTotp(tx: TenantClient, userId: string): Promise<boolean> {
  const row = await tx.totpCredential.findUnique({ where: { userId } });
  return row !== null && row.confirmedAt !== null;
}

export async function removeTotp(tx: TenantClient, userId: string): Promise<void> {
  const row = await tx.totpCredential.findUnique({ where: { userId } });
  if (!row) return;
  await tx.totpCredential.delete({ where: { userId } });
  await deleteSecret(tx, row.secretName);
}

/**
 * The verifier the chokepoint consults.
 *
 * Acceptance is not just "the arithmetic works": the step that produced the
 * code must be strictly later than the last step already accepted, and the
 * watermark is advanced with a conditional update whose row count is checked.
 * Without both, a code shoulder-surfed inside its 30-second window is usable a
 * second time, and two requests presenting it at once both succeed.
 */
export function totpVerifier(provider: MasterKeyProvider): FactorVerifier {
  return {
    type: 'totp',
    // A user with no factor may add this one mid-sign-in when policy demands
    // it: an authenticator app needs nothing an administrator has to post out.
    enrollable: true,

    async enrolled(tx, userId) {
      return hasTotp(tx, userId);
    },

    async verify(tenantId, userId, presentation, context): Promise<FactorVerifyResult> {
      const { now } = context;
      if (presentation.type !== 'totp') {
        return { ok: false, reason: 'totp_invalid' };
      }
      if (!CODE_SHAPE.test(presentation.code)) {
        return { ok: false, reason: 'totp_invalid' };
      }

      const row = await withTenant(tenantId, (tx) =>
        tx.totpCredential.findUnique({ where: { userId } }),
      );
      if (!row || !row.confirmedAt) {
        return { ok: false, reason: 'totp_not_enrolled' };
      }

      const base32 = await withTenant(tenantId, (tx) =>
        getSecret(tx, provider, row.secretName),
      );
      if (!base32) {
        // The row says enrolled and the vault disagrees. That is a fault, not
        // a wrong code, and it is recorded as its own reason rather than
        // disappearing into "invalid".
        return { ok: false, reason: 'totp_secret_missing' };
      }

      const match = matchStep(
        OTPAuth.Secret.fromBase32(base32),
        presentation.code,
        row.period,
        row.digits,
        row.algorithm,
        now,
      );
      if (!match) return { ok: false, reason: 'totp_invalid' };

      if (row.lastCounter !== null && match.counter <= row.lastCounter) {
        // The watermark is set at confirmation, so the very code that
        // completed enrolment is refused if it is presented again inside its
        // own thirty-second step. That is the point — it stops the enrolment
        // code being replayed as a login — but it is also the one refusal a
        // user is guaranteed to meet while looking at a correct code, so it
        // gets its own reason rather than disappearing into "invalid".
        const enrolCounter = row.confirmedAt
          ? OTPAuth.TOTP.counter({
              period: row.period,
              timestamp: row.confirmedAt.getTime(),
            })
          : null;
        if (enrolCounter !== null && match.counter === enrolCounter) {
          return { ok: false, reason: 'totp_used_for_enrolment' };
        }
        return { ok: false, reason: 'totp_replayed' };
      }

      const advanced = await withTenant(tenantId, (tx) =>
        tx.totpCredential.updateMany({
          where: {
            userId,
            OR: [{ lastCounter: null }, { lastCounter: { lt: match.counter } }],
          },
          data: { lastCounter: match.counter },
        }),
      );
      // Zero rows means another request advanced the watermark first. That
      // request has the code; this one is a replay of it.
      if (advanced.count !== 1) return { ok: false, reason: 'totp_replayed' };

      return { ok: true };
    },
  };
}

export function installTotpVerifier(provider: MasterKeyProvider): void {
  registerFactorVerifier(totpVerifier(provider));
}
```

- [ ] **Step 5: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/auth/mfa/totp.test.ts`
Expected: PASS, 19 tests.

If "refuses the same code twice" fails, the watermark is being written but not
read back, or `updateMany`'s count is being ignored. Do not proceed — that is
the entire replay defence.

- [ ] **Step 6: Prove the chokepoint challenges, enrols and accepts**

Append to `packages/core/src/auth/authorize.test.ts`:

```ts
import * as OTPAuth from 'otpauth';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  TOTP_PERIOD_SECONDS,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  installTotpVerifier,
} from './mfa/totp.js';

const totpProvider = localMasterKeyProvider(Buffer.alloc(32, 7));

const codeAt = (secret: string, at: Date) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: TOTP_PERIOD_SECONDS,
    digits: 6,
    algorithm: 'SHA1',
    timestamp: at.getTime(),
  });

describe('authorize — TOTP step-up', () => {
  // Installed here rather than at module scope: the outer beforeEach empties
  // the registry, so each describe declares exactly what it exercises.
  beforeEach(() => installTotpVerifier(totpProvider));

  async function enrolTotp(): Promise<string> {
    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, totpProvider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      totpProvider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );
    return enrolment.secret;
  }

  it('challenges instead of allowing when a rule requires MFA', async () => {
    const secret = await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });

    expect(challenge).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
      enrolledFactors: ['totp'],
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const allowed = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, later) },
      sourceIp: '10.1.2.3',
      relyingParty: RP,
      now: later,
    });
    expect(allowed).toMatchObject({ status: 'allow', userId, satisfiedFactor: 'totp' });
  });

  it('refuses a wrong code without burning the attempt', async () => {
    await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const wrong = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: later,
    });
    expect(wrong).toEqual({ status: 'deny', reason: 'factor_invalid' });

    const attempt = await withTenant(tenantId, (tx) => tx.authAttempt.findFirst());
    expect(attempt!.consumedAt).toBeNull();
  });

  it('refuses to reuse a consumed attempt token', async () => {
    const secret = await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, later) },
      sourceIp: null,
      relyingParty: RP,
      now: later,
    });

    const nextStep = new Date(later.getTime() + TOTP_PERIOD_SECONDS * 1000);
    const again = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, nextStep) },
      sourceIp: null,
      relyingParty: RP,
      now: nextStep,
    });
    expect(again).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('refuses an expired attempt token', async () => {
    const secret = await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const later = new Date(NOW.getTime() + 60_000);
    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: later,
    });
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const muchLater = new Date(later.getTime() + 10 * 60 * 1000);
    const expired = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'totp', code: codeAt(secret, muchLater) },
      sourceIp: null,
      relyingParty: RP,
      now: muchLater,
    });
    expect(expired).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('pairs every attempt it issues with an audit event, in one transaction', async () => {
    await enrolTotp();
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: new Date(NOW.getTime() + 60_000),
    });

    const attempts = await withTenant(tenantId, (tx) => tx.authAttempt.count());
    const challenged = await withTenant(tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: 'auth.mfa_challenged' } }),
    );
    expect(attempts).toBe(1);
    expect(challenged).toBe(1);
  });
});

describe('authorize — forced enrolment', () => {
  beforeEach(() => installTotpVerifier(totpProvider));

  it('offers enrolment rather than refusing a user who holds nothing', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });

    expect(result).toMatchObject({ status: 'enrol', enrollableFactors: ['totp'] });

    const events = await auditActions();
    expect(events.some((e) => e.action === 'auth.enrolment_required')).toBe(true);
  });

  it('issues a session once the factor is enrolled, without asking for it twice', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, totpProvider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      totpProvider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );

    const allowed = await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: offer.attemptToken,
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    // Enrolling is proof of possession: a TOTP enrolment is confirmed with a
    // live code, so the user is not immediately challenged for the same thing.
    expect(allowed).toMatchObject({ status: 'allow', userId, satisfiedFactor: 'totp' });
  });

  it('records the enrolment as having happened under a forced challenge', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, totpProvider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      totpProvider,
      userId,
      codeAt(enrolment.secret, NOW),
      NOW,
    );
    await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: offer.attemptToken,
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });

    // A stolen password can now buy an attacker their own factor. The trade is
    // accepted; being able to see it afterwards is what makes it acceptable.
    const events = await auditActions();
    const forced = events.find((e) => e.action === 'auth.forced_enrolment_completed');
    expect(forced).toBeDefined();
    expect(forced!.payload).toMatchObject({ factor: 'totp', underForcedEnrolment: true });
  });

  it('refuses an enrolled claim the database does not support', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    // Nothing was enrolled. Saying so must not be enough.
    const result = await authorize(tenantId, {
      kind: 'enrolled',
      attemptToken: offer.attemptToken,
      enrolledFactor: 'totp',
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('refuses to spend an enrolment attempt on a verification', async () => {
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const offer = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    if (offer.status !== 'enrol') throw new Error('expected an enrolment offer');

    const result = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: offer.attemptToken,
      factor: { type: 'totp', code: '000000' },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'attempt_invalid' });
  });

  it('refuses outright when the tenant has turned self-enrolment off', async () => {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { selfEnrolmentEnabled: false },
    });
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    // The tenant issues factors by hand. There is genuinely no way forward and
    // saying so is honest.
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('refuses when the rule names a factor this deployment cannot enrol', async () => {
    // Only TOTP is installed in this describe, so a rule demanding WebAuthn has
    // nothing to offer and nothing to accept.
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Keys only', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('does not offer a factor the rule did not ask for', async () => {
    // A rule naming TOTP offers TOTP and nothing else, even when more types
    // are installed.
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'App codes only', outcome: 'require_factor', factorType: 'totp' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toMatchObject({ status: 'enrol', enrollableFactors: ['totp'] });
  });
});
```

- [ ] **Step 7: Run and commit**

```bash
pnpm exec tsc -b
pnpm vitest run packages/core/src/auth
```
Expected: PASS. `authorize.test.ts` now runs 31 tests — the 18 from Task 4, plus five for the TOTP step-up and eight for forced enrolment.

Add to `packages/core/src/index.ts`:

```ts
export * from './auth/mfa/totp.js';
```

```bash
git add -A
git commit -m "feat: add TOTP enrolment and replay-protected verification"
```


---

## Task 6: WebAuthn

**Files:**
- Create: `packages/core/src/auth/mfa/webauthn.ts`
- Modify: `packages/core/package.json` — add `@simplewebauthn/server`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/auth/mfa/webauthn.test.ts`

**Interfaces:**
- Consumes: from Task 4 — `FactorVerifier`, `FactorVerifyContext`, `RelyingParty`, `RelyingPartyIdentity`, `registerFactorVerifier`. From `@simplewebauthn/server` — `generateRegistrationOptions`, `verifyRegistrationResponse`, `generateAuthenticationOptions`, `verifyAuthenticationResponse`, and the types `RegistrationResponseJSON`, `AuthenticationResponseJSON`, `PublicKeyCredentialCreationOptionsJSON`, `PublicKeyCredentialRequestOptionsJSON`, `AuthenticatorTransportFuture`.
- Produces:
  - `function beginWebAuthnRegistration(tenantId: string, userId: string, rp: RelyingPartyIdentity, now?: Date): Promise<PublicKeyCredentialCreationOptionsJSON>`
  - `type RegistrationOutcome = { ok: true; credentialId: string } | { ok: false; reason: string }`
  - `function finishWebAuthnRegistration(tenantId: string, userId: string, rp: RelyingPartyIdentity, label: string, response: RegistrationResponseJSON, now?: Date): Promise<RegistrationOutcome>`
  - `function beginWebAuthnAuthentication(tenantId: string, userId: string, rp: RelyingParty, now?: Date): Promise<PublicKeyCredentialRequestOptionsJSON>`
  - `function listWebAuthnCredentials(tx: TenantClient, userId: string): Promise<{ id: string; label: string; createdAt: Date; lastUsedAt: Date | null }[]>`
  - `function removeWebAuthnCredential(tx: TenantClient, userId: string, id: string): Promise<void>`
  - `function hasWebAuthn(tx: TenantClient, userId: string): Promise<boolean>`
  - `function webauthnVerifier(): FactorVerifier` — takes no argument; the relying party arrives on `FactorVerifyContext`
  - `function installWebAuthnVerifier(): void`
  - `const WEBAUTHN_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @syntra/core add @simplewebauthn/server@13.3.2
```

`@simplewebauthn/server` is the WebAuthn implementation: it is the
best-maintained Node library for the specification, it verifies attestation
statements and assertion signatures rather than leaving that to us, and its v13
API returns the credential shape (`{ id, publicKey, counter, transports }`)
directly. Hand-written COSE key parsing and CBOR decoding is exactly where
identity products acquire vulnerabilities.

- [ ] **Step 2: Note where the relying party comes from**

WebAuthn binds a credential to an RP ID and an origin, and Syntra selects a
tenant from the Host header, so both are per request rather than configuration.
Task 4 already declared `RelyingParty` in
`packages/core/src/auth/mfa/relying-party.ts` and made it a required field on
`AuthorizeRequest`; `tenantRelyingParty(tenant, publicUrl)` in
`apps/api/src/routes/relying-party.ts` is the one place it is derived, from
`Tenant.primaryDomain` and never from the `Host` header.

Registration additionally wants a display name, which verification does not, so
it takes `RelyingPartyIdentity` — the same two fields plus `name`, which routes
fill in from the tenant.

Nothing in this module reads an ambient store. The verifier receives the
relying party on `FactorVerifyContext`, which is what lets it be tested as a
pure function of its inputs and what stops a background job compiling into a
confusing run-time failure.

The RP ID a credential was registered under is stored on the row and re-checked
on every assertion. That check is a consistency guard, not the security
control: a phisher who could choose the RP ID would stamp their own onto the
row during registration and the comparison would pass. What makes the property
hold is that the RP ID comes from the tenant's own configuration, which the
attacker does not control.

- [ ] **Step 3: Write the failing test**

`packages/core/src/auth/mfa/webauthn.test.ts`. The test drives the real
library with a software authenticator built from Node's `crypto`, so signature
verification, the counter check and the origin check are all exercised for
real rather than mocked.

```ts
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  createHash,
  randomBytes,
} from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import type { RelyingParty, RelyingPartyIdentity } from './relying-party.js';
import {
  beginWebAuthnAuthentication,
  beginWebAuthnRegistration,
  finishWebAuthnRegistration,
  hasWebAuthn,
  listWebAuthnCredentials,
  removeWebAuthnCredential,
  webauthnVerifier,
} from './webauthn.js';

let tenantId: string;
let userId: string;

/** What verification needs. */
const RP: RelyingParty = {
  id: 'acme.syntra.test',
  origin: 'http://acme.syntra.test',
};

/** What registration needs: the same, plus a name for the browser prompt. */
const RP_ID: RelyingPartyIdentity = { ...RP, name: 'Acme' };

const b64u = (buf: Buffer) => buf.toString('base64url');

/**
 * A minimal software authenticator: an ES256 key pair, CBOR-encoded COSE
 * public key, and authenticator data assembled by hand. It signs what a real
 * key would sign, so verifyAuthenticationResponse does real work.
 */
class SoftKey {
  readonly credentialId = randomBytes(32);
  counter = 0;
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as {
      x: string;
      y: string;
    };
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    // CBOR map of 5 pairs: kty 2, alg -7, crv 1, x, y.
    return Buffer.concat([
      Buffer.from([0xa5]),
      Buffer.from([0x01, 0x02]),
      Buffer.from([0x03, 0x26]),
      Buffer.from([0x20, 0x01]),
      Buffer.from([0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ]);
  }

  private authData(rpId: string, includeCredential: boolean): Buffer {
    const rpIdHash = createHash('sha256').update(rpId).digest();
    // UP | UV, plus AT when an attested credential is included.
    const flags = Buffer.from([includeCredential ? 0x45 : 0x05]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    if (!includeCredential) return Buffer.concat([rpIdHash, flags, counter]);

    const aaguid = Buffer.alloc(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([
      rpIdHash,
      flags,
      counter,
      aaguid,
      idLength,
      this.credentialId,
      this.coseKey(),
    ]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(challenge: string, rp: RelyingParty) {
    const authData = this.authData(rp.id, true);
    const clientDataJSON = this.clientData('webauthn.create', challenge, rp.origin);
    // fmt "none", attStmt {}, authData.
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      Buffer.from([0x63]),
      Buffer.from('fmt'),
      Buffer.from([0x64]),
      Buffer.from('none'),
      Buffer.from([0x67]),
      Buffer.from('attStmt'),
      Buffer.from([0xa0]),
      Buffer.from([0x68]),
      Buffer.from('authData'),
      Buffer.from([0x59]),
      (() => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(authData.length);
        return len;
      })(),
      authData,
    ]);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['usb' as const],
      },
    };
  }

  assert(challenge: string, rp: RelyingParty, counterOverride?: number) {
    if (counterOverride !== undefined) this.counter = counterOverride;
    else this.counter += 1;

    const authData = this.authData(rp.id, false);
    const clientDataJSON = this.clientData('webauthn.get', challenge, rp.origin);
    const signed = Buffer.concat([
      authData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const signature = createSign('SHA256').update(signed).sign(this.keys.privateKey);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
    };
  }
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

async function register(key: SoftKey, label = 'YubiKey') {
  const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
  return finishWebAuthnRegistration(
    tenantId,
    userId,
    RP_ID,
    label,
    key.register(options.challenge, RP) as never,
  );
}

const verify = (assertion: unknown, at = new Date(), rp: RelyingParty = RP) =>
  webauthnVerifier().verify(
    tenantId,
    userId,
    { type: 'webauthn', assertion },
    { now: at, relyingParty: rp },
  );

describe('WebAuthn registration', () => {
  it('stores the credential with its public key, counter and RP ID', async () => {
    const key = new SoftKey();
    const outcome = await register(key);
    expect(outcome).toMatchObject({ ok: true });

    const row = await withTenant(tenantId, (tx) => tx.webAuthnCredential.findFirst());
    expect(row).toMatchObject({
      userId,
      rpId: RP.id,
      label: 'YubiKey',
      attestationType: 'none',
      transports: ['usb'],
    });
    expect(row!.publicKey.length).toBeGreaterThan(0);
    expect(await withTenant(tenantId, (tx) => hasWebAuthn(tx, userId))).toBe(true);
  });

  it('consumes the challenge, so a registration cannot be replayed', async () => {
    const key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    const response = key.register(options.challenge, RP);
    await finishWebAuthnRegistration(tenantId, userId, RP_ID, 'One', response as never);

    const again = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_ID,
      'Two',
      response as never,
    );
    expect(again).toEqual({ ok: false, reason: 'webauthn_no_challenge' });
  });

  it('refuses a registration from a different origin', async () => {
    const key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    const evil: RelyingParty = { ...RP, origin: 'http://evil.example' };
    const outcome = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_ID,
      'Bad',
      key.register(options.challenge, evil) as never,
    );
    expect(outcome).toEqual({ ok: false, reason: 'webauthn_registration_rejected' });
  });

  it('refuses a registration for a different RP ID', async () => {
    const key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    const evil: RelyingParty = { ...RP, id: 'evil.example' };
    const outcome = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_ID,
      'Bad',
      key.register(options.challenge, evil) as never,
    );
    expect(outcome).toEqual({ ok: false, reason: 'webauthn_registration_rejected' });
  });

  it('excludes credentials the user already holds', async () => {
    const key = new SoftKey();
    await register(key);
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([
      key.credentialId.toString('base64url'),
    ]);
  });
});

describe('WebAuthn assertion', () => {
  let key: SoftKey;

  beforeEach(async () => {
    key = new SoftKey();
    await register(key);
  });

  it('accepts a valid assertion and advances the stored counter', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const result = await verify(key.assert(options.challenge, RP));
    expect(result).toEqual({ ok: true });

    const row = await withTenant(tenantId, (tx) => tx.webAuthnCredential.findFirst());
    expect(row!.counter).toBe(key.counter);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('refuses a counter that goes backwards — the mark of a cloned key', async () => {
    const first = await beginWebAuthnAuthentication(tenantId, userId, RP);
    await verify(key.assert(first.challenge, RP));

    const second = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const result = await verify(key.assert(second.challenge, RP, 1));
    expect(result).toEqual({ ok: false, reason: 'webauthn_counter_regressed' });
  });

  it('still classifies the library counter error by its message', async () => {
    // webauthnVerifier distinguishes a cloned key from a bad signature by
    // looking for "counter" in the message @simplewebauthn/server throws.
    // Confirmed against verifyAuthenticationResponse.js:144-150 in 13.3.2 —
    // this test is what notices if a future version rewords it, because the
    // classification would silently degrade to webauthn_assertion_rejected and
    // a cloned key would look like a typo.
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const assertion = key.assert(options.challenge, RP);
    const row = await withTenant(tenantId, (tx) => tx.webAuthnCredential.findFirst());

    await expect(
      verifyAuthenticationResponse({
        response: assertion as never,
        expectedChallenge: options.challenge,
        expectedOrigin: RP.origin,
        expectedRPID: RP.id,
        credential: {
          id: row!.credentialId,
          publicKey: new Uint8Array(row!.publicKey),
          // Ahead of what the authenticator will report, so the guard fires.
          counter: key.counter + 5,
          transports: [],
        },
        requireUserVerification: false,
      }),
    ).rejects.toThrow(/counter/i);
  });

  it('refuses a counter that stands still', async () => {
    const first = await beginWebAuthnAuthentication(tenantId, userId, RP);
    await verify(key.assert(first.challenge, RP));
    const used = key.counter;

    const second = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const result = await verify(key.assert(second.challenge, RP, used));
    expect(result).toEqual({ ok: false, reason: 'webauthn_counter_regressed' });
  });

  it('refuses an assertion over a challenge that was never issued', async () => {
    const result = await verify(key.assert('bm90LWEtY2hhbGxlbmdl', RP));
    expect(result).toEqual({ ok: false, reason: 'webauthn_no_challenge' });
  });

  it('refuses a replayed assertion', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const assertion = key.assert(options.challenge, RP);
    expect(await verify(assertion)).toEqual({ ok: true });
    expect(await verify(assertion)).toEqual({ ok: false, reason: 'webauthn_no_challenge' });
  });

  it('refuses an assertion signed for another origin', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const evil: RelyingParty = { ...RP, origin: 'http://evil.example' };
    const result = await verify(key.assert(options.challenge, evil));
    expect(result).toEqual({ ok: false, reason: 'webauthn_assertion_rejected' });
  });

  it('refuses an assertion signed under another RP ID', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const evil: RelyingParty = { ...RP, id: 'evil.example' };
    const result = await verify(key.assert(options.challenge, evil));
    expect(result).toEqual({ ok: false, reason: 'webauthn_assertion_rejected' });
  });

  it('refuses a credential registered under a different RP ID than the request', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const assertion = key.assert(options.challenge, RP);
    // Same assertion, different host on the request. Syntra picks a tenant
    // from the Host header, so a credential enrolled at one tenant hostname
    // must not assert at another.
    const result = await verify(assertion, new Date(), {
      ...RP,
      id: 'other.syntra.test',
    });
    expect(result).toEqual({ ok: false, reason: 'webauthn_wrong_rp' });
  });

  it('refuses an unknown credential id', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const stranger = new SoftKey();
    const result = await verify(stranger.assert(options.challenge, RP));
    expect(result).toEqual({ ok: false, reason: 'webauthn_unknown_credential' });
  });

  it('refuses garbage that is not an assertion at all', async () => {
    expect(await verify({ nonsense: true })).toEqual({
      ok: false,
      reason: 'webauthn_malformed',
    });
    expect(await verify(null)).toEqual({ ok: false, reason: 'webauthn_malformed' });
  });
});

describe('listing and removal', () => {
  it('lists credentials without their public keys', async () => {
    await register(new SoftKey(), 'Laptop');
    const rows = await withTenant(tenantId, (tx) => listWebAuthnCredentials(tx, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Laptop' });
    expect(JSON.stringify(rows)).not.toContain('publicKey');
  });

  it('removes only the named credential and only for its owner', async () => {
    await register(new SoftKey(), 'A');
    const rows = await withTenant(tenantId, (tx) => listWebAuthnCredentials(tx, userId));
    await withTenant(tenantId, (tx) => removeWebAuthnCredential(tx, userId, rows[0]!.id));
    expect(await withTenant(tenantId, (tx) => hasWebAuthn(tx, userId))).toBe(false);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/auth/mfa/webauthn.test.ts`
Expected: FAIL — cannot resolve `./webauthn.js`.

- [ ] **Step 5: Implement WebAuthn**

`packages/core/src/auth/mfa/webauthn.ts`:

```ts
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { registerFactorVerifier } from './registry.js';
import type { RelyingParty, RelyingPartyIdentity } from './relying-party.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

export const WEBAUTHN_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

type Purpose = 'register' | 'authenticate';

/**
 * Issues a challenge and stores it, replacing any live one.
 *
 * A partial unique index allows only one live challenge per user and purpose,
 * so the previous one is consumed first rather than left valid: two open
 * challenges means a challenge captured from one flow can be answered in
 * another.
 */
async function issueChallenge(
  tenantId: string,
  userId: string,
  purpose: Purpose,
  challenge: string,
  now: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.webAuthnChallenge.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.webAuthnChallenge.create({
      data: {
        tenantId: await currentTenant(tx),
        userId,
        purpose,
        challenge,
        expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_LIFETIME_MS),
      },
    });
  });
}

/**
 * Takes the live challenge and marks it used in one conditional update, so two
 * concurrent responses cannot both claim it. Returns null when there is none.
 */
async function consumeChallenge(
  tenantId: string,
  userId: string,
  purpose: Purpose,
  now: Date,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.webAuthnChallenge.findFirst({
      where: { userId, purpose, consumedAt: null },
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await tx.webAuthnChallenge.update({
        where: { id: row.id },
        data: { consumedAt: now },
      });
      return null;
    }
    const claimed = await tx.webAuthnChallenge.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    return claimed.count === 1 ? row.challenge : null;
  });
}

export async function beginWebAuthnRegistration(
  tenantId: string,
  userId: string,
  rp: RelyingPartyIdentity,
  now: Date = new Date(),
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await withTenant(tenantId, (tx) =>
    tx.webAuthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    }),
  );

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: userId,
    // Registering a key the user already holds silently replaces it on some
    // authenticators; excluding them makes the browser say so instead.
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: row.transports as AuthenticatorTransportFuture[],
    })),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  await issueChallenge(tenantId, userId, 'register', options.challenge, now);
  return options;
}

export type RegistrationOutcome =
  | { ok: true; credentialId: string }
  | { ok: false; reason: string };

export async function finishWebAuthnRegistration(
  tenantId: string,
  userId: string,
  rp: RelyingPartyIdentity,
  label: string,
  response: RegistrationResponseJSON,
  now: Date = new Date(),
): Promise<RegistrationOutcome> {
  const challenge = await consumeChallenge(tenantId, userId, 'register', now);
  if (!challenge) return { ok: false, reason: 'webauthn_no_challenge' };

  // Outside any transaction: attestation verification is CBOR parsing,
  // signature checking and possibly a metadata lookup, and Prisma's
  // interactive transactions time out at 5000 ms.
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch {
    return { ok: false, reason: 'webauthn_registration_rejected' };
  }
  if (!verification.verified) {
    return { ok: false, reason: 'webauthn_registration_rejected' };
  }

  const { credential, fmt } = verification.registrationInfo;

  await withTenant(tenantId, async (tx) => {
    await tx.webAuthnCredential.create({
      data: {
        tenantId: await currentTenant(tx),
        userId,
        credentialId: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: (credential.transports ?? []) as string[],
        attestationType: fmt,
        rpId: rp.id,
        label,
      },
    });
  });

  return { ok: true, credentialId: credential.id };
}

export async function beginWebAuthnAuthentication(
  tenantId: string,
  userId: string,
  rp: RelyingParty,
  now: Date = new Date(),
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const credentials = await withTenant(tenantId, (tx) =>
    tx.webAuthnCredential.findMany({
      where: { userId, rpId: rp.id },
      select: { credentialId: true, transports: true },
    }),
  );

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: credentials.map((row) => ({
      id: row.credentialId,
      transports: row.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: 'preferred',
  });

  await issueChallenge(tenantId, userId, 'authenticate', options.challenge, now);
  return options;
}

export async function hasWebAuthn(tx: TenantClient, userId: string): Promise<boolean> {
  return (await tx.webAuthnCredential.count({ where: { userId } })) > 0;
}

export async function listWebAuthnCredentials(tx: TenantClient, userId: string) {
  return tx.webAuthnCredential.findMany({
    where: { userId },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function removeWebAuthnCredential(
  tx: TenantClient,
  userId: string,
  id: string,
): Promise<void> {
  await tx.webAuthnCredential.deleteMany({ where: { id, userId } });
}

function asAssertion(value: unknown): AuthenticationResponseJSON | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AuthenticationResponseJSON>;
  if (typeof candidate.id !== 'string') return null;
  if (!candidate.response || typeof candidate.response !== 'object') return null;
  const inner = candidate.response as Record<string, unknown>;
  if (typeof inner['clientDataJSON'] !== 'string') return null;
  if (typeof inner['authenticatorData'] !== 'string') return null;
  if (typeof inner['signature'] !== 'string') return null;
  return candidate as AuthenticationResponseJSON;
}

/**
 * The verifier the chokepoint consults.
 *
 * Three checks beyond the signature, all of which the specification calls for
 * and none of which the library can make on our behalf:
 *
 * - The credential was registered against the RP ID this request arrived on.
 *   Syntra picks a tenant from the Host header, so a credential enrolled at one
 *   tenant's hostname must not assert at another's.
 * - The signature counter strictly increases. A counter that stands still or
 *   goes backwards is how a cloned authenticator shows itself, and the library
 *   only enforces it when it is handed the stored value — which is why the
 *   stored value is passed in and the result is written back.
 * - The stored counter is advanced with a conditional update whose row count is
 *   checked, so two concurrent assertions cannot both be accepted.
 */
export function webauthnVerifier(): FactorVerifier {
  return {
    type: 'webauthn',
    // A user with no factor may add a passkey mid-sign-in when policy demands
    // one: most devices already have a platform authenticator built in.
    enrollable: true,

    async enrolled(tx, userId) {
      return hasWebAuthn(tx, userId);
    },

    async verify(tenantId, userId, presentation, context): Promise<FactorVerifyResult> {
      const { now, relyingParty: rp } = context;
      if (presentation.type !== 'webauthn') {
        return { ok: false, reason: 'webauthn_malformed' };
      }
      const assertion = asAssertion(presentation.assertion);
      if (!assertion) return { ok: false, reason: 'webauthn_malformed' };

      const row = await withTenant(tenantId, (tx) =>
        tx.webAuthnCredential.findFirst({
          where: { credentialId: assertion.id, userId },
        }),
      );
      if (!row) {
        // Consume the challenge anyway: an unknown credential id must not
        // leave a live challenge behind for a second guess.
        await consumeChallenge(tenantId, userId, 'authenticate', now);
        return { ok: false, reason: 'webauthn_unknown_credential' };
      }
      if (row.rpId !== rp.id) {
        await consumeChallenge(tenantId, userId, 'authenticate', now);
        return { ok: false, reason: 'webauthn_wrong_rp' };
      }

      const challenge = await consumeChallenge(tenantId, userId, 'authenticate', now);
      if (!challenge) return { ok: false, reason: 'webauthn_no_challenge' };

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: assertion,
          expectedChallenge: challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          credential: {
            id: row.credentialId,
            publicKey: new Uint8Array(row.publicKey),
            // The column is BigInt because counters are uint32; the library
            // wants a number. Exact well past uint32, so the conversion cannot
            // lose a step.
            counter: Number(row.counter),
            transports: row.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: false,
        });
      } catch (cause) {
        // The library throws rather than returning false when the counter does
        // not advance. Distinguishing that from a bad signature matters: one is
        // a typo-level failure, the other is evidence of a cloned key.
        const message = cause instanceof Error ? cause.message : '';
        if (message.includes('counter')) {
          return { ok: false, reason: 'webauthn_counter_regressed' };
        }
        return { ok: false, reason: 'webauthn_assertion_rejected' };
      }

      if (!verification.verified) {
        return { ok: false, reason: 'webauthn_assertion_rejected' };
      }

      const next = verification.authenticationInfo.newCounter;
      const stored = Number(row.counter);
      if (next <= stored && !(next === 0 && stored === 0)) {
        return { ok: false, reason: 'webauthn_counter_regressed' };
      }

      const advanced = await withTenant(tenantId, (tx) =>
        tx.webAuthnCredential.updateMany({
          where: { id: row.id, counter: { lt: BigInt(next) } },
          data: { counter: BigInt(next), lastUsedAt: now },
        }),
      );
      if (advanced.count !== 1 && next !== 0) {
        return { ok: false, reason: 'webauthn_counter_regressed' };
      }
      if (next === 0) {
        // An authenticator that does not implement a counter reports 0 forever.
        // There is no replay evidence to be had from it; record the use and
        // move on rather than refusing every assertion after the first.
        await withTenant(tenantId, (tx) =>
          tx.webAuthnCredential.update({
            where: { id: row.id },
            data: { lastUsedAt: now },
          }),
        );
      }

      return { ok: true };
    },
  };
}

export function installWebAuthnVerifier(): void {
  registerFactorVerifier(webauthnVerifier());
}
```

- [ ] **Step 6: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/auth/mfa/webauthn.test.ts`
Expected: PASS, 18 tests.

If the software authenticator's attestation object fails to parse, check the
CBOR byte-string header in `register()`: `0x59` introduces a two-byte length
and `authData` must be exactly that long.

- [ ] **Step 7: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './auth/mfa/webauthn.js';
```

`RelyingParty` and `RelyingPartyIdentity` are already exported from
`./auth/mfa/relying-party.js` by Task 4; do not re-export them here.

```bash
pnpm exec tsc -b
pnpm vitest run packages/core/src/auth
git add -A
git commit -m "feat: add WebAuthn registration and assertion verification"
```

---

## Task 7: Recovery codes

**Files:**
- Create: `packages/core/src/auth/mfa/recovery-codes.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/auth/mfa/recovery-codes.test.ts`

**Interfaces:**
- Consumes: from Task 4 — `FactorVerifier`, `registerFactorVerifier`.
- Produces:
  - `const RECOVERY_CODE_COUNT = 10`
  - `function generateRecoveryCodes(tx: TenantClient, userId: string): Promise<string[]>`
  - `function countUnusedRecoveryCodes(tx: TenantClient, userId: string): Promise<number>`
  - `function hasRecoveryCodesFor(tx: TenantClient, userId: string): Promise<boolean>`
  - `function removeRecoveryCodes(tx: TenantClient, userId: string): Promise<void>`
  - `function recoveryCodeVerifier(): FactorVerifier`
  - `function installRecoveryCodeVerifier(): void`

- [ ] **Step 1: Write the failing test**

`packages/core/src/auth/mfa/recovery-codes.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import {
  RECOVERY_CODE_COUNT,
  countUnusedRecoveryCodes,
  generateRecoveryCodes,
  hasRecoveryCodesFor,
  recoveryCodeVerifier,
  removeRecoveryCodes,
} from './recovery-codes.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const generate = () =>
  withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));

const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

const use = (code: string) =>
  recoveryCodeVerifier().verify(
    tenantId,
    userId,
    { type: 'recovery_code', code },
    { now: new Date(), relyingParty: RP },
  );

describe('generateRecoveryCodes', () => {
  it('returns ten distinct codes', async () => {
    const codes = await generate();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('uses an unambiguous alphabet and a readable shape', async () => {
    for (const code of await generate()) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('stores hashes, never the codes', async () => {
    const codes = await generate();
    const rows = await withTenant(tenantId, (tx) => tx.recoveryCode.findMany());
    const stored = JSON.stringify(rows);
    for (const code of codes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace('-', ''));
    }
  });

  it('replaces the previous set rather than adding to it', async () => {
    const first = await generate();
    await generate();
    expect(await withTenant(tenantId, (tx) => countUnusedRecoveryCodes(tx, userId))).toBe(
      RECOVERY_CODE_COUNT,
    );
    expect(await use(first[0]!)).toEqual({ ok: false, reason: 'recovery_code_invalid' });
  });
});

describe('recoveryCodeVerifier', () => {
  it('accepts a code once', async () => {
    const codes = await generate();
    expect(await use(codes[0]!)).toEqual({ ok: true });
    expect(await withTenant(tenantId, (tx) => countUnusedRecoveryCodes(tx, userId))).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });

  it('refuses the same code twice', async () => {
    const codes = await generate();
    await use(codes[0]!);
    expect(await use(codes[0]!)).toEqual({ ok: false, reason: 'recovery_code_used' });
  });

  it('accepts a code typed in lower case with spaces', async () => {
    const codes = await generate();
    const messy = ` ${codes[0]!.toLowerCase()} `;
    expect(await use(messy)).toEqual({ ok: true });
  });

  it('accepts a code typed without the separator', async () => {
    const codes = await generate();
    expect(await use(codes[0]!.replace('-', ''))).toEqual({ ok: true });
  });

  it('refuses a code that was never issued', async () => {
    await generate();
    expect(await use('ZZZZZ-ZZZZZ')).toEqual({ ok: false, reason: 'recovery_code_invalid' });
  });

  it('refuses when the user has no codes at all', async () => {
    expect(await use('ZZZZZ-ZZZZZ')).toEqual({ ok: false, reason: 'recovery_code_invalid' });
  });

  it('lets exactly one of two concurrent uses of the same code succeed', async () => {
    const codes = await generate();
    const [a, b] = await Promise.all([use(codes[0]!), use(codes[0]!)]);
    const outcomes = [a.ok, b.ok].sort();
    expect(outcomes).toEqual([false, true]);
    expect(await withTenant(tenantId, (tx) => countUnusedRecoveryCodes(tx, userId))).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });
});

describe('hasRecoveryCodesFor / removeRecoveryCodes', () => {
  it('reports false once every code is spent', async () => {
    const codes = await generate();
    for (const code of codes) await use(code);
    expect(await withTenant(tenantId, (tx) => hasRecoveryCodesFor(tx, userId))).toBe(false);
  });

  it('removes every code, spent or not', async () => {
    await generate();
    await withTenant(tenantId, (tx) => removeRecoveryCodes(tx, userId));
    expect(await withTenant(tenantId, (tx) => tx.recoveryCode.count())).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/auth/mfa/recovery-codes.test.ts`
Expected: FAIL — cannot resolve `./recovery-codes.js`.

- [ ] **Step 3: Implement recovery codes**

`packages/core/src/auth/mfa/recovery-codes.ts`:

```ts
import { createHash, randomInt } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { registerFactorVerifier } from './registry.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

export const RECOVERY_CODE_COUNT = 10;

/** Crockford-style: no I, L, O, U, 0 or 1, so a handwritten code reads back. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP = 5;

/**
 * SHA-256, not Argon2id.
 *
 * A recovery code is fifty bits of uniformly random data from a
 * cryptographically secure source, so there is no dictionary to run against it
 * and no password-reuse risk to blunt; the slow hash buys nothing and would
 * cost ten Argon2 verifications per attempt. A password is the opposite case,
 * which is why password.ts uses Argon2id.
 */
const hashCode = (normalised: string) =>
  createHash('sha256').update(normalised).digest('hex');

/** Uppercase, separators and spaces stripped: what the user typed is not the point. */
const normalise = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

function makeCode(): string {
  let out = '';
  for (let i = 0; i < GROUP * 2; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${out.slice(0, GROUP)}-${out.slice(GROUP)}`;
}

/**
 * Issues a fresh set and discards the previous one. Returned in the clear
 * exactly once — the database holds only digests, so a lost sheet of codes is
 * regenerated, never recovered.
 */
export async function generateRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<string[]> {
  const tenantId = await currentTenant(tx);
  await tx.recoveryCode.deleteMany({ where: { userId } });

  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < RECOVERY_CODE_COUNT) {
    const code = makeCode();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  await tx.recoveryCode.createMany({
    data: codes.map((code) => ({
      tenantId,
      userId,
      codeHash: hashCode(normalise(code)),
    })),
  });

  return codes;
}

export async function countUnusedRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<number> {
  return tx.recoveryCode.count({ where: { userId, usedAt: null } });
}

export async function hasRecoveryCodesFor(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  return (await countUnusedRecoveryCodes(tx, userId)) > 0;
}

export async function removeRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.recoveryCode.deleteMany({ where: { userId } });
}

/**
 * Consumption is one conditional UPDATE whose row count is checked. Reading the
 * row and then writing it would let two requests presenting the same code both
 * find it unused; this way the second one updates zero rows and is refused,
 * because PostgreSQL serialises the two updates on the row lock and the second
 * re-evaluates `usedAt IS NULL` after the first commits.
 */
export function recoveryCodeVerifier(): FactorVerifier {
  return {
    type: 'recovery_code',
    // Deliberately not enrollable. A recovery code is the fallback you generate
    // once you already hold a real factor; offering it as the way to satisfy a
    // require_mfa rule would let a user answer "prove you have a second factor"
    // by printing themselves one.
    enrollable: false,

    async enrolled(tx, userId) {
      return hasRecoveryCodesFor(tx, userId);
    },

    async verify(tenantId, userId, presentation, context): Promise<FactorVerifyResult> {
      const { now } = context;
      if (presentation.type !== 'recovery_code') {
        return { ok: false, reason: 'recovery_code_invalid' };
      }
      const codeHash = hashCode(normalise(presentation.code));

      return withTenant(tenantId, async (tx) => {
        const claimed = await tx.recoveryCode.updateMany({
          where: { userId, codeHash, usedAt: null },
          data: { usedAt: now },
        });
        if (claimed.count === 1) return { ok: true };

        // Distinguish "wrong code" from "already spent" for the audit log only.
        // Both answer the user identically, one level up.
        const exists = await tx.recoveryCode.count({ where: { userId, codeHash } });
        return {
          ok: false,
          reason: exists > 0 ? 'recovery_code_used' : 'recovery_code_invalid',
        };
      });
    },
  };
}

export function installRecoveryCodeVerifier(): void {
  registerFactorVerifier(recoveryCodeVerifier());
}
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/auth/mfa/recovery-codes.test.ts`
Expected: PASS, 13 tests.

If "lets exactly one of two concurrent uses succeed" is flaky, the check is
reading before writing somewhere. It must be a single `updateMany` with
`usedAt: null` in the `where`.

- [ ] **Step 5: Prove a recovery code satisfies require_mfa but not require_factor**

Append to `packages/core/src/auth/authorize.test.ts`:

```ts
import { generateRecoveryCodes, installRecoveryCodeVerifier } from './mfa/recovery-codes.js';

describe('authorize — recovery codes', () => {
  // Only recovery codes are installed here, so nothing is enrollable and the
  // fallback branch is exercised rather than forced enrolment.
  beforeEach(() => installRecoveryCodeVerifier());

  it('satisfies require_mfa', async () => {
    const codes = await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const challenge = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(challenge.status).toBe('challenge');
    if (challenge.status !== 'challenge') throw new Error('expected a challenge');

    const allowed = await authorize(tenantId, {
      kind: 'continue',
      attemptToken: challenge.attemptToken,
      factor: { type: 'recovery_code', code: codes[0]! },
      sourceIp: null,
      relyingParty: RP,
      now: NOW,
    });
    expect(allowed).toMatchObject({ status: 'allow', satisfiedFactor: 'recovery_code' });
  });

  it('does not satisfy a rule that names WebAuthn', async () => {
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await withTenant(tenantId, (tx) =>
      addRule(tx, { name: 'Keys only', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    // A printed code is not a hardware key, and a rule that asks for one is not
    // satisfied by the other. Recovery codes are not enrollable either, so
    // there is nothing to offer and the answer is an honest refusal.
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });

  it('is never offered as the way to satisfy a forced enrolment', async () => {
    // The user holds no recovery codes and no factor. A require_mfa rule must
    // not answer "generate yourself some codes" — that would let a user prove
    // possession of a second factor by printing one.
    await withTenant(tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const result = await authorize(tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
      applicationId: null,
      sourceIp: null,
      relyingParty: RP,
      scope: 'portal',
      now: NOW,
    });
    expect(result).toEqual({ status: 'deny', reason: 'factor_not_enrolled' });
  });
});
```

- [ ] **Step 6: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './auth/mfa/recovery-codes.js';
```

```bash
pnpm exec tsc -b
pnpm vitest run packages/core/src/auth
git add -A
git commit -m "feat: add single-use hashed recovery codes"
```

---

## Task 8: The MFA HTTP surface

**Files:**
- Create: `packages/contracts/src/mfa.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/mfa.ts`
- Modify: `packages/core/src/notify/notification-service.ts` — replace `notify` with `renderMessage` + `sendMessage`
- Modify: `packages/core/src/notify/notification-service.test.ts`
- Modify: `packages/core/src/notify/templates/index.ts` — `factor-added`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/routes/admin/users.ts` — remove a user's factor
- Test: `apps/api/src/routes/mfa.test.ts`

**Interfaces:**
- Consumes: from Tasks 4–7 — `authorize`, `tenantRelyingParty` and `assertWebAuthnUsable` (Task 4, `apps/api/src/routes/relying-party.ts`), `beginTotpEnrolment`, `confirmTotpEnrolment`, `hasTotp`, `removeTotp`, `installTotpVerifier`, `beginWebAuthnRegistration`, `finishWebAuthnRegistration`, `beginWebAuthnAuthentication`, `listWebAuthnCredentials`, `removeWebAuthnCredential`, `installWebAuthnVerifier`, `generateRecoveryCodes`, `countUnusedRecoveryCodes`, `removeRecoveryCodes`, `installRecoveryCodeVerifier`, `RelyingPartyIdentity`, `findAttempt`. From the existing codebase — `requireSession`, `requirePermission`, `ProblemError`, `createSession`, `recordEvent`, `PERMISSIONS`.
- Produces:
  - Zod schemas `totpConfirmRequest`, `webauthnRegisterRequest`, `mfaVerifyRequest`, `webauthnChallengeRequest`, `mfaStatusResponse`, `adminFactorParams`
  - Routes under `/api/auth/mfa` and `/api/admin`
  - `function renderMessage(tenantName: string, template: TemplateName, to: string, vars: Record<string, string>): OutboundMessage` and `function sendMessage(transport: Transport, message: OutboundMessage): Promise<void>`, replacing `notify`
  - the `factor-added` template
  - `async function webauthnContext(request, publicUrl): Promise<{ rp: RelyingPartyIdentity }>` — reads the tenant, derives its relying party and refuses a mismatched `Host`

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/mfa.ts`:

```ts
import { z } from 'zod';

export const factorType = z.enum(['totp', 'webauthn']);
export const presentedFactorType = z.enum(['totp', 'webauthn', 'recovery_code']);

export const totpConfirmRequest = z.object({
  code: z.string().min(6).max(6),
});
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequest>;

export const webauthnRegisterRequest = z.object({
  label: z.string().min(1).max(64).default('Security key'),
  // The browser's RegistrationResponseJSON. Its shape is the WebAuthn
  // specification's, not ours, and @simplewebauthn/server validates it far more
  // thoroughly than a zod object could; re-declaring it here would only drift.
  response: z.record(z.unknown()),
});
export type WebauthnRegisterRequest = z.input<typeof webauthnRegisterRequest>;

export const webauthnCredentialRemoveParams = z.object({
  credentialId: z.string().uuid(),
});

/**
 * The second half of a sign-in. Exactly one factor field is present, matched to
 * `type`, so a caller cannot send a TOTP code and hope it satisfies a WebAuthn
 * requirement.
 */
export const mfaVerifyRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('totp'),
    attemptToken: z.string().min(1).max(256),
    code: z.string().min(6).max(6),
  }),
  z.object({
    type: z.literal('recovery_code'),
    attemptToken: z.string().min(1).max(256),
    code: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal('webauthn'),
    attemptToken: z.string().min(1).max(256),
    assertion: z.record(z.unknown()),
  }),
]);
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequest>;

export const webauthnChallengeRequest = z.object({
  attemptToken: z.string().min(1).max(256),
});

export const mfaStatusResponse = z.object({
  totp: z.object({ enrolled: z.boolean() }),
  webauthn: z.object({
    credentials: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        createdAt: z.string(),
        lastUsedAt: z.string().nullable(),
      }),
    ),
  }),
  recoveryCodes: z.object({ remaining: z.number() }),
});
export type MfaStatusResponse = z.infer<typeof mfaStatusResponse>;

export const adminFactorParams = z.object({
  id: z.string().uuid(),
  type: presentedFactorType,
});
```

Add `export * from './mfa.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing route test**

`apps/api/src/routes/mfa.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  addRule,
  assignRole,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  createRole,
  createUser,
  generateRecoveryCodes,
  localMasterKeyProvider,
  setPassword,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;

const PASSWORD = 'correct horse battery staple';

/** The same master key buildTestApp configures, so the vault round-trips. */
const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

async function seedUser(opts: { admin?: boolean } = {}) {
  const user = await withTenant(ctx.tenantId, async (tx) => {
    const created = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, created.id, PASSWORD);
    if (opts.admin) {
      const role = await createRole(tx, 'Owner', [
        PERMISSIONS.DIRECTORY_READ,
        PERMISSIONS.DIRECTORY_WRITE,
      ]);
      await assignRole(tx, created.id, role.id);
    }
    return created;
  });
  userId = user.id;
  return user;
}

const login = (password = PASSWORD) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'jdoe', password },
  });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'syntra_session')?.value;

async function portalCookie() {
  const res = await login();
  return cookieOf(res)!;
}

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
) =>
  ctx.app.inject({
    method,
    url,
    headers: {
      host: ctx.host,
      ...(opts.cookie ? { cookie: `syntra_session=${opts.cookie}` } : {}),
    },
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
  });

describe('TOTP enrolment over HTTP', () => {
  it('refuses without a session', async () => {
    await seedUser();
    const res = await call('POST', '/api/auth/mfa/totp/begin');
    expect(res.statusCode).toBe(401);
  });

  it('returns a secret and a QR image exactly once', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const res = await call('POST', '/api/auth/mfa/totp/begin', { cookie });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.qr).toMatch(/^data:image\/gif;base64,/);
  });

  it('confirms with a valid code and reports enrolment', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(begin.json().secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });

    const confirm = await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: { code },
    });
    expect(confirm.statusCode).toBe(204);

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.json().totp.enrolled).toBe(true);
  });

  it('refuses a wrong confirmation code', async () => {
    await seedUser();
    const cookie = await portalCookie();
    await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    const confirm = await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: { code: '000000' },
    });
    expect(confirm.statusCode).toBe(400);
  });

  it('never shows the secret again after enrolment', async () => {
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    const secret = begin.json().secret;
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });
    await call('POST', '/api/auth/mfa/totp/confirm', { cookie, payload: { code } });

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.body).not.toContain(secret);
  });
});

describe('the step-up round trip', () => {
  /**
   * Enrols through the core service at a timestamp two minutes in the past,
   * not through HTTP at wall time.
   *
   * `confirmTotpEnrolment` sets the replay watermark to the counter step that
   * confirmed the enrolment — which is the point, since it stops the enrolment
   * code being replayed as a login. An HTTP enrolment followed immediately by
   * an HTTP sign-in lands in that same thirty-second step, so a correct code is
   * correctly refused and the test fails for a reason unrelated to what it is
   * testing. Backdating the confirmation puts the watermark four steps behind,
   * which makes the test deterministic rather than dependent on where in the
   * half-minute it happened to run.
   */
  async function enrolTotp(): Promise<string> {
    const past = new Date(Date.now() - 120_000);
    const enrolment = await withTenant(ctx.tenantId, (tx) =>
      beginTotpEnrolment(tx, provider, userId),
    );
    const ok = await confirmTotpEnrolment(
      ctx.tenantId,
      provider,
      userId,
      OTPAuth.TOTP.generate({
        secret: OTPAuth.Secret.fromBase32(enrolment.secret),
        period: 30,
        digits: 6,
        algorithm: 'SHA1',
        timestamp: past.getTime(),
      }),
      past,
    );
    expect(ok).toBe(true);
    return enrolment.secret;
  }

  it('answers a login with a challenge and no cookie, then a session on verify', async () => {
    await seedUser();
    const secret = await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

    const challenge = await login();
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
    });
    expect(cookieOf(challenge)).toBeUndefined();

    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });
    const verified = await call('POST', '/api/auth/mfa/verify', {
      payload: { type: 'totp', attemptToken: challenge.json().attemptToken, code },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: 'authenticated', scope: 'portal' });
    expect(cookieOf(verified)).toBeDefined();
  });

  it('never returns the attempt token in the verified response', async () => {
    await seedUser();
    const secret = await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const challenge = await login();
    const token = challenge.json().attemptToken;
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });
    const verified = await call('POST', '/api/auth/mfa/verify', {
      payload: { type: 'totp', attemptToken: token, code },
    });
    expect(verified.body).not.toContain(token);
  });

  it('answers a bad code with 401 and no cookie', async () => {
    await seedUser();
    await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const challenge = await login();

    const verified = await call('POST', '/api/auth/mfa/verify', {
      payload: {
        type: 'totp',
        attemptToken: challenge.json().attemptToken,
        code: '000000',
      },
    });
    expect(verified.statusCode).toBe(401);
    expect(cookieOf(verified)).toBeUndefined();
  });

  it('answers an unknown attempt token identically to a bad code', async () => {
    await seedUser();
    await enrolTotp();
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));
    const challenge = await login();

    const badCode = await call('POST', '/api/auth/mfa/verify', {
      payload: {
        type: 'totp',
        attemptToken: challenge.json().attemptToken,
        code: '000000',
      },
    });
    const badToken = await call('POST', '/api/auth/mfa/verify', {
      payload: { type: 'totp', attemptToken: 'nope', code: '000000' },
    });
    expect(badToken.statusCode).toBe(badCode.statusCode);
    expect(badToken.json()).toEqual(badCode.json());
  });
});

describe('recovery codes over HTTP', () => {
  /** Recovery codes need a real factor to be a fallback for. */
  async function withAFactor() {
    await seedUser();
    const past = new Date(Date.now() - 120_000);
    const enrolment = await withTenant(ctx.tenantId, (tx) =>
      beginTotpEnrolment(tx, provider, userId),
    );
    await confirmTotpEnrolment(
      ctx.tenantId,
      provider,
      userId,
      OTPAuth.TOTP.generate({
        secret: OTPAuth.Secret.fromBase32(enrolment.secret),
        period: 30,
        digits: 6,
        algorithm: 'SHA1',
        timestamp: past.getTime(),
      }),
      past,
    );
    return portalCookie();
  }

  it('refuses a user who holds no other factor', async () => {
    // Otherwise a user with nothing mints ten codes today, and a require_mfa
    // rule saved next month is satisfied by a printed code forever — the
    // forced-enrolment path is never reached and the rule buys the tenant
    // nothing.
    await seedUser();
    const cookie = await portalCookie();
    const res = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });
    expect(res.statusCode).toBe(409);
    expect(await withTenant(ctx.tenantId, (tx) => tx.recoveryCode.count())).toBe(0);
  });

  it('issues ten codes and reports the remaining count', async () => {
    const cookie = await withAFactor();
    const res = await call('POST', '/api/auth/mfa/recovery-codes', { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().codes).toHaveLength(10);

    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.json().recoveryCodes.remaining).toBe(10);
  });

  it('never returns the codes again', async () => {
    const cookie = await withAFactor();
    const codes = (await call('POST', '/api/auth/mfa/recovery-codes', { cookie })).json().codes;
    const status = await call('GET', '/api/auth/mfa', { cookie });
    expect(status.body).not.toContain(codes[0]);
  });

  it('mails the account owner when a factor is added', async () => {
    // The only control that reaches the person who can tell a legitimate
    // enrolment from an attacker's, and the reason it is unconditional: a
    // factor added with a stolen password survives the password reset that
    // would otherwise fix things.
    await seedUser();
    const cookie = await portalCookie();
    const begin = await call('POST', '/api/auth/mfa/totp/begin', { cookie });
    await call('POST', '/api/auth/mfa/totp/confirm', {
      cookie,
      payload: {
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(begin.json().secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });

    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0]!.to).toBe('j@acme.test');
    expect(ctx.mail.sent[0]!.subject).toContain('second factor');
  });
});

describe('administrative factor removal', () => {
  it('removes a user factor and writes an audit event', async () => {
    const admin = await seedUser({ admin: true });
    const cookie = await portalCookie();
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, admin.id));

    const elevated = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    const adminCookie = cookieOf(elevated)!;

    const res = await call('DELETE', `/api/admin/users/${admin.id}/factors/recovery_code`, {
      cookie: adminCookie,
    });
    expect(res.statusCode).toBe(204);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'mfa.removed' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('refuses a portal session', async () => {
    const user = await seedUser();
    const cookie = await portalCookie();
    const res = await call('DELETE', `/api/admin/users/${user.id}/factors/totp`, { cookie });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run apps/api/src/routes/mfa.test.ts`
Expected: FAIL — 404 on every MFA route.

- [ ] **Step 4: Split the notification service so a send cannot sit in a transaction**

`notify(tx, transport, …)` reads the tenant row and then awaits
`transport.send()`. Every call from inside `withTenant` therefore puts an SMTP
round trip inside `prisma.$transaction`, under the 5000 ms default — the exact
Critical the previous slice shipped. This task is the first caller, so the trap
is removed here rather than worked around.

Replace `notify` in `packages/core/src/notify/notification-service.ts`:

```ts
/**
 * Renders a message. Pure: no database, no transport, no clock.
 *
 * The tenant name is a parameter rather than something read from a
 * transaction, which is what makes this safe to call anywhere — and what stops
 * the send being dragged inside a transaction along with the read.
 */
export function renderMessage(
  tenantName: string,
  template: TemplateName,
  to: string,
  vars: Record<string, string>,
): OutboundMessage {
  const definition = TEMPLATES[template];
  if (!definition) {
    throw new Error(`unknown template: ${template}`);
  }

  const all = { ...vars, tenantName };
  return {
    to,
    subject: render(definition.subject, all, false),
    text: render(definition.text, all, false),
    // Only the HTML part is escaped; escaping the text part would show the
    // reader a literal &amp; instead of an ampersand.
    html: render(definition.html, all, true),
  };
}

/**
 * Sends a rendered message.
 *
 * Takes no transaction, and therefore cannot be given one. That is the whole
 * design: the previous signature accepted a `TenantClient`, which made
 * `withTenant(tx => notify(tx, …))` look like the obvious way to call it.
 */
export async function sendMessage(
  transport: Transport,
  message: OutboundMessage,
): Promise<void> {
  await transport.send(message);
}
```

Delete `notify` and its `TenantClient` and `currentTenant` imports. Rewrite
`packages/core/src/notify/notification-service.test.ts` against the pair — the
tenant name is now passed in, so most of its cases stop needing `withTenant` at
all:

```ts
it('renders the tenant name into the message', () => {
  const message = renderMessage('Acme Care', 'welcome', 'jo@acme.test', {
    displayName: 'Jo',
  });
  expect(message.subject).toContain('Acme Care');
  expect(message.text).toContain('Jo');
  expect(message.to).toBe('jo@acme.test');
});

it('escapes html in a variable so a display name cannot inject markup', () => {
  const message = renderMessage('Acme Care', 'welcome', 'jo@acme.test', {
    displayName: '<script>alert(1)</script>',
  });
  expect(message.html).not.toContain('<script>');
  expect(message.html).toContain('&lt;script&gt;');
});

it('refuses an unknown template', () => {
  expect(() => renderMessage('Acme Care', 'nope' as never, 'jo@acme.test', {})).toThrow(
    /unknown template/,
  );
});

it('sends what it was given', async () => {
  const transport = memoryTransport();
  await sendMessage(transport, renderMessage('Acme Care', 'welcome', 'jo@acme.test', {}));
  expect(transport.sent).toHaveLength(1);
});
```

The per-tenant case that used two tenants keeps its `withTenant` calls to read
the two names, and asserts the two rendered subjects differ.

Then add the template Ruling H requires, in
`packages/core/src/notify/templates/index.ts`:

```ts
  'factor-added': {
    subject: 'A second factor was added to your {{tenantName}} account',
    text: 'Hello {{displayName}},\n\nA {{factor}} was added to your account on {{when}}, from {{sourceIp}}.\n\nIf that was you, nothing further is needed. If it was not, contact your administrator immediately and change your password — a second factor added by someone else survives a password change, so the factor has to be removed too.',
    html: '<p>Hello {{displayName}},</p><p>A <strong>{{factor}}</strong> was added to your account on {{when}}, from {{sourceIp}}.</p><p>If that was you, nothing further is needed. If it was not, contact your administrator immediately and change your password — a second factor added by someone else survives a password change, so the factor has to be removed too.</p>',
  },
```

This is the only control that reaches the one person who can tell a legitimate
enrolment from an attacker's. The audit event stays, but an audit row nobody
reads does not discharge the obligation, and the sentence about surviving a
password change is the part that makes the mail actionable.

- [ ] **Step 5: Add the QR dependency**

```bash
pnpm --filter @syntra/api add @nuintun/qrcode@5.0.3
```

`@nuintun/qrcode` is the QR encoder: pure TypeScript, no native build, one
runtime dependency, and it renders straight to a data URL. The alternative,
`qrcode`, pulls `yargs` into a server dependency tree for the sake of a CLI
nobody here runs.

- [ ] **Step 6: Implement the routes**

`apps/api/src/routes/mfa.ts`:

```ts
import { Byte, Encoder } from '@nuintun/qrcode';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  mfaVerifyRequest,
  totpConfirmRequest,
  webauthnChallengeRequest,
  webauthnCredentialRemoveParams,
  webauthnRegisterRequest,
} from '@syntra/contracts';
import {
  authorize,
  beginTotpEnrolment,
  beginWebAuthnAuthentication,
  beginWebAuthnRegistration,
  confirmTotpEnrolment,
  countUnusedRecoveryCodes,
  createSession,
  finishWebAuthnRegistration,
  findAttempt,
  generateRecoveryCodes,
  hasTotp,
  listWebAuthnCredentials,
  localMasterKeyProvider,
  permissionsForUser,
  recordEvent,
  removeWebAuthnCredential,
  type RelyingPartyIdentity,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession, SESSION_COOKIE } from '../plugins/require-session.js';
import { assertWebAuthnUsable, tenantRelyingParty } from './relying-party.js';

export interface MfaRouteOptions {
  masterKey: Buffer;
  publicUrl: string;
  authRateLimitMax: number;
  transport: Transport;
}

const SECURE = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: SECURE,
};

/**
 * Reads the tenant, derives its relying party, and refuses if this request did
 * not arrive on the tenant's own host.
 *
 * One helper rather than three call sites doing it by hand: every WebAuthn
 * endpoint needs the same three things in the same order, and a site that
 * forgot `assertWebAuthnUsable` would be a phishable endpoint that looked
 * exactly like the others.
 */
async function webauthnContext(
  request: FastifyRequest,
  publicUrl: string,
): Promise<{ rp: RelyingPartyIdentity }> {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const rp = tenantRelyingParty(tenant, publicUrl);
  assertWebAuthnUsable(request, tenant, rp);
  // Registration also wants a display name for the browser prompt;
  // verification does not.
  return { rp: { ...rp, name: tenant.name } };
}

/**
 * Tells the account owner a factor was added.
 *
 * Rendered and sent outside every transaction. Ruling H makes this
 * unconditional rather than reserved for forced enrolment: the plan already
 * mails on a password change, and a factor added by a stolen password is the
 * more serious of the two, because it survives the password reset that would
 * otherwise fix things.
 *
 * Module scope, and the transport is a parameter rather than a closure over
 * `options`, because the forced-enrolment router in Task 9 calls it too and is
 * registered separately.
 */
export async function tellOwnerAFactorWasAdded(
  request: FastifyRequest,
  transport: Transport,
  userId: string,
  factor: string,
): Promise<void> {
  const { user, tenantName } = await request.db(async (tx) => ({
    user: await tx.user.findUnique({ where: { id: userId } }),
    tenantName: (await tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }))
      .name,
  }));
  if (!user) return;

  const message = renderMessage(tenantName, 'factor-added', user.email, {
    displayName: user.displayName,
    factor,
    when: new Date().toISOString(),
    sourceIp: request.ip,
  });
  await sendMessage(transport, message);
}

const qrDataUrl = (text: string) =>
  new Encoder({ level: 'M' }).encode(new Byte(text)).toDataURL(4, { margin: 8 });

export async function registerMfaRoutes(
  app: FastifyInstance,
  options: MfaRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);
  const LIMIT = {
    rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
  };

  async function sessionBody(
    request: FastifyRequest,
    userId: string,
    scope: SessionScope,
  ) {
    const user = await request.db((tx) => tx.user.findUnique({ where: { id: userId } }));
    const permissions = await request.db((tx) => permissionsForUser(tx, userId));
    return {
      status: 'authenticated' as const,
      userId,
      displayName: user?.displayName ?? '',
      scope,
      mayElevate: permissions.size > 0,
      permissions: [...permissions],
    };
  }

  // ---- The step-up half of a sign-in. No session yet, so no session guard.

  app.post('/verify', { config: LIMIT }, async (request, reply) => {
    const body = mfaVerifyRequest.parse(request.body);

    const factor =
      body.type === 'webauthn'
        ? ({ type: 'webauthn', assertion: body.assertion } as const)
        : ({ type: body.type, code: body.code } as const);

    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );

    const result = await authorize(request.tenantId, {
      kind: 'continue',
      attemptToken: body.attemptToken,
      factor,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
    });

    if (result.status === 'deny') {
      // One refusal is named, because the user is looking at a code that is
      // arithmetically correct and needs to be told why it was not taken. It
      // is safe to distinguish here and nowhere else: reaching this point
      // required a valid attempt token, which only exists after primary
      // authentication has already succeeded.
      if (result.reason === 'factor_used_for_enrolment') {
        throw new ProblemError(
          400,
          'code-already-used-for-setup',
          'That code completed your setup',
          'It cannot be used again to sign in. Wait for your app to show the next code.',
        );
      }
      // Everything else collapses into one response. A bad code, an unknown
      // attempt token and an expired one read identically, so nothing tells an
      // attacker which half to work on.
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    // The factor was accepted and the policy now wants something else — which
    // only happens when a rule tightened while the user was reaching for their
    // phone. Hand the new demand back rather than issuing a session.
    if (result.status === 'challenge') {
      return reply.status(200).send({
        status: 'challenge',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        acceptableFactors: result.acceptableFactors,
      });
    }
    if (result.status === 'enrol') {
      return reply.status(200).send({
        status: 'enrol',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        enrollableFactors: result.enrollableFactors,
      });
    }

    // The scope comes off the attempt, which recorded what its issuer meant.
    // Never from whether this request happened to carry a cookie — the web
    // client sends one on every call, so that inference hands an
    // administrative session to any portal user completing a step-up.
    const { token } = await request.db((tx) =>
      createSession(tx, result.userId, result.scope, result.satisfiedFactor),
    );
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);
    return sessionBody(request, result.userId, result.scope);
  });

  /**
   * A WebAuthn step-up needs a challenge before the browser can sign anything,
   * and the caller holds an attempt token rather than a session. The attempt is
   * read but not consumed, so a user who cancels the browser prompt can try
   * again.
   */
  app.post('/webauthn/challenge', { config: LIMIT }, async (request) => {
    const body = webauthnChallengeRequest.parse(request.body);
    const attempt = await request.db((tx) =>
      findAttempt(tx, body.attemptToken, new Date()),
    );
    if (!attempt || attempt.purpose !== 'verify') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    const { rp } = await webauthnContext(request, options.publicUrl);
    return beginWebAuthnAuthentication(request.tenantId, attempt.userId, rp);
  });

  // ---- Enrolment by a user who is already signed in. Everything below needs
  // a live session; Task 9 adds the same operations under an enrolment attempt
  // for a user who is not signed in yet.

  app.register(async (secured) => {
    secured.addHook('preHandler', requireSession('portal'));

    secured.get('/', async (request) => {
      const { userId } = request.session;
      const totp = await request.db((tx) => hasTotp(tx, userId));
      const credentials = await request.db((tx) => listWebAuthnCredentials(tx, userId));
      const remaining = await request.db((tx) => countUnusedRecoveryCodes(tx, userId));

      // Whether a security key can be registered here at all, so the screen can
      // say why the button is disabled instead of offering an action that
      // always fails.
      let webauthnAvailable = true;
      let webauthnUnavailableReason: string | null = null;
      try {
        await webauthnContext(request, options.publicUrl);
      } catch (cause) {
        webauthnAvailable = false;
        webauthnUnavailableReason =
          cause instanceof ProblemError ? (cause.detail ?? cause.title) : null;
      }

      return {
        totp: { enrolled: totp },
        webauthn: {
          available: webauthnAvailable,
          unavailableReason: webauthnUnavailableReason,
          credentials: credentials.map((c) => ({
            id: c.id,
            label: c.label,
            createdAt: c.createdAt.toISOString(),
            lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
          })),
        },
        recoveryCodes: { remaining },
      };
    });

    secured.post('/totp/begin', { config: LIMIT }, async (request) => {
      // beginTotpEnrolment throws when a *confirmed* credential already
      // exists. That is a conflict the caller can act on — remove the old one
      // first — not a server fault, and a 500 here would also print a stack
      // trace into the log for an ordinary double-click.
      const enrolment = await request.db(async (tx) => {
        if (await hasTotp(tx, request.session.userId)) {
          throw new ProblemError(
            409,
            'already-enrolled',
            'An authenticator app is already set up',
            'Remove the existing one before setting up another.',
          );
        }
        return beginTotpEnrolment(tx, provider, request.session.userId);
      });
      // QR encoding happens outside the transaction above: it is pure CPU work
      // and has no business inside Prisma's 5000 ms transaction budget.
      return { ...enrolment, qr: qrDataUrl(enrolment.uri) };
    });

    secured.post('/totp/confirm', { config: LIMIT }, async (request, reply) => {
      const body = totpConfirmRequest.parse(request.body);
      const ok = await confirmTotpEnrolment(
        request.tenantId,
        provider,
        request.session.userId,
        body.code,
      );
      if (!ok) {
        throw new ProblemError(400, 'invalid-code', 'That code did not match');
      }
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.enrolled',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { factor: 'totp', underForcedEnrolment: false },
        }),
      );
      // Outside every transaction above, and awaited so a mail failure is
      // logged rather than becoming an unhandled rejection.
      await tellOwnerAFactorWasAdded(
        request,
        options.transport,
        request.session.userId,
        'authenticator app',
      );
      return reply.status(204).send();
    });

    secured.post('/webauthn/begin', { config: LIMIT }, async (request) => {
      const { rp } = await webauthnContext(request, options.publicUrl);
      return beginWebAuthnRegistration(request.tenantId, request.session.userId, rp);
    });

    secured.post('/webauthn/finish', { config: LIMIT }, async (request, reply) => {
      const body = webauthnRegisterRequest.parse(request.body);
      const { rp } = await webauthnContext(request, options.publicUrl);
      const outcome = await finishWebAuthnRegistration(
        request.tenantId,
        request.session.userId,
        rp,
        body.label,
        body.response as never,
      );
      if (!outcome.ok) {
        // The reason is recorded rather than dropped: a rejected registration
        // that leaves no trace is a support call with nothing to look at.
        await request.db((tx) =>
          recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'mfa.enrol_failed',
            targetType: 'User',
            targetId: request.session.userId,
            outcome: 'failure',
            sourceIp: request.ip,
            payload: { factor: 'webauthn', reason: outcome.reason },
          }),
        );
        throw new ProblemError(400, 'registration-rejected', 'That security key was not accepted');
      }
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.enrolled',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            factor: 'webauthn',
            label: body.label,
            underForcedEnrolment: false,
          },
        }),
      );
      await tellOwnerAFactorWasAdded(
        request,
        options.transport,
        request.session.userId,
        'security key',
      );
      return reply.status(204).send();
    });

    secured.delete('/webauthn/:credentialId', async (request, reply) => {
      const { credentialId } = webauthnCredentialRemoveParams.parse(request.params);
      await request.db((tx) =>
        removeWebAuthnCredential(tx, request.session.userId, credentialId),
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.removed',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { factor: 'webauthn', credentialId },
        }),
      );
      return reply.status(204).send();
    });

    secured.post('/recovery-codes', { config: LIMIT }, async (request) => {
      // Recovery codes are the fallback for a factor you already hold, not a
      // factor in themselves. Without this gate a user with nothing can mint
      // ten codes today, and a require_mfa rule saved next month is satisfied
      // by a printed code forever — the forced-enrolment path is never
      // reached, and the rule buys the tenant nothing. This is the check the
      // endpoint's own comment already claimed it made.
      const held = await request.db((tx) =>
        enrolledFactorTypes(tx, request.session.userId),
      );
      if (held.length === 0) {
        throw new ProblemError(
          409,
          'no-factor-to-recover',
          'Set up a second factor first',
          'Recovery codes are a way back in when you lose your authenticator app or security key, so there has to be one to lose.',
        );
      }

      const codes = await request.db((tx) =>
        generateRecoveryCodes(tx, request.session.userId),
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.recovery_codes_issued',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { count: codes.length },
        }),
      );
      // Shown once. There is no endpoint that returns them again, because the
      // database holds only digests.
      return { codes };
    });
  });
}
```

- [ ] **Step 7: Mount the routes and install the verifiers**

In `apps/api/src/app.ts`, add the imports and, after `registerAuthRoutes`:

```ts
  // Factor verifiers are installed once per process, before any route can ask
  // the chokepoint what is enrolled or what could be enrolled. A verifier that
  // is not installed is not a factor: authorize() would report the user as
  // having none AND nothing to enrol, and refuse rather than offer.
  //
  // None of them takes a relying party. It arrives per request on
  // AuthorizeRequest, which is why there is no ambient store here and why a
  // background job that has no relying party cannot compile.
  installTotpVerifier(localMasterKeyProvider(config.masterKey));
  installWebAuthnVerifier();
  installRecoveryCodeVerifier();

  await app.register(registerMfaRoutes, {
    prefix: '/api/auth/mfa',
    masterKey: config.masterKey,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    // The factor-added mail. `transport` is the same one the password-reset
    // routes get; Task 10 threads it through `buildApp`.
    transport,
  });
```

- [ ] **Step 8: Add the administrative factor removal**

In `apps/api/src/routes/admin/users.ts`, add:

```ts
  app.delete(
    '/users/:id/factors/:type',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, type } = adminFactorParams.parse(request.params);

      await request.db(async (tx) => {
        if (type === 'totp') await removeTotp(tx, id);
        else if (type === 'recovery_code') await removeRecoveryCodes(tx, id);
        else await tx.webAuthnCredential.deleteMany({ where: { userId: id } });

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.removed',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { factor: type, by: 'administrator' },
        });
      });

      return reply.status(204).send();
    },
  );
```

- [ ] **Step 9: Fix the login test that assumed nothing was enrollable**

Installing the verifiers changes an answer Task 4 asserted. With TOTP and
WebAuthn registered, a `require_mfa` rule no longer refuses a user who holds
nothing — it offers enrolment. In `apps/api/src/routes/auth.test.ts`, replace
the case added in Task 4:

```ts
  it('offers enrolment when the user holds no factor', async () => {
    // Task 4 asserted a refusal here, because no verifier was installed and
    // there was nothing to offer. Now there is, and refusing would lock out
    // everyone the first time a tenant turns MFA on.
    await seedUser();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'MFA everywhere', outcome: 'require_mfa' }),
    );
    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'enrol' });
    // The password was accepted; nothing else was granted.
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });
```

Task 9 asserts the rest of that flow, in `apps/api/src/routes/enrol.test.ts`.

- [ ] **Step 10: Run the suite**

Run: `pnpm vitest run apps/api/src/routes/mfa.test.ts apps/api/src/routes/auth.test.ts`
Expected: PASS, 15 tests in `mfa.test.ts`.

- [ ] **Step 11: Typecheck and commit**

```bash
pnpm exec tsc -b
pnpm vitest run apps/api
git add -A
git commit -m "feat: expose MFA enrolment and step-up over HTTP"
```

---

## Task 9: Forced enrolment

**Files:**
- Create: `packages/contracts/src/enrol.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/enrol.ts`
- Modify: `apps/api/src/app.ts`
- Create: `packages/core/src/policy/impact.ts`
- Modify: `packages/core/src/index.ts`
- Test: `apps/api/src/routes/enrol.test.ts`
- Test: `packages/core/src/policy/impact.test.ts`

**Interfaces:**
- Consumes: from Task 4 — `authorize`, `findAttempt`, `tenantRelyingParty`, `enrolledFactorTypes`, `ruleMatches` (Task 2), `buildAuthContext` (Task 3). From Tasks 5–7 — `beginTotpEnrolment`, `confirmTotpEnrolment`, `beginWebAuthnRegistration`, `finishWebAuthnRegistration`. From Task 8 — `qrDataUrl`, `webauthnContext` and `tellOwnerAFactorWasAdded` (export all three from `mfa.ts`).
- Produces:
  - `interface RuleImpact { totalActiveUsers: number; matchedUsers: number; usersNeedingEnrolment: number; unevaluatedConditions: string[] }`
  - `const IMPACT_USER_CAP = 25_000`, `const IMPACT_MEMBERSHIP_CAP = 100_000`
  - `function previewRuleImpact(tx: TenantClient, rule: RuleInput, now?: Date, caps?: ImpactCaps): Promise<RuleImpact>`
  - Zod schemas `enrolBeginRequest`, `enrolTotpConfirmRequest`, `enrolWebauthnFinishRequest`
  - Routes under `/api/auth/enrol`

This is the surface a user reaches after their password was accepted and the
policy asked for a factor they do not hold. It is deliberately a separate file
from `mfa.ts`: everything there is guarded by `requireSession`, and everything
here is guarded by an enrolment attempt token instead. Mixing the two would put
two different authentication rules in one router, which is how one of them ends
up applied by accident.

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/enrol.ts`:

```ts
import { z } from 'zod';

export const enrolBeginRequest = z.object({
  attemptToken: z.string().min(1).max(256),
});
export type EnrolBeginRequest = z.infer<typeof enrolBeginRequest>;

export const enrolTotpConfirmRequest = z.object({
  attemptToken: z.string().min(1).max(256),
  code: z.string().min(6).max(6),
});
export type EnrolTotpConfirmRequest = z.infer<typeof enrolTotpConfirmRequest>;

export const enrolWebauthnFinishRequest = z.object({
  attemptToken: z.string().min(1).max(256),
  label: z.string().min(1).max(64).default('Security key'),
  response: z.record(z.unknown()),
});
export type EnrolWebauthnFinishRequest = z.input<typeof enrolWebauthnFinishRequest>;

export const ruleImpactResponse = z.object({
  totalActiveUsers: z.number(),
  matchedUsers: z.number(),
  usersNeedingEnrolment: z.number(),
  unevaluatedConditions: z.array(z.string()),
});
export type RuleImpactResponse = z.infer<typeof ruleImpactResponse>;
```

Add `export * from './enrol.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing impact test**

`packages/core/src/policy/impact.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { createContract } from '../identity/contract-service.js';
import { createPerson, linkUserToPerson } from '../identity/person-service.js';
import { generateRecoveryCodes } from '../auth/mfa/recovery-codes.js';
import { previewRuleImpact } from './impact.js';

let tenantId: string;

const NOW = new Date('2026-08-12T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function user(login: string) {
  return withTenant(tenantId, (tx) =>
    createUser(tx, {
      login,
      email: `${login}@acme.test`,
      displayName: login,
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const preview = (rule: Parameters<typeof previewRuleImpact>[1]) =>
  withTenant(tenantId, (tx) => previewRuleImpact(tx, rule, NOW));

describe('previewRuleImpact', () => {
  it('counts everyone for an unconstrained rule', async () => {
    await user('a');
    await user('b');
    const impact = await preview({ name: 'All', outcome: 'require_mfa' });
    expect(impact).toMatchObject({
      totalActiveUsers: 2,
      matchedUsers: 2,
      usersNeedingEnrolment: 2,
    });
  });

  it('leaves out inactive users', async () => {
    const a = await user('a');
    await user('b');
    await withTenant(tenantId, (tx) => deactivateUser(tx, a.id, 'left'));
    const impact = await preview({ name: 'All', outcome: 'require_mfa' });
    expect(impact.totalActiveUsers).toBe(1);
  });

  it('counts only the matching group', async () => {
    const a = await user('a');
    await user('b');
    const groupId = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Finance');
      await addMember(tx, g.id, a.id);
      return g.id;
    });
    const impact = await preview({
      name: 'Finance',
      outcome: 'require_mfa',
      groupIds: [groupId],
    });
    expect(impact).toMatchObject({ totalActiveUsers: 2, matchedUsers: 1 });
  });

  it('counts a contract condition against every active contract', async () => {
    const a = await user('a');
    await user('b');
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'A', familyName: 'A' });
      await linkUserToPerson(tx, a.id, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2026-01-01'),
        department: 'Care',
      });
      await createContract(tx, person.id, {
        sequence: 2,
        startDate: day('2026-01-01'),
        department: 'Finance',
      });
    });
    const impact = await preview({
      name: 'Finance',
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    expect(impact.matchedUsers).toBe(1);
  });

  it('does not count someone who already holds a factor as needing enrolment', async () => {
    const a = await user('a');
    await user('b');
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, a.id));
    const impact = await preview({ name: 'All', outcome: 'require_mfa' });
    // Recovery codes satisfy require_mfa, so `a` is already covered.
    expect(impact).toMatchObject({ matchedUsers: 2, usersNeedingEnrolment: 1 });
  });

  it('does not let recovery codes cover a rule that names a factor', async () => {
    const a = await user('a');
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, a.id));
    const impact = await preview({
      name: 'Keys',
      outcome: 'require_factor',
      factorType: 'webauthn',
    });
    expect(impact.usersNeedingEnrolment).toBe(1);
  });

  it('counts nobody as needing enrolment for an allow rule', async () => {
    await user('a');
    const impact = await preview({ name: 'Allow', outcome: 'allow' });
    expect(impact.usersNeedingEnrolment).toBe(0);
  });

  it('names the conditions it could not evaluate', async () => {
    await user('a');
    const impact = await preview({
      name: 'Offsite nights',
      outcome: 'deny',
      ipRanges: ['203.0.113.0/24'],
      startMinute: 0,
      endMinute: 60,
    });
    // A preview has no request behind it, so there is no address and no moment
    // to test. Saying so is better than quietly counting as if there were.
    expect(impact.unevaluatedConditions).toEqual(['source address', 'time window']);
    expect(impact.matchedUsers).toBe(1);
  });

  it('answers from counts, and says so, when the directory is too large to walk', async () => {
    // Not a real 25,000-user fixture: the cap is lowered for the test, which is
    // what makes the partial-answer branch reachable at all. Without this the
    // branch would first run on a customer's directory.
    await user('a');
    await user('b');
    const impact = await withTenant(tenantId, (tx) =>
      previewRuleImpact(
        tx,
        {
          name: 'Finance',
          outcome: 'require_mfa',
          contractField: 'department',
          contractValues: ['Finance'],
        },
        NOW,
        { userCap: 1, membershipCap: 1 },
      ),
    );

    expect(impact.totalActiveUsers).toBe(2);
    // No group condition, so SQL matches everyone; the contract condition it
    // could not apply is named rather than silently ignored.
    expect(impact.matchedUsers).toBe(2);
    expect(impact.unevaluatedConditions).toContain('contract attributes');
  });

  it('assumes the user is entering the application a rule names', async () => {
    await user('a');
    const appId = await withTenant(tenantId, async (tx) => {
      const row = await tx.application.create({
        data: { tenantId, name: 'CRM', slug: 'crm', launchUrl: 'https://crm.acme.test/' },
      });
      return row.id;
    });
    const impact = await preview({
      name: 'CRM',
      outcome: 'require_mfa',
      applicationIds: [appId],
    });
    expect(impact.matchedUsers).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/policy/impact.test.ts`
Expected: FAIL — cannot resolve `./impact.js`.

- [ ] **Step 4: Implement the impact preview**

`packages/core/src/policy/impact.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { ruleMatches } from './evaluate.js';
import type { RuleInput } from './policy-service.js';
import type { AuthContext, ContractFacts, FactorType, PolicyRule } from './types.js';

export interface RuleImpact {
  totalActiveUsers: number;
  matchedUsers: number;
  /**
   * Of the users this rule matches, how many hold nothing that satisfies it
   * and would therefore be asked to enrol a factor on their next sign-in.
   */
  usersNeedingEnrolment: number;
  /** Conditions a preview cannot test, named so nobody assumes it did. */
  unevaluatedConditions: string[];
}

/**
 * Above these, the preview stops loading rows and answers from counts alone.
 *
 * A directory of a hundred thousand people would otherwise pull every user and
 * every membership into the API process to answer a question an administrator
 * asked out of curiosity. The partial answer is still useful and, crucially,
 * still honest: it says which dimensions it could not apply.
 */
export const IMPACT_USER_CAP = 25_000;
export const IMPACT_MEMBERSHIP_CAP = 100_000;

/**
 * How many people a rule would touch, answered before it is saved.
 *
 * Directory Sync learned this the expensive way: a change that silently
 * affected everyone was indistinguishable from one that affected nobody until
 * it had already happened. A rule requiring a second factor is the same shape
 * of mistake, and the same courtesy applies.
 *
 * Two honest limits, both reported rather than hidden. A preview has no request
 * behind it, so source address and time window cannot be tested and are
 * ignored — a rule constrained by either affects at most this many people, not
 * exactly this many. And an application-scoped rule is counted as though the
 * user were entering the first application it names, because that is the case
 * the administrator is reasoning about.
 *
 * Six queries, then everything is decided in memory against the same
 * `ruleMatches` the live decision uses. Per-user queries would be tens of
 * thousands of round trips on a real directory, and a preview that times out
 * teaches nobody anything.
 */
export interface ImpactCaps {
  userCap?: number;
  membershipCap?: number;
}

export async function previewRuleImpact(
  tx: TenantClient,
  rule: RuleInput,
  now: Date = new Date(),
  caps: ImpactCaps = {},
): Promise<RuleImpact> {
  const userCap = caps.userCap ?? IMPACT_USER_CAP;
  const membershipCap = caps.membershipCap ?? IMPACT_MEMBERSHIP_CAP;
  const unevaluatedConditions: string[] = [];
  if ((rule.ipRanges ?? []).length > 0) unevaluatedConditions.push('source address');
  if (
    (rule.daysOfWeek ?? []).length > 0 ||
    (rule.startMinute ?? null) !== null ||
    (rule.endMinute ?? null) !== null
  ) {
    unevaluatedConditions.push('time window');
  }

  const demandsFactor =
    rule.outcome === 'require_mfa' || rule.outcome === 'require_factor';
  const groupIds = rule.groupIds ?? [];

  // Count before materialising. Two cheap aggregates decide whether the honest
  // answer is the whole one or the partial one.
  const totalActiveUsers = await tx.user.count({ where: { status: 'active' } });
  const membershipCount = await tx.groupMembership.count();

  if (totalActiveUsers > userCap || membershipCount > membershipCap) {
    // Too large to reason about in memory. Answer the dimensions SQL can
    // express — group membership, and which users hold which factor — and name
    // contract conditions alongside the two a preview never evaluates, so the
    // number is understood as an upper bound rather than a count.
    if (rule.contractField && (rule.contractValues ?? []).length > 0) {
      unevaluatedConditions.push('contract attributes');
    }

    const scope =
      groupIds.length > 0
        ? { status: 'active', memberships: { some: { groupId: { in: groupIds } } } }
        : { status: 'active' };

    const matchedUsers = await tx.user.count({ where: scope });

    let usersNeedingEnrolment = 0;
    if (demandsFactor) {
      const covered =
        rule.outcome === 'require_factor' && rule.factorType === 'totp'
          ? { totpCredential: { confirmedAt: { not: null } } }
          : rule.outcome === 'require_factor'
            ? { webAuthnCredentials: { some: {} } }
            : {
                OR: [
                  { totpCredential: { confirmedAt: { not: null } } },
                  { webAuthnCredentials: { some: {} } },
                  { recoveryCodes: { some: { usedAt: null } } },
                ],
              };
      const already = await tx.user.count({ where: { ...scope, ...covered } });
      usersNeedingEnrolment = matchedUsers - already;
    }

    return {
      totalActiveUsers,
      matchedUsers,
      usersNeedingEnrolment,
      unevaluatedConditions,
    };
  }

  const users = await tx.user.findMany({
    where: { status: 'active' },
    select: { id: true, personId: true, orgUnitId: true },
  });
  const memberships = await tx.groupMembership.findMany({
    select: { userId: true, groupId: true },
  });
  // Only the field the rule actually names. Selecting all four would carry
  // three columns of employment data across the wire for every person in the
  // tenant to answer a question about one of them.
  const contracts = await tx.contract.findMany({
    where: {
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    select: {
      personId: true,
      department: rule.contractField === 'department',
      jobTitle: rule.contractField === 'jobTitle',
      employer: rule.contractField === 'employer',
      location: rule.contractField === 'location',
    },
  });

  const totp = await tx.totpCredential.findMany({
    where: { confirmedAt: { not: null } },
    select: { userId: true },
  });
  const webauthn = await tx.webAuthnCredential.findMany({ select: { userId: true } });
  const recovery = await tx.recoveryCode.findMany({
    where: { usedAt: null },
    select: { userId: true },
  });

  const groupsByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const list = groupsByUser.get(row.userId) ?? [];
    list.push(row.groupId);
    groupsByUser.set(row.userId, list);
  }

  const contractsByPerson = new Map<string, ContractFacts[]>();
  for (const row of contracts) {
    const list = contractsByPerson.get(row.personId) ?? [];
    // Unselected columns come back undefined; the engine expects null.
    list.push({
      department: row.department ?? null,
      jobTitle: row.jobTitle ?? null,
      employer: row.employer ?? null,
      location: row.location ?? null,
    });
    contractsByPerson.set(row.personId, list);
  }

  const withTotp = new Set(totp.map((r) => r.userId));
  const withWebauthn = new Set(webauthn.map((r) => r.userId));
  const withRecovery = new Set(recovery.map((r) => r.userId));

  // The rule as the engine would see it, minus the two dimensions a preview
  // cannot supply. The id and position are placeholders: ruleMatches reads
  // neither.
  const candidate: PolicyRule = {
    id: 'preview',
    name: rule.name,
    enabled: true,
    position: 0,
    outcome: rule.outcome,
    factorType: rule.factorType ?? null,
    applicationIds: rule.applicationIds ?? [],
    groupIds: rule.groupIds ?? [],
    contractField: rule.contractField ?? null,
    contractValues: rule.contractValues ?? [],
    ipRanges: [],
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  const applicationId = candidate.applicationIds[0] ?? null;

  const covers = (userId: string): boolean => {
    if (rule.outcome === 'require_factor') {
      const wanted = rule.factorType;
      if (wanted === 'totp') return withTotp.has(userId);
      if (wanted === 'webauthn') return withWebauthn.has(userId);
      return false;
    }
    // require_mfa: anything counts, including recovery codes.
    return (
      withTotp.has(userId) || withWebauthn.has(userId) || withRecovery.has(userId)
    );
  };

  let matchedUsers = 0;
  let usersNeedingEnrolment = 0;

  for (const user of users) {
    const context: AuthContext = {
      userId: user.id,
      applicationId,
      groupIds: groupsByUser.get(user.id) ?? [],
      contracts: user.personId ? (contractsByPerson.get(user.personId) ?? []) : [],
      sourceIp: null,
      now,
    };
    if (!ruleMatches(candidate, context)) continue;

    matchedUsers += 1;
    if (demandsFactor && !covers(user.id)) usersNeedingEnrolment += 1;
  }

  return {
    totalActiveUsers,
    matchedUsers,
    usersNeedingEnrolment,
    unevaluatedConditions,
  };
}
```

The import line is exactly:

```ts
import type { AuthContext, ContractFacts, PolicyRule } from './types.js';
```

`FactorType` is not among them — nothing in this module names the type.

- [ ] **Step 5: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/policy/impact.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Write the failing enrolment-route test**

`apps/api/src/routes/enrol.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { prisma, withTenant } from '@syntra/db';
import { addRule, createUser, generateRecoveryCodes, setPassword } from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });
});

const post = (url: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url, headers: { host: ctx.host }, payload });

const login = () => post('/api/auth/login', { login: 'jdoe', password: PASSWORD });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'syntra_session');

const requireMfa = () =>
  withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'MFA', outcome: 'require_mfa' }));

const codeFor = (secret: string) =>
  OTPAuth.TOTP.generate({
    secret: OTPAuth.Secret.fromBase32(secret),
    period: 30,
    digits: 6,
    algorithm: 'SHA1',
  });

describe('a login that requires a factor the user does not hold', () => {
  it('answers with an enrolment demand and no cookie', async () => {
    await requireMfa();
    const res = await login();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'enrol' });
    expect(res.json().enrollableFactors).toEqual(
      expect.arrayContaining(['totp', 'webauthn']),
    );
    // The password was right, but nothing has been granted.
    expect(cookieOf(res)).toBeUndefined();
  });

  it('never offers recovery codes as the factor to enrol', async () => {
    await requireMfa();
    const res = await login();
    expect(res.json().enrollableFactors).not.toContain('recovery_code');
  });

  it('refuses outright when the tenant has turned self-enrolment off', async () => {
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { selfEnrolmentEnabled: false },
    });
    await requireMfa();
    const res = await login();
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/enrol/totp', () => {
  async function offer() {
    await requireMfa();
    return login().then((res) => res.json().attemptToken as string);
  }

  it('refuses without an attempt token', async () => {
    const res = await post('/api/auth/enrol/totp/begin', { attemptToken: 'nope' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an ordinary session cookie in place of an attempt token', async () => {
    // Signing in normally and then calling the enrolment surface must not work:
    // this endpoint is guarded by the attempt, not by a session, and the two
    // are not interchangeable.
    const signedIn = await login();
    const cookie = cookieOf(signedIn)!.value;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/enrol/totp/begin',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { attemptToken: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns a secret and a QR image against a live attempt', async () => {
    const attemptToken = await offer();
    const res = await post('/api/auth/enrol/totp/begin', { attemptToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.json().qr).toMatch(/^data:image\/gif;base64,/);
  });

  it('issues a session once the code is confirmed', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;

    const res = await post('/api/auth/enrol/totp/confirm', {
      attemptToken,
      code: codeFor(secret),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'authenticated', scope: 'portal' });
    expect(cookieOf(res)).toBeDefined();
  });

  it('records the enrolment as having happened under a forced challenge', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;
    await post('/api/auth/enrol/totp/confirm', { attemptToken, code: codeFor(secret) });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'mfa.enrolled' } }),
    );
    expect(events).toHaveLength(1);
    // A factor enrolled by whoever held the password during a forced challenge
    // must be distinguishable afterwards from one the owner added themselves.
    expect(events[0]!.payload).toMatchObject({
      factor: 'totp',
      underForcedEnrolment: true,
    });

    const completed = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: 'auth.forced_enrolment_completed' } }),
    );
    expect(completed).toBe(1);
  });

  it('refuses a wrong code and leaves the attempt usable', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;

    const bad = await post('/api/auth/enrol/totp/confirm', {
      attemptToken,
      code: '000000',
    });
    expect(bad.statusCode).toBe(400);
    expect(cookieOf(bad)).toBeUndefined();

    const good = await post('/api/auth/enrol/totp/confirm', {
      attemptToken,
      code: codeFor(secret),
    });
    expect(good.statusCode).toBe(200);
  });

  it('refuses to reuse the attempt token after it has been spent', async () => {
    const attemptToken = await offer();
    const secret = (await post('/api/auth/enrol/totp/begin', { attemptToken })).json()
      .secret as string;
    await post('/api/auth/enrol/totp/confirm', { attemptToken, code: codeFor(secret) });

    const again = await post('/api/auth/enrol/totp/begin', { attemptToken });
    expect(again.statusCode).toBe(401);
  });

  it('refuses to spend a verification attempt on enrolment', async () => {
    // Give the user a factor, so the login produces a step-up challenge rather
    // than an enrolment demand, then try to use that token here.
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await requireMfa();
    const challenge = await login();
    expect(challenge.json().status).toBe('challenge');

    const res = await post('/api/auth/enrol/totp/begin', {
      attemptToken: challenge.json().attemptToken,
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses TOTP when the rule names WebAuthn', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'Keys', outcome: 'require_factor', factorType: 'webauthn' }),
    );
    const attemptToken = (await login()).json().attemptToken as string;
    const res = await post('/api/auth/enrol/totp/begin', { attemptToken });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `pnpm vitest run apps/api/src/routes/enrol.test.ts`
Expected: FAIL — 404 on every `/api/auth/enrol` route.

- [ ] **Step 8: Implement the enrolment routes**

Export three helpers from `apps/api/src/routes/mfa.ts`, so this router shares
them rather than growing a second copy of each — a second QR encoder is
harmless, but a second relying-party derivation or a second "did we tell the
owner" rule is not:

```ts
export const qrDataUrl = (text: string) =>
  new Encoder({ level: 'M' }).encode(new Byte(text)).toDataURL(4, { margin: 8 });

export async function webauthnContext(
  request: FastifyRequest,
  publicUrl: string,
): Promise<{ rp: RelyingPartyIdentity }> { /* …as written in Task 8… */ }

export async function tellOwnerAFactorWasAdded(
  request: FastifyRequest,
  transport: Transport,
  userId: string,
  factor: string,
): Promise<void> { /* …as written in Task 8… */ }
```

`tellOwnerAFactorWasAdded` takes the transport as a parameter rather than
closing over `options`, because both routers call it and they are registered
separately.

`apps/api/src/routes/enrol.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  enrolBeginRequest,
  enrolTotpConfirmRequest,
  enrolWebauthnFinishRequest,
} from '@syntra/contracts';
import {
  authorize,
  beginTotpEnrolment,
  beginWebAuthnRegistration,
  confirmTotpEnrolment,
  createSession,
  finishWebAuthnRegistration,
  findAttempt,
  localMasterKeyProvider,
  permissionsForUser,
  recordEvent,
  type FactorType,
  type ResolvedAttempt,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { tenantRelyingParty } from './relying-party.js';
import { qrDataUrl, tellOwnerAFactorWasAdded, webauthnContext } from './mfa.js';

export interface EnrolRouteOptions {
  masterKey: Buffer;
  publicUrl: string;
  authRateLimitMax: number;
  transport: Transport;
}

const SECURE = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: SECURE,
};

/**
 * Enrolment during a forced-enrolment challenge.
 *
 * There is no session here and no session guard. The credential is the
 * enrolment attempt token, which authorize() issued after primary
 * authentication succeeded and the policy asked for a factor the user does not
 * hold. It buys exactly one thing: enrolling a factor of the required kind.
 *
 * SECURITY TRADE, ACCEPTED DELIBERATELY: whoever holds the password can enrol
 * their own factor here. The alternative is a product in which no tenant can
 * ever turn MFA on, because the first rule they save locks out everyone who has
 * not already enrolled. The same password previously bought a full session with
 * no factor at all, so this is not a step backwards — but every enrolment that
 * happens through this router is audited with `underForcedEnrolment: true`, so
 * it can be found afterwards.
 */
export async function registerEnrolRoutes(
  app: FastifyInstance,
  options: EnrolRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);
  const LIMIT = {
    rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
  };

  /**
   * Resolves the attempt and checks that the factor about to be enrolled is
   * the kind the rule asked for. A rule demanding WebAuthn must not be
   * satisfiable by enrolling an authenticator app.
   */
  async function attemptFor(
    request: FastifyRequest,
    token: string,
    factor: FactorType,
  ): Promise<ResolvedAttempt> {
    const attempt = await request.db((tx) => findAttempt(tx, token, new Date()));
    if (!attempt || attempt.purpose !== 'enrol') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }
    if (
      attempt.requiredOutcome === 'require_factor' &&
      attempt.requiredFactor !== factor
    ) {
      throw new ProblemError(
        400,
        'wrong-factor-type',
        'That is not the kind of factor this account needs',
      );
    }
    return attempt;
  }

  /**
   * Hands the enrolment back to the chokepoint, which re-reads what the user
   * actually holds, consumes the attempt, audits the forced enrolment and
   * re-evaluates the policy. This route never decides that a session may be
   * issued; it only reports what authorize() decided.
   */
  async function finish(
    request: FastifyRequest,
    reply: FastifyReply,
    attempt: ResolvedAttempt,
    token: string,
    factor: FactorType,
  ) {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );

    const result = await authorize(request.tenantId, {
      kind: 'enrolled',
      attemptToken: token,
      enrolledFactor: factor,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
    });

    if (result.status === 'deny') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }
    if (result.status === 'challenge') {
      return reply.status(200).send({
        status: 'challenge',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        acceptableFactors: result.acceptableFactors,
      });
    }
    if (result.status === 'enrol') {
      return reply.status(200).send({
        status: 'enrol',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        enrollableFactors: result.enrollableFactors,
      });
    }

    // The scope comes off the attempt through authorize(), which is where the
    // issuer recorded it. An elevation that ended in forced enrolment must come
    // back as an administrative session, and a portal sign-in must not.
    const { token: sessionToken } = await request.db((tx) =>
      createSession(tx, attempt.userId, result.scope, result.satisfiedFactor),
    );
    reply.setCookie(SESSION_COOKIE, sessionToken, cookieOptions);

    const user = await request.db((tx) =>
      tx.user.findUnique({ where: { id: attempt.userId } }),
    );
    const permissions = await request.db((tx) =>
      permissionsForUser(tx, attempt.userId),
    );
    return {
      status: 'authenticated' as const,
      userId: attempt.userId,
      displayName: user?.displayName ?? '',
      scope: result.scope,
      mayElevate: permissions.size > 0,
      permissions: [...permissions],
    };
  }

  app.post('/totp/begin', { config: LIMIT }, async (request) => {
    const body = enrolBeginRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'totp');

    const enrolment = await request.db((tx) =>
      beginTotpEnrolment(tx, provider, attempt.userId),
    );
    // QR encoding outside the transaction: pure CPU work with no business
    // inside Prisma's 5000 ms transaction budget.
    return { ...enrolment, qr: qrDataUrl(enrolment.uri) };
  });

  app.post('/totp/confirm', { config: LIMIT }, async (request, reply) => {
    const body = enrolTotpConfirmRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'totp');

    const ok = await confirmTotpEnrolment(
      request.tenantId,
      provider,
      attempt.userId,
      body.code,
    );
    if (!ok) {
      // A wrong code costs a retry, not the attempt: the user is standing in
      // front of a screen with no session and nowhere else to go.
      throw new ProblemError(400, 'invalid-code', 'That code did not match');
    }

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: attempt.userId,
        action: 'mfa.enrolled',
        targetType: 'User',
        targetId: attempt.userId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { factor: 'totp', underForcedEnrolment: true, ruleId: attempt.ruleId },
      }),
    );
    // Outside every transaction, and unconditional. This is the mail that
    // reaches the one person who can tell a legitimate enrolment from one made
    // by whoever held the password — and it matters most here, because this
    // path is the one a stolen password can reach.
    await tellOwnerAFactorWasAdded(
      request,
      options.transport,
      attempt.userId,
      'authenticator app',
    );

    return finish(request, reply, attempt, body.attemptToken, 'totp');
  });

  app.post('/webauthn/begin', { config: LIMIT }, async (request) => {
    const body = enrolBeginRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'webauthn');
    // Refuses with a 409 naming the fix when this tenant has no primary domain
    // set, rather than registering a credential against an origin taken from
    // the request. The enrolment screen renders that message.
    const { rp } = await webauthnContext(request, options.publicUrl);
    return beginWebAuthnRegistration(request.tenantId, attempt.userId, rp);
  });

  app.post('/webauthn/finish', { config: LIMIT }, async (request, reply) => {
    const body = enrolWebauthnFinishRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'webauthn');
    const { rp } = await webauthnContext(request, options.publicUrl);

    const outcome = await finishWebAuthnRegistration(
      request.tenantId,
      attempt.userId,
      rp,
      body.label,
      body.response as never,
    );
    if (!outcome.ok) {
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: attempt.userId,
          action: 'mfa.enrol_failed',
          targetType: 'User',
          targetId: attempt.userId,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: {
            factor: 'webauthn',
            reason: outcome.reason,
            underForcedEnrolment: true,
          },
        }),
      );
      throw new ProblemError(
        400,
        'registration-rejected',
        'That security key was not accepted',
      );
    }

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: attempt.userId,
        action: 'mfa.enrolled',
        targetType: 'User',
        targetId: attempt.userId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          factor: 'webauthn',
          label: body.label,
          underForcedEnrolment: true,
          ruleId: attempt.ruleId,
        },
      }),
    );
    await tellOwnerAFactorWasAdded(
      request,
      options.transport,
      attempt.userId,
      'security key',
    );

    return finish(request, reply, attempt, body.attemptToken, 'webauthn');
  });
}
```

Register it in `apps/api/src/app.ts`, beside the MFA routes:

```ts
  await app.register(registerEnrolRoutes, {
    prefix: '/api/auth/enrol',
    masterKey: config.masterKey,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    transport,
  });
```

- [ ] **Step 9: Run it to make sure it passes**

Run: `pnpm vitest run apps/api/src/routes/enrol.test.ts`
Expected: PASS, 12 tests.

If "refuses to spend a verification attempt on enrolment" fails, `findAttempt`
is not returning `purpose` or `attemptFor` is not checking it. Do not proceed —
that check is what stops a step-up being converted into an enrolment.

- [ ] **Step 10: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './policy/impact.js';
```

```bash
pnpm exec tsc -b
pnpm vitest run packages/core apps/api
git add -A
git commit -m "feat: let a user enrol a required factor instead of being locked out"
```

---

## Task 10: Self-service password reset

**Files:**
- Create: `packages/core/src/auth/password-policy.ts`
- Create: `packages/core/src/auth/refresh-token.ts`
- Create: `packages/core/src/auth/password-reset.ts`
- Modify: `packages/core/src/notify/templates/index.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/contracts/src/reset.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/password-reset.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/routes/admin/users.ts` — `PATCH /users/:id`
- Test: `packages/core/src/auth/password-policy.test.ts`
- Test: `packages/core/src/auth/password-reset.test.ts`
- Test: `apps/api/src/routes/password-reset.test.ts`

**Interfaces:**
- Consumes: from Task 4 — `verifyFactor`, `enrolledFactorTypes`, `hasRecoveryCodes`, `RelyingParty`, and `tenantRelyingParty` from `apps/api/src/routes/relying-party.ts`. From Task 8 — `renderMessage` and `sendMessage`. From Tasks 5–7 — the three registered verifiers. From the existing codebase — `Transport`, `memoryTransport`, `TEMPLATES`, `hashPassword`, `revokeAllForUser`, `recordEvent`.
- Produces:
  - `type PasswordCheck = { ok: true } | { ok: false; reason: 'too_short' | 'too_long' | 'too_obvious' }`
  - `function validateNewPassword(password: string, opts: { minLength: number; login: string; email: string }): PasswordCheck`
  - `function revokeAllRefreshTokensForUser(tx: TenantClient, userId: string): Promise<void>`
  - `const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000`
  - `function requestPasswordReset(tenantId: string, transport: Transport, publicUrl: string, input: { login: string; sourceIp: string | null; now?: Date }): Promise<void>`
  - `type ResetPreflight = { valid: false } | { valid: true; requiresFactor: boolean; acceptableFactors: ('totp' | 'webauthn' | 'recovery_code')[] }`
  - `function preflightPasswordReset(tenantId: string, token: string, now?: Date): Promise<ResetPreflight>`
  - `type ResetOutcome = { ok: true } | { ok: false; reason: 'invalid_token' | 'factor_required' | 'factor_invalid' | 'weak_password'; detail?: string }`
  - `function completePasswordReset(tenantId: string, transport: Transport, input: { token: string; newPassword: string; factor?: FactorPresentation; relyingParty: RelyingParty; sourceIp: string | null; now?: Date }): Promise<ResetOutcome>`

- [ ] **Step 1: Write the failing password-policy test**

`packages/core/src/auth/password-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateNewPassword } from './password-policy.js';

const opts = { minLength: 12, login: 'jdoe', email: 'jo.doe@acme.test' };

describe('validateNewPassword', () => {
  it('accepts a long enough password', () => {
    expect(validateNewPassword('correct horse battery staple', opts)).toEqual({ ok: true });
  });

  it('counts characters, not bytes', () => {
    // Twelve characters that are more than twelve bytes must still pass.
    expect(validateNewPassword('naïve-café-🔑x', opts)).toEqual({ ok: true });
  });

  it('rejects one shorter than the tenant minimum', () => {
    expect(validateNewPassword('short', opts)).toEqual({ ok: false, reason: 'too_short' });
    expect(validateNewPassword('elevenchars', opts)).toEqual({ ok: false, reason: 'too_short' });
  });

  it('honours a tenant minimum above the default', () => {
    expect(validateNewPassword('twelvechars!', { ...opts, minLength: 16 })).toEqual({
      ok: false,
      reason: 'too_short',
    });
  });

  it('rejects one long enough to be a denial of service against Argon2', () => {
    expect(validateNewPassword('x'.repeat(1025), opts)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('rejects the login itself, whatever the case', () => {
    expect(validateNewPassword('JDOEjdoejdoe', { ...opts, login: 'jdoejdoejdoe' })).toEqual({
      ok: false,
      reason: 'too_obvious',
    });
  });

  it('rejects the local part of the email address', () => {
    expect(
      validateNewPassword('JO.DOE.jo.doe', { ...opts, email: 'jo.doe.jo.doe@acme.test' }),
    ).toEqual({ ok: false, reason: 'too_obvious' });
  });

  it('rejects a single repeated character', () => {
    expect(validateNewPassword('aaaaaaaaaaaaaaa', opts)).toEqual({
      ok: false,
      reason: 'too_obvious',
    });
  });
});
```

- [ ] **Step 2: Implement the password policy**

`packages/core/src/auth/password-policy.ts`:

```ts
export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'too_long' | 'too_obvious' };

export interface PasswordPolicyOptions {
  minLength: number;
  login: string;
  email: string;
}

/**
 * The tenant password policy, such as it is: a length floor, a length ceiling
 * and three refusals that catch the passwords people actually pick when told to
 * pick one.
 *
 * The ceiling is not arbitrary. Argon2id's cost is proportional to input, and
 * an unbounded password field is a way to spend a server's memory on demand.
 */
export function validateNewPassword(
  password: string,
  opts: PasswordPolicyOptions,
): PasswordCheck {
  // Code points, not UTF-16 units: a password of twelve emoji is twelve
  // characters to the person who typed it.
  const length = [...password].length;
  if (length < opts.minLength) return { ok: false, reason: 'too_short' };
  if (password.length > 1024) return { ok: false, reason: 'too_long' };

  const lowered = password.toLowerCase();
  const localPart = opts.email.split('@')[0] ?? '';
  if (lowered === opts.login.toLowerCase()) return { ok: false, reason: 'too_obvious' };
  if (localPart && lowered === localPart.toLowerCase()) {
    return { ok: false, reason: 'too_obvious' };
  }
  if (new Set([...password]).size === 1) return { ok: false, reason: 'too_obvious' };

  return { ok: true };
}
```

- [ ] **Step 3: Run it**

Run: `pnpm vitest run packages/core/src/auth/password-policy.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 4: Add the refresh-token revocation**

`packages/core/src/auth/refresh-token.ts`:

```ts
import type { TenantClient } from '@syntra/db';

/**
 * Revokes every live refresh token for a user.
 *
 * Access I issues none — the OIDC provider in Access II does. It exists here
 * because a password reset must invalidate every credential derived from the
 * old password, and "we will remember to add refresh tokens to that list later"
 * is how a revoked session ends up still refreshable.
 */
export async function revokeAllRefreshTokensForUser(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
```

- [ ] **Step 5: Add the mail templates**

In `packages/core/src/notify/templates/index.ts`, add to `TEMPLATES`:

```ts
  'password-reset': {
    subject: 'Reset your {{tenantName}} password',
    text: 'Hello {{displayName}},\n\nOpen this link to choose a new password. It works once and expires in 30 minutes.\n\n{{resetUrl}}\n\nIf you did not ask for this, nothing has changed and you can ignore this message.',
    html: '<p>Hello {{displayName}},</p><p>Open this link to choose a new password. It works once and expires in 30 minutes.</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p><p>If you did not ask for this, nothing has changed and you can ignore this message.</p>',
  },
  'password-reset-upstream': {
    subject: 'Reset your {{tenantName}} password',
    text: 'Hello {{displayName}},\n\nYour password is not held by {{tenantName}}. It is managed by {{provider}}, and that is where you reset it.\n\nIf you are not sure what that means, contact your IT administrator.',
    html: '<p>Hello {{displayName}},</p><p>Your password is not held by {{tenantName}}. It is managed by <strong>{{provider}}</strong>, and that is where you reset it.</p><p>If you are not sure what that means, contact your IT administrator.</p>',
  },
```

The upstream user gets a message, not a different HTTP response. Telling them
in the browser that their password lives elsewhere would say "this account
exists and is federated" to anyone who typed a login name.

- [ ] **Step 6: Write the failing reset test**

`packages/core/src/auth/password-reset.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { memoryTransport } from '../notify/notification-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createSession, resolveSession } from './session-service.js';
import { hashPassword, setPassword, verifyPassword } from './password.js';
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  installTotpVerifier,
} from './mfa/totp.js';
import { generateRecoveryCodes, installRecoveryCodeVerifier } from './mfa/recovery-codes.js';
import {
  completePasswordReset,
  preflightPasswordReset,
  requestPasswordReset,
} from './password-reset.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
installTotpVerifier(provider);
installRecoveryCodeVerifier();

const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };

let tenantId: string;
let userId: string;
let transport: ReturnType<typeof memoryTransport>;

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';
const PUBLIC_URL = 'http://acme.syntra.test';
const NOW = new Date('2026-08-12T09:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  transport = memoryTransport();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });
});

const request = (login: string) =>
  requestPasswordReset(tenantId, transport, PUBLIC_URL, {
    login,
    sourceIp: '10.1.2.3',
    now: NOW,
  });

/** The token as it reaches the user: pulled out of the link in the mail. */
const tokenFromMail = () => {
  const match = /token=([A-Za-z0-9_-]+)/.exec(transport.sent[0]?.text ?? '');
  return match?.[1] ?? null;
};

describe('requestPasswordReset', () => {
  it('mails a single-use link to a known login', async () => {
    await request('jdoe');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('jo.doe@acme.test');
    expect(tokenFromMail()).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('accepts an email address as well as a login', async () => {
    await request('jo.doe@acme.test');
    expect(transport.sent).toHaveLength(1);
  });

  it('sends nothing for an unknown login, and does not throw', async () => {
    await request('nobody');
    expect(transport.sent).toHaveLength(0);
  });

  it('stores only the digest of the token', async () => {
    await request('jdoe');
    const token = tokenFromMail()!;
    const rows = await withTenant(tenantId, (tx) => tx.passwordResetToken.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('invalidates the previous token when a second is asked for', async () => {
    await request('jdoe');
    const first = tokenFromMail()!;
    await request('jdoe');

    const outcome = await completePasswordReset(tenantId, transport, {
      token: first,
      newPassword: NEW_PASSWORD,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('tells an upstream-managed user where to go instead, by mail', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Entra ID' },
      }),
    );
    await request('jdoe');

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.text).toContain('Entra ID');
    expect(tokenFromMail()).toBeNull();
    expect(await withTenant(tenantId, (tx) => tx.passwordResetToken.count())).toBe(0);
  });

  it('sends nothing to an inactive account', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: userId }, data: { status: 'inactive' } }),
    );
    await request('jdoe');
    expect(transport.sent).toHaveLength(0);
  });

  it('records the request in the audit log either way', async () => {
    await request('jdoe');
    await request('nobody');
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_reset_requested' } }),
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.outcome).sort()).toEqual(['failure', 'success']);
  });
});

describe('preflightPasswordReset', () => {
  it('reports a valid token with no factor needed', async () => {
    await request('jdoe');
    expect(await preflightPasswordReset(tenantId, tokenFromMail()!, NOW)).toEqual({
      valid: true,
      requiresFactor: false,
      acceptableFactors: [],
    });
  });

  it('reports the factors a user with MFA must present', async () => {
    const enrolment = await withTenant(tenantId, (tx) =>
      beginTotpEnrolment(tx, provider, userId),
    );
    await confirmTotpEnrolment(
      tenantId,
      provider,
      userId,
      OTPAuth.TOTP.generate({
        secret: OTPAuth.Secret.fromBase32(enrolment.secret),
        period: 30,
        digits: 6,
        algorithm: 'SHA1',
        timestamp: NOW.getTime(),
      }),
      NOW,
    );
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));

    await request('jdoe');
    expect(await preflightPasswordReset(tenantId, tokenFromMail()!, NOW)).toEqual({
      valid: true,
      requiresFactor: true,
      acceptableFactors: ['totp', 'recovery_code'],
    });
  });

  it('reports an unknown token as invalid', async () => {
    expect(await preflightPasswordReset(tenantId, 'nope', NOW)).toEqual({ valid: false });
  });
});

describe('completePasswordReset', () => {
  const complete = (over: Record<string, unknown> = {}) =>
    completePasswordReset(tenantId, transport, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      relyingParty: RP,
      sourceIp: '10.1.2.3',
      now: NOW,
      ...over,
    });

  it('sets the new password', async () => {
    await request('jdoe');
    expect(await complete()).toEqual({ ok: true });

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(await verifyPassword(credential.hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(credential.hash, PASSWORD)).toBe(false);
  });

  it('refuses the token a second time', async () => {
    await request('jdoe');
    const token = tokenFromMail()!;
    await complete({ token });
    expect(await complete({ token })).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses an expired token', async () => {
    await request('jdoe');
    const late = new Date(NOW.getTime() + 31 * 60 * 1000);
    expect(await complete({ now: late })).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a password the tenant policy rejects, without spending the token', async () => {
    await request('jdoe');
    expect(await complete({ newPassword: 'short' })).toEqual({
      ok: false,
      reason: 'weak_password',
      detail: 'too_short',
    });
    // Still usable: a rejected password is the user's typo, not an attack.
    expect(await complete()).toEqual({ ok: true });
  });

  it('revokes every session', async () => {
    const token = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    await request('jdoe');
    await complete();
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token.token))).toBeNull();
  });

  it('revokes every refresh token', async () => {
    await withTenant(tenantId, (tx) =>
      tx.refreshToken.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'stand-in-for-an-access-ii-token',
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    );
    await request('jdoe');
    await complete();
    const rows = await withTenant(tenantId, (tx) => tx.refreshToken.findMany());
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it('writes an audit event', async () => {
    await request('jdoe');
    await complete();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_reset_completed' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
  });

  it('tells the user their password changed', async () => {
    await request('jdoe');
    await complete();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.subject).toContain('password was changed');
  });
});

describe('completePasswordReset with a second factor', () => {
  let codes: string[];

  beforeEach(async () => {
    codes = await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, userId));
    await request('jdoe');
  });

  it('refuses without the factor — otherwise reset is a way around MFA', async () => {
    const outcome = await completePasswordReset(tenantId, transport, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'factor_required' });

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
    );
    expect(await verifyPassword(credential.hash, PASSWORD)).toBe(true);
  });

  it('refuses a wrong factor without spending the token', async () => {
    const token = tokenFromMail()!;
    const bad = await completePasswordReset(tenantId, transport, {
      token,
      newPassword: NEW_PASSWORD,
      factor: { type: 'recovery_code', code: 'ZZZZZ-ZZZZZ' },
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(bad).toEqual({ ok: false, reason: 'factor_invalid' });

    const good = await completePasswordReset(tenantId, transport, {
      token,
      newPassword: NEW_PASSWORD,
      factor: { type: 'recovery_code', code: codes[0]! },
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(good).toEqual({ ok: true });
  });

  it('accepts a valid factor and spends it', async () => {
    const outcome = await completePasswordReset(tenantId, transport, {
      token: tokenFromMail()!,
      newPassword: NEW_PASSWORD,
      factor: { type: 'recovery_code', code: codes[0]! },
      relyingParty: RP,
      sourceIp: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true });

    const spent = await withTenant(tenantId, (tx) =>
      tx.recoveryCode.count({ where: { userId, usedAt: { not: null } } }),
    );
    expect(spent).toBe(1);
  });
});
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/auth/password-reset.test.ts`
Expected: FAIL — cannot resolve `./password-reset.js`.

- [ ] **Step 8: Implement the reset flow**

`packages/core/src/auth/password-reset.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import {
  renderMessage,
  sendMessage,
  type Transport,
} from '../notify/notification-service.js';
import { currentTenant } from '../tenant-context.js';
import { hashPassword, setPasswordHash } from './password.js';
import { validateNewPassword } from './password-policy.js';
import { revokeAllForUser } from './session-service.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.js';
import { enrolledFactorTypes, hasRecoveryCodes, verifyFactor } from './mfa/registry.js';
import type { RelyingParty } from './mfa/relying-party.js';
import type { FactorPresentation } from './mfa/types.js';

export const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface RequestResetInput {
  login: string;
  sourceIp: string | null;
  now?: Date | undefined;
}

/**
 * Step 1 and 2 of spec section 9.
 *
 * Always resolves, and always the same way. The caller's HTTP response does not
 * depend on whether the account exists, whether it is active, or whether its
 * password is held here at all — every one of those distinctions would turn the
 * form into an account-existence oracle. What actually happened goes to the
 * audit log and, for a real user, to their inbox.
 *
 * The SMTP send is deliberately outside every transaction. `withTenant` is
 * `prisma.$transaction`, whose default timeout is 5000 ms; a mail server that
 * takes six seconds to answer would abort the transaction and roll back the
 * token that was just written, leaving the user with a link that does not work.
 */
export async function requestPasswordReset(
  tenantId: string,
  transport: Transport,
  publicUrl: string,
  input: RequestResetInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const needle = input.login.trim();

  // One read, two facts. The tenant name is needed to render either message,
  // and pulling it out here is what lets every send below happen outside a
  // transaction — `withTenant` is `prisma.$transaction`, and an SMTP server
  // that takes six seconds to answer would abort it and roll back the token
  // that was just written, leaving the user with a link that does not work.
  const { user, tenantName } = await withTenant(tenantId, async (tx) => ({
    user: await tx.user.findFirst({
      where: { OR: [{ login: needle }, { email: needle }] },
    }),
    tenantName: (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name,
  }));

  if (!user || user.status !== 'active') {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: user?.id ?? null,
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user?.id ?? null,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { login: needle, reason: user ? 'user_inactive' : 'unknown_login' },
      }),
    );
    return;
  }

  if (user.passwordSource !== 'local') {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user.id,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { login: needle, reason: 'password_is_upstream' },
      }),
    );
    // Rendered and sent with no transaction open. `sendMessage` takes no
    // `TenantClient` precisely so this cannot regress.
    await sendMessage(
      transport,
      renderMessage(tenantName, 'password-reset-upstream', user.email, {
        displayName: user.displayName,
        provider: user.passwordSourceHint ?? 'your organization identity provider',
      }),
    );
    return;
  }

  const token = randomBytes(32).toString('base64url');

  try {
    await withTenant(tenantId, async (tx) => {
      // A partial unique index allows one live token per user, so the previous
      // one is consumed rather than left valid alongside the new one.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          tenantId: await currentTenant(tx),
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS),
        },
      });
      await recordEvent(tx, {
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user.id,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: { login: needle },
      });
    });
  } catch (cause) {
    // Two requests for the same account at once: one wins the partial unique
    // index and the other violates it. Letting that escape would turn into a
    // 500 where an unknown login gets a 202, which is an account-existence
    // oracle built out of an error page. The loser sends nothing; the winner's
    // mail is already on its way.
    const code = (cause as { code?: string }).code;
    if (code === 'P2002') return;
    throw cause;
  }

  const resetUrl = `${publicUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
  await sendMessage(
    transport,
    renderMessage(tenantName, 'password-reset', user.email, {
      displayName: user.displayName,
      resetUrl,
    }),
  );
}

type TokenRow = { id: string; userId: string };

async function liveToken(
  tx: TenantClient,
  token: string,
  now: Date,
): Promise<TokenRow | null> {
  const row = await tx.passwordResetToken.findFirst({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, userId: row.userId };
}

export type ResetPreflight =
  | { valid: false }
  | {
      valid: true;
      requiresFactor: boolean;
      acceptableFactors: FactorPresentation['type'][];
    };

/**
 * What the reset screen needs to know: whether the link still works, and
 * whether a second factor must be presented alongside the new password.
 *
 * This discloses nothing an attacker does not already have, because it is
 * gated on holding a valid token — which only arrives in the account owner's
 * inbox.
 */
export async function preflightPasswordReset(
  tenantId: string,
  token: string,
  now: Date = new Date(),
): Promise<ResetPreflight> {
  return withTenant(tenantId, async (tx) => {
    const row = await liveToken(tx, token, now);
    if (!row) return { valid: false };

    const factors = await enrolledFactorTypes(tx, row.userId);
    const acceptable: FactorPresentation['type'][] = [...factors];
    if (await hasRecoveryCodes(tx, row.userId)) acceptable.push('recovery_code');

    return {
      valid: true,
      requiresFactor: acceptable.length > 0,
      acceptableFactors: acceptable,
    };
  });
}

export interface CompleteResetInput {
  token: string;
  newPassword: string;
  factor?: FactorPresentation | undefined;
  /**
   * Required even when no factor is presented. A WebAuthn assertion cannot be
   * verified without it, and making it conditional would mean the one call
   * that needs it is the one a caller forgets.
   */
  relyingParty: RelyingParty;
  sourceIp: string | null;
  now?: Date | undefined;
}

export type ResetOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid_token' | 'factor_required' | 'factor_invalid' | 'weak_password';
      detail?: string;
    };

/**
 * Steps 3 and 4 of spec section 9.
 *
 * A user who has registered a second factor must present it. Without that, a
 * mailbox compromise would be enough to take an account that its owner
 * deliberately protected with a hardware key — password reset would be the way
 * around MFA rather than a path through it.
 *
 * Completion revokes every session and every refresh token. A password change
 * that leaves the attacker's existing session alive has changed nothing.
 */
export async function completePasswordReset(
  tenantId: string,
  transport: Transport,
  input: CompleteResetInput,
): Promise<ResetOutcome> {
  const now = input.now ?? new Date();

  const context = await withTenant(tenantId, async (tx) => {
    const row = await liveToken(tx, input.token, now);
    if (!row) return null;
    const user = await tx.user.findUnique({ where: { id: row.userId } });
    if (!user || user.status !== 'active' || user.passwordSource !== 'local') return null;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    const factors = await enrolledFactorTypes(tx, row.userId);
    const acceptable: FactorPresentation['type'][] = [...factors];
    if (await hasRecoveryCodes(tx, row.userId)) acceptable.push('recovery_code');

    return {
      tokenId: row.id,
      user,
      minLength: tenant.passwordMinLength,
      // Carried out of the transaction so the confirmation mail can be
      // rendered and sent without opening another one.
      tenantName: tenant.name,
      acceptable,
    };
  });

  if (!context) return { ok: false, reason: 'invalid_token' };

  // Checked before anything is spent: a weak password is a typo, and costing
  // the user their link for it would send them back to their inbox.
  const check = validateNewPassword(input.newPassword, {
    minLength: context.minLength,
    login: context.user.login,
    email: context.user.email,
  });
  if (!check.ok) return { ok: false, reason: 'weak_password', detail: check.reason };

  if (context.acceptable.length > 0) {
    if (!input.factor) return { ok: false, reason: 'factor_required' };
    if (!context.acceptable.includes(input.factor.type)) {
      return { ok: false, reason: 'factor_invalid' };
    }
    // Outside a transaction: signature and hash work, possibly a network read.
    const verified = await verifyFactor(tenantId, context.user.id, input.factor, {
      now,
      relyingParty: input.relyingParty,
    });
    if (!verified.ok) {
      await withTenant(tenantId, (tx) =>
        recordEvent(tx, {
          actorUserId: context.user.id,
          action: 'auth.password_reset_factor_failed',
          targetType: 'User',
          targetId: context.user.id,
          outcome: 'failure',
          sourceIp: input.sourceIp,
          payload: { reason: verified.reason, factor: input.factor!.type },
        }),
      );
      return { ok: false, reason: 'factor_invalid' };
    }
  }

  // Argon2 hashing is deliberately expensive, so it happens here, before any
  // transaction opens, rather than inside one.
  const hash = await hashPassword(input.newPassword);

  const consumed = await withTenant(tenantId, (tx) =>
    tx.passwordResetToken.updateMany({
      where: { id: context.tokenId, consumedAt: null },
      data: { consumedAt: now },
    }),
  );
  if (consumed.count !== 1) return { ok: false, reason: 'invalid_token' };

  await withTenant(tenantId, async (tx) => {
    await setPasswordHash(tx, context.user.id, hash);
    await revokeAllForUser(tx, context.user.id);
    await revokeAllRefreshTokensForUser(tx, context.user.id);
    await recordEvent(tx, {
      actorUserId: context.user.id,
      action: 'auth.password_reset_completed',
      targetType: 'User',
      targetId: context.user.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: { factorPresented: input.factor?.type ?? null },
    });
  });

  await sendMessage(
    transport,
    renderMessage(context.tenantName, 'password-changed', context.user.email, {
      displayName: context.user.displayName,
    }),
  );

  return { ok: true };
}
```

`setPassword` calls `hashPassword` internally, which would put Argon2 inside
the transaction. Add to `packages/core/src/auth/password.ts`:

```ts
/**
 * Writes an already-computed hash. The hashing itself is the caller's job, so
 * it can happen outside a transaction — Argon2id is deliberately expensive and
 * has no business inside Prisma's 5000 ms transaction budget.
 */
export async function setPasswordHash(
  tx: TenantClient,
  userId: string,
  hash: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  await tx.passwordCredential.upsert({
    where: { userId },
    create: { tenantId, userId, hash },
    update: { hash },
  });
}
```

- [ ] **Step 9: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/auth/password-reset.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 10: Write the contracts**

`packages/contracts/src/reset.ts`:

```ts
import { z } from 'zod';

export const resetRequestRequest = z.object({
  login: z.string().min(1).max(320),
});

export const resetPreflightRequest = z.object({
  token: z.string().min(1).max(256),
});

export const resetCompleteRequest = z.object({
  token: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(1024),
  factor: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('totp'), code: z.string().min(6).max(6) }),
      z.object({ type: z.literal('recovery_code'), code: z.string().min(1).max(64) }),
      z.object({ type: z.literal('webauthn'), assertion: z.record(z.unknown()) }),
    ])
    .optional(),
});
export type ResetCompleteRequest = z.input<typeof resetCompleteRequest>;

export const resetPreflightResponse = z.object({
  valid: z.boolean(),
  requiresFactor: z.boolean(),
  acceptableFactors: z.array(z.enum(['totp', 'webauthn', 'recovery_code'])),
});

export const patchUserRequest = z.object({
  passwordSource: z.enum(['local', 'upstream']).optional(),
  passwordSourceHint: z.string().max(256).nullable().optional(),
});
export type PatchUserRequest = z.input<typeof patchUserRequest>;
```

Add `export * from './reset.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 11: Write the failing route test**

`apps/api/src/routes/password-reset.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { createUser, setPassword } from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
  });
});

const post = (url: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url, headers: { host: ctx.host }, payload });

const tokenFromMail = () => {
  const match = /token=([A-Za-z0-9_-]+)/.exec(ctx.mail.sent[0]?.text ?? '');
  return match![1]!;
};

describe('POST /api/auth/password-reset/request', () => {
  it('answers identically for a known and an unknown login', async () => {
    const known = await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const unknown = await post('/api/auth/password-reset/request', { login: 'nobody' });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  });

  it('sends the mail for the known one only', async () => {
    await post('/api/auth/password-reset/request', { login: 'nobody' });
    expect(ctx.mail.sent).toHaveLength(0);
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    expect(ctx.mail.sent).toHaveLength(1);
  });
});

describe('POST /api/auth/password-reset/complete', () => {
  it('sets the password and lets the user sign in with it', async () => {
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const res = await post('/api/auth/password-reset/complete', {
      token: tokenFromMail(),
      newPassword: 'a completely different passphrase',
    });
    expect(res.statusCode).toBe(204);

    const login = await post('/api/auth/login', {
      login: 'jdoe',
      password: 'a completely different passphrase',
    });
    expect(login.statusCode).toBe(200);
  });

  it('reports a weak password with a usable message', async () => {
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const res = await post('/api/auth/password-reset/complete', {
      token: tokenFromMail(),
      newPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().type).toContain('weak-password');
    expect(res.json().detail).toBeTruthy();
  });

  it('reports a spent, expired or unknown token identically', async () => {
    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    const token = tokenFromMail();
    await post('/api/auth/password-reset/complete', {
      token,
      newPassword: 'a completely different passphrase',
    });

    const spent = await post('/api/auth/password-reset/complete', {
      token,
      newPassword: 'yet another passphrase entirely',
    });
    const unknown = await post('/api/auth/password-reset/complete', {
      token: 'never-issued',
      newPassword: 'yet another passphrase entirely',
    });
    expect(spent.statusCode).toBe(400);
    expect(spent.json()).toEqual(unknown.json());
  });

  it('signs every existing session out', async () => {
    const login = await post('/api/auth/login', { login: 'jdoe', password: PASSWORD });
    const cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;

    await post('/api/auth/password-reset/request', { login: 'jdoe' });
    await post('/api/auth/password-reset/complete', {
      token: tokenFromMail(),
      newPassword: 'a completely different passphrase',
    });

    const probe = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
    });
    expect(probe.statusCode).toBe(401);
  });
});
```

- [ ] **Step 12: Give the test app a mail transport**

In `apps/api/src/test-support.ts`, replace the return with one that carries the
transport, and pass it into `buildApp`:

```ts
  const mail = memoryTransport();
  const app = await buildApp(config, { logger: false, transport: mail });
  return { app, tenantId: tenant.id, host: TEST_HOST, mail };
```

Add `transport?: Transport` to `AppOptions` in `apps/api/src/app.ts`, defaulting
to `smtpTransport(config.smtpUrl)`. No test run can put mail on the wire, which
is the same reason `memoryTransport` exists.

- [ ] **Step 13: Implement the routes**

`apps/api/src/routes/password-reset.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  resetCompleteRequest,
  resetPreflightRequest,
  resetRequestRequest,
} from '@syntra/contracts';
import {
  completePasswordReset,
  preflightPasswordReset,
  requestPasswordReset,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { tenantRelyingParty } from './relying-party.js';

export interface PasswordResetRouteOptions {
  transport: Transport;
  publicUrl: string;
  authRateLimitMax: number;
}

export async function registerPasswordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRouteOptions,
): Promise<void> {
  const LIMIT = {
    rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
  };

  app.post('/request', { config: LIMIT }, async (request, reply) => {
    const body = resetRequestRequest.parse(request.body);

    // Awaited rather than fired and forgotten, so a mail failure is logged
    // rather than becoming an unhandled rejection. The response body and status
    // do not depend on what happened inside.
    await requestPasswordReset(request.tenantId, options.transport, options.publicUrl, {
      login: body.login,
      sourceIp: request.ip,
    });

    return reply.status(202).send({ ok: true });
  });

  app.post('/preflight', { config: LIMIT }, async (request) => {
    const body = resetPreflightRequest.parse(request.body);
    const result = await preflightPasswordReset(request.tenantId, body.token);
    return result.valid
      ? result
      : { valid: false, requiresFactor: false, acceptableFactors: [] };
  });

  app.post('/complete', { config: LIMIT }, async (request, reply) => {
    const body = resetCompleteRequest.parse(request.body);
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );

    const factor =
      body.factor === undefined
        ? undefined
        : body.factor.type === 'webauthn'
          ? ({ type: 'webauthn', assertion: body.factor.assertion } as const)
          : ({ type: body.factor.type, code: body.factor.code } as const);

    const outcome = await completePasswordReset(request.tenantId, options.transport, {
      token: body.token,
      newPassword: body.newPassword,
      ...(factor === undefined ? {} : { factor }),
      // From the tenant, not the request. A WebAuthn assertion presented to
      // complete a reset is verified against the tenant's own origin, the same
      // as everywhere else — this endpoint is unauthenticated, so it is the
      // last place that should trust a header.
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
      sourceIp: request.ip,
    });

    if (outcome.ok) return reply.status(204).send();

    if (outcome.reason === 'weak_password') {
      throw new ProblemError(
        400,
        'weak-password',
        'That password does not meet the policy',
        outcome.detail === 'too_short'
          ? 'Choose a longer password.'
          : outcome.detail === 'too_long'
            ? 'Choose a shorter password.'
            : 'Choose something less predictable than your own name or login.',
      );
    }
    if (outcome.reason === 'factor_required') {
      throw new ProblemError(
        400,
        'factor-required',
        'A second factor is required',
        'This account has a second factor registered, so resetting the password needs it too.',
      );
    }
    if (outcome.reason === 'factor_invalid') {
      throw new ProblemError(400, 'factor-invalid', 'That second factor was not accepted');
    }
    // Unknown, spent and expired all land here and read the same.
    throw new ProblemError(
      400,
      'invalid-reset-token',
      'That reset link is no longer usable',
      'Request a new one.',
    );
  });
}
```

Register it in `apps/api/src/app.ts`:

```ts
  await app.register(registerPasswordResetRoutes, {
    prefix: '/api/auth/password-reset',
    transport,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
  });
```

- [ ] **Step 14: Add the administrative PATCH**

In `apps/api/src/routes/admin/users.ts`:

```ts
  app.patch(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchUserRequest.parse(request.body);

      const updated = await request.db(async (tx) => {
        const user = await tx.user.update({
          where: { id },
          data: {
            ...(body.passwordSource === undefined
              ? {}
              : { passwordSource: body.passwordSource }),
            ...(body.passwordSourceHint === undefined
              ? {}
              : { passwordSourceHint: body.passwordSourceHint }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.update',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { passwordSource: user.passwordSource },
        });
        return user;
      });

      return { id: updated.id, passwordSource: updated.passwordSource };
    },
  );
```

- [ ] **Step 15: Export and commit**

The three modules this task adds are exported here, not in Task 11 — the route
written in Step 13 imports `requestPasswordReset` and friends from
`@syntra/core`, and a task whose own code does not compile is not a task.

Add to `packages/core/src/index.ts`:

```ts
export * from './auth/password-policy.js';
export * from './auth/refresh-token.js';
export * from './auth/password-reset.js';
```

```bash
pnpm exec tsc -b
pnpm vitest run packages/core/src/auth packages/core/src/notify apps/api/src/routes
git add -A
git commit -m "feat: add enumeration-safe self-service password reset"
```

---

## Task 11: Application catalog and assignment resolution

**Files:**
- Create: `packages/core/src/access/application-service.ts`
- Create: `packages/core/src/access/assignment-service.ts`
- Create: `packages/core/src/access/resolve.ts`
- Modify: `packages/core/src/rbac/permissions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/access/resolve.test.ts`

**Interfaces:**
- Consumes: `TenantClient`, `currentTenant`, `listGroupsForUser`.
- Produces:
  - `interface CreateApplicationInput { name: string; slug: string; description?: string | null; iconUrl?: string | null; launchUrl?: string | null; type?: string; visibility?: 'assigned' | 'hidden' }`
  - `function createApplication(tx: TenantClient, input: CreateApplicationInput)`
  - `function updateApplication(tx: TenantClient, id: string, input: Partial<CreateApplicationInput> & { status?: string })`
  - `function listApplications(tx: TenantClient)`
  - `function findApplication(tx: TenantClient, id: string)`
  - `type AssignmentSubject = { type: 'user'; id: string } | { type: 'group'; id: string } | { type: 'orgUnit'; id: string }`
  - `function assignApplication(tx: TenantClient, applicationId: string, subject: AssignmentSubject): Promise<void>`
  - `function unassignApplication(tx: TenantClient, assignmentId: string): Promise<void>`
  - `function listAssignments(tx: TenantClient, applicationId: string)`
  - `function resolveApplicationIdsForUser(tx: TenantClient, userId: string): Promise<Set<string>>`
  - `function resolveApplicationsForUser(tx: TenantClient, userId: string)`
  - `function isApplicationAssigned(tx: TenantClient, userId: string, applicationId: string): Promise<boolean>`
  - `PERMISSIONS.ACCESS_READ = 'access.read'`, `PERMISSIONS.ACCESS_MANAGE = 'access.manage'`, `PERMISSIONS.POLICY_READ = 'policy.read'`, `PERMISSIONS.POLICY_MANAGE = 'policy.manage'`

- [ ] **Step 1: Add the permissions**

In `packages/core/src/rbac/permissions.ts`, add to `PERMISSIONS`:

```ts
  ACCESS_READ: 'access.read',
  ACCESS_MANAGE: 'access.manage',
  POLICY_READ: 'policy.read',
  POLICY_MANAGE: 'policy.manage',
```

`ALL_PERMISSIONS` derives from the object, so the seed's Owner role picks them
up with no further change.

- [ ] **Step 2: Write the failing resolution test**

`packages/core/src/access/resolve.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { createOrgUnit } from '../directory/org-unit-service.js';
import { createUser } from '../directory/user-service.js';
import { createApplication, updateApplication } from './application-service.js';
import { assignApplication, listAssignments, unassignApplication } from './assignment-service.js';
import {
  isApplicationAssigned,
  resolveApplicationsForUser,
  resolveApplicationIdsForUser,
} from './resolve.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const app = (slug: string) =>
  withTenant(tenantId, (tx) =>
    createApplication(tx, {
      name: slug.toUpperCase(),
      slug,
      launchUrl: `https://${slug}.acme.test/`,
    }),
  );

const names = async () => {
  const rows = await withTenant(tenantId, (tx) => resolveApplicationsForUser(tx, userId));
  return rows.map((r) => r.slug).sort();
};

describe('resolveApplicationsForUser', () => {
  it('returns nothing when nothing is assigned', async () => {
    await app('crm');
    expect(await names()).toEqual([]);
  });

  it('returns an application assigned directly to the user', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'user', id: userId }),
    );
    expect(await names()).toEqual(['crm']);
  });

  it('returns an application assigned to a group the user is in', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('does not return an application assigned to a group the user left', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
    });
    expect(await names()).toEqual([]);
  });

  it('returns an application assigned to the user org unit', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const ou = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: ou.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: ou.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('inherits an assignment made on a parent org unit', async () => {
    // An assignment on Head Office that did not reach Care would make the org
    // tree decorative: every grant would have to be repeated at every leaf.
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: care.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: head.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('does not inherit downwards from a child org unit', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const head = await createOrgUnit(tx, 'Head Office');
      const care = await createOrgUnit(tx, 'Care', head.id);
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: head.id } });
      await assignApplication(tx, crm.id, { type: 'orgUnit', id: care.id });
    });
    expect(await names()).toEqual([]);
  });

  it('is a union: the same application through two paths appears once', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
    });
    expect(await names()).toEqual(['crm']);
  });

  it('is a union: different applications through different paths all appear', async () => {
    const crm = await app('crm');
    const wiki = await app('wiki');
    const rota = await app('rota');
    await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await addMember(tx, g.id, userId);
      const ou = await createOrgUnit(tx, 'Care');
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: ou.id } });

      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, wiki.id, { type: 'group', id: g.id });
      await assignApplication(tx, rota.id, { type: 'orgUnit', id: ou.id });
    });
    expect(await names()).toEqual(['crm', 'rota', 'wiki']);
  });

  it('leaves out an application that has been retired', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await updateApplication(tx, crm.id, { status: 'inactive' });
    });
    expect(await names()).toEqual([]);
  });

  it('leaves a hidden application out of the portal but keeps it resolvable', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await updateApplication(tx, crm.id, { visibility: 'hidden' });
    });
    expect(await names()).toEqual([]);
    expect(
      await withTenant(tenantId, (tx) => isApplicationAssigned(tx, userId, crm.id)),
    ).toBe(true);
  });

  it('returns tiles ordered by name so the portal is stable between loads', async () => {
    const zebra = await app('zebra');
    const alpha = await app('alpha');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, zebra.id, { type: 'user', id: userId });
      await assignApplication(tx, alpha.id, { type: 'user', id: userId });
    });
    const rows = await withTenant(tenantId, (tx) => resolveApplicationsForUser(tx, userId));
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'zebra']);
  });

  it('drops the assignment when the application is removed', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, (tx) =>
      assignApplication(tx, crm.id, { type: 'user', id: userId }),
    );
    await withTenant(tenantId, (tx) => tx.application.delete({ where: { id: crm.id } }));
    expect(await withTenant(tenantId, (tx) => tx.appAssignment.count())).toBe(0);
  });
});

describe('assignments', () => {
  it('is idempotent', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
    });
    expect(await withTenant(tenantId, (tx) => listAssignments(tx, crm.id))).toHaveLength(1);
  });

  it('removes only the named assignment', async () => {
    const crm = await app('crm');
    const rows = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Nurses');
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await assignApplication(tx, crm.id, { type: 'group', id: g.id });
      return listAssignments(tx, crm.id);
    });
    await withTenant(tenantId, (tx) => unassignApplication(tx, rows[0]!.id));
    expect(await withTenant(tenantId, (tx) => listAssignments(tx, crm.id))).toHaveLength(1);
  });
});

describe('resolveApplicationIdsForUser', () => {
  it('includes hidden applications, which the portal filter then removes', async () => {
    const crm = await app('crm');
    await withTenant(tenantId, async (tx) => {
      await assignApplication(tx, crm.id, { type: 'user', id: userId });
      await updateApplication(tx, crm.id, { visibility: 'hidden' });
    });
    const ids = await withTenant(tenantId, (tx) => resolveApplicationIdsForUser(tx, userId));
    expect([...ids]).toEqual([crm.id]);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run packages/core/src/access/resolve.test.ts`
Expected: FAIL — cannot resolve `./application-service.js`.

- [ ] **Step 4: Implement the catalog**

`packages/core/src/access/application-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type ApplicationVisibility = 'assigned' | 'hidden';

export interface CreateApplicationInput {
  name: string;
  slug: string;
  description?: string | null | undefined;
  iconUrl?: string | null | undefined;
  launchUrl?: string | null | undefined;
  /** 'bookmark' today. Access II adds 'saml' and 'oidc'. */
  type?: string | undefined;
  visibility?: ApplicationVisibility | undefined;
}

export async function createApplication(
  tx: TenantClient,
  input: CreateApplicationInput,
) {
  const existing = await tx.application.findFirst({ where: { slug: input.slug } });
  if (existing) {
    // Checked explicitly rather than left to the unique constraint, so the
    // caller gets a domain error it can map to 409 instead of a driver error.
    throw new Error(`slug already exists: ${input.slug}`);
  }
  const tenantId = await currentTenant(tx);
  return tx.application.create({
    data: {
      tenantId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      iconUrl: input.iconUrl ?? null,
      launchUrl: input.launchUrl ?? null,
      type: input.type ?? 'bookmark',
      visibility: input.visibility ?? 'assigned',
    },
  });
}

export async function updateApplication(
  tx: TenantClient,
  id: string,
  input: Partial<CreateApplicationInput> & { status?: string | undefined },
) {
  return tx.application.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
      ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  });
}

export async function listApplications(tx: TenantClient) {
  return tx.application.findMany({ orderBy: { name: 'asc' } });
}

export async function findApplication(tx: TenantClient, id: string) {
  return tx.application.findUnique({ where: { id } });
}
```

`packages/core/src/access/assignment-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type AssignmentSubject =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string }
  | { type: 'orgUnit'; id: string };

/**
 * Grants an application to one subject. Idempotent: the same grant twice is one
 * assignment.
 *
 * Not an upsert. Prisma cannot address a compound unique key holding a null,
 * and for good reason — SQL treats NULL as distinct from NULL, so a compound
 * constraint over the three nullable subject columns would not constrain
 * anything at all. Three partial unique indexes enforce it in the database;
 * this lookup keeps the call idempotent rather than throwing.
 */
export async function assignApplication(
  tx: TenantClient,
  applicationId: string,
  subject: AssignmentSubject,
): Promise<void> {
  const where = {
    applicationId,
    userId: subject.type === 'user' ? subject.id : null,
    groupId: subject.type === 'group' ? subject.id : null,
    orgUnitId: subject.type === 'orgUnit' ? subject.id : null,
  };

  const existing = await tx.appAssignment.findFirst({ where });
  if (existing) return;

  const tenantId = await currentTenant(tx);
  await tx.appAssignment.create({
    data: { tenantId, subjectType: subject.type, ...where },
  });
}

export async function unassignApplication(
  tx: TenantClient,
  assignmentId: string,
): Promise<void> {
  await tx.appAssignment.deleteMany({ where: { id: assignmentId } });
}

export async function listAssignments(tx: TenantClient, applicationId: string) {
  return tx.appAssignment.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'asc' },
  });
}
```

`packages/core/src/access/resolve.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { listGroupsForUser } from '../directory/group-service.js';

/** A tree deep enough to hit this is a cycle, not an organization. */
const MAX_ORG_UNIT_DEPTH = 64;

/**
 * The org unit the user sits in, and every unit above it.
 *
 * An assignment made on Head Office reaches everyone under it; that is what
 * makes the tree worth having. It does not reach downwards: a grant to Care
 * does not follow the user up to Head Office.
 *
 * The depth cap and the seen-set are not paranoia — parentId is a self-relation
 * with no database-level acyclicity check, and a cycle introduced by a bad
 * import would otherwise hang every sign-in.
 */
async function orgUnitChain(tx: TenantClient, orgUnitId: string | null): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = orgUnitId;

  for (let depth = 0; current && depth < MAX_ORG_UNIT_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    const row = await tx.orgUnit.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = row?.parentId ?? null;
  }

  return chain;
}

/**
 * Every application the user resolves to, by any path.
 *
 * A union of three sets: assignments naming the user, assignments naming a
 * group they belong to, and assignments naming their org unit or one above it.
 * A retired application is excluded; a hidden one is not, because hidden means
 * "no tile", not "no access".
 */
export async function resolveApplicationIdsForUser(
  tx: TenantClient,
  userId: string,
): Promise<Set<string>> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { orgUnitId: true },
  });
  const groups = await listGroupsForUser(tx, userId);
  const orgUnitIds = await orgUnitChain(tx, user?.orgUnitId ?? null);

  const rows = await tx.appAssignment.findMany({
    where: {
      application: { status: 'active' },
      OR: [
        { userId },
        ...(groups.length > 0 ? [{ groupId: { in: groups.map((g) => g.id) } }] : []),
        ...(orgUnitIds.length > 0 ? [{ orgUnitId: { in: orgUnitIds } }] : []),
      ],
    },
    select: { applicationId: true },
  });

  return new Set(rows.map((row) => row.applicationId));
}

/** The tiles for the portal: resolved, visible, and ordered by name. */
export async function resolveApplicationsForUser(tx: TenantClient, userId: string) {
  const ids = await resolveApplicationIdsForUser(tx, userId);
  if (ids.size === 0) return [];

  return tx.application.findMany({
    where: { id: { in: [...ids] }, visibility: 'assigned' },
    orderBy: { name: 'asc' },
  });
}

export async function isApplicationAssigned(
  tx: TenantClient,
  userId: string,
  applicationId: string,
): Promise<boolean> {
  const ids = await resolveApplicationIdsForUser(tx, userId);
  return ids.has(applicationId);
}
```

- [ ] **Step 5: Run it to make sure it passes**

Run: `pnpm vitest run packages/core/src/access/resolve.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Export and commit**

Add to `packages/core/src/index.ts`:

```ts
export * from './access/application-service.js';
export * from './access/assignment-service.js';
export * from './access/resolve.js';
```

```bash
pnpm exec tsc -b
pnpm vitest run packages/core
git add -A
git commit -m "feat: add the application catalog and assignment resolution"
```

---

## Task 12: Access administration API

**Files:**
- Create: `packages/contracts/src/access.ts`
- Create: `packages/contracts/src/policy.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/admin/applications.ts`
- Create: `apps/api/src/routes/admin/policies.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/admin/access.test.ts`

**Interfaces:**
- Consumes: from Task 3 — `loadPolicy`, `setPolicyDefault`, `addRule`, `updateRule`, `deleteRule`, `reorderRules`, `RuleInput`. From Task 9 — `previewRuleImpact`, `ruleImpactResponse`. From Task 11 — `createApplication`, `updateApplication`, `listApplications`, `findApplication`, `assignApplication`, `unassignApplication`, `listAssignments`, `PERMISSIONS.ACCESS_*`, `PERMISSIONS.POLICY_*`.
- Produces: routes under `/api/admin/applications` and `/api/admin/policy`, including `POST /api/admin/policy/rules/impact`, and the zod schemas the web application imports.

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/access.ts`:

```ts
import { z } from 'zod';

export const applicationSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and hyphens');

export const createApplicationRequest = z.object({
  name: z.string().min(1).max(128),
  slug: applicationSlug,
  description: z.string().max(1024).optional(),
  iconUrl: z.string().url().max(2048).optional(),
  // Access I launches bookmarks. Access II widens this enum; the column is
  // already a free string, so that is a code change and not a migration.
  type: z.literal('bookmark').default('bookmark'),
  launchUrl: z.string().url().max(2048),
  visibility: z.enum(['assigned', 'hidden']).default('assigned'),
});
export type CreateApplicationRequest = z.input<typeof createApplicationRequest>;

export const updateApplicationRequest = createApplicationRequest
  .partial()
  .omit({ slug: true })
  .extend({ status: z.enum(['active', 'inactive']).optional() });
export type UpdateApplicationRequest = z.input<typeof updateApplicationRequest>;

export const assignApplicationRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.string().uuid() }),
  z.object({ type: z.literal('group'), id: z.string().uuid() }),
  z.object({ type: z.literal('orgUnit'), id: z.string().uuid() }),
]);
export type AssignApplicationRequest = z.infer<typeof assignApplicationRequest>;

export const assignmentParams = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
});

export const applicationTile = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
});
export type ApplicationTile = z.infer<typeof applicationTile>;
```

`packages/contracts/src/policy.ts`:

```ts
import { z } from 'zod';

export const policyOutcome = z.enum(['allow', 'require_mfa', 'require_factor', 'deny']);
export const policyFactorType = z.enum(['totp', 'webauthn']);
export const contractField = z.enum(['department', 'jobTitle', 'employer', 'location']);

const minuteOfDay = z.number().int().min(0).max(1439);

export const policyRuleRequest = z
  .object({
    name: z.string().min(1).max(128),
    enabled: z.boolean().default(true),
    outcome: policyOutcome,
    factorType: policyFactorType.nullable().default(null),
    applicationIds: z.array(z.string().uuid()).default([]),
    groupIds: z.array(z.string().uuid()).default([]),
    contractField: contractField.nullable().default(null),
    contractValues: z.array(z.string().min(1).max(256)).default([]),
    ipRanges: z.array(z.string().min(1).max(64)).default([]),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
    startMinute: minuteOfDay.nullable().default(null),
    endMinute: minuteOfDay.nullable().default(null),
    timezone: z.string().max(64).nullable().default(null),
  })
  .refine((v) => v.outcome !== 'require_factor' || v.factorType !== null, {
    message: 'Choose which factor this rule requires',
    path: ['factorType'],
  })
  .refine((v) => (v.startMinute === null) === (v.endMinute === null), {
    message: 'A time window needs both a start and an end',
    path: ['endMinute'],
  })
  .refine((v) => v.contractField === null || v.contractValues.length > 0, {
    message: 'Name at least one value to match',
    path: ['contractValues'],
  });
export type PolicyRuleRequest = z.input<typeof policyRuleRequest>;

export const policyDefaultRequest = z
  .object({
    outcome: policyOutcome,
    factorType: policyFactorType.nullable().default(null),
  })
  .refine((v) => v.outcome !== 'require_factor' || v.factorType !== null, {
    message: 'Choose which factor the default requires',
    path: ['factorType'],
  });
export type PolicyDefaultRequest = z.input<typeof policyDefaultRequest>;

export const reorderRulesRequest = z.object({
  ruleIds: z.array(z.string().uuid()).min(1),
});

export const ruleParams = z.object({ ruleId: z.string().uuid() });
```

Add both to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing route test**

`apps/api/src/routes/admin/access.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  ALL_PERMISSIONS,
  assignRole,
  createGroup,
  createRole,
  createUser,
  setPassword,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let adminCookie: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Ada',
    });
    await setPassword(tx, u.id, PASSWORD);
    const role = await createRole(tx, 'Owner', ALL_PERMISSIONS);
    await assignRole(tx, u.id, role.id);
    return u.id;
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;

  const elevated = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
    payload: { password: PASSWORD },
  });
  adminCookie = elevated.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  cookie = adminCookie,
) =>
  ctx.app.inject({
    method,
    url,
    headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });

const newApp = (slug = 'crm') =>
  call('POST', '/api/admin/applications', {
    name: 'CRM',
    slug,
    launchUrl: 'https://crm.acme.test/',
  });

describe('applications', () => {
  it('creates one and lists it', async () => {
    const created = await newApp();
    expect(created.statusCode).toBe(201);

    const list = await call('GET', '/api/admin/applications');
    expect(list.json().applications).toHaveLength(1);
    expect(list.json().applications[0]).toMatchObject({ slug: 'crm', type: 'bookmark' });
  });

  it('rejects a duplicate slug with 409', async () => {
    await newApp();
    expect((await newApp()).statusCode).toBe(409);
  });

  it('rejects a slug with capitals or spaces', async () => {
    const res = await call('POST', '/api/admin/applications', {
      name: 'CRM',
      slug: 'My CRM',
      launchUrl: 'https://crm.acme.test/',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a launch URL that is not a URL', async () => {
    const res = await call('POST', '/api/admin/applications', {
      name: 'CRM',
      slug: 'crm',
      launchUrl: 'javascript:alert(1)',
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a portal session', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'admin', password: PASSWORD },
    });
    const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    expect((await newApp('other')).statusCode).toBe(201);
    const res = await call('GET', '/api/admin/applications', undefined, portal);
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit event on creation', async () => {
    await newApp();
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'application.create' } }),
    );
    expect(events).toHaveLength(1);
  });
});

describe('assignments', () => {
  it('assigns to a user, a group and an org unit and lists them', async () => {
    const appId = (await newApp()).json().id;
    const groupId = await withTenant(ctx.tenantId, async (tx) =>
      (await createGroup(tx, 'Nurses')).id,
    );

    expect(
      (await call('POST', `/api/admin/applications/${appId}/assignments`, {
        type: 'user',
        id: userId,
      })).statusCode,
    ).toBe(201);
    expect(
      (await call('POST', `/api/admin/applications/${appId}/assignments`, {
        type: 'group',
        id: groupId,
      })).statusCode,
    ).toBe(201);

    const list = await call('GET', `/api/admin/applications/${appId}/assignments`);
    expect(list.json().assignments).toHaveLength(2);
  });

  it('is idempotent', async () => {
    const appId = (await newApp()).json().id;
    const body = { type: 'user', id: userId };
    await call('POST', `/api/admin/applications/${appId}/assignments`, body);
    await call('POST', `/api/admin/applications/${appId}/assignments`, body);
    const list = await call('GET', `/api/admin/applications/${appId}/assignments`);
    expect(list.json().assignments).toHaveLength(1);
  });

  it('removes one', async () => {
    const appId = (await newApp()).json().id;
    await call('POST', `/api/admin/applications/${appId}/assignments`, {
      type: 'user',
      id: userId,
    });
    const id = (await call('GET', `/api/admin/applications/${appId}/assignments`)).json()
      .assignments[0].id;
    expect(
      (await call('DELETE', `/api/admin/applications/${appId}/assignments/${id}`)).statusCode,
    ).toBe(204);
  });
});

describe('the policy', () => {
  it('starts empty with an allow default', async () => {
    const res = await call('GET', '/api/admin/policy');
    expect(res.json()).toEqual({
      fallback: { outcome: 'allow', factorType: null },
      rules: [],
    });
  });

  it('adds rules in order', async () => {
    await call('POST', '/api/admin/policy/rules', { name: 'First', outcome: 'allow' });
    await call('POST', '/api/admin/policy/rules', { name: 'Second', outcome: 'deny' });
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().rules.map((r: { name: string }) => r.name)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('rejects require_factor with no factor named', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'require_factor',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a half-specified time window', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'deny',
      startMinute: 540,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unusable timezone with a message naming the field', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'deny',
      startMinute: 0,
      endMinute: 60,
      timezone: 'Middle/Earth',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('timezone');
  });

  it('rejects a malformed CIDR', async () => {
    const res = await call('POST', '/api/admin/policy/rules', {
      name: 'Bad',
      outcome: 'deny',
      ipRanges: ['10.0.0.0/33'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('reorders', async () => {
    const a = (await call('POST', '/api/admin/policy/rules', { name: 'A', outcome: 'allow' })).json();
    const b = (await call('POST', '/api/admin/policy/rules', { name: 'B', outcome: 'allow' })).json();
    await call('PUT', '/api/admin/policy/rules/order', { ruleIds: [b.id, a.id] });
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().rules.map((r: { name: string }) => r.name)).toEqual(['B', 'A']);
  });

  it('deletes and closes the gap', async () => {
    await call('POST', '/api/admin/policy/rules', { name: 'A', outcome: 'allow' });
    const b = (await call('POST', '/api/admin/policy/rules', { name: 'B', outcome: 'allow' })).json();
    await call('POST', '/api/admin/policy/rules', { name: 'C', outcome: 'allow' });
    await call('DELETE', `/api/admin/policy/rules/${b.id}`);
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().rules.map((r: { position: number }) => r.position)).toEqual([1, 2]);
  });

  it('sets the tenant default', async () => {
    await call('PUT', '/api/admin/policy/default', {
      outcome: 'require_factor',
      factorType: 'webauthn',
    });
    const res = await call('GET', '/api/admin/policy');
    expect(res.json().fallback).toEqual({ outcome: 'require_factor', factorType: 'webauthn' });
  });

  it('reports how many users a rule would affect before it is saved', async () => {
    // The same shape of mistake Directory Sync's deactivation threshold exists
    // for: a change that touches everyone must not be indistinguishable from
    // one that touches nobody until after it has happened.
    const res = await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Everyone needs a factor',
      outcome: 'require_mfa',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      totalActiveUsers: 1,
      matchedUsers: 1,
      usersNeedingEnrolment: 1,
      unevaluatedConditions: [],
    });
  });

  it('names the conditions the preview could not test', async () => {
    const res = await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Offsite',
      outcome: 'deny',
      ipRanges: ['203.0.113.0/24'],
    });
    expect(res.json().unevaluatedConditions).toEqual(['source address']);
  });

  it('rate-limits the preview and requires the stronger permission', async () => {
    // Storing nothing is not the same as costing nothing: this endpoint can
    // count every user and every membership in the tenant, and it answers "how
    // many of your people have no second factor".
    const res = await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Everyone',
      outcome: 'require_mfa',
    });
    expect(res.statusCode).toBe(200);

    const reader = await withTenant(ctx.tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'reader',
        email: 'reader@acme.test',
        displayName: 'Reader',
      });
      await setPassword(tx, u.id, PASSWORD);
      const role = await createRole(tx, 'Policy reader', [PERMISSIONS.POLICY_READ]);
      await assignRole(tx, u.id, role.id);
      return u;
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'reader', password: PASSWORD },
    });
    const portal = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const elevated = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${portal}` },
      payload: { password: PASSWORD },
    });
    const readerCookie = elevated.cookies.find((c) => c.name === 'syntra_session')!.value;

    expect(reader.id).toBeTruthy();
    const refused = await call(
      'POST',
      '/api/admin/policy/rules/impact',
      { name: 'Everyone', outcome: 'require_mfa' },
      readerCookie,
    );
    expect(refused.statusCode).toBe(403);
  });

  it('previews without storing anything', async () => {
    await call('POST', '/api/admin/policy/rules/impact', {
      name: 'Everyone',
      outcome: 'require_mfa',
    });
    expect((await call('GET', '/api/admin/policy')).json().rules).toEqual([]);
  });

  it('writes an audit event for every policy change', async () => {
    await call('POST', '/api/admin/policy/rules', { name: 'A', outcome: 'deny' });
    await call('PUT', '/api/admin/policy/default', { outcome: 'deny' });
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetType: 'AuthPolicy' } }),
    );
    expect(events.map((e) => e.action).sort()).toEqual([
      'policy.default_set',
      'policy.rule_added',
    ]);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/access.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 4: Implement the application routes**

`apps/api/src/routes/admin/applications.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  assignApplicationRequest,
  assignmentParams,
  createApplicationRequest,
  idParam,
  updateApplicationRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  assignApplication,
  createApplication,
  findApplication,
  listApplications,
  listAssignments,
  recordEvent,
  unassignApplication,
  updateApplication,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export async function registerAdminApplicationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/applications',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => ({
      applications: await request.db((tx) => listApplications(tx)),
    }),
  );

  app.post(
    '/applications',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const body = createApplicationRequest.parse(request.body);

      const created = await request.db(async (tx) => {
        let application;
        try {
          application = await createApplication(tx, body);
        } catch (cause) {
          throw new ProblemError(
            409,
            'slug-taken',
            'That slug is already used',
            cause instanceof Error ? cause.message : undefined,
          );
        }
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.create',
          targetType: 'Application',
          targetId: application.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: application.slug, name: application.name },
        });
        return application;
      });

      return reply.status(201).send(created);
    },
  );

  app.put(
    '/applications/:id',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = updateApplicationRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await findApplication(tx, id);
        if (!existing) throw new ProblemError(404, 'not-found', 'Application not found');

        const updated = await updateApplication(tx, id, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.update',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: updated.slug, status: updated.status },
        });
        return updated;
      });
    },
  );

  app.get(
    '/applications/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return { assignments: await request.db((tx) => listAssignments(tx, id)) };
    },
  );

  app.post(
    '/applications/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const subject = assignApplicationRequest.parse(request.body);

      await request.db(async (tx) => {
        const application = await findApplication(tx, id);
        if (!application) throw new ProblemError(404, 'not-found', 'Application not found');

        await assignApplication(tx, id, subject);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.assign',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { subjectType: subject.type, subjectId: subject.id },
        });
      });

      return reply.status(201).send({ ok: true });
    },
  );

  app.delete(
    '/applications/:id/assignments/:assignmentId',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const { id, assignmentId } = assignmentParams.parse(request.params);

      await request.db(async (tx) => {
        await unassignApplication(tx, assignmentId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.unassign',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { assignmentId },
        });
      });

      return reply.status(204).send();
    },
  );
}
```

- [ ] **Step 5: Implement the policy routes**

`apps/api/src/routes/admin/policies.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  policyDefaultRequest,
  policyRuleRequest,
  reorderRulesRequest,
  ruleParams,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  addRule,
  deleteRule,
  loadPolicy,
  recordEvent,
  previewRuleImpact,
  reorderRules,
  setPolicyDefault,
  updateRule,
  type RuleInput,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * The service throws for a rule that could never be honoured — a malformed
 * CIDR, a timezone the platform cannot resolve. Those are the administrator's
 * mistakes, not server faults, so they come back as 400 with the message
 * attached rather than as a 500 with nothing.
 */
async function domainError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw new ProblemError(
      400,
      'invalid-policy-rule',
      'That rule cannot be stored as written',
      cause instanceof Error ? cause.message : undefined,
    );
  }
}

export interface PolicyRouteOptions {
  authRateLimitMax: number;
}

export async function registerAdminPolicyRoutes(
  app: FastifyInstance,
  options: PolicyRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/policy',
    { preHandler: requirePermission(PERMISSIONS.POLICY_READ) },
    async (request) => request.db((tx) => loadPolicy(tx)),
  );

  app.put(
    '/policy/default',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request) => {
      const body = policyDefaultRequest.parse(request.body);
      await request.db(async (tx) => {
        await domainError(() => setPolicyDefault(tx, body));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.default_set',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { outcome: body.outcome, factorType: body.factorType },
        });
      });
      return request.db((tx) => loadPolicy(tx));
    },
  );

  /**
   * How many people a rule would touch, answered before it is saved and
   * without storing anything. A rule requiring a second factor now sends
   * everyone it matches through forced enrolment on their next sign-in, and an
   * administrator is entitled to know how many people that is first.
   *
   * Rate-limited like a write and gated on POLICY_MANAGE rather than
   * POLICY_READ, despite storing nothing. It is the most expensive endpoint in
   * the console — it can count every user and every membership in the tenant —
   * and it answers "how many of your people have no second factor", which is
   * reconnaissance if it leaks. The permission to see that is the permission
   * to change the rule that acts on it.
   */
  app.post(
    '/policy/rules/impact',
    {
      preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE),
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = policyRuleRequest.parse(request.body);
      return request.db((tx) =>
        domainError(() => previewRuleImpact(tx, body as RuleInput)),
      );
    },
  );

  app.post(
    '/policy/rules',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const body = policyRuleRequest.parse(request.body);
      const rule = await request.db(async (tx) => {
        const created = await domainError(() => addRule(tx, body as RuleInput));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rule_added',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ruleId: created.id, name: created.name, outcome: created.outcome },
        });
        return created;
      });
      return reply.status(201).send(rule);
    },
  );

  app.put(
    '/policy/rules/order',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request) => {
      const body = reorderRulesRequest.parse(request.body);
      await request.db(async (tx) => {
        await domainError(() => reorderRules(tx, body.ruleIds));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rules_reordered',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { order: body.ruleIds },
        });
      });
      return request.db((tx) => loadPolicy(tx));
    },
  );

  app.put(
    '/policy/rules/:ruleId',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request) => {
      const { ruleId } = ruleParams.parse(request.params);
      const body = policyRuleRequest.parse(request.body);
      return request.db(async (tx) => {
        const updated = await domainError(() => updateRule(tx, ruleId, body as RuleInput));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rule_updated',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ruleId, name: updated.name, outcome: updated.outcome },
        });
        return updated;
      });
    },
  );

  app.delete(
    '/policy/rules/:ruleId',
    { preHandler: requirePermission(PERMISSIONS.POLICY_MANAGE) },
    async (request, reply) => {
      const { ruleId } = ruleParams.parse(request.params);
      await request.db(async (tx) => {
        await deleteRule(tx, ruleId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'policy.rule_deleted',
          targetType: 'AuthPolicy',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ruleId },
        });
      });
      return reply.status(204).send();
    },
  );
}
```

Register both in `apps/api/src/app.ts`:

```ts
  await app.register(registerAdminApplicationRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminPolicyRoutes, {
    prefix: '/api/admin',
    authRateLimitMax: config.authRateLimitMax,
  });
```

- [ ] **Step 6: Run and commit**

Run: `pnpm vitest run apps/api/src/routes/admin/access.test.ts`
Expected: PASS, 23 tests.

```bash
pnpm exec tsc -b
git add -A
git commit -m "feat: add application and policy administration API"
```

---

## Task 13: Portal tiles and launching through the chokepoint

**Files:**
- Create: `apps/api/src/routes/portal.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/pages/Portal.tsx`
- Test: `apps/api/src/routes/portal.test.ts`

**Interfaces:**
- Consumes: from Task 4 — `authorize`. From Task 11 — `resolveApplicationsForUser`, `isApplicationAssigned`, `findApplication`. From the existing codebase — `requireSession`, `ProblemError`, `recordEvent`.
- Produces:
  - `GET /api/portal/applications` → `{ applications: ApplicationTile[] }`
  - `POST /api/portal/applications/:id/launch` → `{ status: 'launch'; url: string }`, `{ status: 'challenge'; attemptToken: string; expiresAt: string; acceptableFactors: string[] }`, or `{ status: 'enrol'; attemptToken: string; expiresAt: string; enrollableFactors: string[] }`

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/portal.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  createApplication,
  createUser,
  localMasterKeyProvider,
  setPassword,
} from '@syntra/core';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let cookie: string;

const PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();

  userId = await withTenant(ctx.tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPassword(tx, u.id, PASSWORD);
    return u.id;
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const call = (method: 'GET' | 'POST', url: string, withCookie = true) =>
  ctx.app.inject({
    method,
    url,
    headers: {
      host: ctx.host,
      ...(withCookie ? { cookie: `syntra_session=${cookie}` } : {}),
    },
  });

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

/**
 * Enrols TOTP at a timestamp two minutes in the past.
 *
 * `confirmTotpEnrolment` sets the replay watermark to the step that confirmed
 * the enrolment, so a code generated at wall time immediately afterwards falls
 * in the same step and is correctly refused as a replay. Backdating puts the
 * watermark four steps behind and makes every test below deterministic instead
 * of dependent on where in the half-minute it ran.
 */
async function enrolTotpFor(id: string): Promise<string> {
  const past = new Date(Date.now() - 120_000);
  const enrolment = await withTenant(ctx.tenantId, (tx) =>
    beginTotpEnrolment(tx, provider, id),
  );
  const ok = await confirmTotpEnrolment(
    ctx.tenantId,
    provider,
    id,
    OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(enrolment.secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
      timestamp: past.getTime(),
    }),
    past,
  );
  expect(ok).toBe(true);
  return enrolment.secret;
}

async function assignedApp(slug = 'crm') {
  return withTenant(ctx.tenantId, async (tx) => {
    const application = await createApplication(tx, {
      name: 'CRM',
      slug,
      description: 'Customer records',
      launchUrl: 'https://crm.acme.test/',
    });
    await assignApplication(tx, application.id, { type: 'user', id: userId });
    return application;
  });
}

describe('GET /api/portal/applications', () => {
  it('needs a session', async () => {
    expect((await call('GET', '/api/portal/applications', false)).statusCode).toBe(401);
  });

  it('returns the tiles the user resolves to', async () => {
    await assignedApp();
    const res = await call('GET', '/api/portal/applications');
    expect(res.json().applications).toEqual([
      {
        id: expect.any(String),
        name: 'CRM',
        slug: 'crm',
        description: 'Customer records',
        iconUrl: null,
      },
    ]);
  });

  it('never returns the launch URL in the tile list', async () => {
    await assignedApp();
    const res = await call('GET', '/api/portal/applications');
    // The URL comes from /launch, which goes through the chokepoint. Putting it
    // in the tile would make the tile itself a way around policy.
    expect(res.body).not.toContain('crm.acme.test');
  });

  it('returns nothing for a user with no assignments', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, { name: 'CRM', slug: 'crm', launchUrl: 'https://crm.acme.test/' }),
    );
    expect((await call('GET', '/api/portal/applications')).json().applications).toEqual([]);
  });
});

describe('POST /api/portal/applications/:id/launch', () => {
  it('returns the launch URL for an assigned application', async () => {
    const application = await assignedApp();
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'launch', url: 'https://crm.acme.test/' });
  });

  it('refuses an application the user is not assigned', async () => {
    const application = await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, { name: 'HR', slug: 'hr', launchUrl: 'https://hr.acme.test/' }),
    );
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(403);
  });

  it('reports an unknown application exactly as an unassigned one', async () => {
    const unknown = await call(
      'POST',
      '/api/portal/applications/00000000-0000-4000-8000-000000000000/launch',
    );
    const application = await withTenant(ctx.tenantId, (tx) =>
      createApplication(tx, { name: 'HR', slug: 'hr', launchUrl: 'https://hr.acme.test/' }),
    );
    const unassigned = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(unknown.statusCode).toBe(unassigned.statusCode);
    expect(unknown.json()).toEqual(unassigned.json());
  });

  it('honours a policy rule scoped to that application', async () => {
    const application = await assignedApp();
    await enrolTotpFor(userId);

    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'challenge',
      acceptableFactors: ['totp'],
    });
    expect(res.body).not.toContain('crm.acme.test');
  });

  it('does not challenge for an application the rule does not name', async () => {
    const crm = await assignedApp('crm');
    const wiki = await assignedApp('wiki');
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM only',
        outcome: 'require_mfa',
        applicationIds: [crm.id],
      }),
    );
    const res = await call('POST', `/api/portal/applications/${wiki.id}/launch`);
    expect(res.json().status).toBe('launch');
  });

  it('refuses when a rule denies that application', async () => {
    const application = await assignedApp();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM closed',
        outcome: 'deny',
        applicationIds: [application.id],
      }),
    );
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(403);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.policy_denied' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ruleName: 'CRM closed' });
  });

  it('offers enrolment when a rule scoped to the application needs a factor', async () => {
    const application = await assignedApp();
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    // This user has enrolled nothing, so the launch cannot be a step-up.
    const res = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'enrol' });
    expect(res.body).not.toContain('crm.acme.test');
  });

  it('completes the challenge round trip and then launches', async () => {
    // The case whose absence let an application with a require_mfa rule be
    // permanently unlaunchable: launch issues a challenge, the challenge is
    // answered, and the relaunch is a fresh decision with nothing recorded as
    // satisfied — so it issues the same challenge again, and again.
    const application = await assignedApp();
    const secret = await enrolTotpFor(userId);
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    const challenged = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(challenged.json()).toMatchObject({ status: 'challenge' });

    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: {
        type: 'totp',
        attemptToken: challenged.json().attemptToken,
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });
    expect(verified.statusCode).toBe(200);

    // The step-up replaced the session cookie; the relaunch uses the new one.
    cookie = verified.cookies.find((c) => c.name === 'syntra_session')!.value;
    const launched = await call('POST', `/api/portal/applications/${application.id}/launch`);
    expect(launched.json()).toEqual({ status: 'launch', url: 'https://crm.acme.test/' });
  });

  it('gives a portal session to a portal user who completes a launch step-up', async () => {
    // The browser sends its cookie on every request, so "a session cookie was
    // present" is true for every launch step-up ever performed. Inferring
    // scope from it would hand an administrative session to any portal user
    // who clicked a tile.
    const application = await assignedApp();
    const secret = await enrolTotpFor(userId);
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, {
        name: 'CRM needs a factor',
        outcome: 'require_mfa',
        applicationIds: [application.id],
      }),
    );

    const challenged = await call('POST', `/api/portal/applications/${application.id}/launch`);
    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: {
        type: 'totp',
        attemptToken: challenged.json().attemptToken,
        code: OTPAuth.TOTP.generate({
          secret: OTPAuth.Secret.fromBase32(secret),
          period: 30,
          digits: 6,
          algorithm: 'SHA1',
        }),
      },
    });

    expect(verified.json().scope).toBe('portal');
    const attempt = await withTenant(ctx.tenantId, (tx) => tx.authAttempt.findFirst());
    expect(attempt!.scope).toBe('portal');
  });

  it('audits a successful launch', async () => {
    const application = await assignedApp();
    await call('POST', `/api/portal/applications/${application.id}/launch`);
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'application.launch' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(application.id);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run apps/api/src/routes/portal.test.ts`
Expected: FAIL — 404 on every portal route.

- [ ] **Step 3: Implement the portal routes**

`apps/api/src/routes/portal.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { idParam } from '@syntra/contracts';
import {
  authorize,
  findApplication,
  isApplicationAssigned,
  recordEvent,
  resolveApplicationsForUser,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession } from '../plugins/require-session.js';
import { tenantRelyingParty } from './relying-party.js';

export interface PortalRouteOptions {
  authRateLimitMax: number;
  publicUrl: string;
}

export async function registerPortalRoutes(
  app: FastifyInstance,
  options: PortalRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('portal'));

  app.get('/applications', async (request) => {
    const rows = await request.db((tx) =>
      resolveApplicationsForUser(tx, request.session.userId),
    );
    // Deliberately not the launch URL. A tile is a name and an icon; getting
    // to the application goes through /launch, which goes through authorize().
    return {
      applications: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        iconUrl: row.iconUrl,
      })),
    };
  });

  app.post(
    '/applications/:id/launch',
    { config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { userId, sessionId, satisfiedFactor } = request.session;

      const assigned = await request.db((tx) => isApplicationAssigned(tx, userId, id));
      if (!assigned) {
        // An unknown application and an unassigned one read the same, so the
        // catalog cannot be enumerated from a portal session.
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      // Even for an already-signed-in user, entering an application is a
      // separate decision: a rule may name this application and demand a
      // stronger factor than the session was established with. Access II's
      // protocol adapters mount on exactly this call.
      const tenant = await request.db((tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
      );

      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        principal: {
          kind: 'session',
          userId,
          sessionId,
          // What this session was established with. Without it the decision
          // below cannot know the user has already answered this rule, and a
          // launch → challenge → verify → launch cycle never terminates: the
          // relaunch is a fresh decision with nothing satisfied, so it issues
          // the same challenge again, forever.
          satisfiedFactor,
        },
        applicationId: id,
        sourceIp: request.ip,
        relyingParty: tenantRelyingParty(tenant, options.publicUrl),
        // A launch never elevates. Recorded on any attempt this opens, so the
        // session issued at the far end of the step-up is a portal one even
        // though the caller arrived holding a cookie.
        scope: 'portal',
      });

      if (decision.status === 'deny') {
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      if (decision.status === 'challenge') {
        return {
          status: 'challenge' as const,
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          acceptableFactors: decision.acceptableFactors,
        };
      }

      // A rule scoped to this application wants a factor the user does not
      // hold. They keep their portal session; what they do not get is this
      // application until they enrol.
      if (decision.status === 'enrol') {
        return {
          status: 'enrol' as const,
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          enrollableFactors: decision.enrollableFactors,
        };
      }

      const application = await request.db((tx) => findApplication(tx, id));
      if (!application?.launchUrl) {
        throw new ProblemError(
          409,
          'not-launchable',
          'That application has no launch address configured',
        );
      }

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: userId,
          action: 'application.launch',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: application.slug },
        }),
      );

      return { status: 'launch' as const, url: application.launchUrl };
    },
  );
}
```

Register it in `apps/api/src/app.ts`:

```ts
  await app.register(registerPortalRoutes, {
    prefix: '/api/portal',
    authRateLimitMax: config.authRateLimitMax,
    publicUrl: config.publicUrl,
  });
```

A launch that returns a challenge is completed with the same
`/api/auth/mfa/verify` used at sign-in; verifying issues a fresh portal session
and the browser retries the launch. That reuse is deliberate — a second
verification endpoint would be a second place for a factor check to be wrong.

- [ ] **Step 4: Run it to make sure it passes**

Run: `pnpm vitest run apps/api/src/routes/portal.test.ts`
Expected: PASS, 14 tests.

If "completes the challenge round trip and then launches" hangs on a second
challenge, `Session.satisfiedFactor` is not being written by `createSession` or
not being read by `resolveSession`. Do not proceed — without it every
application covered by a `require_mfa` rule is unreachable.

- [ ] **Step 5: Move the resource hook out of the console chunk**

`useApiResource` currently lives in `apps/web/src/pages/admin/hooks.ts`, and the
portal is about to use it. Move the file to
`apps/web/src/session/use-api-resource.ts` unchanged, and leave a one-line
re-export behind so the eight existing admin pages keep compiling:

```ts
// apps/web/src/pages/admin/hooks.ts
export { useApiResource, type Resource } from '../../session/use-api-resource.js';
```

Importing it from `pages/admin/` into the portal would pull a module out of the
lazy-loaded console chunk into the main bundle for every portal-only session.

- [ ] **Step 6: Fill in the portal tiles**

Replace the body of `apps/web/src/pages/Portal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Alert, Empty, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { useSession } from '../session/SessionProvider.js';
import { ApiError, api } from '../session/api.js';
import { useApiResource } from '../session/use-api-resource.js';

interface Tile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  iconUrl: string | null;
}

type LaunchResponse =
  | { status: 'launch'; url: string }
  | {
      status: 'challenge';
      attemptToken: string;
      expiresAt: string;
      acceptableFactors: string[];
    }
  | {
      status: 'enrol';
      attemptToken: string;
      expiresAt: string;
      enrollableFactors: string[];
    };

/** Two letters from the name: no icon service, no network call, no CDN. */
function Monogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-soft font-semibold text-primary"
    >
      {initials}
    </span>
  );
}

export function Portal() {
  const { session } = useSession();
  const firstName = session?.displayName.split(' ')[0] ?? 'there';
  const { data, error, loading } = useApiResource<{ applications: Tile[] }>(
    '/api/portal/applications',
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  /**
   * Finishes a launch that was interrupted by a step-up.
   *
   * The tile the user clicked is carried through the challenge in the query
   * string, and retried once the new session exists. Guarded so a reload does
   * not open the application again.
   */
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('launch');
    if (!wanted || !data) return;
    const tile = data.applications.find((row) => row.id === wanted);
    window.history.replaceState({}, '', '/');
    if (tile) void launch(tile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function launch(tile: Tile) {
    setBusy(tile.id);
    setLaunchError(null);
    try {
      const result = await api<LaunchResponse>(
        `/api/portal/applications/${tile.id}/launch`,
        { method: 'POST' },
      );
      if (result.status === 'launch') {
        // noopener so the opened application cannot reach back into this tab.
        window.open(result.url, '_blank', 'noopener,noreferrer');
      } else {
        // The step-up screen owns the attempt token from here. Task 14 replaces
        // this inline write with storeChallenge() from
        // apps/web/src/mfa/challenge-store.ts, which writes exactly this key
        // and exactly these five fields.
        const kind = result.status === 'enrol' ? 'enrol' : 'verify';
        sessionStorage.setItem(
          'syntra.challenge',
          JSON.stringify({
            kind,
            attemptToken: result.attemptToken,
            expiresAt: result.expiresAt,
            factors:
              result.status === 'enrol'
                ? result.enrollableFactors
                : result.acceptableFactors,
            returnTo: '/',
          }),
        );
        window.location.assign(kind === 'enrol' ? '/enrol' : '/mfa');
      }
    } catch (cause) {
      setLaunchError(
        cause instanceof ApiError && cause.problem.status === 403
          ? `${tile.name} is not available to you right now.`
          : `${tile.name} could not be opened. Try again.`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold text-ink">Good day, {firstName}</h1>
          <p className="mt-1 text-muted">
            Applications your organization has assigned to you.
          </p>
        </header>

        <div className="mt-8 space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {launchError && <Alert tone="danger">{launchError}</Alert>}

          {loading && <SkeletonRows rows={3} cols={2} />}

          {!loading && data?.applications.length === 0 && (
            <Empty title="No applications assigned yet">
              When your administrator assigns applications to you, they appear here
              and open with a single click.
            </Empty>
          )}

          {!loading && data && data.applications.length > 0 && (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.applications.map((tile) => (
                <li key={tile.id}>
                  <button
                    type="button"
                    onClick={() => launch(tile)}
                    disabled={busy === tile.id}
                    aria-busy={busy === tile.id || undefined}
                    className="flex h-full w-full items-start gap-3 rounded-panel border border-border-subtle bg-bg p-4 text-left transition-colors duration-150 ease-out-quart hover:bg-surface disabled:opacity-55"
                  >
                    <Monogram name={tile.name} />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{tile.name}</span>
                      {tile.description && (
                        <span className="mt-0.5 block text-sm text-muted">
                          {tile.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 7: Typecheck, run and commit**

```bash
pnpm exec tsc -b
pnpm vitest run apps/api
pnpm --filter @syntra/web test
git add -A
git commit -m "feat: show portal tiles and launch applications through authorize()"
```

---

## Task 14: The user-facing screens — step-up, enrolment, password reset

**Files:**
- Create: `apps/web/src/pages/MfaChallenge.tsx`
- Create: `apps/web/src/pages/EnrolFactor.tsx`
- Create: `apps/web/src/pages/Security.tsx`
- Create: `apps/web/src/pages/ForgotPassword.tsx`
- Create: `apps/web/src/pages/ResetPassword.tsx`
- Create: `apps/web/src/mfa/challenge-store.ts`
- Create: `apps/web/src/mfa/webauthn.ts`
- Modify: `apps/web/package.json` — add `@simplewebauthn/browser`
- Modify: `apps/web/src/routes.tsx`
- Modify: `apps/web/src/pages/Login.tsx`
- Modify: `apps/web/src/components/AppShell.tsx` — a link to Security
- Test: `apps/web/src/pages/MfaChallenge.test.tsx`
- Test: `apps/web/src/pages/ResetPassword.test.tsx`

**Interfaces:**
- Consumes: from Task 8 — `/api/auth/mfa/*`. From Task 9 — `/api/auth/enrol/*`. From Task 10 — `/api/auth/password-reset/*`. From Task 13 — the `syntra.challenge` handoff written by `Portal.tsx`.
- Produces:
  - `type PendingKind = 'verify' | 'enrol'`
  - `interface PendingChallenge { kind: PendingKind; attemptToken: string; expiresAt: string; factors: string[]; returnTo: string }`
  - `function storeChallenge(challenge: PendingChallenge): void`
  - `function takeChallenge(): PendingChallenge | null`
  - `const routeFor: (kind: PendingKind) => string`
  - `function startWebAuthnRegistration(label: string): Promise<void>`
  - `function enrolWebAuthnForAttempt(attemptToken: string, label: string): Promise<unknown>`
  - `function assertWebAuthn(attemptToken: string): Promise<Record<string, unknown>>`
  - Routes `/mfa`, `/enrol`, `/security`, `/forgot-password`, `/reset-password`

- [ ] **Step 1: Add the browser library**

```bash
pnpm --filter @syntra/web add @simplewebauthn/browser@13.3.0
```

It is the client half of `@simplewebauthn/server@13.3.2` and handles the
base64url encoding of the credential the browser returns. Version 13 takes its
options wrapped: `startRegistration({ optionsJSON })`, not the bare object that
version 12 accepted.

- [ ] **Step 2: Write the challenge handoff**

`apps/web/src/mfa/challenge-store.ts`:

```ts
export type PendingKind = 'verify' | 'enrol';

export interface PendingChallenge {
  /**
   * 'verify' — present a factor you already hold, at /mfa.
   * 'enrol'  — register one of the required kind, at /enrol.
   * The two screens are separate because the endpoints behind them are
   * separate, and a token issued for one is refused by the other.
   */
  kind: PendingKind;
  attemptToken: string;
  expiresAt: string;
  /** Factors to offer: acceptable ones to verify, or enrollable ones to add. */
  factors: string[];
  /** Where to go once the step-up is satisfied. */
  returnTo: string;
}

const KEY = 'syntra.challenge';

/**
 * sessionStorage rather than a route parameter or React state.
 *
 * The attempt token must survive a full-page navigation (the portal launch
 * path reloads), and it must not end up in a URL, where it would be written to
 * every proxy log and left in the browser's history. sessionStorage is scoped
 * to the tab and cleared when it closes.
 */
export function storeChallenge(challenge: PendingChallenge): void {
  sessionStorage.setItem(KEY, JSON.stringify(challenge));
}

/** Reads and clears in one go: an attempt token is used once. */
export function takeChallenge(): PendingChallenge | null {
  const raw = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingChallenge;
    if (typeof parsed.attemptToken !== 'string') return null;
    if (parsed.kind !== 'verify' && parsed.kind !== 'enrol') return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Where a stored challenge should send the browser. */
export const routeFor = (kind: PendingKind) => (kind === 'enrol' ? '/enrol' : '/mfa');
```

- [ ] **Step 3: Write the WebAuthn browser helpers**

`apps/web/src/mfa/webauthn.ts`:

```ts
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from '../session/api.js';

/**
 * Enrols a security key or passkey for a user who is already signed in.
 *
 * The options come from the server, go straight to the authenticator, and the
 * response goes straight back. Nothing in between is inspected here — the
 * verification that matters happens server-side, and any check made in the
 * browser is a convenience the caller can skip.
 */
export async function startWebAuthnRegistration(label: string): Promise<void> {
  const optionsJSON = await api<Record<string, unknown>>('/api/auth/mfa/webauthn/begin', {
    method: 'POST',
  });
  const response = await startRegistration({ optionsJSON: optionsJSON as never });
  await api('/api/auth/mfa/webauthn/finish', {
    method: 'POST',
    body: JSON.stringify({ label, response }),
  });
}

/**
 * The same thing during a forced-enrolment challenge, where there is no session
 * and the attempt token is the credential. A separate pair of endpoints, not a
 * flag on the first pair: the two are authenticated differently and mixing them
 * is how one rule gets applied where the other was meant.
 *
 * Returns whatever the server answers, which is a session on success and a
 * further challenge if the policy moved underneath.
 */
export async function enrolWebAuthnForAttempt(
  attemptToken: string,
  label: string,
): Promise<unknown> {
  const optionsJSON = await api<Record<string, unknown>>(
    '/api/auth/enrol/webauthn/begin',
    { method: 'POST', body: JSON.stringify({ attemptToken }) },
  );
  const response = await startRegistration({ optionsJSON: optionsJSON as never });
  return api('/api/auth/enrol/webauthn/finish', {
    method: 'POST',
    body: JSON.stringify({ attemptToken, label, response }),
  });
}

/** Signs a step-up challenge. The caller holds an attempt token, not a session. */
export async function assertWebAuthn(
  attemptToken: string,
): Promise<Record<string, unknown>> {
  const optionsJSON = await api<Record<string, unknown>>(
    '/api/auth/mfa/webauthn/challenge',
    { method: 'POST', body: JSON.stringify({ attemptToken }) },
  );
  const assertion = await startAuthentication({ optionsJSON: optionsJSON as never });
  return assertion as unknown as Record<string, unknown>;
}
```

- [ ] **Step 4: Write the failing step-up test**

`apps/web/src/pages/MfaChallenge.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { storeChallenge } from '../mfa/challenge-store.js';
import { MfaChallenge } from './MfaChallenge.js';

const renderPage = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <MfaChallenge />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (impl: (url: string, init?: RequestInit) => Response) => {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) =>
    impl(String(url), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const problem = (status: number) =>
  new Response(JSON.stringify({ status, title: 'Invalid credentials' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

describe('MfaChallenge', () => {
  it('sends the user back to sign in when there is no pending challenge', async () => {
    stubFetch(() => problem(401));
    renderPage();
    expect(
      await screen.findByText(/sign in again/i),
    ).toBeInTheDocument();
  });

  it('asks for a code and accepts it', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    const fetchSpy = stubFetch((url) =>
      url.includes('/api/auth/mfa/verify')
        ? ok({ status: 'authenticated', userId: 'u', displayName: 'J', scope: 'portal', mayElevate: false, permissions: [] })
        : problem(401),
    );

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) =>
        String(u).includes('/api/auth/mfa/verify'),
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toEqual({
        type: 'totp',
        attemptToken: 'token-1',
        code: '123456',
      });
    });
  });

  it('states a rejected code in plain language and lets the user try again', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    await userEvent.type(await screen.findByLabelText(/code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /verify/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not match/i);
    expect(screen.getByRole('button', { name: /verify/i })).toBeEnabled();
  });

  it('offers a recovery code as an alternative', async () => {
    storeChallenge({
      kind: 'verify',
      attemptToken: 'token-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      factors: ['totp'],
      returnTo: '/',
    });
    stubFetch(() => problem(401));

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /recovery code/i }));
    expect(screen.getByLabelText(/recovery code/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Write the step-up screen**

`apps/web/src/pages/MfaChallenge.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { takeChallenge, storeChallenge, type PendingChallenge } from '../mfa/challenge-store.js';
import { assertWebAuthn } from '../mfa/webauthn.js';
import { ApiError, api } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';

type Mode = 'totp' | 'webauthn' | 'recovery_code';

export function MfaChallenge() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pending = takeChallenge();
    setChallenge(pending);
    if (pending) {
      // Put it back: the token is spent on a successful verify, not on
      // rendering the screen, and a wrong code must not cost the user the flow.
      storeChallenge(pending);
      // First offered, not "totp unless webauthn". A user whose only remaining
      // factor is a printed recovery code would otherwise land on a screen
      // that opens a WebAuthn prompt for a key they do not have.
      const first = pending.factors[0];
      if (first === 'totp' || first === 'webauthn' || first === 'recovery_code') {
        setMode(first);
      }
    }
    setReady(true);
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);

    try {
      const body =
        mode === 'webauthn'
          ? {
              type: 'webauthn',
              attemptToken: challenge.attemptToken,
              assertion: await assertWebAuthn(challenge.attemptToken),
            }
          : { type: mode, attemptToken: challenge.attemptToken, code };

      await api('/api/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      takeChallenge();
      await refresh();
      navigate(challenge.returnTo.startsWith('/') ? challenge.returnTo : '/', {
        replace: true,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'code-already-used-for-setup') {
        // The one refusal a user is guaranteed to meet while looking at a
        // correct code. Enrol a factor, get challenged twenty seconds later,
        // and the replay watermark refuses the code that completed setup —
        // which is the point, but only if it is explained. Unexplained it is a
        // support ticket; explained it is a sentence.
        setError(
          cause.problem.detail ??
            'That code completed your setup. Wait for your app to show the next one.',
        );
      } else if (cause instanceof ApiError && cause.problem.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (cause instanceof DOMException) {
        setError('Your security key was not used. Try again, or use a code.');
      } else {
        // The server does not distinguish a wrong code from an expired attempt,
        // and neither does this.
        setError('That did not match. Try again, or use a recovery code.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return null;

  if (!challenge) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-sm text-center">
          <Wordmark className="mb-8" />
          <Alert tone="warning" title="This step expired">
            Sign in again to continue.
          </Alert>
          <Button className="mt-4 w-full" variant="primary" onClick={() => navigate('/login')}>
            Back to sign in
          </Button>
        </div>
      </main>
    );
  }

  const offers = (factor: Mode) =>
    challenge.factors.includes(factor) && mode !== factor;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">One more step</h1>
          <p className="mt-1 text-muted">
            Your organization requires a second factor for this sign-in.
          </p>

          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            {mode === 'totp' && (
              <Field
                label="Six-digit code"
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                invalid={Boolean(error)}
              />
            )}
            {mode === 'recovery_code' && (
              <Field
                label="Recovery code"
                value={code}
                onChange={setCode}
                autoComplete="off"
                autoFocus
                required
                hint="One of the codes you saved when you set up your second factor."
                invalid={Boolean(error)}
              />
            )}
            {mode === 'webauthn' && (
              <p className="text-muted">
                Use your security key or passkey when the browser asks.
              </p>
            )}

            {error && (
              <Alert tone="danger">
                <span>{error}</span>
              </Alert>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Verify
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap gap-3">
            {offers('webauthn') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('webauthn')}>
                Use a security key
              </Button>
            )}
            {offers('totp') && (
              <Button size="sm" variant="ghost" onClick={() => setMode('totp')}>
                Use a code from your app
              </Button>
            )}
            {mode !== 'recovery_code' && (
              <Button size="sm" variant="ghost" onClick={() => setMode('recovery_code')}>
                Use a recovery code
              </Button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
```

Add a `refresh()` to `SessionProvider`, which re-reads `/api/auth/session` and
sets the session, and expose it on the context type:

```ts
  const refresh = useCallback(async () => {
    try {
      setSession(await api<SessionResponse>('/api/auth/session'));
    } catch {
      setSession(null);
    }
  }, []);
```

- [ ] **Step 6: Write the forced-enrolment screen**

`apps/web/src/pages/EnrolFactor.tsx`. This is what a user sees when their
password was accepted and the policy asked for a factor they do not hold. They
have no session yet; the attempt token is the only thing they hold.

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import {
  storeChallenge,
  takeChallenge,
  type PendingChallenge,
} from '../mfa/challenge-store.js';
import { enrolWebAuthnForAttempt } from '../mfa/webauthn.js';
import { ApiError, api } from '../session/api.js';
import { useSession } from '../session/SessionProvider.js';

interface Enrolment {
  secret: string;
  uri: string;
  qr: string;
}

export function EnrolFactor() {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'totp' | 'webauthn'>('totp');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Security key');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pending = takeChallenge();
    if (pending && pending.kind === 'enrol') {
      // Put it back: the attempt is spent when enrolment succeeds, not when
      // this screen renders, and a mistyped code must not cost the user the
      // whole sign-in.
      storeChallenge(pending);
      setChallenge(pending);
      setMode(pending.factors.includes('totp') ? 'totp' : 'webauthn');
    }
    setReady(true);
  }, []);

  async function beginTotp() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      setEnrolment(
        await api<Enrolment>('/api/auth/enrol/totp/begin', {
          method: 'POST',
          body: JSON.stringify({ attemptToken: challenge.attemptToken }),
        }),
      );
    } catch {
      setError('That did not work. Sign in again to start over.');
    } finally {
      setBusy(false);
    }
  }

  function done() {
    takeChallenge();
    void refresh().then(() =>
      navigate(challenge!.returnTo.startsWith('/') ? challenge!.returnTo : '/', {
        replace: true,
      }),
    );
  }

  async function confirmTotp(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/enrol/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ attemptToken: challenge.attemptToken, code }),
      });
      done();
    } catch (cause) {
      if (cause instanceof ApiError && cause.problem.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (cause instanceof ApiError && cause.problem.status === 401) {
        setError('This step expired. Sign in again to start over.');
      } else {
        setError('That code did not match. Check your app and try the next one.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function addKey() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await enrolWebAuthnForAttempt(challenge.attemptToken, label.trim() || 'Security key');
      done();
    } catch (cause) {
      // A tenant with no primary domain set cannot register a security key at
      // all, and the server says so with a message naming the fix. Showing it
      // is better than a generic failure the user cannot act on.
      setError(
        cause instanceof ApiError && cause.kind === 'webauthn-unavailable'
          ? (cause.problem.detail ?? 'Security keys are not available here.')
          : cause instanceof DOMException
            ? 'That security key was not registered. Try again.'
            : 'That security key was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return null;

  if (!challenge) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-sm text-center">
          <Wordmark className="mb-8" />
          <Alert tone="warning" title="This step expired">
            Sign in again to continue.
          </Alert>
          <Button className="mt-4 w-full" variant="primary" onClick={() => navigate('/login')}>
            Back to sign in
          </Button>
        </div>
      </main>
    );
  }

  const offersBoth = challenge.factors.length > 1;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">Set up a second factor</h1>
          <p className="mt-1 text-muted">
            Your organization now requires one. It takes a minute, and you will
            be signed in straight afterwards.
          </p>

          {mode === 'totp' && (
            <div className="mt-6 space-y-4">
              {!enrolment && (
                <>
                  <p className="text-muted">
                    Use an authenticator app — the one your organization
                    recommends, or any that shows six-digit codes.
                  </p>
                  <Button variant="primary" loading={busy} className="w-full" onClick={beginTotp}>
                    Start
                  </Button>
                </>
              )}

              {enrolment && (
                <form onSubmit={confirmTotp} noValidate className="space-y-4">
                  <p className="text-muted">
                    Scan this with your app, then type the code it shows.
                  </p>
                  <img
                    src={enrolment.qr}
                    alt="QR code for your authenticator app"
                    className="size-48 rounded-control border border-border-subtle"
                  />
                  <p className="text-sm text-muted">
                    Cannot scan? Enter this key instead:{' '}
                    <code className="font-mono text-ink">{enrolment.secret}</code>
                  </p>
                  <Field
                    label="Six-digit code"
                    value={code}
                    onChange={setCode}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    invalid={Boolean(error)}
                  />
                  <Button type="submit" variant="primary" loading={busy} className="w-full">
                    Confirm
                  </Button>
                </form>
              )}
            </div>
          )}

          {mode === 'webauthn' && (
            <div className="mt-6 space-y-4">
              <p className="text-muted">
                Use a security key, or the fingerprint or face unlock built into
                this device.
              </p>
              <Field label="Name this key" value={label} onChange={setLabel} />
              <Button variant="primary" loading={busy} className="w-full" onClick={addKey}>
                Continue
              </Button>
            </div>
          )}

          {error && (
            <Alert tone="danger">
              <span>{error}</span>
            </Alert>
          )}

          {offersBoth && (
            <div className="mt-4">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  setEnrolment(null);
                  setMode(mode === 'totp' ? 'webauthn' : 'totp');
                }}
              >
                {mode === 'totp' ? 'Use a security key instead' : 'Use an app instead'}
              </Button>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          Recovery codes are not offered here. Generate a set from the Security
          page once you are signed in.
        </p>
      </div>
    </main>
  );
}
```

The closing note is not decoration. Recovery codes are deliberately not
enrollable during a forced challenge — a user must not be able to answer "prove
you hold a second factor" by printing themselves one — and saying so is better
than leaving the reader to wonder where they went.

- [ ] **Step 7: Replace the portal's inline handoff**

In `apps/web/src/pages/Portal.tsx`, Task 13 wrote the pending challenge into
`sessionStorage` by hand and only handled a step-up. Replace that block so both
outcomes are carried, and so there is one place that knows the key and shape:

```tsx
import { routeFor, storeChallenge } from '../mfa/challenge-store.js';

// …widen the response type:
type LaunchResponse =
  | { status: 'launch'; url: string }
  | {
      status: 'challenge';
      attemptToken: string;
      expiresAt: string;
      acceptableFactors: string[];
    }
  | {
      status: 'enrol';
      attemptToken: string;
      expiresAt: string;
      enrollableFactors: string[];
    };

// …inside launch(), replacing the else branch:
      } else {
        const kind = result.status === 'enrol' ? 'enrol' : 'verify';
        storeChallenge({
          kind,
          attemptToken: result.attemptToken,
          expiresAt: result.expiresAt,
          factors:
            result.status === 'enrol'
              ? result.enrollableFactors
              : result.acceptableFactors,
          // Come back and finish what the user was doing. Landing them on an
          // empty portal after a step-up they only entered because they
          // clicked a tile leaves them to guess that they should click it
          // again.
          returnTo: `/?launch=${tile.id}`,
        });
        window.location.assign(routeFor(kind));
      }
```

- [ ] **Step 8: Route both login outcomes here**

In `apps/web/src/pages/Login.tsx`, replace the placeholder branches added in
Task 4:

```ts
      const outcome = await login(loginName, password);
      if (outcome.status === 'authenticated') {
        navigate('/', { replace: true });
        return;
      }

      const kind = outcome.status === 'enrol' ? 'enrol' : 'verify';
      storeChallenge({
        kind,
        attemptToken: outcome.attemptToken,
        expiresAt: outcome.expiresAt,
        factors:
          outcome.status === 'enrol'
            ? outcome.enrollableFactors
            : outcome.acceptableFactors,
        returnTo: '/',
      });
      navigate(routeFor(kind), { replace: true });
```

and add, below the form, a link that does not name the account:

```tsx
        <p className="mt-6 text-center text-sm text-muted">
          <Link to="/forgot-password" className="text-accent underline-offset-2 hover:underline">
            Forgot your password?
          </Link>
        </p>
```

- [ ] **Step 9: Write the Security page**

`apps/web/src/pages/Security.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Panel, Status } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { ApiError, api } from '../session/api.js';
import { startWebAuthnRegistration } from '../mfa/webauthn.js';

interface MfaStatus {
  totp: { enrolled: boolean };
  webauthn: {
    available: boolean;
    unavailableReason: string | null;
    credentials: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];
  };
  recoveryCodes: { remaining: number };
}

interface Enrolment {
  secret: string;
  uri: string;
  qr: string;
}

export function Security() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [keyLabel, setKeyLabel] = useState('Security key');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<MfaStatus>('/api/auth/mfa'));
    } catch {
      setError('Your security settings could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function beginTotp() {
    setBusy(true);
    setCodeError(null);
    try {
      setEnrolment(await api<Enrolment>('/api/auth/mfa/totp/begin', { method: 'POST' }));
    } catch {
      setError('Enrolment could not be started.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp() {
    setBusy(true);
    setCodeError(null);
    try {
      await api('/api/auth/mfa/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setEnrolment(null);
      setCode('');
      await load();
    } catch (cause) {
      setCodeError(
        cause instanceof ApiError && cause.problem.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That code did not match. Check your app and try the next one.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function addKey() {
    setBusy(true);
    setError(null);
    try {
      await startWebAuthnRegistration(keyLabel.trim() || 'Security key');
      await load();
    } catch (cause) {
      setError(
        cause instanceof DOMException
          ? 'That security key was not registered. Try again.'
          : 'That security key was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeKey(id: string) {
    await api(`/api/auth/mfa/webauthn/${id}`, { method: 'DELETE' });
    await load();
  }

  async function issueCodes() {
    setBusy(true);
    try {
      const result = await api<{ codes: string[] }>('/api/auth/mfa/recovery-codes', {
        method: 'POST',
      });
      setCodes(result.codes);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.kind === 'no-factor-to-recover'
          ? (cause.problem.detail ??
            'Set up an authenticator app or a security key first.')
          : 'Recovery codes could not be generated.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold text-ink">Security</h1>
          <p className="mt-1 text-muted">
            A second factor keeps your account usable only by you, even if your
            password is guessed.
          </p>
        </header>

        {error && <Alert tone="danger">{error}</Alert>}

        <Panel
          title="Authenticator app"
          description="A six-digit code that changes every thirty seconds."
          actions={
            status?.totp.enrolled ? (
              <Status tone="active">Set up</Status>
            ) : (
              <Button size="sm" variant="primary" loading={busy} onClick={beginTotp}>
                Set up
              </Button>
            )
          }
        >
          {enrolment && (
            <div className="space-y-4 p-4">
              <p className="text-muted">
                Scan this with your authenticator app, then type the code it shows.
              </p>
              <img
                src={enrolment.qr}
                alt="QR code for your authenticator app"
                className="size-48 rounded-control border border-border-subtle"
              />
              <p className="text-sm text-muted">
                Cannot scan? Enter this key instead:{' '}
                <code className="font-mono text-ink">{enrolment.secret}</code>
              </p>
              <Field
                label="Code from your app"
                value={code}
                onChange={setCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                error={codeError ?? undefined}
              />
              <Button variant="primary" loading={busy} onClick={confirmTotp}>
                Confirm
              </Button>
            </div>
          )}
        </Panel>

        <Panel
          title="Security keys and passkeys"
          description="A hardware key, or the fingerprint or face unlock built into this device."
        >
          <div className="space-y-4 p-4">
            {status?.webauthn.credentials.length === 0 && (
              <p className="text-muted">Nothing registered yet.</p>
            )}
            {status && status.webauthn.credentials.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {status.webauthn.credentials.map((credential) => (
                  <li key={credential.id} className="flex items-center justify-between py-2">
                    <span>
                      <span className="block font-medium text-ink">{credential.label}</span>
                      <span className="block text-sm text-muted">
                        Added {new Date(credential.createdAt).toLocaleDateString()}
                        {credential.lastUsedAt
                          ? ` · last used ${new Date(credential.lastUsedAt).toLocaleDateString()}`
                          : ' · never used'}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => removeKey(credential.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {status && !status.webauthn.available ? (
              <Alert tone="info" title="Security keys are not available here">
                {status.webauthn.unavailableReason ??
                  'An administrator must configure this tenant before security keys can be used.'}
              </Alert>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label="Name this key"
                  value={keyLabel}
                  onChange={setKeyLabel}
                  className="min-w-56 flex-1"
                />
                <Button variant="primary" loading={busy} onClick={addKey}>
                  Add a key
                </Button>
              </div>
            )}
          </div>
        </Panel>

        <Panel
          title="Recovery codes"
          description="Single-use codes for when you lose your phone or key."
          actions={
            <Button size="sm" loading={busy} onClick={issueCodes}>
              {status && status.recoveryCodes.remaining > 0 ? 'Replace codes' : 'Generate codes'}
            </Button>
          }
        >
          <div className="space-y-3 p-4">
            <p className="text-muted">
              {status?.recoveryCodes.remaining ?? 0} unused code
              {status?.recoveryCodes.remaining === 1 ? '' : 's'} remaining.
            </p>
            {codes && (
              <>
                <Alert tone="warning" title="Save these now">
                  They are shown once. Syntra stores only their fingerprints and
                  cannot show them again.
                </Alert>
                <ul className="grid grid-cols-2 gap-2 font-mono text-ink sm:grid-cols-3">
                  {codes.map((value) => (
                    <li key={value} className="rounded-control bg-surface-2 px-2 py-1 text-center">
                      {value}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
```

The response type is named `MfaStatus`, not `Status`: `Status` is already the
badge component imported from `@syntra/ui`, and the shadowing is a compile
error.

- [ ] **Step 10: Write the password-reset screens**

`apps/web/src/pages/ForgotPassword.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { api } from '../session/api.js';

export function ForgotPassword() {
  const [login, setLogin] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ login }),
      });
    } catch {
      // Deliberately swallowed. The server answers identically whether or not
      // the account exists, and a visible failure here would give that away.
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          {sent ? (
            <>
              <h1 className="text-lg font-semibold text-ink">Check your inbox</h1>
              <Alert tone="info">
                If that account exists, we have sent it a link. It works once and
                expires in thirty minutes.
              </Alert>
              <p className="mt-4 text-sm text-muted">
                Nothing arrived? Check spam, or ask your IT administrator — some
                accounts have their password managed elsewhere.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-ink">Reset your password</h1>
              <p className="mt-1 text-muted">
                Enter your login or work email address.
              </p>
              <form onSubmit={submit} noValidate className="mt-6 space-y-4">
                <Field
                  label="Login or email"
                  value={login}
                  onChange={setLogin}
                  autoComplete="username"
                  autoFocus
                  required
                />
                <Button type="submit" variant="primary" loading={busy} className="w-full">
                  Send the link
                </Button>
              </form>
            </>
          )}
        </div>
        <p className="mt-6 text-center text-sm text-muted">
          <Link to="/login" className="text-accent underline-offset-2 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
```

`apps/web/src/pages/ResetPassword.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import { Wordmark } from '../components/Wordmark.js';
import { ApiError, api } from '../session/api.js';
import { assertWebAuthn } from '../mfa/webauthn.js';

interface Preflight {
  valid: boolean;
  requiresFactor: boolean;
  acceptableFactors: string[];
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [password, setPassword] = useState('');
  const [factorMode, setFactorMode] = useState<'totp' | 'recovery_code' | 'webauthn'>('totp');
  const [factorCode, setFactorCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setPreflight({ valid: false, requiresFactor: false, acceptableFactors: [] });
      return;
    }
    api<Preflight>('/api/auth/password-reset/preflight', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((result) => {
        setPreflight(result);
        const first = result.acceptableFactors[0];
        if (first === 'webauthn' || first === 'recovery_code' || first === 'totp') {
          setFactorMode(first);
        }
      })
      .catch(() =>
        setPreflight({ valid: false, requiresFactor: false, acceptableFactors: [] }),
      );
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preflight?.valid) return;
    setBusy(true);
    setError(null);

    try {
      const factor = !preflight.requiresFactor
        ? undefined
        : factorMode === 'webauthn'
          ? { type: 'webauthn' as const, assertion: await assertWebAuthn(token) }
          : { type: factorMode, code: factorCode };

      await api('/api/auth/password-reset/complete', {
        method: 'POST',
        body: JSON.stringify({
          token,
          newPassword: password,
          ...(factor ? { factor } : {}),
        }),
      });
      navigate('/login', { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.problem.detail ?? cause.problem.title);
      } else {
        setError('That could not be completed. Request a new link.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (preflight && !preflight.valid) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
        <div className="w-full max-w-sm">
          <Wordmark className="mb-8" />
          <Alert tone="warning" title="That link is no longer usable">
            Reset links work once and expire after thirty minutes.
          </Alert>
          <p className="mt-4 text-center text-sm text-muted">
            <Link to="/forgot-password" className="text-accent underline-offset-2 hover:underline">
              Request a new one
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">Choose a new password</h1>

          <form onSubmit={submit} noValidate className="mt-6 space-y-4">
            <Field
              label="New password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              autoFocus
              required
              hint="At least twelve characters. A short sentence works well."
            />

            {preflight?.requiresFactor && factorMode !== 'webauthn' && (
              <Field
                label={factorMode === 'totp' ? 'Code from your app' : 'Recovery code'}
                value={factorCode}
                onChange={setFactorCode}
                autoComplete="one-time-code"
                required
                hint="Your account has a second factor, so resetting the password needs it too."
              />
            )}
            {preflight?.requiresFactor && factorMode === 'webauthn' && (
              <p className="text-muted">
                Use your security key when the browser asks. Your account has a
                second factor, so resetting the password needs it too.
              </p>
            )}

            {error && (
              <Alert tone="danger">
                <span>{error}</span>
              </Alert>
            )}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              Set the password
            </Button>
          </form>

          {preflight && preflight.acceptableFactors.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {preflight.acceptableFactors
                .filter((f) => f !== factorMode)
                .map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant="ghost"
                    onClick={() => setFactorMode(f as typeof factorMode)}
                  >
                    {f === 'totp'
                      ? 'Use a code from your app'
                      : f === 'webauthn'
                        ? 'Use a security key'
                        : 'Use a recovery code'}
                  </Button>
                ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 11: Write the failing reset-screen test**

`apps/web/src/pages/ResetPassword.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ResetPassword } from './ResetPassword.js';

const renderAt = (search: string) =>
  render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <ResetPassword />
    </MemoryRouter>,
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('ResetPassword', () => {
  it('says the link is unusable when there is no token', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('');
    expect(await screen.findByText(/no longer usable/i)).toBeInTheDocument();
  });

  it('says the link is unusable when preflight rejects it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ valid: false, requiresFactor: false, acceptableFactors: [] })),
    );
    renderAt('?token=stale');
    expect(await screen.findByText(/no longer usable/i)).toBeInTheDocument();
  });

  it('asks only for a password when no factor is registered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ valid: true, requiresFactor: false, acceptableFactors: [] })),
    );
    renderAt('?token=good');
    expect(await screen.findByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/recovery code/i)).not.toBeInTheDocument();
  });

  it('asks for the second factor when one is registered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ valid: true, requiresFactor: true, acceptableFactors: ['totp', 'recovery_code'] }),
      ),
    );
    renderAt('?token=good');
    expect(await screen.findByLabelText(/code from your app/i)).toBeInTheDocument();
  });

  it('sends the password and the factor together', async () => {
    const fetchSpy = vi.fn(async (url: unknown) =>
      String(url).includes('preflight')
        ? json({ valid: true, requiresFactor: true, acceptableFactors: ['totp'] })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    renderAt('?token=good');
    await userEvent.type(await screen.findByLabelText(/new password/i), 'a long enough passphrase');
    await userEvent.type(screen.getByLabelText(/code from your app/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /set the password/i }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/complete'));
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        token: 'good',
        newPassword: 'a long enough passphrase',
        factor: { type: 'totp', code: '123456' },
      });
    });
  });

  it('shows the server message when the password is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('preflight')
          ? json({ valid: true, requiresFactor: false, acceptableFactors: [] })
          : json(
              { status: 400, title: 'Weak password', detail: 'Choose a longer password.' },
              400,
            ),
      ),
    );

    renderAt('?token=good');
    await userEvent.type(await screen.findByLabelText(/new password/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /set the password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/longer password/i);
  });
});
```

- [ ] **Step 12: Wire up the routes**

In `apps/web/src/routes.tsx`, add the imports and the routes. `/mfa`,
`/forgot-password` and `/reset-password` are outside `RequireSession` — the
whole point is that the caller has no session yet.

```tsx
      <Route path="/mfa" element={<MfaChallenge />} />
      {/*
        Outside RequireSession on purpose. A user reaching /enrol has passed
        primary authentication and holds no session — that is the whole point
        of the screen.
      */}
      <Route path="/enrol" element={<EnrolFactor />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        path="/security"
        element={
          <RequireSession scope="portal">
            <Security />
          </RequireSession>
        }
      />
```

In `apps/web/src/components/AppShell.tsx`, add a Security link beside the
Administration one:

```tsx
            <Link
              to="/security"
              className="rounded-control px-2.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Security
            </Link>
```

- [ ] **Step 13: Run and commit**

```bash
pnpm exec tsc -b
pnpm --filter @syntra/web test
git add -A
git commit -m "feat: add MFA enrolment, step-up and password-reset screens"
```

---

## Task 15: The administration screens

**Files:**
- Create: `apps/web/src/pages/admin/ApplicationsPage.tsx`
- Create: `apps/web/src/pages/admin/ApplicationDetailPage.tsx`
- Create: `apps/web/src/pages/admin/PoliciesPage.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx`
- Test: `apps/web/src/pages/admin/PoliciesPage.test.tsx`

**Interfaces:**
- Consumes: from Task 12 — `/api/admin/applications`, `/api/admin/applications/:id/assignments`, `/api/admin/policy`, `/api/admin/policy/rules/impact` and the rule endpoints. From the existing codebase — `useApiResource`, `PageHeader`, `Panel`, `Button`, `Field`, `Alert`, `Empty`, `Status`, `SkeletonRows`.
- Produces: three screens and three navigation entries.

- [ ] **Step 1: Write the failing policy-screen test**

`apps/web/src/pages/admin/PoliciesPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PoliciesPage } from './PoliciesPage.js';

const policy = {
  fallback: { outcome: 'allow', factorType: null },
  rules: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Finance needs a key',
      enabled: true,
      position: 1,
      outcome: 'require_factor',
      factorType: 'webauthn',
      applicationIds: [],
      groupIds: [],
      contractField: 'department',
      contractValues: ['Finance'],
      ipRanges: [],
      daysOfWeek: [],
      startMinute: null,
      endMinute: null,
      timezone: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Offsite is refused',
      enabled: true,
      position: 2,
      outcome: 'deny',
      factorType: null,
      applicationIds: [],
      groupIds: [],
      contractField: null,
      contractValues: [],
      ipRanges: ['203.0.113.0/24'],
      daysOfWeek: [],
      startMinute: null,
      endMinute: null,
      timezone: null,
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const renderPage = () =>
  render(
    <MemoryRouter>
      <PoliciesPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('PoliciesPage', () => {
  it('lists rules in evaluation order with their position', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();

    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Finance needs a key');
    expect(rows[0]).toHaveTextContent('1');
    expect(rows[1]).toHaveTextContent('Offsite is refused');
  });

  it('states first-match-wins on the page rather than leaving it implicit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();
    expect(await screen.findByText(/first rule that matches/i)).toBeInTheDocument();
  });

  it('shows the tenant default as the last resort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();
    expect(await screen.findByText(/when no rule matches/i)).toBeInTheDocument();
  });

  it('summarises a rule conditions in words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();
    expect(await screen.findByText(/department is Finance/i)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.0\/24/)).toBeInTheDocument();
  });

  it('moves a rule up and sends the whole new order', async () => {
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? json(policy) : json(policy),
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderPage();

    await userEvent.click((await screen.findAllByRole('button', { name: /move up/i }))[0]!);

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/rules/order'));
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        ruleIds: [
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
        ],
      });
    });
  });

  it('reports how many users a rule would affect before it is saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/rules/impact')
          ? json({
              totalActiveUsers: 40,
              matchedUsers: 12,
              usersNeedingEnrolment: 9,
              unevaluatedConditions: [],
            })
          : json(policy),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /add a rule/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Everyone needs a factor');
    await userEvent.click(screen.getByRole('button', { name: /check who this affects/i }));

    expect(await screen.findByText(/matches 12 of 40 active users/i)).toBeInTheDocument();
    expect(screen.getByText(/9 of them hold no factor/i)).toBeInTheDocument();
  });

  it('says which conditions the count could not include', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/rules/impact')
          ? json({
              totalActiveUsers: 40,
              matchedUsers: 40,
              usersNeedingEnrolment: 40,
              unevaluatedConditions: ['source address'],
            })
          : json(policy),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /add a rule/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Offsite');
    await userEvent.click(screen.getByRole('button', { name: /check who this affects/i }));

    expect(await screen.findByText(/counted without source address/i)).toBeInTheDocument();
  });

  it('reports a rejected rule with the server message attached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) =>
        init?.method === 'POST'
          ? json(
              {
                status: 400,
                title: 'That rule cannot be stored as written',
                detail: 'ipRanges holds something that is not an address or CIDR: 10.0.0.0/33',
              },
              400,
            )
          : json(policy),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /add a rule/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Bad rule');
    await userEvent.type(screen.getByLabelText(/addresses/i), '10.0.0.0/33');
    await userEvent.click(screen.getByRole('button', { name: /save rule/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not an address or CIDR/i);
  });
});
```

- [ ] **Step 2: Write the policy screen**

`apps/web/src/pages/admin/PoliciesPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: 'allow' | 'require_mfa' | 'require_factor' | 'deny';
  factorType: 'totp' | 'webauthn' | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: string | null;
  contractValues: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

interface Policy {
  fallback: { outcome: Rule['outcome']; factorType: Rule['factorType'] };
  rules: Rule[];
}

interface RuleImpact {
  totalActiveUsers: number;
  matchedUsers: number;
  usersNeedingEnrolment: number;
  unevaluatedConditions: string[];
}

const OUTCOME_LABEL: Record<Rule['outcome'], string> = {
  allow: 'Allow',
  require_mfa: 'Require a second factor',
  require_factor: 'Require a specific factor',
  deny: 'Refuse',
};

const OUTCOME_TONE: Record<Rule['outcome'], 'active' | 'warning' | 'danger'> = {
  allow: 'active',
  require_mfa: 'warning',
  require_factor: 'warning',
  deny: 'danger',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * The conditions in words. A rule is only auditable if an administrator can
 * read what it does without reconstructing it from form fields.
 */
function conditions(rule: Rule): string[] {
  const parts: string[] = [];
  if (rule.applicationIds.length > 0) {
    parts.push(`${rule.applicationIds.length} named application(s)`);
  }
  if (rule.groupIds.length > 0) parts.push(`${rule.groupIds.length} named group(s)`);
  if (rule.contractField && rule.contractValues.length > 0) {
    parts.push(`${rule.contractField} is ${rule.contractValues.join(' or ')}`);
  }
  if (rule.ipRanges.length > 0) parts.push(`from ${rule.ipRanges.join(', ')}`);
  if (rule.daysOfWeek.length > 0) {
    parts.push(`on ${rule.daysOfWeek.map((d) => DAYS[d]).join(', ')}`);
  }
  if (rule.startMinute !== null && rule.endMinute !== null) {
    parts.push(
      `between ${clock(rule.startMinute)} and ${clock(rule.endMinute)} ${rule.timezone ?? 'UTC'}`,
    );
  }
  return parts.length > 0 ? parts : ['every sign-in'];
}

export function PoliciesPage() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [outcome, setOutcome] = useState<Rule['outcome']>('require_mfa');
  const [factorType, setFactorType] = useState<'totp' | 'webauthn'>('webauthn');
  const [ipRanges, setIpRanges] = useState('');
  const [contractField, setContractField] = useState('');
  const [contractValues, setContractValues] = useState('');
  const [impact, setImpact] = useState<RuleImpact | null>(null);

  const load = useCallback(async () => {
    try {
      setPolicy(await api<Policy>('/api/admin/policy'));
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.problem.status === 403
          ? 'You do not have permission to view this.'
          : 'The policy could not be loaded.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const list = (value: string) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  const draft = () => ({
    name,
    outcome,
    factorType: outcome === 'require_factor' ? factorType : null,
    ipRanges: list(ipRanges),
    contractField: contractField || null,
    contractValues: list(contractValues),
  });

  /**
   * Who this rule would touch, asked before it is stored.
   *
   * Directory Sync's deactivation threshold exists because a change that
   * silently affected everyone looked exactly like one that affected nobody
   * until it had already happened. A rule requiring a second factor is the
   * same shape: everyone it matches who holds no factor is sent through
   * enrolment on their next sign-in, and an administrator is entitled to know
   * how many people that is first.
   */
  async function checkImpact() {
    setBusy(true);
    setFormError(null);
    try {
      setImpact(
        await api<RuleImpact>('/api/admin/policy/rules/impact', {
          method: 'POST',
          body: JSON.stringify(draft()),
        }),
      );
    } catch (cause) {
      setFormError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be checked.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    setBusy(true);
    setFormError(null);
    try {
      await api('/api/admin/policy/rules', {
        method: 'POST',
        body: JSON.stringify(draft()),
      });
      setAdding(false);
      setName('');
      setIpRanges('');
      setContractField('');
      setContractValues('');
      setImpact(null);
      await load();
    } catch (cause) {
      // The failing detail is attached rather than replaced with a generic
      // apology: "that rule cannot be stored" without saying which part is
      // wrong sends the administrator back to guessing.
      setFormError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, delta: number) {
    if (!policy) return;
    const ids = policy.rules.map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await api('/api/admin/policy/rules/order', {
      method: 'PUT',
      body: JSON.stringify({ ruleIds: ids }),
    });
    await load();
  }

  async function remove(id: string) {
    await api(`/api/admin/policy/rules/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <>
      <PageHeader
        title="Authentication policy"
        description="The first rule that matches decides. Rules are evaluated top to bottom on every sign-in and every application launch."
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding((v) => !v)}>
            Add a rule
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {adding && (
        <Panel title="New rule">
          <div className="space-y-4 p-4">
            <Field label="Name" value={name} onChange={setName} required />

            <div>
              <label
                htmlFor="policy-outcome"
                className="mb-1.5 block font-medium text-ink"
              >
                Outcome
              </label>
              <select
                id="policy-outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as Rule['outcome'])}
                className="h-9 w-full rounded-control border border-border-subtle bg-bg px-3 text-ink"
              >
                {(Object.keys(OUTCOME_LABEL) as Rule['outcome'][]).map((value) => (
                  <option key={value} value={value}>
                    {OUTCOME_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>

            {outcome === 'require_factor' && (
              <div>
                <label htmlFor="policy-factor" className="mb-1.5 block font-medium text-ink">
                  Which factor
                </label>
                <select
                  id="policy-factor"
                  value={factorType}
                  onChange={(e) => setFactorType(e.target.value as 'totp' | 'webauthn')}
                  className="h-9 w-full rounded-control border border-border-subtle bg-bg px-3 text-ink"
                >
                  <option value="webauthn">Security key or passkey</option>
                  <option value="totp">Authenticator app</option>
                </select>
              </div>
            )}

            <Field
              label="Source addresses"
              value={ipRanges}
              onChange={setIpRanges}
              hint="CIDR ranges or single addresses, comma separated. Leave empty to match any address."
            />
            <Field
              label="Contract field"
              value={contractField}
              onChange={setContractField}
              hint="department, jobTitle, employer or location. Leave empty to ignore contracts."
            />
            <Field
              label="Contract values"
              value={contractValues}
              onChange={setContractValues}
              hint="Comma separated. A person with several concurrent contracts matches if any one of them does."
            />

            {impact && (
              <Alert
                tone={impact.usersNeedingEnrolment > 0 ? 'warning' : 'info'}
                title={`Matches ${impact.matchedUsers} of ${impact.totalActiveUsers} active users`}
              >
                <p>
                  {impact.usersNeedingEnrolment === 0
                    ? 'Everyone it matches already holds a factor that satisfies it.'
                    : `${impact.usersNeedingEnrolment} of them hold no factor that satisfies this rule, and will be asked to set one up the next time they sign in.`}
                </p>
                {impact.unevaluatedConditions.length > 0 && (
                  <p className="mt-1 text-sm text-muted">
                    Counted without {impact.unevaluatedConditions.join(' or ')}, which
                    only a real sign-in can supply. The true number is at most this.
                  </p>
                )}
              </Alert>
            )}

            {formError && (
              <Alert tone="danger">
                <span>{formError}</span>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={checkImpact}>
                Check who this affects
              </Button>
              <Button variant="primary" loading={busy} onClick={addRule}>
                Save rule
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <div className="mt-6 space-y-4">
        {!policy && !error && <SkeletonRows rows={3} cols={3} />}

        {policy && policy.rules.length === 0 && (
          <Empty title="No rules yet">
            Every sign-in falls through to the default below. Add a rule to require
            a second factor of a group, a department or an address range.
          </Empty>
        )}

        {policy && policy.rules.length > 0 && (
          <ol className="space-y-2">
            {policy.rules.map((rule, index) => (
              <li
                key={rule.id}
                className="flex items-start gap-3 rounded-panel border border-border-subtle bg-bg p-4"
              >
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-medium tabular-nums text-muted">
                  {rule.position}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{rule.name}</span>
                    <Status tone={OUTCOME_TONE[rule.outcome]}>
                      {OUTCOME_LABEL[rule.outcome]}
                      {rule.outcome === 'require_factor' && rule.factorType
                        ? `: ${rule.factorType === 'webauthn' ? 'security key' : 'authenticator app'}`
                        : ''}
                    </Status>
                    {!rule.enabled && <Status tone="neutral">Disabled</Status>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{conditions(rule).join(' · ')}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => move(index, -1)}>
                    Move up
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(index, 1)}>
                    Move down
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(rule.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}

        {policy && (
          <Panel title="Default">
            <p className="p-4 text-muted">
              When no rule matches:{' '}
              <span className="font-medium text-ink">
                {OUTCOME_LABEL[policy.fallback.outcome]}
              </span>
              .
            </p>
          </Panel>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Write the applications list**

`apps/web/src/pages/admin/ApplicationsPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

interface Row {
  id: string;
  name: string;
  slug: string;
  type: string;
  visibility: 'assigned' | 'hidden';
  status: string;
}

export function ApplicationsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [launchUrl, setLaunchUrl] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ applications: Row[] }>('/api/admin/applications');
      setRows(result.applications);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.problem.status === 403
          ? 'You do not have permission to view this.'
          : 'The application catalog could not be loaded.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setSlugError(null);
    setFormError(null);
    try {
      await api('/api/admin/applications', {
        method: 'POST',
        body: JSON.stringify({
          name,
          slug,
          launchUrl,
          ...(description ? { description } : {}),
        }),
      });
      setAdding(false);
      setName('');
      setSlug('');
      setDescription('');
      setLaunchUrl('');
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.problem.status === 409) {
        setSlugError('That slug is already used.');
      } else {
        setFormError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'That application could not be saved.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Applications"
        description="What your people can reach from the portal, and who each one is assigned to."
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding((v) => !v)}>
            Add an application
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {adding && (
        <Panel title="New application">
          <div className="space-y-4 p-4">
            <Field label="Name" value={name} onChange={setName} required />
            <Field
              label="Slug"
              value={slug}
              onChange={setSlug}
              required
              hint="Lower-case letters, digits and hyphens. It appears in URLs and cannot be changed later."
              error={slugError ?? undefined}
            />
            <Field label="Description" value={description} onChange={setDescription} />
            <Field
              label="Launch URL"
              value={launchUrl}
              onChange={setLaunchUrl}
              required
              hint="Where the tile opens. https:// only."
            />
            {formError && (
              <Alert tone="danger">
                <span>{formError}</span>
              </Alert>
            )}
            <Button variant="primary" loading={busy} onClick={create}>
              Save application
            </Button>
          </div>
        </Panel>
      )}

      <div className="mt-6">
        {!rows && !error && <SkeletonRows rows={4} cols={4} />}

        {rows && rows.length === 0 && (
          <Empty
            title="No applications yet"
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add an application
              </Button>
            }
          >
            Add one to give people a tile in their portal.
          </Empty>
        )}

        {rows && rows.length > 0 && (
          <Panel>
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium max-sm:hidden">Type</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Visibility</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/admin/applications/${row.id}`}
                        className="font-medium text-ink underline-offset-2 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="ml-2 text-sm text-muted">{row.slug}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">{row.type}</td>
                    <td className="px-4 py-2.5">
                      {row.visibility === 'hidden' ? (
                        <Status tone="neutral">Hidden</Status>
                      ) : (
                        <Status tone="primary">Assigned</Status>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {/*
                        A retired application stays in the list and stays
                        labelled. Hiding it to keep the table tidy would make
                        the catalog unauditable — the same rule as an inactive
                        user in the directory.
                      */}
                      <Status tone={row.status === 'active' ? 'active' : 'inactive'}>
                        {row.status === 'active' ? 'Active' : 'Retired'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Write the application detail screen**

`apps/web/src/pages/admin/ApplicationDetailPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

type SubjectType = 'user' | 'group' | 'orgUnit';

interface Assignment {
  id: string;
  subjectType: SubjectType;
  userId: string | null;
  groupId: string | null;
  orgUnitId: string | null;
}

interface Named {
  id: string;
  name: string;
}

const LABELS: Record<SubjectType, string> = {
  user: 'User',
  group: 'Group',
  orgUnit: 'Org unit',
};

export function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [assignments, setAssignments] = useState<Assignment[] | null>(null);
  const [users, setUsers] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [orgUnits, setOrgUnits] = useState<Named[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<SubjectType, string>>({
    user: '',
    group: '',
    orgUnit: '',
  });

  const load = useCallback(async () => {
    try {
      const [a, u, g, o] = await Promise.all([
        api<{ assignments: Assignment[] }>(`/api/admin/applications/${id}/assignments`),
        api<{ users: { id: string; displayName: string }[] }>('/api/admin/users'),
        api<{ groups: Named[] }>('/api/admin/groups'),
        api<{ orgUnits: Named[] }>('/api/admin/org-units'),
      ]);
      setAssignments(a.assignments);
      setUsers(u.users.map((row) => ({ id: row.id, name: row.displayName })));
      setGroups(g.groups);
      setOrgUnits(o.orgUnits);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.problem.status === 403
          ? 'You do not have permission to view this.'
          : 'This application could not be loaded.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (assignment: Assignment): string => {
    if (assignment.subjectType === 'user') {
      return users.find((row) => row.id === assignment.userId)?.name ?? 'Unknown user';
    }
    if (assignment.subjectType === 'group') {
      return groups.find((row) => row.id === assignment.groupId)?.name ?? 'Unknown group';
    }
    return orgUnits.find((row) => row.id === assignment.orgUnitId)?.name ?? 'Unknown org unit';
  };

  async function assign(type: SubjectType) {
    const subjectId = chosen[type];
    if (!subjectId) return;
    await api(`/api/admin/applications/${id}/assignments`, {
      method: 'POST',
      body: JSON.stringify({ type, id: subjectId }),
    });
    setChosen((current) => ({ ...current, [type]: '' }));
    await load();
  }

  async function unassign(assignmentId: string) {
    await api(`/api/admin/applications/${id}/assignments/${assignmentId}`, {
      method: 'DELETE',
    });
    await load();
  }

  const picker = (type: SubjectType, options: Named[]) => (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-56 flex-1">
        <label htmlFor={`pick-${type}`} className="mb-1.5 block font-medium text-ink">
          {LABELS[type]}
        </label>
        <select
          id={`pick-${type}`}
          value={chosen[type]}
          onChange={(e) => setChosen((c) => ({ ...c, [type]: e.target.value }))}
          className="h-9 w-full rounded-control border border-border-subtle bg-bg px-3 text-ink"
        >
          <option value="">Choose one…</option>
          {options.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </div>
      <Button onClick={() => assign(type)} disabled={!chosen[type]}>
        Assign
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Assignments"
        description="Who can reach this application, and how."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!assignments && !error && <SkeletonRows rows={3} cols={2} />}

      {assignments && (
        <Panel
          title="Assigned to"
          description="Assignments are a union: a person reaches this application if any one of them matches, and an assignment on a parent organizational unit reaches everyone below it."
        >
          <div className="space-y-4 p-4">
            {assignments.length === 0 && (
              <Empty title="Not assigned to anyone yet">
                Assign a group or an organizational unit rather than a list of
                people — it stays correct as people join and leave.
              </Empty>
            )}

            {assignments.length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {assignments.map((assignment) => (
                  <li key={assignment.id} className="flex items-center justify-between py-2">
                    <span>
                      <span className="text-sm text-muted">
                        {LABELS[assignment.subjectType]}
                      </span>
                      <span className="ml-2 font-medium text-ink">{nameOf(assignment)}</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => unassign(assignment.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-3 border-t border-border-subtle pt-4">
              {picker('user', users)}
              {picker('group', groups)}
              {picker('orgUnit', orgUnits)}
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}
```

- [ ] **Step 5: Add the navigation**

In `apps/web/src/pages/admin/AdminApp.tsx`, add to `NAV`, after the org-units
entry:

```ts
  { to: '/admin/applications', label: 'Applications', permission: 'access.read' },
  { to: '/admin/policy', label: 'Authentication policy', permission: 'policy.read' },
```

and to the `<Routes>`:

```tsx
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="applications/:id" element={<ApplicationDetailPage />} />
            <Route path="policy" element={<PoliciesPage />} />
```

- [ ] **Step 6: Run and commit**

```bash
pnpm exec tsc -b
pnpm --filter @syntra/web test
git add -A
git commit -m "feat: add application and policy administration screens"
```

---

## Task 16: Administrative step-up, the seed, and whole-slice verification

**Files:**
- Modify: `apps/api/src/routes/auth.ts` — `/elevate` through `authorize()`
- Modify: `packages/db/src/seed.ts`
- Modify: `README.md`
- Modify: `e2e/README.md`
- Create: `e2e/access-mfa.spec.ts`
- Test: `apps/api/src/routes/auth.test.ts` — extend

**Interfaces:**
- Consumes: everything built in Tasks 1–16.
- Produces: an elevation path that honours `Tenant.adminMfaRequired`, a seed a developer can demonstrate the slice from, and an end-to-end test over the whole thing.

- [ ] **Step 1: Write the failing elevation test**

Append to `apps/api/src/routes/auth.test.ts`. Add `prisma` to the `@syntra/db`
import, `generateRecoveryCodes` to the `@syntra/core` import, and
`import * as OTPAuth from 'otpauth';` at the top of that file first — `prisma.tenant.update` is used directly because `Tenant` is
the one model deliberately outside row-level security.

```ts
describe('POST /api/auth/elevate and admin MFA', () => {
  it('elevates on the password alone when the tenant does not require a factor', async () => {
    await seedUser({ admin: true });
    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    expect(res.json()).toMatchObject({ status: 'authenticated', scope: 'admin' });
  });

  it('challenges instead when the tenant requires a factor for the console', async () => {
    const user = await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });
    await withTenant(ctx.tenantId, (tx) => generateRecoveryCodes(tx, user.id));

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    expect(res.json()).toMatchObject({ status: 'challenge' });
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });

  it('offers enrolment to an administrator who has no factor yet', async () => {
    await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    // Turning the requirement on must not strand the only administrator
    // outside the console with nobody able to let them back in.
    expect(res.json()).toMatchObject({ status: 'enrol' });
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });

  it('refuses outright when the tenant has also turned self-enrolment off', async () => {
    await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true, selfEnrolmentEnabled: false },
    });

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    // Two deliberate decisions stacked: factors are issued by hand, and the
    // console needs one. There is genuinely no path forward from here.
    expect(res.statusCode).toBe(401);
  });

  it('issues an admin session when an elevation enrolment completes', async () => {
    await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;
    const offer = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });
    const attemptToken = offer.json().attemptToken as string;

    const begin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/enrol/totp/begin',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { attemptToken },
    });
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(begin.json().secret),
      period: 30,
      digits: 6,
      algorithm: 'SHA1',
    });

    const done = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/enrol/totp/confirm',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { attemptToken, code },
    });
    // The caller already held a portal session, so the step-up ends in an
    // administrative one rather than a second portal session.
    expect(done.statusCode).toBe(200);
    expect(done.json().scope).toBe('admin');
  });

  it('issues an admin session when the challenge is answered', async () => {
    const user = await seedUser({ admin: true });
    await prisma.tenant.update({
      where: { id: ctx.tenantId },
      data: { adminMfaRequired: true },
    });
    const codes = await withTenant(ctx.tenantId, (tx) =>
      generateRecoveryCodes(tx, user.id),
    );

    const portal = await login(PASSWORD);
    const cookie = cookieOf(portal)!.value;
    const challenge = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: { password: PASSWORD },
    });

    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie}` },
      payload: {
        type: 'recovery_code',
        attemptToken: challenge.json().attemptToken,
        code: codes[0],
      },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().scope).toBe('admin');
  });
});
```

- [ ] **Step 2: Add the MFA floor to elevation**

Task 4 already routed `/elevate` through `authorize()` with `scope: 'admin'`.
The only thing this task adds is the floor, so that a tenant which requires a
second factor for the console actually gets one. In
`apps/api/src/routes/auth.ts`, read the tenant alongside the relying party and
pass the floor:

```ts
      const { tenant, rp } = await relyingPartyFor(request);

      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        principal: { kind: 'password', login: user.login, password: body.password },
        applicationId: null,
        sourceIp: request.ip,
        relyingParty: rp,
        scope: 'admin',
        // A floor the caller imposes. It can only strengthen the policy
        // outcome — a tenant rule that denies is still a denial, and a floor
        // never turns one into an allow.
        ...(tenant.adminMfaRequired ? { floor: 'require_mfa' as const } : {}),
      });
```

Nothing else in the handler changes. The three non-allow branches, the session
creation and the audit event were all written in Task 4.

There is no `scopeForStepUp` and no scope inference anywhere. `AuthAttempt.scope`
records `'admin'` at the moment this handler opens the attempt, and
`/api/auth/mfa/verify` and `/api/auth/enrol/*` read it back through
`AuthorizeResult.scope`. Deriving it instead from whether a session cookie was
present would give an administrative session to any portal user completing a
launch step-up, because the browser sends its cookie on every request — which is
exactly the mitigation spec section 5 names for shipping one React application
to two audiences.

- [ ] **Step 3: Verify nothing bypasses the chokepoint**

```bash
grep -rn "from '@syntra/core/src/auth/login-service" apps packages --include=*.ts --include=*.tsx
grep -rn "\bauthenticate(" apps packages --include=*.ts --include=*.tsx | grep -v 'packages/core/src/auth/'
```

Expected: no output from either.

Two greps rather than one for `authenticate`, because the plan introduces a
`status: 'authenticated'` literal in five response bodies and a bare
`grep authenticate` matches every one of them. The first finds a deep import of
the module; the second finds a call, anchored on the opening parenthesis and
excluding the one directory entitled to make it.

- [ ] **Step 4: Run the elevation tests**

Run: `pnpm vitest run apps/api/src/routes/auth.test.ts apps/api/src/routes/mfa.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the seed**

In `packages/db/src/seed.ts`, inside the `withTenant` block after the groups and
people are created, add:

```ts
  // Three tiles, so the portal has something in it on a fresh install and the
  // three assignment kinds are each exercised by the seed rather than only by
  // tests.
  const wiki = await createApplication(tx, {
    name: 'Staff handbook',
    slug: 'handbook',
    description: 'Policies, rotas and induction material.',
    launchUrl: 'https://example.com/handbook',
  });
  const rota = await createApplication(tx, {
    name: 'Rota planner',
    slug: 'rota',
    description: 'Shift patterns for the coming month.',
    launchUrl: 'https://example.com/rota',
  });
  const finance = await createApplication(tx, {
    name: 'Expenses',
    slug: 'expenses',
    description: 'Submit and approve claims.',
    launchUrl: 'https://example.com/expenses',
  });

  await assignApplication(tx, wiki.id, { type: 'orgUnit', id: headOffice.id });
  await assignApplication(tx, rota.id, { type: 'group', id: nurses.id });
  await assignApplication(tx, finance.id, { type: 'user', id: owner.id });

  // One rule, shipped disabled. Nobody is locked out by it — a user with no
  // factor is offered enrolment rather than refused — but a fresh install
  // should not push a developer through enrolment on their first sign-in
  // before they have seen anything. Turning it on is one click in the console.
  await addRule(tx, {
    name: 'Finance, offsite, needs a second factor',
    outcome: 'require_mfa',
    enabled: false,
    contractField: 'department',
    contractValues: ['Finance'],
  });
```

Import `createApplication`, `assignApplication` and `addRule` from
`@syntra/core`, and make sure `nurses` and `headOffice` are the variable names
the existing seed uses — read the file rather than assuming.

The rule ships **disabled**. A seed that locked a developer out of their own
instance on first run would be the last thing they see of Syntra.

- [ ] **Step 6: Typecheck the workspace**

Run: `pnpm exec tsc -b`
Expected: 0 errors.

Vitest transpiles without type-checking, so this is the only thing that catches
a signature drift between `authorize()`, the verifiers and the routes.

- [ ] **Step 7: Run every suite in order**

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm test
pnpm --filter @syntra/web test
pnpm db:reset
SEED_ADMIN_PASSWORD='...' SEED_USER_PASSWORD='...' pnpm seed
AUTH_RATE_LIMIT_MAX=200 pnpm dev &
pnpm e2e
```

Expected: every suite green. The ordering matters — the integration tests
truncate the database, so the seed runs after them, and the browser suite needs
a raised rate limit because it signs in far more often in a minute than a person
would.

- [ ] **Step 8: Write the end-to-end test**

`e2e/access-mfa.spec.ts`, following the helpers already in `e2e/access.spec.ts`.

Two properties this file has to have, both learned the hard way. It runs
`describe.serial`, because the tests share one seeded database and a rule saved
by one is in force for the next. And the test that saves a `require_mfa` rule
removes it again before it finishes, because a leftover rule turns every
subsequent sign-in in the file — including the administrator's — into a
forced-enrolment screen, and the failure surfaces three tests away from its
cause.

```ts
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
  await new Promise((resolve) => setTimeout(resolve, 30_000 - (Date.now() % 30_000) + 1_000));
}

test.describe.serial('access', () => {
  test('a user sees the tiles their organization assigned them', async ({ page }) => {
    await signIn(page, 'jdoe', USER!);
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /rota planner/i })).toBeVisible();
    // Assigned to the owner only, so it must not appear here.
    await expect(page.getByRole('button', { name: /expenses/i })).toHaveCount(0);
  });

  test('a user with no factor is enrolled rather than refused, and challenged next time', async ({
    page,
  }) => {
    test.setTimeout(120_000); // one wait for the next TOTP step

    // Turn on a rule that demands a factor, as an administrator.
    await signIn(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/policy');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await page.getByLabel('Name').fill('Everyone needs a factor');
    await page.getByLabel('Outcome').selectOption('require_mfa');

    // The count is shown before the rule is saved, not discovered afterwards.
    await page.getByRole('button', { name: /check who this affects/i }).click();
    await expect(page.getByText(/active users/i)).toBeVisible();

    await page.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.getByText('Everyone needs a factor')).toBeVisible();
    await signOut(page);

    // A user who has never enrolled is offered enrolment, not a dead end.
    await signIn(page, 'jdoe', USER!);
    await expect(
      page.getByRole('heading', { name: /set up a second factor/i }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Start' }).click();

    const secret = await page.getByText(/^[A-Z2-7]{32}$/).innerText();
    await page.getByLabel('Six-digit code').fill(codeFor(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();

    // Enrolling is proof of possession, so the sign-in completes rather than
    // immediately asking for the same code again.
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();

    // Signing in again now takes the step-up path instead.
    await signOut(page);
    await waitForNextTotpStep();
    await signIn(page, 'jdoe', USER!);
    await expect(page.getByRole('heading', { name: /one more step/i })).toBeVisible();
    await page.getByLabel('Six-digit code').fill(codeFor(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();
    await signOut(page);

    // Put the tenant back. A leftover require_mfa rule sends every later
    // sign-in in this file to the enrolment screen, and the failure would
    // surface in a test that has nothing to do with it.
    await signIn(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/policy');
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Everyone needs a factor' })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(page.getByText('Everyone needs a factor')).toHaveCount(0);
    await signOut(page);
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
    await signIn(page, 'admin', ADMIN!);
    await elevateTo(page, '/admin/applications');
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
    await expect(page.getByRole('link', { name: /staff handbook/i })).toBeVisible();
  });
});
```

The reset mail itself is read in MailDev at `http://localhost:1080` during
development. The end-to-end test asserts the enumeration-safe response rather
than the mail, because the mail assertion belongs to the integration test in
Task 10 where the transport is in memory.

The WebAuthn path is not driven here. Playwright's virtual authenticator can do
it, but the relying party now comes from `Tenant.primaryDomain`, and the seeded
tenant's is `acme.localhost` while the browser suite runs against
`acme.localhost:5173` — the origin matches, so it would work, but the setup is
worth its own spec rather than being smuggled into this one. The server-side
behaviour is covered exhaustively in Task 6 against a software authenticator.

- [ ] **Step 9: Update the documentation**

In `README.md`, mark Access I built in the module table and add a short section:

- Every sign-in, every elevation and every application launch goes through one
  `authorize()` in `packages/core/src/auth/authorize.ts`. Nothing issues a
  session without a decision from it.
- The authentication policy is an ordered list of rules; the first that matches
  decides, and when none does the tenant default applies. Rules match on target
  application, group, contract attribute, source address and time window, and a
  contract condition matches if any of the person's currently active contracts
  satisfies it.
- Second factors are TOTP and WebAuthn, with single-use recovery codes as the
  fallback. A user enrols their own at `/security`; an administrator can clear
  someone's factor from the user page when they lose a phone.
- **A policy that requires a factor the user does not hold offers enrolment
  rather than refusing.** The password has already been accepted at that point;
  the token they receive buys exactly one thing — enrolling a factor of the
  required kind — and no session is issued until it succeeds. Without this, the
  first tenant-wide `require_mfa` rule would lock out everyone who had not
  already enrolled, and MFA would be a feature nobody could switch on. The
  trade is that whoever holds a password can enrol their own factor, so every
  such enrolment is audited with `underForcedEnrolment: true`. A tenant that
  issues factors by hand sets `Tenant.selfEnrolmentEnabled` to false, and then
  a missing factor really is a refusal.
- Before a policy rule is saved, the console reports how many users it matches
  and how many of them would be asked to enrol — the same courtesy Directory
  Sync's deactivation threshold provides, for the same shape of mistake. Above
  25,000 active users it answers from counts instead of walking the directory,
  and names the conditions it could not apply.
- **Whenever a second factor is added to an account, its owner is mailed.**
  Not only under forced enrolment: a factor added with a stolen password is the
  worse case precisely because it survives the password reset that would
  otherwise fix things, and the owner is the only person who can tell a
  legitimate enrolment from an attacker's. The audit event
  (`mfa.enrolled`, with `underForcedEnrolment`) is there too — **wire it into
  your alerting.** An audit row nobody reads does not discharge the obligation.
- **Security keys need `Tenant.primaryDomain` set.** WebAuthn pins the relying
  party server-side; Syntra derives it from the tenant's own domain and refuses
  a request that arrives on any other host. Taking it from the `Host` header
  instead would let anyone who proxies Syntra under their own name choose what
  their assertion is checked against, which is the entire property a security
  key exists to provide. A tenant with no primary domain gets a message saying
  so, and authenticator apps still work.
- Self-service password reset answers identically whether or not the account
  exists. A user with a second factor must present it, completion revokes every
  session and refresh token, and an account whose password lives upstream is
  told by mail where to go instead.
- `Tenant.adminMfaRequired` makes a second factor mandatory for reaching the
  administration console. It is off by default so an existing tenant's owner is
  not locked out by the migration; turn it on once the owner has enrolled.

In `e2e/README.md`, add a third bullet under the two that are already there:

> **The MFA spec runs `describe.serial` and cleans up after itself.** It signs
> in as the administrator, saves a rule requiring a second factor for everyone,
> drives a user through forced enrolment and a step-up, and then removes the
> rule again. The removal is not tidiness: a rule left in force sends every
> later sign-in in the file — the administrator's included — to the enrolment
> screen, and the failure surfaces in a test that has nothing to do with it.
>
> It is still worth running `pnpm db:reset && pnpm seed` between runs, because
> the enrolled factor is not cleaned up, and a second run would find `jdoe`
> already holding one.
>
> **One test waits up to 31 seconds.** Confirming a TOTP enrolment sets the
> replay watermark to the step it happened in, so the next code is refused
> until that step ends. The integration tests backdate the enrolment; a browser
> cannot, so it waits. That test raises its own timeout to 120 seconds.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: require a second factor for the console, seed the catalog, and cover the slice end to end"
```

---

## Plan self-review

**Spec coverage.** Every part of the spec in Access I's scope maps to a task:

| Spec | Task |
|---|---|
| §6 Access — `Application` | 1, 11, 12, 15 |
| §6 Access — `AppAssignment`, union resolution | 1, 11, 12, 13, 15 |
| §6 Credentials — `TotpCredential`, encrypted secret, replay window | 1, 5 |
| §6 Credentials — `WebAuthnCredential` (id, key, counter, transports, attestation) | 1, 6 |
| §6 Credentials — `RecoveryCode`, single-use, hashed | 1, 7 |
| §6 Credentials — `PasswordResetToken`, single-use, hashed, time-limited | 1, 10 |
| §6 Credentials — `Session`, `RefreshToken` with revocation | 1, 10 |
| §6 Access — `AuthPolicy`, `AuthPolicyRule` | 1, 3, 12, 15 |
| §7 Single chokepoint | 4, and every caller in 8, 9, 13, 16 |
| §8 ordered rules, first match wins | 2, 3 |
| §8 match on application, group, contract attribute, IP/CIDR, time window | 2 |
| §8 a contract condition matches if any active contract satisfies it | 2, 3 |
| §8 outcomes allow / require_mfa / require_factor / deny | 2, 4 |
| §8 tenant default when nothing matches | 2, 3, 12 |
| §8 pure function of rule set and context | 2 |
| §9 reset step 1 — identical response | 10 |
| §9 reset step 2 — single-use, time-limited, hashed token, mailed | 10 |
| §9 reset step 3 — password policy, second factor required | 10 |
| §9 reset step 4 — revoke sessions and refresh tokens, audit | 10 |
| §9 upstream password → told where to go | 1, 10 |
| §9 notifications through the existing service | 8, 10 |
| §5 administrative sessions require step-up MFA | 16 |
| §5 scope separation between the two audiences | 1, 4, 13, 16 |
| §11 typed results, RFC 9457, uniform auth responses | 4, 8, 9, 10, 12, 13 |
| §12 rate limiting on authentication endpoints | 8, 9, 10, 12, 13 |
| §12 every privileged action audited | 4, 8, 9, 10, 12, 13 |
| §12 RLS as the tenant isolation control | 1 |
| §13 exhaustive policy tests, multi-contract cases | 2, 3 |
| §13 end-to-end over login, enrolment, challenge, launch | 16 |
| Ruling A — forced enrolment instead of deny | 1, 4, 5, 9, 14, 16 |
| Ruling A — audit naming the forced-enrolment challenge | 4, 9 |
| Ruling A — affected-user count before a rule is saved | 9, 12, 15 |
| Ruling B — attempt and its audit event in one transaction | 4, 5 |
| Ruling C — explicit `relyingParty` on `AuthorizeRequest` | 4, 6, 8, 9, 10, 13 |
| Ruling D — TOTP watermark kept, tests moved, refusal explained | 4, 5, 8, 13, 14, 16 |
| Ruling E — `AuthAttempt.scope`, never inferred | 1, 4, 8, 9, 13, 16 |
| Ruling F — relying party from `Tenant.primaryDomain` | 1, 4, 6, 8, 9, 14 |
| Ruling G — recovery codes require an existing factor | 8 |
| Ruling H — mail the owner when a factor is added | 8, 9 |
| Ruling I — `previewRuleImpact` capped, rate-limited, stronger permission | 9, 12 |
| Ruling J — an unevaluable condition matches a `deny` rule | 2 |
| Access II (SAML, OIDC, federation, claim mappings, metadata) | **not built**; `Principal.external` and `AuthorizeRequest.applicationId` in Task 4 are the mount points |

**Placeholder scan.** No "TBD", no "add appropriate validation", no "similar to
Task N". The four prose-instead-of-code steps the pre-flight review named are
gone: `ApplicationsPage` and `ApplicationDetailPage` are written out in Task 15
Steps 3 and 4; the `setPasswordHash` hoist in Task 10 is a code block whose
call site now matches it; Task 3's "check its return type before running" is
replaced by the verified answer (`listGroupsForUser` returns `Group` rows); and
Task 9's "drop it if your editor says it is unused" is replaced by the exact
import line, which does not contain the unused name.

**Type consistency across this revision.** Re-checked every name the nine
findings and six rulings moved:

- `ConditionResult` (Task 2, `ip-match.ts`) is what `evaluateIpRanges` and
  `evaluateTimeWindow` return and what `ruleMatches` resolves against
  `rule.outcome`. `matchesIpRanges` and `matchesTimeWindow` survive as
  one-line boolean wrappers, so the existing tests and `isValidTimeZone`
  callers are untouched. `isIpRangeUsable` is what `validate()` in Task 3 now
  calls — a parse in a try/catch, not a matcher pressed into service as a
  syntax check.
- `AuthAttempt.scope` (Task 1) is set by `issueAttempt` from
  `IssueAttemptInput.scope` (Task 4), which `decide()` fills from
  `AuthorizeRequest.scope`, which `/login` sets to `'portal'` (Task 4),
  `/elevate` to `'admin'` (Task 4) and `/launch` to `'portal'` (Task 13). It
  comes back on `ResolvedAttempt.scope`, then on `AuthorizeResult.scope`, and
  is what `/api/auth/mfa/verify` (Task 8) and `/api/auth/enrol/*` (Task 9) pass
  to `createSession`. There is no `scopeForStepUp` and no other reader.
- `Session.satisfiedFactor` (Task 1) is written by `createSession` (Task 4
  Step 11), returned on `ResolvedSession` (same step), read by `/launch` into
  `Principal.session.satisfiedFactor` (Task 13), and consumed by `decide()` via
  `DecideInput.satisfied` (Task 4). The round trip is tested in Task 13.
- `RelyingParty { id, origin }` is produced only by `tenantRelyingParty` (Task
  4, `routes/relying-party.ts`). Callers: `/login` and `/elevate` (4),
  `/api/auth/mfa/*` through `webauthnContext` (8), `/api/auth/enrol/*` (9),
  `/password-reset/complete` (10), `/launch` (13). `RelyingPartyIdentity` adds
  `name` and is used only by the two registration functions. Nothing derives
  either from `request.headers.host` any more except `assertWebAuthnUsable`,
  whose entire job is to compare the two and refuse.
- `DenyReason` gained `factor_used_for_enrolment`, produced by `continueAttempt`
  (4) from the verifier reason `totp_used_for_enrolment` (5), mapped to the
  problem type `code-already-used-for-setup` by `/api/auth/mfa/verify` (8), and
  rendered by `MfaChallenge` (14). Four hops, one string each, all four checked.
- `acceptableFactors` is `FactorPresentationType[]` on `AuthorizeResult` (4) and
  includes `'recovery_code'`, which `PendingChallenge.factors` carries (14) and
  the step-up screen selects its initial mode from.
- `renderMessage` / `sendMessage` (Task 8) replace `notify`. Callers:
  `tellOwnerAFactorWasAdded` (8, module scope, transport as a parameter so
  Task 9's separately-registered router can call it), and the three sends in
  `password-reset.ts` (10). `notify` appears nowhere except in the prose
  explaining its removal.
- `previewRuleImpact(tx, rule, now?, caps?)` (9) is called by
  `/api/admin/policy/rules/impact` (12) and rendered as `RuleImpact` by
  `PoliciesPage` (15); the four field names match across all three.

**Findings from the pre-flight review, and where each is now.**

| Finding | Fixed in |
|---|---|
| C1 SMTP inside three transactions | 8 (the split), 10 (the three sends) |
| C2 scope inferred from a cookie | 1 (`AuthAttempt.scope`), 4, 8, 9, 13, 16 |
| C3 relying party from the `Host` header | 4 (`relying-party.ts`), 6, 8, 9, 10, 13, 14 |
| H1 `validate()` rejecting real networks | 2 (`isIpRangeUsable`), 3 (validator + a test that stores valid ranges) |
| H3 Task 10 cannot compile | 10 (exports moved out of 11) |
| H4 the TOTP watermark | 5 (distinct reason), 8 and 13 (backdated enrolment), 14 (screen copy), 16 (e2e waits a step) |
| H5 the launch challenge loop | 1, 4, 13 (and the round-trip test) |
| H6 recovery codes defeat forced enrolment | 8 |
| M12 the fail-open on `deny` | 2 |
| M1 e2e ordering and the `authenticate` grep | 16 |
| M9 `/elevate` importing `authenticate` | 4 (routed through `authorize()` immediately) |
| M2 empty `acceptableFactors` | 4, 14 |
| M3 counter classified by message text | 6 (a test that fails if the wording changes) |
| M4 `counter` int4 vs uint32 | 1 (BigInt), 6 (conversion at the library boundary) |
| M6 concurrent reset requests | 10 (`P2002` treated as "someone else just did it") |
| M7 the generated migration's `DROP INDEX` | 1 (a step that reads it before appending) |
| M8 a recovery code spent before the attempt is consumed | 4 (activity checked first, residual window documented) |
| M10 `/totp/begin` 500 | 8 |
| four prose-instead-of-code steps | 3, 9, 10, 15 |
| Task 5 test arithmetic | 5 (31, not 32) |

**Three things this revision found that the review did not.**

1. `tellOwnerAFactorWasAdded` was first written inside `registerMfaRoutes` and
   exported from there, which does not compile — Task 9's router imports it. It
   is at module scope, with the transport as a parameter rather than a closure
   over `options`, because the two routers are registered separately.

2. Task 10's password-reset route still imported `relyingPartyFor` from
   `./auth.js` after that helper stopped existing in its old form. It reads the
   tenant and calls `tenantRelyingParty` like every other caller. This is the
   unauthenticated endpoint, so it is the last place that should have been
   trusting a header.

3. `previewRuleImpact` selected all four contract columns unconditionally while
   a rule can only name one. It now selects the named field, which also means
   the unselected columns arrive as `undefined` and are normalised to `null`
   before the engine sees them — the engine distinguishes "no value" from "not
   asked for", and `undefined` would have matched neither branch cleanly.

---

## Execution handoff

Plan complete and saved to
`docs/superpowers/plans/2026-08-15-syntra-access-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between
tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans,
batch execution with checkpoints.

Which approach?
