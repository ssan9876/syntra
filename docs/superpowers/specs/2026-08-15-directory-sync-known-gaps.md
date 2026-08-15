# Directory Sync — spec debt

What the approved spec promises that the branch does not yet deliver. Recorded
deliberately rather than absorbed silently, so the gap is a decision rather than a
surprise. Each item names the spec section that binds it.

## A conflicting user makes a clean run report as half-broken

The highest-priority item on this page, because it is half of a fix that was made.

A source user that correlates to a locally managed account is a conflict, so it is
never created with that source anchor. An `add_member` referencing it then fails its
user lookup, and the run ends `partially_applied` even though everything appliable
applied cleanly. This was fixed for conflicting *groups* and not for conflicting
*users* — the brief that drove the fix diagnosed only the group side.

Pre-existing, not a regression, and it fails safe: nothing wrong is written, the run
merely reports worse than it performed. Reproduced against the current branch with a
locally managed `jdoe` and an LDAP `jdoe` in a group.

The remedy, from the reviewer who found it: mirror the unmappable-member handling in
`run-service.ts` — build a `usableMembers` set from user correlations that are
`matched` or `new`, and for an anchor outside it, keep the membership if Syntra
already holds it and skip it otherwise. **A plain `continue` is wrong**: it turns the
conflict into a spurious `remove_member`, which revokes real access. That hazard is
why this was left for a reviewed change rather than applied unreviewed at the end of
a long session.

Not covered by existing tests — the "never applies a conflict" test applies the run
but asserts only on the local user, never on the run's status.

## The administration surface is roughly a third built (spec section 11)

Section 11 describes five things. Two exist.

| Promised | State |
|---|---|
| A sources list | Built — read-only table |
| A source editor with a **Test connection** action | **Missing.** `test()` is implemented and reachable over the API; nothing in the console calls it. `SourceDetailPage.tsx` appears in the plan's own file list and was never built. |
| Attribute mapping editor seeded with AD and OpenLDAP defaults | **Missing.** `DEFAULT_MAPPINGS` exists with both flavours; there is no UI to see or change them. |
| Run history, and a run detail screen with Apply and per-change skip | Partly. History and detail are built, Apply works. **Per-change skip is implemented server-side and has no control in the console.** |
| A blocked run leads with why, and the numbers | Built |

Consequence in plain terms: an administrator cannot create or configure a directory
source from the console at all. Source creation, mapping, connection test and preview
are API-only. The end-to-end test drives those four steps over HTTP for exactly this
reason, and says so in its own comments.

Two spec success criteria are unreachable from the UI as a result:

- Criterion 1, "report what object classes and attributes it found" — `discoverSchema`
  is implemented and has no caller outside its own test. `test()` returns three counts.
- Criterion 4, "apply part of it" — `applyRun` accepts an `only` list and
  `skipChange` works; neither has a control.

The README is honest about this. Its module table row claiming "source and run
administration screens" overstates it and should be softened.

## Transport security is weaker than promised (spec section 8)

Section 8 says "Transport — LDAPS or StartTLS" and section 5 lists a TLS mode in the
source config. Neither exists. `ldapConfigSchema` has no TLS field and the connector
derives TLS solely from an `ldaps://` URL prefix. There is no `startTLS()` call
anywhere on the branch. An `ldap://` source binds in plaintext, bind password on the
wire, with no way to configure otherwise.

This is the item I would fix first of everything on this page.

## A source is write-once (spec section 5)

There is no update or delete on `/sources`. Schedule, `enabled`, `autoApply`,
`deactivationThresholdPercent` and the bind password are all fixed at creation. The
plan's file structure says "source CRUD"; only C and R were built.

Related: `scheduleAllSyncSources` runs once at API boot, and the create route does not
touch the scheduler — so **a source created with a cron expression is not scheduled
until the process restarts.** Also `User.sourceId` has no foreign key to
`DirectorySource`, so a source removed by any means would strand its users permanently
unsynced.

## Reads accumulate rather than stream (spec section 8)

Section 8 promises results "streamed rather than accumulated, so a large directory does
not become a large heap." `client.search()` drains every page internally and returns a
complete array; the connector maps that into a second complete array; `previewRun`
accumulates a third. The async-generator shape is decorative. `searchPaginated` is the
real fix. Note the fix wave corrects the comment that claims otherwise, but not the
behaviour.

## Active Directory range retrieval (spec section 8, by implication)

AD returns `member` on groups above 1500 entries as `member;range=0-1499`, and ldapts
does not implement range retrieval. The fix wave makes this fail loudly instead of
proposing to empty the group — which is the safe interim behaviour, not the correct
one. **Large AD groups cannot be synced until this is implemented.** If Active
Directory is a launch target, this is the second thing to fix.

## The manual run endpoint is synchronous

`POST /sources/:id/run` performs the whole read-and-diff inside the HTTP request. Spec
section 7 says a run is a pg-boss job. Even with the transaction fix, a full directory
read will outlast typical proxy timeouts. It should enqueue and return the run id.

## The default user filter is wrong for Active Directory

`userFilter` defaults to `(objectClass=person)`. In AD, `computer` derives from
`person`, so this matches every machine account in the domain and would create a Syntra
user for each. The conventional filter is `(&(objectCategory=person)(objectClass=user))`.
Left alone because changing the default breaks OpenLDAP, which has no `objectCategory` —
the real fix is per-flavour config defaults to match the per-flavour `DEFAULT_MAPPINGS`
that already exist.

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
