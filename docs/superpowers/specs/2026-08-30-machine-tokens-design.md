# Machine tokens

Status: designed, 2026-08-30
Based on `dcb5bd2`

A credential a program can hold: issued against a service account, bounded by
that account's roles, presented as a bearer token, and revocable without
touching anybody's password.

Sub-project **C1** of four-and-a-half. A (ending access), B (watching Syntra)
and D (backup and restore) are built. **C2 — an inbound SCIM 2.0 server — is a
separate document and depends on this one**: a SCIM client authenticates with
exactly this credential, and building SCIM first would mean inventing a
throwaway authentication scheme to be replaced immediately.

## Why

Syntra has no way for a program to authenticate.

There is a session, which needs a browser, a password and often a second
factor. There is the OAuth client-credentials grant, which issues a token to an
*OIDC client* for use against *relying parties* — it is a protocol feature for
applications Syntra federates to, not a way to call Syntra's own admin API.
Nothing else exists. A script that wants to create a user, run a sync or read
the audit log has no credential to present, and neither does the SCIM server
C2 adds.

The practical consequence today is that automation either does not happen or
happens with a human's password in a cron job — which is the credential that
also opens the console, cannot be scoped, cannot be rotated without locking a
person out, and appears in the audit log as that person.

## Ruling: a token is a decision, not an exemption

**Every token presentation goes through `authorize()`**, as a new request kind.

The alternative — a second documented exemption alongside the
client-credentials grant — was considered and rejected on the history of the
first one. That exemption was granted conditionally, on the stated ground that
"the control there is the client secret", and was later reopened when a review
found a client registered `token_endpoint_auth_method: none` could reach it
with **no credential at all**. One exemption with a hole in it is an argument
against a second exemption, not a precedent for one.

Routing through the chokepoint buys three things that would otherwise each need
building again:

- **A deactivated account's tokens stop at the next request**, because
  `authorize()` already re-reads account status rather than trusting anything
  issued earlier.
- **Policy applies to machines.** An IP rule confining a token to the host that
  should be presenting it is the one control that limits the damage of a
  stolen token, and it already exists — it just has never been reachable by a
  machine.
- **One audit path.** `auth.policy_denied` and the allow are written where
  every other decision is written.

**What cannot apply, and is said rather than skipped.** A bearer token cannot
answer an MFA challenge. A policy rule that requires a second factor, met by a
token, is a **deny** — not a silent pass, and not an allow with the requirement
quietly dropped. An operator whose `require_mfa` rule matches their integration
should see that integration refused and understand why, because the alternative
is a rule they believe is enforced and is not.

## Ruling: a token can never exceed its account

Authority is the **intersection** of the service account's roles and the
token's own scopes.

- Revoking the account's role revokes every token it issued, at once, with no
  token-by-token cleanup — which is what makes offboarding an integration a
  single act.
- A token minted for one job cannot quietly do everything the account can, so
  one over-broad account does not become many over-broad credentials.

Scopes are drawn from the existing `PERMISSIONS` values. There is no second
authorization vocabulary, because two vocabularies drift and the drift is
always in the permissive direction.

An empty scope list means **the account's full authority**, matching how an
empty webhook subscription means every event — but the console always writes an
explicit list, so the permissive default is reachable only by an integrator who
typed it.

## The credential

```
syntra_pat_<43 chars of base64url>
```

A prefix, so a leaked token is recognisable in a log, a paste or a secret
scanner, and so a support conversation can name what somebody is holding
without seeing it. 256 bits from `randomBytes` after the prefix.

**Stored as SHA-256, not Argon2id**, for the reason `hashClientSecret` already
documents about client secrets: this is a uniformly random 256-bit value, not a
human-chosen password, so there is no dictionary to grind and a memory-hard KDF
buys nothing while costing a real latency floor on *every* API request. The
comparison is constant-time.

Shown **once**, at issue, and never again — the same rule as a client secret.

### The row

```prisma
model ApiToken {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String    @db.Uuid
  userId      String    @db.Uuid       // the service account
  name        String                   // "SCIM from Workday"
  tokenHash   String    @unique
  /// The permissions this token may exercise, intersected with the account's
  /// roles. Empty means the account's full authority.
  scopes      String[]  @default([])
  expiresAt   DateTime?                // null is allowed, and discouraged
  lastUsedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
  createdBy   String?   @db.Uuid
}
```

`lastUsedAt` is what makes an unused token findable. A credential nobody can
tell is unused is a credential nobody ever revokes.

It is written **at most once a minute per token**, not on every request: a busy
integration would otherwise turn every read into a write, and knowing a token
was used "within the last minute" is exactly as useful as knowing the second.

### Expiry

`expiresAt` is optional and the console defaults it to ninety days. A
non-expiring token is a real requirement — an integration nobody is staffed to
rotate is worse broken than long-lived — but it should be a thing somebody
chose, so `list` marks it and Govern can find it.

## Presenting one

```
Authorization: Bearer syntra_pat_…
```

`requireSession` gains a second way to establish `request.session`. That is the
whole integration: `requirePermission` already reads `request.session.userId`,
so every existing admin route accepts a token with no change, and none of them
can accidentally be left out.

**This is also the risk, and it is deliberate.** Every admin route becomes
reachable by a token that holds the right permission — which is the point of an
API credential, and is why the scope intersection above is not optional.

Three routes refuse a token whatever it holds, and refuse it explicitly:

- **`/api/auth/*`** — signing in, elevating, changing a password. A token is
  already authenticated; there is nothing for it to do here, and a token that
  could elevate would be a token that could mint a session.
- **`/api/admin/users/:id/password`** and the password-setup routes. Handing a
  program the ability to set a human's credential is a different authority from
  managing the directory, and it is not one a token gets in this slice.
- **The portal.** A machine has no applications to launch.

A token presented at any of them is a `403` naming the reason, never a `401`
that reads as "your credential is wrong".

`request.session.scope` is `'admin'` for a token, because the routes it reaches
are the administrative ones. It carries a marker so the audit log can tell a
token from a person — the two are not the same actor even when they are the
same `userId`.

## Managing them

Under an account, beside its sessions:

| Route | Does |
|---|---|
| `GET /api/admin/users/:id/tokens` | The account's tokens, never the hashes |
| `POST /api/admin/users/:id/tokens` | Issue one. **Returns the token once.** |
| `DELETE /api/admin/users/:id/tokens/:tokenId` | Revoke one |

Guarded by a new `PERMISSIONS.TOKEN_MANAGE`, not by `directory.write`. Issuing
a credential that can act as an account is a different authority from editing
that account's display name, and the existing separation between
`directory.write` and `directory.delete` is the precedent: "somebody trusted to
fix a misspelt display name has not thereby been trusted to delete the
account."

**Step-up MFA is required to issue one**, and not to list or revoke. Issuing
mints a lasting credential from a session that will expire; revoking takes
access away and grants nothing, which is the same reasoning that put no step-up
on session revocation.

The console shows the token once, in the idiom the client secret already uses,
and says plainly that it will not be shown again.

## Audit

| Action | When |
|---|---|
| `api_token.issued` | With the name, scopes and expiry. Never the token |
| `api_token.revoked` | |
| `api_token.expired` | First refusal after expiry, once |
| `auth.token_denied` | Presented and refused: revoked, expired, deactivated account, policy |

All four join the `credentials` webhook group from cluster B, so an integration
watching security events learns that a machine credential was minted without
anybody having to wire it up.

## Testing

- **The intersection holds.** A token scoped `directory.read` whose account
  holds `directory.write` cannot write. A token scoped `directory.write` whose
  account holds only `directory.read` cannot write **either** — the case that
  proves it is an intersection and not a union, and the one a union would pass.
- Revoking the account's role kills the token with no token-level change.
- A deactivated account's token stops at the next request.
- A revoked token, an expired token and an unknown token are each refused, and
  refused identically — a caller learns that the credential did not work, not
  which of the three it was.
- **A policy rule requiring MFA denies a token**, and the audit says so.
- An IP rule confines a token to an address.
- `/api/auth/*` and the password routes refuse a valid token holding every
  permission, with 403.
- The token appears nowhere in any response body, including the issue response
  after the first, and nowhere in an audit payload.
- `lastUsedAt` moves on first use and does not write again within the minute.
- RLS: a token cannot be resolved from another tenant.

## Documentation

`configure.md` gains a machine-access section: what a token is, the prefix, the
intersection, what it cannot reach, and that policy applies — including that a
`require_mfa` rule will refuse it, because that is the surprise worth
documenting before somebody meets it.

`operate.md` gains finding unused tokens through `lastUsedAt`, and the note that
a non-expiring token is a choice somebody made.

## Not in this document

**Inbound SCIM.** C2, and the reason this exists.

**OAuth for Syntra's own API.** A bearer token is not an OAuth grant, and
adding an authorization server for Syntra's admin API would be a much larger
thing than the automation problem it would solve.

**Per-token IP allowlists.** Policy rules already express this, and a second
place to say the same thing is a second place for the two to disagree.

**Tokens for portal users.** A person's automation is a service account with
that person's manager, not a credential attached to somebody who might leave.
