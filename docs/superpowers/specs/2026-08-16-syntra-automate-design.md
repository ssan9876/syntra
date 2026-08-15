# Syntra Automate — Requests

**Date:** 2026-08-16
**Status:** Approved design
**Scope:** Sub-project 3 of the Syntra programme, first of its two slices

---

## 1. Purpose

Provision decides what a person gets because of their contracts. Automate is how
somebody asks for what their contracts did not give them.

A researcher needs the statistics licence for one project. A new team lead needs
the shared mailbox their predecessor held. A contractor needs read access to one
finance folder for the duration of an audit. None of that follows from a job
title, and none of it should require a ticket, a phone call, or an administrator
with a console open.

Automate gives every person a catalog of things they may ask for, routes each
request to somebody accountable, and turns an approval into access — with an end
date, with a record of who decided and why, and without growing a second writer
alongside the one Provision already owns.

This is what HelloID calls Service Automation. It is the half of an identity
platform users actually touch, and it is the half where an approval control that
looks like a workflow feature quietly becomes the reason an auditor cannot sign
off.

### Success criteria

Done when a Syntra instance can:

1. Publish a catalog of requestable products, each visible only to the people its
   audience admits, with visibility enforced identically on every read path
   including search.
2. Let a person open the catalog, submit a request with a typed form, see where
   it is, and cancel it while it is still theirs to cancel.
3. Let a manager or a helpdesk agent request on behalf of somebody else, with the
   subject always told.
4. Route a request through an ordered approval workflow whose approvers are
   resolved from the subject's manager chain, the product's owner, the resource's
   owner, a role, a group, or a named person.
5. Grant a product with no approval stages immediately, and record that it did.
6. Refuse, on every path — self-approval, delegation, escalation, a manager cycle,
   a group the subject belongs to, an on-behalf submitter — to let anybody decide
   a request they are the subject or the submitter of.
7. Handle an approver who is absent, on leave, or whose account has been disabled,
   without the request either stalling silently or approving itself.
8. Turn an approval into an `AccessGrant` that enters Provision's desired state, so
   the entitlement is written to the target system by Provision and by nothing
   else.
9. Grant a Syntra application assignment or a locally-managed group membership
   directly, and never touch a group owned by a directory source.
10. Hold access until a date, warn before that date arrives, and remove it when it
    does — through a reviewable, guarded sweep, not an unattended mass write.
11. Remove requested access when a person's contracts end, on the contract end
    date, and say so to everybody who needs to know.
12. Let a team lead add and remove members of one group they own, from the portal,
    with no administrative session and no console.
13. Report every request it could not fulfil — a failed target write, a workflow
    that resolves to nobody, a subject who stopped being eligible mid-flight — by
    name, to a human, and never by leaving a row in a quiet state.
14. Record every submission, decision, delegation, grant and revocation in the
    hash-chained audit log, in the same transaction as the act it records.

---

## 2. Position in the programme

| Sub-project | Status | Relationship |
|---|---|---|
| **Core** | built | Persons, contracts, RBAC, the audit log, the vault, the scheduler, the notification service, `withTenant`. Automate is built on all of them. |
| **Directory Sync** | built | Owns the membership of every group carrying a `sourceId`. Automate never writes one. Section 5. |
| **Access** | built | Owns `Application` and `AppAssignment`. Automate writes `AppAssignment` rows; Access resolves them into portal tiles unchanged. |
| **Provision — Targets** | designed, in build | **The dependency that matters.** Automate produces grants; Provision applies them. Section 5. |
| **Provision — Sources** | planned | Independent. Automate reads persons and contracts, and does not care how they got there. |
| **Automate — Requests** | this document | Depends on Core, Access, and Provision — Targets. |
| **Automate — Tasks** | planned, sibling document | Delegated dynamic forms and the scripted task engine. See below. |
| **Govern** | planned | Consumes the decision record, the grant inventory, and the review flags this slice produces. Sections 10 and 21. |

The Core design's table numbers Automate as sub-project 3. It is the fifth design
document in the programme, after Core, Directory Sync, Provision — Targets, and
Provision — Sources.

### Automate is two slices, and this is the first

Sub-project 3 as the Core design scoped it contains four things: a product
catalog, self-service requests, approval workflows, and **delegated dynamic forms
plus a scripted task engine**. The first three are one product. The fourth is a
code execution engine, and it is not the same kind of thing at all.

**The seam is arbitrary code.**

- **Automate — Requests** (this document): everything a request can do is *data
  Provision or Access already knows how to write*. A product grants entitlements,
  application assignments, and local group memberships. A form field is one of a
  closed set of typed fields whose options come from the catalog or from a static
  list. An approver is resolved by one of a closed set of selectors. Nothing an
  administrator types is executed.
- **Automate — Tasks** (sibling document): form fields whose options are computed
  by running a script against a live system, and request outcomes that run a
  script rather than record a grant. That brings a sandbox, a script credential
  model, an execution audit trail, output handling, timeouts, and — for anything
  on-premises — the Agent of sub-project 5 as the executor.

Each half delivers working software alone, which is the test.

**Requests alone** is a complete self-service access product: a catalog, an
approval chain, time-bounded grants, delegated group administration, and a
fulfilment path that reaches real target systems through Provision. An
organization can run it as its access request process on day one. It has no
dependency on the task engine, because nothing in it executes anything.

**Tasks alone**, built on top, adds the ability to request things that are not
grants — a new distribution list, a room booking, a password reset performed by a
script, a folder created on a file server. It is a genuine capability and it is
also the entire security surface of the sub-project. Building it beside the
approval engine, in one cycle, means the approval control and the code execution
control get designed by the same tired week.

**Requests is built first**, and not only because Tasks depends on the approval
chain it defines. Every irreversible decision in sub-project 3 — who may approve,
what visibility means, what happens when a grant meets a contract change, what a
request that cannot be fulfilled does — lives in Requests. Those decisions should
not wait behind a sandbox.

The seam holds in both directions: nothing in this document executes a script, and
nothing in Tasks decides who may approve.

### The one hard dependency

`targetEntitlement` products cannot be fulfilled until Provision — Targets exists,
because Provision is the only writer to a target system and this design does not
give Automate a second one. Until then, `application` and `localGroup` products
are fully functional, which is a usable product on its own — a catalog of Syntra
applications and locally-managed groups, with approvals and expiry. This is stated
as a sequencing fact rather than a fallback plan: if Provision — Targets slips,
Automate still ships something that works, with one product kind disabled and the
catalog editor saying why.

---

## 3. Platform constraints this design inherits

These are not restated for completeness. Each one shapes something below.

**Nothing irreversible happens unattended.** Directory Sync refuses a run that
would deactivate an implausible share of a source. Provision inherits a guard
covering creates, disables, archives and entitlement revocations, on two axes.
Automate's bulk surface is the expiry and lapse sweep, and it is guarded the same
way (section 11). The single-request path is not bulk and is not threshold-guarded;
it is guarded by approval.

**No network or long-running I/O inside a Prisma interactive transaction.**
`withTenant` is `prisma.$transaction(fn)` under a 5000 ms default. This has shipped
as a defect twice on this project — once with a directory read, once with an SMTP
send, which is why `sendMessage` no longer accepts a `TenantClient` at all.
Automate sends more mail than every other subsystem combined, so section 13 states
the ordering explicitly and section 20 makes it a test rather than a convention.

**Every table is tenant-scoped under forced row-level security keyed on a GUC.**
Every new table below carries `tenantId` and a policy comparing it against
`app.current_tenant`. No table is protected by a `where` clause in application code
alone.

**The audit log is hash-chained and append-only, and a privileged action records
its event in the same transaction as the action.** An approval is the archetypal
case: somebody will need to reconstruct, a year later, who allowed this and on
what basis. Decisions are therefore never updated — a reversal is a new row — and
every decision, delegation, product edit and grant commits with its audit event.

**A silently dropped record is the defect class this project keeps
rediscovering.** Directory Sync computed absence from a mapping failure and
proposed deactivating the people it had failed to understand. Provision's answer
was `ProvisionException`: a table, by name, not a count. Automate's equivalents are
a request that cannot be fulfilled, a workflow that resolves to nobody, and a
notification that failed to send. Each of the three has a state, a name, a
notification and a screen. None of them has silence.

---

## 4. Decisions

Settled during brainstorming; the implementation plan does not reopen them.

| Decision | Choice | Reasoning |
|---|---|---|
| Slicing | Two slices, seam at arbitrary code, Requests first | Section 2. The approval control and the script sandbox are different problems and should not share a cycle. |
| Who writes to target systems | Provision, exclusively. Automate produces grants. | Section 5. A second writer would fight Provision over the same account every night, and whichever ran last would win. |
| How a grant reaches Provision | `AccessGrant` becomes a term in `desiredState` | Section 5. It dissolves both birthright collisions instead of arbitrating them, and inherits Provision's plan, guard, retry and audit unchanged. |
| What Automate may write itself | `AppAssignment`, and `GroupMembership` on a group with a null `sourceId` | Section 5. Those tables have no other writer. A synced group has one, and it rewrites membership every run. |
| Catalog visibility default | Closed. A product with no audience rule is visible to nobody. | Section 6. The safe reading of an unconfigured access control is "nobody", and a catalog listing things you may not have describes the organization to you. |
| Visibility enforcement | One server-side resolver, called by every read path; excluded products are 404 | Section 6. A filter applied in the console and not in search is the leak; 403 confirms existence. |
| Request granularity | One product per request, several resources per product | Section 7. A cart mixes approval chains and produces a request that is half-approved, whose every subsequent state is ambiguous. |
| Cancellation window | Requester may cancel until approval, never after | Section 7. After approval the honest act is to hand the access back, which is its own recorded event, not a race with an apply in flight. |
| Workflow immutability | A request carries a snapshot of the workflow and grants it was submitted under | Section 7. The same rule as "what was reviewed is what is applied": editing a product must not mutate decisions in flight. |
| Eligibility re-check | Re-evaluated at each stage and again at fulfilment | Section 7. An approval given on Monday for a finance product must not fulfil on Friday after the subject left finance. |
| Approver resolution | A closed set of selectors, no scripting | Section 8. The rule that decides who may allow access must be readable by somebody who did not write it. Same reasoning that kept PowerShell out of Provision's business rules. |
| Auto-grant | A workflow with zero stages, not a flag | Section 8. One mechanism, and the catalog can say plainly "granted immediately". |
| Delegation | Adds an approver, never replaces one; depth 1; time-bounded, end date required | Sections 8 and 9. Replacement hides an approval from the person accountable for it, and is the cleanest self-approval path in the design. |
| Escalation | Adds an approver after an SLA, and tells the original | Section 8. Escalation that replaces silently removes somebody's authority without telling them. |
| Timeout behaviour | Remind forever by default; expire is opt-in and notified; **never auto-approve** | Section 8. Approval by inattention is a privilege grant nobody made. |
| Approval integrity | The subject and the submitter are dropped from every resolved approver set, checked at decision time in the domain service | Section 9. It is a security control, not a workflow feature. |
| Request grant vs. birthright | Union. A grant survives a rule that stopped matching; a rule survives a grant that expired. | Section 10. Both collisions are the same collision, and union is the answer Provision already uses across concurrent contracts. |
| Movers | A grant survives a department change, and is flagged for review | Section 10. Somebody asked and somebody accountable allowed it; revoking that silently on an HR field change is not Automate's call. Not saying anything is not an option either. |
| Leavers | Grants lapse on the person's latest contract end date, with no grace | Section 12. Requested access is access beyond the job. When the job ends it goes first, and it goes on the day. |
| Duration | Per product: permanent, fixed, or requester's choice under a cap | Section 12. |
| Expiry | A reviewable, guarded sweep with one row per grant | Section 11. The one thing Automate does in bulk, so it gets the treatment everything in bulk gets here. |
| Renewal | A new request against the same product, pre-filled | Section 12. Auto-renewal unless somebody objects is auto-approval wearing a different hat. |
| Delegated administration | A portal surface; every delegated act is an `AccessRequest` with no approval stages | Section 14. One fulfilment path, one audit shape, one answer to "why does this person hold this". |
| Notification timing | Rendered inside the transaction, sent after it commits, recorded in an outbox | Section 13. The signature of `sendMessage` already forbids the other order; the outbox is what makes a failed send answerable. |
| Failure surfacing | Every non-terminal failure has a status, a named subject, a notification and a screen | Section 3. |

---

## 5. What Automate writes, and what it does not

Four subsystems now touch access. It matters that they form a cycle with one
direction of flow rather than a set of competing writers.

```
   HR record ──▶ Person + Contract ──┐
                                     ├──▶ desiredState ──▶ Provision ──▶ Target system
   Catalog ──▶ Request ──▶ AccessGrant ┘                                      │
                                                                              │
                          Access ◀── Syntra User/Group ◀── Directory Sync ◀────┘
```

**Automate does not talk to a target system.** It has no connector, no
credentials, no write path, and no retry loop against anything remote. What an
approval produces is a row.

### The mechanism: a grant is a term in desired state

Provision's `desiredState` is a pure function of a person, their contracts, the
business rules, and the account profile. This slice gives it one more input: the
person's **active `AccessGrant` rows for that target**.

```ts
desiredState(
  person, contracts, rules, profile, grants, now, horizon
): {
  account: { required: boolean; attributes: ...; enabledNow: boolean } | null
  entitlements: Set<entitlementId>
  attribution: Map<entitlementId, Array<
      { source: 'rule';    ruleId: string;  contractId: string }
    | { source: 'request'; grantId: string; requestId: string }>>
}
```

The entitlement set is the **union** of what the rules produce and what the grants
name. `attribution` gains a second shape, so "why does this person hold this?"
answers with either a rule and a contract or a request and its approver.

Everything downstream is Provision's existing machinery, unchanged: the plan, the
per-action guard, the per-entitlement axis, the three-step transaction shape, the
provenance marker, the retry classification, the reconciler, the audit events.
Automate adds no enforcement code, no second guard, and no second definition of
what an entitlement is.

Three changes to a built subsystem, listed plainly rather than buried:

- `desiredState` gains the `grants` parameter above.
- `AccountEntitlement.origin` gains the value `request`, alongside `rule`,
  `manual` and `discovered`, and the row gains a nullable `grantedByRequestId`.
  One value covers both grant origins — a delegated administrator's act is an
  `AccessRequest` too (section 14), so `grantedByRequestId` answers which kind it
  was without a second enum value that would mean the same thing to Provision.
- `Entitlement` gains a `requestable` flag, so a target's catalog can be published
  without publishing every group in the domain.

### What this dissolves

**A request grants something Provision would not grant.** Under any design where
Automate writes separately, this is drift: Provision's reconciler sees an
entitlement it did not grant, and in `authoritative` mode proposes revoking it.
Under this design it is not drift at all, because it is in desired state. The
grant is *documented, approved, attributable access*, and `authoritative` mode
exists to strip *undocumented* access. Ruling P2 requires drift to be reported
under both modes; a request grant is not drift and is not reported as such — it
appears in the person view with its request, its approver and its end date.

**A contract change removes something a person separately requested.** The same
answer inverted. The rules stop matching, the rule-attributed term leaves the
union, and the grant term remains. The revocation is proposed only when both terms
are gone. This is exactly the semantics Provision already applies when one of two
concurrent contracts ends: losing access because one of two independent reasons to
hold it went away is the bug, and union is the fix.

Section 10 works through the full matrix.

### Latency, and the state between approval and access

An approved `targetEntitlement` request is not access yet. Provision applies it on
its next run for that target.

Mitigated the way Provision mitigated the same problem with Directory Sync: an
approval that produces target grants **enqueues a run of the affected target
system**. That is an existing job on an existing queue. The run is subject to
Provision's guard and its `autoApply` setting exactly as any other — Automate has
no ability to bypass either, which is the point.

So a request can sit. Where it sits is `awaiting_fulfilment`, and that state is
loud:

- The requester's view says, in words, that the request is approved and waiting to
  be applied, and names the target.
- A request in `awaiting_fulfilment` for longer than `fulfilmentSlaHours` (default
  24) appears on the administration dashboard and notifies the holders of
  `automate.manage`.
- A request whose Provision action reached `failed` becomes `fulfilment_failed`,
  carrying the target's own message. The requester, the subject and
  `automate.manage` are told. The grant is **not** recorded as active, so the
  console never claims somebody holds something they do not.
- A request whose action was `superseded` by a newer Provision run stays
  `awaiting_fulfilment` and does not fail. The grant is still in desired state, so
  the superseding run re-proposes it. This falls out of the design rather than
  needing handling, and it gets a test because it is the case that looks like a
  failure and is not.

### What Automate does write

Three product kinds, three fulfilment paths, one writer each.

| Product kind | Written by | Path |
|---|---|---|
| `targetEntitlement` | **Provision** | `AccessGrant` enters `desiredState`; the next run for that target plans and applies it. |
| `application` | **Automate** | An `AppAssignment` row naming the subject's user, in one transaction with its audit event. |
| `localGroup` | **Automate** | A `GroupMembership` row, in one transaction with its audit event. |

The second and third are safe because those tables have no other writer.
`AppAssignment` is written by Access's administration surface and by nothing else.
`GroupMembership` on a **locally-managed** group — `sourceId` null — is written by
Core's directory surface and by nothing else.

**A group carrying a `sourceId` is refused as a `localGroup` product**, at
configuration time, with the message naming the owning source. Its membership is
rewritten by that source every run; a request-granted membership would survive
until the small hours and then vanish, which is worse than refusing it. The
correct way to request a synced group is as the `targetEntitlement` it
corresponds to: Provision writes the Active Directory group, Directory Sync brings
the membership back, and Access grants applications from it. That is the loop
the Provision design's section 4 exists to keep intact.

### An `application` product and its subject's account

An `AppAssignment` names a `User`, and a `Person` may hold several accounts or
none. The rule: an `application` product resolves to the subject's `User` rows via
`User.personId`. A subject with **no** user account cannot be granted an
application product, and the request is refused at submission with that reason —
not approved and then found to be unfulfillable. A subject with several accounts
gets the assignment on all of them; an application granted to a person is granted
to that person, and picking one of their logins arbitrarily is a support call
waiting to happen.

---

## 6. The product catalog

### What a requestable thing is

A **`Product`** is one thing a person may ask for. It carries:

- Identity and presentation: `name`, `slug`, `description`, `category`, `iconUrl`,
  and `requestInstructions` — free text shown on the request form, which is where
  a tenant explains what the thing actually is.
- `kind` — `targetEntitlement`, `application`, or `localGroup`.
- **The resources it grants**, as `ProductGrant` rows: one per resource. A product
  granting several resources is a bundle — "Finance onboarding" granting three
  groups and a licence — and the alternative, one product per entitlement, makes a
  catalog nobody can navigate. A bundle is requested, approved and fulfilled as a
  set; its per-resource outcomes are recorded per `RequestItem`, so a bundle where
  two of three landed is `partially_fulfilled` and names the one that did not.
  A bundle may not mix kinds in a way that splits the fulfilment path
  unrepresentably: `targetEntitlement` grants within one bundle must all belong to
  **one target system**, so that one Provision run fulfils the whole thing. Mixing
  a target entitlement with an application or a local group is allowed.
- `audienceCondition` — section below.
- `workflowId` — the approval workflow, section 8.
- `durationMode`, `defaultDurationDays`, `maxDurationDays` — section 12.
- `formSchema` — the typed request form, below.
- `ownerPersonId` or `ownerGroupId` — who owns the catalog item, used by the
  `productOwner` approver selector and told when the product's requests get stuck.
- `status` — `draft`, `active`, `retired`. A product is never hard-deleted while
  any grant or request references it; retiring hides it from the catalog and stops
  new requests, and section 7 says what happens to the ones in flight.

### Who can see it

**Visibility is an access decision, and its default is closed.**

A product's audience is a declarative condition — the same closed interpreter
Provision's business rules use, over the same closed field set, extended by three
fields the catalog needs:

```
field := contract.department | contract.jobTitle | contract.costCentre
       | contract.employer   | contract.location  | contract.fte
       | person.status
       | user.memberOfGroup          (new)
       | user.orgUnit                (new — matches the unit or any above it)
       | person.hasEntitlement       (new — holds a named entitlement already)
```

Reusing the evaluator is not a convenience. It means the expression that decides
who sees a product is the same kind of object, with the same operators, the same
case-insensitive trimmed string comparison and the same test suite, as the one
that decides who gets birthright access. A tenant learns one language.

A condition matches if **any** of the person's currently active contracts
satisfies it, which is the rule Access's authentication policy already uses.

**An absent audience means nobody.** A `Product` with a null `audienceCondition`
is visible to no one, and the catalog editor says so on the screen. The tempting
alternative — absent means everybody — is the same shape as the defect this
project keeps rediscovering: an unconfigured control that fails open. A product
genuinely meant for everybody says so with `{ all: [] }`, which is true for anyone
holding any active contract, and is a deliberate keystroke rather than an
omission.

`person.hasEntitlement` exists for the common real case: a product that only makes
sense to somebody who already holds the base licence. Without it, tenants express
that as a department list that drifts.

### How visibility is enforced

One function:

```ts
visibleProducts(tx, personId): Promise<Product[]>
```

**Every read path calls it.** The catalog list, the category browse, the search
and typeahead, the product detail endpoint, the "request on behalf" picker, and
the request form's option lists. A filter applied by the console and not by search
is the leak, and search is the endpoint that gets written last.

A product the caller's audience does not admit returns **404, not 403**. A 403
confirms the thing exists, and the existence of "Payroll — Executive Compensation
Reporting" in a catalog is itself information about the organization. This is the
same discipline as the login endpoint returning an identical response and timing
whether or not the account exists.

Three places where visibility could leak sideways, each closed:

- **The approver's view.** An approver sees the product name and description for
  requests routed to them, whether or not their own audience admits the product.
  That is correct: being routed the decision is the authorisation. It is not a
  general catalog read, and it does not grant one.
- **Request on behalf.** The catalog shown to a submitter acting for somebody else
  is **the subject's** catalog, not the submitter's. A helpdesk agent with
  `automate.request_on_behalf` sees what the subject may request. This is the
  right way round: the permission is to act for somebody, not to see everything.
- **Delegated administration.** A delegated resource manager can grant only within
  the resource's own audience (section 14), so delegation is not a route around
  the audience rule.

### The request form

A `formSchema` is a list of typed fields from a closed set: `text`, `textarea`,
`select` (static options), `multiselect`, `date`, `number`, `checkbox`, and
`resourcePicker` (choose among the product's own `ProductGrant` rows, for a
product whose bundle is "pick one of these four shared mailboxes"). Each field
carries a label, help text, required flag, and validation bounds. The whole schema
is validated by Zod at save time and the submitted values are validated against it
again at submission.

Two fields are implicit on every form and not part of the schema: **justification**
(required whenever the workflow has at least one stage — an approver asked to
decide with no stated reason will decide badly or not at all) and **duration**
(shown only when `durationMode` is `requesterChoice`).

**Form fields whose options come from a live system** — every mailbox on the mail
server, every folder under a share — are the dynamic forms of the sibling slice.
They require running something against a target, and this slice runs nothing.
Section 21.

---

## 7. The request

### Two lifecycles, deliberately not one

**An `AccessRequest` is the ask. An `AccessGrant` is the holding.** They have
separate lifecycles and conflating them is the ambiguity that makes "what happens
when the date arrives" unanswerable.

A request terminates when it has been decided and fulfilled, or refused. What
happens afterwards — expiry, lapse, hand-back, revocation — happens to the grant,
and the request is the immutable record of why the grant exists.

**Request statuses**

| Status | Meaning |
|---|---|
| `pending_approval` | At least one stage is open. |
| `blocked_no_approver` | A stage resolved to nobody valid, and its fallback did too. Section 8. |
| `approved` | Every stage decided in favour. Transient for internal kinds, which fulfil in the same transaction. |
| `awaiting_fulfilment` | Dispatched to Provision, not yet applied. Section 5. |
| `fulfilled` | Every item landed. |
| `partially_fulfilled` | **Terminal.** Every item reached a terminal state, some landed and some did not, and the request names which. A request with items still in flight is `awaiting_fulfilment`, never this. |
| `fulfilment_failed` | Every item reached a terminal state and none landed. |
| `rejected` | A decision against, or an automatic refusal — the reason is always recorded. |
| `cancelled` | Withdrawn by the requester before approval. |
| `expired` | Nobody decided within the product's expiry window, where one is configured. |

**Grant statuses**

| Status | Meaning |
|---|---|
| `scheduled` | `startsAt` is in the future — a pre-hire, or a deliberately dated start. |
| `pending` | In force, dispatched, not yet confirmed applied at the target. |
| `active` | Confirmed held. |
| `expired` | `endsAt` passed. |
| `lapsed` | The subject's contracts all ended. Section 12. |
| `revoked` | Handed back, or withdrawn by an owner or administrator. |

Desired state includes grants in `pending` and `active` — that is, grants whose
window covers now. `scheduled` grants are visible in the console, say when they
start, and contribute nothing until they do. This mirrors Provision's pre-hire
split, where the horizon decides whether an account exists and `now` decides
whether it holds anything: **a scheduled grant never confers access before its
start date.**

### What the requester sees

The product, what it grants in plain terms, the current stage, and **who the
current stage is with, by display name**.

Naming the approver is a deliberate choice. Anonymous approval is worse than
visible approval: it makes chasing impossible, it makes "who allowed this" a
support ticket, and it removes the social accountability that makes an approver
read the request. The names shown are the subject's own manager chain, a product
owner, a resource owner, or a named group — facts the requester could establish
from the directory anyway.

They also see a **timeline**: submitted, each stage opened, each decision with its
comment, each notification sent, dispatched, fulfilled. The timeline is assembled
from the same rows the audit log records, so what the requester reads and what an
auditor reads cannot disagree.

### What they can cancel

**A requester may cancel until the request reaches `approved`, and not after.**

After approval the request is out of their hands — the grant may already be
mid-apply at a target, and a cancel that races a Provision action produces a state
nobody described. What a person does after approval is **hand the access back**,
which is a separate, recorded act: it revokes the grant, removes its term from
desired state, and the next Provision run proposes the revocation. The same
mechanism as expiry and the same audit shape — but a hand-back is one grant, so it
runs immediately rather than waiting for the nightly sweep, and it is subject to
Provision's guard on the target side and to no sweep guard at all. A guard exists
to catch mass action, and this is a person giving one thing back.

Cancelling notifies the approvers of the open stage, so they stop looking at it. A
cancelled request cannot be resurrected; asking again is a new request, which
keeps the decision record honest about what was asked and when.

### Requesting on behalf of somebody

Two routes, both audited, both producing a request whose `subjectPersonId` and
`requestedByUserId` differ:

- The subject's **manager**, resolved through `Contract.managerPersonId`, needs no
  permission. A manager asking for their report is the ordinary case.
- Anybody else needs `automate.request_on_behalf`. Helpdesk, HR, onboarding.

Three rules attach:

1. **The subject is always notified at submission.** Not on approval — at
   submission, before anybody decides. A request made for you that you were never
   told about is the shape of a privilege escalation, and the notification is the
   thing that makes it visible while it can still be stopped.
2. **The submitter is never a deciding approver** on that request, by any path.
   Section 9.
3. The catalog and the audience rule are the **subject's**. Section 6.

### When the subject changes underneath the request

The case that forces an answer, because the naive implementation — resolve
everything at submission, apply at approval — grants finance access to somebody
who left finance three days ago.

**Eligibility is re-evaluated at each stage opening and again immediately before
fulfilment.** The evaluation is the audience condition plus the subject's
employment state, both cheap and both pure.

| Change | Outcome |
|---|---|
| The audience no longer admits the subject | The request is `rejected`, reason `no_longer_eligible`, naming what changed. The requester, the subject, and every approver who already decided are told — the last of these because somebody's approval was just made moot and they should know why. |
| The subject's contracts have all ended | `rejected`, reason `subject_departed`. |
| The subject's person record is inactive | `rejected`, reason `subject_inactive`. |
| The subject already holds **every** resource the product grants | `rejected`, reason `already_held`, naming where each holding comes from — a rule, an earlier request, or a hand grant. Refused rather than silently fulfilled into a no-op, because a person who asks for something they already have has a different problem and deserves to be told what it is. |
| The subject already holds **some** of what the product grants | Not a refusal. The already-held items are marked `skipped` with the reason and the source of the existing holding; the rest are fulfilled. The request reaches `fulfilled`, and the notification names what was already held so the requester is not left wondering. |
| The subject's manager changed while a stage is open | The open stage is **re-resolved and reassigned**, and both the outgoing and incoming approver are told. Decisions already recorded on **completed** stages stand — they were valid when made. |
| The product's workflow or grants were edited | Nothing. A request carries a **snapshot** of the workflow and the `ProductGrant` set it was submitted under, as `RequestItem` and `ApprovalStep` rows written at submission. |
| The product was retired | In-flight requests are `rejected`, reason `product_withdrawn`. Existing grants are untouched — retiring a catalog entry is not a decision to revoke what it already granted, and pretending otherwise would make retiring a product a mass revocation with no review. |

The snapshot rule is the same principle as Directory Sync's materialized
`SyncChange` and Provision's materialized `ProvisionAction`: **what was reviewed is
what is applied, literally.** An approver approved a specific set of resources
under a specific chain. Editing the product afterwards must not change what their
signature meant.

---

## 8. Approval workflows

A **workflow** is an ordered list of **stages**. A request instantiates it at
submission as `ApprovalStep` rows — the snapshot of section 7 — and walks them in
order. A stage completes when its quorum is met. A rejection at any stage ends the
request; there is no "reject and continue".

### Resolving approvers

A stage names an approver **selector** from a closed set. No scripting, for the
same reason Provision refuses scripted business rules: the expression that decides
who may allow access has to be readable by somebody who did not write it,
diffable, and evaluable in a unit test.

| Selector | Resolves to |
|---|---|
| `manager` | The manager of the subject's resolved contract. |
| `managerChain(n)` | The n-th manager up from the subject, 1 ≤ n ≤ 5. |
| `productOwner` | The product's owner person, or every member of its owner group. |
| `resourceOwner` | The owner recorded for the resource being granted. |
| `role` | Every holder of a named Syntra role. |
| `group` | Every member of a named group. |
| `person` | One named person. |

**Which contract supplies the manager.** `resolveContractForMapping` in
`packages/core/src/identity/contract-service.ts` — the primary contract if
currently active, otherwise the active contract with the lowest sequence number.
Reused, not reimplemented. Access uses it for claims, Provision uses it for account
attributes, and a person's approval chain disagreeing with their SAML assertion
about who their manager is would be a support call nobody can close.

**The manager chain is cycle-safe.** `Contract.managerPersonId` is a self-reference
with no database-level acyclicity check, exactly like `OrgUnit.parentId`, and
`resolveApplicationIdsForUser`'s `orgUnitChain` already carries a depth cap and a
seen-set for that reason. The manager walk carries the same, capped at
`MAX_MANAGER_DEPTH = 16`. A cycle terminates the walk rather than hanging every
approval in the tenant.

**`resourceOwner` needs an owner to exist.** A `ResourceOwner` table keyed on
`(resourceType, resourceId)` records it — deliberately a separate table rather than
a column added to `Entitlement`, `Application` and `Group`, because two of those
three are owned by other subsystems and adding a column to a table another
subsystem rewrites every night is how a boundary erodes.

**A stage using `manager`, `managerChain` or `resourceOwner` must declare a
`fallbackSelector`**, and the workflow will not save without one. These are the
three selectors that legitimately resolve to nobody: a person with no manager, a
chain shorter than n, a resource whose owner was never recorded. Validating this at
save time is the same discipline that makes Provision validate its grace-period
ordering when the target is saved — the alternative is discovering it at 3am on
somebody's request.

### Quorum

Per stage: `any` (default — the first decision decides the stage) or `all` (every
resolved approver must approve).

`all` is refused at save time on a selector that could resolve to more than
`maxApprovers` (default 10). A stage requiring the unanimous approval of a
400-member group never completes, and a workflow that cannot complete is a request
that sits forever.

### Auto-grant

**A workflow with zero stages grants immediately.** Not a flag, not a special case
— the empty list is the mechanism, the same way Provision expresses "matches
everybody" as an empty `all`.

The catalog shows such a product as "granted immediately" so the requester knows
before they ask. Configuring one is a privileged action with an audit event
recording the before and after, because a workflow edited from two stages to zero
is functionally the same act as approving everything that product will ever grant.

### Absence, delegation and escalation

These are design decisions, not features to leave for later, because each one is a
path into the approval control.

**Delegation.** Any user may record an `ApprovalDelegation`: a delegate, a start,
an end, and optionally a restriction to one product category.

- **A delegation adds an approver; it never replaces one.** While a delegation is
  active, a stage routed to the delegator is routed to the delegator *and* the
  delegate. Either may act; under `any` quorum whoever acts first decides. Under
  `all` quorum the pair counts once — the delegator's obligation is satisfied by
  either of them, which is what a delegation means. The decision records who
  actually decided and that they acted as a delegate for whom.
  Replacement is the tempting design, and it is rejected here rather than in
  section 19 because the argument is inseparable from how delegation works. It
  hides an approval from the person accountable for it. A stale delegation that
  nobody remembers silently removes somebody from their own approvals for as long
  as it runs. And it is the cleanest self-approval path anybody will find in this
  system: persuade your manager to delegate to you for a week, and every request
  you raise arrives in your own queue with the nominal approver never seeing one
  of them. Adding is strictly safer, and the audit still records who decided.
- **Delegation is not transitive.** A delegates to B, B delegates to C: C is not an
  approver of A's steps. Depth 1, enforced when the delegation is created.
- **An end date is required**, and the span may not exceed `maxDelegationDays`
  (default 90). An indefinite delegation is a permanent transfer of authority that
  nobody ever re-decides.
- Creating, editing and ending a delegation are privileged, audited acts, and both
  parties are notified at start and at end.
- A delegation may be created by the delegator, or by an administrator holding
  `automate.manage` on their behalf — for the manager who went on leave without
  setting one, which is the case this feature exists for.

**Escalation.** Each stage carries `slaHours` and `onTimeout`:

- `remind` (**the default**) — notify the stage's approvers at 50% and 100% of the
  SLA, then daily, indefinitely. A request never stops asking.
- `escalate` — after the SLA, the stage's `escalationSelector` is resolved and
  those approvers are **added** to the stage. The original approvers remain, and
  **they are told they were escalated past.** Escalation that silently removes
  somebody's authority is how an approver discovers, months later, that decisions
  attributed to their team were not theirs.
- `expire` — after `expiryHours`, the request becomes `expired` and the requester
  is told, by name, with the reason and an invitation to resubmit. Opt-in per
  product, never the default, because a request that quietly evaporates is exactly
  the silent-drop failure this platform keeps rediscovering — and even opted into,
  it is loud.

**There is no timeout that approves.** Not configurable, not per product, not for
low-risk items. Approval by inattention is a privilege grant nobody made, and it
is the single most common way a self-service access product ends up unable to
answer an audit. Section 20 makes it a structural test rather than a promise: no
transition into `approved` exists that is not caused by a decision row.

**An approver who cannot act.** A resolved approver is **valid** only if they hold
a Syntra `User` that is `active`, and their `Person` holds at least one active
contract. A person with no `User` at all cannot sign in and therefore cannot
decide, so they are dropped too — which is the ordinary case of a manager who
exists in the HR record and has no account here. Anybody failing any of the three
is dropped from the resolved set at the moment of resolution and re-checked at the
moment of decision.

If dropping leaves the stage empty:

1. The stage's `fallbackSelector` is resolved and used.
2. If that is also empty, the request becomes **`blocked_no_approver`**. It appears
   on the administration dashboard, notifies the product owner and every holder of
   `automate.manage`, and stays there until somebody fixes the workflow, records a
   resource owner, or decides it by hand as an administrator — an act which is
   itself recorded as a decision with the administrator named, and which is subject
   to the invariant of section 9 like every other decision.

It never auto-approves, and it never sits silently. A disabled manager is the most
ordinary reason an approval chain breaks, and it is the one the design has to be
explicit about.

---

## 9. Approval integrity

Approval is a security control. The question "could a requester approve their own
request, through any path" gets a section, an invariant, an enumeration, and a
test that is hard to delete by accident.

### The invariant

> **No person may record a decision on a request in which they are the subject or
> the submitter.**

Three properties of how it is enforced matter as much as the rule:

- It is enforced **in the domain service**, in the function that records a
  decision, not in the resolver alone and never in the console. Router-level gating
  in React is cosmetic — Core says so about administrative routes and it is no
  less true here.
- It is enforced **at the moment of decision**, not only at the moment of
  resolution. A stage resolved on Monday and decided on Thursday is re-checked on
  Thursday, because the manager relation, the group membership and the account
  status all move.
- It is enforced as a **subtraction from the resolved set**, in one place, so that
  every selector inherits it. A rule applied per selector is a rule that the next
  selector forgets.

### Every path, and how each is closed

1. **Direct self-approval.** The subject is the resolved approver — they own the
   product, they own the resource, they are the named person. Dropped from the
   resolved set.
2. **Being your own manager.** `Contract.managerPersonId` pointing at the person
   themselves, or a manager cycle where A manages B and B manages A, so
   `managerChain(2)` returns A. The walk carries a seen-set and a depth cap, and
   the subject is dropped wherever in the chain they appear. A chain that collapses
   to empty falls through to the required `fallbackSelector`.
3. **Delegation.** The subject holds a delegation from the resolved approver.
   Because delegation *adds* rather than replaces, dropping the subject leaves the
   nominal approver in place and the stage still works. This is the concrete payoff
   of that decision: under replacement, anybody who could persuade their manager to
   delegate to them for a week could approve their own requests, and the nominal
   approver would never see one of them.
4. **Escalation.** The subject is the escalation target — a plausible accident when
   escalation goes to a role the subject happens to hold. Dropped the same way. If
   escalation resolves to nobody, the stage stays open and keeps reminding. It
   never auto-approves, which is why there is no timeout-approval anywhere in this
   design for that hole to fall through.
5. **A group or role selector the subject belongs to.** The subject is dropped from
   the membership. If they were the only member, the stage has no valid approver
   and the request becomes `blocked_no_approver` — which is the correct outcome,
   because a product whose only approver is the person asking is a
   misconfiguration, and it should be visible as one rather than resolved by
   pretending.
6. **The on-behalf submitter.** Dropped as well as the subject. A helpdesk agent who
   may raise a request for anybody must not be able to decide what they raised.
   This is the path a design that only checks the *subject* leaves open, and it is
   the more dangerous one, because the on-behalf permission is handed out widely.
7. **A disabled or departed approver acting on an old session.** Validity is
   re-checked at the decision. Deactivation revokes sessions in Core, which covers
   most of it; the check is repeated at the act because "most of it" is not a
   security control.
8. **Approving through the API rather than the console.** Authorisation is
   server-side, in the same domain function, on the same rule set. There is no
   second path.
9. **Editing your way to approval.** A holder of `automate.manage` can edit a
   product's workflow to zero stages, submit a request, and be granted. This cannot
   be prevented by the approval engine, because it is a legitimate power that
   somebody must hold. It is contained rather than prevented, and the containment
   is named honestly:
   - The workflow snapshot (section 7) means the edit must **precede** the
     submission, so the audit log shows the edit immediately followed by the
     request, by the same actor, on the same product.
   - `automate.manage` is a distinct permission from the ability to request, and an
     administrative session requires step-up MFA and carries a shorter idle
     timeout.
   - Every product and workflow change records before and after in the audit log.
   - Detecting the pattern is Govern's, and the record it needs exists.
10. **Two-stage laundering** — the subject decides stage 1 of somebody else's
    request, who decides stage 2 of theirs. Automate does not attempt to detect
    this, and says so rather than implying otherwise. It is a
    segregation-of-duties question, it needs a graph over decisions across
    requests and time, and that is Govern's. What Automate owes Govern is the
    record: every decision, with the deciding person, the subject, the submitter,
    the selector that resolved them, whether they acted as a delegate or an
    escalation target, and the time.

### The decision record

`ApprovalDecision` rows are append-only in the same sense as the audit log. A
decision is never updated and never deleted; a reversal is a new decision with its
own reason. Each one writes its `AuditEvent` in the same transaction as the
decision, per the platform rule.

**A rejection requires a comment.** A refusal with no reason is an unanswerable
support call and a request the person will simply raise again. An approval's
comment is optional.

---

## 10. Requested access and birthright access

Provision computes what a person should have from their contracts and is additive
by default, per ruling P2, so it tolerates access granted by hand. Requested access
is not access granted by hand — it is access granted by Syntra, with a record —
and the design treats it as first-class rather than as tolerated drift.

Section 5 gives the mechanism: the grant is a term in the union that forms desired
state. This section works through what that produces, because the two collisions
named in section 5 are the two rows of the matrix where a naive design does damage.

| Rule grants it | Active grant exists | Desired | What the console says |
|---|---|---|---|
| yes | no | held | "From rule *Finance staff*, via contract *Finance Analyst*." |
| no | yes | held | "Requested by Anna on 3 March, approved by Jan, until 30 June." |
| yes | yes | held | Both, listed. Neither is redundant: they end independently. |
| no | no | not held | Revocation proposed. |

**Collision 1 — a request grants something Provision would not grant.** Row two.
It is desired, so Provision does not revoke it in either enforcement mode, and it
is not a `DriftFinding`, because it is neither undocumented nor unexplained. Ruling
P2's requirement that additive mode must mean "I saw this and left it" rather than
"I did not look" is satisfied more strongly here than by drift reporting: Syntra
did not merely see it, it caused it, and can name who approved it.

**Collision 2 — a contract change removes something a person separately
requested.** Row three becoming row two. The rule stops matching, the
rule-attributed term leaves, the grant term stays, and the entitlement stays. No
revocation is proposed. This is the same shape as Provision's own case of one
concurrent contract ending while another continues, and it gets the same answer for
the same reason: losing access because one of two independent reasons to hold it
went away is the bug.

The inverse, row three becoming row one — the grant expires while the rule still
matches — also proposes nothing. The notification the holder receives says the
grant ended **and that they still hold the access from their role**, because
telling somebody they lost something they did not lose is its own kind of defect.

### Movers

A person granted a finance folder because they were in finance, who moves to
facilities, still holds the grant. The rules stopped matching; the grant did not
expire.

**The grant survives, and is flagged.** `AccessGrant.needsReview` is set, with the
reason — the contract attribute that changed and the value it changed from — the
first time a sweep observes that the subject no longer satisfies the product's
audience condition. The grant's holder, the original approver, and the resource
owner are notified once, not repeatedly.

The alternative, revoking automatically on a department change, is rejected in
section 19. In short: somebody asked and somebody accountable allowed it, an HR
field changing is not a decision to reverse that, and a system that silently
removes approved access on an attribute change is a system whose users learn to
request everything twice.

But saying nothing is not an option either, and `needsReview` is what makes this
different from a leak. The flag is queryable, it appears on the person view, on the
resource owner's "resources you manage" page, and on the administration dashboard —
and it is precisely the input a recertification campaign consumes when Govern
exists. Automate flags; Govern campaigns.

### Leavers

Covered in section 12, because it is the same mechanism as expiry and belongs
beside it. In one line: **requested access ends when employment ends, on the day,
with no grace.**

---

## 11. Sweeps: the one thing Automate does in bulk

Single requests are guarded by approval. Two things are not single requests, and
both can touch thousands of people in one night:

- **Expiry** — grants whose `endsAt` has passed.
- **Lapse** — grants held by a person whose contracts have all ended.

A cohort granted the same access with the same end date at the start of a project
expires together. An HR import that ran against a staging database makes the whole
organization look like leavers. Both are the characteristic accident of this
subsystem and both are mass.

So a sweep is a **run**, in exactly the idiom Directory Sync and Provision
established: it computes, writes down one row per proposed removal, and stops.

### `ExpirySweep` and `SweepAction`

A nightly pg-boss job carrying `{ tenantId }` — a background job has no request and
therefore no ambient tenant.

```
load → classify → guard → apply
```

- **load** — grants, persons, contracts. Database only. No network anywhere in a
  sweep, which is what keeps it out of the transaction problem entirely.
- **classify** — pure. Each grant becomes an `expire` action, a `lapse` action, or
  nothing. Separately, and not as an action, a grant whose subject no longer
  satisfies the product's audience is marked `needsReview` (section 10). A flag is
  not a removal: it changes nothing about what the person holds, so it is not
  counted by the guard and cannot be skipped in the review screen.
- **guard** — pure. Below.
- **apply** — the only stage that writes.

Each `SweepAction` records the grant, the reason, the resource and the resulting
removal. Actions of kind `targetEntitlement` are applied by **removing the grant
term from desired state and enqueuing a Provision run** — Provision then plans and
applies the revocation under its own guard, its own per-entitlement axis, and its
own review. Actions of kind `application` and `localGroup` are applied by Automate
directly, in one short transaction each alongside their audit event.

### The guard

Provision's guard already covers the target half, thoroughly and on two axes. It
does not cover the Syntra-internal half, because those writes never reach
Provision. So Automate carries a guard over its own writes, in the same shape:

| Population | Denominator | Default threshold |
|---|---|---|
| Internal removals in one sweep | Active `application` and `localGroup` grants in the tenant | 10% |
| Removals of one product's grants | That product's current active grants | 50% |

Either axis tripping marks the sweep `requiresConfirmation`; it does not auto-apply
and the reason names the product, the count and the share. The per-product axis is
there for the reason Provision's per-entitlement axis is there: emptying one
product of its 90 holders is 0.2% of a large tenant and total for the 90.

Two conditions **block outright**, with no confirmation available:

- **The person population collapsed.** If the count of persons holding at least one
  active contract has fallen by more than `personPopulationDropPercent` (default
  20, the same number and the same reasoning as Provision's) since the last applied
  sweep, the sweep is refused. Every lapse action in a sweep is downstream of that
  count, and a truncated HR import is the accident most likely to produce a sweep
  that revokes everything. A tenant with no persons at all is refused
  unconditionally.
- **The first sweep in a tenant** always requires confirmation regardless of size,
  because every denominator is zero and no percentage can say anything about it.
  This is the hole Provision found in Directory Sync's guard, closed here at the
  start.

A blocked sweep is fully readable in the same review screen as any other, per-row
skip included, and confirmation is per sweep, recorded against the confirming user.
The scheduler never confirms anything.

---

## 12. Time-bounded access

### Declaring a duration

Per product:

| `durationMode` | Behaviour |
|---|---|
| `permanent` | The grant has no `endsAt`. Available, and the catalog editor says plainly that it means "until somebody takes it away". |
| `fixed` | Every grant runs `defaultDurationDays` from its start. |
| `requesterChoice` | The requester picks, bounded by `maxDurationDays`, defaulted to `defaultDurationDays`. |

`maxDurationDays` applies under `requesterChoice` and is validated on the form and
again at submission. An approver may **shorten** a duration when deciding — a
manager who will allow three weeks but not three months should be able to say so
without a rejection and a resubmission — and the shortened value is recorded on the
decision. An approver may not lengthen it.

A grant's `startsAt` is the moment of fulfilment, or a later date the requester
chose, or the subject's contract start where that is in the future. The last case is
the pre-hire: the grant is `scheduled`, confers nothing, and becomes `pending` on
the day. Provision's horizon logic already distinguishes "an account exists" from
"it holds anything", and a scheduled grant simply is not in the union until its
start date.

### When the date arrives

The nightly sweep of section 11 moves the grant to `expired`, removes its term from
desired state, and produces the removal.

Before that:

- **`expiryWarningDays`** — default `[7, 1]` per tenant. The holder and the original
  approver are notified, and the notification carries an **Extend** action.
- **Extension is a new request** against the same product, pre-filled with the
  original justification and pointing at the grant it would replace. It goes
  through the same workflow. If it is approved before the original expires, the new
  grant supersedes the old one (`supersededByGrantId`) and no removal is produced —
  which is the case worth testing, because a naive implementation expires the old
  grant, revokes at the target, and re-grants an hour later, producing an outage
  and two audit events that say the opposite of what happened.
- **Auto-renewal is rejected** (section 19). Renewal unless somebody objects is
  approval by inattention wearing a different hat.

When the removal lands, the holder is told what ended and how to ask again — and,
where a business rule still grants the same entitlement, told that they still hold
it and why.

### When the contract ends

This is where an access-management product either quietly leaks entitlements or
does its job.

**Every grant held by a person with no active contract, and none starting within
the pre-hire horizon, lapses on the person's latest contract end date — with no
grace period.**

The horizon is the target system's `preHireDays` for a `targetEntitlement` grant,
and the tenant's `preHireHorizonDays` for an `application` or `localGroup` grant,
which has no target to inherit from. Two horizons rather than one is not
duplication: a domain that needs an account three weeks early does not imply a
portal tile three weeks early, and inventing a target-derived number for an
internal grant would attach it to a target the grant has nothing to do with.

Three parts, each deliberate:

- **The latest end date across all their contracts**, not the earliest. A person
  whose second engagement ran three months longer left three months later. Same
  rule Provision anchors its ladder to.
- **No grace, even where the target's `disableGraceDays` is non-zero.** Provision
  graces a leaver's account and its birthright entitlements so the person can hand
  over from their own login. Requested access is by definition access beyond what
  the job required, and the least-privilege answer for the extra is that it goes
  first, on the day. This deliberately mirrors Provision's own split between mover
  revocations (immediate, because the person is present and can be asked) and
  leaver revocations (graced with the account): requested access at a departure is
  closer to the mover case, because it is the marginal access rather than the
  access the account exists for.
- **The honest escape hatch is a request.** If a departing person genuinely needs
  the extra access for a two-week handover, their manager requests it back, with a
  fourteen-day duration, through the same catalog, with an approval and an end
  date. That is a decision somebody made and can be shown to have made, which a
  grace period inherited from a target's configuration is not.

The three meanings of "no active contract" are Provision's, and Automate uses the
same classification rather than a second one:

- **Contracts exist, all ended** — a leaver. Grants lapse.
- **Contracts exist, all start beyond the horizon** — a future joiner. Nothing
  lapses. Grants already held are left alone and reported, because a grant held by
  somebody who has not started is a question, not an instruction.
- **No contracts at all** — an incomplete record, not a departure. **Nothing
  lapses.** The person appears on the sweep as a `SweepException`, by name, with the
  reason. This is the distinction Directory Sync got wrong once and Provision built
  its whole exception model around, and it is repeated here because the failure
  shape is identical: a person the system cannot understand must produce *no
  actions*, never *empty desired state*.

The holder is notified when their grants lapse; so are the resource owners, whose
list of who holds their resource just changed.

---

## 13. Notification

Core owns the notification service. Automate is its largest consumer, so the
ordering rule is stated once and enforced structurally.

**Render inside the transaction, send after it commits.** `renderMessage` is pure
and takes a tenant name as a parameter; `sendMessage` takes a transport and a
message and cannot be handed a `TenantClient`, because the signature was
deliberately changed after an SMTP round trip inside `prisma.$transaction` shipped
as a defect. Automate does not rely on that being remembered: the transaction
writes a **`NotificationOutbox`** row, and a job sends it afterwards.

The outbox is not ceremony. "The approver says they never got the mail" is the most
common support question a request system produces, and without a row it is
unanswerable. Each outbox row carries the template, the recipient, the request it
belongs to, attempts, last error, and sent time; it appears on the request timeline;
and a row that exhausts its attempts is surfaced, not swallowed.

### Who is told what

| Event | Recipients | Notes |
|---|---|---|
| Request submitted on somebody's behalf | The subject | Always, at submission, before any decision. Section 7. |
| Stage opened | The stage's valid approvers, and any active delegates | |
| Reminder | The same | At 50% and 100% of the SLA, then daily. |
| Escalated | The escalation approvers **and the original approvers** | The second half is what stops escalation being a silent removal of authority. |
| Approved | Requester, subject | |
| Rejected | Requester, subject, and approvers who already decided | With the reason, always. |
| Automatically refused | Requester, subject, and approvers who already decided | `no_longer_eligible`, `subject_departed`, `subject_inactive`, `already_held`, `product_withdrawn`. |
| Cancelled | The open stage's approvers | So they stop looking at it. |
| Fulfilled | Subject, requester | Names what they now hold and until when. |
| Partially fulfilled | Subject, requester, `automate.manage` | Names what did **not** land, and why. |
| Fulfilment failed | Subject, requester, `automate.manage` | Never batched, never digested. |
| Awaiting fulfilment past SLA | `automate.manage` | Section 5. |
| Blocked, no approver | Product owner, `automate.manage` | Section 8. |
| Expiry warning | Holder, original approver | With the Extend action. Section 12. |
| Expired | Holder, resource owner | Says whether the access actually went away. |
| Lapsed | Holder, resource owner, the person's most recent manager | Section 12. |
| Grant flagged for review | Holder, original approver, resource owner | Once, not repeatedly. Section 10. |
| Delegation started / ended | Delegator and delegate | Both ends, both times. |
| Sweep requires confirmation | `automate.manage` | Section 11. |

A per-user `NotificationPreference` allows an approver drowning in stage-opened
mail to choose a daily digest. **Failures, blocks and confirmations are never
digested**, regardless of preference — a digest is a convenience for routine
traffic, and the traffic that matters is the traffic that says something is stuck.

New templates live beside the existing five in
`packages/core/src/notify/templates`, in the same `{{placeholder}}` shape, with the
same rule that an unknown placeholder is left visible rather than rendered as
`undefined`.

---

## 14. Delegated administration

The ask is narrow and common: a team lead should be able to add and remove members
of their own group without being given the administration console.

### The shape

A **`ResourceDelegation`** records
`(resourceType, resourceId, delegate, capabilities, startsAt, endsAt)`. The
delegate is a person or a group. Capabilities come from a closed set:

- `view_members` — see who holds the resource.
- `approve` — act as the `resourceOwner` selector for requests granting it.
- `grant` — add somebody directly.
- `revoke` — remove somebody directly.

Six properties make this a delegation rather than a back door.

**It is a portal surface, not the console.** "Resources you manage" is a page in
the end-user portal under an ordinary portal session. No `/api/admin/*`, no
administrative scope, no step-up MFA, no lazily-loaded admin chunk. That is the
entire point of the feature, and it is the reason it cannot be implemented by
handing the team lead a scoped role.

**Every delegated act is an `AccessRequest`.** A direct grant by a delegated
manager creates a request with `productId` null, `resourceType` and `resourceId`
set, `origin` `delegated_admin`, no approval stages, and the acting person recorded
as the submitter. It fulfils down the same three paths, produces the same
`AccessGrant`, writes the same audit events, and answers the same "why does this
person hold this?" query.

The alternative — a direct membership write — is faster and forks the audit trail
and the fulfilment path in two. A group membership that exists because a team lead
added it, and cannot be told apart from one a rule produced, is precisely the
inventory gap Govern will be asked to close. A synthetic product per resource was
also considered and rejected: it would double the catalog with entries nobody
browses.

A delegated `revoke` is the same act inverted: it revokes the `AccessGrant`, which
removes the term from desired state, and the removal follows the ordinary path. A
delegated manager cannot revoke a holding that came from a business rule — that is
Provision's, and the console says so, naming the rule.

**Scope is per resource, never per type.** A delegation on the group *Finance
Reporting* says nothing about any other group. There is no "manage all groups"
delegation; that is a role, and roles live in the console.

**The resource's audience rule applies.** A delegated manager may only grant to
people the resource's own audience condition admits — where the resource is
reachable through a product, that product's condition; where it is not, the
delegation may carry its own `audienceCondition`. Without this, delegation is a
hole underneath section 6: give a team lead a group and they can put anybody in the
organization into it.

**Delegation is depth 1.** A delegated manager cannot delegate onwards, for the
same reason approval delegation is not transitive.

**Bulk is bounded by construction.** A delegated act naming more than
`delegatedBulkLimit` subjects (default 25) is refused, with a message pointing at
an administrator. The blast radius of a capability handed out to dozens of team
leads should be small enough that no guard is needed, and small enough that the
absence of one is not the reason it is safe.

Creating, editing and ending a delegation are privileged, audited administrative
acts. A delegation may carry an end date and expires with it.

---

## 15. Data model

New tables, all tenant-scoped under the same forced row-level security and the same
GUC-keyed policy as everything in Core. Every one carries `tenantId`.

### Settings

- **`AutomateSettings`** — one row per tenant, holding every number this design
  names so that none of them is a constant compiled into the code: `sweepSchedule`
  (cron), `sweepThresholdPercent` (10), `perProductSweepThresholdPercent` (50),
  `personPopulationDropPercent` (20), `fulfilmentSlaHours` (24),
  `expiryWarningDays` (`[7, 1]`), `preHireHorizonDays` (14, for grants with no
  target system), `maxDelegationDays` (90), `maxApprovers` (10),
  `delegatedBulkLimit` (25), `lastAppliedSweepAt`,
  `personsWithActiveContractAtLastSweep`.

  The last two are the denominator the population-collapse refusal compares
  against, and they are stored rather than recomputed for the same reason
  Provision stores `lastAppliedRunAt`: the comparison is against the last state
  somebody accepted, not against the last state observed.

  `MAX_MANAGER_DEPTH` is deliberately **not** here. It is a cycle-termination
  constant, not a policy, and a tenant that could raise it could hang its own
  approvals.

### Catalog

- **`Product`** — `name`, `slug`, `description`, `category`, `iconUrl`,
  `requestInstructions`, `kind`, `audienceCondition` (JSON, nullable — null means
  nobody), `workflowId`, `formSchema` (JSON), `durationMode`,
  `defaultDurationDays`, `maxDurationDays`, `ownerPersonId`, `ownerGroupId`,
  `status`, `createdAt`, `updatedAt`. Unique on `(tenantId, slug)`.
- **`ProductGrant`** — `productId`, `resourceType`
  (`entitlement` / `application` / `group`), `resourceId`, `targetSystemId`
  (nullable, set for `entitlement`), `optional` (for `resourcePicker` forms).
  Unique on `(tenantId, productId, resourceType, resourceId)`.

### Workflow

- **`ApprovalWorkflow`** — `name`, `description`, `enabled`.
- **`ApprovalStage`** — `workflowId`, `sequence`, `name`, `selector`,
  `selectorConfig` (JSON: the role, group, person or chain depth), `quorum`
  (`any` / `all`), `fallbackSelector`, `fallbackConfig` (JSON), `slaHours`,
  `onTimeout` (`remind` / `escalate` / `expire`), `escalationSelector`,
  `escalationConfig`, `expiryHours`. Unique on `(workflowId, sequence)`.

### Requests

- **`AccessRequest`** — `productId` (nullable — delegated acts, section 14),
  `subjectPersonId`, `requestedByUserId`, `origin` (`catalog` / `delegated_admin`),
  `justification`, `formValues` (JSON), `requestedDurationDays`, `status`,
  `statusReason`, `submittedAt`, `decidedAt`, `fulfilledAt`. Indexed on
  `(tenantId, status)` and `(tenantId, subjectPersonId)`.
- **`RequestItem`** — `requestId`, `resourceType`, `resourceId`, `targetSystemId`,
  `status` (`pending` / `dispatched` / `fulfilled` / `failed` / `skipped`),
  `provisionActionId` (nullable), `grantId` (nullable), `message`. **The snapshot of
  what was asked for**, written at submission, so editing the product afterwards
  changes nothing about this request.
- **`ApprovalStep`** — `requestId`, `sequence`, `stageSnapshot` (JSON: the whole
  stage as it stood at submission), `status` (`waiting` / `open` / `approved` /
  `rejected` / `skipped`), `openedAt`, `closedAt`, `slaDueAt`, `escalatedAt`.
- **`ApprovalStepApprover`** — `stepId`, `personId`, `via`
  (`selector` / `delegate` / `escalation` / `fallback`), `onBehalfOfPersonId`
  (nullable, the delegator). The materialized resolved set, which is what makes
  "who was this with, on the day" answerable a year later rather than recomputable
  against a directory that has since moved.
- **`ApprovalDecision`** — `stepId`, `personId`, `decision` (`approve` / `reject`),
  `comment`, `shortenedToDays` (nullable), `via`, `onBehalfOfPersonId`, `decidedAt`.
  Append-only: never updated, never deleted.
- **`ApprovalDelegation`** — `delegatorPersonId`, `delegatePersonId`, `category`
  (nullable), `startsAt`, `endsAt`, `createdByUserId`, `revokedAt`.

### Grants and ownership

- **`AccessGrant`** — `subjectPersonId`, `resourceType`, `resourceId`,
  `targetSystemId` (nullable), `origin` (`request` / `delegated_admin`),
  `requestId`, `startsAt`, `endsAt` (nullable), `status`, `statusReason`,
  `needsReview`, `reviewReason`, `supersededByGrantId` (nullable, for renewals),
  `createdAt`, `endedAt`.
  Indexed on `(tenantId, subjectPersonId, status)` — the read `desiredState`
  performs per person — and on `(tenantId, endsAt)` for the sweep.
- **`ResourceOwner`** — `resourceType`, `resourceId`, `ownerPersonId` or
  `ownerGroupId`. Unique on `(tenantId, resourceType, resourceId)`.
- **`ResourceDelegation`** — `resourceType`, `resourceId`, `delegatePersonId` or
  `delegateGroupId`, `capabilities` (string array), `audienceCondition` (JSON,
  nullable), `startsAt`, `endsAt`, `createdByUserId`.

### Sweeps and notification

- **`ExpirySweep`** — `status` (`running` / `previewed` / `blocked` / `applying` /
  `applied` / `partially_applied` / `failed`), `startedAt`, `finishedAt`, counts by
  action kind, `personsWithActiveContract`, `personsUnprocessable`,
  `requiresConfirmation`, `blockedReason`, `confirmedByUserId`, `error`.
- **`SweepAction`** — `sweepId`, `grantId`, `kind` (`expire` / `lapse`),
  `resourceType`, `resourceId`, `status` (`proposed` / `dispatched` / `applied` /
  `skipped` / `failed`), `provisionActionId` (nullable), `message`. Indexed on
  `(sweepId, status)`, which is how the apply loop reads it.
- **`SweepException`** — `sweepId`, `personId`, `kind`, `message`. The person with
  no contracts at all, by name. Section 12.
- **`NotificationOutbox`** — `template`, `to`, `vars` (JSON), `requestId`
  (nullable), `attempts`, `lastError`, `sentAt`. Section 13.
- **`NotificationPreference`** — `userId`, `mode` (`immediate` / `daily`).

### Changes to existing tables

Unlike Provision, this slice does change tables another subsystem owns, and the
changes are listed rather than absorbed:

- `AccountEntitlement.origin` gains `request`; the row gains
  `grantedByRequestId` (nullable).
- `Entitlement` gains `requestable` (default false), so a target's catalog can be
  published without publishing every group in the domain.
- `Application` and `Group` gain nothing. Their owners are recorded in
  `ResourceOwner`, deliberately, so that a table Directory Sync rewrites nightly
  gains no Automate column.
- `Person` and `Contract` are unchanged.

### Permissions

Added to the closed catalogue in `packages/core/src/rbac/permissions.ts`:

- `automate.read` — see the request queue, all products, all grants, the console.
- `automate.manage` — create and edit products, workflows, resource owners and
  delegations; confirm a sweep; decide a `blocked_no_approver` request.
- `automate.request_on_behalf` — submit for a person who is not you and not your
  report.

**Requesting for yourself needs no permission.** Every portal user may open the
catalog; what they can see there is the audience decision, and adding a permission
in front of it would make an unconfigured tenant's catalog empty for a second,
unrelated reason. **Approving needs no permission either** — approval authority
comes from resolution, not from RBAC, and a permission that granted it would be a
tenant-wide right to approve anything, which is not a thing anybody should hold.

---

## 16. Pipeline and transaction shape

Automate performs **no network I/O of its own**. It writes rows, enqueues jobs, and
hands messages to an outbox. Every remote call in the fulfilment path belongs to
Provision, inside Provision's own three-step shape. That is a security property —
no target credentials are reachable from the request path — and it is what makes
the transaction discipline here short and checkable.

**Submission** — one short transaction:

1. Validate the form against the schema, evaluate the audience, resolve the
   subject's user accounts.
2. Write `AccessRequest`, `RequestItem` rows, `ApprovalStep` rows with their stage
   snapshots.
3. Resolve stage 1's approvers and write `ApprovalStepApprover` rows.
4. Write the audit event.
5. Write `NotificationOutbox` rows.

All of it is database reads and writes over data already in PostgreSQL, so it fits
comfortably inside `withTenant`. Nothing renders a template against a remote
service; nothing sends anything.

**Decision** — one short transaction: re-check approver validity, write
`ApprovalDecision`, close or advance the step, resolve the next stage's approvers,
write the audit event, write the outbox rows. If this was the last stage, set
`approved`.

**Fulfilment** — one short transaction per path:

- `application` and `localGroup`: write the row, write the `AccessGrant` as
  `active`, write the audit event, mark the `RequestItem` fulfilled. Commit.
- `targetEntitlement`: write the `AccessGrant` as `pending`, mark the item
  `dispatched`, write the audit event, **enqueue the Provision run**. Commit. The
  enqueue is a pg-boss insert in the same PostgreSQL instance, so it commits or
  rolls back with the transaction, which is exactly why pg-boss was chosen.

**Reflection** — when a Provision run finishes, a handler reads the actions
carrying a `grantId` and, in one short transaction per grant, moves the grant to
`active` or the item to `failed`, updates the request's status, and writes the
outbox rows.

**Sweeps** — the phases of section 11, with the whole plan written in **one**
transaction so a sweep that fails partway writes no plan at all. There is no
readable state in which a sweep is `previewed` with no actions, or holds actions
while still `running`. This is Provision's phase 7 rule, and it is the rule that
makes a review screen trustworthy.

**Notification sending** — a job, outside every transaction, reading the outbox.

---

## 17. Administration and end-user surface

### End-user (portal)

- **Catalog** — browse by category, search, product detail with what it grants in
  plain language, the duration, and whether it needs approval and from whom. Every
  read through `visibleProducts`.
- **My requests** — status, the current stage and who it is with, the timeline, and
  cancel while cancellable.
- **My access** — every grant, where it came from, when it ends, an **extend**
  action, and a **hand it back** action.
- **My approvals** — the queue, with the subject, the product, the justification,
  the form answers, and what the subject already holds. Approve, reject with a
  required comment, or approve with a shortened duration.
- **My delegations** — record an absence, see delegations made to me.
- **Resources I manage** — section 14. Members, add, remove, and the review flags
  on grants of that resource.

### Administration console

- **Catalog editor**, with an **audience preview**: "visible to 412 of 1,180
  persons — show me who". The direct analogue of Provision's business-rule impact
  preview, and it exists for the same reason: an audience whose blast radius is
  only visible after saving is an audience that gets saved and then discovered.
- **Workflow editor**, with a **resolution preview**: pick a real person, see the
  chain this workflow produces for them — "stage 1: Jan de Vries (manager); stage
  2: Security Team (4 valid of 6 members; 2 dropped: inactive account, subject)".
  This is the screen that catches a workflow resolving to nobody, a fallback that
  is missing, and a stage where the subject is the only approver — before it is
  saved rather than at 3am on somebody's request.
- **Request queue** — every request in the tenant, filterable by status, product,
  subject and age, leading with the ones that are stuck: `blocked_no_approver`,
  `awaiting_fulfilment` past SLA, `fulfilment_failed`.
- **Request detail** — the timeline, the resolved approver set with the `via` of
  each, every decision and comment, every notification and whether it sent.
- **Sweep review** — a blocked sweep leads with why and the numbers behind it,
  names the product where the per-product axis tripped, groups actions by product
  and by person, and offers per-row skip and explicit confirmation.
- **Sweep exceptions** — by person, with the reason, on the sweep and on the
  dashboard.
- **Resource owners** and **resource delegations** — list, assign, time-bound.
- **Person detail**, extended: the "why does this person hold this?" view Provision
  built now answers with either a rule and a contract, or a request, its approver
  and its end date. It is the same screen, with the attribution union of section 5
  behind it, and that is the point of putting grants into desired state rather than
  beside it.

---

## 18. Security posture

- Approval authority comes from resolution, never from a permission, and the
  self-approval invariant is enforced in the domain service at decision time.
  Section 9.
- Catalog visibility fails closed, is enforced by one server-side resolver on every
  read path, and answers 404 rather than 403. Section 6.
- Automate holds no target-system credentials and opens no connection to one. The
  request path cannot reach a vault entry for a target.
- Every decision, delegation, product change, workflow change, grant, revocation
  and sweep confirmation writes an audit event in the same transaction as the act.
  Lowering a sweep threshold is a privileged action for the same reason Provision
  treats it as one: it is functionally the same as approving everything it would
  otherwise have caught.
- `ApprovalDecision` is append-only. A reversal is a new row.
- Audience conditions, form schemas and approver selectors are data, evaluated and
  validated by closed interpreters over closed field and operator sets. Nothing an
  administrator types is executed — that is the whole seam between this slice and
  the next.
- Administrative capability (`automate.manage`) is separate from the ability to
  request, and administrative sessions carry step-up MFA and a shorter idle
  timeout, per Core.
- Row-level security is the primary tenant isolation control on every new table.
- Bulk is bounded twice: sweeps by threshold and by outright refusal, delegated
  acts by a hard subject limit.

---

## 19. Rejected alternatives

Rejections belonging to one decision are stated with that decision: replacement
delegation and timeout approval in section 8, a cart in the decisions table of section 4, a direct
membership write for delegated administration in section 14, auto-renewal in
section 12. Six more are cross-cutting.

**Rejected — Automate writing to target systems directly.** The obvious design:
Automate has an approval, it knows the entitlement, the connector is right there.
It fails on ownership, and it fails the same way a second writer always does. A
requested grant written outside Provision's plan is drift to Provision's
reconciler, and in `authoritative` mode Provision revokes it the same night. The
fix would be a shared table of "grants Provision should ignore", which is the
`AccessGrant` table of this design with the fulfilment inverted and the guard,
retry, provenance marker and audit shape duplicated on both sides. Putting the
grant into desired state gets the same access with one writer, one guard, and one
answer to "why does this person hold this".

**Rejected — a workflow engine.** BPMN, or a general state machine with scripted
transitions and scripted approver resolution. It buys parallel branches,
conditional routing on form values, and the ability to express any process a tenant
can draw. It costs the property this design is built on: that the rule deciding who
may allow access is readable by somebody who did not write it. An approval chain
resolved by a script cannot be previewed, cannot be tested without a runtime,
cannot be audited by reading it, and becomes unmaintainable the moment its author
leaves. This is the same rejection Provision made of scripted business rules, and
the closed selector set here covers the cases real organizations actually
configure. Conditional routing on a form value — "over €5,000 needs finance" — is
the one genuine loss, and it is recovered by making it two products with two
audiences, which is also more honest about there being two different things being
asked for.

**Rejected — approval authority as an RBAC permission.** An `automate.approve`
permission is simple and is exactly wrong: it grants a tenant-wide right to approve
anything, which nobody should hold, and it detaches approval from the accountability
that makes it meaningful. Approval authority is a property of the relationship
between the approver and the request — manager, owner, named group — and it is
resolved per request. RBAC decides who administers Automate, not who may allow
access through it.

**Rejected — resolving approvers at decision time instead of materializing them.**
Fewer rows and always fresh. It makes "who was this with, on the Tuesday it was
sitting there" unanswerable, because the manager relation, the group membership and
the account statuses have all moved since. Materializing the resolved set is the
same principle as Directory Sync's materialized `SyncChange` and Provision's
`ProvisionAction`: the reviewable artifact has to exist as data, not as something
recomputable.

**Rejected — automatically revoking a request grant when the subject's contract
attributes change.** Tidy, and it makes requested access converge on birthright
access. It is rejected because somebody asked and somebody accountable allowed, and
an HR field changing is not a decision to reverse that. A department rename would
revoke every grant in the organization overnight. And a system that silently
removes approved access on an attribute change teaches its users to request
everything twice and hoard what they get. `needsReview` plus a notification plus
Govern's campaign is the answer: flagged, visible, and decided by a human.

**Rejected — an external ITSM as the approval front end.** ServiceNow, Jira Service
Management and Topdesk all have approval workflows, and many organizations already
run one. Integrating rather than building would be less code. It is rejected for
this slice because the approval decision would then live outside the hash-chained
audit log, in a system with its own retention, its own permission model and its own
notion of who a person is — and reconstructing an approval a year later would mean
reconciling two logs. An outbound integration that *notifies* an ITSM, and an API
that lets one submit requests, are both reasonable later work and are named in
section 21. The decision of record stays here.

---

## 20. Testing

Test-driven throughout: a failing test precedes the code that satisfies it. The
interesting logic is pure, deliberately, and that is where most of these live.

**Unit — the pure functions.**

- **Audience evaluation** across every operator and every new field, plus the two
  cases that decide the security of section 6: a null condition admitting nobody,
  and `{ all: [] }` admitting everybody with an active contract.
- **Approver resolution** across every selector: a subject with no manager falling
  to the fallback; a chain shorter than n; a manager cycle terminating; a group
  selector with some members inactive; a resource with no recorded owner; a stage
  that resolves to nobody producing `blocked_no_approver` rather than anything
  else.
- **The self-approval invariant, as a matrix rather than a set of cases.** A
  table-driven test over {selector} × {subject is approver, subject is delegate,
  subject is delegator, subject is escalation target, subject is sole group member,
  subject is submitter, subject is their own manager, subject is in a manager
  cycle} asserting that no resolved set and no accepted decision ever contains the
  subject or the submitter. This is the test that must fail if somebody later adds
  a selector and forgets the subtraction, which is why it is written over the
  selector list rather than as eight hand-written cases.
- **No transition into `approved` exists that is not caused by an
  `ApprovalDecision` row.** An exhaustive test over the request state machine, in
  the shape of Provision's structural never-deletes test, so that adding a
  timeout-approval later fails a test rather than passing review.
- **Duration arithmetic** at its boundaries: the day before, of and after
  `endsAt`; a shortened approval; an extension approved before and after the
  original expired; `maxDurationDays` enforced at the form and again at submission;
  a scheduled grant on each side of its start date.
- **The union with birthright**, as the four rows of section 10's matrix, plus the
  two transitions that are the collisions: a rule stopping while a grant continues
  proposing nothing, and a grant expiring while a rule continues proposing nothing
  and notifying accurately.
- **Leaver classification**, the three meanings of "no active contract": all ended
  produces lapse; all starting beyond the horizon produces nothing; no contracts at
  all produces a `SweepException` and **not** a lapse. That last assertion is the
  one that fails loudly if anybody ever collapses the two, and it is the same
  assertion Provision's suite carries for the same reason.
- **The sweep guard** at its boundaries: just under each threshold, exactly at it,
  just over; the per-product axis tripping while the tenant-wide axis does not; a
  first sweep with a zero denominator; the person-population drop; a tenant with no
  persons.

**Integration — against a real PostgreSQL, and for the target path a `FakeTarget`.**

- The full loop: submit, approve, grant enters desired state, a Provision run
  proposes the grant, applies it, and `AccountEntitlement` carries
  `origin = 'request'` and the request id.
- **Collision 1**: with the grant held, run Provision in `authoritative` mode and
  assert no revocation is proposed and no `DriftFinding` is written.
- **Collision 2**: change the subject's contract so the granting rule stops
  matching, run Provision, assert the entitlement is not revoked and the grant is
  flagged `needsReview` with one notification.
- **Expiry**: advance past `endsAt`, run the sweep, assert the revocation is
  proposed by Provision and applied, and the holder is told.
- **Expiry where a rule still grants it**: assert nothing is revoked and the
  notification says so.
- **Lapse**: end every contract, run the sweep, assert grants lapse on the latest
  end date with no grace even where `disableGraceDays` is 7.
- **Fulfilment failure**: a `FakeTarget` rejecting the grant permanently — the
  request becomes `fulfilment_failed`, the grant is not `active`, three parties are
  notified, and the console names the target's own message.
- **Supersession**: a Provision run superseded by a newer one — the request stays
  `awaiting_fulfilment`, the newer run re-proposes the grant, and the request
  fulfils. The case that looks like a failure and is not.
- **A synced group refused as a `localGroup` product** at configuration time,
  naming the owning source.
- **Tenant isolation**: a request, a grant and a product created in one tenant are
  invisible to another even when the query is written wrongly.

**Visibility, as its own suite.** A product whose audience excludes the caller
returns 404 from *every* read path — list, category browse, search, typeahead,
detail, the on-behalf picker, and the form's option lists — enumerated as a table
over the route list, so a route added later without the resolver fails a test.

**The transaction rule, as a test rather than a convention.** The test transport
fails the test if it is invoked while a database transaction is open. The defect
that shipped twice on this project — a network call inside `prisma.$transaction`
under a 5000 ms timeout — becomes a red test on the third attempt rather than a
production incident. The outbox makes this easy to satisfy: nothing in the request
path sends anything.

**End-to-end (Playwright).** Publish a product with a two-stage workflow; a user
requests it; the manager approves; the security group rejects and the requester
sees the reason. Then: an auto-granted product fulfilling immediately; a delegation
letting a colleague approve while the manager is away, with the audit showing who
actually decided; a team lead adding a member from the portal with no
administrative session; a grant approaching expiry, extended in place with no
outage; a blocked sweep reviewed and confirmed; and the person view answering "why
does this person hold this" with a rule for one entitlement and a request for
another.

---

## 21. Out of scope

**Deferred to Automate — Tasks** (the sibling document): dynamic form fields whose
options are computed against a live system, the scripted task engine, script
credentials and sandboxing, the Agent as a script executor, and request outcomes
that are actions rather than grants. A shared mailbox is requestable in this slice
only as the group or entitlement that confers access to it; creating a mailbox, a
distribution list, a home directory or a file share permission is a task, and this
slice runs nothing.

**Deferred to Govern:** recertification campaigns over the `needsReview` flags and
the grant inventory this slice produces; segregation-of-duties rules, including the
two-stage laundering pattern of section 9; owner attribution for orphan accounts;
and chasing findings to closure. Automate records and flags; Govern judges and
campaigns.

**Deferred to Provision — Sources:** where persons and contracts come from.
Automate reads them and does not care.

**Not in this slice at all:**

- A shopping cart spanning several products in one request. The console may group
  several requests visually; the requests remain separate.
- Conditional routing within one workflow on a form value. Expressed as two
  products with two audiences.
- Approval from Slack, Teams or email reply. The decision of record is made in
  Syntra; an outbound notification integration is reasonable later work.
- An inbound API for an external ITSM to submit requests, and an outbound
  integration that mirrors requests into one.
- Licence cost, budget and chargeback. A product does not know what it costs.
- Request analytics beyond the queue and its filters — time-to-approve reporting,
  approver responsiveness, catalog popularity.
- Multi-language product descriptions.
- Risk scoring, or automatic workflow selection by risk. A product names its
  workflow.
- Requests whose subject is a group rather than a person.
- Mobile push notification. SMTP is the only transport Core has.
