# Adopting a conflicted account

Status: approved design, not yet implemented
Base: `ad41c7f` (v1.7.0)

## Why

`conflict` is a state an account can reach and never leave.

`apply.ts` sets it when a create is refused because the object already exists —
`AlreadyExistsError: 00000524 … ENTRY_EXISTS` from Active Directory, which is
`ERROR_USER_EXISTS`: the `sAMAccountName` is taken somewhere in the domain. The
row keeps its correlation key, gets `statusReason`, and has no anchor, because
Syntra never created anything.

Nothing clears it. `apply.ts:1494` is the only writer of `status: 'conflict'`
and no code path writes it back. `reconcile.ts:314` makes the person
`account_conflict` at scope `all` and `continue`s before anything else is
evaluated. `run-service.ts` excludes them from `needReservation`, with a comment
saying exactly why — a reservation for somebody the plan cannot name would sit
`pending` for ever. So every subsequent run short-circuits in the same place,
whatever the administrator does in the directory. There is no endpoint, no
console control, and no run that resolves it.

This was hit in the lab on the second real account provisioned, by a person
whose account already existed in the domain — an entirely ordinary situation.
The only way out was editing `TargetAccount` by hand. That is not an answer.

The refusal itself is right and stays. Syntra will not silently bind to an
object it did not create: anybody able to create an object in a target could
otherwise choose a name that causes Syntra to hand them an existing person's
account. What is missing is the deliberate act — an administrator saying *yes,
that object is this person's account* — and a record of who said it.

## What this is not

**It is not general re-correlation.** Adoption applies only to an account in
`conflict`. Binding an arbitrary person to an arbitrary directory object is a
much wider power — it would let an administrator attach anyone to anyone's
account — and it is not what this problem needs. Orphan accounts, which Govern
already reports at `GET /govern/orphans`, are the same operation seen from the
other end and are deliberately out of scope here.

**It does not write to the directory.** Not the object's attributes, and not the
provenance marker. Adoption is a decision, recorded; the next run converges the
object through the guarded path like any other change.

**It is not a standing "reset to pending" button.** Resetting a conflict whose
object is still there recreates the same conflict on the next run. Resetting is
available only as an explicit answer to a question the action asks — the
candidate is not visible, and the administrator says the object is gone rather
than merely out of sight. See "No candidate is ambiguous".

## Why no directory write

Provenance is consulted in exactly two places, both about creates:
`apply.ts:898`, where a create refused as already-existing checks whether the
object carries *this action's* marker, and `resolveInFlightActions`, which
resolves a create whose response was lost by looking for the marker. Once a row
holds an anchor, `reconcile` matches by anchor and never reads provenance again.
An adopted account therefore needs no marker to work.

Writing one anyway would cost something real. On this target
`provenanceAttribute` is `info`, the AD Notes field. Syntra writes it on
accounts it creates, where it is empty by construction. An adopted account was
made by somebody else and its `info` may hold their notes; stamping it destroys
a field Syntra does not own, in order to record something no code reads.

So the action performs one directory READ — to find the object and its anchor —
and no write. It cannot half-succeed, and it cannot lose data.

## The action

`packages/core/src/provision/adoption-service.ts`, a new file. It goes beside
`placement-service.ts` rather than inside it: placement answers *where an
account lives*, adoption answers *which object an account is*.

```ts
export interface AdoptAccountInput {
  personId: string;
  targetSystemId: string;
  reason: string;
  actorUserId: string | null;
  sourceIp: string | null;
}

export async function adoptAccount(
  tenantId: string,
  provider: MasterKeyProvider,
  input: AdoptAccountInput,
): Promise<{ adopted: boolean; anchor: string | null; dn: string | null }>;
```

Order of operations:

1. Load the account for `(personId, targetSystemId)`. Throw `NoAccountToAdoptError`
   if there is none, `NotInConflictError` unless `status === 'conflict'`.
2. Read the target. Find the object whose correlation key — `sAMAccountName` on
   an AD target, folded case-insensitively as everywhere else — equals the row's
   `correlationKey`.
3. **No candidate**: refuse with `CandidateNotVisibleError`, unless the caller
   explicitly asked for the other outcome — see "No candidate is ambiguous"
   below. Syntra does not guess here.
4. **Candidate whose anchor another row already holds**: throw
   `AnchorAlreadyBoundError` naming the other person. The partial unique index
   on `(tenantId, targetSystemId, anchor)` would refuse the write regardless;
   catching it first turns a constraint violation into a sentence.
5. Otherwise bind, in one transaction: `anchor`, `status: 'active'`,
   `statusReason: null`.

The audit event is `provision.account.adopted`, carrying `personId`, `anchor`,
`dn`, `correlationKey`, the reason and the actor — written on the reset path
too, with `adopted: false` on it. "Who bound this account to this object, and
why" is the only question anybody asks afterwards.

Attributes are not written. The next run proposes `update_account` for the
adopted object through the guard, in a plan somebody reviews.

## No candidate is ambiguous, and Syntra must not guess

The conflict that motivated this had the colliding object **outside** the
target's `baseDn`. AD enforces `sAMAccountName` uniqueness across the domain,
but Syntra's `read` returns only what is under the base — so the create was
refused by an object Syntra cannot see, and step 2 finds nothing.

An object that has since been *deleted* looks exactly the same: nothing under
the base carries that name. The two need opposite treatments — the first must be
refused, because a retry would be refused identically for ever; the second
should retry, because the create would now succeed — and **Syntra cannot tell
them apart.**

It cannot tell them apart from the status either. `finish()` sets `conflict`
only when `result.failure === 'conflict'`, so *every* row in this state got here
by being told the name was already taken. The status carries no information that
separates the two cases. The only other signal is `statusReason`, which holds
the directory's own error text — and deciding behaviour by matching strings a
foreign system produced is precisely the coupling that stranded actions in
`v1.6.3`.

So the administrator decides, because the administrator is the one who can look.
The POST body carries an explicit second answer:

```ts
{ reason: string; ifNoCandidate?: 'refuse' | 'reset' }   // default 'refuse'
```

The default refuses, naming the base DN:

> the account `ssander` was refused as already existing, and no object with that
> name is inside `OU=Users,OU=Syntra,DC=ssander,DC=local`. Either it is elsewhere
> in the domain where this target cannot see it — move it into the managed
> subtree, or widen the target's base DN — or it has since been deleted, in which
> case the account can be created again.

`ifNoCandidate: 'reset'` is the administrator answering the second half: the row
returns to `status: 'pending'` with `statusReason` cleared, and the next run
creates the account normally. It is audited as `provision.account.adopted` with
`adopted: false` and the reason, because "who decided this account should be
created again, and why" is the same question adoption's audit answers.

Nothing infers. The refusal states both possibilities and the caller picks one.

## API

Two routes in `apps/api/src/routes/admin/targets.ts`, beside the Move control
they are modelled on. Both `PROVISION_MANAGE` — this overrides a refusal the
subsystem makes on purpose, and is not read-shaped.

```
GET  /targets/:id/accounts/:personId/adoption-candidate
POST /targets/:id/accounts/:personId/adopt
     body: { reason: string, ifNoCandidate?: 'refuse' | 'reset' }
```

The GET returns `{ anchor, dn, attributes }` for the object that would be bound,
or the same typed refusals. It exists because the safeguard being replaced is a
technical one: provenance answers "did Syntra make this?", and the only thing
that can stand in for it is a named human having looked at a specific object.
Confirming a *name* is not that. It reads the directory, so it is called when
the dialog opens, never on page load.

Problem responses:

| Error | Status | Code |
| --- | --- | --- |
| `NoAccountToAdoptError` | 409 | `nothing-to-adopt` |
| `NotInConflictError` | 409 | `not-in-conflict` |
| `AnchorAlreadyBoundError` | 409 | `anchor-already-bound` |
| `CandidateNotVisibleError` | 404 | `candidate-not-visible` |

`POST` answers 200 with `{ adopted, anchor, dn }`. The reset path is a success,
not a failure: the administrator asked for the conflict to be resolved and it
was, by a different route than binding.

## Console

A control beside **Move** on `PersonAccessPage`, per account, rendered only when
that account's status is `conflict`. Opening it calls the candidate endpoint and
shows the DN and identifying attributes; the administrator supplies a reason.

One line of consequence, because it is not obvious and it is not reversible by
the same button: once adopted, Syntra manages the account — it writes the
profile's attributes onto it, moves it when its org unit changes, and puts it on
the leaver ladder.

When the candidate endpoint finds nothing, the dialog shows the refusal's two
possibilities and offers the second as a distinct, secondary action — *the
account no longer exists; create it again* — which is the `ifNoCandidate:
'reset'` call. It is never the primary button, and it is never the default.

Per `explaining-ui-is-a-design-failure`, that line is about what adoption *does*,
not about how to use the control. If the control needs instructions, the control
is wrong.

## Testing

Service, in `adoption-service.test.ts`:

- binds the candidate, sets `active`, clears `statusReason`, writes the audit
- **performs no directory write** — the connector's `write` is never called.
  This is the property the whole design rests on and the one a later change is
  most likely to break
- refuses an account that is not in conflict
- refuses when another row already holds that anchor
- refuses with the base-DN message when no candidate is visible, **by default** —
  the case that motivated the feature, and the one an inference would get wrong
- resets to `pending` when no candidate is visible and the caller passed
  `ifNoCandidate: 'reset'`, auditing it with `adopted: false`
- never resets on its own: the same input without the flag refuses
- matches the correlation key case-insensitively

API, in the existing `targets` route tests: one per problem response, the happy
path, and that both routes require `PROVISION_MANAGE`.

Console: the control appears only for a conflicted account, and the reason is
required.

## Migration

None. No schema change: `anchor`, `status` and `statusReason` all exist.
