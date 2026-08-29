# Syntra Provision — Targets

**Date:** 2026-08-16
**Status:** Approved design
**Scope:** Sub-project 2 of the Syntra programme, first of its two slices

---

## 1. Purpose

Directory Sync brings people **in**. Provision pushes accounts and access **out**.

A person and their contracts describe what someone does for the organization.
Provision turns that description into accounts and entitlements in the systems
they need, and takes them away again when the description changes. A joiner gets
an account created and the access their job implies. A mover gets the access
their new job implies and loses the access their old one carried. A leaver gets
disabled. Nobody types any of it, and nobody has to remember to.

This is what HelloID calls provisioning, and it is the half of an identity
platform that produces **birthright access** — the access you get because of who
you are and what you do, as opposed to access you ask for, which is Automate's
job, or access somebody signs off on, which is Govern's.

It is also the half that can do real damage. Everything else in Syntra so far
reads the world or decides about it. This subsystem changes other people's
systems, in bulk, unattended, on a schedule, driven by an HR record that
somebody else maintains. The design is shaped accordingly.

### Success criteria

Done when a Syntra instance can:

1. Configure an Active Directory target system, test the connection, and
   discover the entitlements it offers.
2. Express business rules over contract attributes — department, job title,
   employer, location, cost centre — that determine who gets an account in that
   target and which entitlements they hold.
3. Compute, for every person, the accounts and entitlements they should hold,
   correctly for a person with several concurrent contracts.
4. Produce a reviewable plan: every proposed account creation, attribute update,
   entitlement grant and revocation, disable, enable and archive, with before and
   after state and the rule that caused it.
5. Apply that plan exactly as reviewed, or part of it, or none of it.
6. Create a real Active Directory account with a generated, unique
   `sAMAccountName` and UPN, in the right organizational unit, with an initial
   password the administrator never sees in the clear.
7. Carry a person through joiner, mover and leaver, including a rehire against
   their original account, a contract ending while another continues, a
   future-dated start, a retroactive correction, and a person with no active
   contract at all.
8. Refuse a run that would create, disable, archive, or strip entitlements from
   an implausible share of a target's population — measured per action type, and
   per entitlement, not only in aggregate.
9. Report a person it could not process, by name and reason, and leave that
   person's existing access untouched rather than inferring they have none.
10. Detect that a target system has drifted — an entitlement granted by hand, an
    account that vanished — and record it without silently reversing it.
11. Survive a target system being unreachable partway through an apply: retry
    what is retryable, mark what is not, and represent the partially applied run
    honestly.
12. Record every applied action in the hash-chained audit log.

---

## 2. Position in the programme

| Sub-project | Status | Relationship |
|---|---|---|
| **Core** | built | Persons, contracts, the directory, the vault, the scheduler, the audit log, `withTenant`. Provision is built on all of them. |
| **Directory Sync** | built | Provision inherits its connector interface and its evaluate-then-enforce shape. It is also the return path: see section 4. |
| **Access** | planned | Independent. Access consumes contract attributes for claims and policy; Provision consumes them for entitlements. Neither needs the other. |
| **Provision — Targets** | this document | Depends on Core and, for the Active Directory target, on the connector package Directory Sync built. |
| **Provision — Sources** | built 2026-08-29, sibling document | Depends on Core only. See below, and `2026-08-28-provision-sources-design.md`. |
| **Automate** | planned | Requested access, approvals, scripted tasks. Provision is birthright access; Automate is asked-for access. |
| **Govern** | planned | Consumes Provision's inventory and drift findings. See section 12. |

### Provision is two slices, and this is the first

Sub-project 2 as the Core design scoped it contains both halves of the flow:
source systems and snapshots that populate persons and contracts, and business
rules and target systems that push access outward. Built as one slice it is two
complete pipelines, two connector families, two guards and two administration
surfaces in a single cycle. That is not a cycle that ends.

**The seam is the person register.** Persons and contracts are a settled, built,
tested part of Core. Everything upstream of them is one slice; everything
downstream is another.

- **Provision — Sources** (sibling document, built 2026-08-29 — see
  `2026-08-28-provision-sources-design.md`): HR source systems, scheduled
  imports of persons and contracts, snapshots, duplicate detection and merging,
  and the same evaluate-then-enforce discipline applied to writing `Person` and
  `Contract` rows.
- **Provision — Targets** (this document): business rules, target systems,
  accounts, entitlements, the joiner–mover–leaver lifecycle, deprovisioning,
  reconciliation and drift.

Each delivers working software alone. Sources alone gives an organization a
person register fed nightly from its HR system, which Access immediately uses
for claims and authentication policy — a real capability with no dependency on
Targets. Targets alone gives rule-driven provisioning to Active Directory over a
person register maintained by hand, by API, or through the CSV importer that
already exists in `packages/core/src/identity/csv-import.ts` — which is how a
large share of real HR integrations work anyway, a nightly file drop.

**Targets is built first.** Two reasons. Sources alone adds no capability a user
can see: it fills a table faster than the CSV importer fills it, which is worth
having but is not a new thing the product does. Targets alone is the entire
value proposition of a provisioning module. And more importantly, every
irreversible decision in sub-project 2 — never delete, what the guard counts,
what an anchor is in a target, what happens to a person we cannot process —
lives in Targets. Those decisions should not wait behind a second import
pipeline, because their cost of being wrong is other people's systems.

The seam holds in the other direction too: nothing in this document reads a
source system, and nothing in Sources writes to a target. They meet at `Person`
and `Contract` and nowhere else.

---

## 3. Decisions

Settled during brainstorming; the implementation plan does not reopen them.

| Decision | Choice | Reasoning |
|---|---|---|
| Slicing | Two slices, seam at the person register, Targets first | Section 2. Each half is a whole pipeline; together they are not one cycle. |
| First target system | Active Directory | The hardest realistic target, and the one that closes a loop with software that already exists. Section 6. |
| Lifecycle model | Derived state, diffed. No lifecycle events. | An HR record is edited retroactively and out of order. A state function of the record at time *now* converges after any outage or correction; an event stream does not. Section 8. |
| Rule composition | Union across all active contracts | Core models concurrent contracts deliberately. First-match ordering would silently strip the access a second contract earns. Section 7. |
| Rule language | Declarative conditions over a closed field set, no scripting | The rules decide who gets access. Arbitrary code there is unauditable, untestable, and a sandbox problem. Section 7. |
| Account attributes | From an account profile, not from rules | Rules answer *whether*; the profile answers *what*. Two rules contributing conflicting attribute values is a class of bug that then does not arise. Section 7. |
| Plan storage | One materialized row per proposed action | Inherited from Directory Sync and restated in section 10. |
| Deletion | Never. Disable, then optionally archive. | Section 9. |
| Grace periods | Per target system, measured from the person's latest contract end date, disable defaulting to zero days | A leaver's access should end when their contract ends. Handover time is a deliberate choice an organization makes, not a default it inherits. Section 9. |
| Entitlement revocation timing | Mover revocations immediate, leaver revocations graced with the account | A mover is still present and can be asked. A leaver whose entitlements are stripped while their account stays live is neither in nor out. Section 9. |
| Guard populations | Per action type, and additionally per entitlement | The last slice learned that a small absolute count against a large denominator hides the total emptying of one population. Section 11. |
| Drift | Reported, not reversed, unless the target is explicitly authoritative | A provisioning engine that silently strips grants it did not make gets switched off. Section 12. |
| Unprocessable persons | Recorded by name, and excluded from the plan entirely | Directory Sync shipped the defect where absence was inferred from a mapping failure. The equivalent here is worse: it revokes access rather than deactivating a row. Section 13. |
| Account anchor | The target's own immutable object identifier | Section 5. |
| Retries | Inside the run that proposed the action | A generic retry queue applies actions outside the run that was reviewed, in an order nobody chose. Section 14. |
| Writing to Syntra's own directory | Not done, with one narrow exception | Section 4. |

---

## 4. What Provision writes, and what it does not

Three subsystems now touch accounts. It matters that they form a cycle with one
direction of flow rather than a set of competing writers.

```
  HR record ──▶ Person + Contract ──▶ Provision ──▶ Active Directory
                                                         │
                        Access ◀── Syntra User/Group ◀── Directory Sync
```

Provision writes to the **target system**. Directory Sync reads the target
system back into Syntra's own directory. Access grants applications from the
Syntra groups that arrive that way. No table has two writers.

This is a large part of why Active Directory is the first target rather than a
SaaS system: the return leg already exists and is tested, so the first slice of
Provision closes a loop instead of opening one.

Three consequences worth stating plainly, because each is a question somebody
will ask on the first day of use.

**A freshly provisioned person cannot sign in to Syntra until the next directory
sync.** Provision creates the account in Active Directory; the Syntra `User` for
it appears when the paired directory source next runs. This is not a defect of
either subsystem, it is the cost of one-directional flow, and the mitigation is
cheap: after a successful apply that created or enabled accounts, Provision
enqueues a run of the paired directory source. That is an existing job on an
existing queue, not a new mechanism.

**Provision does not create the Syntra `User`, and does not write Syntra group
memberships.** A synced `GroupMembership` is owned by its directory source and
rewritten every run; a second writer would lose that argument every night.
Provision writes the Active Directory group membership, and the Syntra
membership follows on the return leg. Correlation needs no special handling:
Directory Sync anchors on `objectGUID`, the account Provision created has never
been seen before, so it correlates as new and is created. An account that
collided with a locally managed Syntra login would be reported as a conflict by
the machinery that already exists for exactly that.

Once the Syntra `User` exists, Provision claims it: on each run, a
`TargetAccount` whose anchor matches a `User` carrying the same `sourceAnchor` on
the paired source, and whose `personId` is null, has that user's `personId` set
to the account's person. Ownership is established by the anchor both subsystems
already agree on, never by a name. A `User` that already carries a different
`personId` is left alone and reported as drift.

**The one exception: account status propagates inward.** When Provision disables
or archives an account whose target is paired with a directory source, and the
person holds a Syntra `User` owned by that source, the plan includes a
`deactivate_syntra_user` action; enabling proposes `reactivate_syntra_user`.
Nothing else about that user is written — not its mapped fields, not its
memberships, not its person link beyond the claim above.

This exception is not tidiness. Directory Sync maps no directory attribute onto
`status` — deliberately, since a mapping that could write `status` would be a
route around its guard — so an account disabled in Active Directory stays
`active` in Syntra. Without this action, a leaver whose Active Directory account
Provision has just disabled still holds a live Syntra login with a Syntra-held
password. That is a leaver who can still sign in, which is the precise thing this
subsystem exists to prevent.

The residual gap is real and is named here rather than hidden: an account
disabled in Active Directory *by an administrator*, outside Provision, still
leaves the Syntra user active. Closing it means Directory Sync learning to read
`userAccountControl` into status, which is a change to that subsystem and is out
of scope here.

---

## 5. Target systems and the write interface

### The connector

A target system is a connector plus configuration plus credentials, exactly as a
directory source is. The existing `Connector<C>` interface in
`packages/connectors/src/types.ts` already provides three of the four things a
target needs — `test`, `discoverSchema` and `read` — and declares the fourth,
`write`, which this slice gives its real shape.

`read` is not a leftover. It is how Provision learns what the target currently
holds, which is the input to reconciliation (section 12). The same paged,
anchor-normalising reader that Directory Sync uses to pull Active Directory into
Syntra is what Provision uses to ask the target what it thinks is true. A target
connector that could only write would have no way to converge.

Targets need one thing directories do not, so a target connector is a
`Connector<C>` plus one member:

```ts
interface TargetConnector<C> extends Connector<C> {
  /** The grantable things this target offers: groups, licences, roles. */
  listEntitlements(config: C): AsyncIterable<DiscoveredEntitlement>;
}

interface DiscoveredEntitlement {
  /** The target's immutable identifier. Never the display name. */
  externalId: string;
  type: 'group' | 'licence' | 'role';
  displayName: string;
  description?: string;
}
```

### `write`

`WriteOperation` as declared is a bag of attributes with no verb, which was the
right placeholder and is not a usable interface. Its real shape is a tagged
union, because the operations a target supports are genuinely different
operations and not one operation with a mode flag:

```ts
type WriteOperation =
  | { op: 'create_account'; actionId: string; correlationKey: string;
      attributes: Record<string, string[]>; enabled: boolean }
  | { op: 'update_account'; actionId: string; anchor: string;
      attributes: Record<string, string[]> }
  | { op: 'enable_account';  actionId: string; anchor: string }
  | { op: 'disable_account'; actionId: string; anchor: string; reason: string }
  | { op: 'archive_account'; actionId: string; anchor: string }
  | { op: 'rename_account';  actionId: string; anchor: string;
      correlationKey: string }
  | { op: 'grant_entitlement';  actionId: string; anchor: string;
      entitlementId: string }
  | { op: 'revoke_entitlement'; actionId: string; anchor: string;
      entitlementId: string };

interface WriteResult {
  ok: boolean;
  message: string;
  /** Present on a successful create: the target's identifier for the object. */
  anchor?: string;
  /**
   * Why it failed, in terms the run can act on. `transient` is retried,
   * `throttled` is retried after `retryAfterMs`, and nothing else is.
   */
  failure?: 'transient' | 'throttled' | 'conflict' | 'rejected'
          | 'unauthorized' | 'not_found';
  retryAfterMs?: number;
}
```

Widening `WriteOperation` and `WriteResult` breaks nothing: `write` has no
implementation anywhere, and the LDAP connector continues to leave it
unimplemented until it becomes the Active Directory target connector of
section 6.

Four things about this shape are load-bearing.

**`actionId` on every operation.** It is the id of the `ProvisionAction` row that
proposed this write, and the connector records it on the object it creates
wherever the target offers somewhere to put it. This is how a non-idempotent
create becomes safe to retry: see section 14.

**`update_account` carries the complete set of managed attributes**, not a delta.
The connector writes desired state. A connector that receives the same
`update_account` twice performs the same write twice and leaves the same result,
which is what makes retry free for the majority of operations.

**`create_account` carries a correlation key, not an anchor**, because the anchor
does not exist yet; the anchor comes back in the result. Every other operation
carries an anchor, because by then it does.

**`failure` is a closed set decided by the connector**, not a string the run
pattern-matches. Only the connector knows whether an LDAP `busy` or an HTTP 429
is worth another attempt. Getting this classification into the connector, where
the target-specific knowledge is, is what keeps the retry logic in the run
generic.

### The anchor

**The anchor of a target-system account is the target's own immutable object
identifier.** `objectGUID` in Active Directory. Never `sAMAccountName`, never the
user principal name, never the mail address, and never the distinguished name.

This is the same lesson Directory Sync learned one level up, and it costs more
here. A distinguished name changes when somebody moves between organizational
units, and a `sAMAccountName` or UPN changes when somebody marries, or when a
duplicate forces a rename. In Directory Sync, treating a name as identity
produced a spurious deactivation and a second account. In Provision it produces a
spurious *create*: Syntra loses track of the account it owns, decides the person
has none, and creates a second one — with a second mailbox, a second home
directory, and the original still live and still holding every entitlement, now
invisible to the engine that granted them. That is worse than a deactivation,
because it is not obviously wrong from the outside.

The same rule applies to **entitlements**, which is easy to forget.
`Entitlement.externalId` is the target's immutable identifier for the group,
licence or role — the group's `objectGUID`, not its name or DN. Renaming a group
must not read as "revoke this from all 400 holders and grant a new thing to all
400 of them", which is exactly what name-keyed entitlements produce, and exactly
the shape the guard would then have to talk somebody out of.

An account that does not exist yet has no anchor. Its `TargetAccount` row exists
in status `pending` with its correlation key reserved (section 6), so two runs
cannot generate the same login and the account has a durable identity in Syntra
before it has one in the target.

**Rejected — a Syntra-generated identifier written into the target as the
anchor.** Attractive because it is stable by construction and would work
identically across every target. It fails on the first target that has no
writable field to put it in, and on every account that already existed before
Syntra did — which is most of them, in every real deployment.

---

## 6. The Active Directory target

Specified in enough detail to build. It is deliberately the hard case.

**Rejected — Entra ID or Google Workspace as the first target.** Both are
substantially easier: REST over HTTPS, stable immutable object ids, PATCH
semantics that are naturally idempotent, entitlement catalogs that enumerate
cleanly, and delta queries. That ease is the argument against them. A design
proven against an idempotent, well-identified, always-reachable target teaches
nothing about non-idempotent creates, name generation, multi-step account
creation, or the difference between a target that is down and a target that is
empty. Active Directory has all four, and it is also what the target market
actually runs. Entra ID goes second, where it will either fit or reveal that the
interface was shaped around one target's quirks — a much cheaper thing to
discover with the design already proven against the harder one.

### Transport

The same `ldapts` connectivity Directory Sync already uses, with the same
`tlsMode`, certificate verification and timeout settings, and the same
vault-held bind credential. Writes require LDAPS or StartTLS unconditionally:
Active Directory refuses a password write over an unencrypted connection, and a
target that could be configured to write in the clear is a target that eventually
does.

Reachability is the one thing this target needs that Syntra does not yet have in
every deployment. Where the domain controller is reachable from the Syntra host,
the connector connects directly, which is what Directory Sync already does. Where
it is not, the on-premises Agent (sub-project 5) becomes the transport. The Agent
is therefore a *transport* for this connector, not a prerequisite for it, and
this slice does not build it.

### Account creation, which is not one operation

Creating a usable Active Directory account is three writes, and Active Directory
will refuse them in the wrong order:

1. `add` the user object at the computed DN, with `sAMAccountName`,
   `userPrincipalName`, `displayName`, `givenName`, `sn`, `mail` and the
   provenance marker, with `userAccountControl` set to `514` — a normal account,
   disabled.
2. `modify` `unicodePwd` with the generated initial password, UTF-16LE encoded
   and quote-wrapped as Active Directory requires. This is why the transport must
   be encrypted.
3. `modify` `userAccountControl` to `512` — a normal account, enabled — but only
   if the account is meant to be enabled now. A pre-hire (section 8) stops after
   step 2 and is enabled on its start date.

The connector performs all three inside one `create_account` operation and
returns the `objectGUID` from step 1. If step 2 or 3 fails, the operation returns
`ok: false` and the account exists but is unusable and disabled — which is the
right way round to fail. The next run sees an account carrying this action's
provenance marker, adopts it, and proposes the remaining steps as an
`update_account` and an `enable_account`. A half-created account is a recoverable
state, not an orphan.

### Names and uniqueness

`sAMAccountName` is capped at 20 characters, must be unique in the domain, and is
the thing a collision actually collides on. The account profile supplies a
template — `%person.givenName.first%.%person.familyName%`, lowercased, non-ASCII
folded, apostrophes and spaces stripped — and a uniqueness strategy. The strategy
tries the base value, then the base value with an incrementing numeric suffix, up
to a configured attempt limit, truncating from the right to stay within 20
characters while preserving the suffix.

Uniqueness is checked against both Syntra's reserved keys and the target's
current inventory, and it is enforced by a unique index on
`(tenantId, targetSystemId, correlationKey)` rather than by the code that
generates them. Two concurrent runs generating the same name for two different
people is a race the database refuses, not one the application is trusted to
avoid — the same discipline that makes the primary-contract constraint a partial
unique index in Core.

A generation that cannot produce a unique key within the attempt limit does not
pick something arbitrary. It makes that person unprocessable for that target
(section 13) and says so by name.

**A correlation key, once assigned, is never regenerated.** Somebody marrying
does not get a new login. Renaming an account breaks certificate subjects,
profile paths, file ownership, mailbox aliases and every downstream system that
keyed on it, and it is not the provisioning engine's decision to make on the
strength of a changed `familyName`. `rename_account` exists as an action type, is
disabled by default per target (`renameEnabled`), and when enabled is always
confirmable.

### Placement

The DN is computed from a template on the account profile that may reference
contract fields — `OU=%contract.department%,OU=Users,%baseDn%` — with a required
fallback container used when the template resolves to an empty value. A template
that resolves to a container that does not exist in the target does not create
it; the person becomes unprocessable and the run says which container was
missing. Silently creating organizational units in somebody else's domain is not
a thing this product does.

A move — a person changing department, and therefore container — is a `modifyDN`,
expressed as an `update_account` whose managed attributes include the computed
DN. The anchor is unchanged, which is the whole point of anchoring on
`objectGUID`.

### Entitlements

An Active Directory entitlement is a security group; `externalId` is the group's
`objectGUID`. `listEntitlements` enumerates groups under a configured search
base. `grant_entitlement` and `revoke_entitlement` are `modify` operations adding
or deleting a single
value on the group's `member` attribute — single-value modifications, never a
replace of the whole attribute, since a replace turns a lost race into a mass
revocation.

Two Active Directory specifics constrain this:

- **Primary group membership is not in `member`** and cannot be removed by
  writing to it. The primary group (`Domain Users`, normally) is excluded from
  the entitlement catalog, and an attempt to revoke it is rejected by the
  connector rather than attempted and failed.
- **Range retrieval.** Active Directory returns `member` on groups above 1500
  entries as `member;range=0-1499`, and `ldapts` does not implement range
  retrieval. This is a known, recorded gap in Directory Sync, and it lands here
  harder: a truncated membership read makes the reconciler believe 1500 people
  hold a group that 4000 people hold, and the missing 2500 look like grants that
  need making — or, if a rule stopped matching them, like nothing at all. The
  existing behaviour is to mark the record with `readFailure` rather than return
  a truncated one, and Provision honours that the same way the sync pipeline
  does: the entitlement is `unreadable`, every person a rule would grant or
  revoke it to is unprocessable for that target, and no grant or revoke of it is
  proposed in that run. **Range retrieval must be implemented before a domain
  with large groups can be provisioned**, and until it is, the failure is loud.

  **Amended 2026-08-16 under Ruling P1: it is implemented.**
  `readRangedAttribute` in `packages/connectors/src/ldap/range.ts` (Task 3, which
  lands before this connector) walks the windows until the server marks the last
  one with an asterisk. The `readFailure` treatment described above is unchanged
  and still the fallback — it now applies to a walk that *cannot be completed*
  rather than to every group above the limit. A partial membership is never
  returned; that is the whole reason the walk throws instead of handing back
  what it collected.

### Deprovisioning treatment

- `disable_account` sets bit 2 of `userAccountControl` and writes the reason into
  `info`, prefixed with the tenant and run.
- `archive_account` moves the object to the configured archive container, removes
  every entitlement Provision manages for it, and leaves the object, its mailbox
  and its file ownership intact.
- There is no delete operation on this connector. Not disabled, not
  configuration-gated: absent, so that no configuration mistake can produce one.

---

## 7. Business rules and desired state

### The shape of a rule

A business rule maps a condition over **one contract** to a set of entitlements
in **one target system**, and states whether a match requires an account there at
all.

```
BusinessRule {
  targetSystemId
  name
  condition        — a boolean expression over contract and person fields
  grantsAccount    — whether a match requires an account in this target
  entitlements[]   — the entitlements a match grants
}
```

A condition is a small declarative expression stored as JSON, validated by Zod,
and evaluated as a pure function:

```
condition := { all: [condition, ...] }
           | { any: [condition, ...] }
           | { not: condition }
           | { field, op, value }

field     := contract.department | contract.jobTitle | contract.costCentre
           | contract.employer   | contract.location  | contract.fte
           | person.status

op        := equals | notEquals | in | notIn | startsWith | contains
           | isEmpty | isNotEmpty | greaterThan | lessThan
```

String comparisons are case-insensitive and trim surrounding whitespace, because
HR data is typed by humans and `"Finance "` and `"finance"` are the same
department. `greaterThan` and `lessThan` apply only to `contract.fte`. An empty
`all` is true, which is how a birthright rule matching everybody with any active
contract is expressed without a special case.

**Rejected — regular-expression matching.** It is the operator everybody asks for
and it brings catastrophic backtracking into the code path that decides who has
access, on patterns typed by administrators. The closed operator set covers the
real cases; the ones it does not cover are usually a request for a cleaner HR
field.

**Rejected — scripted rules.** HelloID allows PowerShell in this position and it
is the single feature that makes a provisioning configuration impossible to
review, impossible to test, and impossible to reason about after the person who
wrote it leaves. A rule that decides access must be readable by somebody who did
not write it, diffable, and evaluable in a unit test without a runtime. Scripting
belongs in Automate, behind an approval, against a single request.

### Composition across concurrent contracts

**A rule is evaluated against each of the person's active contracts
independently, and the results are unioned.**

Core models concurrent contracts deliberately, and this is where that decision
pays. A researcher who is 0.6 FTE in the physics department and 0.4 FTE teaching
holds two contracts, and both are true at once. Union is the only composition
that gets that right: they need the physics shares and the teaching systems, and
losing either because the other was evaluated first is a bug that presents as
"the system took my access away" and gets diagnosed weeks later.

**Rejected — first-match rule ordering.** Simpler, familiar from firewall and
policy engines, and used by Syntra's own authentication policy. It is right
there — a policy decides one outcome for one login — and wrong here, where the
question is not "which rule applies" but "everything this person is entitled to".
Under first-match, adding a rule can silently remove access, which is the
property least tolerable in this subsystem.

**Rejected — deny rules.** A rule that removes an entitlement another rule
granted reintroduces ordering through the back door, and makes "why does this
person *not* have X" unanswerable without simulating the whole rule set in order.
Exclusions are expressed as conditions. Access somebody should not have despite
their contract is a segregation-of-duties question, and that is Govern's.

### Account attributes come from the profile, not from rules

Rules answer *whether* somebody gets an account. An **account profile** — one per
target system — answers *what that account looks like*: templates for the
correlation key, the UPN, the display name, the mail address, the container, and
any target-specific attributes.

Templates may reference person fields and contract fields. When a person holds
several concurrent contracts, exactly one supplies the values, resolved by the
same rule Access already uses for claim mappings: **the primary contract if it is
currently active, otherwise the active contract with the lowest sequence
number** — `resolveContractForMapping` in
`packages/core/src/identity/contract-service.ts`, reused rather than
reimplemented. A person with several contracts has one department printed in the
directory, and it is the same department their SAML assertion carries. Two
subsystems disagreeing about somebody's department is a support call nobody can
close.

Keeping attributes out of rules removes an entire class of failure. Two rules
both matching and both wanting to set `department` is a conflict that would have
to be resolved by priority, and priority is the mechanism that makes a rule set
unreadable. Under this split, no such conflict exists.

### Desired state

The whole of the above is one pure function:

```ts
desiredState(
  person, contracts, rules, profile, now, horizon
): {
  account: { required: boolean; attributes: Record<string, string[]>;
             enabledNow: boolean } | null
  entitlements: Set<entitlementId>
  attribution: Map<entitlementId, { ruleId: string; contractId: string }[]>
}
```

`attribution` is not an extra: it is what lets the console answer "why does this
person hold this?" with a rule name and a contract, which is the most-asked
question of any provisioning product and is unanswerable after the fact if the
reason is not recorded at the time.

---

## 8. The joiner–mover–leaver lifecycle

There are no joiner, mover and leaver *events* in this design. There is a desired
state computed from the person record as it stands, an actual state read from the
target, and a diff between them. Joiner, mover and leaver are names for shapes
that diff takes.

**Rejected — an event-driven lifecycle.** Reacting to "a contract ended" or "a
department changed" is the obvious model and it is the wrong one for this input.
An HR record is corrected retroactively, edited out of order, and occasionally
restored from backup. Every missed, duplicated or out-of-order event under that
model becomes permanent divergence that only a human notices. A state function
recomputed each run has no memory to corrupt: whatever happened upstream, the next
run converges. This is the same reasoning that made Directory Sync read the whole
directory every run instead of following a change cursor, and it is what makes
retroactive corrections a non-event below.

The hard cases, each of which is a test.

**Joiner.** No `TargetAccount` exists; rules produce `required: true`. The plan
proposes `create_account`, then the entitlement grants the rules produced.
Ordering within a person is fixed: account before entitlements, always, because a
grant needs an anchor.

**Mover.** The account exists. The rules now produce a different entitlement set
and the profile now produces different attributes. The plan proposes
`update_account` for the attribute differences — including a container change,
which in Active Directory is a move — plus grants for what is newly required and
revocations for what is no longer. **Mover revocations are immediate**: the person
is still present, the least-privilege answer is to take the old department's
access away now, and if it was a mistake they are there to say so.

**Leaver.** The person holds contracts and every one of them has ended — which is
one of the three meanings of "no active contract", and the only one that is a
departure; see the end of this section for the other two. Rules produce nothing,
so no account is required and the entitlement set is empty. The plan proposes the
deprovisioning ladder of section 9 on its grace timers, and — for a paired
target — `deactivate_syntra_user`.

**An account no longer required while the person is still employed.** A person
holds an active contract, but no rule for this target matches it any more: they
moved from finance to facilities and the finance system is not theirs. This is a
*mover*, not a leaver, and it is treated as one — the account is disabled
immediately, with no grace, and its entitlements revoked immediately. The leaver
grace timers are anchored to a contract end date, and this person does not have
one; inventing a departure date for them would be inventing data. The person is
present and can be asked, which is the same reasoning that makes mover revocations
immediate.

**Rehire.** The person's `TargetAccount` still exists, in status `disabled`,
because disabling never deleted the row and never deleted the object. A new
contract starts; desired state says an account is required; the diff proposes
`enable_account` **on the existing account**, not a create. Keying the account on
`(personId, targetSystemId)` is what makes this automatic rather than a special
case. The person gets their old login and their old files back, which is what
they and everybody around them expect.

The one qualification: **re-enabling an account that has been disabled for longer
than `reenableWithoutConfirmationDays` (default 7) is a confirmable action** and
never auto-applies. Inside that window a re-enable is almost always a correction —
a contract gap over a weekend, an HR record fixed the morning after — and should
just happen. Outside it, a real rehire deserves a look, because months of
accumulated entitlements are about to come back to life along with the login, and
because an account reappearing after six months is also the shape of a bad rule.

This is a separate setting from `disableGraceDays` and not derived from it. Tying
the two together would mean that the default `disableGraceDays` of zero makes
*every* re-enable confirmable, including the correction the morning after, which
is the opposite of what the window is for.

**A contract ending while another continues.** The union in section 7 handles it
without any special case: when contract A ends, A's rules stop matching and A's
entitlements leave the desired set; B's remain, so the account remains and B's
access remains. The proposed actions are exactly the revocations attributable to
A alone, and nothing else. This is the case a model flattened onto the user record
gets silently wrong in the dangerous direction — it usually revokes everything —
and it gets an explicit test.

**A future-dated start.** A contract beginning in three weeks is not active, so a
naive evaluation at `now` produces nothing and the account appears on the morning
of day one, or later. Real organizations need it ready before then.

Each target system carries `preHireDays`. Desired state is computed against two
dates: the **window** from `now` to `horizon = now + preHireDays` decides
**whether an account is required and what its attributes are**, and `now` decides
**whether that account is enabled and which entitlements it holds**. A person starting within the horizon therefore gets
their account created, named, placed and password-set — and left disabled, holding
nothing — and the run on their start date proposes `enable_account` and their
grants.

The requirement is asked over the window and not at the horizon alone, and that
is not pedantry. Asking only at `horizon` asks whether the person will still be
employed in `preHireDays` time, so somebody whose contract ends next Tuesday
answers *no* — and produces `required: false` while still at their desk, which is
the mover shape above and earns them an immediate disable and an immediate
revoke of everything, days before they leave and while their entitlements,
computed at `now`, are still desired. Over the window, `preHireDays` is purely
additive: it can bring an account forward and can never take one away, which is
the only behaviour a setting of that name can safely have.

The security property this preserves is worth being explicit about: **a pre-hire
never holds access before their start date.** Only the account object exists
early, disabled and empty, which is the thing that takes time to propagate through
mailbox provisioning and directory replication. Access itself is granted on the
day.

**A retroactive change.** HR corrects a record: a contract that ended last month
is recorded today, or a department change is backdated to the first of the year.
Because the desired state is recomputed from the record as it now stands and
diffed against reality, the correction lands on the next run with no replay and no
reconciliation script. There is no event that was missed, because there were never
any events.

What Provision cannot do is un-hold the access somebody held during the
intervening weeks. It does not pretend otherwise: a retroactive contract end whose
grace period had already elapsed before the run first observed it produces its
deprovisioning actions on that same run, and the run records that the departure
was observed late. That fact — access held after a contract ended — is a finding,
and findings are Govern's to campaign on.

There was a real argument for restarting the grace clock at the moment of
observation instead, so that a backdated leaver gets the same handover window as
an ordinary one. It lost because deprovisioning here is a *disable*, which is
reversible in one action, and because a second, hidden clock that can extend
somebody's access beyond what their record says is exactly the kind of mechanism
nobody remembers exists when they are trying to explain an audit finding. One
rule: the grace runs from the contract end date.

**A person with no active contract at all.** This is where a careless
implementation does damage, because "no active contract" has three completely
different meanings and only one of them is a leaver.

- **Contracts exist, all have ended.** A leaver. The ladder in section 9 applies.
- **Contracts exist, all start beyond the horizon.** A future joiner. Nothing is
  proposed and nothing is deprovisioned. If they somehow already hold an account,
  it is left exactly as it is and reported as drift, because an account belonging
  to somebody whose contract has not started is a question, not an instruction.
- **No contracts at all.** Not a departure. It is an incomplete record — a person
  created by hand and not finished, or an import that dropped the contract rows.
  The person is **unprocessable** (section 13): reported by name, and their
  existing accounts and entitlements are left untouched.

That last distinction is the entire lesson of the previous slice restated in this
subsystem's terms. Directory Sync computed absence as "not present in the mapped
set", so anything it failed to understand looked departed. The equivalent mistake
here is computing desired access as "whatever the rules produced", so a person
whose contracts failed to load produces an empty set, looks like a leaver, and
gets disabled and stripped. A person Provision cannot understand must produce *no
actions*, not *empty desired state*. The two are not the same, and the difference
is somebody's job.

---

## 9. Deprovisioning

### Provision never deletes

**No action Provision can take deletes an account or an entitlement object in a
target system.** Not after any grace period, not under any configuration, not on
any code path. The Active Directory connector has no delete operation to call.

Four reasons, in descending order of how much they matter.

The security objective is met without it. A disabled account cannot
authenticate, and it stops being able to at the moment the write lands. Deletion
adds nothing to the outcome that matters and takes away every option afterwards.

Deletion destroys things that are not the account. In Active Directory it takes
the mailbox, the home directory, the profile, the certificate bindings and the
security identifier that every file ACL in the organization references. Somebody
who left still owns documents, and their manager still needs them.

The failure mode of this subsystem is *mass* action. A misconfigured source, a
rule with an inverted condition, an HR export that ran against an empty staging
database — the characteristic accident here is not one wrong person, it is four
thousand. Every action Provision can take therefore has to be one that four
thousand instances of can be walked back. Disable satisfies that. Delete does not.

And an organization that genuinely must delete still can. It deletes in the target
system, deliberately, by hand, with whatever approval its own process requires.
Provision then reads the account as gone and records it — see below.

### The ladder

Per target system, three settings, all measured from **the latest end date across
the person's contracts** — the day they stopped being employed at all, not the day
their first contract ended, since a person whose second contract ran three months
longer left three months later.

The ladder applies only to a departure. An account that stopped being required
while the person is still employed is a mover and is handled immediately, per
section 8.

| Setting | Default | Effect |
|---|---|---|
| `entitlementRevocationDelayDays` | 0 | Leaver entitlement revocations wait this long. |
| `disableGraceDays` | 0 | The account is disabled this long after the end date. |
| `archiveAfterDays` | null | The account is archived this long after the end date. Null means never. |

`disableGraceDays` defaults to **zero**. A leaver's access ends on the day their
contract ends; that is what the contract end date means. Handover time is a choice
an organization makes explicitly, with a number it can be asked about, not a
default it inherits from a product.

The ordering `entitlementRevocationDelayDays <= disableGraceDays` and, when
`archiveAfterDays` is set, `disableGraceDays < archiveAfterDays`, is validated
when the target is saved. The alternative orderings describe states nobody wants:
an account whose entitlements were stripped a week before it was disabled belongs
to somebody who is still employed as far as the directory is concerned and cannot
do anything.

`archiveAfterDays` defaults to **null**, because archiving moves the object,
strips its remaining managed entitlements, and is the closest thing to destructive
in the ladder. It is opted into.

A grace period is a design decision and not an implementation knob because it
decides how long somebody who has left can still reach things. Making it visible
per target, constrained in its ordering, and defaulted to the tight end is the
decision; the number itself is the tenant's.

### When an account has vanished from the target

Reconciliation finds a `TargetAccount` whose anchor the target no longer returns.
The account is marked `missing_at_target` and a drift finding is recorded. If the
rules still require an account for that person, recreating it is a **confirmable**
action, never automatic. An account that vanished usually vanished because
somebody deleted it deliberately, and a provisioning engine that silently puts it
back the same night is a provisioning engine in an argument with an administrator,
at nightly resolution, that the administrator loses.

---

## 10. Evaluate then enforce

A run computes the entire plan, writes it down, and stops. Applying it is a
separate, explicit step. This is the shape Directory Sync established and it
transfers unchanged, but the reasons are worth stating in this subsystem's own
terms rather than pointed at, because two of them are stronger here.

**What was reviewed is what is applied, literally.** A run writes one
`ProvisionAction` row per proposed action, and applying walks those rows. The
review screen and the enforcement loop read the same table, so there is no version
of "the preview said one thing and the apply did another" that can arise from the
two disagreeing about the world. If the target changed between the two, the plan
is stale — but it is *knowably* stale and it is the thing that was approved,
rather than something recomputed at the moment of writing that nobody ever saw.

**The plan is the artifact of review, and review here is not optional.** A
directory sync applied wrongly makes a mess inside Syntra. A provisioning run
applied wrongly changes four thousand accounts in somebody else's Active
Directory. The first time a tenant configures a rule set, the only thing standing
between a misplaced condition and a domain-wide incident is a human reading a list
and recognising that 900 revocations is not what they meant. That list has to
exist as an artifact, not as a log of what already happened.

**A crash is survivable and resumable.** Each action carries its own status. A run
interrupted halfway leaves applied actions applied, unapplied ones proposed, and
at most one in-flight action to resolve. There is no need to work out where it got
to.

**Single actions can be skipped.** One conflicting person does not force the whole
run to be abandoned or applied wholesale.

**Rejected — recomputing the plan at apply time from a stored snapshot.** Fewer
rows, always fresh. It defeats the reason for splitting the two steps: the
approval attaches to a computation, not to a list, and a computation can produce
different output on a different day. Directory Sync rejected this for the same
reason and nothing about targets weakens the argument.

**Rejected — serialising the plan as one document.** Compact, unqueryable, and
all-or-nothing, which forecloses per-action skip and per-action retry.

### Staleness, and the one place Provision differs from Directory Sync

Directory Sync allows applying a run computed against a directory state that has
since moved: the changes are applied as reviewed, and freshness is the schedule's
problem. Provision does not.

**A target system has at most one run in a non-terminal state.** Starting a run
marks any still-`proposed` actions of an earlier run `superseded`. And a scheduled
run does not start while a run is awaiting review; the schedule records that it
skipped and why.

The difference is warranted because these actions have side effects in other
people's systems and they compound. Two overlapping plans against one target can
interleave a revocation from the older plan behind a grant from the newer one, and
the resulting state is one neither plan described and nobody approved. Superseding
is also cheap, because the newer run contains everything still true — a superseded
action that still needs doing reappears in the run that superseded it.

The skip rule matters for a different reason: without it, a target whose runs
require confirmation accumulates a queue of blocked runs that can never be
cleared, and the review screen becomes a thing people stop opening.

---

## 11. The guard

The guard decides whether a plan may be applied at all. It is a pure function of
the plan and a set of counts, it is not advisory, and `autoApply` does not
override it.

### What it counts

Directory Sync learned the hard way that a guard which counts only the obvious
population misses the dangerous one — membership removals sat entirely outside it
while user deactivations were carefully gated, and a wrong group filter could
empty every group in a tenant while sailing under the user threshold. That lesson
is built in here rather than discovered again.

Every consequential action type is its own population with its own denominator:

| Action type | Denominator | Default threshold |
|---|---|---|
| `create_account` | Accounts this target currently holds | 20% |
| `disable_account` | Active accounts this target holds | 10% |
| `archive_account` | Accounts this target holds | 2% |
| `revoke_entitlement` | Entitlement holdings this target holds | 10% |
| `deactivate_syntra_user` | Active Syntra users linked to this target | 10% |

Creates are guarded as well as removals, which Directory Sync does not do. A rule
whose condition inverted and now matches everybody proposes an account in the
finance system for the entire organization, and that is not a mess that gets
cleaned up by disabling them again — every one of those accounts leaves a mailbox,
a home directory and an audit trail behind it.

Populations not in the table — `update_account`, `enable_account`,
`grant_entitlement`, `rename_account`, `reactivate_syntra_user` — are not
threshold-guarded. They are additive or corrective, and a mass grant, while
undesirable, is visible in the plan and reversible by the next run. Rename and
re-enable have their own confirmation rules in sections 6 and 8.

### The second axis: per entitlement

A global revocation threshold is not enough, and this is the part the previous
slice's experience most directly informs. Revoking every holder of one entitlement
is the exact signature of a rule that stopped matching — a renamed department, a
changed job title string, a mistyped condition. In an organization with 40,000
holdings across 300 groups, emptying one group of its 90 members is 0.2% of the
total and passes a 10% global threshold without a murmur. For the 90 people it is
total.

So revocations are counted twice: globally, and **per entitlement against that
entitlement's own current holder count**, with `perEntitlementThresholdPercent`
defaulting to 50. Either axis tripping requires confirmation, and the reason names
the entitlement, the count and the share.

### The refusals that are not thresholds

Two conditions block outright, with no confirmation available, because there is
nothing an administrator could usefully confirm about them:

- **The target returned no accounts while Syntra believes it holds some.** An
  empty target and an unreachable one look identical from here, and the safe
  reading is the second. This is the direct analogue of Directory Sync's
  zero-records rule, and it matters more: at a target, "everything is gone" drives
  creates as well as disables.
- **The person population collapsed.** If the number of persons holding at least
  one active contract has fallen by more than `personPopulationDropPercent`
  (default 20) since the last successfully applied run, the run is refused. This
  is upstream of every leaver action in the plan, and it is the signature of a
  broken HR feed — a truncated export, an import that ran against a staging
  database — which is the accident most likely to produce a plan that disables
  everybody. A run with no persons at all is refused unconditionally. On a first
  run there is no previous population to compare against, and this test is
  skipped — a first run is separately confirmable in its entirety, below.

Additionally, a run against a target that **has never had a run applied** always
requires confirmation, regardless of size. A first run has a denominator of zero
for every population, so no percentage threshold can say anything about it, and
the first run is also the one where the rule set has never been proved against
real data. This closes the hole a zero denominator would otherwise open — the same
hole that, in Directory Sync's guard, is handled by skipping a population with no
denominator, which is right for a sync and not right for a first mass create.

### After the guard

A blocked run is fully readable, in the same review screen as any other. An
administrator sees exactly what it wanted to do and the numbers behind it, and
confirms explicitly. Confirmation is per run, not a setting, and the confirming
user is recorded on the run. The scheduler never confirms anything.

---

## 12. Reconciliation with reality

Every run begins by reading the target. Targets drift: somebody adds a person to a
group by hand at four in the afternoon because a deadline moved, an administrator
disables an account directly, a group is deleted, an account is deleted.

Reconciliation compares three things — what Syntra believes it granted, what the
target actually holds, and what the rules say should be held — and sorts the
differences into four kinds.

**Syntra granted it and the target has it.** Agreement. Nothing to do.

**Syntra granted it and the target does not have it.** Provision restores it. This
is not drift policing, it is convergence: Provision is authoritative for what
Provision granted, and a grant that silently disappeared — a failed write that
reported success, a restore from backup, somebody undoing it — is the subsystem's
own state having come apart, and putting it back is the whole job.

**The target has it and Provision never granted it.** Drift. What happens next
depends on the target's `enforcementMode`:

- `additive` (**the default**) — recorded as a `DriftFinding` and left alone.
- `authoritative` — proposed for revocation, but **only for entitlements within
  Provision's remit**, meaning entitlements named by at least one business rule
  for this target. A group no rule mentions is not Provision's business and is
  never revoked, in either mode.

Additive is the default because a provisioning engine that silently strips
anything it did not grant will be switched off inside a week, and rightly: the
hand grant at four in the afternoon was somebody solving a real problem, and
reversing it at two in the morning without telling anybody is how a product loses
the trust it needs to be allowed near a domain controller. The remit restriction
applies in both modes because "Provision manages this target" and "Provision
manages every group in this target" are different claims, and only the first is
ever true.

**The target has an account that belongs to no person Syntra knows.** An orphan.
Provision records it and does nothing else.

### The seam with Govern

Provision converges what it manages and inventories what it does not. It does not
judge.

Deciding whether an orphan should exist, attributing it to a human owner, running
a recertification campaign that asks a manager to confirm their team's access,
detecting that somebody can both raise and approve a payment, and chasing findings
to closure — all of that is Govern. What Provision owes Govern is a durable,
queryable, per-tenant inventory of who holds what in which target and why:
`TargetAccount`, `Entitlement`, `AccountEntitlement` with its `origin` and its
granting rule, and `DriftFinding`. That inventory is a genuine deliverable of this
slice even before Govern exists, because it is also what answers "who has access
to the finance system" when somebody asks — today, by hand, from the console.

---

## 13. Persons Provision cannot process

A person Provision cannot fully evaluate for a target is **excluded from that
target's plan entirely** and reported by name. Their existing accounts and
entitlements there are not touched: not granted, not revoked, not disabled.

The distinction this preserves is between *this person should have nothing* and
*we could not work out what this person should have*. Those produce identical
empty sets and opposite correct behaviours. Directory Sync shipped the version of
this bug where a mapping failure was computed as absence and proposed deactivating
exactly the people whose records had a missing attribute. Here the same shape
proposes revoking their access, which is faster to notice and harder to undo.

A person becomes unprocessable for a target when:

- They hold no contracts at all (section 8).
- A business rule for that target names an entitlement that is `missing` or
  `unreadable` in the target's catalog. **The whole rule is unresolvable, not just
  that entitlement** — quietly evaluating the rule without its missing entitlement
  produces a desired set that lacks it, and the diff then proposes revoking it
  from everybody who holds it. A rule that cannot be fully resolved produces no
  desired state at all, for any person it would have been evaluated against.
- An account profile template references a field that resolves to nothing and has
  no fallback, or a container that does not exist in the target.
- Name generation could not produce a unique correlation key within the attempt
  limit.
- The target could not be read completely enough to diff against safely for that
  person — an account the connector saw but could not read in full.
- Their `TargetAccount` is in status `conflict` (below).

Each one writes a `ProvisionException` row naming the person, the target, the kind
and the reason. This is deliberately a table and not the count-plus-distinct-
reasons pair that `SyncRun` carries: with a directory of objects, knowing that
eleven records failed to map for two distinct reasons is enough to act on. With
people, the only useful question is *which* eleven, and the answer needs to be a
list a human can work down.

The run surfaces the count prominently, and the Apply screen shows it. An
exception is not a warning to be scrolled past: every person on that list is a
person whose access is frozen until somebody fixes something.

### Conflicts

A `create_account` whose correlation key already exists in the target, on an
account that does not carry this action's provenance marker, is a **conflict**.
The `TargetAccount` is marked `conflict`, no write happens, and an administrator
resolves it by linking the existing account to the person or by changing the name
generation.

It is never a silent adoption, for the same reason Directory Sync refuses one:
anybody able to create an object in the target could otherwise choose a name that
causes Syntra to hand them an existing person's account, along with every
entitlement the rules will then grant it.

---

## 14. Failure, retry, and partial application

A target system is remote, on somebody else's network, and will be down.

### What is idempotent

Most of it, by construction. `update_account` carries the complete managed
attribute set, so writing it twice writes the same state twice.
`grant_entitlement` and `revoke_entitlement` are set operations — granting a held
entitlement and revoking an unheld
one are both successes, not errors, and the connector reports them as such.
`enable_account`, `disable_account` and `archive_account` assert a state rather
than toggling one.

`create_account` is the exception and the whole problem. Active Directory has no
idempotency key, and a create whose response was lost has either happened or not,
with no way to ask.

**The provenance marker solves it.** Every `create_account` writes the tenant id
and the originating `actionId` into a configured attribute on the object it
creates — `info` in Active Directory, or a nominated `extensionAttribute`. On
retry, the connector looks up the correlation key first:

- Not present — the create did not happen. Perform it.
- Present, carrying **this** `actionId` — our own previous attempt succeeded and
  we lost the answer. Adopt it, return its anchor, and continue with whatever
  steps of the creation sequence remain.
- Present, carrying anything else or nothing — somebody else's account with our
  chosen name. A conflict (section 13). Never adopted.

This is what makes a non-idempotent create safe to retry without either creating a
duplicate or capturing a stranger's account.

### What is retried

Classification comes from the connector, in the closed `failure` set of section 5.

- `transient` — retried within the run, up to `maxAttempts` (default 3), with
  exponential backoff and jitter.
- `throttled` — retried, honouring `retryAfterMs` where the target supplies one,
  and not counted against `maxAttempts`. Writes against a single target run at a
  bounded concurrency (default 4) for the same reason.
- `conflict`, `rejected`, `unauthorized`, `not_found` — **never retried.** A
  duplicate name, a schema violation, a refused password complexity, a revoked
  service credential and a deleted entitlement do not become true on the fourth
  attempt. They are marked `failed` with the target's own message, and they need a
  human.

An action that exhausts its retries within the run is left `pending_retry` rather
than `failed`, and the next run for that target picks it up — provided the plan
still wants it, which is the point: an action pending retry that the next
evaluation no longer proposes is `superseded`, not attempted. A target that was
down for a night does not come back to a queue of decisions made against last
night's facts.

**Rejected — a generic outbox with independent retries.** Decoupling actions from
their run is the standard distributed-systems answer and it is wrong here for one
reason: it applies actions outside the run that was reviewed, in an order nobody
chose, at a time nobody expected. The review guarantee of section 10 is worth more
than the delivery guarantee, and retry-within-the-run plus re-planning by the next
run recovers most of the delivery guarantee anyway.

### The transaction shape, and the in-flight state

The platform rule is absolute: **no network call inside a Prisma interactive
transaction.** `withTenant` is `prisma.$transaction(fn)` under Prisma's 5000 ms
default, and a whole directory read once sat inside one, which made that subsystem
unable to work against a real directory. A target write is slower and less
reliable than a directory read.

So each action that calls a connector — every type but the two Syntra-directory
ones named in section 15 — is applied in three steps:

1. One short `withTenant`: mark the action `in_flight`, write the audit event
   recording the *intent*, commit.
2. The connector call. No transaction is held. No database connection is held.
3. One short `withTenant`: write the outcome onto the action, update
   `TargetAccount` or `AccountEntitlement`, write the audit event recording the
   *result*, commit.

Step 3 commits the state change and its audit event together, which keeps Core's
rule that a privileged action and its record land in one transaction.

There is an honest gap between steps 2 and 3 that no amount of transaction
discipline closes, because the target is not in the database and cannot join a
transaction. **The `in_flight` marker is what makes that gap observable rather
than silent.** An action found `in_flight` at the start of a run — because a
process died, a container was rescheduled, a deploy happened mid-apply — is in an
*unknown* state, not a failed one, and the run resolves it before planning
anything: it reads the target and asks whether the write landed, using the
provenance marker for creates and plain state comparison for everything else.

Recording the intent before the call rather than only the outcome after it is what
makes this possible. An audit log that only records completions cannot distinguish
"we never tried" from "we tried and never found out".

### Ordering

Within a person: create the account, then attribute updates, then grants, then
revocations, then disable, then archive. Revocations precede disable so that a
leaver's access is gone before the account stops being writable in the way
archiving makes it. Across persons the actions are independent and run at the
target's concurrency limit.

### A partially applied run

Represented as Directory Sync represents one, because the shape was right.
`ProvisionRun.status` is one of `running`, `previewed`, `blocked`, `applying`,
`applied`, `partially_applied` or `failed`. A run reaches `applied` only when
every action it proposed reached a terminal state and none failed; anything else
that started applying ends `partially_applied`, and the run detail names what did
not land and why. Action statuses are `proposed`, `in_flight`, `applied`,
`skipped`, `failed`, `pending_retry`, `conflict` and `superseded`.

---

## 15. Data model

New tables, all tenant-scoped under the same forced row-level security and the
same GUC-keyed policy as everything in Core. Every one carries `tenantId`; none of
them is filtered by a `where` clause in application code alone.

### Configuration

- **`TargetSystem`** — `name`, `type` (`activeDirectory`), `config` (JSON: URL,
  TLS mode, certificate verification, bind DN, base DN, entitlement search base,
  archive container, provenance attribute, page size, timeouts), `secretName`
  naming the vault entry holding the bind credential, `pairedDirectorySourceId`
  (nullable), `schedule`, `autoApply`, `enforcementMode` (`additive` /
  `authoritative`), `preHireDays`, `entitlementRevocationDelayDays`,
  `disableGraceDays`, `archiveAfterDays`, `reenableWithoutConfirmationDays`, the
  five threshold percentages of section 11, `perEntitlementThresholdPercent`,
  `personPopulationDropPercent`, `maxAttempts`, `concurrency`, `renameEnabled`,
  `enabled`, `lastRunAt`, `lastAppliedRunAt`.

  The bind credential is never on this row. It lives in the Core vault and is
  fetched at run time, exactly as a directory source's bind password is, so a
  target can be read and edited without exposing it.

- **`AccountProfile`** — one per target: `correlationKeyTemplate`,
  `uniquenessStrategy`, `maxUniquenessAttempts`, `containerTemplate`,
  `fallbackContainer`, `attributeTemplates` (JSON), `initialPasswordPolicy`,
  `initialPasswordDelivery` (`manager` / `personalEmail` / `vaultOnly`).

- **`BusinessRule`** — `targetSystemId`, `name`, `description`, `condition`
  (JSON), `grantsAccount`, `enabled`.

- **`RuleEntitlement`** — `ruleId`, `entitlementId`. A join table, so that "which
  rules grant this entitlement" is a query rather than a scan over JSON.

### Inventory

- **`Entitlement`** — `targetSystemId`, `externalId` (the target's immutable id),
  `type`, `displayName`, `description`, `status` (`present` / `missing` /
  `unreadable`), `holderCount`, `lastSeenAt`.
  Unique on `(tenantId, targetSystemId, externalId)`.

- **`TargetAccount`** — `targetSystemId`, `personId`, `anchor` (null until the
  account exists), `correlationKey`, `status` (`pending` / `active` / `disabled` /
  `archived` / `missing_at_target` / `conflict`), `statusReason`, `disabledAt`,
  `disableDueAt`, `archiveDueAt`, `createdActionId`, `lastReconciledAt`,
  `lastAppliedAttributes` (JSON).
  Unique on `(tenantId, targetSystemId, personId)` — one account per person per
  target, which is what makes a rehire find its own account.
  Unique on `(tenantId, targetSystemId, correlationKey)` — the reservation that
  makes name generation safe against concurrency in the database rather than in
  the code.
  Unique on `(tenantId, targetSystemId, anchor)` where `anchor` is not null.

- **`AccountEntitlement`** — `accountId`, `entitlementId`, `origin` (`rule` /
  `manual` / `discovered`), `grantedByRuleId` (nullable), `grantedAt`,
  `revokedAt`, `state` (`held` / `revoked`).
  `origin` is what separates convergence from drift, and it is not derivable after
  the fact, so it is recorded at the moment of the grant.

### Runs

- **`ProvisionRun`** — `targetSystemId`, `status`, `startedAt`, `finishedAt`,
  counts by action type, `personsEvaluated`, `personsWithActiveContract`,
  `personsUnprocessable`, `accountsReadFromTarget`, `entitlementsReadFromTarget`,
  `requiresConfirmation`, `blockedReason`, `confirmedByUserId`, `error`.

- **`ProvisionAction`** — `runId`, `actionType`, `personId` (nullable),
  `accountId` (nullable), `entitlementId` (nullable), `before` JSON, `after` JSON,
  `attributedRuleIds` (array), `status`, `attempts`, `nextAttemptAt`, `message`,
  `appliedAt`.
  Indexed on `(runId, status)`, which is how the apply loop reads it — Directory
  Sync indexed its equivalent on `(runId, changeType)` and then queried by status.

  Action types: `create_account`, `update_account`, `enable_account`,
  `disable_account`, `archive_account`, `rename_account`, `grant_entitlement`,
  `revoke_entitlement`, `deactivate_syntra_user`, `reactivate_syntra_user`.
  **There is no delete of any kind, and no type that could become one.**

  Every action type maps one-to-one onto a `WriteOperation` of section 5, with two
  exceptions: `deactivate_syntra_user` and `reactivate_syntra_user` call no
  connector at all. They are writes to Syntra's own directory, per section 4, and
  are therefore the only two actions that apply inside a single transaction with
  their audit event and need no in-flight resolution.

- **`ProvisionException`** — `runId`, `personId`, `targetSystemId`, `kind`,
  `message`. Section 13.

- **`DriftFinding`** — `runId`, `targetSystemId`, `accountId` (nullable),
  `entitlementId` (nullable), `kind` (`unmanaged_entitlement` / `missing_grant` /
  `orphan_account` / `account_missing_at_target` / `unexpected_status`), `detail`
  JSON, `status` (`open` / `acknowledged` / `resolved`), `firstSeenAt`,
  `lastSeenAt`. A finding that persists across runs is updated rather than
  duplicated, so the count on the dashboard is a count of problems and not a count
  of runs.

### Changes to existing tables

None. `Person`, `Contract` and `User` are unchanged, which is the return on having
established the person and contract model in Core rather than here.

---

## 16. Pipeline and transaction shape

Six stages, each a module with its own tests.

```
load → evaluate → reconcile → plan → guard → enforce
```

- **load** — reads persons, contracts, rules, the profile and Syntra's own
  inventory from the database, and reads accounts and entitlement holdings from
  the target over the network. The only stage before `enforce` that does I/O.
- **evaluate** — desired state per person. Pure.
- **reconcile** — merges the target's inventory with Syntra's belief into an
  actual state, and emits drift findings. Pure.
- **plan** — desired minus actual, with the grace timers applied, ordered, with
  exceptions extracted. Pure.
- **guard** — section 11. Pure.
- **enforce** — the only stage that writes to a target.

The four stages between loading and enforcing are pure functions over data, which
is the same property that made Directory Sync's interesting logic exhaustively
testable without a server or a database. Everything genuinely hard here — the
multi-contract union, the grace arithmetic, the rehire, the pre-hire horizon, the
guard's two axes, the drift classification — is in those four stages and is tested
with plain values.

### Phasing

A run is a pg-boss job carrying `{ tenantId, targetSystemId }`, because a
background job has no request and therefore no ambient tenant.

The phases mirror `previewRun`'s, for the same reason and under the same rule: no
`tx` handle crosses a phase boundary, and nothing that touches the network is
inside one.

1. Create the `ProvisionRun` row, so there is something to mark `failed` however
   the rest gives out. One short transaction.
2. Read configuration and credentials. One short transaction; returns plain data,
   deliberately not a `tx`.
3. Resolve any `in_flight` actions from a previous run (section 14). Target reads,
   no transaction.
4. Read the target: accounts and entitlement holdings. Network. No transaction.
   Slow, and holding no database connection while it runs.
5. Snapshot the database side — persons, contracts, rules, profile, inventory — in
   one short transaction.
6. Evaluate, reconcile, plan and guard. Pure. No transaction, no I/O.
7. Write every `ProvisionAction`, every `ProvisionException`, every `DriftFinding`
   and the run's terminal status **in one transaction**, so that a run which fails
   partway writes no plan at all. There is no readable state in which a run is
   `previewed` with no actions, or holds actions while still `running`.

Enforcement is a separate entry point, and its per-action three-step shape is in
section 14. It is not merged back into the preview phases: one long transaction
around a target read is precisely the bug this phasing exists to prevent.

---

## 17. Administration surface

- **Target systems** list and editor, with a **Test connection** action that
  reports what it found before anything is saved, and a **Refresh entitlements**
  action that populates the catalog.
- **Account profile** editor with a **live preview**: pick a real person, see the
  correlation key, UPN, display name and container the templates would produce for
  them, and whether that key is already taken. A template language nobody can try
  is a template language everybody gets wrong.
- **Business rule** editor with an **impact preview**, computed without writing
  anything: "this rule matches 412 of 1,180 persons; enabling it would grant 412
  entitlements and revoke 3." A rule whose blast radius is only visible after it
  is saved is a rule that gets saved and then discovered.
- **Run history**, and a run detail screen that groups actions **both** by type and
  by person, with before and after values, the rules each action is attributed to,
  an **Apply** action, and per-action skip. Grouping by person is what an
  administrator actually reads: "what is about to happen to Anna" is the question,
  not "how many revocations are there".
- A **blocked run** leads with why and the numbers behind it, per tripped
  population, naming the entitlement where the per-entitlement axis tripped.
- An **Exceptions** tab, listed by person, whose count appears on the Apply screen.
- A **Drift** tab, with acknowledge and resolve, and a filter for orphan accounts.
- A **person detail** view answering **why does this person hold this?** — every
  account and entitlement, its origin, the rule that granted it, and the contract
  that satisfied the rule. This is the single most-asked question of a provisioning
  product, and it is cheap here only because attribution was recorded at evaluation
  time.
- Wherever a target-managed value appears, it renders read-only and names the
  target that owns it, the same way synced directory fields do.

---

## 18. Security posture

- Target credentials in the Core vault, never on the `TargetSystem` row, never
  returned by any API once written, only replaced. Borrowing a saved credential
  for a connection test requires the transport — URL, TLS mode and certificate
  setting — to match the saved target, so that a test cannot be pointed at an
  attacker-controlled socket to harvest the credential. This is the rule Directory
  Sync arrived at after a security review, and it is adopted here at the start
  rather than after.
- **The generated initial password is a secret and is treated as one.** It is
  generated with `crypto.randomBytes`, sealed into the vault, and delivered once —
  to the person's manager, or to their personal email address, or to neither if
  the target's delivery mode is `vaultOnly` — through Core's notification service.
  It is never written to a `ProvisionAction`, never to an audit payload, never to
  a log line, and never returned by an API.
- Writes to Active Directory require an encrypted transport unconditionally.
- Every applied action writes an audit event in the same transaction as the state
  change it records, plus an intent event before the call (section 14).
- Every configuration change — a target, a profile, a rule, a threshold, an
  enforcement mode — is a privileged action with an audit event in the same
  transaction, because lowering a threshold is functionally the same as approving
  everything it would otherwise have caught.
- Confirming a blocked run records the confirming user on the run.
- The service account Provision binds with should hold only the rights it needs —
  create, modify and move within the configured containers, and modify membership
  on the configured groups. The documentation says so, and `test` reports which of
  those rights it could not exercise, so an over-privileged bind is a visible
  choice rather than a default.
- Row-level security as the primary tenant isolation control on every new table.
- Rule conditions are data, evaluated by a closed interpreter over a closed field
  and operator set. Nothing an administrator types is executed.

---

## 19. Alternatives considered and rejected

Rejections belonging to a single decision are stated where that decision is: the
event-driven lifecycle in section 8, first-match ordering, deny rules and scripted
rules in section 7, recomputation at apply time and a serialized plan in
section 10, the generic outbox in section 14, Entra ID as the first target in
section 6, and a Syntra-generated anchor in section 5. Three more are
cross-cutting.

**Rejected — treating Syntra's own directory as a target system.** Elegant on
paper: Syntra groups and application assignments are entitlements like any other,
and one mechanism would cover both. It fails on ownership. A synced
`GroupMembership` is owned by its directory source and rewritten every run, so
Provision and Directory Sync would write the same rows with different opinions,
every night, and whichever ran last would win. The flow in section 4 reaches the
same outcome with one writer per table: Provision writes the Active Directory
group, Directory Sync brings the membership back, Access grants applications from
it.

**Rejected — a single global guard threshold across all action types.** One number
is easier to explain and easier to configure. It is also exactly the defect the
previous slice shipped: a destructive action type with a small absolute count
disappears against a large aggregate denominator, and the population that gets
wiped is the one nobody was counting. Per-type denominators, plus the
per-entitlement axis, cost a table in the configuration screen and are the
difference between a guard and a formality.

**Rejected — deleting accounts after a long grace period, as a configurable
option.** The argument for it is real: data-protection regimes require erasure, and
organizations do want a leaver's account gone eventually. It is rejected because a
configurable delete is still a delete, and the accident this subsystem produces is
a mass one. Erasure is a deliberate, per-person, human decision made in the target
system with the target system's own controls, and Provision reports the result
rather than causing it.

---

## 20. Testing

Test-driven throughout: a failing test precedes the code that satisfies it.

**Unit — the pure stages, which is where the design lives.**

- Condition evaluation across every operator, including the empty `all`, the
  case-insensitive and whitespace-trimming string comparisons, and `isEmpty`
  against null versus empty string.
- Desired state over the full contract matrix, each case explicit: one active
  contract; two concurrent contracts producing a union; one of two ending while
  the other continues; a contract starting inside the pre-hire horizon; one
  starting beyond it; all contracts ended; a contract ended retroactively; and a
  person with no contracts at all, which must produce an exception and not an
  empty desired state. That last assertion is the one that fails loudly if
  somebody ever collapses the two.
- The two cases that look alike and are not: a person whose contracts have all
  ended, who gets the graced leaver ladder; and a person still holding an active
  contract that no rule matches any more, who gets an immediate mover disable with
  no grace at all.
- Attribute resolution across concurrent contracts, asserting it agrees with
  `resolveContractForMapping` rather than reimplementing the precedence.
- Name generation: a clean name, a collision, a collision chain, a name needing
  truncation to fit 20 characters with its suffix intact, a name of non-ASCII
  characters, and exhaustion of the attempt limit producing an exception.
- Grace arithmetic at its boundaries: the day before, the day of and the day after
  each of the three timers; a person with two contracts ending three months apart,
  whose timers must run from the later one; a contract whose end date is already
  past all three when first observed; and a re-enable on each side of
  `reenableWithoutConfirmationDays`.
- The guard at its boundaries: just under each threshold, exactly at it, just
  over; the per-entitlement axis tripping while the global axis does not; a first
  run against a target with a zero denominator; zero accounts read; and the person
  population drop.
- Reconciliation producing each of the four outcomes, and the remit restriction
  refusing to revoke an entitlement no rule mentions even in `authoritative` mode.

**Integration — against a real directory.** A containerized Samba Active Directory
domain controller, which is heavier than the OpenLDAP container Directory Sync
uses and is necessary: `sAMAccountName` uniqueness, `userAccountControl`,
`unicodePwd` over TLS and `modifyDN` are the behaviours under test, and OpenLDAP
has none of them. Covered: a first run creating an account and its groups; a
second run being a no-op; a department change moving the account between
containers without changing the anchor; a grant and a revoke; a leaver disabling;
a rehire re-enabling the same account rather than creating a second; and a name
collision reported as a conflict rather than adopted.

**Connector-level failure injection** — an in-memory `FakeTarget` implementing
`TargetConnector`, with programmable failures: a transient error that succeeds on
retry; a permanent rejection that is not retried; a throttle with a retry-after; a
create that succeeds at the target but loses its response, proving the provenance
marker adopts rather than duplicates; a create that lands under a name somebody
else owns, proving it conflicts rather than adopts; and a target that returns
nothing at all.

**Crash recovery** — kill the process mid-apply, restart, and assert that the
`in_flight` action is resolved against the target rather than retried blind or
marked failed.

**Guard, as scenarios rather than units** — a run that would disable everybody is
blocked, and stays blocked with `autoApply` on; a run that would empty one group
of all its members is blocked even though it is a fraction of a percent of total
holdings; a run against a target that returned zero accounts is refused outright
and cannot be confirmed.

**Never-deletes, structurally** — an exhaustive test over the action-type union
asserting that no member of it maps to a destructive target operation, so that
adding one later fails a test rather than passing review.

**Loop integration with Directory Sync** — provision an account into Active
Directory, run the paired directory source, and assert that Syntra creates the
user, that Provision claims it for the person on the next run, and that a
subsequent disable propagates inward to the Syntra user.

**End-to-end** — Playwright over configuring a target, seeding an account profile,
writing a rule, previewing its impact, reviewing a run, applying part of it,
applying the rest, confirming a blocked run, and reading the "why does this person
hold this?" view.

---

## 21. Out of scope

**Deferred to Provision — Sources** (the sibling document): HR source systems,
scheduled person and contract imports, snapshots, duplicate detection and merging.
Persons and contracts continue to arrive by hand, by API, or through Core's CSV
importer.

**Deferred to Automate:** requested access, approval workflows, dynamic forms and
scripted tasks. Provision is birthright access — what you get because of your
contract. Anything anybody has to ask for is Automate's.

**Deferred to Govern:** recertification campaigns, segregation-of-duties rules,
orphan account remediation, owner attribution, and chasing drift findings to
closure. Provision inventories and reports; Govern judges and campaigns.

**Deferred to the Agent (sub-project 5):** an outbound-connecting transport for a
target that is not reachable from the Syntra host. The Active Directory connector
speaks to a reachable domain controller directly in this slice.

**Not in this slice at all:** Entra ID, Google Workspace and SaaS target
connectors; SCIM as an outbound protocol; password synchronization to targets;
mailbox, home-directory and file-share operations beyond the archive move the
Active Directory target performs; delegated approval of individual provisioning
actions; simulating a rule change against historical data; reading
`userAccountControl` into Syntra's user status, which is a Directory Sync change.

**Amended 2026-08-16 under Ruling P1.** Active Directory range retrieval was
listed above as out of scope. It is not: Ruling P1 makes it a prerequisite of
this slice rather than a parallel gap, because Provision *writes*, and a
truncated group read makes 2,500 people look like they need grants or like
nothing at all -- and either reading drives writes to a real directory. It is
implemented in `packages/connectors/src/ldap/range.ts` by Task 3 of the
implementation plan, placed before the Active Directory connector and before
enforcement. The ruling post-dates this section and is the later decision.
