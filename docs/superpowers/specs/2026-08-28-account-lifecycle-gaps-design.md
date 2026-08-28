# Account lifecycle gaps — Design

Five things an administrator cannot do from the console, or can do twice by
accident. They are one design document rather than five because they share a
subject — the account, the person behind it, and the seam between them — and
because four of the five touch the same two screens.

## 1. The holes

**Duplicates are possible in four ways.** `createUser` in
`packages/core/src/directory/user-service.ts` checks `login` and nothing else,
with a case-sensitive `findFirst`. `@@unique([tenantId, login])` is
case-sensitive in Postgres too, so `MOkafor` and `mokafor` are two accounts and
both can sign in. Email is not checked at all. Neither is "does this person
already have an account", nor "does this person already exist".

**A contract cannot be corrected.** `jobTitle` and `department` live on
`Contract` — not on `User`, not on `Person`. `POST /persons/:id/contracts`
creates one and there is no `PATCH`, so a mistyped department is fixed by
adding a second contract with a new sequence, which is a different fact about
the person than the one anybody meant to record. The console shows the fields
read-only on `PersonDetailPage` with no way in.

**Accounts orphan themselves.** `OnboardPersonPage` does the right thing: it
creates the person, the contract and the login, then calls `link-user`
immediately, with a comment saying an unlinked account is the orphan the page
exists to stop producing. The bare "New user" form in `AccountsTab` does none
of that — it posts to `POST /users`, which has no `personId` at all. Every
account created from the Accounts tab is an orphan, and there is no screen that
lists them or offers to fix them. `linkUserToPerson` exists and is reachable
only from the person's side, one at a time.

**The org unit on the create form is half a decision.** `User.orgUnitId` feeds
access resolution. `Person.orgUnitId` is what drives placement through the
ladder — the schema comment on `Person.orgUnitId` says so explicitly, and says
why it is not hung off `User`. The Accounts create form sets only the first, so
an account created there has an org unit for access and lands in the fallback
container on every target. The form also shows no container hint, so the
mistyped department that `OnboardPersonPage` catches while correcting it is
still free goes uncaught here.

**There is no way to set somebody's password.** `POST /users/:id/password-setup`
mints a one-time link, which is the right primitive for a joiner and the wrong
one for the support call where an administrator is reading a password down the
phone. `setPasswordHash` exists in `packages/core/src/auth/password.ts`; nothing
admin-facing calls it. There is also no "must change at next sign-in" concept
anywhere in the schema.

## 2. What this is not

**Not a change to Directory Sync's correlation.** `packages/core/src/sync/correlate.ts`
resolves a directory object to a `User`. The person matcher introduced here
resolves a `User` to a `Person`. They are different questions and the sync apply
path is deliberately not wired to the new matcher: folding it in would change
what a sync run does, and who owns the person link during a run is its own
decision.

**Not a hard block on a second account.** A contractor with two simultaneous
contracts is the case the person/contract/user split was built for. Refusing a
second account would break the model this product is built on. The second
account is a warning that names the first one and can be confirmed past.

**Not a merge tool.** The duplicate-person guard warns and links to the
candidate. Merging two people who both accumulated contracts, accounts and
audit history is a much larger piece of work and is out of scope.

**Not a password field on the create form.** The comment in `AccountsTab`
explaining its absence stands. A new account still gets its first password by
link, by directory, or by upstream provider. The manual set-password control
lives on an existing account's own screen, where the administrator is looking at
the account they mean.

## 3. Duplicate guards

Two are refusals enforced by the database. Two are warnings the caller can
confirm past. The split is deliberate: a login or an email collision is always a
mistake, and a duplicated person or a second account sometimes is not.

### 3.1 Login — refuse, case-insensitively

Migration adds a functional unique index:

```sql
CREATE UNIQUE INDEX "User_tenantId_lower_login_key"
  ON "User" ("tenantId", lower("login"));
```

`createUser` keeps its explicit pre-check — the existing comment gives the
reason, that the caller gets a domain error to map to 409 rather than a driver
error — and gains `mode: 'insensitive'`. The index is the backstop for the race
the pre-check cannot close.

The migration fails on a tenant that already holds a case-collision. That is
correct: two accounts differing only in case need a human to decide which is
real. The migration ships with the query that finds them:

```sql
SELECT "tenantId", lower("login"), count(*), array_agg("id")
  FROM "User" GROUP BY 1, 2 HAVING count(*) > 1;
```

### 3.2 Email — refuse, locally managed accounts only

```sql
CREATE UNIQUE INDEX "User_tenantId_lower_email_local_key"
  ON "User" ("tenantId", lower("email")) WHERE "sourceId" IS NULL;
```

Partial, and that is the whole of the design. A directory is authoritative over
the accounts it owns; Syntra refusing what LDAP says would fail a sync run
mid-apply over a shared mailbox somebody set up years ago. The index therefore
covers only what Syntra itself created, which is exactly what an administrator
typing into the create form can collide with.

Checked in `createUser` and in `PATCH /users/:id/details`, both
case-insensitively, both returning 409.

### 3.3 Second account for one person — warn

`POST /users` carrying a `personId` whose person already has an **active**
account returns 409 `type: 'second-account'`, with the existing account's login
and id in the problem document. The form renders that as a confirmable warning
naming the existing account, and re-posts with `allowSecondAccount: true`.

An inactive existing account does not warn. Replacing a leaver's account is not
a duplicate.

### 3.4 Duplicate person — warn

`POST /persons` matches against active people on either:

- `businessEmail` equal, case-insensitively; or
- `givenName` and `familyName` both equal, case-insensitively, after trimming.

Any match returns 409 `type: 'possible-duplicate'` with the candidates. The
form lists them, offers a link through to each, and offers "create anyway",
which re-posts with `allowDuplicate: true`.

`externalId` already has its own conflict path in `PATCH /persons/:id` and is
left alone.

## 4. Editing a contract

`patchContractRequest` follows the idiom `patchPersonRequest` and
`patchUserDetailsRequest` already set: every field optional, `.strict()`, and a
`.refine` requiring at least one. `startDate` is not nullable — a contract with
no start is not a correction anybody meant to make. `endDate`, `jobTitle`,
`department`, `costCentre`, `employer`, `location`, `managerPersonId` and `fte`
are nullable so they can be cleared.

`PATCH /persons/:id/contracts/:sequence`, guarded by `identity.write`, calling a
new `updateContract` in `person-service.ts`. Promoting a contract to primary
demotes the incumbent inside the same transaction, reusing the logic already at
`apps/api/src/routes/admin/persons.ts:218`. Audit `person.updateContract`
carrying `from` and `to` for the fields that changed.

**These fields are edited on the person's page, not the account's.** They
describe what somebody does, which is a property of their contract, and an
account is not the thing that holds it. `AccountDetailPage` already names and
links the person at the top of the screen — that link is the route in, and it is
one click. If the account screen later needs to show the primary contract's
department and title, it shows them read-only with that same link; it does not
grow a second editor over the same column.

On `PersonDetailPage`, each contract row gains an Edit button opening the field
set the add form already renders, initialised from the row.

## 5. Linking accounts to people

### 5.1 The matcher

New `packages/core/src/identity/person-match.ts`, one exported function:

```ts
matchPersonForAccount(tx, { email, displayName }): Promise<{
  confident: PersonCandidate | null;
  candidates: PersonCandidate[];   // each carries the rule that matched
}>
```

Rules, over active people only:

| Rule | Strength |
|---|---|
| `email` equals `businessEmail`, case-insensitively | confident |
| `email` equals `personalEmail`, case-insensitively | candidate |
| `displayName` equals `givenName familyName`, normalised for case and whitespace | candidate |

Two or more matches on the confident rule demote it to candidates: an ambiguous
match is not a confident one, and picking the first would link an account to
whichever row the planner happened to return.

A personal email on a work account is a guess about somebody's private address,
and two people share a name often enough that a name match must be confirmed.
Neither ever auto-links.

No match links nothing and says nothing. Silence is the default.

### 5.2 The create form

`createUserRequest` gains `personId: z.string().uuid().nullable().optional()`
and `allowSecondAccount: z.boolean().optional()`. The three states are
distinguished and mean different things:

- a `personId` — link to that person, inside the transaction that creates the
  account;
- `null` — a service account, explicitly. Do not match, do not link;
- omitted — run the matcher, and link if it is confident.

The form offers a person combobox searching existing people, with "No person —
service account" as an explicit choice rather than a blank default. Creating an
orphan becomes something somebody chose.

A confident match to a person who **already has an active account** does not
auto-link. It is demoted to a candidate and surfaces as a suggestion on the new
account's screen instead, because auto-linking it would silently create the
second account §3.3 exists to warn about. An explicit `personId` in that
situation still warns and is still confirmable — the difference is that
somebody asked for it.

A confident auto-link writes audit `user.autolinked` naming the rule that fired.
It is never silent in the record; an administrator who wonders why an account
has a person can read why.

`POST /users` is guarded by `directory.write` and linking by `identity.write`.
A caller holding only the first gets 403 for an explicit `personId`, and has the
matcher skipped entirely — an auto-link is a write to a person, and a permission
boundary is not something a convenience feature gets to step over.

### 5.3 Suggestions on an unlinked account

`GET /users/:id/person-candidates` returns the matcher's output for an account
with no person. `AccountDetailPage` renders the candidates where it currently
renders the flat "Not linked", each with its reason and a Link button posting to
the existing `POST /persons/:id/link-user`.

An account with no candidates keeps today's behaviour exactly: "Not linked",
stated flatly, with no call to action. A service account is the ordinary case
there and the existing comment says so.

### 5.4 Backfill

`GET /users/unlinked` returns every account with `personId` null, each with its
top candidate and that candidate's strength. A page at `/admin/users/unlinked`
lists them with a per-row Link and a "link all confident" action that posts the
confident ones in one request.

It is reached from a `quietWhenZero` stat card on `UsersPage`, the same idiom
"Awaiting an account" and "Locked out" already use, and not from a fourth tab.
The backlog is a transient state; a tab for it would be a permanently visible,
usually empty destination, and the stat card disappears when the work is done.

## 6. Org unit at creation

The picked unit is applied to the account, and to the person **only when the
person's own unit is null**. If the person already has one, the form states
which and leaves it.

That asymmetry is the point. `Person.orgUnitId` is what the placement ladder
reads, and a person who already has one either had it set deliberately or has an
`AccountPlacement` row protecting a manual move. Overwriting it from a form
whose subject is the account would undo a decision made about the person, and
the person's own screen is where that decision is changed.

The form also renders `useContainerHints` against the enabled targets, showing
the actual container per target before saving — the same treatment
`OnboardPersonPage` gives it, for the reason stated there: this deployment
applies provisioning without a confirmation step, so this is the last point at
which a mistyped department is free to correct.

`PATCH /users/:id/details` already accepts and validates `orgUnitId`. The
account's Edit form does not send it. It gains the field.

## 7. Setting a password

### 7.1 Must-change

`PasswordCredential` gains `mustChange Boolean @default(false)`.

`passwordExpired` in `password-ageing.ts` becomes `mustRenewPassword`, which
returns true when the flag is set **or** when the age check fires. The flag is
honoured even when `passwordMaxAgeDays` is zero — a policy that has switched
scheduled expiry off, which the docstring there recommends, must not switch off
a change an administrator just demanded — and it is still never honoured for a
non-`local` `passwordSource`, for the reason already given there: a user whose
password lives upstream would be stranded in front of a form that changes
nothing at their provider.

The single call site is `authorize.ts:493`, the last gate before a session
exists and the one every path shares. Forcing a change therefore reuses the
renewal attempt machinery whole, rather than adding a second gate that some
paths would miss.

`setPasswordHash` gains a `mustChange` option defaulting to `false`. Every
existing caller — self-service change, renewal, reset completion — clears the
flag by construction, because clearing it is what "the user chose this password
themselves" means, and no caller has to remember to.

### 7.2 The service

`setPasswordAsAdmin(tx, userId, plain, policy, now)`, in `password-change.ts`
beside `changeOwnPassword`:

1. refuse a non-`local` `passwordSource` — Syntra does not hold that password;
2. validate against the tenant's policy via `password-policy.ts`;
3. refuse a password in `PasswordHistory` within the configured depth;
4. write the hash with `mustChange: true`, and push the previous hash to
   history, trimming to depth;
5. revoke every session and every refresh token.

All five in one transaction. The revocation is the same shape `deactivateUser`
and `completePasswordReset` both use, and for the reason `deactivateUser`'s
docstring gives: a credential change whose sessions survive reads as done and is
not. An administrator setting a password because an account is compromised is
the exact case where the attacker's live session must not outlive the change.

Audit `user.setPassword`. The payload names the actor and the target and never
the password.

### 7.3 The endpoint

`POST /api/admin/users/:id/password` taking `{ password }`, guarded by
`directory.write` — the same guard as `POST /users/:id/password-setup`, and no
step-up MFA, matching that control. The two are the same authority over the same
account and should not disagree about what it takes to exercise it. If step-up
is later wanted here it belongs on both, as one change to how credential
operations are guarded, not as an inconsistency introduced by this one.

### 7.4 The control

A "Set password" button beside "Password link" in the Sign-in panel on
`AccountDetailPage`, offered under the same `passwordSource !== 'upstream'`
condition, opening an inline form that states the tenant's policy before the
administrator types rather than after the server refuses.

On success it says what happened, in order and in full: the password is set,
every session was revoked, and they must choose their own the next time they
sign in. The panel's existing setup-link block is the precedent — it says the
previous link stopped working because nothing else would tell anybody.

## 8. Migrations

Two.

1. The two unique indexes in §3.1 and §3.2. Blocked by pre-existing collisions
   by design; the detection queries ship with it.
2. `PasswordCredential.mustChange`, defaulting false, which is a rewriteless
   add on Postgres 11 and later.

## 9. Testing

Per module, in the existing vitest layout, and the suites are run one at a time
— concurrent runs against the shared database produce phantom failures.

- **Duplicate guards**: `user-service.test.ts` for the case-insensitive login
  and the local-only email rule, including that a source-owned account is
  exempt from the email index; `users.test.ts` and `persons.test.ts` for the two
  confirmable 409s and for the confirmation flag letting the second attempt
  through.
- **Contract editing**: `persons.test.ts` for the patch, the primary
  demotion, the nullable clears, and the empty-body refusal.
- **Matcher**: `person-match.test.ts` covering each rule, the ambiguity
  demotion, the no-match silence, and that inactive people never match.
  `users.test.ts` for the three `personId` states on create.
- **Org unit**: that the person's unit is set when null and left when not.
- **Password**: `password-change.test.ts` for the policy refusal, the history
  refusal, the upstream refusal, and that sessions and refresh tokens are gone
  after a success; `authorize` for a `mustChange` credential being sent to
  renewal with `passwordMaxAgeDays` at zero, and for the flag being cleared by
  the renewal that follows.
- **Tenant isolation** holds throughout: every new query goes through
  `TenantClient`, and the matcher in particular must not see another tenant's
  people. One test asks for exactly that.

## 10. Order of work

1. Duplicate guards, and the contract patch. Self-contained, no risk beyond the
   two indexes.
2. Set-password. One migration, and it touches the sign-in path.
3. Org unit on the create form.
4. Autolink. The largest, and it reads the person data the earlier work tidies.
