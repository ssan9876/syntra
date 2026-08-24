import { splitDn, type ProvisionActionType } from '@syntra/connectors';
import { activeOn, departureDate } from './desired.js';
import { unprocessableScope } from './reconcile.js';
import type {
  ActualState,
  ContractFacts,
  DesiredState,
  LadderSettings,
  PlannedAction,
  RevocationOrderFacts,
  SyntraUserFacts,
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
  /**
   * Administrative departures, keyed on `personId`.
   *
   * Set when a human deactivated the person's account from the console rather
   * than a contract ending. Absent for everybody else, which is almost
   * everybody.
   */
  departureOverrideByPerson: ReadonlyMap<string, Date>;
  /**
   * EVERY Syntra login linked to a person, keyed on `personId`.
   *
   * A list per person, not one login, and that is the whole point of the
   * shape. A `ReadonlyMap<string, SyntraUserFacts>` holds exactly one value
   * per key, so the second login read for a person overwrote the first and the
   * plan could only ever name one of them — while `person-service.ts`
   * documents the two-login case in as many words, "an everyday login and an
   * admin one". On departure the overwritten login was never proposed for
   * deactivation, and it does not self-correct: nothing re-examines a login no
   * action ever names, so a departed person kept it for good, with its
   * Syntra-held password. Which of the two survived was whichever the read
   * happened to return last, so the admin login was as likely as the everyday
   * one. Ruling P29.
   *
   * An array rather than a `Map<userId, …>` per person: nothing here looks a
   * login up by id, both directions iterate the whole set, and an array
   * preserves the CALLER's order — which matters because each login now
   * produces its own action, and an action's index in the returned array
   * becomes `ProvisionAction.sequence`. Two runs over the same data must
   * number the same actions the same way.
   *
   * Absent and empty say the same thing and both are ordinary rather than
   * exceptional: a person with no Syntra login at all is the common case at a
   * target whose paired source has not run yet. Neither proposes anything.
   */
  syntraUserByPerson: ReadonlyMap<string, readonly SyntraUserFacts[]>;
  pairedDirectorySource: boolean;
  ladder: LadderSettings;
  /**
   * Govern's open revocation orders for this target, as plain values.
   *
   * Provision never queries Govern. The orders arrive here already read, and
   * each is consumed at most once — a one-shot negative term, not a standing
   * rule.
   */
  revocationOrders: readonly RevocationOrderFacts[];
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
    // This cannot be inferred from anything else here. They have no ended
    // contract, so `departureDate` returns null, so `departed` is false, so
    // the branch below reads them as a mover and disables them today.
    if (state.notYetStarted) continue;

    const current = input.actual.get(state.personId);
    if (!current) continue;

    const personId = state.personId;
    const accountId = current.accountId;
    // Resolved once, for both directions, so the paired-source gate and the
    // empty case are each written down in exactly one place. `?? []` is the
    // person who has no Syntra login — the ordinary case, not the exception —
    // and it makes both loops below do nothing without a null test of their
    // own.
    const syntraUsers: readonly SyntraUserFacts[] = input.pairedDirectorySource
      ? (input.syntraUserByPerson.get(personId) ?? [])
      : [];
    const contracts = input.contractsByPerson.get(personId) ?? [];
    const departureOverride = input.departureOverrideByPerson.get(personId) ?? null;
    const endDate = departureDate(contracts, now, departureOverride);
    // A departure is having stopped being employed, and `endDate` is the day
    // it happened — which during a gap between two fixed-term contracts is the
    // end of the one that just ended, NOT the end of one that has not started.
    // Reading it as the maximum end date across every contract put every
    // ladder timer fifteen months in the future for exactly that person, so
    // not one step ever fired and they kept an enabled account and every
    // entitlement for the whole gap.
    const departed = endDate !== null;
    // Not the same question as `departed`, and only ever used to say WHY.
    // Somebody whose only other contract is open-ended and starts in September
    // has no ENDED contract to date a departure from, and is not employed
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
        // Defaulted here, overridden only by `grant_entitlement`.
        // `revoke_entitlement` keeps it EMPTY deliberately: by the time a
        // revocation is proposed the grant has already left the union, so
        // there is no live grant to attribute it to. Reflection finds the
        // removal by its `SweepAction` instead.
        attributedGrantIds: [],
        requiresConfirmation: false,
        // Overridden only by the revocation-order term below.
        revocationOrderId: null,
        message: null,
        ...over,
      });
    };

    if (state.account?.required) {
      /**
       * The Syntra logins come back with EMPLOYMENT, not with one particular
       * write at the target.
       *
       * This used to live inside the `enable_account` branch, which is inside
       * the `existsAtTarget` arm — so a rehire whose target object had been
       * deleted, or whose account row was still `pending` with a null anchor,
       * took the create arm instead and their logins were never reactivated at
       * all. And it does not self-correct: the next run finds the account
       * enabled at the target, so the enable branch is never re-entered, and
       * the login stays `inactive` for ever with nothing that ever looks at it
       * again. The same shape reached the same way by an administrator who
       * re-enabled the account by hand before the run.
       *
       * Gated on `enabledNow` rather than on any write, so a pre-hire whose
       * account exists but should not yet be usable gets nothing back early.
       *
       * The asymmetry with the deactivation below is deliberate and unchanged:
       * that one follows the DEPARTURE rather than the disable write, because
       * failing to give a login back is an inconvenience and failing to take
       * one away is the defect this whole subsystem exists to prevent.
       *
       * One action per login, over ALL of them. A returner with an everyday
       * login and an admin one has both taken away by the departure branch, so
       * giving only one back would strand the other inactive — the same
       * never-re-examined shape as the defect that list exists to fix, pointed
       * the harmless way. Each action names its own login in `after.userId`,
       * because `applySyntraUserAction` resolves exactly one user from it.
       */
      if (state.account.enabledNow) {
        for (const user of syntraUsers) {
          if (user.status === 'active') continue;
          push('reactivate_syntra_user', {
            accountId,
            before: { status: user.status },
            after: { status: 'active', userId: user.id },
          });
        }
      }

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
          // Decided on the instant, not on the rounded day count: both
          // `disabledAt` and `now` are real timestamps rather than the
          // midnight-aligned contract dates the rest of the ladder runs on, so
          // rounding here would make the window a day longer or a day shorter
          // than the number the administrator typed, depending on the time of
          // day the run happens to start. The day count below is only ever
          // reported, never compared.
          const outsideWindow =
            current.disabledAt !== null &&
            now.getTime() >
              addDays(
                current.disabledAt,
                ladder.reenableWithoutConfirmationDays,
              ).getTime();
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
            attributedGrantIds: (state.grantAttribution.get(entitlementId) ?? []).map(
              (a) => a.grantId,
            ),
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

    // A revocation order is not an inference. It is a single dated instruction
    // carrying a named human, a campaign, a decision id and a comment; it is
    // consumed once; and it appears here attributed to that decision rather
    // than to reconciliation. It is subject to the ordinary guard exactly as
    // any other revocation, including the per-entitlement axis.
    for (const order of input.revocationOrders) {
      if (order.accountId !== accountId) continue;
      // Desired state wants it: the order is overtaken, and executing it would
      // remove access a rule or a live grant asks for — which Provision would
      // restore on the same run.
      if (state.entitlements.has(order.entitlementId)) continue;
      if (!current.heldEntitlements.has(order.entitlementId)) continue;
      // Already proposed by ordinary reconciliation. One revocation, not two.
      if (
        actions.some(
          (a) =>
            a.actionType === 'revoke_entitlement' &&
            a.personId === personId &&
            a.entitlementId === order.entitlementId,
        )
      ) {
        continue;
      }
      push('revoke_entitlement', {
        entitlementId: order.entitlementId,
        before: {
          held: true,
          revocationOrderId: order.orderId,
          decidedBy: order.decidedByPersonName,
          campaign: order.campaignName,
          campaignDecisionId: order.campaignDecisionId,
          reason: order.reason,
        },
        after: { held: false },
        revocationOrderId: order.orderId,
        message: `revoked by ${order.decidedByPersonName} in ${order.campaignName ?? 'an access review'}: ${order.reason}`,
      });
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
      // `disableGraceDays` exists to delay the disable after a SCHEDULED
      // departure -- the contract that ends on the 31st, where nobody wants
      // the account dead at 00:01. An administrative deactivation is not a
      // scheduled departure: the two reasons somebody clicks Deactivate are
      // "they left today" and "this account is compromised", and both want it
      // dead now. A button that appears to do nothing for seven days is a
      // button people work around.
      //
      // The console has already written the disable through to the directory
      // by the time this runs, so honouring a grace period here would mean
      // re-ENABLING an account somebody deliberately killed.
      const disableDue = departureOverride
        ? true
        : departed
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
        //
        // EVERY linked login, one action each. A `Map` keyed on `personId`
        // carried one, so a leaver with an everyday login and an admin one
        // lost only whichever the read returned last and kept the other
        // forever (Ruling P29). Each action names its login in `after.userId`
        // — `applySyntraUserAction` resolves exactly one user from it, so a
        // single action cannot stand for two logins however it is worded.
        for (const user of syntraUsers) {
          if (user.status !== 'active') continue;
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

/**
 * The container part of a DN — the parent of the first RDN.
 *
 * `splitDn` from `@syntra/connectors`, and NOT `dn.indexOf(',')`, which is
 * what this used to do. `CN=Novak\, Anna,OU=Staff,…` is an entirely ordinary
 * Active Directory account — and one Provision meets constantly, because it
 * correlates accounts administrators created by hand — and the first comma in
 * it is the ESCAPED one. Splitting there yields the container
 * ` Anna,OU=Staff,…`, which differs from the container the profile renders, so
 * `containerChanged` is true, so an `update_account` is proposed carrying a
 * move, so `toWriteOperation` hands the connector
 * `CN=<sAMAccountName>,<container>` and `modifyDN` silently RENAMES the object
 * from `Novak\, Anna`. That is exactly the unconfirmed rename `rename_account`
 * is opt-in and always-confirmable to prevent, arriving underneath it — and it
 * would repeat on every run, because the object's real container never
 * matches.
 *
 * Imported rather than restated: this is the fourth place in this repository
 * that needed to take a DN apart, and `@syntra/connectors` — which core
 * already depends on — is where the correct one lives.
 */
function containerOf(state: ActualState): string | null {
  if (state.dn === null) return null;
  const { parent } = splitDn(state.dn);
  // A DN with no comma at all names no container, which is what the caller's
  // null means. `splitDn` reports the empty string for it.
  return parent === '' ? null : parent;
}
