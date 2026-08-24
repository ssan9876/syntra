# Directory Write-Back — Design

**Status:** proposed
**Date:** 2026-08-23
**Covers:** self-service password change writing through to Active Directory; deactivating a directory-managed user from the admin console; both of those participating in the Provision leaver ladder.

---

## 1. The problem, and the bigger one underneath it

Syntra reads Active Directory and never writes back to it. Two visible consequences:

- Self-service password change writes an Argon2id hash into Syntra's own `PasswordCredential` and stops there. A directory-sourced user ends up with two passwords: one for the portal, one for Windows. The lab demonstrates this right now — `ssander` signs into Syntra with one string and into the domain with another.
- The admin console refuses to deactivate a user carrying a `sourceId`, offering the text *"managed by a directory source"* instead of a button.

The second refusal is honest about a real constraint rather than arbitrary. `diff.ts:104` proposes `reactivate_user` for **any** matched object whose Syntra status is not `active`:

```ts
if (existing.status !== 'active' && object.objectType !== 'orgUnit') {
  changes.push({ changeType: 'reactivate_user', /* … */ });
}
```

Deactivating a synced user in Syntra would therefore be undone by the next sync run. Blocking the button was the correct interim behaviour for a subsystem that only reads.

### 1.1 The gap that matters more

Directory Sync never reads `userAccountControl`. The `uac.ts` helpers — `isEnabled`, `withDisableBit` — exist only in the AD **target** connector, which is Provision. The **source** connector reads whatever `(objectClass=person)` returns and treats presence in the result set as "this account should be active."

So the inverse of the reported problem is also true, and worse:

> **An account disabled in Active Directory stays `active` in Syntra, indefinitely.**

`login-service.ts:92` refuses a login when `user.status !== 'active'`. That check never fires for these accounts, because nothing ever moves them off `active`. The practical effect: an administrator disables a leaver in AD — the ordinary, correct offboarding reflex, the one every runbook starts with — and that person keeps their Syntra portal session, keeps their Syntra login, and keeps SSO into every application Syntra fronts. In the lab that is Snipe-IT via SAML.

Nothing warns anybody. The AD account shows disabled, the console shows the person as an active user, and both are reporting truthfully on their own state.

This is the same defect as the un-deactivatable user, seen from the other side: **Syntra has no representation of "the source says this account is disabled."** Fixing it is a prerequisite for the feature the user asked for, and is worth doing on its own merits.

---

## 2. What already exists

The seams are better than expected. Almost nothing here is new machinery.

| Piece | Where | State |
|---|---|---|
| `Connector.write()` on the LDAP **source** connector | `packages/connectors/src/ldap/connector.ts:377` | Explicit stub: *"Writing back to LDAP is not implemented in this slice; the method exists for Provision"* |
| `encodeUnicodePwd` — UTF-16LE, quote-wrapped | `packages/connectors/src/ad/connector.ts:155` | Working, used by `create_account` |
| TLS-before-bind connection helper | `ad/connector.ts:99` | Working; no plaintext path at all |
| `classifyLdapError` → closed failure set | `ad/connector.ts:117` | Working |
| `isEnabled` / `withDisableBit` / `withoutDisableBit` | `packages/connectors/src/ad/uac.ts` | Working, target-side only |
| `disable_account` write operation | `packages/connectors/src/types.ts` | Working, Provision-side only |
| Leaver ladder: revoke → disable → archive → reap | `provision/target-service.ts`, `docs/lab/windows/syntra-reap.ps1` | Working, anchored on `departureDate()` |
| `deactivate_syntra_user` action | `provision/syntra-user.ts` | Working — Provision already deactivates the linked Syntra login |
| `User.personId` → Person | `schema.prisma:88` | Present |

So: AD password encoding exists, TLS binding exists, error classification exists, the disable bit helpers exist, and the ladder exists. What is missing is a *write path from the source side* and a *status signal from the source read*.

---

## 3. Design decisions

Three choices materially shape the work. Each is recorded with the alternative rejected, because each could reasonably have gone the other way.

### D1 — Password change binds as the user, not as the service account

**Decision:** to change a password, open a second connection and bind as **the user's own DN with the current password they typed**, then perform the RFC-standard change form on their own object:

```
delete: unicodePwd = "<old>"   (UTF-16LE, quote-wrapped)
add:    unicodePwd = "<new>"
```

both modifications in a **single** modify request.

**Why:** the alternative is to bind as `svc-syntra` and `replace: unicodePwd`, which is the administrative *reset* form. That requires granting the service account the **Reset Password** extended right across the user OU. A bind credential with standing reset rights over every user is a full account-takeover primitive: whoever reads that secret out of the vault owns every identity in the OU. The service account currently cannot do this, and it should stay that way.

Binding as the user grants the service account nothing. It also gets three properties free:

- **The old password is verified by Active Directory**, not by Syntra. A failed bind *is* the wrong-password answer. This matters because the two passwords may already have diverged (the lab is in exactly that state), and verifying against Syntra's local hash would accept a password AD would reject.
- **AD's own policy applies in full** — complexity, length, and password *history*. Syntra's tenant policy is checked first as a fast local rejection; AD's is authoritative.
- **Minimum password age is enforced.** The reset form bypasses it; the change form does not. A self-service portal should not silently hand users a way around a policy the domain sets.

**Cost accepted:** two LDAP connections per change (one service bind to resolve anchor → DN, one user bind to modify). Both TLS. This is not a hot path.

### D2 — The source is the authority for a directory-sourced user's password

**Decision:** when a user has a `sourceId` and that source has write-back enabled, the change goes to AD **first**. Only when AD accepts does Syntra write its local Argon2id hash, revoke sessions, and audit.

**Why:** ordering decides what a partial failure looks like.

- AD first, then local: if AD refuses, nothing has changed anywhere, and the user is told why. If AD accepts but the local write fails, the two diverge — but they diverge with **AD holding the password the user just chose and expects**, and Syntra holding the old one. Recoverable, and the user's domain login (the one that matters at 8am) is correct.
- Local first, then AD: a mid-flight failure leaves Syntra accepting a password the domain rejects. The user believes they changed it, their workstation disagrees, and the support call that follows has no obvious cause.

The failure that cannot be avoided is chosen to be the recoverable one.

**Cost accepted:** the local hash write happens outside the AD call and can fail independently. It is retried once, and a failure is audited as `auth.password_writeback_desync` with enough detail to fix it by hand.

### D3 — Admin deactivation disables immediately *and* enters the ladder

**Decision:** clicking **Deactivate** on a directory-managed user:

1. disables the account in AD **now** (sets the `userAccountControl` disable bit),
2. sets the Syntra user `inactive`, revoking sessions and refresh tokens (existing `deactivateUser`),
3. if the user is linked to a Person, stamps `Person.departureOverride = today`, which puts them onto the existing Provision ladder for the slower consequences — entitlement revocation, archive into `OU=Deactivated`, and the 30-day reap on the DC.

**Why not ladder-only:** the ladder's `disableGraceDays` exists to delay disabling after a *scheduled* departure — the contract that ends on the 31st, where you do not want the account dead at 00:01. A human clicking "Deactivate" is not a scheduled departure. The two most common reasons to click it are "this person left today" and "this account is compromised," and both want the account dead now. A button that appears to do nothing for seven days is a button people work around.

**Why not immediate-only:** that is the flag-flip the codebase already has, and it leaves entitlements granted, the account sitting in its original OU, and nothing ever reaping it. The user asked for this to be part of the automation, and the automation is the ladder.

So: the disable is immediate and the ladder handles everything downstream of the disable. `disableGraceDays` is bypassed for an administrative deactivation and honoured for a contract-derived one — recorded explicitly rather than emergent.

**Reversal:** Reactivate clears `departureOverride`, clears the disable bit in AD, and sets the user active. The ladder anchors on `departureDate()`, which returns to being contract-derived. Nothing in this path deletes; the reap script independently refuses to delete an *enabled* account and holds anything it has not previously stamped, so a reactivation inside the 30-day window is safe by two mechanisms rather than one.

---

## 4. Data model

Three additions. All nullable, all with defaults that preserve current behaviour.

```prisma
model DirectorySource {
  // …
  /// Whether Syntra may write back to this source. Off by default: a source
  /// configured before this existed must not silently acquire write rights.
  /// Turning it on is a deliberate act, and `test` reports whether the bind
  /// can actually exercise what it claims.
  writebackEnabled  Boolean  @default(false)
  /// Which write-backs are permitted, independently. A tenant may want the
  /// disable bit without handing the portal a password path, or the reverse.
  writebackPassword Boolean  @default(false)
  writebackDisable  Boolean  @default(false)
}

model Person {
  // …
  /// An administrative departure, set by a human deactivating this person's
  /// account, as distinct from a departure derived from contract end dates.
  /// `departureDate()` prefers this when set. Cleared by reactivation.
  departureOverride     DateTime?
  departureOverrideBy   String?   @db.Uuid
  departureOverrideNote String?
}

model User {
  // …
  /// Mirrors the source's account-disabled state as last read. Null for a
  /// locally-managed user and for any source that cannot report it.
  /// Distinct from `status`: this is what the SOURCE says, `status` is what
  /// Syntra concluded. Keeping them apart is what makes "disabled upstream,
  /// still active here" a detectable condition rather than an invisible one.
  sourceDisabled Boolean?
}
```

`User.sourceDisabled` earns its place by being the thing that makes §1.1 diagnosable. A single `status` column collapses "we were told" and "we decided," and a drift report cannot be written against a collapsed value.

**`passwordSource` is left alone.** It is `local` for synced users today, and this change does not make them `upstream` — `upstream` means Access II federation, where Syntra holds no hash and cannot verify anything. A write-back user is genuinely different: Syntra holds a hash *and* the source holds the truth. The distinction is carried by `sourceId` + source config, which is where it already lives, rather than by overloading an enum whose existing value means something else.

---

## 5. Connector interface

A **separate, narrow interface** rather than new members of `WriteOperation`.

```ts
/**
 * Writing back to the system a user was read FROM. Deliberately not part of
 * `WriteOperation`: that union is documented as "every action Provision can
 * propose", and carries a safety argument about mass action that these
 * operations do not share. A password change is one person, initiated by that
 * person, and is not something a misconfigured rule can propose four thousand
 * of.
 */
export interface SourceWriteback<C> {
  /**
   * Change a password by binding as the user. `currentPassword` is verified by
   * the directory, never by us. Neither password is ever logged, returned, or
   * included in an error.
   */
  changePassword(config: C, input: {
    anchor: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<WritebackResult>;

  /** Set or clear the account-disabled state. Idempotent. */
  setEnabled(config: C, input: {
    anchor: string;
    enabled: boolean;
    reason: string;
  }): Promise<WritebackResult>;
}

export type WritebackFailure =
  | 'wrong_password'        // the user bind was refused
  | 'policy'                // AD refused the new password: history, complexity, min age
  | 'unauthorized'          // the bind cannot do this
  | 'not_found'             // the anchor resolves to nothing
  | 'unsupported'           // this source has no write-back
  | 'transient';
```

Why not extend `WriteOperation`: that union's doc comment is an argument, not a description — *"Every action here therefore has to be one that four thousand instances of can be walked back."* Adding `set_password` to it would put a non-idempotent, non-reversible operation inside a set whose whole claim is reversibility, and would give it Provision's retry policy, under which a retried password change with a stale old password fails on every attempt while looking transient.

`ldapConnector` implements `SourceWriteback` for Active Directory. Non-AD LDAP returns `unsupported` for `changePassword` — the `unicodePwd` encoding is Microsoft-specific — and uses the standard modify for `setEnabled` only where a `userAccountControl` attribute is present.

**`test()` gains write-back probes.** When `writebackEnabled` is on, `ConnectionResult.rights` reports whether the bind can read `userAccountControl` and whether it can write it, so an under-privileged service account is a visible configuration error at save time rather than a runtime failure on the day somebody leaves.

---

## 6. Sync: reading the disabled state

This is the §1.1 fix and it stands alone.

1. The LDAP source connector adds `userAccountControl` to the requested attributes for users. Absent (non-AD), nothing changes anywhere.
2. `mapping.ts` derives `sourceDisabled` from the UAC bit via the existing `isEnabled`. It is **not** a mappable field — `rejectUnassignable` already refuses to let a mapping write `status`, and rightly, because a source attribute that could deactivate people is a loaded gun. This is derived, not mapped.
3. `diff.ts` changes in two places:

```ts
// Matched, source says disabled, Syntra says active → propose deactivation.
if (object.sourceDisabled === true && existing.status === 'active') {
  changes.push({ changeType: 'deactivate_user', /* … */,
                 reason: 'disabled_in_source' });
  continue;
}

// The existing reactivate branch gains a guard: do not resurrect somebody the
// source still reports as disabled, and do not resurrect an administrative
// deactivation the source cannot see.
if (existing.status !== 'active'
    && object.sourceDisabled !== true
    && object.objectType !== 'orgUnit') {
  changes.push({ changeType: 'reactivate_user', /* … */ });
}
```

The guard is what makes admin deactivation stick. Combined with §7 writing the disable bit, the next sync reads the account as disabled and agrees with Syntra rather than fighting it. The two halves are load-bearing together: the write-back without the guard would still be reverted on the run *between* the write and the next read of `userAccountControl`; the guard without the write-back would leave Syntra and AD permanently disagreeing.

**Safety:** this is a diff proposal like any other, subject to the existing sync guard thresholds. A misread that would deactivate a large fraction of the directory trips the guard and proposes nothing, exactly as an absent-object mass deactivation does today. That existing protection is why this can be added without a new one.

---

## 7. Core services

### 7.1 `changeOwnPassword` — extended, not replaced

The existing outcome union gains two members and one branch:

```
load user + credential + tenant
  ├─ passwordSource === 'upstream'      → { upstream, hint }        (unchanged)
  ├─ sourceId set && source writes pwd  → WRITE-BACK PATH  ← new
  └─ otherwise                          → LOCAL PATH       (unchanged)
```

Write-back path, in order:

1. `validateNewPassword` against tenant policy — a local rejection is free and immediate, and does not spend a round trip or an AD bad-password attempt.
2. `changePassword` on the source connector. AD verifies the old password by bind and applies domain policy.
   - `wrong_password` → `{ ok: false, reason: 'wrong_password' }`, audited as a failed attempt. **This counts against AD's lockout policy, and that is correct** — a portal that let you brute-force a domain password without ever tripping lockout would be a hole, not a feature.
   - `policy` → `{ ok: false, reason: 'directory_policy', detail }` carrying AD's own diagnostic, mapped to a sentence rather than passed through raw.
   - `transient` / `unauthorized` → `{ ok: false, reason: 'directory_unavailable' }`. Explicitly **not** a silent fallback to a local-only change: that is the divergence this feature exists to remove.
3. Only now: hash outside the transaction, then in one transaction write the hash, revoke every other session and all refresh tokens, and audit `auth.password_changed` with `viaDirectory: true`.

New outcome members: `directory_policy`, `directory_unavailable`. The API maps them to 422 and 503 respectively; `PasswordPanel` needs no change, because it already renders `problem.detail` verbatim and was written to.

### 7.2 `deactivateDirectoryUser` — new

```ts
async function deactivateDirectoryUser(tenantId, {
  userId, reason, actorUserId, sourceIp,
}): Promise<DeactivateOutcome>
```

Order, and the reasoning behind it:

1. Resolve the user, its source, and the source's write-back config. No `sourceId` → delegate to the existing local `deactivateUser` and stop.
2. `writebackDisable` off → refuse with `writeback_not_enabled`, naming the source and what to turn on. **Not** a local-only deactivation, which is the state that produces the reactivate-fight this whole design removes.
3. `setEnabled(anchor, false, reason)` against the directory. **Outside** the transaction — an LDAP round trip inside a Prisma interactive transaction spends the 5,000 ms budget on the network.
4. On failure, stop and report. Nothing local has changed. The account is exactly as it was.
5. On success, in one transaction: `deactivateUser` (status, sessions, refresh tokens), set `User.sourceDisabled = true`, and if `personId` is set, stamp `departureOverride`. Audit `user.deactivate` with `viaDirectory: true` and the anchor.
6. Enqueue a Provision run for the affected person, so the ladder starts without waiting for the next schedule.

Directory first, then local — same argument as D2. A failure leaves both systems agreeing that nothing happened.

`reactivateDirectoryUser` is the mirror: clear the disable bit, clear `departureOverride`, set active, enqueue.

### 7.3 `departureDate` — override-aware

```ts
export function departureDate(
  contracts: ContractFacts[],
  on: Date,
  override?: Date | null,
): Date | null {
  if (override) return override;          // administrative departure wins
  // … existing contract-derived logic, unchanged
}
```

Override wins over contracts unconditionally. A human who deactivated somebody has information the contract table does not — the resignation that has not been keyed yet, the compromised account, the person walked out this morning. Letting an open-ended contract (`endDate === null`, which returns `null` — "not leaving") override that would make the button a no-op for exactly the population it is most needed for: permanent employees.

The ladder consumes this unchanged. `entitlementRevocationDelayDays` and `archiveAfterDays` anchor on the returned date as they always have. Only `disableGraceDays` is bypassed, and only when the departure came from an override — §7.2 has already disabled the account, so honouring a grace period would mean *re-enabling* it, which no one intends.

---

## 8. API and UI

**API**

| Route | Change |
|---|---|
| `POST /api/auth/password` | New outcomes → 422 `directory-password-policy`, 503 `directory-unavailable` |
| `POST /api/admin/users/:id/deactivate` | Routes directory-managed users through `deactivateDirectoryUser`; 409 `writeback-not-enabled`, 502 `directory-write-failed` |
| `POST /api/admin/users/:id/reactivate` | Mirror |
| `POST/PATCH /api/admin/sources/:id` | Accepts the three write-back flags; `test` reports the rights |

**UI**

- `UsersPage.tsx:263-279` — the *"managed by a directory source"* text becomes a real **Deactivate** button when the source has `writebackDisable`. When it does not, the text stays but says something actionable: which source owns the account, and that write-back is off. The current text tells the user a fact and leaves them nowhere to go.
- The confirm dialog states plainly what will happen: the AD account is disabled now, entitlements are revoked after *n* days, the account is archived to `OU=Deactivated` after *m*, and permanently deleted after 30. Those numbers come from the target's ladder rather than being restated in the browser. A dialog that says "are you sure?" without saying what happens is a dialog people click through.
- A user whose `sourceDisabled` is true but whose `status` is still `active` — the §1.1 population, until the next sync — is badged **Disabled upstream** in the list. It is the one state that is invisible today and the one worth surfacing loudest.
- Source settings grow a write-back section: off by default, with the two sub-toggles and the result of the rights probe.

---

## 9. Safety

| Risk | Control |
|---|---|
| Bind credential gains password-reset power over the OU | D1: bind as the user; the service account gains nothing. No Reset Password right is requested or used. |
| Passwords reaching a log, a response, or an error | No password is a parameter to anything that formats. `classifyLdapError` reads `name` and `message`, never the request. Existing tests assert audit payloads contain neither password; extended to the write-back path. |
| Mass deactivation from a misread `userAccountControl` | Existing sync guard thresholds; a UAC misread reaches the diff as ordinary proposed changes and trips the same limit. |
| Write-back turned on silently by an upgrade | All three flags default `false`. Existing sources are unaffected until a human opts in. |
| AD accepted, Syntra did not | Audited as `auth.password_writeback_desync`; AD holds the password the user chose, which is the recoverable direction. |
| Deactivation racing a sync run | Sync proposes; it does not apply without an apply step. A proposed `reactivate_user` written before the disable bit landed is re-diffed against fresh state on apply. |
| A deactivation that should not have happened | Nothing deletes. Reactivate is one click, the reap holds enabled accounts, and the 30-day window is stamped rather than computed from a timestamp that a restore would reset. |

---

## 10. Testing

**Unit / integration (vitest, real Postgres):**
- `departureDate` — override wins over open-ended contracts, over later end dates, and clears correctly.
- `diff` — disabled-in-source proposes deactivation; the reactivate guard holds against a source-disabled account; an enabled account still reactivates. Each asserted from the diff output, not from a mock call count.
- `changeOwnPassword` write-back path — every outcome, plus AD-first ordering proved by asserting the local hash is unchanged after a directory refusal.
- `deactivateDirectoryUser` — refusal when write-back is off, no local change on directory failure, ladder stamped on success.
- Audit payloads contain neither password on every new path.

**Connector (against the Samba container the AD target tests already use):**
- `changePassword` succeeds; wrong old password returns `wrong_password`; a policy-violating new password returns `policy`; neither password appears in any thrown message.
- `setEnabled` is idempotent both ways; the UAC bit is set without clobbering the other flags — `withDisableBit`, never `= 514`.

**Mutation checks**, per this repo's habit — each new test is proven to fail against the unfixed code:
- Remove the `sourceDisabled` guard from the reactivate branch → the deactivation-sticks test must fail.
- Reverse D2's ordering (local before directory) → the ordering test must fail.
- Return `unsupported` from `setEnabled` → the refusal test must fail rather than silently pass.

**Lab verification** — the end that actually counts:
1. Change `ssander`'s password in the portal; confirm the **same** string then authenticates against AD over LDAPS, closing the divergence the lab is sitting in today.
2. Wrong current password → refused, and AD's `badPwdCount` incremented (lockout is being honoured, not bypassed).
3. Disable a test user directly in AD; run a sync; confirm Syntra moves them to `inactive` and that their portal login and Snipe-IT SSO both stop working. This is §1.1, demonstrated end to end.
4. Deactivate a directory-managed user from the console; confirm the AD account is disabled within seconds, the next sync leaves them deactivated rather than resurrecting them, and the ladder stamps the archive OU and the reap date.

---

## 11. Out of scope

- **Password write-back to anything but AD.** Non-AD LDAP returns `unsupported`. The `unicodePwd` encoding is Microsoft's.
- **Reading a password change made in AD.** Passwords do not sync inbound; there is nothing to read. A domain password changed at a workstation leaves Syntra's local hash stale until the user changes it through the portal. Closing that means Syntra stops holding a hash at all and binds to AD at login — a genuine improvement and a different, larger change.
- **Group and OU write-back.** Users only.
- **Deleting anything.** Unchanged and not negotiable: the reap on the DC remains the only thing that deletes, on its own schedule, with its own refusals.

---

## 12. Order of work

1. Sync reads `userAccountControl` → `User.sourceDisabled`; diff guard. *(Fixes §1.1 on its own; ships independently of everything below.)*
2. `SourceWriteback` interface + AD implementation + connector tests.
3. Source write-back config, rights probe, settings UI.
4. `deactivateDirectoryUser` / `reactivateDirectoryUser`; API; Users page button.
5. `departureOverride` and the ladder wiring.
6. Password write-back in `changeOwnPassword`; API outcomes.
7. Lab verification, end to end.

Step 1 is deliberately first and self-contained. It is the security gap, it is a prerequisite for step 4 sticking, and it is worth having even if the rest slips.
