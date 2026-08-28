# Org-unit-driven account placement

Status: approved design, not yet implemented
Branch: `worktree-orgunit-placement`, based on `47a8a39`

## Why

An administrator can create an organizational unit in Syntra today. It does
nothing to the directory. `OrgUnit` is an internal construct that feeds access
resolution — `resolve.ts` walks the tree to find assignments, `audience.ts`
targets catalog products by `user.orgUnit`, `approvers.ts` routes approvals up
it — and no code path has ever written one outward. `ObjectType` in
`packages/connectors/src/types.ts:1` includes `orgUnit`, but only inbound: the
LDAP connector's `orgUnitSearchBase` and `orgUnitFilter` read units in, and
`SourceWriteback` is three methods, none of which creates anything.

Where an account lands in the directory is decided somewhere else entirely, by
`AccountProfile.containerTemplate` — a string with `%person.*%`,
`%contract.*%` and `%baseDn%` substituted into it (`provision/templates.ts:145`).
There is no `%orgUnit%` scope and there never has been. So the tree an
administrator builds in Syntra and the tree accounts actually live in are
unrelated, and the only lever on placement is HR data.

That is a defensible design for a deployment where Active Directory is the
system of record. It is the wrong one for this deployment, where Syntra is the
front door: a person is created in Syntra and the AD account is created by
outbound provisioning. Here the administrator building the org tree is the
person who should be deciding where accounts go, and today they must instead
express that decision as a department string and hope the rendered DN matches
an OU somebody made by hand.

This spec makes Syntra the master of the org-unit tree. Creating an OrgUnit in
Syntra can create the container in the directory; assigning a person to an
OrgUnit places their account in it.

## What this is not

Three things are deliberately out of scope, and each is out for a reason that
should survive into the implementation rather than being re-litigated by
whoever reads this next.

**Renaming an OrgUnit does not rename the container.** A `modifyDN` on a
container moves every account beneath it in one operation. That is a mass
action wearing a rename's clothing: the characteristic accident is not one
wrong account, it is every account in the department, and the guard axes count
accounts rather than containers so it would pass unremarked. A rename changes
Syntra's label and leaves the DN alone.

**Reparenting is not supported.** Same reason, plus it makes the DN of every
descendant container stale at once.

**`deleteDirectoryOrgUnit` is untouched.** Deletion already exists on the
source-writeback path (`directory/directory-writeback.ts:425`), gated on
`writebackEnabled` + `writebackDelete`, refusing any unit that is not empty.
Creation lands in Provision instead, which leaves the lifecycle split across
two subsystems. That asymmetry is accepted knowingly: moving delete into
Provision is a breaking change to a shipped console button, and the reason
creation belongs in Provision — the guard, the previewed diff, the thresholds,
the retry classification — does not apply to a single deliberate deletion of a
container already proven empty.

## Ruling P9, narrowed

`connectors/src/types.ts:353` and `provision/run-service.ts:504` both cite
Ruling P9, and `reconcile.ts:284` enforces it:

> Silently creating organizational units in somebody else's domain is not a
> thing this product does.

The enforcement is severe on purpose. A desired container absent from the set
`listContainers` returned makes the person `container_missing`, which
`reconcile.ts:89` classifies at scope `all` — the whole person drops out of the
run, not merely their placement.

This spec does not repeal that. It narrows it:

> **Ruling P9 (revised).** Provision never creates a container *implicitly*. A
> container is created only where an administrator explicitly created an
> OrgUnit in Syntra and explicitly materialised it against a target. A
> container named by a rendered template and absent from the target remains
> `container_missing`, at scope `all`, unchanged.

The distinction is between an operator naming an object they want and a
rendering rule inventing a DN out of an HR field. The first is a decision with
a person behind it. The second is the mass-action shape the whole subsystem
exists to prevent: an inverted condition or a bad HR export would mint
containers across the domain at the same rate it mints accounts.

That narrowing is enforced **structurally, not by discipline**. A
`create_container` action can only be produced from a container backed by an
`OrgUnitContainer` row. Steps 3 and 4 of the placement ladder below render
strings and hold no row, so they cannot reach the code that emits one. This is
the same technique `renderContainer` uses against Ruling P22 — an optional
guard is a hole with a lid next to it, and the lid gets left off, so the hole
is closed instead.

## Data model

### `OrgUnitContainer`

Migration `20260921000000_org_unit_container`.

```prisma
/// The container one OrgUnit corresponds to on one target.
///
/// An OrgUnit is tenant-wide and target-agnostic; a container is a
/// distinguished name under a particular target's base. This row is the join,
/// and it is what lets a run compare what Syntra intends against what the
/// target holds. Without it the intent lives only in the shape of the tree,
/// and a container renamed or removed behind Syntra's back is undetectable.
model OrgUnitContainer {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  orgUnitId      String       @db.Uuid
  orgUnit        OrgUnit      @relation(fields: [orgUnitId], references: [id], onDelete: Cascade)
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)
  /// The DN Syntra intends. Validated once, here, on write — see "Escaping"
  /// below. Never re-rendered per run.
  dn             String
  /// The target's identifier, once the target has confirmed the object.
  /// Null while `state` is 'desired'.
  anchor         String?
  /// 'desired' | 'live' | 'adopted'
  ///
  /// 'desired' — Syntra intends this container; the target has not confirmed
  ///   it. The only state from which `create_container` may be emitted.
  /// 'live'    — Provision created it and holds its anchor.
  /// 'adopted' — it already existed at the target and Syntra bound to it.
  ///
  /// 'live' and 'adopted' behave identically at run time. They are
  /// distinguished because "we made this" and "this was already here" are
  /// different answers to the question somebody asks when a container turns
  /// up in a domain nobody expected it in.
  state          String       @default("desired")
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@unique([tenantId, orgUnitId, targetSystemId])
  @@unique([tenantId, targetSystemId, dn])
  @@index([tenantId])
}
```

Both unique constraints are load-bearing. The first says one OrgUnit
materialises at most once per target. The second stops two OrgUnits claiming
the same DN, which would otherwise let two departments' accounts converge into
one container with no error anywhere.

`onDelete: Cascade` from `OrgUnit` is safe because `deleteDirectoryOrgUnit`
already refuses any unit holding users or children. A unit that can be deleted
is empty, so the containers it named hold nothing Syntra placed.

The existing `OrgUnit.sourceId` / `sourceAnchor` columns are untouched. They
record where a unit was *ingested from*, which is a different fact from where
it is *materialised to*, and the two are populated by different pipelines
against different credentials. In this deployment they are even different bind
identities against the same DC.

### `Person.orgUnitId`

Migration `20260921000100_person_org_unit`.

```prisma
model Person {
  // ...
  orgUnitId String?  @db.Uuid
  orgUnit   OrgUnit? @relation("PersonOrgUnit", fields: [orgUnitId], references: [id])
}

model OrgUnit {
  // ...
  persons    Person[]           @relation("PersonOrgUnit")
  containers OrgUnitContainer[]
}
```

The relation is named because `OrgUnit` will then hold two relations to two
different models and Prisma disambiguates by name; `users` stays unnamed and
unchanged.

Added **alongside** `User.orgUnitId`, not replacing it. `User.orgUnitId` keeps
feeding `access/resolve.ts`, `automate/audience.ts` and `automate/approvers.ts`
exactly as it does today, so role scoping and catalog audience are unaffected
by this work.

The relation goes on `Person` rather than `User` because placement is a
property of a person, and in this deployment a provisioned person routinely
has no `User` at all — `User.passwordSource` supports only `local` and
`upstream`, so a person written to AD by Provision has no Syntra login until
somebody sets a password. Hanging placement off `User` would mean the feature
silently did not apply to most of the population it exists for.

It does not go on `Contract` either, though `%contract.department%` sets the
precedent. A person with two simultaneous contracts has two departments and
one account, so a contract-scoped OU needs a tiebreak rule, and every available
rule is arbitrary.

## The placement ladder

`DesiredStateInput` gains one field, required rather than optional, for the
reason `containerOverride`'s own docstring gives — *"required so no run can
forget to load it."*

```ts
/**
 * The DN of the container this person's OrgUnit is materialised at on THIS
 * target, or null when they have no OrgUnit, their OrgUnit is not
 * materialised here, or the row is not yet usable.
 *
 * Ranks BELOW `containerOverride` and ABOVE the template. A manual move is a
 * decision somebody recorded a reason for; an OU assignment is a rule. The
 * specific beats the general, which is also what stops the five-minute tick
 * dragging a moved account back to its department.
 */
orgUnitContainer: string | null;
```

Resolution in `desiredState` (`provision/desired.ts:593`), in order:

1. **`containerOverride`** — a manual Move. Absolute; ignores the fallback.
   Unchanged.
2. **`orgUnitContainer`** — the person's OrgUnit, resolved for this target.
   New.
3. **`renderContainer(profile.containerTemplate, context)`** — unchanged.
4. **`profile.fallbackContainer`** — unchanged.

A person with no OrgUnit produces `null` at step 2 and behaves bit-identically
to today. That is what makes this adoptable one person at a time against a
live target with `autoApply` on, rather than a cutover.

`provision/explain.ts:856` renders the container independently in order to
explain a decision, and must apply the same ladder. An explanation that
disagrees with the plan is worse than no explanation, because it is believed.

### Escaping

Steps 3 and 4 go through `renderContainer`, which escapes every substituted
value against RFC 4514 (Ruling P22). Step 2 does not, and must not: the DN is a
stored column, not a template, and there is nothing to interpolate.

The obligation moves to the write path. `OrgUnitContainer.dn` is validated once
when the row is created — parsed as a DN, rejected if malformed, rejected if it
is not a descendant of the target's `baseDn`. That last check is what keeps a
materialisation from pointing at `CN=Users` or another domain's subtree.
Validating on write rather than per run is the right trade because the value is
operator-supplied once and read thousands of times.

## `create_container`

### The action

`ProvisionActionType` gains `create_container`. `CONNECTOR_ACTION_TYPES` gains
it **first** — that list is documented as "the order enforcement applies them,"
and a container must exist before an account can be created in it or moved into
it.

`create_container` is not an account action. It carries no `personId`; it is
keyed on the `OrgUnitContainer` row. Code that assumes every action names a
person must be audited: `apply.ts` groups by person for concurrency, and the
per-entitlement guard axis counts holders.

### The connector method

`TargetConnector` gains a counterpart to `listContainers`:

```ts
/**
 * Creates one container at the target.
 *
 * Reached only from an `OrgUnitContainer` row in state 'desired' — see Ruling
 * P9 (revised). A connector implementing this must not create intermediate
 * parents: a missing parent is `not_found`, and inventing the tree above a
 * container is precisely the implicit creation P9 forbids.
 */
createContainer(config: C, input: { dn: string }): Promise<WriteResult>;
```

`WriteResult` already carries everything needed: `anchor` on success fills
`OrgUnitContainer.anchor`, and `WriteFailure` classifies the rest.

Two classifications need stating explicitly because they are not obvious:

- **`conflict`** — the DN already exists. This is **success by adoption**, not
  an error. The row moves to `adopted`, the anchor is read back, and the run
  continues. Two operators materialising the same unit, or a re-materialise
  after somebody made the OU by hand, both land here and both should heal.
- **`not_found`** — the parent does not exist. A genuine failure. The row stays
  `desired` and the run reports it. Retrying will not help, so this is not
  retryable (`isRetryable` already excludes it).

### The change to `reconcile.ts`

At `reconcile.ts:284`, before declaring `container_missing`: look up an
`OrgUnitContainer` row for this tenant, target and DN.

- Row exists in state `desired` → emit `create_container` and do **not** mark
  the person unprocessable.
- Row exists in state `live` or `adopted`, but the DN is absent from
  `listContainers` → **drift**, see below. The person is `container_missing`
  as today.
- No row → existing behaviour verbatim, including scope `all` at
  `reconcile.ts:89`.

Those three branches are the revised ruling in code, and the second and third
are what keep it honest.

## The guard

Every existing axis is a share: `createAccountThresholdPercent` and its
siblings are a percentage of an affected population (`guard.ts:139-183`).
Containers have no population to be a share of. Ten new containers against four
people is not 250 percent of anything; the denominator does not exist.

So this axis is an **absolute cap**, `TargetSystem.maxContainerCreatesPerRun`,
default `5`.

This deviates from the pattern deliberately, and the deviation must be
documented at the field and in `guard.ts`, or the next reader will "fix" it into
a percentage and produce a number with no meaning. The accident it prevents is
real and is not a share: a bulk OrgUnit import, or a script materialising a
whole tree, putting a hundred containers into a domain in one tick.

Exceeding the cap skips the run in the same way every other axis does, rather
than applying a partial set. Half a tree is a worse state than none of it.

## Drift

An `OrgUnitContainer` in state `live` or `adopted` whose DN is no longer
returned by `listContainers` is a **finding, never an auto-recreate**.

Somebody removed that container in the directory. Re-creating it on the next
five-minute tick is Syntra silently fighting a domain administrator, and it
would do so indefinitely and invisibly. The same applies to a DN that comes
back under a different anchor: that is a delete-and-recreate behind Syntra's
back, and the question of whether the new object is the same container is not
one a scheduler can answer.

Both surface through the existing `DriftFinding` model. Resolution is manual:
re-materialise (which adopts, if the DN is there again) or unmaterialise.

Materialising against a DN that already exists is the opposite case and needs
no ceremony — adopt it, record the anchor, set `state = 'adopted'`. This is how
units ingested from a directory source enter the model, and how a
re-materialise after a manual directory change heals.

## Write ordering

The `OrgUnitContainer` row is written **first**, in state `desired`; the
directory is written **second**.

This follows `moveAccount`'s precedent (`provision/placement-service.ts`) and
for the same reason. If the directory write fails, the intent stands and the
next run retries it through the guard, in a plan somebody reviews. The other
order loses the decision on a transient failure, and the operator's only
evidence they ever pressed the button is an error they have already dismissed.

## Console

Three touches, no new pages.

**`OrgUnitsPage.tsx`** — a per-unit "Materialise on target" control: choose a
target, see the DN that will be created, confirm. Creating an OrgUnit in Syntra
alone still writes nothing to any directory. The two steps stay separate
because "I made a department in Syntra" and "put a container in my domain" are
different decisions, and the second is the explicit act Ruling P9 (revised)
rests on. It must read as a directory write, not a checkbox.

**`PersonDetailPage.tsx`** — the OrgUnit assignment. The Move control on
`PersonAccessPage` is unchanged and still outranks it; its existing
reason-required flow becomes the documented way to record that one person is an
exception to their unit.

**`OnboardPersonPage.tsx`** — `previewContainerForFacts` gains the OrgUnit and
short-circuits at step 2. Without this the preview is wrong for exactly the
people this feature is for, on the one screen where placement is checked while
it is still free to correct. A preview that disagrees with the run is worse
than none.

## Testing

- **`desired.test.ts`** — one case per rung, plus the case that matters most:
  an OrgUnit assignment *and* an `AccountPlacement`, asserting the placement
  wins and the fallback is not consulted.
- **`reconcile.test.ts`** — the P9 fork, as two tests that differ in one row:
  a missing container backed by a `desired` row emits `create_container`; the
  identical missing container with no row is `container_missing` at scope
  `all`. These two are the ruling.
- **`guard.test.ts`** — the cap holds at its boundary, and a test asserting it
  is an absolute count and not a share.
- **`placement-service.test.ts`** — DN validation on write: malformed DN
  refused, a DN outside the target's `baseDn` refused.
- **`writeback.integration.test.ts`** — `createContainer` against the Samba
  domain controller already in `infra/docker-compose.yml`: success returning an
  anchor, `conflict` on an existing DN adopting cleanly, `not_found` on a
  missing parent.

## Rollout on the lab

The lab target (`ssander.local (AD)`) runs with `autoApply: true` and
`archiveAccountThresholdPercent: 2`. Moves deliberately share the archive axis
(`guard.ts:168`), and the tenant holds four people, so **one** account move is
25 percent and the first run will skip rather than apply.

That is the guard working correctly, but it will present as a mysterious
no-op. The rollout therefore is: preview first, raise the threshold
deliberately for the lab, then apply. Not: discover it during a run and lower a
safety limit under time pressure.

`containerTemplate` on that target is `%baseDn%` today, so every account
currently lands in `OU=Users,OU=Syntra,DC=ssander,DC=local`. The two existing
OrgUnits — `Company` and `Users`, both ingested — become `adopted` rows, which
means placement can be tested against a container that already exists before
`create_container` is ever exercised.
