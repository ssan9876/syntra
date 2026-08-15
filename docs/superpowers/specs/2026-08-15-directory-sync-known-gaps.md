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
administration screens" overstated it and now says what is actually there: source
lifecycle over the API, a run review screen in the console.

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
