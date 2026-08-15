# Syntra Directory Sync

**Date:** 2026-08-15
**Status:** Approved design
**Scope:** Sub-project between Core and Access

---

## 1. Purpose

Bring people and groups from an existing directory into Syntra, and keep them
current, without anyone retyping a joiner or chasing a leaver.

Core can hold users, groups and organizational units, but every one of them has
to be created by hand. This slice connects an LDAP or Active Directory server as
a source and reconciles Syntra against it on a schedule.

### Success criteria

Done when a Syntra instance can:

1. Connect to an LDAP or Active Directory server, test the connection, and
   report what object classes and attributes it found.
2. Read users, groups, organizational units and group memberships from a
   configured search base, in pages, without holding the whole directory in
   memory.
3. Produce a reviewable diff — every proposed create, update, deactivation,
   reactivation and membership change, with before and after state.
4. Apply that diff exactly as reviewed, or apply part of it, or not apply it.
5. Refuse to apply a run that would deactivate an implausible share of the
   directory, and refuse outright when the source returned nothing.
6. Survive a person moving between organizational units without deactivating
   them or issuing them a second account.
7. Report a source record that collides with an existing local account, or with
   an account owned by another source, as a conflict rather than adopting it.
8. Run on a schedule, and record every applied change in the audit log.

---

## 2. Position in the program

| Sub-project | Status | Relationship |
|---|---|---|
| **Core** | built | Provides the directory, the vault, the scheduler, the audit log and `withTenant`. This slice is built on all of them. |
| **Directory Sync** | this document | Depends on Core. |
| **Access** | planned | Does not depend on this. The two can be built in either order. |
| **Provision** | planned | Depends on this. Inherits the connector interface and the evaluate-then-enforce pattern rather than reinventing them. |

Section 10 of the [Core + Access design](2026-08-14-syntra-core-access-design.md)
sketched this subsystem and is superseded in detail by this document. Its
commitments are kept: one connector interface, a diff that stops before writing,
deletion that deactivates rather than deletes, and a scope limited to users,
groups and organizational units.

---

## 3. Decisions

Settled during brainstorming; the implementation plan does not reopen them.

| Decision | Choice | Reasoning |
|---|---|---|
| Sources in this slice | LDAP and Active Directory only | One connector done properly, against the hardest case: no change feed, DN-based naming, paged results. Entra ID and Google are REST and are also identity providers, so they belong beside Access. |
| Change detection | Full read every run; absence means gone | Correct against any server, and correct after a failed run. DirSync and `entryUSN` cursors are Active Directory specific and silently wrong once a cookie is lost. At the documented 30,000-person ceiling a full read is seconds. |
| Outage protection | Threshold gate on the run | A run proposing to deactivate more than a configured share of active users will not auto-apply, and a run that read zero records never applies at all. |
| Attribute ownership | The source owns mapped fields | Mapped attributes are read-only in Syntra and rewritten each run; unmapped ones stay locally editable. Predictable, and the interface can say plainly where to change the value instead. |
| Group memberships | Synced | Access grants entitlements to groups. A group with no members is an empty shell, and maintaining membership in two places is the duplication this product exists to remove. |
| Existing local account | Reported as a conflict | Silent adoption would let anyone able to write to the directory capture an existing Syntra account, including a privileged one. |
| Reappearing user | Proposed reactivation, never automatic | Handles a rehire without recreating them, while keeping restored access an explicit decision — which also covers an outage having deactivated them wrongly. |
| Diff storage | One materialized row per proposed change | See section 4. |

---

## 4. Storing the diff

A run writes one `SyncChange` row per proposed action, and applying walks those
rows.

This makes "what you reviewed is exactly what you applied" literally true rather
than approximately true. It also survives a crash midway through an apply, lets
a single conflicting change be skipped without abandoning the whole run, and
renders in a review screen with no additional work.

**Rejected — recompute the diff at apply time** from a stored snapshot. Fewer
rows and always fresh, but the preview and the apply can disagree when the
source moves in between, which defeats the reason for splitting them.

**Rejected — serialize the plan as a single blob.** Compact, but unqueryable,
all-or-nothing, and a poor foundation for a review screen.

---

## 5. Data model

New tables, all tenant-scoped under the same forced row-level security and the
`NULLIF(current_setting(...), '')` policy as everything in Core.

### Configuration

- **`DirectorySource`** — `name`, `type` (`ldap`), `config` (JSON: host, port,
  TLS mode, bind DN, search bases, filters, anchor attribute), `secretName`
  naming the vault entry holding the bind password, `schedule` (cron or null),
  `autoApply`, `deactivationThresholdPercent` (default 10), `enabled`,
  `lastRunAt`.

  The bind password is never stored on this row. It lives in the Core vault and
  is fetched at run time, so a source can be read and edited by an administrator
  without exposing the credential.

- **`AttributeMapping`** — `sourceId`, `objectType` (`user` / `group` /
  `orgUnit`), `sourceAttribute`, `targetField`, `transform`
  (`none` / `trim` / `lowercase`), and whether the mapping is the correlation
  key.

### Run records

- **`SyncRun`** — `sourceId`, `status`, `startedAt`, `finishedAt`, counts by
  change type, `recordsRead`, `requiresConfirmation`, `blockedReason`, `error`.

  Status is one of `running`, `previewed`, `blocked`, `applied`,
  `partially_applied`, or `failed`. A run reaches `previewed` when the diff is
  complete, `blocked` when the guard refuses it, and `applied` only after every
  proposed change has been resolved.

- **`SyncChange`** — `runId`, `changeType`, `targetType`, `targetId` (null for a
  create), `sourceAnchor`, `before` JSON, `after` JSON, `status`
  (`proposed` / `applied` / `skipped` / `failed` / `conflict`), `message`.

  Change types: `create_user`, `update_user`, `deactivate_user`,
  `reactivate_user`, `create_group`, `update_group`, `deactivate_group`,
  `add_member`, `remove_member`, `create_org_unit`, `update_org_unit`.

  There is deliberately no delete of any kind, and no change type for an
  organizational unit that vanished from the source — see section 10.

### Directory changes

`User`, `Group` and `OrgUnit` each gain `sourceId` and `sourceAnchor`, unique
per tenant and source. A row with a null `sourceId` is locally managed and is
never touched by a run.

---

## 6. Identity across runs

**The anchor is the object's immutable identifier, never its distinguished
name.** `objectGUID` on Active Directory, `entryUUID` on OpenLDAP, configurable
per source.

This is the single most consequential detail in the design. A person moving from
one organizational unit to another changes their DN. Treating the DN as identity
would read that as a deletion plus a creation: the person is deactivated, loses
their group memberships, and is issued a second account — from an ordinary
Tuesday reorganisation. Anchoring on the GUID makes the same event a plain
update of one field.

Correlation proceeds in order:

1. By `(sourceId, sourceAnchor)`. This is the normal path and matches even if
   every other attribute changed.
2. Failing that, by the mapping marked as the correlation key, against accounts
   with no `sourceId`. A match here is a **conflict**, not an adoption.
3. Failing that, it is a new object.

A match against an account already owned by a **different** source is also a
conflict, and never a transfer. Two directories both claiming the same person is
a fact an administrator needs to see and resolve, not something a run should
settle by whichever happened to execute last.

---

## 7. Pipeline

Six stages. Each is a separate module with its own tests.

```
read → map → correlate → diff → guard → apply
```

- **read** — the only stage that talks to LDAP. Yields `SourceRecord` values.
- **map** — applies `AttributeMapping` to turn a `SourceRecord` into a
  `DirectoryObject`.
- **correlate** — resolves each object to an existing row, a conflict, or new.
- **diff** — emits `SyncChange` rows, including deactivations for anchors
  previously seen from this source and absent now.
- **guard** — see section 9.
- **apply** — the only stage that writes to the directory.

The four stages between reading and applying are pure functions over data. The
interesting logic — mapping, correlation, diffing, the threshold — is therefore
exhaustively testable without a directory server or a database, and the two
stages that do touch the outside world stay thin enough to test against real
ones.

A run is a pg-boss job carrying `{ tenantId, sourceId }` in its payload, because
a background job has no request and therefore no ambient tenant.

---

## 8. The LDAP connector

`ldapts`, against both OpenLDAP and Active Directory.

- **Paging** — simple paged results control at 1000 entries per page, streamed
  rather than accumulated, so a large directory does not become a large heap.
- **Transport** — LDAPS or StartTLS. Certificate verification is on by default
  and disabling it is a per-source setting that the interface labels plainly.
- **Anchors** — `objectGUID` arrives as binary and is normalised to its
  canonical hyphenated form; `entryUUID` arrives as text.
- **Memberships** — `member` and `memberOf` carry DNs, so the read builds a
  DN-to-anchor map during the same pass and resolves memberships against it. A
  member outside the configured search base is recorded as unresolved on the
  run, and is never silently dropped.
- **Failure** — a connection or bind failure fails the run with the reason on
  the `SyncRun`. A run that fails partway writes no changes at all: the diff is
  computed in full before any of it is applied.

The connector interface declares `write` for Provision's benefit, and LDAP
leaves it unimplemented in this slice.

---

## 9. The guard

Before a diff may be applied, automatically or by hand:

- A run that read **zero records** is blocked unconditionally. An empty
  directory is indistinguishable from an unreachable one, and the safe reading
  is the second.
- A run proposing to deactivate more than `deactivationThresholdPercent` of
  currently active users from this source is marked `requiresConfirmation` and
  will not auto-apply.

A blocked run is fully readable. An administrator sees exactly what it wanted to
do, in the same review screen as any other run, and confirms explicitly.
`autoApply` does not override the guard — an unattended schedule is precisely
the circumstance in which nobody is watching.

---

## 10. Applying

Each `SyncChange` is applied in its own transaction alongside its audit event,
so a change and its record commit together or not at all. A change that fails is
marked `failed` with the reason and the run continues; the run ends
`partially_applied` and names what did not land.

Deactivation never deletes. It sets the user inactive with a reason naming the
source and the run, exactly as Core's `deactivateUser` already does.

**A group that disappears from the source is deactivated, not removed**, and its
memberships are left in place. A group is the thing entitlements are granted to,
so deleting one silently revokes access from everybody in it — the same
irreversible outcome the user rule exists to prevent. A deactivated group is
listed, labelled, and grants nothing.

**An organizational unit that disappears is left alone** and reported on the
run. Units carry scoped administrative role assignments, and removing one would
silently narrow or widen someone's authority. This is rare enough, and
consequential enough, to be a human decision.

Applying a run whose changes were computed against a directory state that has
since moved is allowed — the changes are applied as reviewed. Freshness is the
schedule's job, not the apply step's.

---

## 11. Administration surface

- A sources list, and an editor with a **Test connection** action that reports
  what it found before anything is saved.
- Attribute mapping editor, seeded with sensible defaults for Active Directory
  and OpenLDAP so the common case needs no typing.
- A run history, and a run detail screen grouping proposed changes by type with
  before and after values, an **Apply** action, and per-change skip.
- A blocked run leads with why it was blocked and the numbers behind it.
- Synced fields render read-only wherever they appear, naming the source that
  owns them.

---

## 12. Testing

- **Unit** — map, correlate, diff and guard as pure functions. The guard is
  tested at its boundaries: just under the threshold, exactly at it, just over,
  and zero records read.
- **Integration** — against a real OpenLDAP container seeded with LDIF, run
  through the whole pipeline: a first sync that creates, a second that is a
  no-op, an attribute change, an **organizational unit move that must not
  deactivate anyone**, a deletion that deactivates, a reappearance that proposes
  reactivation, a membership change, and a paged read that crosses the page
  boundary.
- **Guard** — a run that would deactivate everyone is blocked, and stays
  blocked with `autoApply` on.
- **Conflict** — a source record matching a locally created administrator is
  reported as a conflict and does not take the account over.

---

## 13. Out of scope

Entra ID and Google Workspace connectors, incremental or DirSync cursors,
writing back to the directory, per-field override flags, and syncing persons or
contracts. A directory is an account store, not an authoritative record of
employment; persons and contracts continue to come from an administrator or,
later, from Provision.
