# Admin password setup — Design

A directory-backed joiner reaches Syntra with an account, a login and no way to
sign in. This closes that, with the smallest primitive that does it: an
administrator can mint a password-setup link for a named user.

## 1. The hole

`authenticate()` in `packages/core/src/auth/login-service.ts` is the single
authentication chokepoint, and it verifies against one thing — an Argon2id hash
in `PasswordCredential`. It does not consult `passwordSource` at all. That
column gates only the *change* and *reset* flows, which refuse a non-`local`
user and point them at an upstream provider.

So a local user with no `PasswordCredential` row cannot sign in, and there are
exactly two routes to such a row today:

- **Self-service change** (`auth/password-change.ts`) requires the current
  password. A joiner does not have one.
- **The reset flow** (`auth/password-reset.ts`) requires a mailbox Syntra can
  reach, and mails a link.

Neither is reachable for a brand-new person. The admin users route
(`apps/api/src/routes/admin/users.ts`) can move a user between `local` and
`upstream` and nothing else — **there is no way for an administrator to give a
user their first password.** That is the gap, and it is not specific to
provisioning; it exists for every user Syntra has ever created.

### 1.1 Why this surfaced now

Provision creates an AD account and seals an initial password into the vault,
delivering it per `AccountProfile.initialPasswordDelivery`. That credential is
the *directory's*. Syntra does not bind to AD to authenticate, so it buys the
joiner nothing at the Syntra login form — and therefore nothing at the SSO that
depends on it.

## 2. What this is not

**Not a `directory` password source.** Making `authenticate()` bind to AD as the
user would give one credential for AD, Syntra and SSO, and the machinery exists
— write-back already binds as the user to change a domain password. It was
rejected here for two reasons. It puts a network call inside the single
authentication chokepoint, so AD's lockout policy begins firing on Syntra
logins; and Syntra is what you sign in with, so a DC that is unreachable locks
everybody out of the console they would use to fix it. That is the same hazard
the update design is built around, arriving by a different road. It remains a
reasonable future direction; it is not this change.

**Not seeding the Syntra credential from the vault.** Copying Provision's
initial password into `PasswordCredential` when `claimSyntraUsers` links the
user would also work, and gives the joiner one password. It was rejected because
the two credentials drift the moment either side changes, and because it makes a
vault secret flow into a second store as a side effect of a link operation.

## 3. Decisions

### D1 — Reuse `PasswordResetToken`, do not invent a setup token

Same table, same hashing, same `completePasswordReset` consumption path. The
schema comment on `PasswordResetToken` already makes this argument about
WebAuthn challenges: one store and one consumption rule beats two that the
verifier has to choose between. The joiner path and the forgot-password path
want identical behaviour at the end — verify the token, demand any enrolled
factors, set the hash, revoke every session and refresh token.

No migration. That is a consequence of the decision, not a motivation for it.

### D2 — The MFA behaviour needs no special case

`acceptableFactorsFor` returns the union of enrolled factor types plus recovery
codes, and its docstring is explicit: *"A user with no second factor at all gets
an empty list, which is what makes `requiresFactor` false for them."* A joiner
has enrolled nothing, so the completion demands only the token and the new
password. A user who *has* enrolled a factor is still required to present it,
which is correct — an admin-minted link must not be a way to bypass somebody's
second factor.

### D3 — Definite outcomes, no timing floor

`requestPasswordReset` is deliberately an oracle-avoider: always void, constant
time, identical response whether or not the account exists, because it is
exposed to anonymous callers. Every one of those properties is wrong here. The
caller holds `directory.write` and can already list every user in the tenant, so
there is no existence fact left to protect. Hiding the outcome from them would
only mean an administrator cannot tell a typo from a federated account.

So: `404` for an unknown user, `409` when `passwordSource` is not `local`, and
no `RESET_REQUEST_FLOOR_MS`.

### D4 — The link is returned to the caller

The response carries the URL and its expiry. Mailing only does not solve the
case this exists for: a joiner may have no mailbox Syntra can reach on day one,
and in the lab `SMTP_URL` points at a sink that accepts everything and delivers
nothing.

The cost is real and is accepted deliberately: the URL is a bearer credential
that grants password-set on someone else's account, and it sits in an API
response an administrator may paste anywhere. Two things bound it — a 24-hour
expiry (D5) and an audit event naming the actor, the subject and the token id,
so a link that is later abused is attributable.

### D5 — A separate 24-hour lifetime

`RESET_TOKEN_LIFETIME_MS` stays 30 minutes. A new `SETUP_TOKEN_LIFETIME_MS` is
24 hours, because the two flows have genuinely different shapes: a reset is
requested by somebody sitting at the form, and a setup link is routed to a
person through a manager, a ticket or a first-day handover. Thirty minutes turns
onboarding into a support call. Twenty-four hours bounds a leaked link to a
single day.

The lifetime is a parameter of the issuing call, not of the token — the token
row already carries `expiresAt`, so consumption needs no change.

### D6 — `PERMISSIONS.DIRECTORY_WRITE`, not a new permission

Every mutation on the admin users route already guards on `DIRECTORY_WRITE`, and
"can give this user a password" belongs with "can change this user".

The constraint is harder than the preference: `Role.permissions` is written at
seed time and there is no `roles.ts` admin route — nothing outside tests writes
that column. A new permission string added in code cannot be assigned to any
role in an existing deployment without direct SQL, so it would ship
unusable. Reuse is not a shortcut here; a new permission would be a defect.

## 4. Data model

Unchanged. `PasswordResetToken` already holds `tokenHash`, `expiresAt`,
`consumedAt` and `userId`, which is everything this needs.

## 5. Service

`packages/core/src/auth/password-reset.ts`:

```
export const SETUP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type IssueSetupOutcome =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'unknown_user' | 'not_local' };

export async function issuePasswordSetup(
  tx: TenantClient,
  input: {
    userId: string;
    actorUserId: string;
    sourceIp: string | null;
    now?: Date;
    lifetimeMs?: number;
  },
): Promise<IssueSetupOutcome>;
```

It takes a `TenantClient` rather than a `tenantId`, unlike
`requestPasswordReset` beside it. That function opens its own transactions
specifically so an SMTP round trip cannot happen inside one; this sends no mail,
does two indexed writes, and is called from `request.db(...)` like every other
mutation on the admin users route.

It mints a token the same way the reset flow does — random bytes, stored as a
digest, raw value returned once and never persisted — writes the row, and
records `auth.password_setup_issued` naming the actor and the subject.

Issuance supersedes: every unconsumed token for that user is stamped
`consumedAt` before the new row is written, exactly as `attemptPasswordReset`
already does. This is not a preference. A **partial unique index allows one live
token per user**, so a design that left the old one valid alongside the new one
would not merely be undesirable — it would violate the index and throw `P2002`.

Two consequences worth stating plainly, because they follow from the shared
table rather than from anything this change invents:

- An admin minting a setup link **consumes an outstanding reset the user
  requested for themselves**, and vice versa. There is one live link per user
  across both flows.
- The last link issued is the only one that works. An administrator who sends
  two and then tells the joiner to use the first has broken their own
  onboarding, so the console copy should say so (section 7).

`P2002` is handled differently here than in the reset path. There, a
simultaneous request is swallowed and the loser sends nothing, because
surfacing it would turn an error page into an account-existence oracle. No such
oracle exists for a caller holding `directory.write`, so the loser of a
concurrent issuance gets a `409` and can try again — silently returning success
without a usable link would be worse than saying what happened.

## 6. API

`POST /api/admin/users/:id/password-setup`, guarded by `DIRECTORY_WRITE`.

```
200 { "url": "https://<public>/reset-password?token=<token>", "expiresAt": "..." }
404 unknown user
409 password-source-not-local   (with passwordSourceHint, so the message can
                                 name where the password actually lives)
```

The URL is composed from the same `publicUrl` the reset mail uses, so both
flows land on one route and there is one page to keep working.

## 7. Console

A **Password link** row action on `apps/web/src/pages/admin/UsersPage.tsx`,
visible with `directory.write`. There is no user detail page — that table's last
cell already carries Edit and the status toggle, and this belongs beside them.

The result opens a dialog showing the returned URL with a copy control and the
expiry in plain words. It must render the link as something to copy, not as a
navigable anchor an administrator can click and thereby consume.

Because issuance supersedes (section 5), the dialog must say that generating
a new link stops the previous one working. An administrator who sends two links
and expects both to be usable is the failure this copy exists to prevent.

## 8. Testing

- A user with no credential: issue, complete, sign in. The whole point.
- A user with an enrolled TOTP factor: completion still demands the factor.
- Unknown user is 404; an `upstream` user is 409 and no token is written.
- An expired token is refused, and a consumed token is refused a second time.
- Issuing twice supersedes: the first link no longer works, the second does.
- Issuing a setup link consumes an outstanding self-service reset token, and a
  self-service reset consumes an outstanding setup link. One live link per user
  across both flows.
- Concurrent issuance: the loser gets 409 rather than a success carrying a link
  that was invalidated before it was returned.
- The audit event names the actor, not the subject, as the actor.
- Permission: a caller without `directory.write` gets 403 and no token exists.

## 9. Out of scope

- Binding to AD to authenticate (section 2). Revisit as its own design.
- Bulk issuance for a joiner cohort.
- Any change to `authenticate()`, the reset completion path, or the MFA
  registry. If this change needs to touch `login-service.ts`, the design is
  wrong.
