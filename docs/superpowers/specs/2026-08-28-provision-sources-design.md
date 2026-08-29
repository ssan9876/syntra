# Provision — Sources: the HR feed

Status: implemented on `worktree-provision-sources`, 2026-08-29
Based on `f091608`

Built as specified, with four departures worth reading before the sections
that describe them:

- **`readFailure` and mapping failures needed a second rule.** Excluding those
  records from the diff is not enough on its own: a failure that cannot be
  attributed to a person -- which is every failure when the correlation column
  is renamed -- leaves everybody looking absent. The diff therefore takes
  `absenceReliable`, and withholds the whole absence half when any failure is
  unattributable. See "Absence".
- **The guard is given the population as it WOULD be, not as it is.**
  `populationDropRefusal` refuses a zero count unconditionally, so passing the
  current count blocked every first run of every source. See "The guard".
- **A run can end `partially_applied`**, as Directory Sync's does. The spec
  said `applied`; a run whose every change failed must not report success.
- **`test` samples rather than caps.** The spec's byte ceiling is a refusal,
  which is right for `read` and wrong for a connection test: applied to `test`
  it failed every export larger than the sample.

Phase 2 -- duplicate detection and merging -- remains unbuilt, as planned.

## Why

`docs/superpowers/specs/2026-08-16-syntra-provision-design.md:88` splits
sub-project 2 in half at the person register and names the two halves. Targets
was built first, deliberately, because every irreversible decision in the
sub-project lives there. This is the other half:

> **Provision — Sources** (sibling document): HR source systems, scheduled
> imports of persons and contracts, snapshots, duplicate detection and merging,
> and the same evaluate-then-enforce discipline applied to writing `Person` and
> `Contract` rows.

Everything downstream of the person register now assumes an HR feed that
nothing in the codebase produces. `identity/population-drop.ts` refuses a run
whose person population collapsed because "this is the signature of a broken HR
feed" — and has no caller that feeds it an import. `govern/rule-mining.ts:109`
discounts a candidate rule over people whose department is unset because that
is "a statement about a gap in the HR feed". `sync/apply.ts:233` calls dropping
out of the feed "the commonest offboarding signal". `provision/desired.ts` has
a branch for a directory-only person with "nothing in the HR feed to derive a
date from". The feed is load-bearing in the reasoning of four subsystems and
absent from the product.

What exists instead is `identity/csv-import.ts`: a fixed five-required-column
parser, no configurable mapping, no preview, no guard, no schedule, driven by
an administrator pasting a file into `ImportTab`. It is honest about being
that, and `apps/api/src/routes/admin/persons.ts:368` records the consequence —
a Person has no `sourceId`, so nothing is source-owned and every field stays
hand-editable.

This spec adds a source family for HR systems: scheduled reads, mapped onto
`Person` and `Contract`, diffed, guarded, previewed and applied in the same
idiom Directory Sync established.

## What this is not

**Not a widening of `DirectorySource`.** `DirectorySource` owns `users`,
`groups` and `orgUnits` foreign keys and four write-back flags, and
`SourceRecord` is built around `dn`, `anchor`, `memberDns` and an `ObjectType`
of `user | group | orgUnit`. A person is none of the three. Carrying HR sources
in those tables means a fourth object type, a synthetic DN, and four write-back
columns that are permanently false on half the rows — and those tables are
trustworthy precisely because they only know three things. The seam the
Provision design draws is the point: "nothing in this document reads a source
system, and nothing in Sources writes to a target. They meet at `Person` and
`Contract` and nowhere else."

**Not a shared run kernel.** `PersonImportRun` is close to a copy of `SyncRun`,
and `evaluatePersonGuard` is close to a copy of `evaluateGuard`. Extracting the
common engine now means refactoring a shipped, tested subsystem against one
guess at what is common. The right time is after the second consumer exists.
The duplication is accepted knowingly and is the evidence a later extraction
would be built on.

**Not a write path.** An HR system is authoritative. `SourceConnector` has no
`write`, no `discoverSchema` and no `SourceWriteback` — the interface having no
write path is the enforcement, not a policy note in a docstring.

**Not deletion.** No change type in this pipeline deletes a `Person` or a
`Contract`, and none can become one. The argument is the one
`ProvisionActionType` already makes: the characteristic accident of a feed is
not one wrong person, it is four thousand, and every action has to be one that
four thousand instances of can be walked back.

**Duplicate detection and merging is phase 2.** It is in scope for the
sub-project and specified in this document, but it is not in the first slice.
Merging two `Person` rows reconciles contracts, `TargetAccount`s,
`AccountPlacement`s and audit history, and it is the one operation here that is
hard to walk back. The "Phase 2" section states its shape so it can be built
without reopening this design.

## The connector

A new interface in `@syntra/connectors`, deliberately much smaller than
`Connector<C>`:

```ts
export interface SourceConnector<C> {
  test(config: C): Promise<SourceConnectionResult>;
  read(config: C): AsyncIterable<PersonSnapshotRecord>;
}
```

Its own registry, a plain lookup in the idiom of `registry.ts`, with
`PERSON_SOURCE_TYPES = ['sftpDelimited'] as const` and an
`UnknownPersonSourceTypeError` naming the known types. Adding a second family
is one entry in each of two records, not a new mechanism.

### `SourceConnectionResult`

Not `ConnectionResult`. That type carries `sampleCounts` keyed by `ObjectType`
and `rights` describing what a bind may write, and neither means anything for a
read-only person source. What the console actually needs back from a test is
different:

```ts
export interface SourceConnectionResult {
  ok: boolean;
  message: string;
  /** Column names as the file presents them. Drives the mapping editor. */
  columns?: string[];
  recordsSampled?: number;
  /**
   * The host key the server presented, and whether it matches what is stored.
   * `unknown` is what the accept action acts on; `mismatch` offers no action.
   */
  hostKey?: {
    fingerprint: string;
    status: 'matched' | 'unknown' | 'mismatch';
  };
}
```

`hostKey` is on the result rather than thrown as an error because an unknown
key on a first test is the ordinary path, not a failure — it is how a
fingerprint is obtained. A mismatch is a failure and sets `ok: false`, and the
distinction between the two states is the whole reason this is a three-valued
field rather than a boolean.

### Completeness is a contract of `read`

`read` either yields every record the source holds or throws. There is no third
outcome and no partial-success return value, because a partial read that a
caller could mistake for a complete one is the input that departs a workforce.
The `maxBytes` and `maxRows` ceilings therefore throw when reached rather than
stopping the iteration, a transport error mid-stream propagates rather than
ending it, and the run records a failure and computes no diff at all. Per-record
incompleteness has its own channel — `readFailure` — which is a statement about
one person, never about the file.

### `PersonSnapshotRecord`

A person and their contracts, read as one unit. A person imported without their
contracts has no department, no start date and no manager, and the placement
ladder and every business rule would read that as true rather than as missing.

```ts
export interface ContractSnapshot {
  /** The HR system's own employment id. See `Contract.externalId`. */
  externalId?: string;
  sequence?: number;
  isPrimary?: boolean;
  startDate: string;
  endDate?: string;
  jobTitle?: string;
  department?: string;
  costCentre?: string;
  employer?: string;
  location?: string;
  managerExternalId?: string;
  fte?: string;
}

export interface PersonSnapshotRecord {
  /** The anchor. Correlates to `Person.externalId`. */
  externalId: string;
  fields: Record<string, string>;
  contracts: ContractSnapshot[];
  /**
   * Set when the source returned this person but the connector could not read
   * them completely enough to diff against safely. The record is still
   * returned rather than dropped, because the difference between "this person
   * is gone" and "we could not read this person" is the difference between a
   * correct departure and a catastrophic one. A reader seeing this must count
   * the record as read, exclude it from the diff, and never treat it as
   * absent.
   */
  readFailure?: string;
}
```

Values are single strings, not `string[]`. `SourceRecord` uses arrays because
that is what LDAP returns regardless of what the schema claims; a delimited
file has one value per cell, and pretending otherwise would push the unwrapping
into every consumer.

### `sftpDelimited`

Config: `host`, `port`, `username`, `remotePath` (a path or a glob resolving to
exactly one file — more than one match is an error, not a choice), `delimiter`,
`quoteChar`, `encoding`, `hasHeaderRow`, `hostKeyFingerprint`, `maxBytes`,
`maxRows`. The credential — private key or password — goes to the vault under
`personSource.<id>.credential`, as `createSource` does with `bindPassword`
today.

Four transport rules:

1. **Host key pinning is mandatory.** `ssh2`'s `hostVerifier` callback receives
   the server's key, and it is compared against the stored fingerprint. There
   is no trust-on-first-use and no `hostVerifier: () => true`. A source with no
   fingerprint cannot run; `test` is how one is obtained, and accepting it is a
   deliberate act with an audit event behind it rather than a default nobody
   sees. `test` against a *changed* key reports a mismatch and stops — a host
   key that changed is either a rebuilt server or an interception, and only one
   of those is safe to click through.
2. **The address is checked and the connection pinned to it.**
   `classifyAddress` from `net/outbound.ts` classifies every resolved address,
   and the connection is made to the literal address that was checked. `ssh2`
   takes a `host`, so the DNS-rebinding window `fetchExternalDocument`
   documents exists here identically and closes the same way.
   `OUTBOUND_ALLOW_PRIVATE` lifts the private-address refusal, and unlike the
   HTTP case it will routinely be needed: an HR server on a private network is
   an ordinary deployment.
3. **Key-based authentication is the documented path**, password
   authentication supported because real HR vendors still ship it.
4. **`maxBytes` and `maxRows` refuse rather than truncate.** A short read that
   looked successful is the exact input the guard exists to catch, and it is
   better never to manufacture one.

**Transport is separate from parsing.** `readDelimited(text, options)` is a
pure function of a string, fully testable with no server, and the SFTP half is
a thin fetch around it. A later `localFile` or `httpJson` person source reuses
the parser unchanged.

## Data model

Four new tables, three new columns. Nothing modifies `DirectorySource`,
`SyncRun` or `SyncChange`.

### `PersonSource`

`id`, `tenantId`, `name`, `type`, `config` Json, `secretName`, `feedMode`,
`schedule`, `autoApply`, `deactivationThresholdPercent` (default 10, as
`DirectorySource` has), `enabled`, `lastRunAt`, `createdAt`, `updatedAt`,
`@@unique([tenantId, name])`, `@@index([tenantId])`.

Relations: `mappings`, `runs`, `persons`.

What it does not carry is load-bearing: no `writebackEnabled`,
`writebackPassword`, `writebackDisable` or `writebackDelete`, because the
connector interface has no write path; no `users`/`groups`/`orgUnits`; no
`pairedTargets`. Those four flags on an HR source would be four columns that
are permanently false and that somebody eventually wires up by mistake.

`feedMode` is `'snapshot' | 'delta'` and **has no default**. See "Absence".

### `PersonFieldMapping`

`id`, `tenantId`, `sourceId`, `recordType` (`'person' | 'contract'`),
`sourceColumn`, `targetField`, `transform` (`none | trim | lowercase`),
`isCorrelation`, `@@unique([sourceId, recordType, targetField])`,
`@@index([tenantId])`.

The same shape as `AttributeMapping`, keyed by record type instead of
`ObjectType`, and under the same allow-list discipline `sync/mapping.ts`
applies. `ASSIGNABLE_PERSON_FIELDS` is `givenName`, `familyName`,
`nameConvention`, `businessEmail`, `personalEmail`.
`ASSIGNABLE_CONTRACT_FIELDS` is `externalId`, `sequence`, `isPrimary`,
`startDate`, `endDate`, `jobTitle`, `department`, `costCentre`, `employer`,
`location`, `managerExternalId`, `fte`.

`Person.status` is not assignable, for the reason `sync/mapping.ts` gives about
`User.status`: a source column an administrator can point at anything is a way
to deactivate a workforce by typo. Departure has exactly two legitimate
sources, a contract `endDate` and `departureOverride`, and neither is a
mapping.

`Person.externalId` is not assignable either — it is the correlation anchor,
fixed at source creation. Changing it re-anchors every person the source owns,
so it is not a field that moves.

### `PersonImportRun`

`id`, `tenantId`, `sourceId`, `status`, `startedAt`, `finishedAt`,
`recordsRead`, `requiresConfirmation`, `blockedReason`, `error`,
`mappingFailures`, `mappingFailureReasons String[]`, `personsAbsent`,
`confirmedBy`, `@@index([tenantId, startedAt])`, `@@index([sourceId])`.

A near-copy of `SyncRun` by design, plus `personsAbsent` (which the guard
measures and the run page shows) and `confirmedBy` (an override nobody can find
later is not a control).

### `PersonImportChange`

`id`, `tenantId`, `runId`, `changeType`, `recordType`, `targetId`,
`externalId`, `before` Json, `after` Json, `status`, `message`.

`changeType` is one of `create_person`, `update_person`, `depart_person`,
`reactivate_person`, `create_contract`, `update_contract`, `end_contract`.
There is no delete of either kind and no type that could become one.

`status` is `proposed | applied | skipped | failed`.

Indexed `@@index([tenantId])`, `@@index([runId, changeType])` and
`@@index([runId, status])` — both of the last two, because `SyncChange`'s
comment records that the second was missing and every apply sequential-scanned
the run's changes.

### `Person.sourceId`

Nullable, `onDelete: Restrict`, mirroring `User.sourceId`.

`persons.ts:368` reasons that a Person needs no `sourceId` because "people
arrive by CSV import, which matches on `externalId` and updates in place, so a
later import overwrites an edit to a field the file carries — the import is the
authority, not a sync run, and it only runs when somebody uploads one." A
scheduled import breaks the last clause. A nightly run silently reverting a
hand edit at 02:00 is a different thing from an upload doing it while the
administrator watches.

So source-owned persons get the source-owned edit refusal that users, groups
and org units already have, and hand-made or CSV persons keep `sourceId: null`
and stay fully editable. `Restrict` for the reason `DirectorySource` records:
without the foreign key, deleting a source strands its persons permanently
unfed, and `SetNull` silently converts them into hand-managed rows that nothing
keeps current. `deletePersonSource` releases them the way `deleteSource`
releases users — deactivate, detach, with the counts compared inside the
deleting transaction so what is checked is what is about to change.

### `Contract.externalId`

Nullable, `@@unique([personId, externalId])`.

A contract is identified today only by `@@unique([personId, sequence])`, and
`sequence` is a Syntra-side ordinal rather than something an HR file carries.
Diffing on a positional ordinal means a person whose two contracts arrive in a
different order has both rewritten into each other. The HR system's own
employment id is the stable key; `sequence` remains the display ordering it
already is.

Where a file genuinely carries no contract id, the source falls back to
matching on `sequence`, and the mapping screen says so with the consequence
named. A silent fallback here is a silent data-corruption path.

### `Person.statusReason`

Nullable, mirroring `User.statusReason`.

Needed because absence deactivates, and because **an absence-derived departure
must not write `departureOverride`.** That field's own comment defines it as an
administrative departure — "a human deactivated this person's account… somebody
who clicked Deactivate knows something the contract table does not — the
resignation nobody has keyed yet, the compromised account, the person walked
out this morning" — and `departureDate()` prefers it over contract dates for
exactly that reason. An import knows nothing of the kind. It knows a row was
missing. Writing `departureOverride` from a feed would let a truncated export
outrank the contract table permanently, and since reactivation clears the
override, the damage outlives the bad run.

An import writes `status` and `statusReason`. The contract table stays the
authority on dates.

## The run

Read, diff, guard, preview, apply — the shape `sync/run-service.ts`
established.

**The read completes before the diff begins.** The connector streams, and the
run buffers the whole snapshot before diffing anything. A diff computed against
a partially-read file is a diff in which every unread person is absent, and
absence departs people. The `maxBytes`/`maxRows` ceilings refuse rather than
truncate for this reason: there is no code path that produces a short read and
calls it a read. Network I/O happens outside the transaction, per Global
Constraint 1.

**Correlation** is on `Person.externalId` within the tenant, which is already
`@@unique([tenantId, externalId])`. A record whose `externalId` is empty or
missing is a mapping failure, not a new person.

**`isPrimary`** is taken from the file if mapped; otherwise derived as the
earliest-starting currently-active contract, with ties broken by `externalId`
so two runs over the same file cannot disagree. Never left to insertion order.

**`managerExternalId`** resolves to a `Person` in the same tenant. An
unresolvable manager is recorded on the change and leaves the field null; it is
not a mapping failure, because a manager who has not been imported yet is
ordinary on a first run and is fixed by the next one.

## Absence

The most dangerous rule in this document.

**A source declares `snapshot` or `delta`, and there is no default.** A full
snapshot means absence is evidence of departure. A delta — "changes since
yesterday" — means absence is evidence of nothing at all, and reading one as
the other offboards the entire workforce on the first quiet night. The field is
required, the console forces the choice with both consequences stated, and no
migration invents a value for it.

**In `delta` mode the diff cannot produce `depart_person`.** Not suppressed
downstream, not filtered by the guard: never produced. A safety property
enforced by a filter is one that a later refactor of the filter removes.

**In `snapshot` mode, `depart_person` is proposed only for a person who**:

- is owned by this source (`sourceId` matches — never a hand-made, CSV, or
  other-source person), and
- is currently active, and
- whose `externalId` did not appear in a **complete** read, and
- was not returned with `readFailure`, and did not fail field mapping.

A record the connector returned with `readFailure`, or one that could not be
mapped, is **counted in `recordsRead` and excluded from the diff entirely** —
neither updated nor departed. This mirrors `SourceRecord.readFailure` and
`SyncRun.mappingFailures`, whose comment states the rule plainly: such records
"are deliberately NOT treated as absent, so a schema change at the source
cannot propose deactivating real people." A column rename at the HR vendor must
not read as a redundancy.

## The guard

Two guards. Both must pass. They measure different things, and a run can pass
one and fail the other.

### The share guard

`provision-sources/guard.ts`, an analogue of `sync/guard.ts` with two
populations rather than three:

| change type | denominator |
|---|---|
| `depart_person` | active persons owned by this source |
| `end_contract` | active contracts owned by this source |

Two denominators, not one, for the reason `sync/guard.ts` records: a wrong
mapping that ends every contract would otherwise sail under a threshold
measured against the person count.

`recordsRead === 0` blocks outright with `requiresConfirmation: false`. An
empty file and an unreachable server are indistinguishable and the safe reading
is the second; there is nothing a human could usefully confirm about it.

An over-threshold run blocks with `requiresConfirmation: true`, because a
genuine cohort departure — a closed site, a contractor batch — has to be
processable through the pipeline rather than by hand.

### The population-drop guard

`populationDropRefusal` from `identity/population-drop.ts`, called with
`subject: 'import'`. This is the function that has been sitting there since
Provision with no caller feeding it an HR run; it was written for this.

It measures the tenant-wide count of people holding an active contract, before
and after, which is the number Provision's leaver path and Automate's expiry
sweep are both downstream of. The share guard asks whether this run is doing
something disproportionate to what this source owns; the drop guard asks
whether the person register is about to collapse. A tenant with two HR sources
can pass the first and fail the second, and that is the case worth catching.

Its refusal is a complete sentence and is stored and displayed verbatim, per
its own comment: "a refusal that carries its own sentence is one the caller
cannot paraphrase into something less specific."

### What a block means

A blocked run never applies on a schedule, whatever `autoApply` says.
`sync/guard.ts` states why: an unattended schedule is exactly when nobody is
watching. Confirmation is a human act, recorded in `confirmedBy` and in the
audit log.

## Apply

Ordered:

1. `create_person`
2. `create_contract`, `update_contract`
3. `update_person`, `reactivate_person`
4. `end_contract`
5. `depart_person`

Departure last, so a person is never briefly departed while a contract that
would have kept them active is still pending. A partial apply that stops
halfway leaves a state the next run converges from, never one it compounds.

`end_contract` writes an `endDate`. `depart_person` writes `status` and
`statusReason`, and never `departureOverride`.

Re-running the same file over the applied state produces an empty diff.

Per-change skip and partial apply work as `skipChange` and `applyRun` do
today. A skipped change reappears as proposed on the next run rather than being
remembered as a decision — the file is still saying it, and a skip is "not
now", not "never".

Every applied change writes an `AuditEvent`.

## Console

**Nav.** `AdminNav.tsx` records the rule that several removed links "existed
only to distinguish themselves from a neighbour". "Directory sources" beside
"People sources" is that failure re-introduced. `Connected systems` keeps two
links; `/admin/sources` is relabelled **Sources** and gains tabs:

- **Directory** — the existing `SourcesTab`
- **People** — person sources
- **Runs** — runs of both families in one list, with the source named and its
  family as a column

One Runs tab, not two: "what ran last night and what did it do" is one question
an administrator asks each morning, and splitting it means checking two places.
A run remains reachable from its source; it is still not a peer in the nav.

**Source editor.** The three-step shape `SourceDetailPage` has, with two
additions.

*Host key confirmation is part of the connection test, not a field.* Nobody has
a fingerprint to hand, and a field that can be typed into is a field the wrong
thing can be pasted into. `test` connects, refuses to proceed past an unknown
key, and shows the fingerprint it saw with one action to accept it. Accepting
writes an audit event carrying the fingerprint and the user. Re-testing against
a changed key offers no accept action: it reports a mismatch and stops.

*Snapshot or delta is a required choice with no preselection*, stated as
consequences rather than jargon — "This file lists everyone currently employed"
against "This file lists only what changed" — with the consequence shown once
chosen: people missing from the file are treated as leavers, or they are not.
The control explains itself; there is no paragraph explaining the control.

**Mapping editor works from a real sample.** `test` reads the first rows and
returns the actual column headers, so mapping is choosing from columns that
exist rather than typing names that might. Unmapped required fields block
saving. The `Contract.externalId` fallback is surfaced as a warning naming its
consequence.

**Run review** reuses the `SyncRunDetailPage` idiom — changes grouped by type,
per-change skip, partial apply, polling while running — with two differences:

- Departures are their own section, above the rest, showing the count against
  its denominator ("37 of 812 people this source owns"). That is the number the
  guard measured, and putting it where the confirming administrator reads it
  makes the confirmation informed rather than a click.
- A blocked run shows `blockedReason` verbatim.

**The manual CSV import stays** under `/admin/users`, and gains one rule: it
refuses a row whose `externalId` belongs to a person owned by a person source,
naming the source. Letting an upload overwrite fields a nightly feed reverts
tomorrow is worse than refusing.

**Permissions:** the existing `sync.read` and `sync.manage`. It is the same
capability — configure a system Syntra reads from, review what it proposes,
apply it.

## Testing

**Parser, with strings and no server:** quoted delimiters, embedded newlines
inside quotes, a UTF-8 BOM, CRLF, a trailing blank line, ragged rows, a
duplicate header, an empty file. The empty file must reach the run as
`recordsRead: 0`; the parser is not where that gets smoothed into "no changes".

**`FakePersonSource` in `@syntra/connectors/testing`**, reachable only through
the separate entry point, for the reason that file's header gives: "a fake
reachable from production code is a fake that will eventually be reached." It
yields a scripted sequence including records carrying `readFailure`, so the
whole run/diff/guard/apply path is testable with no transport.

**Table-driven diff and guard scenarios**, in the idiom of
`sync/scenarios.test.ts`. Each of these is a way this feature could offboard a
workforce:

- A `readFailure` record is counted in `recordsRead`, produces no change, and
  produces no `depart_person`.
- A mapping failure behaves identically.
- A `delta` source produces no `depart_person` for anyone, including where the
  diff would otherwise obviously propose one.
- `recordsRead === 0` blocks with `requiresConfirmation: false`.
- An over-threshold run blocks with `requiresConfirmation: true`.
- A blocked run under `autoApply: true` on a schedule applies nothing.
- A run that passes the share guard and trips `populationDropRefusal` — the
  two-source case.
- Re-running the identical file yields an empty diff.
- Apply ordering: a person whose contract ends and who also disappears is not
  left departed by a partial apply that stopped halfway.
- A skipped `depart_person` is proposed again on the next run.
- A hand-made person (`sourceId: null`) is never departed by any source.
- Two contracts arriving in reversed order are not rewritten into each other.

**One integration test against a real SFTP server**, gated as the Samba tests
are: a container in `infra/docker-compose.yml`, `sftp:up` and `sftp:wait`
scripts, skipped when absent so the default `pnpm test` stays hermetic. It
exists for what a fake cannot prove: a mismatched host key refuses the
connection. The same test covers the address check and the
connect-to-the-literal-address pin.

**One e2e spec**, `e2e/person-sources.spec.ts`, mirroring `sync.spec.ts`:
create a source, test, accept the host key, map from sampled headers, run,
review a diff with departures, confirm a guarded run, see it applied. E2E
covers the path a human takes once; the branching lives in unit tests.

Integration and e2e additions stay opt-in and serial. These suites are already
slow and produce phantom failures when run concurrently.

## Phase 2: duplicate detection and merging

Specified here so it can be built without reopening this design, and
deliberately not in the first slice.

**The problem.** The same human arrives twice: a rehire with a new employee
number, a person present in two HR systems, a contractor converted to staff.
`@@unique([tenantId, externalId])` guarantees two rows, not one person.

**Detection** proposes candidates; it never merges. Candidate pairs come from
an exact match on `businessEmail` or `personalEmail`, or a match on
`familyName` plus date of birth where the feed carries one. A candidate is a
row in a review queue with both records shown side by side.

**Merging** is a single deliberate act on a named pair, confirmed by a human —
the same shape as `deleteObject` in `SourceWriteback`, and for the same reason:
nothing here is computed in bulk, so the "no delete in the planner" invariant
is untouched. One `Person` is kept and one is superseded; the superseded row is
marked, never deleted, and keeps its id so audit history and any
`TargetAccount` or `AccountPlacement` pointing at it still resolves. Contracts
re-parent to the kept person. A merge is reversible by an unmerge that restores
the parentage, which is what makes confirming one a reasonable thing to ask of
an administrator.

**Both `externalId`s survive** on the kept person as a set of source-scoped
aliases, so the next run of either source correlates to the merged person
rather than re-creating the row it just absorbed. Without that, a merge is
undone nightly.

## Rollout on the lab

The lab runs tagged releases from `/opt/syntra`. This ships as a tagged release
like any other; the migration adds four tables and three nullable columns and
backfills nothing. Existing persons keep `sourceId: null` and stay exactly as
editable as they are today.

`feedMode` has no default, and no existing row needs one — there are no
`PersonSource` rows to migrate.
