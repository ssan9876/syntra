# Directory Sync — spec debt

What the approved spec promises that the branch does not yet deliver. Recorded
deliberately rather than absorbed silently, so the gap is a decision rather than a
surprise. Each item names the spec section that binds it.

## ~~A conflicting user makes a clean run report as half-broken~~ — fixed

`computeDiff` now builds a `usableMembers` set from user correlations that are
`matched` or `new`, alongside the `usableGroups` set that already existed, and an
anchor outside it is **kept if Syntra already holds the membership and skipped if
not** — the same rule the unmappable-member case uses.

Keeping it is the load-bearing half. A plain `continue` drops the anchor from the
desired membership, and desired is differenced against what Syntra holds, so the
omission reads as `remove_member` and revokes real access over a name collision. The
"keeps a membership Syntra already holds when the member turns into a conflict" test
fails against exactly that mistake; the "never applies a conflict" test now asserts
on the run's status as well as on the local account.

## ~~The administration surface is roughly a third built~~ (spec section 11) — fixed

Section 11 describes five things. All five now exist.

| Promised | State |
|---|---|
| A sources list | Built. Names link into the editor; **New source** is on the header and in the empty state. |
| A source editor with a **Test connection** action | Built. `SourceDetailPage.tsx`, create and edit, every field section 5 names. `POST /sources/test` tests a configuration that was never saved, and calls `discoverSchema` as well as `test`. |
| Attribute mapping editor seeded with AD and OpenLDAP defaults | Built. `DEFAULT_MAPPINGS` is served by `GET /sources/mapping-defaults` rather than duplicated in the bundle, alongside `ASSIGNABLE_FIELDS`, so the console cannot offer a target field the server would refuse. |
| Run history, and a run detail screen with Apply and per-change skip | Built. Skip per change, and a tickbox per proposed change feeding `applyRun`'s `only`. |
| A blocked run leads with why, and the numbers | Built, and unchanged — the threshold confirmation is still a deliberate tick before Apply does anything. |

Both previously unreachable success criteria are now reachable from the console:

- Criterion 1, "report what object classes and attributes it found" — the test report
  lists both. `discoverSchema` now asks for `*` and `+`: `entryUUID` is operational on
  OpenLDAP, so the report used to list every attribute except the anchor, which is the
  field it exists to help fill in.
- Criterion 4, "apply part of it" — unticking a change leaves it out of this apply and
  still proposed; the run comes back `partially_applied` and the rest can be applied
  afterwards. The end-to-end test applies a run in two passes to prove it.

Two things this exposed and fixed, both invisible until the console drove them:

- A `partially_applied` run could not be applied again. The page read "finished" off
  the run's status, and that status is set on exactly the run that still has changes
  waiting.
- A source created with a cron expression is scheduled the moment it commits, before
  its mappings can be written. `enabled` is now settable on create, so a source can be
  saved configured-but-not-running.

Three defects the security review of this work found, all now closed:

- **The stored bind password could be read back out of the vault.** A test that
  borrowed a saved source's credential spliced it into the caller's own
  configuration, `url` included, so anyone holding `sync.manage` could point it
  at a socket they controlled and capture the password in the clear. Borrowing
  now requires the transport — URL, TLS mode and certificate setting — to match
  the saved source; testing anywhere else costs the password, which is the
  proof of possession that was missing.
- **`source.test` was not audited at all**, which contradicted this branch's
  own rule. It is now, success and refusal alike, with the address it connected
  to.
- **`ldapts` was given no timeouts**, and defaults both to wait-forever. A host
  that black-holes packets pinned a request handler indefinitely.
  `connectTimeoutMs` and `timeoutMs` are config fields now, defaulting to 10s
  and 60s.

Still true of this surface, and deliberately left:

- The editor exposes every field the spec's section 5 names, but not `pageSize`, nor
  the two timeout fields added with them. All three are carried through untouched on a
  save rather than reset, since `config` is replaced whole.
- Groups and org units carry no source column of their own. `UsersPage` does, which is
  where an administrator would try to edit a synced field. Extending it is a one-line
  change per page once those pages grow rows worth labelling.
- The mapping editor cannot reorder rules, and does not need to: mapping is a set, not
  a sequence.

## ~~Transport security is weaker than promised~~ (spec section 8) — fixed

`ldapConfigSchema` carries a `tlsMode` of `plain`, `starttls` or `ldaps`, and the
connector calls `startTLS()` **before** the bind, with a test on that ordering for
both `test()` and `read()`. Certificate verification stays on by default and the
sources page names both the transport and a source with verification turned off.

Left out, the mode is derived from the URL scheme, so a source saved before the field
keeps the transport it had. A mode contradicting the scheme is refused rather than
reconciled. The dev OpenLDAP container needed `LDAP_TLS_VERIFY_CLIENT: try` before it
would serve StartTLS to a client with no certificate of its own; 636 is mapped too, so
LDAPS is tested against the real server as well.

Still open on this axis: the interface labels the settings but cannot yet *edit* them,
because there is no source editor — see the administration-surface item above.

## ~~A source is write-once~~ (spec section 5) — fixed

`PATCH /sources/:id` and `DELETE /sources/:id` exist, with an audit event in the same
transaction as the mutation. Every field is optional and only what was sent is
written; `config` is replaced whole, since it is validated as a whole. A new bind
password replaces the vault entry the source already names.

Create, update and delete each reconcile the scheduler immediately, so a source with a
cron expression no longer waits for a restart. Each source has a schedule *key* of its
own — pg-boss keys its schedule table on `(queue, key)` with `key` defaulting to `''`,
so before this every source on the `sync.run` queue wrote the same row and only the
last one scheduled ever ran. That was a second, unrecorded bug in the same area.

`User`, `Group` and `OrgUnit` now have a real foreign key to `DirectorySource`, `ON
DELETE RESTRICT`. Deleting a source deactivates and detaches what it owned, in one
transaction, and is refused with a 409 and the counts unless the caller confirms —
deactivating rather than orphaning, because an account no directory keeps current is
a leaver waiting to happen, and because this subsystem deletes no directory object
anywhere else.

## ~~An unresolvable member DN revoked the members we COULD read~~ — fixed

Found while diagnosing a flaky test, and much worse than the flake. `computeDiff`
resolved each of a group's member DNs to an anchor; a DN naming nothing the read
returned was counted in `unresolvedMembers` and then dropped. `desired` is
differenced against what Syntra holds, so the omission read as `remove_member`.

The two comments directly below that branch already explain, twice, why dropping
an anchor is wrong for the cases where the DN *does* resolve. The case where we
know least was the one falling through to a revocation.

The cost does not land on the unreadable member — they were already invisible. It
lands on everyone else in the group: `desired` is short one anchor, so the
difference proposes removing whichever real members remain. One dangling DN in
three thousand memberships is far under the deactivation threshold, so the guard
never sees it.

Directories present this constantly: OpenLDAP's referential-integrity overlay
rewrites a group's member DN *after* a `modifyDN` commits, so a read taken in that
window sees a dangling DN; a member outside the configured search base never
appears in the read at all; an entry deleted between the user read and the group
read is gone from one and named by the other.

`diffMemberships` now takes the set of groups read in part and proposes their
additions and none of their removals — the treatment every other partial read in
this subsystem gets. Per group, not per run.

This was also the cause of `scenarios.test.ts`'s intermittent failure on the
organizational-unit move, which turned the whole-repo suite red once during the
Govern merge. It moves `uid=jdoe` and previews immediately; with refint lagging,
`cn=Nurses` reported its only member as a dangling DN and the guard blocked the
apply at 100%. On an idle machine refint won the race; under a full-suite load it
did not. There is now a deterministic case built on a member DN that names no
entry at all, so the fix does not depend on winning or losing that race.

## Reads accumulate rather than stream (spec section 8)

Section 8 promises results "streamed rather than accumulated, so a large directory does
not become a large heap." `client.search()` drains every page internally and returns a
complete array; the connector maps that into a second complete array; `previewRun`
accumulates a third. The async-generator shape is decorative. `searchPaginated` is the
real fix. Note the fix wave corrects the comment that claims otherwise, but not the
behaviour.

## ~~Active Directory range retrieval~~ (spec section 8, by implication) — fixed

`readRangedAttribute` in `packages/connectors/src/ldap/range.ts` walks AD's
`member;range=low-high` windows until the server marks the last one with an
asterisk, and `read()` calls it for any group whose first response came back
truncated. Large AD groups now sync.

It never returns a partial result: a window that fails throws, and the record
is marked `readFailure` exactly as before. That path did not go away, it
stopped being the only path.

Closed under Ruling P1 in the Provision — Targets slice rather than as a
Directory Sync follow-up, because Provision *writes*: a truncated group read
makes 2,500 people look like they need grants, or like nothing at all, and
either reading drives writes to a real directory.

## The manual run endpoint is synchronous, and the console now waits on it

`POST /sources/:id/run` performs the whole read-and-diff inside the HTTP request. Spec
section 7 says a run is a pg-boss job. This mattered less while the endpoint had no
caller in the browser; the editor's **Run now** button now holds a request open for
the length of a full directory read, which is the shape that outlasts a proxy timeout.
The button reports as loading and the console lands on the run when it returns, so a
slow read looks like a slow button rather than a failure — but the fix is still to
enqueue and return the run id, and then poll.

## The default user filter is wrong for Active Directory — half closed

`userFilter` defaults to `(objectClass=person)`. In AD, `computer` derives from
`person`, so this matches every machine account in the domain and would create a Syntra
user for each. The conventional filter is `(&(objectCategory=person)(objectClass=user))`.

The console now seeds that filter when the editor's **Active Directory** button is
used, alongside the anchor attribute and the mappings, so the flavour is chosen once
and everything that depends on it follows. That is the per-flavour default the entry
above asks for, in the one place a source is actually configured.

The stored `ldapConfigSchema` default is unchanged and still wrong for Active
Directory, because changing it breaks OpenLDAP, which has no `objectCategory`. A
source created over the API without a `userFilter` still gets the OpenLDAP-shaped one.

## Smaller items, recorded but not urgent

- `create_user` / `create_group` / `create_org_unit` write only hardcoded columns and
  ignore other mapped fields. Self-corrects on the next run via `update_*`, but a first
  sync is lossy relative to the diff the administrator reviewed.
- Org units are created but never attached to anything — `parentId` is never set and no
  user's `orgUnitId` is ever assigned. The synced OU tree is flat and unreferenced.
- The `sync.apply` audit event is written outside the run's transaction. Narrow: every
  individual mutation already commits with its own audit event, so a crash in that
  window loses a summary, not the record of what changed.
- `SyncChange` is indexed on `(runId, changeType)` but `applyRun` queries
  `(runId, status)`.
- `scheduler.stop()` is never called on shutdown.
- `connector.ts` excludes the anchor attribute from the requested attribute list, so a
  mapping whose source attribute is the anchor can never resolve.
- No concurrency control on `applyRun`. Two simultaneous applies of one run would both
  see `proposed`. The unique constraint on `(tenantId, sourceId, sourceAnchor)` turns
  the duplicate into a failed change rather than a duplicate account — worth knowing
  that the schema, not the code, is what protects this.
