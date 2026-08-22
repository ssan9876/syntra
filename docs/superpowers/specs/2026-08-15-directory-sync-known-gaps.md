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

## ~~Reads accumulate rather than stream~~ (spec section 8) — fixed

`client.search()` drained every page internally and handed back one complete
array, which the connector then mapped into a second complete array before
yielding any of it, and `previewRun` accumulated a third. Section 8 asks for
results "streamed rather than accumulated, so a large directory does not become a
large heap"; the async-generator shape was decorative.

`read()` now walks `searchPaginated` and yields each entry as it maps it. A page
is still a page — `pageSize` entries are resident while they are mapped — and
`previewRun` still collects what it is given, because the diff correlates the whole
read against a snapshot and cannot be computed a page at a time. What is gone is
the two full copies underneath that, which is the difference between one and three.

The test that pins it asserts the connector yields from the first page before the
server is asked for the second. Every other test in that file consumes the whole
iterator and passes either way, which is how this stayed decorative long enough to
be written down as spec debt.

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

## ~~The manual run endpoint is synchronous, and the console waits on it~~ — fixed

`POST /sources/:id/run` performed the whole read-and-diff inside the HTTP request.
A directory read is network-bound and has no time limit of its own, and holding a
request open for it is the shape that outlasts a proxy timeout: the browser is told
the run failed while the run carries on, and the operator's next move is to press
the button again.

`queueRun` creates the run row and then enqueues — that order, because the reverse
races a free worker against a transaction that has not committed — and the endpoint
answers 202 with the row the worker will fill in. Section 7's "a run is a pg-boss
job" now covers the manual path as well as the schedule.

`queued` is a state distinct from `running`: between them the job sits in pg-boss
for as long as the queue is busy, and a screen showing `running` for that window
would be lying about the directory. The run page names the difference and follows
the run, stopping when it settles.

With no scheduler the endpoint answers 503 rather than falling back to inline. The
failure that leaves it null means no scheduled sync is running for any source in
any tenant, and doing the work inline would hide a broken deployment behind a
button that still appears to work.

## The default user filter is wrong for Active Directory — a kept decision

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

## ~~The LDAP test fixture is shared mutable state across parallel workers~~ — fixed

Six test files read the one OpenLDAP container at `localhost:1389`, and the
suite runs up to eight worker processes in parallel. Each worker gets a database
of its own — `vitest.config.ts` shards them precisely so two workers cannot
truncate each other's tables — and there was no equivalent for the directory.

`scenarios.test.ts` is the only writer. It moves `uid=jdoe` between
organizational units, replaces `cn=Nurses`' member list, and adds and removes
whole entries. Every one of those was visible to the four readers, whose sources
were scoped to `dc=acme,dc=test` — the whole tree. A reader previewing twice
around one of those windows saw an object appear or vanish and proposed a
`create_user` or a `deactivate_user` for it. Observed twice: `scenarios.test.ts`
failing in the whole-repo run (that one turned out to be the product defect
above), and `run-service.test.ts > proposes nothing on a second run over an
unchanged directory` proposing a `deactivate_user`. Both files passed alone.

`infra/ldap/seed.ldif` now carries two subtrees of identical shape:
`ou=Shared,dc=acme,dc=test` for the five files that only read, and
`ou=Scenarios,dc=acme,dc=test` for the one that writes. Each file scopes its
source to its own container, so no file can observe another's directory. The
rule this establishes — **a test that mutates the directory gets a subtree of
its own** — is the one `e2e/sync.spec.ts` already followed with its timestamped
OU; this applies it to the fixtures that ship.

Verified by repetition rather than by one green run: the race passed
intermittently before, so a single pass proves nothing. The files were run
together, in parallel, several times over, and then the whole repository.

`packages/connectors/src/ldap/connector.test.ts` was missed on the first pass —
the audit that found the readers searched `packages/core` and `apps/api` and not
`packages/connectors`, and the sync-scoped verification runs could not have
caught it. The whole-repo run did, deterministically: its user counts doubled and
its group DNs moved. The lesson is the audit, not the fix — "which files talk to
this container" is a question to ask of the repository, not of the directories
the bug happened to be found in.

Changing the fixture means REMOVING the container, not restarting it — the image
bootstraps its custom LDIF only into an empty data directory. `README.md` says
so where the other OpenLDAP recreation note lives.

## ~~The synced organizational tree was flat and unreferenced~~ — fixed

Org units were created and then attached to nothing, and Syntra's scoped
administration is built on that tree.

I first recorded this as two decisions — the hierarchy an unfinished import, the
user's placement a policy choice — and parked the second. That was wrong, and the
spec says so plainly. Section 6, on anchoring: "A person moving from one
organizational unit to another changes their DN... Anchoring on the GUID makes the
same event **a plain update of one field**." Success criterion 6 requires surviving
that move; today it survived by doing nothing, which passes the letter and leaves
Syntra permanently stale about where people work.

What an org unit's REMOVAL means is a genuine policy choice, and it is untouched: a
unit that disappears from the source is still left alone, still reported, still a
human decision, exactly as section 10 says. That is the rule the `diff.ts` comment
about scoped role assignments was always about, and it is not this rule.

`parentAnchor` rides in the change's `fields`, so the ordinary field diff picks it
up — one before-and-after line, reviewed like anything else — but it is structural
rather than mappable: `ASSIGNABLE_FIELDS` does not list it, so no mapping rule can
aim a source attribute at the hierarchy, and `apply` strips it from the blob and
translates it to a local id.

Three things it had to get right, each with a test that fails without it:

- **A parent we could not read is not a parent that is gone.** `parentAnchorOf`
  returns undefined for a unit above the search base or one whose read failed, and
  undefined omits the key — `fields` is differenced against what is stored, so an
  omitted key proposes nothing while `''` proposes a detach. Otherwise a run whose
  org-unit search came back empty detaches every person in the tenant from their
  department, silently narrowing every scoped administrative role, and reports
  success. Same rule as the unresolvable member DN above.
- **Order.** `orderBy: { id: 'asc' }` is uuid order. Units now apply before the users
  that name them and parents before their children, reconstructed from the anchors
  the diff already carries.
- **Escaped commas.** `cn=Doe\, Jo,ou=Care,...` is what Active Directory generates
  for someone displayed as "Doe, Jo"; splitting on the first raw comma yields a DN
  that resolves to nothing, which this code reads as "in no organizational unit".

## ~~A group that came back could never come back~~ — fixed

Found while adding the above, and older than it.

`diffObjects` routed a returning group through `update_group` carrying
`{ status: 'active' }`. `status` is not a field a mapping may write —
`rejectUnassignable` refuses it, and rightly, since a source attribute that could
set `status` could deactivate people — so the change failed on every run. Forever.
The run came back `partially_applied` with a failed change, and the group stayed
inactive with its memberships intact and granting nothing.

Deactivation is chosen over deletion precisely because it is recoverable, and the
memberships are kept precisely so the group can return intact. A group that cannot
return is deleted in all but name. `reactivate_group` is now a change type of its
own, outside `MAPPED_WRITES`, mirroring the `reactivate_user` that has been the
working half of this pair all along.

The unit test asserted `update_group`. It encoded the defect exactly, which is why
nothing ever caught it — a reminder that a test agreeing with the code is not the
same as a test checking it.

## Smaller items

- ~~`create_user` / `create_group` / `create_org_unit` write only hardcoded columns and
  ignore other mapped fields.~~ **Fixed.** The columns they write turn out to be exactly
  `ASSIGNABLE_FIELDS`, so nothing mappable was being lost — but `rejectUnassignable`
  covered `update_*` only, so a create carrying a field a mapping may not write dropped
  it in silence rather than failing. The administrator reviewed a diff naming the field
  and got a row without it. Creates now refuse it with the same message updates get.
- ~~Org units are created but never attached to anything — `parentId` is never set
  and no user's `orgUnitId` is ever assigned.~~ **Fixed** — see below; it grew out of
  the smaller-items list and got a section of its own.
- The `sync.apply` audit event is written outside the run's transaction. **Kept.** Every
  individual mutation already commits with its own audit event, so a crash in that
  window loses a summary and not the record of what changed.
- ~~`SyncChange` is indexed on `(runId, changeType)` but `applyRun` queries
  `(runId, status)`.~~ **Fixed** — `(runId, status)` added alongside, not instead:
  the console's per-run listing really does read by type.
- ~~`scheduler.stop()` is never called on shutdown.~~ **Fixed**, and it was worse than
  the note suggested: `server.ts` registered no signal handler at all, so SIGTERM
  terminated the process outright — in-flight requests cut, a sync run abandoned
  mid-directory, pg-boss still holding its job. `shutdownHandler` drains HTTP, then
  stops the scheduler, then disconnects Prisma. HTTP first, because a request in flight
  may enqueue and a scheduler stopped underneath it turns a save into a 500.
- ~~`connector.ts` excludes the anchor attribute from the requested attribute list, so a
  mapping whose source attribute is the anchor can never resolve.~~ **Fixed** — and as
  the NORMALISED value, because `toArray` renders a Buffer with `toString('utf8')` and
  `objectGUID` is sixteen raw bytes, so the obvious version of the fix writes mojibake
  into somebody's record.
- No concurrency control on `applyRun`. Two simultaneous applies of one run would both
  see `proposed`. The unique constraint on `(tenantId, sourceId, sourceAnchor)` turns
  the duplicate into a failed change rather than a duplicate account — worth knowing
  that the schema, not the code, is what protects this.

---

## What is left, and why it is left

Three things on this page are decisions rather than debt. They are written down so
that the next person to read the list knows the difference.

**The stored `ldapConfigSchema` default for `userFilter` stays wrong for Active
Directory.** `(objectClass=person)` matches every machine account in an AD domain,
and the right filter is `(&(objectCategory=person)(objectClass=user))` — but
`objectCategory` does not exist in OpenLDAP, so changing the stored default breaks
the other half of the supported directories. The console seeds the correct filter
when the editor's **Active Directory** button is used, which is the one place a
source is actually configured. A source created over the API without a `userFilter`
still gets the OpenLDAP-shaped one.

**The `sync.apply` summary event is written outside the run's transaction.** Every
individual mutation commits with its own audit event, so the window loses a summary
and never the record of what changed.

**Groups and organizational units carry no source column in the console.** `UsersPage`
does, which is where an administrator would try to edit a synced field and needs to be
told they cannot. Extending it is a line per page once those pages grow rows worth
labelling.

Everything else on this page is closed.

## Seven workers takes PostgreSQL down — measured

Fourteen full suite runs on an eight-core box, chasing what looked like one flaky
suite and turned out to be two failures with very different meanings.

**The symptom that matters.** A PostgreSQL backend exits with code 2, the
postmaster terminates every other backend, and the cluster enters recovery. Every
test in flight fails — eighty, ninety files at a time — and the output reads as a
catastrophic regression in code that is fine. Not OOM: zero signal terminations,
`oom_kill 0` in the cgroup, memory ample. No `PANIC`, nothing logged before it.
The cause of the exit itself is still unidentified.

**The numbers.**

| workers | `max_connections` | platform | result |
|---|---|---|---|
| 7 | default 100 | LXC | 1 crash in 5 runs, 1 flaky run |
| 7 | **300** | LXC | 1 crash in 2 runs |
| 7 | **300** | KVM | **3 crashes in 3 runs** |
| 4 | default 100 | KVM | **0 crashes, 0 hook timeouts, 3 runs** |

**Raising `max_connections` made it worse, and that was the wrong lever twice
over.** Prisma's pool is `cores * 2 + 1` per client and every vitest worker builds
its own — 231 connections across seven workers, plus pg-boss's own pools. At the
default ceiling the excess is refused cleanly and concurrency is capped; at 300
every one of them is established and an eight-core machine is oversubscribed.
Capping Prisma's pool instead (`connection_limit=10`) failed differently: that
error is Prisma waiting for a connection in its OWN pool, so a smaller pool
produces it sooner, and three more files started failing.

**A VM did not help; it hurt.** The whole exercise was moved from an LXC container
to a KVM guest on the same host, same image, same versions, same tuning, to test
whether Docker-in-LXC was at fault. It crashed in all three runs — worse than the
container. The hypervisor is exonerated; the demand is the problem.

**Four workers is the answer this hardware gives.** Three consecutive runs, no
crashes, no hook timeouts, 3,357 tests. It costs time: ~43 minutes a run against
~24 at seven. `SYNTRA_TEST_WORKERS` already existed for this and CI now pins it.

**What is still unexplained**, and worth saying rather than papering over: why the
backend exits with code 2 at all. Oversubscription explains the correlation but not
the mechanism, and nothing in the PostgreSQL log, the kernel log or the cgroup
accounting names it.

Left over from the same runs: `transaction-budget.test.ts` fails on a cold database
— 3241ms and 4579ms against a 2500ms budget on the first run after the container is
recreated, passing on every run after. The budget is real and worth keeping; the
first-run measurement is against cold caches.

## Two load-sensitive tests, outside this subsystem

Found by the whole-repo runs that verified the work above, recorded here because
this is where the reader is. Neither is Directory Sync, and neither is a
regression — both pass alone and fail on a machine running eight workers.

- `auth/login-service.test.ts > takes comparable time for an unknown login and a
  wrong password` asserts a wall-clock RATIO inside `0.3 … 3`. It measured 3.05.
  The property it is defending is real and worth defending — an unknown login and
  a wrong password must do the same work, or the login endpoint is a user
  enumeration oracle — but a ratio of two timings on a loaded machine is not a
  sound way to measure it. Asserting that both paths perform a password hash
  would be.
- `automate/catalog-service.test.ts > does not race two concurrent first reads
  into a P2002` fires eight concurrent transactions and fails intermittently with
  "Unable to start a transaction in the given time" — pool acquisition, not the
  race it is testing. It reproduces running alone, so "load" was the wrong word
  for it.

  **The arithmetic behind it, and a fix that did not work.** Prisma's default pool
  is `physical cores * 2 + 1` per client, and every vitest worker builds its own.
  On this sixteen-core machine that is 33 each and 264 across eight workers,
  against a PostgreSQL `max_connections` of 100 — so the shards, given a database
  apiece precisely so they could not interfere, still share one server and still
  interfere through it.

  Pinning `connection_limit=10` on the shard URLs looked like the fix and made
  things worse: one failing file became five, all with the same error, because
  that message is Prisma's `maxWait` expiring while it waits for a free connection
  in *its own* pool. Shrinking the pool from 33 to 10 makes it more likely, not
  less, for any worker that legitimately wants more than ten transactions at once
  — `scheduler.test.ts`, `sync/jobs.test.ts` and `loop.integration.test.ts` all do,
  and all three started failing. It was reverted.

  A real fix is one of: raise the server's `max_connections` (an infra change to
  `infra/docker-compose.yml`), lower the worker count and accept a slower suite, or
  give each worker a pool small enough for the server AND raise `maxWait` so a
  queued transaction waits rather than throwing. All three are deliberate choices
  about the suite rather than about Directory Sync, which is why this is written
  down instead of chosen here.

`govern/transaction-budget.test.ts` was a third and is now fixed: its slice-1 half
measured the unbounded case only, so when the machine was slow enough for the
breach to arrive as Prisma's 5,000 ms transaction ceiling instead of a number, the
test that exists to prove the budget matters failed by proving it. The slice-2 half
of the same file had already learned this and treats an abort as the same finding.
