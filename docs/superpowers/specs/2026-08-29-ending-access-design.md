# Ending access

Status: designed, 2026-08-29
Based on `c025fb8`

Three features that look unrelated on a roadmap and are one story in the code:
a session inventory with revocation, client authentication on the OIDC
revocation and introspection endpoints, and OpenID Connect back-channel
logout. Each is a different protocol's answer to the same question — **how does
somebody's access actually stop?** — and today each answers it differently, or
not at all.

This is sub-project A of four. The others are observability (a security webhook
group and a metrics endpoint), backup and restore, and machine access (API
tokens, then an inbound SCIM server). They are separate documents.

## Why

Three statements in the documentation are the specification for this work,
because all three are admissions.

`docs/configure.md:479` tells an operator that a policy change does not reach
live sessions, and that **"if you need a rule to bite immediately, revoke the
sessions as well."** There is no way to do that. `revokeAllForUser` exists in
`packages/core/src/auth/session-service.ts:221` and is reachable only as a side
effect of a password reset or a deactivation. An administrator following the
documentation's own instruction has to change somebody's password to carry it
out.

`docs/configure.md:518` says token revocation and introspection are advertised
and do not work. That is half stale and half true, and the true half is not the
half it describes — see "Client authentication", below.

`docs/configure.md:493` says single logout does not propagate, that **"single
logout is a local logout with a protocol answer attached,"** and that an
offboarding procedure must not rely on it. That is honest and it is also the
gap: the one thing an IAM platform is bought to do at speed is take access
away, and Syntra currently takes it away from itself and tells nobody.

The three share code as well as a theme. All three end at
`revokeAllRefreshTokensForUser`, `OidcArtifact`, and the session table, and the
outbound half of back-channel logout is a retry queue Syntra already has,
written for webhooks and tested.

## Ruling: one funnel, not three callers

**Every Syntra-side revocation of a user's sessions goes through one function,
and that function is the only thing that revokes artifacts and enqueues logout
tokens.**

The alternative — propagating on deactivation and administrative revocation but
not on a routine password change — was considered and rejected. It makes the
behaviour of revocation depend on which caller invoked it, and
`packages/core/src/auth/refresh-token.ts:1` is a docstring about exactly that
failure having already happened once here:

> the version of this function that revoked only the empty one satisfied the
> letter of every caller and none of the point: a phished password already
> exchanged for a refresh token survived the reset for fourteen days

A second version of that bug is available for free the moment propagation is a
thing some callers remember to do. It is not offered.

The consequence to accept deliberately: a self-service password change signs
the person out of every relying party, not just out of Syntra. That is the
correct behaviour for the act — a password change after somebody else has
learned the password is cosmetic if the sessions it bought stay alive — and it
is the same reasoning `revokeAllForUserExcept` already applies inside Syntra.

## 1. Session inventory

### Schema

Two columns on `Session` (`packages/db/prisma/schema.prisma:591`):

```prisma
  /// The address the session was established from, as the trusted-proxy
  /// resolution reports it. Descriptive, never authoritative: nothing reads
  /// this to make a decision.
  ip        String?
  /// The User-Agent header at establishment, truncated. Stored so a person
  /// can recognise a session in a list; a list of scopes and timestamps is
  /// not recognisable, and an unrecognisable list gets revoked wholesale.
  userAgent String?
```

Both nullable, because sessions predating the migration have neither and a
backfill would have to invent them. An index on `(userId, revokedAt)` for the
list query.

`userAgent` is truncated at 256 bytes on write. It is attacker-controlled text
of unbounded length, and the column exists to be read by a human, not parsed.

### Why these do not ride in on the decision

`createSession` (`session-service.ts:85`) takes a `SessionAllowance` and
nothing else, and its docstring says why:

> Everything the session records — who it belongs to, its scope, the factor
> that established it — is read off the decision, never taken from ambient
> request state. A route that thought it knew the user id is how an elevation
> came to pass one value while its decision carried another.

IP and user agent *are* ambient request state. They cannot be added to
`SessionAllowance` without making that sentence false, and making it false is
how the elevation bug comes back. They therefore arrive as a **separate second
parameter**:

```ts
export interface SessionOrigin {
  ip: string | null;
  userAgent: string | null;
}

export async function createSession(
  tx: TenantClient,
  decision: SessionAllowance,
  origin: SessionOrigin,
): Promise<{ token: string; expiresAt: Date }>;
```

Two parameters with two meanings: the decision carries authority, the origin
carries description. The split is the documentation.

The address comes from the existing trusted-proxy resolution that the per-IP
rate limits already use (`packages/core/src/config.ts:81` describes what
happens when it is misconfigured — every per-IP bucket collapses into one). A
second way of computing a client address would be a second thing to get wrong,
and the two would disagree in exactly the deployment where it matters.

### Core

```ts
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

export async function listSessionsForUser(
  tx: TenantClient,
  userId: string,
): Promise<SessionSummary[]>;

export async function revokeSessionById(
  tx: TenantClient,
  sessionId: string,
): Promise<boolean>;
```

`listSessionsForUser` returns live sessions only, newest first, applying the
same liveness rules `resolveSession` does — idle timeout and absolute expiry,
not just `revokedAt`. Two answers to "is this session still good" is one answer
too many, and the existing `readSession` docstring says so.

The token hash is never returned. There is no route on which a session's
identifier needs to be the thing that authenticates it.

### API

Admin, under the existing account routes:

| Route | Does |
|---|---|
| `GET /api/admin/users/:id/sessions` | The user's live sessions |
| `DELETE /api/admin/users/:id/sessions/:sessionId` | One session |
| `POST /api/admin/users/:id/sessions/revoke` | All of them, through the funnel |

Portal, for the signed-in user's own:

| Route | Does |
|---|---|
| `GET /api/portal/sessions` | Own live sessions, the caller's flagged `current: true` |
| `DELETE /api/portal/sessions/:id` | One, including the current one |

Revoking your own current session is allowed and is **not** silent: the
response says the caller was signed out, and the cookie is cleared in the same
reply. Refusing it would be worse — the session a person most wants to end from
another device is the one they are looking at.

Both admin routes require an elevated session, like every other administrative
write. Neither requires step-up MFA: revocation grants nothing.

### Console

Admin: a **Sessions** tab on `AccountDetailPage`, listing scope, where from,
when established, when last seen, with a revoke on each row and a revoke-all
above them.

Portal: a **Your devices** panel on the profile page, the same list for the
signed-in user, with the current session marked as such and every other row
revocable.

Neither list explains itself in prose. A row reading `Firefox on Windows ·
81.2.x · signed in 2 hours ago · last seen 4 minutes ago` is a control somebody
can act on; the same row without the origin columns needs a paragraph next to
it saying how to tell your sessions apart, and a control that needs explaining
is the wrong control.

### Audit

A `session.revoked` event carrying actor, subject, the count, and how it was
triggered (`admin`, `self`, `password_reset`, `password_change`,
`deactivation`). This is what makes `configure.md:479`'s instruction checkable
after the fact rather than merely followable.

## 2. Client authentication on revocation and introspection

### What is actually broken

`docs/configure.md:518` describes a 415. That was real and is fixed:
`apps/api/src/routes/oidc-op.ts:260` registers a pass-through parser so a
form-encoded POST reaches oidc-provider on the catch-all, and
`oidc-boundary.test.ts:115` pins it. The documentation describes the symptom
that was cured.

The remaining defect is narrower and is stated in
`oidc-boundary.test.ts:145`. Syntra authenticates clients itself for `/token`
— constant-time, against the stored SHA-256 hash — and hands oidc-provider a
placeholder secret it never learns the real value of. That is what makes
`/token` safe. The consequence is that **every other client-authenticated
endpoint answers `invalid_client` to a client presenting its correct secret**,
because the provider is comparing against a value nobody holds.

So revocation and introspection are reachable, parse their bodies, and reject
every client that exists.

### The fix

Stop routing them through the catch-all. `registerOidcTokenRoutes`
(`apps/api/src/routes/oidc-token.ts:294`) is the plugin that owns real client
authentication; revocation and introspection become explicit routes in it,
registered ahead of the catch-all, authenticating with the same
`presentedCredentials` reader and the same constant-time hash comparison
`/token` uses. oidc-provider keeps the placeholder and keeps owning discovery,
authorization, userinfo and end_session.

**Revocation** (RFC 7009). Accepts `token` and an optional `token_type_hint`.
Resolves the token against `OidcArtifact`; if it belongs to the authenticated
client, revokes it and its grant chain through
`artifactRevokeByGrantId` (`packages/core/src/access/oidc-store.ts:132`).
Answers `200` with an empty body whether or not the token existed, whether or
not it had already been revoked, and whether or not it belonged to the caller —
the spec requires this, and it is also the only answer that does not turn the
endpoint into an oracle for guessing other clients' tokens.

**Introspection** (RFC 7662). Answers `{"active": false}` for a token that is
unknown, expired, revoked, **or issued to a different client**. For the
client's own live token it answers `active: true` with `sub`, `scope`,
`client_id`, `exp`, `iat` and `token_type`.

That cross-client rule is the security property of this section and is stated
here so it is not traded away later for a debugging convenience. An
introspection endpoint that describes any token presented to it lets a client
that holds one token learn the subject and scope of another.

Both endpoints are rate-limited on the same limiter the other protocol routes
use. `oidc-grants.test.ts:680` records that a missing rate limit on a protocol
route has been found here before.

### The pin that gets replaced

`oidc-boundary.test.ts:145` asserts the `invalid_client` behaviour **on
purpose**, with a comment explaining that it is written down "rather than
discovered." That test is rewritten by this work.

This is called out rather than done quietly because overturning a deliberate
pin is a decision. The pin was correct as a description of a boundary nobody
had crossed; this crosses it. What replaces it asserts the opposite and for the
same reason — that a client presenting its real secret is authenticated on
these two endpoints and on no others that oidc-provider owns.

## 3. Back-channel logout

### Registration

Two columns on `OidcClient` (`schema.prisma:1357`):

```prisma
  /// Where a logout token is POSTed when this client's user's session ends.
  /// Null means this client is not told, which is the default and is visible
  /// as such in the console.
  backchannelLogoutUri             String?
  /// Whether the logout token must carry `sid`. Per the spec; a client that
  /// asks for it and does not get it must reject the token.
  backchannelLogoutSessionRequired Boolean @default(false)
```

Discovery gains `backchannel_logout_supported: true` and
`backchannel_logout_session_supported: true`.

The URI is validated on write by the same address check the webhook endpoints
use, so a logout token cannot be aimed at a link-local address to make Syntra
probe its own network.

### The token

A JWT signed with the tenant's active OIDC key
(`packages/core/src/keys/signing-key-service.ts:167`), so it verifies against
the JWKS a relying party already fetches and rotates with everything else.

Claims: `iss`, `aud` (the client id), `iat`, `jti`, `sub`, `sid` when the
client asked for it, and

```json
"events": { "http://schemas.openid.net/event/backchannel-logout": {} }
```

**No `nonce`.** The specification forbids it, and a logout token carrying one
must be rejected by a conforming relying party — so including it would make
every delivery fail against exactly the correct implementations.

### Delivery

Its own table, the existing retry policy.

```prisma
model LogoutDelivery {
  id            String    @id @default(uuid()) @db.Uuid
  tenantId      String    @db.Uuid
  clientId      String    @db.Uuid
  /// The signed token, frozen at enqueue. A retry an hour later sends what
  /// the logout said then, not what the rows say now.
  token         String
  attempts      Int       @default(0)
  nextAttemptAt DateTime
  deliveredAt   DateTime?
  lastStatus    Int?
  lastError     String?
  createdAt     DateTime  @default(now())
}
```

Modelled on `WebhookDelivery` (`schema.prisma:2949`) and deliberately **not**
sharing it. A logout token is not a webhook: an administrator filters webhook
deliveries by event group and configures endpoints per integration, and a
logout token has neither. Sharing the table would put rows in a console screen
whose every control is wrong for them.

What is shared is the policy, imported not copied:
`classifyStatus` and `RETRY_DELAYS_MS` from
`packages/core/src/notify/webhook-retry.ts`. Outbound requests go through
`guardedFetch` (`packages/core/src/net/guarded-fetch.ts`), which refuses
redirects rather than following them — the mechanism by which a URL that passed
the address check becomes one that did not.

A `access.logout_deliver` job on the existing scheduler, registered the way
`registerWebhookJobs` (`webhook-jobs.ts:316`) registers its sender, reading the
due range by `nextAttemptAt`.

A delivery that exhausts its attempts stops being a retry and starts being
evidence: it stays in the table with its last status and error, and is visible
on the application's detail page. **A failed logout is not a silent gap.** This
is the whole reason back-channel is worth building over front-channel — the
browser-driven version cannot tell you it failed.

### The funnel

```ts
export type RevocationTrigger =
  | 'admin'
  | 'self'
  | 'logout'
  | 'password_reset'
  | 'password_change'
  | 'deactivation';

export interface EndSessionsOptions {
  trigger: RevocationTrigger;
  /** A session to spare — a self-service password change spares its own. */
  exceptSessionId?: string;
  /** A single session, for a targeted revoke. */
  onlySessionId?: string;
}

export async function endSessions(
  tx: TenantClient,
  userId: string,
  options: EndSessionsOptions,
): Promise<{ sessionsRevoked: number; logoutsEnqueued: number }>;
```

It revokes the sessions, calls `revokeAllRefreshTokensForUser`, enqueues a
logout delivery for every `OidcClient` with a `backchannelLogoutUri` and a live
grant for that user, and records the audit event.

Everything currently calling `revokeAllForUser` or `revokeAllForUserExcept`
moves onto it: password reset, password change, deactivation, and the two new
revoke routes. The old functions stay as the private mechanism `endSessions`
uses and stop being exported from the package.

**Ordinary sign-out propagates too, and this is a deliberate widening.**
`revokeSession(tx, token)` — the single-session path used by the portal logout
(`apps/api/src/routes/auth.ts:468`), RP-initiated logout
(`oidc-logout.ts:147`) and SAML SLO (`saml-idp.ts:650`) — stays exported,
because ending one session by its token is a different act from ending a
user's. But it gains the same propagation, under the `logout` trigger, for the
grants that session established.

The alternative reading — that only administrative revocation propagates and
signing out does not — would make the feature nearly inert. Revocation is rare;
signing out is constant, and it is the case
`docs/configure.md:493` is describing when it says signing out of Syntra leaves
every other service provider holding its own session. A back-channel logout
that does not fire on logout is not single logout.

**Un-exporting them is the point.** It is the same move
`session-service.ts:75` documents making for `createSession` — "the wrong thing
does not compile." A future caller cannot revoke sessions without propagation
because there is no longer a function that does the first without the second.

All of it inside the caller's transaction. A reset that changed the password
and then failed to revoke is worse than either half on its own, and the same is
true of a revocation that failed to enqueue.

## Testing

The repo's norm: integration against a real PostgreSQL, because the properties
worth testing here only exist in the database.

**Sessions.** That the list returns only live sessions, applying idle and
absolute expiry and not merely `revokedAt`. That another tenant's sessions are
not listed — the RLS assertion, written as a query with no `where` clause.
That the user agent is truncated. That revoking the current session from the
portal clears the cookie in the same reply.

**Revocation and introspection.** That a client presenting its real secret is
authenticated, which is the assertion replacing the pin. That revoking a
refresh token kills the access tokens on its grant. That a client introspecting
another client's token gets `{"active": false}` and not a description of it.
That revoking an unknown token still answers 200.

**Back-channel logout.** A fake relying party over HTTP, in the style of the
SFTP fixture `f5619c2` added — a real server, not a mock, because what is being
tested is that a signed token arrives and verifies. That the token has no
`nonce`. That it verifies against the published JWKS. That a 500 is retried on
the ladder and a 400 is not. That a `backchannelLogoutUri` pointing at a
private address is refused on write.

**The funnel.** One test per existing caller proving propagation happens:
reset, change, deactivation, and sign-out. These are the tests that would have caught the bug
`refresh-token.ts` describes, and they are written against the callers rather
than against `endSessions`, because the defect was never in the function — it
was in who called it.

**e2e.** The console session list, and a revoke taking effect on the next
request.

## Documentation

Three passages become false and get rewritten, not amended:

- `docs/configure.md:479` — the instruction to revoke sessions gains the way to
  do it.
- `docs/configure.md:518` — the revocation and introspection paragraph
  describes a 415 that no longer happens and an `invalid_client` that no longer
  should.
- `docs/configure.md:493` — single logout is no longer local-only for OIDC
  relying parties. **The SAML half is unchanged and the paragraph must keep
  saying so**, including that an offboarding procedure still cannot rely on it
  for SAML service providers.

`docs/operate.md` gains the new personal data: what `ip` and `userAgent` are
for, that they age out with the session row rather than on a separate
retention schedule, and that revoking a session does not delete the row.

## Order

1. **Sessions.** Migration, `SessionOrigin`, core, routes, console. Independent
   of everything else and immediately useful. Its revoke routes call
   `revokeAllForUser` and `revokeSessionById` **directly** at this stage —
   the funnel does not exist yet, and inventing a placeholder for it here
   would be a second thing to migrate in step 3.
2. **Revocation and introspection.** Independent of 1. Touches the token
   plugin and one boundary test.
3. **Back-channel logout, then the funnel.** The delivery mechanism first, so
   it can be tested against the fake relying party in isolation; then
   `endSessions`, and the migration of every caller — step 1's routes included
   — onto it. The un-exporting of `revokeAllForUser` happens here and is what
   proves the migration was complete: anything missed stops compiling.

Step 3 is where the funnel's tests live, because that is where the funnel does.
2 depends on neither and can be built in parallel with either.

## Not in this document

**SAML single logout propagation**, in any binding. Considered and deferred:
the SOAP binding means carrying a SOAP client for one message type against
patchy service-provider support, and the front-channel version depends on a
browser completing a chain of redirects where one dead service provider stalls
the rest. Neither degrades honestly, which is the property that makes the OIDC
half worth having.

**Re-evaluating policy on live sessions.** `configure.md:479` describes the
trade and it stands. This work gives an administrator the tool the existing
sentence tells them to use; it does not change when policy is evaluated.

**Token revocation for Syntra's own `RefreshToken` table.** It is empty, as
`refresh-token.ts` records, and `revokeAllRefreshTokensForUser` already covers
it. Nothing here needs it to be otherwise.
