# Syntra Govern — Access Governance

**Date:** 2026-08-16
**Status:** Approved design
**Scope:** Sub-project 4 of the Syntra programme, both of its slices

---

## 1. Purpose

Provision decides what a person gets because of their contracts. Automate is how
somebody asks for what their contracts did not give them. **Govern is the half of
an identity platform that answers "who has access to what, why, and should they
still?"**

Those are the questions an auditor asks and a breach investigation starts from.
They are also the questions nobody in an organization can answer unaided, because
the answer is spread across an HR record, a domain controller, a SaaS tenant, a
directory group nested three levels deep, a ticket somebody raised in March, and
a change an administrator made by hand at four in the afternoon.

Everything before this document either *causes* access or *records* the access it
caused. Govern is the first subsystem whose whole job is to look at what exists,
say honestly what it can and cannot see, and put a named human in front of the
parts that need a decision.

This is what HelloID calls Access Governance. It is the smallest of the
sub-projects by mechanism and the largest by consequence, because its output is
the thing people sign their name to.

**The specific harm this module can cause is false assurance.** Provision can
disable four thousand accounts. Automate can grant access nobody approved. Govern
can do something quieter and worse: produce a report that looks complete, is not,
and is signed anyway. A recertification run against data nobody has refreshed in
six weeks is not governance — it is a signature on a document that says something
untrue, and it is worse than not running the campaign at all, because afterwards
nobody looks again for a year. Every decision below that seems fussy about
timestamps, coverage, and the word "revoked" is there for that reason.

### Success criteria — slice 1, Inventory

Done when a Syntra instance can:

1. Build a point-in-time snapshot of every holding it can see — Syntra group
   memberships, application assignments, administrative role assignments, target
   system accounts and entitlements, and Automate grants — attributed to persons
   across all of them.
2. State, for every holding, **how the person got it**: a business rule and the
   contract that satisfied it, a request and who approved it, a delegated
   administrator's act, a direct assignment, inheritance from a group or an
   organizational unit, a directory source, or nothing at all.
3. Record a holding it cannot explain as **unattributable**, by name, and put it
   at the top of a screen rather than at the bottom of a query.
4. Distinguish *does not hold* from *we do not know*, and never render the second
   as the first anywhere — screen, export, or total.
5. State for every source in a snapshot when it was last successfully read and
   how completely, and refuse to describe as current anything that is not.
6. Answer the four questions: who has access to this system; what does this
   person hold and how did they get each piece; what changed in the last quarter;
   who approved it.
7. Export a report and an evidence bundle that carry their own as-of time,
   coverage and limitations on their face.
8. Verify the hash-chained audit log incrementally, on a schedule, record the
   result, and raise an alert when the chain does not hold.
9. Propose an owner for an account that belongs to no person Syntra knows, and
   never link one without a human confirming it.

### Success criteria — slice 2, Campaigns and Duties

Done when a Syntra instance can:

10. Run a recertification campaign over a scope, resolve a reviewer per item, and
    refuse to start against stale or incompletely-read data.
11. Handle a reviewer who does nothing, certifies everything in one click, or
    leaves the organization mid-campaign, without ever certifying an item that no
    human decided.
12. Turn a revocation decision into a real removal through Provision or Automate
    — or, where it cannot, say so precisely, name what would have to change, and
    route it to somebody, rather than reporting it as revoked.
13. Guard a campaign's revocations the way every other bulk action in this
    platform is guarded, and refuse outright the conditions no confirmation can
    fix.
14. Express segregation-of-duties rules over business functions spanning several
    systems, detect existing violations, and warn at the point where new ones
    would be created.
15. Grant a time-bounded, approved, justified exception to an SoD rule, tell
    somebody before it lapses, and never strip access unattended when it does.
16. Build the decision graph across requests and time that Automate's design
    named as Govern's problem, and report the reciprocity patterns a single
    request cannot see.

---

## 2. Position in the programme

| Sub-project | Status | Relationship |
|---|---|---|
| **Core** | built | Persons, contracts, the directory, RBAC, the hash-chained audit log, the scheduler, notifications, `withTenant`. Govern is built on all of them and reads almost all of them. |
| **Directory Sync** | built | Owns `User`, `Group`, `GroupMembership` and `OrgUnit` rows carrying a `sourceId`. Govern reads them and writes none. |
| **Access** | partly built | Owns `Application` and `AppAssignment`. Govern reads them. |
| **Provision — Targets** | designed | **The inventory Govern is built on.** `TargetAccount`, `Entitlement`, `AccountEntitlement` with its origin and granting rule, and `DriftFinding`. Govern aggregates and does not duplicate. |
| **Provision — Sources** | planned, sibling document | Independent. Govern reads persons and contracts and does not care how they arrived. |
| **Automate — Requests** | designed | **The decision record Govern is built on.** `AccessRequest`, `ApprovalStep`, `ApprovalStepApprover`, `ApprovalDecision`, `AccessGrant`, and the `needsReview` flags. Sections 5 and 14. |
| **Automate — Tasks** | planned, sibling document | Independent of this document. |
| **Govern** | this document | Depends on Core, Access, Provision — Targets, and Automate — Requests. |
| **Agent** | planned | Not involved. Govern opens no connection to anything. |

Provision's section 12 named the seam explicitly: *"Provision converges what it
manages and inventories what it does not. It does not judge."* Automate's section
21 named the same one: *"Automate records and flags; Govern judges and
campaigns."* This document is the other side of both sentences, and it honours
them rather than renegotiating them.

### One document, two build slices

Provision and Automate each split into two documents because their halves are two
separate pipelines that meet at a table. Govern's halves are not that shape: the
campaign engine and the SoD engine are both **queries over one data model that
the inventory half defines**, and specifying that model twice — once as an output
and once as an input — would produce exactly the kind of duplicated, drifting
cross-reference this project's spec reviews keep finding.

So: **one design document, two build slices.** Each section below is marked with
the slice it lands in.

- **Slice 1 — Inventory.** Sections 5 to 10, 17, and section 16 apart from its
  three SoD finding kinds, which arrive with the rules that produce them.
  Snapshots, provenance,
  freshness, history, the reports, the evidence bundle, the audit integrity job,
  orphan attribution, the standing findings. **Read-only. It changes nobody's
  access, ever.**
- **Slice 2 — Campaigns and Duties.** Sections 11 to 15. Recertification,
  reviewers, revocation dispatch, SoD rules, violations, exceptions, and the
  decision graph.

**Each delivers working software alone**, in the sense the previous two
sub-projects established: shippable, demonstrable, and worth running in
production on its own.

Inventory alone is a complete access-review product. An organization that
installs it can, on day one, answer every question in its auditor's request list
with an exported artifact — who holds what, where it came from, what changed, who
approved it, and what we could not see. That is the content of most access
audits, and today it is assembled by hand from four exports and a spreadsheet. It
also produces the standing findings of section 16 — access held by people with no
contract, unattributable holdings, orphan accounts, sources nobody has read —
which is real, actionable output with no campaign machinery at all.

Campaigns alone, built on top, adds periodic attestation and duty separation. It
is a genuine second capability and it is also where every irreversible act in
this sub-project lives.

**Inventory is built first**, and unlike Provision — where the argument was that
the irreversible half should not wait behind a second import pipeline — the
argument here is the inverse, and it is stronger. **Every irreversible act in
Govern is downstream of a number the inventory produced.** A campaign built on an
inventory whose freshness semantics have not been proven in production is a
campaign that certifies stale data, and a certification is signed. The staleness
model, the three-valued state, the coverage register and the provenance chain
have to be built, wrong once, fixed, and running against real deployments
*before* anybody attests to anything on the strength of them.

The seam holds in both directions: nothing in slice 1 changes anybody's access,
and nothing in slice 2 reads a system slice 1 does not already read.

---

## 3. Platform constraints this design inherits

Not restated for completeness. Each shapes something below.

**Nothing irreversible happens unattended.** Directory Sync refuses a run that
would deactivate an implausible share of a source. Provision guards creates,
disables, archives and entitlement revocations on two axes. Automate guards its
expiry sweep the same way. **A recertification campaign that revokes in bulk is
exactly this shape of risk** — a manager clicking "revoke all" on 340 items at
5pm on the last day of a campaign is the characteristic accident of this
subsystem — and section 13 gives it the same treatment: computed, written down,
guarded on two axes, refused outright under conditions no confirmation can fix,
never auto-applied, and confirmed by a named human.

**No network or long-running I/O inside a Prisma interactive transaction.**
`withTenant` is `prisma.$transaction(fn)` under a 5000 ms default, and this has
shipped as a defect twice on this project — once with a directory read, once with
an SMTP send. Govern does no network I/O at all, which removes the classic form
of this bug and introduces its cousin: a snapshot build over a large tenant is
long-running *database* work, and the 5000 ms ceiling does not care that the
latency is local. Section 19 states the batching rule and section 23 makes it a
test.

**Every table is tenant-scoped under forced row-level security keyed on a GUC.**
Every new table below carries `tenantId` and a policy comparing it against
`app.current_tenant`. No table is protected by a `where` clause in application
code alone. This matters more here than anywhere: Govern's tables are a
denormalized copy of who can reach what, across every system, for a whole
organization. A cross-tenant read of the `Holding` table is the worst single
disclosure this platform could produce.

**Every privileged action records an audit event in the same transaction as the
action.** Govern's privileged actions are listed in section 21. Two are easy to
miss and are named there deliberately: exporting a report, which is a bulk read
of everybody's access, and lowering a threshold, which is functionally the same
act as confirming everything it would otherwise have caught.

**A silently dropped record is the defect class this project keeps
rediscovering.** Directory Sync computed absence from a mapping failure and
proposed deactivating the people it had failed to understand. Provision's answer
was `ProvisionException` — a table, by name, not a count. Automate's were
`SweepException` and the `blocked_no_approver` state.

Govern's equivalent is the most consequential of the three, because **an
unattributable entitlement is the single most interesting thing an access review
can find.** It is what a hand grant looks like, what a compromised
administrator's persistence looks like, and what a system nobody remembers
configuring looks like. The design therefore does not merely avoid dropping it:
`CoverageGap` rows and the `unattributable` provenance kind are first-class, they
are counted on the face of every report that could have contained them, and
sections 8 and 10 forbid any aggregation that folds either into a zero.

---

## 4. Decisions

Settled during brainstorming; the implementation plan does not reopen them.

| Decision | Choice | Reasoning |
|---|---|---|
| Slicing | Two build slices in one document, seam at the first act that changes access, Inventory first | Section 2. The halves share one data model; two documents would specify it twice and drift. |
| Where Govern reads from | Syntra's own database only. No connector, no credential, no socket. | Section 5. Provision and Directory Sync own every remote read. A second reader of a target is a second thing to authorise, a second thing to rate-limit, and a second opinion about what the target said. |
| Where Govern writes | Its own tables only. Every access change is dispatched to the subsystem that owns the write. | Section 5. Provision owns targets; Automate owns grants, application assignments and local group memberships; Directory Sync owns synced memberships. Govern owns none of them. |
| Live query or snapshot | Both, and a certification is **always** against a snapshot | Section 6. A signature attaches to a stated set of facts at a stated time, which a live query does not have. The same principle as Directory Sync's materialized `SyncChange` and Provision's `ProvisionAction`. |
| Holding state | Three-valued logic: `held`, `not_held`, `unknown`. Only `held` and `unknown` are rows; `not_held` is absence **within a region coverage says was read**. | Sections 6 and 8. Two-valued logic turns "we could not read the group" into "nobody is in the group", which is the false-assurance defect in its purest form. |
| Provenance | A **set** of attributions per holding, not a label | Section 7. Provision and Automate already union their reasons; a single-valued `origin` column would have to pick one, and would pick wrong exactly when it matters. |
| Unexplained holdings | `unattributable`: a first-class kind, counted on the face of every report | Section 3. |
| Coverage | Recorded per source per snapshot, and gaps are rows rather than a flag | Section 8. |
| Campaign against stale data | Refused at start, and refused again at execution if the snapshot has aged past its limit | Section 8. This is the whole harm this module can cause. |
| Reviewer who does nothing | Never auto-certifies and never auto-revokes. The campaign closes `incomplete` and publishes its coverage. | Section 12. "Approval by inattention is a privilege grant nobody made" — Automate's rule, restated for attestation, in both directions. |
| Rubber-stamping | Detected and disclosed, not prevented — except on high-risk items, where bulk is refused outright | Section 12. You cannot stop somebody clicking yes; you can make it visible, and you can carve out where it is most dangerous. |
| Reviewer who leaves | Items reassigned by re-resolving as of now; decisions already recorded stand | Section 12. Automate's rule for an approver who becomes invalid mid-request, applied to attestation. |
| What a revocation does | Routed by the holding's attribution set: three routes dispatch to an owning subsystem, four require a change elsewhere. **Only a removal that was confirmed and then observed is called "revoked".** | Section 13. A campaign report that says "revoked" about a birthright entitlement Provision will re-grant tonight is a lie with a signature on it. |
| SoD unit | Rules relate **business functions**, not raw entitlements | Section 14. A rule keyed on a group survives neither a rename nor a second group conferring the same power. |
| SoD prevention | At the request, at the approval, at fulfilment, and in the rule editor's preview. **Never by blocking a birthright grant.** | Section 14. Blocking provisioning punishes a person for a configuration error somebody else made, and freezes their access — the trap Provision built its exception model to avoid. |
| SoD exceptions | Approved through Automate's workflow engine; end date required and capped; compensating control required | Section 15. A perpetual exception is how an SoD programme dies quietly. |
| Lapsed exception | The violation reopens and everybody is told. **Nothing is revoked.** | Section 15. Platform rule: nothing irreversible unattended, and a lapse is a timer, not a decision. |
| Findings | One lifecycle, aggregating Provision's `DriftFinding` by reference rather than copying it | Section 16. Two tables of findings with two counts on two dashboards is how a finding gets closed in one place and stays open in the other. |
| Audit verification | Incremental against checkpoints, with full verification a separate, paged job | Section 17. The built `verifyChain` walks every event ever recorded and loads them all into memory at once. |
| What the audit log proves | Integrity of the record, not completeness of the world — and not proof against the operator without external anchoring | Section 17. Stated on the face of the evidence bundle, not only here. |
| Bulk certify | Allowed, bounded, labelled as bulk in the record, refused on high-risk items | Section 12. |
| Reviewing needs no permission | Review authority comes from resolution, as approval authority does in Automate | Section 21. A tenant-wide "may certify anything" permission is not a thing anybody should hold. |
| `govern.read` is scopeable | To an organizational unit, using Core's existing `RoleAssignment.scopeOrgUnitId` | Section 21. Reading Govern is reading everybody's access. |

---

## 5. What Govern writes, and what it does not

*Slice 1 establishes the rule; slice 2 is where it would be broken.*

Four subsystems write access; Govern is the fifth thing that looks at all of it
and writes none of it. The property that has held since Provision's section 4 —
one direction of flow, one writer per table — is the property Govern is most
likely to break, because a governance module has an obvious reason to reach for a
write on every screen it draws.

```
   HR record ──▶ Person + Contract ──┐
                                     ├──▶ desiredState ──▶ Provision ──▶ Target system
   Catalog ──▶ Request ──▶ AccessGrant ┘        ▲                             │
                                                │                             │
                       Access ◀── Syntra User/Group ◀── Directory Sync ◀───────┘
                                                │
                      ┌─────────────────────────┴─────────────────────────┐
                      │  Govern reads all of it, writes only its own      │
                      │  tables, and dispatches decisions back up the     │
                      │  arrows above. It has no arrow of its own.        │
                      └───────────────────────────────────────────────────┘
```

**Govern has no connector, no target-system credential, no vault entry it can
reach, and no socket it can open.** It reads PostgreSQL. That is a security
property worth more than the convenience it costs: the reporting surface — the
one an auditor, a manager and a team lead all touch — cannot be used to reach a
domain controller, because nothing in its dependency graph knows how. Section 23
makes it a structural test over the import graph rather than a promise.

It is also why **Govern is not a second reader.** Its freshness is bounded by
Provision's and Directory Sync's schedules, and section 8 is about displaying
that bound rather than hiding it. Where a screen offers **Refresh now**, it
enqueues the owning subsystem's existing job on the existing queue and says whose
job it enqueued. It does not read the target, and it does not hold the answer.

### The revocation dispatch table

A revocation decided in a recertification campaign has to reach a target system
the same way an expiry does. It does, and this is exactly how. Every campaign
decision of `revoke`, and every SoD remediation, resolves to precisely one of
these outcomes, chosen by **what the holding's attribution set contains**:

| Attribution of the holding | Outcome | Mechanism |
|---|---|---|
| An Automate `AccessGrant` — request or delegated admin — and nothing else | `revocation_dispatched` | Govern calls Automate's grant-revocation domain function with the deciding person and the campaign decision as the reason. The grant's term leaves `desiredState`; Provision plans and applies the revocation under its own guard, its own per-entitlement axis, its own retry and its own audit events. |
| A target holding whose attributions are all `discovered` or `manual`, or which is `unattributable` — nothing in desired state wants it | `revocation_dispatched` | Govern writes a **`RevocationOrder`**, a one-shot negative term consumed by Provision's plan stage. Below. |
| A Syntra `AppAssignment` or a **locally-managed** `GroupMembership` with an `AccessGrant` behind it | `revocation_dispatched` | The same Automate entry point. Automate owns both tables as fulfilment paths. |
| A Syntra `AppAssignment` or local `GroupMembership` with **no** grant behind it — assigned by an administrator in the console | `revocation_requires_change` | A `RemediationItem` naming the assignment, the console screen that owns it, and a named human. Govern does not write `AppAssignment`. |
| A `GroupMembership` on a group carrying a `sourceId` | `revocation_requires_change` | A `RemediationItem` naming the directory source and the distinguished name. The source rewrites that membership every run; a removal here would survive until the small hours and then come back, which is worse than refusing. |
| A live business-rule attribution — Provision would grant it again tonight | `revocation_requires_change` | A `RemediationItem` of kind `rule_change_required`, naming the rule, the contract that satisfied it, and the rule's owner. |
| A `RoleAssignment` carrying Syntra permissions | `revocation_requires_change` | A `RemediationItem` routed to a holder of `rbac.manage`. Core's RBAC surface is the only writer of that table, and an access-review module that could quietly remove administrators is a governance module with a privilege-escalation shape. |

**The last four are not revocations and no report calls them one.** Section 13
makes that a vocabulary rule rather than a convention.

### `RevocationOrder`, and why it does not violate Provision's remit rule

Provision's section 12 says a group no business rule mentions "is not Provision's
business and is never revoked, in either mode." A `RevocationOrder` names exactly
such a holding — that is its purpose, since a holding inside Provision's remit is
either desired, and must not be revoked, or already handled by `authoritative`
mode.

This is not a contradiction, and the distinction is worth stating precisely,
because it is the kind of seam a later reader will read as one.

**The remit restriction protects against Provision *inferring* a revocation.** It
exists because a provisioning engine that strips grants it did not make, on the
strength of its own reading of a target, gets switched off inside a week. A
revocation order is not an inference. It is a single dated instruction carrying a
named human, a campaign, a decision id and a comment; it is consumed once; and it
appears in Provision's plan attributed to that decision rather than to
reconciliation. It is subject to Provision's guard exactly as any other
revocation — including the per-entitlement axis, which is the one that catches a
campaign that decided to empty a group.

Three properties keep it from becoming a standing deny rule, which Provision
rejected for good reasons:

- **It is refused at creation** if the holding carries any live rule or grant
  attribution. If a rule wants it, the honest answer is to change the rule, and
  that is the remediation item, not the order.
- **It is one-shot.** Once applied it is terminal. It does not persist as a term
  that suppresses future grants, so "why does this person not have X" never has
  to be answered by simulating an order history.
- **It is cancelled rather than applied if the holding acquires an attribution
  before the order is planned** — somebody requested it legitimately in the
  meantime — and the campaign is told its decision was overtaken, by name.

### Changes to built and designed subsystems

Listed plainly rather than absorbed, as Automate listed its three.

**Provision — Targets:**

- The plan stage gains `revocationOrders` as an input, and `ProvisionAction`
  gains a nullable `revocationOrderId` so the outcome reflects back.
- Its business-rule impact preview gains an SoD column (section 14). That is a
  call into a pure function, not a dependency on a running Govern.
- Its guard gains one condition: a plan that would introduce a violation of an
  SoD rule of severity `critical` marks the run `requiresConfirmation`. It does
  not block, and it never makes a person unprocessable.

**Automate — Requests:**

- The eligibility re-check at each stage opening and again at fulfilment gains an
  SoD check; `sod_violation` joins the closed set of automatic refusal reasons
  beside `no_longer_eligible`, `subject_departed`, `subject_inactive`,
  `already_held` and `product_withdrawn`.
- The approval screen tells an approver that approving would create a violation,
  which rule it breaks, and against what the subject already holds.
- Nothing else. `ResourceOwner`, `NotificationOutbox` and `NotificationPreference`
  are **reused, not duplicated** — a second owner table is a second answer to
  "who owns this resource", and there is no version of that which ends well.

**Core:** the audit checkpoint and anchor tables of section 17, and paged
verification. `AuditEvent` itself is unchanged, which is the return on having
designed it as an append-only chain in the first slice.

### Where the code lives, and why the dependency does not invert

Govern is a domain module in `packages/core/src/govern/`, beside `rbac`, `audit`
and `identity`, and not a package of its own. That placement is what keeps the
two calls above from inverting the package graph: Provision's guard and its rule
editor call `sodImpact()` and `evaluateSodRules()`, which are **pure functions
over data** — rules, functions, holdings — with no database handle and no
dependency on a running Govern. `core` already depends on `db` and on nothing
else, and both callers live in `core` too, so no package boundary is crossed and
no earlier-built package acquires a dependency on a later-built one.

The rule stated plainly, because it is the one somebody will be tempted to
relax: **anything Provision or Automate calls into Govern for is a pure function
taking plain values.** If a future integration needs Govern to be *queried* by
one of them, that is a signal the seam is wrong, and it should be raised rather
than worked around — the same instruction Core's design gives about package
boundaries generally.

**Nothing else changes.** `Person`, `Contract`, `User`, `Group`,
`GroupMembership`, `AppAssignment`, `RoleAssignment`, `TargetAccount`,
`AccountEntitlement` and `AccessGrant` gain no Govern column. Govern's opinion
about a row never lives on that row.

---

## 6. Reconciliation: the access snapshot

*Slice 1.*

Provision reconciles **one target at a time**, against its own belief about what
it granted, and converges it. That is a different job from this one, and the
difference is worth naming precisely so the two are not built twice.

Govern reconciles **across systems, per person, and across time**. Its unit is
not "does this target agree with Provision" but "here is everything one human can
reach, from all of it, and here is how each piece got there and when we last
looked". Three classes of question fall out of that framing and out of no
single-target reconciler:

- The same human reaching two systems through two different accounts.
- A person with no active contract anywhere who still holds something —
  invisible to each subsystem individually, because each only knows its own
  remit, and each is behaving correctly within it.
- A holding that has been there for two years and that nothing in Syntra can
  explain.

### What a snapshot is

An `AccessSnapshot` is a point-in-time, materialized, immutable set of `Holding`
rows with their attributions, plus a coverage record. It is built by a scheduled
job, on demand, or automatically at the start of a campaign.

**A certification is always against a snapshot, never against a live query.**
This is the same rule as Directory Sync's materialized `SyncChange` and
Provision's materialized `ProvisionAction`, for the same reason: what was
reviewed has to be, literally, what was decided about. A reviewer who certified
Anna's finance folder access on Tuesday certified a specific holding with a
specific provenance observed at a specific time, and that has to still be
readable in a year.

Reports may run either way. A report over the current snapshot is the default and
is the one that can be exported as evidence. A **live** report — computed from
the underlying tables at the moment of the request — is offered explicitly,
labelled as live, and cannot be exported as evidence, because "live" has no as-of
time to put in the header and evidence with no as-of time is not evidence.

### What a holding is

One row per (subject, resource, system) that the subject can reach.

- **Subject** is a `Person` where one can be resolved, and an **unattributed
  account** otherwise. An orphan account's holdings are still holdings; they are
  simply held by somebody Syntra cannot name, which is the most interesting kind.
- **Resource** is one of a closed set of kinds, each of which an auditor asks
  about separately:

| Resource kind | Source of truth | Notes |
|---|---|---|
| `targetEntitlement` | Provision's `AccountEntitlement` + `Entitlement` | A group, licence or role in a target system. |
| `targetAccount` | Provision's `TargetAccount` | The account itself, which is access to the system even holding nothing. |
| `syntraGroup` | Core's `GroupMembership` | Both synced and locally managed; the distinction lives in the attribution. |
| `application` | Access's resolved application set | Resolved by the union `resolveApplicationIdsForUser` already computes: direct, by group, and by organizational unit chain. |
| `syntraRole` | Core's `RoleAssignment` | **Privileged by definition.** An access review that ignores who holds `tenant.manage` has missed the most powerful access in the product. |
| `syntraUser` | Core's `User` | The ability to sign in to Syntra at all, with its status. |

Each holding carries `state` (`held` or `unknown` — see below), `observedAt`,
`observedVia` (which run of which subsystem last confirmed it), `firstSeenAt`
across snapshots, and a `privileged` flag derived from the resource.

### Three-valued state, and why `not_held` is never a row

`held` and `unknown` are stored. `not_held` is the absence of a row — with one
critical qualification: **absence only means `not_held` where coverage says the
region was read.** Where it was not, the region is a `CoverageGap` and every
question about it answers `unknown`.

This is the single most important structural decision in slice 1, and it exists
because of a concrete, already-documented failure. Provision's section 6 records
that Active Directory returns `member` on a group above 1500 entries as
`member;range=0-1499`, that `ldapts` does not implement range retrieval, and that
the safe behaviour is to mark the entitlement `unreadable` rather than return a
truncated membership. A two-valued Govern would take that entitlement's 1500
readable members, find nothing for the other 2500, and print "1500 people hold
Domain Admins" under a heading that says the report is complete. Every number
downstream — the campaign's item count, the SoD violation count, the coverage
percentage — would be confidently wrong, and the report would be signed.

So: an `unreadable` entitlement produces a `CoverageGap` naming the entitlement,
the target, the reason, and the run that failed to read it. Its holder count is
not 1500 and is not zero; it is *unknown*, and the screen says so in those words.

### Correlating a holding to a human

Through the links the other subsystems already maintain, and through no new ones:

1. `TargetAccount.personId` — Provision's claim, established by anchor.
2. `User.personId` — Core's account-to-person link. Nullable, and one person may
   hold several `User` rows, which is the relation the Core design described
   under the name `PersonUserLink`; the built schema carries it as a column on
   `User` rather than as a join table, and this document follows the built
   schema.
3. `AccessGrant.subjectPersonId` — Automate's, which is a person by construction.

Where none of them resolves, the holding belongs to an **unattributed account**
and is counted as one. Govern's cross-system view is exactly as good as those
links and no better, which is why:

- Every person-scoped report carries, in its footer, the tenant's count of
  unattributed accounts in scope. Nobody may read a per-person report as complete
  while accounts belonging to nobody are in the same systems.
- Orphan attribution (section 16) is in slice 1 rather than deferred, because
  until an orphan is resolved it is outside every person-scoped review and
  outside every SoD check.

### Aggregation, not duplication

Provision already writes `DriftFinding` rows for orphan accounts, unmanaged
entitlements, missing grants and accounts missing at the target. Govern **does
not copy them.** A `GovernFinding` of the corresponding kind references the
`DriftFinding` by id, and closing it in either place closes it in both, because
there is only one row underneath. Two finding tables with two counts on two
dashboards is how a problem gets fixed in one and stays open in the other, and
then how somebody stops trusting both numbers.

---

## 7. Provenance: how somebody got each piece

*Slice 1.*

This is the hard question in the brief and it is the hard question in practice.
"Anna holds Finance-Payments" is a fact any export can produce. "Anna holds
Finance-Payments because the business rule *Finance staff* matched her 0.4 FTE
teaching contract, **and** because she requested it in March and Jan approved it
until 30 June" is the answer somebody can act on, and it is only available if
somebody recorded the reason at the time.

Fortunately, two subsystems already did. Provision's `attribution` map records
the rule and the contract at evaluation time, explicitly because "why does this
person hold this?" is unanswerable after the fact. Automate extended the same map
with the request and the grant. Govern's job is to assemble those, add the ones
neither of them sees, and be honest about the rest.

### Provenance is a set

**A holding carries every attribution that explains it, not one.** Provision
unions across concurrent contracts; Automate unions rules with grants; a person
can reach an application by three paths at once. A single `origin` column would
have to choose, and it would choose wrong exactly in the cases that matter — the
researcher with two contracts, the person whose requested access is also now
birthright, the group membership that arrives both by rule and by hand.

The consequence is load-bearing for section 13: **a revoke decision on a holding
with three attributions removes at most the ones Govern can dispatch**, and the
report has to say which, rather than reporting a removal that will be undone
tonight.

### The attribution kinds

| Kind | Carries | Where it comes from |
|---|---|---|
| `business_rule` | rule id, rule name, contract id, the contract's department and job title as at observation | Provision's `AccountEntitlement.grantedByRuleId` and its evaluation-time attribution. |
| `request` | request id, product, requester, subject, every approver and their decision, `endsAt` | Automate's `AccessGrant` + `AccessRequest` + `ApprovalDecision`. |
| `delegated_admin` | grant id, the acting delegate, the delegation and its capabilities | Automate's `AccessGrant.origin = 'delegated_admin'`. |
| `auto_granted` | request id, product, and the fact that **no human decided** | Automate's zero-stage workflow. Section 14 treats this as a class. |
| `direct_assignment` | the `AppAssignment` or `RoleAssignment` row, the administrator who created it if the audit log names one, its scope | Access and Core admin surfaces. |
| `group_inheritance` | the group, and the assignment that names it | An application assigned to a group the person's user belongs to. |
| `org_unit_inheritance` | the unit named, and the chain from the user's unit up to it | An application assigned to an organizational unit above the user's. This is the one nobody expects and the one that produces "I have no idea how they got that". |
| `directory_source` | the source, the anchor, the distinguished name | A `GroupMembership` on a group with a `sourceId`. The reason lies **outside Syntra**, and the attribution says so: it names where to go and ask. |
| `discovered` | the run that first saw it, the date | Provision's `AccountEntitlement.origin = 'discovered'` — present at the target, granted by nobody Syntra knows. **This is an unattributable holding with a discovery date**, and is counted as unattributable. |
| `manual` | the administrator, the date, the reason if recorded | Provision's `origin = 'manual'` — an administrator recorded in Syntra that this grant exists. Attributable, but only to a person, not to a policy. |
| `unattributable` | nothing | No attribution of any other kind could be resolved. Section 3. |

**The definition, exactly, because it is used as a filter in four places.** A
holding is `unattributable` when its attribution set is **empty**, or when its
only attributions are `discovered`. Both mean the same operational thing — the
access exists and nothing in Syntra caused it — and a filter that caught one but
not the other would leave the more common half out of the register it exists for.
`manual` does **not** make a holding unattributable: somebody in Syntra recorded
that the grant exists and who they are, which is a weaker record than a rule or a
request and is not nothing. `Holding.unattributable` is stored, computed once at
build, so that no screen has to re-derive it and get it half right.

`org_unit_inheritance` is worth one more sentence because it is the provenance
question the brief singles out and it is the one Syntra can answer better than
most products can. `resolveApplicationIdsForUser` already walks the unit chain
with a depth cap and a seen-set, and it already knows which unit produced the
match. Recording that unit — not merely "by org unit" but *which one*, and the
path from the user's own unit up to it — is the difference between an answer and
a shrug. It costs one array on the attribution row.

### Attribution as of when

An attribution is resolved **as at the snapshot's observation time**, and the
values it copies — the rule's name, the contract's department, the approver's
display name — are copied, not referenced. A rule renamed next month must not
silently rewrite last quarter's evidence, and an approver who leaves must still
have a name in the record of what they approved. This is the same reasoning that
made Automate materialize `ApprovalStepApprover` instead of re-resolving at read
time.

### The unattributable register

Every snapshot produces an `unattributable` count and a list. The list is:

- On the snapshot summary, above the totals rather than below them.
- On every report that could have contained one of its rows, in the header, as
  "N holdings in this scope have no recorded cause".
- A standing `GovernFinding` per holding, with the ordinary lifecycle of section
  16, so it can be assigned, explained and closed by a human — and so that
  closing it records *who said it was fine and why*.
- **Excluded from bulk certify** (section 12) and given a mandatory comment.

An unattributable holding is never quietly reclassified. If somebody explains it,
the explanation is a `manual` attribution recorded by a named person with a
reason, which is a different and honest thing from having found a cause.

---

## 8. Freshness, staleness, and false assurance

*Slice 1. This section is the reason Inventory is built first.*

Govern reads no system directly. Every fact it holds arrived through Directory
Sync's last run, Provision's last reconciliation, or Automate's own records —
which are the only ones that are current by construction, because Automate's
grants live in the same database.

That is not a weakness to be hidden behind a refresh button. It is a property to
be **displayed**, because the alternative is a report that looks the same whether
the domain controller was read an hour ago or in March.

### What is recorded

Per snapshot, per source in scope, a `SnapshotSource` row:

- `sourceKind` — `directorySource`, `targetSystem`, `syntraInternal`.
- `sourceId`, and the id of the last run that read it.
- `lastSuccessfulReadAt`, and `lastAttemptedReadAt` where they differ.
- `completeness` — `complete`, `partial`, or `unread`.
- `staleness` — derived: `fresh` if `lastSuccessfulReadAt` is within the source's
  `freshnessSlaHours`, `stale` otherwise.
- `gapCount` — the number of `CoverageGap` rows attributable to this source.

`syntraInternal` is always `fresh` and `complete`, and saying so explicitly is
better than leaving a blank that a reader interprets as an omission.

### `CoverageGap`

One row per region of the world Govern cannot describe. Kinds:

| Kind | Meaning | Example |
|---|---|---|
| `source_unread` | A source in scope has never been successfully read | A target configured last week whose first run has not been applied. |
| `source_stale` | Read, but longer ago than its SLA | The domain controller was last read nine days ago against a 24-hour SLA. |
| `resource_unreadable` | A specific resource could not be read completely | Provision's `unreadable` entitlement — the range-retrieval case. |
| `account_unreadable` | An account the connector saw but could not read in full | Provision's per-person unprocessable case, aggregated. |
| `subject_unresolvable` | An account that resolves to no person | An orphan; also a `GovernFinding`. |
| `person_unprocessable` | A person the upstream run excluded | Provision's `ProvisionException` rows, referenced. |

A `CoverageGap` is not a warning banner. It is a row with a subject, a scope and
a reason, it is counted on the face of every report whose scope intersects it,
and it is what makes a question over that scope answer `unknown` rather than a
number.

### The rules that follow

These are the rules the whole section exists to state.

**There are two clocks and they are not the same clock.** `freshnessSlaHours` is
per source and measures *how long ago the world was read*. `maxSnapshotAgeDays`
is per tenant and measures *how long ago Govern assembled the picture*. A
snapshot built five minutes ago from a target read three weeks ago fails the
first and passes the second; a snapshot built five weeks ago from sources that
were all fresh at the time fails the second and passes the first. Both are
checked, separately, at both of the moments below, and a refusal always names
which clock it was.

1. **A campaign cannot be started when any source that its own scope depends on
   is `stale` or `unread`** — the sources contributing holdings the campaign's
   items would be drawn from, not every source in the tenant. Refused, with the
   source named, the age given,
   and a **Refresh now** action that enqueues that subsystem's job. Not a warning
   the campaign owner can dismiss — a refusal. Somebody about to ask 200 managers
   to attest to something has to be attesting to something true.

2. **A campaign cannot be executed against a snapshot older than
   `maxSnapshotAgeDays`** (default 30). It must be re-based onto a fresh
   snapshot, and re-basing **re-opens only the items whose holding actually
   changed** — a certification of a holding that has since changed is not a
   certification of the current holding, and a certification of one that has not
   is still good. Re-basing is recorded on the campaign, with counts.

3. **A report over a stale or partial scope renders the affected figures as
   `unknown`, with the age, and never as zero.** No aggregation path exists that
   collapses `unknown` into `not_held`. Section 23 makes this a property test
   over the aggregation functions rather than a review comment.

4. **Every report and every export carries a header** stating: the snapshot id,
   its as-of time, each source in scope with its last successful read and
   completeness, the count of coverage gaps, and the count of unattributable
   holdings. The report DTO has no constructor that omits it. A number without
   this header is not a number this product produces.

5. **A campaign item over a holding whose source went stale mid-campaign** is
   marked, and its reviewer is told before they decide, on the item. Deciding is
   still allowed — the reviewer may well know the answer — but the decision
   records that it was made against data of that age, and the evidence bundle
   carries the same.

### What "as of" actually means

One more honest distinction, because two timestamps get conflated everywhere in
this product category and the difference is the whole thing:

- **The snapshot's time** is when Govern assembled the picture.
- **The holding's `observedAt`** is when the system that read it last confirmed
  it was true.

They can be days apart, and the second is the one that matters. A snapshot built
at 09:00 this morning from a target read on the 3rd is a snapshot with an as-of
of 09:00 today and a holding truth-time of the 3rd, and the report shows both.
Showing only the first is precisely the false assurance this module can cause,
and it is the default behaviour of every hand-built access report this product
replaces.

---

## 9. History, and "what changed in the last quarter"

*Slice 1.*

The change question needs an event stream, and there are two candidate sources
for one. Neither is sufficient alone, which is the whole design here.

**The audit log** is authoritative, hash-chained, and records actions: a grant
applied, a revocation applied, an assignment created, a role assigned. It is
excellent evidence for everything Syntra did. It says nothing at all about
anything Syntra did not do — a hand grant at a domain controller produces no
Syntra audit event, because Syntra was not involved.

**Snapshot diffing** sees everything, including the hand grant, because the hand
grant is a difference between Tuesday's picture and Wednesday's. It is a sampled
observation, and sampling has a known and statable limitation.

So: **`HoldingEvent` rows are produced by diffing consecutive snapshots, and
cross-referenced to the audit events that caused them where one exists.**

```
HoldingEvent {
  fromSnapshotId, toSnapshotId
  subject (person or unattributed account)
  resource
  change        gained | lost | attribution_changed | became_unknown | became_known
  attributions  the attribution set before and after
  auditEventSequence?   the audit event that explains it, where one exists
  explained     boolean
}
```

`explained = false` on a `gained` event is one of the most valuable rows this
system produces: **access appeared, and Syntra did not cause it.** It is a
standing finding kind.

### The limitation, stated rather than hidden

**A change that happened and reversed entirely between two snapshots is
invisible to the diff.** Somebody added to a group at 09:00 and removed at 16:00,
with nightly snapshots, leaves no `HoldingEvent`. If the act went through Syntra,
the audit log has it and the change report includes it from that side. If it did
not, it is gone.

Three consequences, all stated on the change report itself:

- The report's header names the snapshot cadence over the period and the number
  of snapshots it is built from. "What changed in Q2, from 91 daily snapshots" is
  a defensible sentence; "what changed in Q2" is not.
- Snapshot cadence is therefore a governance setting with a stated consequence,
  not a performance tuning knob, and changing it is an audited privileged action.
- The change report has two panes that are never merged: **observed changes**
  from the diff, and **recorded actions** from the audit log over the same
  period. Where they agree, the row is joined. Where the audit log has an action
  with no observed change, that is a finding too — usually a write that reported
  success and did not land, which is exactly what Provision's convergence case
  exists for.

### Point-in-time queries

"What did Anna hold on 14 March" answers from the snapshot in force on 14 March,
with that snapshot's coverage, and says which snapshot it used. If no snapshot
covers that date, the answer is **"no snapshot covers 14 March"** — not the
nearest one silently, and not an empty set.

Retention: snapshots are retained per `snapshotRetentionDays` (default 400,
which covers a year plus the audit that follows it), except that **any snapshot
referenced by a campaign, an evidence bundle or an open finding is never pruned**
while that reference lives. Pruning a snapshot that a signed attestation points
at would destroy the evidence the attestation was about.

---

## 10. The reports

*Slice 1.*

Four canonical reports, because they are the four questions actually asked. Each
one is a query over a snapshot, each carries the section 8 header, and each can
be exported.

### Who has access to this system

Scope: a target system, an application, a group, or a Syntra role. Output: every
subject who holds anything in it, the resources they hold, each holding's
provenance summary, its `observedAt`, and when it was last certified and by whom.

Grouped, by default, into the four buckets a reviewer of this report actually
cares about, in this order: **unattributable**, **held by a person with no active
contract**, **held by an unattributed account**, then everything else. The
default sort of a governance report is not alphabetical.

### What does this person hold, and how did they get each piece

The provenance view. Extends the person detail screen Provision designed and
Automate extended, with three additions:

- **Every system**, not one target: their Syntra account and its status, their
  groups, their applications and the path each resolved by, their roles, and
  their accounts and entitlements in every target.
- **The full attribution set per holding**, not the first one.
- **The other accounts**, if the person holds several, and the holdings of each.

### What changed in the last quarter

Section 9. Two panes, a joined view, a stated cadence and a stated limitation.

### Who approved it

Reachable from any holding with a `request`, `delegated_admin` or `auto_granted`
attribution: the request, the form answers, the justification, every stage, the
resolved approver set with the `via` of each, every decision and comment, and the
notifications sent. All of it is Automate's data, unmodified; Govern's
contribution is that you can get to it from a holding rather than from a request
id you had to already know.

For a holding with no such attribution, this report says so plainly — "no
approval record exists for this holding" — with the attribution kind that does
apply. That sentence is not a failure of the report. For a birthright
entitlement it is the correct answer, and for an unattributable one it is the
finding.

### What the numbers mean

A short, blunt statement, and it appears on the exported artifact as well as
here, because the whole point is that somebody reading the export a year later
gets it too.

- **"Holds"** means: the system named as the source said so, at the time named as
  `observedAt`, and nothing has been observed since to contradict it.
- **"Does not hold"** means: the region was read completely at that time and this
  subject was not in it. It is never inferred from an unread or partial region.
- **"Unknown"** means what it says, and is never rendered as a zero, a dash, or
  an omission.
- **"Certified"** means: a named human recorded a keep decision against a stated
  set of facts at a stated time. **It does not mean the access is appropriate**,
  it does not mean the human read it, and it does not mean the facts were true at
  the target at the moment of the decision — only that they were true as of the
  observation times shown.
- **"Revoked"** means the removal was **applied at the system that holds it**,
  confirmed by that system, and observed by a subsequent read. A decision that
  was dispatched and not yet applied is `dispatched`. A decision that cannot be
  executed by Govern at all is `requires_change`. Section 13.
- **Percentages** always name their denominator inline. "94% certified" with an
  unstated denominator is the sentence that makes an audit go badly, because the
  denominator turns out to have been "of items that were assigned to a reviewer
  who was still employed".

### Export

Two formats, and a deliberate absence.

- **CSV**, one row per holding, with every header field repeated as leading
  columns on every row — because a CSV gets opened, filtered, and pasted into
  something else, and a header that lives only in row 1 does not survive that
  journey.
- **A signed JSON evidence bundle** — section 17.

**No PDF.** A rendered document is the format most likely to be circulated
detached from its own caveats and is the most work to keep honest across
themes, locales and page breaks. An organization that needs one prints the CSV
or the bundle's rendered view, and that is their choice to make visibly rather
than ours to make quietly.

Every export is a privileged, audited action recording the actor, the scope, the
row count and the snapshot. An export is a bulk read of everybody's access, and
the audit log should be able to answer who took a copy of it.

---

## 11. Access recertification campaigns

*Slice 2.*

The workflow is the easy part and it is not where this section spends its words.

### The shape

A `Campaign` carries:

- **Scope** — a declarative selection over resources and subjects, using the same
  closed condition interpreter Provision's business rules and Automate's audience
  conditions use, over the same closed field set. A tenant learns one expression
  language, and the campaign scope is diffable and testable like everything else
  written in it. Scope may name systems, resource kinds, a privileged-only
  filter, an organizational unit, or a condition over contracts.
- **`snapshotId`** — the frozen picture. Set at start; changed only by an
  explicit, recorded re-base (section 8).
- **`reviewerSelector`** and a required **`fallbackSelector`**, from Automate's
  closed selector set: `manager`, `managerChain(n)`, `resourceOwner`,
  `productOwner`, `role`, `group`, `person`. Reused, not reimplemented — an
  approval chain and a review chain disagreeing about who somebody's manager is
  would be a support call nobody can close, and Automate already resolved which
  contract supplies the manager.
- **Timing** — `opensAt`, `dueAt`, reminder cadence, and whether it recurs.
- **`allowBulkCertify`**, and the high-risk carve-outs of section 12. The cap
  itself is tenant-wide — `GovernSettings.bulkCertifyLimit` — so that a campaign
  cannot quietly raise it for itself.
- **`ownerPersonId`** — the human accountable for the campaign itself, who
  receives everything that gets stuck.

A `CampaignItem` is one holding under review, copied from the snapshot with its
provenance, its `observedAt`, its coverage status and its risk flags. Copied, not
referenced by id, for the same reason Automate snapshots a workflow: editing the
world afterwards must not change what somebody attested to.

### Item granularity

**One item per (subject, resource).** Not per subject, and not per resource.

Per-subject items — "confirm Anna's access" as one row — are what most products
ship and they are the mechanism by which rubber-stamping becomes the norm, since
the only available action is a single yes over 40 things. Per-resource items —
"confirm the 300 members of Finance-Payments" — put the decision with somebody
who knows the resource but not the people.

The console groups items by subject **and** by resource, and a reviewer works in
whichever grouping suits them; the decisions underneath are always per pair,
which is what makes a partial answer representable.

### Item statuses

| Status | Meaning |
|---|---|
| `pending` | Assigned to a reviewer, not decided. |
| `certified` | A named human recorded a keep decision. |
| `revoke_decided` | A named human recorded a revoke decision, not yet dispatched. |
| `revocation_dispatched` | Sent to the owning subsystem. Section 13. |
| `revocation_confirmed` | That subsystem reported it applied; no snapshot has observed it gone yet. |
| `revocation_applied` | Confirmed **and** observed gone. |
| `revocation_requires_change` | Cannot be executed by Govern. A remediation item exists. |
| `revocation_failed` | The owning subsystem reported a permanent failure. |
| `undecided` | **Terminal.** The campaign closed and nobody decided. Section 12. |
| `moot` | The holding stopped existing, or the subject departed, mid-campaign. |
| `blocked_no_reviewer` | Resolution and fallback both produced nobody valid. |

There is no status that means "certified because time ran out", and section 23
makes that a structural test over the state machine in the shape of Provision's
never-deletes test: **no transition into `certified` exists that is not caused by
a `CampaignDecision` row.**

### `moot`, which is not a bucket to hide things in

Two mid-campaign events make an item pointless, and each is verified rather than
assumed:

- **The holding no longer exists.** Verified against the *current* snapshot, not
  inferred from a revocation somebody else dispatched. The item records which
  snapshot showed it gone.
- **The subject departed.** Their contracts all ended; Provision's leaver ladder
  and Automate's lapse sweep now own the holding, and asking a manager to attest
  to the access of somebody who left is theatre. The item records the departure
  date and *does not* count as certified in any figure.

`moot` items appear in the campaign's coverage figure as their own line. They are
not certified, they are not undecided, and they are not hidden.

### `dueAt` is a real date, and extending it is an act

A campaign closes at `dueAt`. Extending it is allowed, is a privileged audited
action recording who extended it and by how long, notifies every reviewer with
open items, and is shown on the campaign report and in the evidence bundle with
the original date beside the new one. A due date that can be moved quietly is not
a due date, and "the campaign ran for six weeks" and "the campaign was extended
three times because nobody responded" are different facts about the same
organization.

---

## 12. Reviewers who do nothing, rubber-stamp, or leave

*Slice 2. The hard part of recertification, and the reason the workflow is not.*

### The reviewer who does nothing

**Silence never certifies and silence never revokes.**

The first half is Automate's rule — *approval by inattention is a privilege grant
nobody made* — restated for attestation. The second half is this platform's rule
about unattended irreversible action: auto-revoking on no response is the
"negative confirmation" feature every product in this category offers, and it is
a mass unattended revocation triggered by a manager being on holiday. Both are
refused, and refusing both is the position that makes the coverage figure the
honest headline.

What happens instead, in order:

1. **Reminders** to the reviewer at 50% and 100% of the time to `dueAt`, then
   daily. A campaign never stops asking.
2. **Escalation** to the reviewer's manager — `Contract.managerPersonId` on the
   reviewer's own resolved contract, by `resolveContractForMapping`, the same
   relation Automate's `manager` selector uses and not a second one — resolved by
   the same selector machinery, which **adds** a reviewer and never replaces one,
   and **tells the
   original reviewer they were escalated past.** Automate's rule, for Automate's
   reason: escalation that silently removes somebody's authority is how a person
   discovers months later that decisions attributed to them were not theirs.
3. **At `dueAt`**, undecided items become `undecided` — terminal — and the
   campaign closes `incomplete`.
4. **The campaign's headline number is coverage**, not completion. "1,840 items:
   1,602 certified, 91 revoked, 63 moot, 84 undecided — 95.4% covered" is the
   sentence the report leads with, and the 84 are listed by reviewer.

   **Coverage is defined once, arithmetically, because it is the number people
   will quote:** `coveragePercent = (decided + moot) / total`, where `decided` is
   every item carrying a `CampaignDecision` and `moot` is every item the world
   resolved without a human. In the example that is (1,602 + 91 + 63) / 1,840 =
   95.4%. `moot` is in the numerator because a holding that no longer exists is
   not an unanswered question; it is counted separately on the same line so that
   a campaign with 800 moot items — which would be a campaign somebody scoped
   against a picture the world had moved past — is visible rather than flattering.
   A campaign report never prints a percentage without the four counts beside it.
5. **A `RemediationItem` per undecided item**, routed to the campaign owner and
   the resource owner. Somebody has to decide, later, by hand; that is a worse
   outcome than deciding on time and a much better one than a machine deciding.
6. **Low coverage is itself a finding.** A campaign closing below
   `minimumCoveragePercent` (default 90) raises a `GovernFinding` naming the
   reviewers who did not respond. The point of a recertification programme is not
   the certifications; it is knowing which parts of the organization are not
   looking.

An `undecided` item is explicitly **not attested** in the evidence bundle. The
bundle says so, per item, in words.

### The reviewer who rubber-stamps

This cannot be prevented and the design does not pretend otherwise. Somebody
determined to click yes 400 times will click yes 400 times. What can be done is
to make it **visible**, and to remove the specific affordance that makes it
effortless on the items where it is most dangerous.

**Visible.** Every decision records:

- `decidedAt`, and `itemOpenedAt` — the server-side interval between the request
  that fetched the item's detail and the request that recorded the decision. Not
  a client-reported dwell time, which is worth nothing.
- `viaBulk` — whether it was part of a bulk action, and the size of that action.
- `sessionDecisionOrdinal` — the position of this decision within a run of
  consecutive decisions by this reviewer, and the elapsed time across that run.

From those, `ReviewQualitySignal` rows per reviewer per campaign: the share
certified, the median interval, the share decided in bulk, the largest single
burst, and the share of items whose detail was never fetched at all. The campaign
report has a **reviewer quality** section, and it is not hidden behind a toggle,
because a campaign in which one manager certified 340 items in ninety seconds is
a campaign whose result an auditor needs to see qualified.

None of these are violations and the screen does not call them violations. A
manager of a stable ten-person team who reads everything and certifies all of it
in four minutes is behaving correctly and will look identical to a rubber-stamper
on the aggregate. The signal is context for a human, and it is stated as such.

**Bounded.** Bulk certify is allowed, capped at `bulkCertifyLimit` (default 50
per action), recorded as bulk on every decision it produces, and **refused
outright on high-risk items**, which must be decided one at a time with a
mandatory comment:

- Any holding that is `unattributable` by the definition in section 7 — an empty
  attribution set, or `discovered` and nothing else.
- Any `privileged` resource — a Syntra role, or an entitlement a tenant has
  marked privileged.
- Any holding currently party to an open SoD violation.
- Any holding whose source is `stale` or whose coverage is `partial`.
- Any holding flagged `needsReview` by Automate — the mover case, where the
  person's contract attributes stopped matching the audience of the thing they
  hold. That flag exists precisely so a campaign can consume it, and it is
  exactly the item a bulk certify must not sweep up.

There is no bulk **revoke** at all. Revoking is one at a time, with a comment,
and the batch of section 13 is what makes the aggregate safe.

### The reviewer who is also the subject

The invariant, borrowed intact from Automate's section 9 and enforced the same
way — in the domain service, at the moment of decision, as a subtraction from the
resolved set so that every selector inherits it:

> **No person may record a decision on a campaign item whose subject is
> themselves.**

Every path Automate enumerated applies here and closes the same way: being your
own manager, a manager cycle, being the resource owner of a resource you hold,
being the sole member of a reviewing group, and deciding through the API rather
than the console. The one Automate path with no analogue is the on-behalf
submitter, because a campaign item has no submitter.

The one path that is *new* here is worth naming: **the resource owner who holds
the resource.** It is the ordinary case — the finance systems manager is in the
finance group — and dropping them from their own item while leaving them to
review the other 300 is correct and is what happens. Their own item falls to the
fallback selector, and if that is also them, the item is `blocked_no_reviewer`
and appears on the dashboard, which is the right outcome for a scope in which
somebody would be attesting to their own access.

### The reviewer who leaves mid-campaign

A reviewer is **valid** only if they hold an `active` Syntra `User` and their
`Person` holds at least one active contract. Automate's definition, reused.
Validity is checked at resolution and re-checked at the moment of each decision,
because deactivation revoking sessions covers most of it and "most of it" is not
a security control.

When a reviewer becomes invalid:

- **Decisions they already recorded stand.** They were valid when made, and the
  evidence bundle shows the reviewer's status as at the decision, not as at
  export. Retroactively invalidating a decision because the decider later left is
  how a campaign becomes unfinishable.
- **Their open items are reassigned** by re-resolving the item's selector as of
  now. The reassignment is recorded per item — `CampaignItemReviewer` rows with a
  `via` and an assignment window — so "who was this with, on the Tuesday it was
  sitting there" stays answerable a year later. This is the same reason Automate
  materializes its resolved approver set instead of recomputing it.
- **Both the outgoing and incoming reviewer are told**, where the outgoing one
  can still be reached.
- **If re-resolution yields nobody valid**, the campaign's `fallbackSelector` is
  used; if that also yields nobody, the item becomes `blocked_no_reviewer`,
  notifies the campaign owner and the holders of `govern.manage`, appears on the
  dashboard, and stays there. It never auto-decides and it never sits silently —
  `blocked_no_approver`'s twin, for the same reason.

The same reassignment happens when the *subject's* manager changes mid-campaign
and the selector was `manager`: the item is re-resolved and both parties told.

---

## 13. What a revocation decision actually does

*Slice 2. The other half of "Govern must not become a second writer".*

A reviewer clicking **revoke** has not revoked anything. What they have done is
record a decision. Section 5 gives the dispatch table; this section gives the
machinery around it, and the vocabulary that keeps the report honest.

### Revocation is a run

`revoke_decided` items do not dispatch as they are decided. They accumulate, and
at campaign close — or at an explicit **Execute revocations** action before it —
they are computed into a **`RevocationBatch`** with one `RevocationDispatch` row
per item, which is written down, guarded, and stopped.

This is the idiom Directory Sync established, Provision inherited and Automate
reused, and this is the place in Govern that has the shape the idiom exists for.
Three specifics:

- **Automate's single-grant hand-back path is deliberately not reused per item.**
  Automate exempts a hand-back from its sweep guard on the reasoning that "a
  guard exists to catch mass action, and this is a person giving one thing back".
  That reasoning is correct for a hand-back and false for a campaign, where a
  reviewer's 340 decisions arrive at once and are exactly mass action. Dispatching
  them one at a time through the ungated path would be a guard bypass built by
  accident out of two individually sound decisions.
- **The batch is where a reviewer's mistake is still cheap.** Between the
  decision and the batch there is a review screen showing every revocation
  grouped by resource and by person, with per-row skip, which is the last point
  at which "I meant to revoke Anna's, not the whole group" costs nothing.
- **Nothing auto-applies.** `autoApply` does not exist for a batch. Confirmation
  is per batch, explicit, and the confirming user is recorded.

### The guard

Two axes, the shape Provision arrived at after Directory Sync learned it the hard
way:

| Population | Denominator | Default threshold |
|---|---|---|
| Revocations in one batch | Holdings in the campaign's scope in the snapshot | 10% |
| Revocations of one resource | That resource's current holder count | 30% |

The per-resource axis is lower than Provision's 50% because a campaign is a
deliberate act with a human on the other end of the confirmation, and because
"this campaign is emptying Finance-Payments" is the single sentence most worth
interrupting somebody with. Either axis tripping marks the batch
`requiresConfirmation`, and the reason names the resource, the count and the
share.

Four conditions **block outright**, with no confirmation available:

- **The snapshot has aged past `maxSnapshotAgeDays`.** Section 8. There is
  nothing an administrator could usefully confirm about executing decisions made
  against a picture of the world from six weeks ago; the answer is to re-base and
  let the reviewers look at what changed.
- **A source in the batch's scope is now `stale` or `unread`.** Same reasoning:
  dispatching a revocation of a holding nobody has confirmed still exists is how
  a campaign revokes something that was already gone and reports it as its own
  work.
- **The person population collapsed.** More than `personPopulationDropPercent`
  (default 20, the same number and the same reasoning as Provision's and
  Automate's) fewer persons hold an active contract than at the last applied
  batch. A truncated HR import makes everybody look like a leaver, and a campaign
  running over that data revokes the organization.
- **The first batch in a tenant** always requires confirmation regardless of
  size, because every denominator is zero and no percentage can say anything
  about it. Provision found this hole in Directory Sync's guard; it is closed
  here at the start.

### Dispatch, and the vocabulary rule

Each `RevocationDispatch` resolves through section 5's table. Then:

- `revocation_dispatched` → the owning subsystem now has it. **The campaign does
  not say "revoked".** For a target holding this means an `AccessGrant`
  revocation or a `RevocationOrder`, and Provision's own guard may block, delay
  or supersede it. That is correct and it is not Govern's to override — but it
  means a dispatch is a request, not an outcome, and reporting it as an outcome
  is precisely the subtly-wrong report this module must not produce.
- `confirmed` → the owning subsystem reported the removal applied, and no
  snapshot has been built since. An honest intermediate state, and it exists
  because the alternative is a screen that has to choose between claiming
  something unverified and hiding a completed action.
- `revocation_applied` → confirmed **and** a subsequent snapshot no longer shows
  the holding. Two conditions, not one, because a write that reported success and
  did not land is a case Provision's convergence logic exists for and Govern
  should not be more credulous than Provision is. A dispatch that is `confirmed`
  but whose next snapshot still shows the holding does **not** advance: it raises
  a `dispatch_not_applied` finding naming both facts, which is one of the more
  valuable rows this subsystem produces.
- `revocation_failed` → a permanent failure from the owning subsystem, with that
  system's own message. The item, the reviewer, the campaign owner and
  `govern.manage` are told, and the holding stays in the inventory as held,
  because it is.
- `revocation_requires_change` → a `RemediationItem` with an owner, a due date,
  and a description of what would have to change. Chased to closure like any
  finding.

**A dispatch that has not been *confirmed* within `dispatchSlaHours` (default 72)
is a finding**, notified, on the dashboard. The clock measures to confirmation
rather than to observation, deliberately: observation waits on the next snapshot,
and an SLA that fired because a nightly job had not run yet would be an alert
that trains people to ignore alerts. The gap between confirmation and observation
has its own finding, above, on the snapshot cadence rather than on a timer. The
alternative to both is a campaign that
closes with 91 revocations, of which 34 never happened, and nobody notices for a
year — which is the same silent-drop failure this platform keeps rediscovering,
wearing the clothes of a completed audit.

### The case that makes the vocabulary necessary

Worth stating concretely, because it is common and because a naive product gets
it exactly wrong.

Anna holds `Finance-Payments`. Her attribution set contains a `business_rule`
attribution — Provision grants it to everyone in her department — and nothing
else. Her manager reviews it and decides revoke.

A naive product records "revoked", removes it at the target, and reports 100%
remediation. Provision's next run computes desired state from Anna's contracts,
finds the rule still matches, and grants it back. By the following morning Anna
holds it again, the campaign says it was revoked, and the report is a lie that
somebody signed.

What happens here: the item becomes `revocation_requires_change`. A
`RemediationItem` of kind `rule_change_required` is created naming the rule
*Finance staff*, the contract that satisfied it, and the rule's owner. The
campaign report shows it in its own column, and the campaign's totals never add
it to the revoked figure. The manager's screen says, in words, that this access
comes from Anna's job and that removing it means changing either the rule or the
job — which is true, is actionable, and is the sentence the manager needed.

---

## 14. Segregation of duties

*Slice 2.*

An SoD rule says two things must not be held by the same person: raise a payment
and approve it; create a supplier and pay one; write code and deploy it to
production; administer the identity platform and approve access in it.

### The unit of an SoD rule is a business function

**Rules relate `BusinessFunction`s, not entitlements.**

```
BusinessFunction {
  name            "Raise a payment"
  description
  resources[]     one or more (systemId, resourceKind, resourceId)
}

SodRule {
  name            "Payment raising and approval"
  functionA, functionB
  severity        low | medium | high | critical
  rationale       required free text — what the risk actually is
  exceptionWorkflowId
  enabled
}
```

A rule written directly over two Active Directory groups is wrong within a year
and wrong invisibly. A group gets renamed — Provision anchors on `objectGUID` so
the entitlement survives, but the rule's author wrote a name. A second group is
created that confers the same power, and the rule sees nothing. A second system
is introduced that does payments, and the rule sees nothing. The indirection
costs one table and one join, and it is what the mature products in this category
converge on for exactly these reasons.

The function is also the unit an organization can actually discuss. "Who can
raise a payment" is a question a finance director can answer; "who is in
`CN=FIN-AP-ENTRY,OU=Groups`" is not.

A function's resources are named by immutable identifier — Provision's rule about
`Entitlement.externalId` being the target's own object id, restated one level up.
A function whose resource has become `missing` or `unreadable` in its target
makes every rule that references it **unevaluable for the affected subjects**,
and that is reported as a `CoverageGap`, not silently evaluated as "does not
hold". This is the same rule Provision applies to a business rule naming a
missing entitlement, and for the same reason: quietly evaluating without it
produces a confident wrong answer in the dangerous direction.

### Detection

Over a snapshot, per **person** — not per account, and not per system.

A violation exists when one person holds at least one resource in function A and
at least one in function B. Cross-account and cross-system by construction, which
is the entire value: the classic real violation is somebody who raises payments
with their ordinary account and approves them with an administrative one, and no
single-system check has ever caught that.

Two consequences follow directly and both are worth stating:

- **An unattributed account cannot be SoD-checked**, because the check is per
  person and the account belongs to nobody. Every orphan is therefore a hole in
  the SoD picture as well as a finding in its own right, and the SoD dashboard
  carries the orphan count in its header for that reason.
- **A person with concurrent contracts may legitimately hold both sides.** Core
  models concurrent contracts deliberately, and the 0.6/0.4 researcher of
  Provision's section 7 is the same person who might genuinely raise a payment
  in one role and approve one in another. The `SodViolation` therefore records
  the contracts that produced each side, and the exception mechanism of section
  15 can reference them — an exception whose stated basis is "these are two
  separate engagements" is a real and reviewable justification, and it lapses
  when one of those contracts does.

A `SodViolation` records the rule, the person, **the specific holdings on each
side** — needed for remediation, since "you violate this rule" is not actionable
and "these three holdings put you on the A side" is — the severity, `firstSeenAt`,
`lastSeenAt`, and its status: `open`, `excepted`, `resolved`, or `unevaluable`.
A violation that persists across snapshots is updated rather than duplicated, so
the dashboard count is a count of problems and not a count of snapshots. Provision
made the same choice for `DriftFinding` and it is right for the same reason.

### Prevention

Prevention happens where a human is already deciding, and nowhere that would
freeze somebody's access.

**At the request (Automate).** The catalog shows a product that would create a
violation with a warning at submission, naming the rule and what the subject
already holds on the other side. It does not block submission — the requester may
have a legitimate case and the point of the workflow is that somebody accountable
hears it.

**At the approval (Automate).** The approver's screen states that approving
creates a violation of a named rule, of a named severity, against named existing
holdings. This is the highest-value integration in the section: it is the one
moment when an accountable human is looking at this specific grant with the
authority to refuse it, and telling them at that moment costs one query.

Approving anyway is allowed for severities below `critical` and **records an
acknowledgement that becomes a pending `SodException` request**, so the
acceptance is captured as a risk acceptance with an owner rather than lost as an
approval that happened to be unwise. For `critical`, approving requires an
existing or concurrently-approved exception; without one the request is refused
with reason `sod_violation`.

**If that pending exception is subsequently refused, nothing is revoked.** The
violation stays `open`, a `GovernFinding` records that access was granted and the
risk acceptance was then declined, and a `RemediationItem` goes to the rule owner
and the approver who allowed the grant. Auto-revoking on a refused exception
would make an exception decision an unattended access removal at one remove,
which is the platform rule in section 3 with an extra step in front of it.

**At fulfilment (Automate).** Re-checked, because Automate already re-checks
eligibility immediately before fulfilment and for the same reason: an approval
given on Monday must not fulfil on Friday into a world that changed. A violation
that appeared in between refuses fulfilment with `sod_violation`, tells the
requester, the subject and the approvers who already decided, and does not leave
a half-granted request in a quiet state.

**At the business rule editor (Provision).** The impact preview gains an SoD
column: "enabling this rule grants to 412 persons and would create 14 SoD
violations, 2 of them critical — show me who". This is prevention at the point
where the fault actually is. A birthright rule that creates a violation is a
configuration error made by a person with a console open, and that is who should
see it, at that moment, before it is saved.

**Never by blocking a birthright grant.** A person whose contract entitles them
to both sides is not doing anything wrong, and refusing to provision them means
they cannot do their job because of a rule somebody else wrote. That is the
unprocessable-person trap Provision built its whole exception model to avoid,
inverted: an empty desired state and a frozen person, produced by a governance
control. What happens instead is that Provision's guard marks a plan introducing
a `critical` violation `requiresConfirmation` — visible, before apply, to a human
who is already reviewing a plan — and the violation is detected, campaigned and
excepted through the ordinary path afterwards.

### The decision graph, and honouring Automate's handoff

Automate's section 9 enumerates every path to self-approval and closes each one,
then names the tenth honestly: **two-stage laundering** — the subject decides
stage 1 of somebody else's request, who decides stage 2 of theirs. Automate says
it does not attempt to detect this, that it needs a graph over decisions across
requests and time, that this is Govern's, and that what it owes Govern is the
record: every decision, with the deciding person, the subject, the submitter, the
selector that resolved them, whether they acted as a delegate or an escalation
target, and the time.

**The handoff works.** The record is sufficient, and this section builds on it.
Three qualifications, each of which is a real hole rather than a quibble, and
each of which Govern closes by looking somewhere else in Automate's own data.

The graph is directed, over persons, built from three edge kinds:

| Edge | From | To | Built from |
|---|---|---|---|
| `decided_for` | the decider | the request's subject | `ApprovalDecision.personId` → `AccessRequest.subjectPersonId`, with the `via` from `ApprovalStepApprover` and the selector from `ApprovalStep.stageSnapshot`. |
| `delegated_grant` | the acting delegate | the subject | `AccessGrant.origin = 'delegated_admin'` → the request's `requestedByUserId`, resolved to a person. |
| `auto_granted` | *nobody* | the subject | A zero-stage workflow. Recorded as an edge with no source. |

**Qualification one: delegated administration has no decision row.** Automate's
section 14 makes every delegated act an `AccessRequest` with no approval stages
and the acting person as the submitter. A graph built only from
`ApprovalDecision` therefore cannot see a pair of team leads who each granted the
other access to the resource they manage — which is the *same* laundering pattern
with less friction than the two-stage one, since it needs no requests at all.
The `delegated_grant` edge closes it, and it is only available because the
delegated act was modelled as a request rather than as a direct membership write.
That decision of Automate's pays here, exactly as its rationale predicted.

**Qualification two: an auto-granted product has no human decider at all.** A
zero-stage workflow is a legitimate configuration and Automate makes editing one
an audited privileged act, but the grant it produces has no approver, so it
contributes no edge. Govern treats `auto_granted` holdings as their own class —
counted, listed, and campaigned first, since access nobody decided is precisely
the access a recertification exists to have somebody decide. Where the audit log
records who last edited the product's workflow, the report names them; where it
does not, it says so.

**Qualification three: an actor with no linked person cannot be merged into the
graph.** `AccessRequest.requestedByUserId` is a `User`, and a `User` may have no
`Person` — a service account, by design. Such an actor is a node the graph cannot
merge with anybody, and it is **reported separately rather than dropped**. A
service account submitting requests on people's behalf is either an integration
worth knowing about or a problem worth knowing about, and either way silence is
the wrong answer.

### What the graph reports

Three patterns, none of which is a violation on its own and all of which say so
on the screen.

- **Reciprocity.** A and B each decided for the other, at least
  `minReciprocalDecisions` times (default 3) within `reciprocityWindowDays`
  (default 180). Reported with both counts, the requests, and the dates.
- **Cycles.** A decided for B, B for C, C for A, up to a depth cap. The same
  shape at one more remove, and the one a pairwise check misses.
- **SoD laundering.** The pattern that is actually a finding rather than a
  signal: A decided a request that granted B something on side A of an SoD rule,
  and B decided a request that granted A something on side B of the same rule.
  This is the two-stage laundering of Automate's section 9 made concrete, and it
  is detectable **only** with the SoD rules in hand, which is why it lands in
  slice 2 alongside them rather than in the inventory.

The first two are `GovernFinding`s of kind `approval_reciprocity`, and the screen
says plainly that in a small team mutual approval is normal and expected, and
that the finding is context for a human rather than an accusation. A four-person
department will trip reciprocity every quarter and should; a product that
presented that as a violation would train its users to close findings without
reading them, which costs more than the check is worth. The third is a finding of
kind `sod_laundering` at the rule's own severity, and it is not soft-pedalled.

Nothing in this section revokes anything, and nothing in it blocks a request. It
produces findings with named people in them, which is what a graph over decisions
can honestly do.

---

## 15. Exceptions to an SoD rule

*Slice 2.*

A rule with no exception mechanism produces a permanently red dashboard, because
somebody in the organization legitimately holds both sides — usually the person
who signs off the audit. A permanently red dashboard is one nobody reads, and an
SoD programme dies of that rather than of anything dramatic.

A `SodException` carries: the rule, the person, the specific holdings it covers,
a **required** business justification, a **required** compensating control, an
approver, `startsAt`, `endsAt`, and its status.

### Who may grant one

**Not the beneficiary, not their manager alone, and not by holding
`govern.manage`.**

An exception is a risk acceptance, and the person who accepts a risk should be
the person who carries it. So an exception is approved through **Automate's
workflow engine**, reusing the same stages, the same closed selector set, the
same quorum and delegation rules, and the same materialized approver set. Each
`SodRule` names its `exceptionWorkflowId`, so whoever writes the rule decides who
may accept its risk — the finance director for a payments rule, the security team
for an administrative one.

Two additional rules:

- **The self-approval invariant applies unchanged.** The beneficiary is dropped
  from the resolved approver set by every path, including the common one where
  they are the resource owner. Automate's subtraction, inherited by reusing
  Automate's resolver rather than writing a second one.
- **The fallback, where a rule names no workflow, is the holders of
  `govern.accept_risk`**, any one of whom may approve — a permission deliberately
  distinct from `govern.manage`. Administering the governance module and
  accepting the organization's risk are different jobs, and a product that
  conflates them hands risk acceptance to whoever configures the software. Where
  the beneficiary is themselves a holder, they are dropped, and where they are
  the only holder the exception is `blocked_no_approver` and says so.

### For how long

**An exception must carry an end date.** Null is not representable, capped at
`maxExceptionDays` (default 90). A perpetual exception is a decision nobody ever
re-makes, and after two years nobody remembers who made it or why. Renewal is a
**new** exception with a new decision, pre-filled with the old justification —
never auto-renewal, which is Automate's rule about renewal and is the same
argument: renewal unless somebody objects is approval by inattention wearing a
different hat.

The cap is a tenant setting because organizations differ, and it is a setting
with a stated consequence rather than a knob: raising it is a privileged, audited
act, and the exception report shows the distribution of exception lengths so that
a tenant which has quietly moved to 365 days can see that it has.

### What happens when it lapses

**The violation returns to `open`. Nothing is revoked.**

This follows directly from the platform rule that nothing irreversible happens
unattended. A lapse is a timer expiring, not a decision anybody made; treating it
as an instruction to strip access would mean an administrator's holiday becomes a
production outage in the finance system.

What actually happens:

1. **Warnings** at `exceptionWarningDays` (default `[14, 3]`) to the beneficiary,
   the approver and the rule owner, carrying a **Renew** action that opens a new
   exception request pre-filled.
2. **At lapse**, the exception becomes `lapsed`, the violation reopens at its
   original severity, and the same three parties are told.
3. **A lapsed exception ages the violation.** `GovernFinding` severity is raised
   one step for a violation whose exception lapsed without renewal, and the
   finding names the lapse. A violation somebody once formally accepted and then
   let quietly expire is a different and worse thing than one nobody has looked
   at yet.
4. **The violation is eligible for a targeted micro-campaign**, which is an
   ordinary `Campaign` whose scope is a condition over open violations of a named
   rule. No new mechanism — the scope language already expresses it.

An exception may also be **revoked early** by an approver or the rule owner, with
a reason, which is a recorded decision and produces the same reopening
immediately.

### Exceptions and the contract that justified them

Where an exception's stated basis is a pair of concurrent contracts (section 14),
it records those contract ids, and **it lapses automatically when either contract
ends**, ahead of its end date, with the same notifications. The justification
stopped being true; the exception should stop with it. This is the one place an
exception ends early without a human, and it is safe because ending an exception
takes nothing away from anybody — it reopens a finding.

---

## 16. Findings and remediation

*Slice 1 for the lifecycle and the standing findings; slice 2 adds the SoD kinds.*

One lifecycle, one table, one count.

```
GovernFinding {
  kind, severity
  subject       person, account, resource, source, reviewer, or SoD violation
                — as (subjectRefType, subjectRefId), which is the uniqueness key
  detail        JSON
  driftFindingId?   a Provision DriftFinding this aggregates, never copies
  status        open | acknowledged | accepted | resolved
  owner         a named person, required to leave `open`
  dueAt
  firstSeenAt, lastSeenAt
}
```

A finding that persists across snapshots is updated, not duplicated. A finding
that stops being observed becomes `resolved` **with the snapshot that showed it
gone**, not silently deleted, because "it went away and we do not know why" is
itself worth a row.

`accepted` requires a reason and an expiry, and behaves like an SoD exception in
miniature: it lapses back to `open` and tells the owner. Acceptance with no
expiry is not representable, for the reason section 15 gives.

### The standing findings

Produced by every snapshot without anybody configuring anything. These are the
output that makes slice 1 a product on its own.

| Kind | What it is | Why only Govern sees it |
|---|---|---|
| `unattributable_holding` | Access with no recorded cause | Section 3. |
| `unexplained_gain` | Access appeared between two snapshots and Syntra did not cause it | Section 9. |
| `access_without_contract` | A person with no active contract who still holds something, anywhere | Each subsystem correctly handles its own remit; nobody but Govern looks across all of them at once, and this is the leaver finding that matters. |
| `orphan_account` | An account belonging to no person | Aggregated across targets from Provision's `DriftFinding`, by reference. |
| `privileged_uncertified` | A privileged holding never certified, or not within `privilegedRecertifyDays` | |
| `stale_source` | A source past its freshness SLA | Section 8. It is a finding, not just a badge, because a source nobody has read is a report nobody should trust. |
| `coverage_gap` | A region that could not be read | Section 8. |
| `campaign_low_coverage` | A campaign closed below its minimum | Section 12. |
| `dispatch_not_applied` | A revocation dispatched and not applied within its SLA | Section 13. |
| `sod_violation` | Section 14 | |
| `sod_laundering` | Section 14 | |
| `approval_reciprocity` | Section 14, as a signal | |
| `lapsed_exception` | Section 15 | |
| `no_human_decision` | Holdings granted by a zero-stage workflow | Section 14. |
| `unmergeable_actor` | A decision or grant by an account with no linked person | Section 14. |

### Dormancy, and what Govern cannot see

A finding kind an auditor will ask for and which is **not** in the list above:
*access that has never been used*.

Syntra knows when somebody last signed in **to Syntra**, from `Session` and
`AuthAttempt`. It does not know when somebody last used an Active Directory
group, opened a file share, or logged into a target system, because nothing in
this platform reads a target's authentication logs and nothing in this design
proposes to. A dormancy report built on Syntra sign-in data alone would be
confidently wrong for every person who reaches a target system without going
through Syntra's portal, which is most of them.

So: Govern reports **Syntra account dormancy**, labelled exactly that, and states
plainly on the same screen that it is not entitlement usage. Target-side usage
telemetry is named in section 24 as out of scope. Shipping the number without the
caveat would be the false-assurance defect again, in a place nobody would think
to look for it.

### Remediation items

A `RemediationItem` is the half of a finding that has an assignee and a deadline:
kind, owner, due date, the finding or campaign item it came from, a description
of what has to change, and a deep link to the screen where it can be changed. Its
kinds are the `revocation_requires_change` cases of section 5, plus
`undecided_item`, `orphan_attribution`, and `rule_change_required`.

Remediation is chased: overdue items notify their owner and the campaign or
finding owner, and appear on the dashboard. This is the "chasing findings to
closure" that Provision's section 12 and Automate's section 21 both deferred
here.

### Orphan attribution

*Slice 1.* An account belonging to no person is outside every person-scoped
review and every SoD check, so resolving it is inventory work, not campaign work.

Govern **proposes** an owner and never assigns one:

- Candidate matching over name similarity, mail address, employee identifier, and
  the manager relation of an adjacent account, each producing an
  `AccountAttribution` row with a method and a confidence.
- A **claim** action: the console shows the account to a candidate's manager, who
  confirms or denies. A denial is recorded and suppresses that candidate.
- **Confirmation calls Provision's own account-linking entry point** — the same
  one an administrator uses to resolve a `conflict` per Provision's section 13.
  Govern does not write `TargetAccount`.

Never automatic, at any confidence. Linking an account to a person is not a
labelling exercise: Provision's next run evaluates that person's desired state
against that account, and a wrong link is a leaver's account attached to a
current employee, or a current employee's account attached to somebody who left
and about to be disabled by the ladder. A proposal is cheap and a wrong link is
somebody's access.

---

## 17. The audit story

*Slice 1.*

Syntra's audit log is a hash-chained, append-only, per-tenant sequence. Each
event carries the digest of its predecessor over a fixed field order with a
stable payload serialization, and `verifyChain` recomputes the whole chain and
reports the first sequence where it does not hold. This exists and is tested.

Govern is the subsystem that finally makes it load-bearing, and that means being
precise in both directions about what it does and does not establish.

### What Govern does with it

**Incremental verification on a schedule.** A `govern.audit.verify` job per
tenant, verifying only the segment since the last `AuditCheckpoint`, writing an
`AuditChainCheck` row with the range verified, the head sequence, the head hash,
the duration and the result.

This is not gold-plating the existing function; it is necessary. The built
`verifyChain` calls `findMany` with no bound and walks every event ever recorded,
which is correct and is O(n) in both time and memory over a table that grows
forever. A tenant with ten million events cannot verify nightly that way, and the
practical outcome of an integrity check too expensive to run is an integrity
check nobody runs. So:

- **`AuditCheckpoint`** — `(sequence, hash, verifiedAt, signature?)`. Written
  after a successful verification of the segment ending there.
- **Incremental verification** walks from the last checkpoint's sequence, seeded
  with its hash as the expected predecessor, in pages.
- **Full verification from genesis** remains available as a separate, explicitly
  invoked, paged job — for an investigation, and on a slow schedule.
- A failed verification is a `critical` `GovernFinding`, notified immediately to
  `govern.manage` and `tenant.manage`, never digested, and it names the sequence.

**A batching rule for Govern's own audit volume.** `recordEvent` takes a
per-tenant advisory lock for the duration of its transaction, deliberately, so
that two concurrent writers cannot claim the same sequence. That serializes
appenders, which is correct and which a 50,000-item campaign would abuse: fifty
thousand separately-audited decisions is fifty thousand serialized transactions
on one tenant's chain, and it would make the campaign the slowest thing in the
product while starving every other audited action.

So Govern's decisions are recorded twice, deliberately: in `CampaignDecision`,
which is append-only, one row per decision, complete; and in the audit log **per
decision transaction**, so a bulk certify of 50 items writes one event naming the
50 item ids and the reviewer, rather than 50 events. Nothing is lost — the audit
event is the tamper-evident anchor for a set of rows that are themselves
complete — and the chain stays a chain rather than a bottleneck.

**Evidence bundles.** For a campaign, a report, or a date range: a deterministic
JSON document containing the snapshot and its coverage, the items with their
provenance as at the snapshot, every decision with its reviewer and its quality
signals, the reviewer resolution history, the notifications sent, the revocation
dispatches and their outcomes, the audit-chain verification result over the
sequence range the bundle covers, and the chain head sequence and hash at the
moment of creation.

Serialized with the same sorted-key discipline `stableStringify` already
implements, so the bundle has a stable digest; the digest is recorded on the
`EvidencePack` row and printed in the bundle's own header. Creating one is a
privileged, audited action.

### What it can prove

- **That the recorded sequence has not been altered or deleted** since it was
  written, to anybody who cannot recompute the chain. A removed event breaks its
  successor's `prevHash`; an altered event fails to reproduce its own digest;
  both name a sequence number.
- **That a specific decision was recorded at a specific position** in that
  sequence, which is a real ordering claim: you cannot back-date a decision into
  the middle of the chain without rewriting everything after it.
- **That an evidence bundle has not been edited since export**, from its digest.
- **That a chain covering a period was verified intact at a given time**, from
  the `AuditChainCheck` rows — which is a stronger statement than verifying it
  today, because it establishes the chain was whole *before* whoever you are
  worried about had a reason to change it.

### What it cannot prove — stated honestly, and stated on the artifact

This list is not a caveats appendix. It is printed on the cover of every evidence
bundle, because the harm this module causes is somebody over-reading its output.

- **It cannot prove completeness of the world.** The chain covers what Syntra
  recorded. Anything that happened without a Syntra audit event — a group
  membership added at a domain controller, a permission changed in a SaaS admin
  console, a row updated with direct SQL by somebody holding the database
  credential — leaves no entry. The absence of an event is not evidence of the
  absence of an act. This is why section 9's change report has two panes and why
  `unexplained_gain` is a finding: **snapshot diffing is the only thing that sees
  what the audit log structurally cannot.**
- **It is not proof against the operator.** The hash is computed in application
  code from data in the same database, with no secret. Somebody holding both
  database write access and the ability to run code can rewrite the chain from
  any point and recompute every subsequent digest, and the result verifies
  perfectly. Hash chaining detects tampering by an actor who cannot recompute; it
  does not detect a full rewrite by one who can. In a self-hosted product the
  operator is exactly that actor.

  Three mitigations, and their honest status:

  - **Database-level append-only grants** — revoking `UPDATE` and `DELETE` on
    `AuditEvent` from the application role. Cheap, effective against the
    application being wrong or compromised, ineffective against a superuser.
    Recommended in the deployment documentation and not enforceable by this code.
  - **Signed checkpoints** — `AuditCheckpoint.signature` over `(sequence, hash)`
    with a key the application holds and the database does not. Raises the bar
    from "database access" to "database access plus the signing key". Designed
    here, with the same key-provider interface Core's vault already uses for its
    master key, and a local-file implementation.
  - **External anchoring** — `AuditAnchor` rows recording `(sequence, hash,
    anchoredAt, receipt)`, where the receipt comes from somewhere the operator
    does not control: write-once storage, a mail to an auditor's mailbox, a
    third-party timestamp. **This is the only one of the three that is actually
    proof against the operator**, and Syntra ships the table, the job and a
    file-and-mail implementation. Anchoring to an external timestamping service
    is out of scope (section 24). A tenant that has not configured anchoring sees
    that stated on its own integrity screen, in those terms, rather than a green
    tick.
- **Timestamps are the application server's clock**, not a trusted timestamp.
  `occurredAt` is `new Date()` at append. Ordering within a tenant is guaranteed
  by the sequence; wall-clock accuracy is guaranteed by nothing.
- **A certification proves a click, not a judgement.** It proves a named,
  authenticated human recorded a decision against a stated set of facts at a
  stated time. It does not prove they read anything, that the access was
  appropriate, or that the facts were true at the target at that instant — only
  as of the observation times shown. The reviewer quality signals of section 12
  are in the bundle for exactly this reason: they are the closest thing to
  evidence of *engagement* the system can honestly produce, and they are offered
  as signals rather than as proof.
- **Deletion of the entire log** is detectable only by something outside it that
  remembers the head. That is what anchoring is for, and without anchoring the
  honest answer is that it is not detectable.

---

## 18. Data model

New tables, all tenant-scoped under the same forced row-level security and the
same GUC-keyed policy as everything in Core. Every one carries `tenantId`; none
is protected by a `where` clause in application code alone.

Slice is marked per group.

### Settings — slice 1

- **`GovernSettings`** — one row per tenant, holding every number this design
  names so none of them is a constant compiled into the code: `snapshotSchedule`
  (cron), `snapshotRetentionDays` (400), `defaultFreshnessSlaHours` (24),
  `maxSnapshotAgeDays` (30), `batchThresholdPercent` (10),
  `perResourceThresholdPercent` (30), `personPopulationDropPercent` (20),
  `minimumCoveragePercent` (90), `bulkCertifyLimit` (50), `dispatchSlaHours`
  (72), `privilegedRecertifyDays` (90), `maxExceptionDays` (90),
  `exceptionWarningDays` (`[14, 3]`), `minReciprocalDecisions` (3),
  `reciprocityWindowDays` (180), `lastAppliedBatchAt`,
  `personsWithActiveContractAtLastBatch`.

  The last two are the denominator the population-collapse refusal compares
  against, stored rather than recomputed for the reason Provision stores
  `lastAppliedRunAt` and Automate stores `lastAppliedSweepAt`: the comparison is
  against the last state somebody accepted, not the last state observed.

### Inventory — slice 1

- **`AccessSnapshot`** — `kind` (`scheduled` / `manual` / `campaign`), `status`
  (`building` / `complete` / `failed`), `startedAt`, `finishedAt`, `asOf`,
  `scope` (JSON), counts by resource kind, `holdingCount`, `unattributableCount`,
  `coverageGapCount`, `unattributedAccountCount`, `error`.
  **`asOf` is the instant the collect stage began**, not `finishedAt`, so that a
  build taking twenty minutes describes a world as it stood at one stated moment
  rather than over a smeared window. It is the timestamp every report header
  carries, and section 8 is about the fact that it is not the same as any
  holding's `observedAt`.
  **Only `complete` snapshots are readable by any report or campaign**, enforced
  in the one accessor function, because a partially built snapshot is
  indistinguishable from a small organization. Section 19.

- **`SnapshotSource`** — `snapshotId`, `sourceKind`, `sourceId`, `lastRunId`,
  `lastSuccessfulReadAt`, `lastAttemptedReadAt`, `completeness`, `staleness`,
  `gapCount`. Section 8.

- **`Holding`** — `snapshotId`, `personId` (nullable), `accountRef` (nullable,
  for an unattributed account), `systemKind`, `systemId`, `resourceKind`,
  `resourceId`, `resourceName` (copied, section 7), `state` (`held` / `unknown`),
  `privileged`, `observedAt`, `observedVia`, `firstSeenAt`, `attributionCount`,
  `unattributable`.
  **A snapshot is immutable once `complete`, so no certification state lives on
  this row.** Certification is a fact about a (subject, resource) pair that
  outlives any one snapshot, and putting `lastCertifiedAt` here would mean either
  writing into a frozen snapshot or losing the history at the next build.
  `HoldingCertification`, below, holds it.
  Indexed on `(tenantId, snapshotId, personId)` — the person report — and
  `(tenantId, snapshotId, systemId, resourceId)` — the resource report — and
  `(tenantId, snapshotId, unattributable)` where true.
  **The indexes match the reads.** Directory Sync indexed `SyncChange` on
  `(runId, changeType)` and then queried by status; Provision corrected it; this
  is the same correction made in advance.

- **`HoldingAttribution`** — `holdingId`, `kind` (section 7), `refType`,
  `refId`, `detail` (JSON, carrying the copied names and the resolved paths),
  `resolvedAt`. Several rows per holding, by design.

- **`CoverageGap`** — `snapshotId`, `kind`, `systemId` (nullable), `resourceId`
  (nullable), `personId` (nullable), `reason`, `sourceRunId` (nullable). Section
  8. **The row that must never be a flag.**

- **`HoldingEvent`** — `fromSnapshotId`, `toSnapshotId`, `personId` / `accountRef`,
  `systemId`, `resourceId`, `change`, `beforeAttributions` (JSON),
  `afterAttributions` (JSON), `auditEventSequence` (nullable), `explained`.
  Indexed on `(tenantId, toSnapshotId)` and `(tenantId, personId, toSnapshotId)`.

- **`HoldingCertification`** — `subjectRefType`, `subjectRefId`, `systemId`,
  `resourceKind`, `resourceId`, `lastCertifiedAt`, `lastCertifiedByPersonId`,
  `lastCampaignId`, `lastDecisionId`. Unique on
  `(tenantId, subjectRefType, subjectRefId, systemId, resourceKind, resourceId)`.
  A projection, rebuilt from `CampaignDecision` rows, which remain the record.
  It exists so that "never certified" and "not certified since" are one indexed
  lookup on a report rather than a join across every campaign a tenant has ever
  run.

- **`AccountAttribution`** — `accountRef`, `systemId`, `proposedPersonId`,
  `method`, `confidence`, `status` (`proposed` / `confirmed` / `denied`),
  `decidedByUserId`, `decidedAt`. Section 16.

### Classification and policy — slice 1

Two small tables that exist because Govern must not add columns to tables it does
not own. `Entitlement` belongs to Provision, `DirectorySource` and `TargetSystem`
likewise, and `Group` is rewritten nightly by its source. Govern's opinion about
one of their rows lives beside it, never on it.

- **`ResourceClassification`** — `systemId`, `resourceKind`, `resourceId`,
  `privileged`, `note`, `setByUserId`, `setAt`. Unique on
  `(tenantId, systemId, resourceKind, resourceId)`.
  `Holding.privileged` is derived at build from this table, plus one rule that
  needs no configuration: **every `syntraRole` holding is privileged**, because a
  Syntra role carries permissions from the closed catalogue and there is no
  version of that which is not. Changing a classification is a privileged,
  audited act; raising one takes effect at the next snapshot, and the finding it
  produces says which snapshot first saw it.

- **`GovernSourcePolicy`** — `sourceKind`, `sourceId`, `freshnessSlaHours`,
  `inDefaultScope`. Unique on `(tenantId, sourceKind, sourceId)`.
  A source with no row uses `GovernSettings.defaultFreshnessSlaHours`. This is
  the per-source override section 8 assumes and is where a tenant says that its
  Active Directory is read hourly and its quarterly-reconciled SaaS target is
  not, without either of them pretending to a freshness it does not have.

### Campaigns — slice 2

- **`Campaign`** — `name`, `description`, `scope` (JSON), `snapshotId`,
  `reviewerSelector`, `reviewerConfig` (JSON), `fallbackSelector`,
  `fallbackConfig` (JSON), `ownerPersonId`, `opensAt`, `dueAt`, `recurrence`,
  `allowBulkCertify`, `status` (`draft` / `generating` / `open` / `executing` /
  `closed_complete` / `closed_incomplete` / `cancelled`), `rebasedFromSnapshotId`
  (nullable), `originalDueAt`, `extensionCount`, counts by item status,
  `coveragePercent`. `originalDueAt` and `extensionCount` are carried rather than
  derived, so a campaign that was extended three times says so on its own row and
  in its evidence bundle.

- **`CampaignItem`** — `campaignId`, `holdingSnapshotId`, `personId` /
  `accountRef`, `systemId`, `resourceKind`, `resourceId`, `resourceName`,
  `attributions` (JSON — the copied set, section 11), `observedAt`,
  `coverageStatus`, `riskFlags` (array: `privileged`, `unattributable`,
  `sod_violation`, `stale`, `needs_review`, `no_human_decision`), `status`,
  `statusReason`, `outcomeRef` (nullable).
  Indexed on `(campaignId, status)` — how every loop and every screen reads it —
  and `(campaignId, personId)`.

- **`CampaignItemReviewer`** — `itemId`, `personId`, `via` (`selector` /
  `fallback` / `escalation` / `reassignment`), `assignedAt`, `unassignedAt`,
  `unassignedReason`. The materialized, historical reviewer set: who this was
  with, on the day. Automate's `ApprovalStepApprover`, for attestation.

- **`CampaignDecision`** — `itemId`, `personId`, `decision` (`certify` /
  `revoke`), `comment`, `itemOpenedAt`, `decidedAt`, `viaBulk`, `bulkSize`,
  `sessionDecisionOrdinal`, `coverageAtDecision` (JSON). **Append-only: never
  updated, never deleted.** A reversal is a new decision with its own reason.

- **`ReviewQualitySignal`** — `campaignId`, `personId`, `itemsAssigned`,
  `itemsDecided`, `certifiedShare`, `medianIntervalMs`, `bulkShare`,
  `largestBurst`, `neverOpenedShare`. Section 12.

- **`RevocationBatch`** — `campaignId` (nullable — an SoD remediation batch has
  none), `status` (`computing` / `previewed` / `blocked` / `applying` /
  `applied` / `partially_applied` / `failed`), counts by outcome,
  `requiresConfirmation`, `blockedReason`, `confirmedByUserId`, `startedAt`,
  `finishedAt`, `error`.

- **`RevocationDispatch`** — `batchId`, `itemId` (nullable),
  `holdingDescriptor` (JSON), `route` (the section 5 row that selected it),
  `status` (`proposed` / `skipped` / `dispatched` / `confirmed` / `applied` /
  `failed` / `requires_change` / `cancelled`), `grantId` (nullable),
  `revocationOrderId`
  (nullable), `remediationItemId` (nullable), `message`, `dispatchedAt`,
  `appliedAt`. Indexed on `(batchId, status)`.

- **`RevocationOrder`** — `targetSystemId`, `accountId`, `entitlementId`,
  `decidedByPersonId`, `campaignDecisionId` (nullable), `reason`, `status`
  (`open` / `planned` / `applied` / `cancelled`), `cancelledReason`,
  `createdAt`. Section 5. Unique on
  `(tenantId, targetSystemId, accountId, entitlementId, status)` where status is
  `open`, so one holding cannot carry two live orders.

- **`RemediationItem`** — `kind`, `ownerPersonId`, `dueAt`, `findingId`
  (nullable), `campaignItemId` (nullable), `description`, `deepLink`, `status`
  (`open` / `in_progress` / `done` / `wont_fix`), `resolutionComment`,
  `resolvedByUserId`, `resolvedAt`.

### Segregation of duties — slice 2

- **`BusinessFunction`** — `name`, `description`, `ownerPersonId`.
- **`BusinessFunctionResource`** — `functionId`, `systemId`, `resourceKind`,
  `resourceId`. Unique on `(tenantId, functionId, systemId, resourceKind,
  resourceId)`.
- **`SodRule`** — `name`, `functionAId`, `functionBId`, `severity`, `rationale`,
  `exceptionWorkflowId` (nullable), `enabled`. A rule may not name the same
  function twice, validated at save.
- **`SodViolation`** — `ruleId`, `personId`, `holdingsA` (JSON), `holdingsB`
  (JSON), `contractsA` (JSON), `contractsB` (JSON), `severity`, `status`
  (`open` / `excepted` / `resolved` / `unevaluable`), `exceptionId` (nullable),
  `firstSeenAt`, `lastSeenAt`, `lastSnapshotId`. Unique on
  `(tenantId, ruleId, personId)` — updated across snapshots, never duplicated.
- **`SodException`** — `ruleId`, `personId`, `violationId`, `justification`,
  `compensatingControl`, `basisContractIds` (JSON, nullable), `approvalRequestId`
  (the Automate request that approved it), `approvedByPersonId`, `startsAt`,
  `endsAt`, `status` (`pending` / `active` / `refused` / `blocked_no_approver` /
  `lapsed` / `revoked`), `revokedReason`, `revokedByUserId`. `endsAt` is **not
  nullable**, and is validated against `maxExceptionDays` at save.

### Findings and evidence — slice 1

- **`GovernFinding`** — as section 16. Unique on
  `(tenantId, kind, subjectRefType, subjectRefId)` so a persisting finding is
  updated rather than duplicated. `driftFindingId` is a reference, never a copy.
- **`EvidencePack`** — `kind` (`campaign` / `report` / `period`), `scope` (JSON),
  `snapshotId` (nullable), `campaignId` (nullable), `chainHeadSequence`,
  `chainHeadHash`, `chainVerificationResult`, `digest`, `createdByUserId`,
  `createdAt`, `storageRef`.

### Audit integrity — slice 1, in Core

- **`AuditCheckpoint`** — `sequence`, `hash`, `verifiedAt`, `signature`
  (nullable), `keyId` (nullable). Unique on `(tenantId, sequence)`.
- **`AuditChainCheck`** — `fromSequence`, `toSequence`, `result`
  (`valid` / `broken`), `brokenAtSequence` (nullable), `startedAt`,
  `durationMs`, `mode` (`incremental` / `full`).
- **`AuditAnchor`** — `sequence`, `hash`, `anchoredAt`, `method`, `receipt`,
  `status`. Section 17.

### Changes to existing tables

Only the ones section 5 lists: `ProvisionAction.revocationOrderId`, and
Automate's `sod_violation` refusal reason, which is a value in a status string
rather than a column. `Person`, `Contract`, `User`, `Group`, `GroupMembership`,
`AppAssignment`, `RoleAssignment`, `TargetAccount`, `AccountEntitlement`,
`AccessGrant` and `AuditEvent` are unchanged.

### Permissions

Added to the closed catalogue in `packages/core/src/rbac/permissions.ts`:

- `govern.read` — snapshots, reports, findings, campaigns, violations.
  **Scopeable to an organizational unit** through Core's existing
  `RoleAssignment.scopeOrgUnitId`, because reading Govern tenant-wide is reading
  everybody's access and a team lead who reviews their own department should not
  be handed that.
- `govern.manage` — build snapshots, create and close campaigns, confirm a
  revocation batch, define business functions and SoD rules, assign findings,
  change a setting.
- `govern.accept_risk` — approve an SoD exception where its rule names no
  workflow. Deliberately distinct from `govern.manage`. Section 15.
- `govern.export` — produce a CSV or an evidence bundle. Distinct from
  `govern.read` because reading a screen and walking out with a file are
  different acts with different consequences, and only one of them is a copy.

**Reviewing needs no permission.** Review authority comes from resolution, as
approval authority does in Automate, for the same reason: a permission that
granted it would be a tenant-wide right to certify anything.

---

## 19. Pipeline and transaction shape

Govern performs **no network I/O**. Every stage reads and writes PostgreSQL. That
removes the failure mode this project shipped twice and introduces its local
cousin, which section 3 names and this section handles.

### The snapshot build

```
collect → correlate → attribute → classify → detect → write
```

- **collect** — read the raw holdings from each subsystem's own tables, and each
  source's run history. Paged. Database only.
- **correlate** — resolve each holding's subject to a person, or to an
  unattributed account. Pure over the collected data.
- **attribute** — build the attribution set per holding. Pure.
- **classify** — three-valued state, coverage, staleness, privilege, risk flags.
  Pure.
- **detect** — standing findings, `HoldingEvent` rows against the previous
  snapshot, and (slice 2) SoD violations and the decision graph. Pure.
- **write** — the only stage that writes.

The four middle stages are pure functions over data, which is what made Directory
Sync's and Provision's interesting logic exhaustively testable without a server.
Everything genuinely hard here — the attribution union, the three-valued
aggregation, the freshness classification, the snapshot diff, the SoD detection —
is in them, and is tested with plain values.

### The batching rule, and where it differs from Provision

Provision writes its entire plan in **one** transaction, so that a run which
fails partway writes no plan at all, and there is no readable state in which a
run is `previewed` with no actions. That rule is right for a plan of a few
thousand rows and wrong for a snapshot of several million.

Govern's adaptation, stated explicitly because it is a deliberate divergence:

1. **The `AccessSnapshot` row is created `building` in one short transaction**, so
   there is something to mark `failed` however the rest gives out.
2. **Holdings, attributions and gaps are written in batches**, each its own short
   `withTenant`, sized so no transaction approaches the 5000 ms default. No
   `tx` handle crosses a batch boundary and no loop over a large collection is
   inside one.
3. **The status flips to `complete` in a final short transaction**, together with
   the counts and the audit event.

The atomicity guarantee Provision gets from one transaction, Govern gets from the
status flag plus one enforced accessor: **every read path goes through
`readableSnapshot()`, which admits only `complete`**. A `building` or `failed`
snapshot is invisible to every report, every campaign and every export, so a
half-built snapshot can never be read as a small organization. Section 23 makes
that a test over the route list, in the shape of Automate's visibility suite.

A failed build leaves its rows behind, marked by their snapshot, and a cleanup
job removes them. Deleting several million rows inside the failure handler is the
same mistake in a different costume.

### Campaign generation

Same shape, same reason: item generation is batched, the `Campaign` stays
`generating` until the last batch commits, and `open` is set in a final short
transaction. A campaign in `generating` is invisible to reviewers. Nobody is
notified until it is `open`, so nobody opens a queue that is still filling.

### Decisions and dispatch

- **A decision** — one short transaction: re-check reviewer validity and the
  self-review invariant, write `CampaignDecision`, update the item, write the
  audit event, write the `NotificationOutbox` rows. A bulk decision writes its
  rows and **one** audit event naming them, per section 17.
- **A revocation batch** — compute, guard, and write **the whole batch in one
  transaction**, because a batch is thousands of rows at most and Provision's
  rule applies at that size. Then dispatch per row, each in its own short
  transaction alongside its audit event, with the reflection handler updating
  outcomes as Provision's and Automate's runs report back.
- **Notification** — rendered inside the transaction, sent after it commits, out
  of Automate's `NotificationOutbox` by the existing job. `sendMessage` cannot be
  handed a `TenantClient`, and Govern does not rely on that being remembered.

### Jobs

Every scheduled job is a pg-boss job carrying `{ tenantId, ... }`, because a
background job has no request and therefore no ambient tenant:
`govern.snapshot.build`, `govern.campaign.remind`, `govern.campaign.close`,
`govern.exception.sweep`, `govern.audit.verify`, `govern.audit.anchor`,
`govern.snapshot.prune`.

---

## 20. Administration and reviewer surface

### Portal — an ordinary session, no console

Reviewing is a thing managers and team leads do, twice a year, from a link in an
email. Requiring an administrative session with step-up MFA for it would mean
either nobody reviews or everybody gets an administrative session, and the second
is worse. So the reviewer surface is the portal, exactly as Automate's delegated
administration is, and for the same reason.

- **My reviews** — the queue, grouped by subject or by resource at the reviewer's
  choice. Per item: what it is in plain language, **how the person got it**, when
  it was last observed and by which system, when it was last certified and by
  whom, the risk flags, and whether it is part of an SoD violation. Certify,
  revoke with a required comment, or bulk certify where permitted — with the
  high-risk carve-outs of section 12 shown as such, in words, rather than as a
  disabled button with no explanation.
- **My access** — already Automate's. Extended with each holding's certification
  history, so somebody can see their access was reviewed and when.
- **Resources I manage** — already Automate's. Extended with the review status of
  each holder.

### Console

- **Snapshots and coverage** — the list, and per snapshot the source table of
  section 8 with each source's last read, completeness and staleness, the
  coverage gaps by kind, and **Refresh now** actions that enqueue the owning
  subsystem's job and say whose job they enqueued.
- **The four reports** of section 10, each with its header, each exportable, each
  with a live/point-in-time toggle that says which it is.
- **Campaigns** — the list with coverage as the headline figure; the editor with
  a **scope preview** ("this scope covers 4,120 holdings across 1,180 persons and
  6 systems — show me") and a **reviewer resolution preview** ("stage: manager;
  1,102 items resolve, 61 fall to the fallback, 17 resolve to nobody — here they
  are"), which is the screen that catches an unreviewable campaign before 200
  people are emailed rather than at 3am on the due date. Provision has the same
  screen for rules and Automate for workflows; it exists here for the same reason.
- **Campaign detail** — progress, coverage, the reviewer quality section, the
  items by status, the undecided list by reviewer, and the revocation batch.
- **Revocation batch review** — a blocked batch leads with why and the numbers,
  names the resource where the per-resource axis tripped, groups by resource and
  by person, offers per-row skip, and requires explicit confirmation. The same
  screen shape as Directory Sync's blocked run and Provision's blocked plan,
  because an administrator should not have to learn a third one.
- **Business functions and SoD rules** — with an **impact preview** on save:
  "this rule is violated by 23 persons today — show me who", before it is saved
  rather than after.
- **Violations and exceptions** — with the holdings on each side, the contracts
  that produced them, the exception state and its expiry.
- **Findings and remediation** — one queue, filterable, leading with the
  uncomfortable ones: unattributable holdings, unexplained gains, access without
  a contract, stale sources, dispatches not applied.
- **Orphan accounts** — with proposed owners, confidence, and the claim flow.
- **Audit integrity** — the checkpoint history, the last verification and its
  range, the anchoring status **stated in words when anchoring is not
  configured**, and a **Verify now** action.

### The dashboard leads with what is wrong

A governance dashboard whose first row is "97% certified" is a dashboard that
gets screenshotted into a board pack and stops being read. The first row here is
the count of things nobody can explain, the second is the count of things nobody
has looked at, and the certification rate is further down with its denominator
next to it.

---

## 21. Security posture

- **Govern holds no target credentials and opens no connection.** No vault entry
  for a target system is reachable from any Govern code path. Section 23 makes it
  a structural test over the import graph.
- **Govern writes no access-bearing row.** Every removal is dispatched to the
  owning subsystem or becomes a remediation item. Section 5, and a structural
  test over the module's Prisma writes.
- **Row-level security is the primary tenant isolation control** on every new
  table, and matters most here: `Holding` is a denormalized copy of who can reach
  what across an entire organization.
- **The self-review invariant** — no person decides an item whose subject is
  themselves — is enforced in the domain service, at the moment of decision, as a
  subtraction from the resolved set. Section 12.
- **Review authority comes from resolution, never from a permission.**
- **`govern.read` is scopeable to an organizational unit**, and reporting screens
  respect the scope on every read path, not only on the list.
- **Every export is a privileged, audited action** recording actor, scope, row
  count and snapshot. An export is a copy of everybody's access leaving the
  building.
- **Every privileged action writes its audit event in the same transaction as the
  act**: building a snapshot, creating and closing a campaign, every decision or
  batch of decisions, confirming a revocation batch, creating a revocation order,
  defining a business function or SoD rule, approving revoking or lapsing an
  exception, confirming an orphan attribution, creating an evidence pack, and
  **changing any threshold, freshness SLA or snapshot cadence** — the last
  because lowering a threshold is functionally the same act as confirming
  everything it would otherwise have caught, and lengthening a cadence is
  functionally the same as agreeing not to see things.
- **`CampaignDecision` and `AuditCheckpoint` are append-only.** A reversal is a
  new row.
- **Scope conditions, audience conditions and SoD rules are data**, evaluated by
  the closed interpreter Provision and Automate already use over a closed field
  and operator set. Nothing an administrator types is executed.
- **Administrative capability is separate from review**, and administrative
  sessions carry step-up MFA and a shorter idle timeout, per Core.
- **Bulk is bounded three times**: by the bulk certify cap, by the high-risk
  carve-outs, and by the revocation batch guard and its outright refusals.

---

## 22. Rejected alternatives

Rejections belonging to one decision are stated with that decision: auto-revoking
on reviewer silence in section 12, blocking a birthright grant on an SoD
violation in section 14, perpetual exceptions and auto-renewal in section 15,
revoking on a lapsed exception in section 15, and automatic orphan linking in
section 16. Seven more are cross-cutting.

**Rejected — Govern reading target systems directly.** The obvious design: an
access review module that reads the systems it reviews, so its data is as fresh
as the moment somebody opened the screen. It is rejected because it makes Govern
a second reader, which means a second credential to hold, a second thing to
rate-limit against a domain controller, a second implementation of paging and
range retrieval, and — worst — a second opinion about what the target said. When
the reconciliation screen and the provisioning run disagree about who is in a
group, an organization has two products and no answer. Freshness is recovered by
displaying it honestly (section 8) and by enqueuing the owner's job, which is
strictly better than hiding it behind a read that happens to be recent.

**Rejected — Govern executing revocations itself.** It has the decision, it knows
the entitlement, the connector is in the same repository. It fails on ownership
exactly as it failed for Automate: a revocation written outside Provision's plan
is drift to Provision's reconciler, and a grant Provision still wants comes back
the same night, so the campaign's report is wrong by morning. Dispatching through
the owner gets the same removal with one writer, one guard, one retry
classification and one audit shape — and it is what forces the honest vocabulary
of section 13, which is worth more than the latency it costs.

**Rejected — an analytics store.** Materializing the inventory into a warehouse,
a column store, or a BI tool, and reporting from there. Genuinely faster for the
aggregate queries, and it is what most products in this category do. It is
rejected on three counts, in order of how much they matter: the copy leaves
PostgreSQL's row-level security behind, and a per-tenant access inventory outside
RLS is the worst disclosure surface this platform could build; the copy has its
own lag, which means the freshness model of section 8 would have to describe two
staleness horizons instead of one and would describe the second badly; and
evidence assembled from a store that is not the system of record cannot be tied
to the audit chain. Reporting from the same database, over materialized snapshots
with real indexes, is fast enough for the documented ceiling and honest at every
size.

**Rejected — a single `origin` column on a holding.** One value, one join, one
simple screen. It is wrong for the two cases that matter most — the person who
holds something both by rule and by request, and the person whose entitlement
arrives by two concurrent contracts — and it is wrong in the direction that
produces a confident, incorrect revocation. Section 7.

**Rejected — storing `not_held` rows.** Symmetric, and it makes some queries
trivial. It multiplies the row count by the size of the resource catalog, and it
destroys the distinction that section 6 exists to preserve: with explicit
`not_held` rows, an unread region produces *no row at all*, which is exactly the
state that then reads as "not held" to anybody writing a query later. Absence
plus an explicit coverage register is both smaller and safer.

**Rejected — continuous certification.** Attesting to each change as it happens,
rather than periodically over a scope. It is the modern-sounding answer and it
has a real advantage: a grant is reviewed while somebody still remembers why. It
is rejected because it produces an unbounded stream of single-item decisions with
no denominator, and coverage — the one honest headline this module has — becomes
unmeasurable. It also retrains reviewers into clicking through interruptions,
which is the rubber-stamping problem industrialized. The genuine case it covers
is recovered two ways that already exist: Automate flags a mover's grant
`needsReview` at the moment it stops matching, and a targeted micro-campaign over
a condition is one campaign with a narrow scope.

**Rejected — risk scoring.** A number per person or per holding, computed from
privilege, age, provenance and peer comparison, used to prioritise review. It is
the feature every product in this category advertises. It is rejected for this
sub-project because a score is an opinion presented as a measurement: it
aggregates several things Govern knows honestly into one thing it does not, and
the moment it exists, reviewers will use it as the reason they did not read the
item. The risk flags of section 11 are deliberately flags — discrete, named,
individually explicable — and the campaign scope language can express any
prioritisation a tenant wants without inventing a number nobody can defend to an
auditor.

---

## 23. Testing

Test-driven throughout: a failing test precedes the code that satisfies it. The
interesting logic is pure, deliberately, and that is where most of these live.

### Unit — the pure stages

- **Attribution assembly**, per kind and in combination: a holding with a rule
  and a grant; a holding whose grant expired while the rule continues; an
  application reached by direct assignment, by group, and by an organizational
  unit two levels up, asserting the recorded chain is the actual chain; a
  `discovered` holding classified as unattributable; a `manual` holding not
  classified as unattributable; and a holding with an empty set producing the
  finding.
- **Three-valued aggregation, as a property test.** Over generated inputs, assert
  that no aggregation function ever produces a count in which an `unknown` was
  counted as `not_held`, and that a scope containing a `CoverageGap` never
  reports a bare number for that region. This is the test that must fail if
  somebody later adds a `count()` that filters on `state = 'held'` and forgets
  the gaps.
- **Freshness classification** at its boundaries: just inside the SLA, exactly
  at it, just outside; a source read successfully but incompletely; a source
  never read; and a snapshot whose sources disagree, asserting the snapshot takes
  the worst of them.
- **The snapshot diff** producing each `HoldingEvent` change kind, including
  `became_unknown` when a source stops being readable — which must **not** be
  reported as `lost`, and which gets its own assertion because it is the mistake
  that turns a read failure into a false "their access was removed".
- **SoD detection**: a violation across two systems and two accounts of one
  person; a person with concurrent contracts on either side, asserting the
  contracts are recorded; a function whose resource is `missing`, asserting the
  rule is `unevaluable` for the affected subjects and **not** evaluated as
  not-held; and a violation persisting across snapshots being updated rather than
  duplicated.
- **The decision graph** over the three edge kinds, asserting that a delegated
  grant produces an edge, that an auto-granted holding produces the
  `no_human_decision` class, and that an actor with no linked person is reported
  rather than dropped.
- **The revocation guard** at its boundaries: just under each threshold, exactly
  at it, just over; the per-resource axis tripping while the batch axis does not;
  a first batch with a zero denominator; a snapshot past `maxSnapshotAgeDays`; a
  source gone stale between decision and execution; and the person-population
  drop.
- **The dispatch router**, as a table over every attribution combination,
  asserting that each resolves to exactly one route and that the three
  `requires_change` routes never produce a dispatch.

### Structural tests — the ones that must fail if somebody forgets

In the shape of Provision's never-deletes test and Automate's no-timeout-approval
test, because a convention that lives in a document is a convention that survives
until the third person touches the code.

- **No transition into `certified` exists that is not caused by a
  `CampaignDecision` row.** Exhaustive over the item state machine. This is the
  test that would fail if anybody ever adds a negative-confirmation setting.
- **No transition into `revocation_applied` exists that is not caused by both an
  owning-subsystem confirmation and a subsequent observation.**
- **Govern imports no connector package.** A test over the module's import graph,
  asserting the Govern namespace has no path to `@syntra/connectors` or to any
  vault entry naming a target credential.
- **Govern writes no access-bearing table.** A test over the Prisma models Govern
  code writes, asserting the set excludes `GroupMembership`, `AppAssignment`,
  `RoleAssignment`, `TargetAccount`, `AccountEntitlement`, `AccessGrant` and
  `AuditEvent` — the last because Govern writes audit events only through
  `recordEvent`.
- **Every report route goes through `readableSnapshot()`**, enumerated as a table
  over the route list so a route added later without it fails a test. Automate's
  visibility suite, for staleness.
- **Every report DTO carries its header.** A type-level and runtime assertion
  that no serializer emits a report body without its as-of, coverage and gap
  counts.
- **No `withTenant` call encloses a loop over an unbounded collection**, checked
  in test by a client wrapper that fails when a transaction exceeds a
  time budget under a seeded large tenant.

### Integration — against a real PostgreSQL, with a `FakeTarget` for the loop

- The full loop: seed persons, contracts, rules and a target through Provision's
  `FakeTarget`; run Provision; request and approve something through Automate;
  build a snapshot; assert every holding carries the right attribution set and
  that "why does this person hold this" answers with a rule for one and a request
  with its approver for another.
- **The `revocation_requires_change` case**, end to end: certify-campaign a
  rule-attributed holding, decide revoke, assert a `RemediationItem` of kind
  `rule_change_required` exists, that **no** revocation was dispatched, that the
  campaign's revoked count does not include it, and that a subsequent Provision
  run leaves the holding in place.
- **The `RevocationOrder` case**: a `discovered` holding revoked, an order
  written, a Provision run planning it as a `revoke_entitlement`, the guard
  seeing it, and the holding gone from the next snapshot with the dispatch
  reaching `applied` only then.
- **The order cancelled**: the same holding acquires a request grant between the
  decision and the plan; assert the order is cancelled, the campaign is told, and
  nothing is revoked.
- **The synced group case**: a revoke decision on a `GroupMembership` carrying a
  `sourceId` produces a remediation item naming the source and no write.
- **Stale refusal**: a campaign whose target has not been read within its SLA
  cannot be started, and one whose snapshot ages past the limit cannot be
  executed.
- **Coverage**: seed a target reporting an entitlement as `unreadable`; assert a
  `CoverageGap`, assert the holder count reports `unknown`, and assert no report
  path renders it as a number.
- **Tenant isolation**: snapshots, holdings, campaigns and findings created in
  one tenant are invisible to another even when the query is written wrongly.
- **Audit**: verify a chain incrementally against a checkpoint; tamper with one
  event's payload and assert the check reports the right sequence; delete an
  event and assert the same; assert an evidence pack's digest is stable across
  two serializations of the same content.

### Scenario tests — the reviewer pathologies

Written as scenarios rather than units, because each is a sequence:

- A reviewer who never responds: reminders fire, escalation adds the manager and
  tells the original, the campaign closes `incomplete`, the items are `undecided`
  and **not** certified, remediation items exist, and the coverage figure is the
  headline.
- A reviewer who bulk-certifies: the decisions carry `viaBulk` and the size, the
  quality signals compute, a high-risk item in the same selection is refused from
  the bulk action, and the evidence bundle shows both.
- A reviewer who is deactivated mid-campaign: their decided items stand with
  their status as at the decision, their open items reassign with a recorded
  window, both parties are notified, and a re-resolution to nobody produces
  `blocked_no_reviewer` rather than anything else.
- A reviewer who is the subject: dropped by every selector, the item falls to the
  fallback, and where the fallback is also them the item blocks.
- A subject who departs mid-campaign: items become `moot` with the departure
  recorded, counted separately, and never as certified.

### End-to-end (Playwright)

Build a snapshot with one deliberately stale source and see the campaign refused
with the source named; refresh, rebuild, start the campaign; a manager reviews
from the portal with no administrative session, certifies some, revokes one
rule-attributed holding and one hand-granted one; the batch is blocked by the
per-resource axis, reviewed, skipped in part, and confirmed; the rule-attributed
decision appears as `requires_change` with its remediation item and not in the
revoked total; the hand-granted one reaches `applied` after a Provision run; the
campaign closes `incomplete` with two undecided items named by reviewer; and the
evidence bundle exports with its coverage, its limitations page, and a verified
chain range.

---

## 24. Out of scope

**Deferred to a later Govern slice, if it is ever warranted:** role mining and
role suggestion from observed holdings; peer-group analytics ("87% of people in
this department do not hold this"); campaign templates and campaign libraries;
reviewer delegation as a first-class object distinct from Automate's approval
delegation; and multi-tenant benchmarking of any kind.

**Not in this sub-project at all:**

- **Target-side usage telemetry.** Whether somebody has ever used an entitlement,
  as opposed to whether they hold it, requires reading authentication and access
  logs from each target system. Nothing in this platform reads those and nothing
  here proposes to. Syntra account dormancy is reported and is labelled as
  exactly that. Section 16.
- **Risk scoring and any single composite number.** Section 22.
- **Automatic remediation of anything.** Every removal is a human decision
  dispatched to an owner, and every finding is closed by a person.
- **Policy-as-code import** — expressing SoD rules or campaign scopes in an
  external language or file format. They are data in the closed interpreter this
  platform already has.
- **GRC platform integration** — pushing findings into ServiceNow GRC, Archer or
  a spreadsheet somebody's auditor mailed them. An export exists; an integration
  does not.
- **SIEM export of the audit log.** Reasonable later work, named here so it is a
  decision rather than an omission.
- **External timestamping or blockchain anchoring services.** `AuditAnchor` ships
  with a file-and-mail implementation and an interface. Section 17.
- **Fine-grained entitlements inside applications** — a role inside a SaaS
  product that Syntra grants access to but cannot enumerate. Govern reviews what
  Provision can see, and says so.
- **Licence cost, budget and chargeback.** Automate already declined to know what
  a product costs; Govern declines to report on it.
- **Data access governance** — file shares, folders and unstructured data. A
  different product with a different data model.
- **Privileged access management** — session brokering, credential vaulting for
  administrative accounts, session recording. Govern reports who *holds*
  privileged access; PAM is about how it is *used*, and it is not this.
- **Attestation of anything that is not access** — asset ownership, policy
  acknowledgement, training completion. The campaign engine could carry them and
  will not, because a campaign whose items are three different kinds of thing is
  a campaign whose coverage figure means nothing.
