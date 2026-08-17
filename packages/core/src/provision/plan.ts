import type { ProvisionActionType } from '@syntra/connectors';
import { activeOn, latestContractEnd } from './desired.js';
import { unprocessableScope } from './reconcile.js';
import type {
  ActualState,
  ContractFacts,
  DesiredState,
  LadderSettings,
  PlannedAction,
} from './types.js';

/**
 * The order actions are applied within one person.
 *
 * Create before entitlements, because a grant needs an anchor. Revocations
 * before disable, so that a leaver's access is gone before the account stops
 * being writable in the way archiving makes it. Archive last, because it is
 * the only step that moves the object.
 */
export const ACTION_ORDER = [
  'create_account',
  'update_account',
  'rename_account',
  'enable_account',
  'reactivate_syntra_user',
  'grant_entitlement',
  'revoke_entitlement',
  'disable_account',
  'deactivate_syntra_user',
  'archive_account',
] as const satisfies readonly ProvisionActionType[];

const MS_PER_DAY = 86_400_000;

/**
 * Whole days on the UTC timeline. Dates in this subsystem are contract dates,
 * which are days rather than instants, so arithmetic on the epoch is exact and
 * does not drift across a daylight-saving boundary the way setDate() does on a
 * local-time Date.
 */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

const due = (dueAt: Date, now: Date) => now.getTime() >= dueAt.getTime();

const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);

export interface PlanInput {
  desired: DesiredState[];
  actual: Map<string, ActualState>;
  contractsByPerson: ReadonlyMap<string, ContractFacts[]>;
  /** The Syntra User owned by the paired directory source, when there is one. */
  syntraUserByPerson: ReadonlyMap<string, { id: string; status: string }>;
  pairedDirectorySource: boolean;
  ladder: LadderSettings;
  now: Date;
}

/**
 * Attribute names, folded.
 *
 * LDAP attribute descriptions are case-insensitive (RFC 4512), so `displayName`
 * and `displayname` name the same attribute at the target. Comparing them with
 * `!==` proposes an update that writes the value the object already holds under
 * the name it already has — noise in a plan an administrator has to read, and
 * for a profile whose `attributeTemplates` keys are cased differently from what
 * Provision last recorded, noise on every run.
 *
 * VALUES are not folded. The directory stores the case it is given, so writing
 * `Anna Novak` over `anna novak` is a real change and has to be proposed.
 */
function foldNames(attributes: Record<string, string[]>): Map<string, string[]> {
  const folded = new Map<string, string[]>();
  for (const [name, values] of Object.entries(attributes)) {
    folded.set(name.toLowerCase(), values);
  }
  return folded;
}

function sameAttributes(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  const left = foldNames(a);
  const right = foldNames(b);
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    const leftValues = left.get(key) ?? [];
    const rightValues = right.get(key) ?? [];
    if (leftValues.length !== rightValues.length) return false;
    if (leftValues.some((value, index) => value !== rightValues[index])) return false;
  }
  return true;
}

/**
 * Desired minus actual, with the grace timers applied and the result ordered.
 *
 * Joiner, mover and leaver are names for shapes this diff takes, not events.
 * There is nothing here that remembers what happened last time, which is what
 * makes a retroactive correction land on the next run with no replay and no
 * reconciliation script.
 *
 * The returned array's ORDER is the plan's order: Task 13 persists it as
 * `ProvisionAction.sequence`, index by index, because `createdAt` is
 * transaction start time in PostgreSQL and is therefore identical for every row
 * one `createMany` writes — ordering by it imposes no order at all, and a grant
 * attempted before the create it depends on fails nondeterministically. The
 * final sort is stable by construction rather than by relying on the engine's,
 * so two runs over the same input produce the same sequence numbers.
 *
 * Pure: no clock of its own, no database, no I/O.
 */
export function planActions(input: PlanInput): PlannedAction[] {
  const actions: PlannedAction[] = [];
  const { ladder, now } = input;

  for (const state of input.desired) {
    // How much of this person's plan an unprocessable verdict poisons, decided
    // by the same function `reconcile` decides it with rather than restated
    // here — the two disagreeing is how a person gets an `actual` entry that
    // nothing ever plans against.
    //
    // `all` is excluded from the plan entirely and their existing access is
    // untouched. A blanket skip for EVERY kind is the defect Ruling P23 names:
    // a rule naming an entitlement that has been deleted from the target would
    // then keep a leaver's account enabled and unarchived forever. Access
    // outlives employment because of a rule referencing something that no
    // longer exists — the same outcome Automate reached by a different route.
    const scope = state.unprocessable
      ? unprocessableScope(state.unprocessable.kind)
      : null;
    if (scope === 'all') continue;

    // Somebody whose contracts all start in the future. Nothing is proposed
    // and nothing is deprovisioned; if they somehow already hold an account it
    // is left exactly as it is and reported as drift by reconcile, because an
    // account belonging to somebody whose contract has not started is a
    // question, not an instruction (spec section 8).
    //
    // This cannot be inferred from anything else here. Their contracts are
    // open-ended, so `latestContractEnd` returns null, so `departed` is false,
    // so the branch below reads them as a mover and disables them today.
    if (state.notYetStarted) continue;

    const current = input.actual.get(state.personId);
    if (!current) continue;

    const personId = state.personId;
    const accountId = current.accountId;
    const contracts = input.contractsByPerson.get(personId) ?? [];
    const endDate = latestContractEnd(contracts);
    // A departure is contracts that all ended. A person still holding an
    // active contract has no departure date, and inventing one would be
    // inventing data.
    const departed = endDate !== null;
    // Not the same question as `departed`, and only ever used to say WHY.
    // Somebody between an ended contract and one that starts in September has
    // no departure date (one contract is open-ended) and is not employed
    // today either.
    const employedNow = activeOn(contracts, now).length > 0;

    // At `grants` scope the entitlement decisions are the unsafe ones: the
    // desired set is empty for want of an answer rather than because the
    // person should hold nothing, and `desiredState` returns before it
    // computes an account at all, so `state.account` is null. That null must
    // NOT be read as "no account is required" — doing so disables everybody in
    // the tenant the moment one rule names a deleted entitlement.
    //
    // The one decision that does not depend on the missing datum is
    // deprovisioning somebody whose contracts have all ended, and a disabled
    // account cannot use the membership we failed to resolve. So: a leaver is
    // still disabled and archived, and anybody else is left exactly as they
    // are (Ruling P23).
    const grantsFrozen = scope === 'grants';
    if (grantsFrozen && !departed) continue;

    const attributedFor = (entitlementId: string) =>
      (state.attribution.get(entitlementId) ?? []).map((a) => a.ruleId);

    const push = (
      actionType: ProvisionActionType,
      over: Partial<PlannedAction> = {},
    ) => {
      actions.push({
        actionType,
        personId,
        accountId,
        entitlementId: null,
        before: null,
        after: null,
        attributedRuleIds: [],
        requiresConfirmation: false,
        message: null,
        ...over,
      });
    };

    if (state.account?.required) {
      if (current.status === 'missing_at_target') {
        // Recreating a vanished account is confirmable, never automatic.
        push('create_account', {
          accountId,
          after: {
            correlationKey: current.correlationKey ?? state.account.correlationKey,
            container: state.account.container,
            attributes: state.account.attributes,
            enabled: state.account.enabledNow,
          },
          requiresConfirmation: true,
          message:
            'this account vanished from the target; recreating it is never automatic, because it usually vanished because somebody deleted it deliberately',
        });
        continue;
      }

      // Nothing at the target, and not the vanished case handled above: an
      // account row whose anchor is null, so the target holds no object of
      // ours to update, enable or rename. Create is the only convergent
      // answer whatever Syntra recorded the row's status as -- the
      // alternative, an update against an object that is not there, cannot
      // succeed at any connector.
      if (!current.existsAtTarget) {
        push('create_account', {
          after: {
            correlationKey: state.account.correlationKey,
            container: state.account.container,
            attributes: state.account.attributes,
            enabled: state.account.enabledNow,
          },
        });
      } else {
        // The PARENT of the current DN against the desired container, not a
        // suffix test. `endsWith` reads
        // `CN=x,OU=Finance,OU=Users,DC=acme,DC=test` as already being in
        // `OU=Users,DC=acme,DC=test`, so a person whose department is cleared
        // -- and whose container therefore falls back to the shallower one --
        // is never moved. Every move to a shallower container is missed, and
        // the fallback container exists precisely for the case where the
        // deeper one cannot be computed.
        const currentContainer = containerOf(current);
        const containerChanged =
          currentContainer !== null &&
          currentContainer.toLowerCase() !== state.account.container.toLowerCase();
        if (
          !sameAttributes(current.attributes, state.account.attributes) ||
          containerChanged
        ) {
          // The complete managed set, never a delta. A container change is a
          // modifyDN at the connector; the anchor is unchanged, which is the
          // whole point of anchoring on objectGUID.
          push('update_account', {
            before: { attributes: current.attributes, container: containerOf(current) },
            after: {
              attributes: state.account.attributes,
              container: state.account.container,
            },
          });
        }

        // Compared case-INSENSITIVELY. `sAMAccountName` is case-insensitive at
        // the target and Task 6's generator emits lowercase, so a key
        // correlated from a pre-existing AD account carries the directory's
        // casing and differs from the generated one by case alone. `!==` there
        // proposes, on every run forever, a rename that changes nothing at the
        // target — each one asking an administrator to confirm an operation
        // documented as breaking certificate subjects, profile paths, file
        // ownership and mailbox aliases. Fourth case defect on this slice: AD
        // folds case and PostgreSQL does not.
        if (
          ladder.renameEnabled &&
          state.account.correlationKey !== null &&
          current.correlationKey !== null &&
          state.account.correlationKey.toLowerCase() !==
            current.correlationKey.toLowerCase()
        ) {
          push('rename_account', {
            before: { correlationKey: current.correlationKey },
            after: { correlationKey: state.account.correlationKey },
            requiresConfirmation: true,
            message:
              'renaming breaks certificate subjects, profile paths, file ownership and mailbox aliases, so it is always confirmed',
          });
        }

        if (state.account.enabledNow && !current.enabledAtTarget) {
          const disabledDays =
            current.disabledAt === null ? null : daysBetween(current.disabledAt, now);
          // Syntra recorded this account as disabled and did not record when.
          // Reading that as "zero days" is the most permissive possible answer
          // to an unknown, and it auto-applies the re-enable of an account
          // that may have been disabled a year ago. An unknown date cannot be
          // SHOWN to be inside the window, and the direction that gives access
          // back is the one that has to be shown.
          //
          // Gated on the recorded status, not on the null alone: an account
          // Syntra records as active has no disable date because there was no
          // disable — a pre-hire created disabled, whose first enable is the
          // joiner happy path and must not need a tick.
          const disableDateUnknown =
            current.status === 'disabled' && current.disabledAt === null;
          const outsideWindow =
            disabledDays !== null &&
            disabledDays > ladder.reenableWithoutConfirmationDays;
          push('enable_account', {
            before: { enabled: false },
            after: { enabled: true },
            requiresConfirmation: outsideWindow || disableDateUnknown,
            ...(outsideWindow
              ? {
                  message: `this account has been disabled for ${disabledDays} days, longer than the ${ladder.reenableWithoutConfirmationDays}-day window; months of accumulated entitlements come back with the login`,
                }
              : disableDateUnknown
                ? {
                    message: `this account is recorded as disabled and Syntra holds no record of when it was disabled, so it cannot be shown to be inside the ${ladder.reenableWithoutConfirmationDays}-day window; months of accumulated entitlements come back with the login`,
                  }
                : {}),
          });

          // Reactivation follows the enable WRITE, unlike the deactivation
          // below, which follows the departure. The asymmetry is deliberate:
          // failing to give a login back is an inconvenience, and failing to
          // take one away is the defect this whole subsystem exists to prevent.
          const user = input.syntraUserByPerson.get(personId);
          if (input.pairedDirectorySource && user && user.status !== 'active') {
            push('reactivate_syntra_user', {
              accountId,
              before: { status: user.status },
              after: { status: 'active', userId: user.id },
            });
          }
        }
      }

      // Not at `grants` scope: the desired set is empty for want of an answer
      // there, so granting from it grants nothing and differencing against it
      // would strip somebody who is still employed. Guarded here as well as in
      // `reconcile`, which empties `heldWithinRemit` for the same reason —
      // structure, not two modules each remembering.
      if (!grantsFrozen) {
        for (const entitlementId of state.entitlements) {
          if (current.heldWithinRemit.has(entitlementId)) continue;
          push('grant_entitlement', {
            entitlementId,
            after: { held: true },
            attributedRuleIds: attributedFor(entitlementId),
          });
        }
      }
    }

    // Revocations. A mover's are immediate; a leaver's wait for their own
    // delay, measured from the latest contract end date.
    const revocationDue =
      !departed || due(addDays(endDate!, ladder.entitlementRevocationDelayDays), now);

    // Deliberately NOT guarded by `grantsFrozen`, unlike the grants above.
    // At `grants` scope `reconcile` leaves `heldWithinRemit` empty, so this
    // loop has nothing to do today; a second guard here would mean that the
    // day somebody makes the remit non-empty for a leaver -- which is the
    // letter of Ruling P23 -- the revocations silently do not happen. A guard
    // whose failure direction is "more access persists" is not a safety net.
    if (revocationDue) {
      for (const entitlementId of current.heldWithinRemit) {
        if (state.entitlements.has(entitlementId)) continue;
        push('revoke_entitlement', {
          entitlementId,
          before: { held: true },
          after: { held: false },
          ...(departed
            ? {}
            : {
                message:
                  'revoked immediately: the person is still employed, so the least-privilege answer is to take the old access away now and they are present to be asked',
              }),
        });
      }
    }

    // An account no longer required, at a target where Provision knows of one:
    // a row it holds, or an object at the target, or both. Not gated on
    // `existsAtTarget` alone — an account that has been deleted at the target
    // or disabled by an administrator by hand still has a paired Syntra login
    // to end, and gating the whole block on the object being there and enabled
    // is how a leaver keeps a live Syntra password because somebody else did
    // half the job first.
    const accountKnownHere = current.accountId !== null || current.existsAtTarget;
    if (!state.account?.required && accountKnownHere) {
      // If the person is still employed this is a mover and it happens now,
      // with no grace: the ladder's timers are anchored to a contract end date
      // and this person does not have one.
      const disableDue = departed
        ? due(addDays(endDate!, ladder.disableGraceDays), now)
        : true;

      if (disableDue) {
        // `enabledAtTarget` is false whenever there is no object at the
        // target, so this covers both "already disabled" and "not there".
        if (current.enabledAtTarget) {
          const late =
            departed && daysBetween(addDays(endDate!, ladder.disableGraceDays), now) > 0;
          push('disable_account', {
            before: { enabled: true },
            after: { enabled: false },
            message: departed
              ? late
                ? `this departure was observed late: the disable fell due on ${addDays(endDate!, ladder.disableGraceDays).toISOString().slice(0, 10)} and this is the first run to see it`
                : null
              : employedNow
                ? 'disabled immediately: this account is no longer required and the person is still employed, so there is no departure date to measure a grace period from'
                : // Not "still employed": one of their contracts is
                  // open-ended, so there is no departure date, but none of
                  // them is in force today either. Saying they are employed
                  // would be asserting the one thing this subsystem must
                  // never assert without evidence.
                  'disabled immediately: this account is no longer required, there is no contract in force today, and no contract has an end date to measure a grace period from',
          });
        }

        // Follows the DEPARTURE, not the disable write above. Without this the
        // leaver whose account an administrator had already disabled by hand —
        // the likeliest shape there is — keeps a live Syntra login with a
        // Syntra-held password, because the one write that was already done
        // silently cancelled the one that was not.
        const user = input.syntraUserByPerson.get(personId);
        if (input.pairedDirectorySource && user && user.status === 'active') {
          push('deactivate_syntra_user', {
            accountId,
            before: { status: user.status },
            after: { status: 'inactive', userId: user.id },
          });
        }
      }

      if (
        departed &&
        ladder.archiveAfterDays !== null &&
        due(addDays(endDate!, ladder.archiveAfterDays), now) &&
        current.existsAtTarget &&
        current.status !== 'archived'
      ) {
        push('archive_account', {
          before: { archived: false },
          after: { archived: true },
        });
      }
    }
  }

  // Decorated, so the order is total and deterministic rather than resting on
  // the engine's sort being stable: this array's index becomes
  // `ProvisionAction.sequence`, and two runs over the same input have to
  // number the same actions the same way.
  return actions
    .map((action, index) => ({ action, index }))
    .sort(
      (a, b) =>
        ACTION_ORDER.indexOf(a.action.actionType) -
          ACTION_ORDER.indexOf(b.action.actionType) || a.index - b.index,
    )
    .map((entry) => entry.action);
}

/** The container part of a DN — everything after the first comma. */
function containerOf(state: ActualState): string | null {
  if (state.dn === null) return null;
  const comma = state.dn.indexOf(',');
  return comma === -1 ? null : state.dn.slice(comma + 1);
}
