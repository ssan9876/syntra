# Onboarding and directory deletion

Status: approved design, not yet implemented
Branch: `worktree-onboarding-and-deletion`, based on `f68b1b8`

## Why

Two API endpoints have no user interface at all:

- `POST /persons/:id/contracts` (`apps/api/src/routes/admin/persons.ts:189`) validates
  sequence collisions and enforces one primary contract per person. Nothing in the
  console calls it. `PersonDetailPage.tsx:67` renders a contracts table and an empty
  state with no control to fill it.
- `POST /persons/:id/link-user` (`persons.ts:248`) links an account to a person.
  Nothing calls it either. The Accounts panel's empty state reads "Link an account to
  give them access" and offers nothing that does.

The consequences explain every complaint on the original list. An administrator can
create a person, and can create a login, but cannot connect them or record what the
person actually does. So People and Users look like two lists of the same thing, and
contracts look like dead weight — because a contract has never been creatable by hand.

Contracts are not dead weight. They are the input the provisioning engine runs on:

- Business rules match on `contract.department`, `contract.jobTitle`,
  `contract.costCentre`, `contract.employer`, `contract.location`, `contract.fte`
  (`packages/core/src/provision/condition.ts:8`).
- Container templates substitute them into the DN an account is created at —
  `OU=%contract.department%,OU=Users,%baseDn%` (`provision/templates.ts:29`).
- `desiredState` derives from `activeOn(contracts, date)`. A person with no contract
  has no active engagement, so the planner proposes nothing for them.

This deployment treats Syntra as the front door: a person is created here and the
Active Directory account is created by outbound provisioning. That makes the chain

```
Person + Contract  ->  rules match on contract fields  ->  desired state
                   ->  provision run  ->  create_account in AD (DN built from the contract)
                   ->  AD directory source sync  ->  Syntra login appears
```

There is no `create_syntra_user` action — verified by grep; the planner can
`deactivate_syntra_user` and `reactivate_syntra_user` but never create one. So for an
ordinary member of staff the Users page is not part of onboarding at all.

## Scope

In: the onboarding flow, the two missing forms, the console's information
architecture around them, and administrator-initiated deletion of users and org units
that propagates to Active Directory.

Out: role management (in flight on `remediation-4-auth-api-console`),
administrator-sets-another-user's-password, and relocating explanatory prose into
documentation. These remain on the backlog.

## 1. Add someone

New route `/admin/people/new`, reached from a primary button on the People page.

One page, three fieldsets. Not a multi-step wizard: the whole point is to show an
administrator everything a new joiner needs in one view.

**Who they are** — `givenName`, `familyName`, `businessEmail`, `personalEmail`,
`externalId`.

**What they do** — `startDate` (required, defaults to today), `endDate`, `jobTitle`,
`department`, `costCentre`, `employer`, `location`, `fte`. `sequence` is fixed at 1 and
`isPrimary` at true; a person's first contract is their primary one by definition, and
offering the choice invites a first contract that is primary for nobody.

The `department` and `jobTitle` fields carry a live hint showing the distinguished name
they will produce, read from the target's container template. That hint is the only
place a typo becomes visible while it is still free to correct, which matters because
this deployment has chosen to apply without a confirmation step.

**Syntra sign-in** — a checkbox, default off, behind copy that says the Active Directory
account is created by provisioning and the login appears on the next directory sync.
Tick it only for an administrator, or for somebody with no directory presence.

### Submission

Sequential, because no transaction spans these endpoints:

```
POST /api/admin/persons                  -> personId
POST /api/admin/persons/:id/contracts    -> sequence 1, isPrimary true
  (if a login was requested)
POST /api/admin/users                    -> userId
POST /api/admin/persons/:id/link-user
  (then, for each enabled target)
POST /api/admin/targets/:id/runs         -> 202 + jobId
  poll the run, then apply scoped to this person
```

"Each enabled target" means every `TargetSystem` not disabled, which is the same set the
scheduler would have run anyway. A target that is disabled is deliberately excluded: a
new person should not be the thing that quietly reactivates a target somebody switched
off.

### Partial failure

A step that fails stops the sequence. What succeeded is kept, and the administrator
lands on the person's detail page with a banner naming exactly which steps completed and
which did not.

This needs no rollback machinery and no new endpoint, because section 3 gives the detail
page a form for every step that can fail. Every partial state is completable in place.
That is the reason section 3 is not optional polish.

## 2. Provisioning on create

The deployment has chosen fully automatic application with no confirmation step.

A provision run is whole-target and asynchronous: `POST /targets/:id/runs` enqueues a
background job that reads the entire target, and a separate `apply` commits it. Applying
such a run wholesale would also commit every other pending action in that target,
including disables and archives for other people that nobody has reviewed. That is a far
larger blast radius than the one person just created.

`applyRunRequestSchema` accepts `only: string[]` — action ids
(`packages/contracts/src/provision.ts:329`). So the flow applies **only the actions whose
`personId` matches the person just created**, and everyone else's pending actions are
left untouched.

`confirm` stays at its default of `false`. A joiner's actions are additive
(`create_account`, `enable_account`, `grant_entitlement`) and the guards in
`provision/guard.ts` fire on destructive actions, so in practice nothing should be
withheld — and anything that does trip a guard surfaces for review rather than going
through silently.

While the run is in flight the person's detail page shows its progress, following the
polling pattern already established by `UpdatesPage.tsx`.

## 3. Person detail: the two missing forms

`PersonDetailPage.tsx` gains:

- **Add contract** — a `RecordPanel` posting to `POST /persons/:id/contracts`, replacing
  the inert "No contracts recorded" empty state. Defaults `sequence` to one past the
  highest existing, and offers `isPrimary` only when the person has no primary contract.
- **Link an existing account** — a picker of users with no `personId`, posting to
  `POST /persons/:id/link-user`, replacing the empty state that currently advises linking
  an account without providing any means to do so.

## 4. People and Users stay separate

The console keeps both pages. They are not duplicates: the split is what allows a person
with no login (a contractor recorded before their start date) and a person with two (an
administrator holding a separate privileged account). Merging the tables would cost both.

What changes is the relationship between them:

- People becomes the front door, carrying the primary **Add someone** action.
- The Users page description becomes: "Accounts that sign into Syntra. Most arrive
  automatically from a directory sync — create one here only for an administrator or
  somebody with no directory presence."

The original request was to combine the two pages. This design deliberately declines
that and fixes the relationship instead; the decision was taken explicitly rather than by
default.

## 5. Deletion

### The constraint

`packages/connectors/src/types.ts:43` states that the provisioning engine has no delete
of any kind and no action type that could become one, because the characteristic failure
of that subsystem is mass action — a misconfigured source, an inverted condition, an HR
export run against an empty staging database — and every action it can propose must be
one that four thousand instances of can be walked back. Disable satisfies that; delete
does not.

It is enforced in code as well as in the type. `ad/connector.ts:1045` rejects any
operation outside `CONNECTOR_ACTION_TYPES` before the bind, positioned there specifically
so that `delete_account` answers "this connector will not do that" rather than
`not_found`, which would read as "that object is already gone".

### The resolution

An administrator deleting one named object is not the failure that invariant guards
against. The invariant protects the **planner**; this request never goes through the
planner.

The codebase already has a path for exactly this shape of write: `SourceWriteback`
(`types.ts:230`) is a separate interface from the provisioning connector, carrying
`changePassword` and `setEnabled` — both administrator- or user-initiated, one object at
a time, deliberately outside the engine.

Deletion goes there. **`ProvisionActionType` is not modified.** The planner still cannot
propose a delete, and the invariant holds exactly as written.

### Changes

- `SourceWriteback` gains `deleteObject(config, { anchor, objectType })`, implemented in
  `packages/connectors/src/ldap/writeback.ts`.
- A per-source flag `writebackDelete`, mirroring the existing `writebackEnabled` and
  `writebackDisable` pair in `sync/source-service.ts` and the schema. Deletion is refused
  until it is switched on for that source.
- A permission `directory.delete`, distinct from `directory.write`, granted to the
  highest built-in role. Keeping it separate means the ability to edit the directory does
  not imply the ability to delete from it.
- `DELETE /api/admin/users/:id` — removes the Active Directory object through the
  writeback where a source owns the account, then the Syntra `User` row. The `Person`,
  their contracts, and every audit event survive, so "who held what last March" stays
  answerable. Audit action `user.delete`.

  **Order matters, and it fails closed.** The directory write happens first, and the
  Syntra row is deleted only if it succeeded. The reverse order has a specific failure:
  Syntra forgets an account that still exists in Active Directory, and the next sync run
  reads it as a new object and recreates it — the resurrection behaviour already observed
  when records were deleted out of a dependent system while the directory still held
  them. A failed directory write therefore leaves both sides untouched and reports why.

  An account with no `sourceId` is locally managed, so there is no directory object and
  no writeback call; the Syntra row is deleted directly.
- `DELETE /api/admin/org-units/:id` — refuses with 409 when the unit has child units or
  users, naming what is still inside. Otherwise deletes in Active Directory and in
  Syntra, in that order and failing closed for the same reason as above. This matches the
  directory's own semantics, where an OU with children cannot be removed without a
  recursive tree delete. Audit action `orgUnit.delete`.

  Emptiness is evaluated over **all** users and child units, not only active ones. A
  deactivated user still occupies the unit, and deleting the unit out from under it would
  orphan the row.
- Console: deletion is the secondary, destructively styled action; deactivate remains the
  default. The confirmation requires typing the login or unit name, following the reason
  prompt pattern `StatusToggle` already uses.

## 6. Testing

Test-driven, matching the conventions of the neighbouring suites. Vitest for routes and
domain code, React Testing Library for pages.

Cases that must exist:

- Org unit deletion refused while it holds users, and while it holds child units.
- User deletion leaves `Person`, contracts, and audit events intact.
- Writeback deletion refused when `writebackDelete` is off for that source.
- Deletion refused for a caller holding `directory.write` but not `directory.delete`.
- Scoped apply touches only the actions carrying the new person's `personId`.
- The onboarding sequence, interrupted at the contract step, leaves a person that the
  detail page can complete.

## 7. Coordination

Four sibling worktrees exist and two peer sessions are building in them. The console
pages, admin routes for persons, users and org units, the connector interfaces, the LDAP
writeback, `source-service.ts`, `schema.prisma`, and the directory and identity contract
schemas are touched by nobody else.

Four files collide with `remediation-4-auth-api-console`:

| File | Nature |
| --- | --- |
| `packages/db/src/migration-order.ts` | Both append to an ordered list. Unavoidable; order is load-bearing. |
| `packages/contracts/src/index.ts` | One added export each. |
| `packages/core/src/index.ts` | One added export each. |
| `permissions.ts`, `builtin-role-permissions.test.ts` | Adding `directory.delete` updates the built-in role assertions. |

Work therefore proceeds in collision order: connector, then routes, then console — none
of which are shared — and the four shared files last, rebased onto whatever has landed on
`main` by then.
