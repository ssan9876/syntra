import type {
  AccountStatus,
  ActualState,
  DesiredState,
  DraftDriftFinding,
  DriftKind,
  EnforcementMode,
  KnownAccount,
  TargetObject,
  UnprocessableKind,
} from './types.js';

export interface ReconcileInput {
  desired: DesiredState[];
  known: KnownAccount[];
  objects: TargetObject[];
  /** Entitlements named by at least one business rule for this target. */
  remit: ReadonlySet<string>;
  /**
   * Containers the target actually holds, read from the target by
   * `listContainers` rather than inferred from the DNs of the accounts it
   * returned. Supplied lowercased by the run, and folded again here so the
   * comparison is right whoever calls it. DN comparison is case-insensitive
   * and a profile written in one case against an OU created in another is an
   * ordinary configuration, not a missing container.
   */
  existingContainers: ReadonlySet<string>;
  /** personId to the container the profile computed for them, in its own case. */
  desiredContainers: ReadonlyMap<string, string>;
  /**
   * Every `OrgUnitContainer` row for this target, keyed by LOWERCASED dn.
   *
   * This map is the whole of Ruling P9 (revised). A container the target does
   * not hold, present here in state 'desired', is one an administrator
   * explicitly materialised, and is created. A container absent from both is
   * one a template invented, and is not -- the person stays
   * `container_missing` at scope `all`, exactly as before.
   *
   * Keyed by DN rather than by org unit because that is the question asked
   * here: the loop holds a container and needs to know whether anybody asked
   * for it, not which unit it belongs to.
   */
  desiredContainerRows: ReadonlyMap<string, { id: string; state: string }>;
  enforcementMode: EnforcementMode;
}

export interface ReconcileOutput {
  actual: Map<string, ActualState>;
  findings: DraftDriftFinding[];
  extraUnprocessable: Map<string, { kind: UnprocessableKind; message: string }>;
  /**
   * Containers to create, keyed by `OrgUnitContainer.id`, valued with the DN
   * in the case the administrator wrote.
   *
   * Deduplicated by row, so a department of forty people is one create rather
   * than forty -- which also matters for the per-run cap, since forty would
   * blow it on its own.
   *
   * `planActions` turns these into `create_container`. Reconcile reports what
   * is missing; it does not build actions, and this keeps that boundary.
   */
  containersToCreate: Map<string, string>;
}

/**
 * How much of a person's plan an unprocessable verdict poisons.
 *
 * `all` means what it says: nothing is computed, nothing is proposed, the
 * person's accounts and entitlements are left exactly as they are.
 *
 * `grants` means only the entitlement decisions are unsafe. Ruling P23: a rule
 * naming an entitlement that has vanished from the target catalog must not be
 * able to keep a leaver's account alive. Global unprocessability there means
 * the account is never disabled and never archived, so access outlives
 * employment because a rule references something that no longer exists -- and
 * a disabled account cannot use the membership we failed to resolve, so
 * proceeding with the account decision is strictly safer than waiting.
 */
export type UnprocessableScope = 'all' | 'grants';

export function unprocessableScope(kind: UnprocessableKind): UnprocessableScope {
  switch (kind) {
    // The rule's condition is intact and so is its account-granting flag. The
    // only thing that could not be resolved is which entitlements it names, so
    // the entitlement decisions are the ones that are poisoned.
    case 'unresolvable_rule':
      return 'grants';
    /**
     * A grant naming an entitlement the catalog does not hold.
     *
     * **This value never reaches this function**, and that is the design
     * rather than an oversight: `desiredState` does not set `unprocessable`
     * for it. It records a `GrantException` and carries on, because a grant is
     * ONE person's approved request and freezing their whole desired state
     * over it would revoke everything else they hold — the opposite of what a
     * rule's failure warrants, where an administrator's intent for a whole
     * population could not be evaluated. Phase 7 turns the exception into a
     * `ProvisionException` row so it is a working-list item rather than a
     * silence.
     *
     * It is classified anyway because the exhaustiveness check below is what
     * makes a kind added without a decision a compile error — and it answers
     * `grants`, the narrower of the two, so that if some future path ever does
     * route it here, the blast radius is the entitlement decisions and not the
     * person's whole account.
     */
    case 'unresolvable_grant':
      return 'grants';
    // An incomplete HR record, a template or a name that could not be
    // produced, a container that is not there, a half-read object, and an
    // account somebody else may own. Each of these makes the ACCOUNT decision
    // itself unanswerable or unsafe, so there is nothing left to scope.
    case 'no_contracts':
    case 'template_unresolvable':
    case 'container_missing':
    case 'name_generation_exhausted':
    case 'target_read_incomplete':
    case 'account_conflict':
      return 'all';
    default: {
      // Exhaustiveness: a kind added to the union without a decision here is a
      // compile error rather than a silent classification.
      const unhandled: never = kind;
      void unhandled;
      // And at runtime an unclassified kind is treated as global, which is the
      // direction that touches nothing.
      return 'all';
    }
  }
}

/**
 * Whether Syntra's recorded status implies the target should report this
 * account as enabled, as disabled, or implies nothing at all.
 *
 * Stated as an expectation rather than as a list of mismatching pairs so that
 * every status has an answer. `archived` expects a disabled object, and an
 * archived account somebody has switched back on is drift by exactly the same
 * argument as a disabled one; enumerating the pairs left that case
 * unreported. `pending` has no object to look at, `missing_at_target` had none
 * last run, and a `conflict` never reaches here.
 */
function expectedEnabled(status: AccountStatus): boolean | null {
  switch (status) {
    case 'active':
      return true;
    case 'disabled':
    case 'archived':
      return false;
    case 'pending':
    case 'missing_at_target':
    case 'conflict':
      return null;
    default: {
      const unhandled: never = status;
      void unhandled;
      return null;
    }
  }
}

/**
 * A stable identity for "the same problem", so a finding that persists across
 * runs is updated rather than duplicated. `-` stands in for a null part
 * because the column is NOT NULL: a unique index over nullable columns
 * constrains nothing, which is why this exists rather than a partial index.
 *
 * `subject` is an explicit fourth part rather than something smuggled into the
 * entitlement slot. Two things need it. An orphan account has no accountId and
 * no entitlement, and what distinguishes one orphan from another is the
 * target's anchor -- which is not a UUID and must never reach the
 * `entitlementId` column. And two genuinely different problems can be
 * `unexpected_status` about one account, so they need different identities or
 * each overwrites the other on every run.
 */
export function driftFingerprint(
  kind: DriftKind,
  accountId: string | null,
  entitlementId: string | null,
  subject: string | null = null,
): string {
  return `${kind}:${accountId ?? '-'}:${entitlementId ?? '-'}:${subject ?? '-'}`;
}

/**
 * Compares three things — what Syntra believes it granted, what the target
 * actually holds, and what the rules say should be held — and sorts the
 * differences into four kinds.
 *
 * Provision converges what it manages and inventories what it does not. It
 * does not judge: deciding whether an orphan should exist, attributing it to
 * an owner and chasing it to closure is Govern's.
 *
 * Ruling P2: drift is recorded under BOTH enforcement modes. The mode decides
 * only whether an unmanaged entitlement is *proposed for revocation*, never
 * whether it is looked at. Additive must mean "I saw this and left it".
 *
 * Pure: no clock, no database, no I/O.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const actual = new Map<string, ActualState>();
  const findings: DraftDriftFinding[] = [];
  const extraUnprocessable = new Map<
    string,
    { kind: UnprocessableKind; message: string }
  >();
  const containersToCreate = new Map<string, string>();
  /** Confirmed rows already reported vanished, so two people share one finding. */
  const vanishedReported = new Set<string>();

  const knownByPerson = new Map(input.known.map((a) => [a.personId, a]));
  const objectByAnchor = new Map(input.objects.map((o) => [o.anchor, o]));

  /**
   * Every anchor Syntra holds a row for.
   *
   * Computed from `known` up front rather than accumulated as the desired loop
   * happens to reach each person. An orphan is an object that "belongs to no
   * person Syntra knows", and whether Syntra knows about it is a property of
   * its own rows -- not of whether this run got as far as evaluating the
   * person, and not of the order of two statements inside a loop. Written the
   * other way round, any early `continue` above the claim turns Provision's
   * own accounts into orphans, and every `continue` added to that loop later
   * is a fresh chance to do it again.
   */
  const claimedAnchors = new Set(
    input.known
      .map((account) => account.anchor)
      .filter((anchor): anchor is string => anchor !== null),
  );

  // Folded here as well as by the caller: this is the one comparison in the
  // module between something Syntra generated from HR data and something the
  // directory returned, and AD folds case where PostgreSQL does not.
  const existingContainers = new Set(
    [...input.existingContainers].map((dn) => dn.trim().toLowerCase()),
  );

  const record = (
    kind: DriftKind,
    accountId: string | null,
    entitlementId: string | null,
    detail: Record<string, unknown>,
    subject: string | null = null,
  ) => {
    findings.push({
      kind,
      accountId,
      entitlementId,
      // An anchor when the subject is one, and never in the entitlement slot.
      subjectAnchor: kind === 'orphan_account' ? subject : null,
      detail,
      fingerprint: driftFingerprint(kind, accountId, entitlementId, subject),
    });
  };

  for (const state of input.desired) {
    const account = knownByPerson.get(state.personId) ?? null;
    const object = account?.anchor ? objectByAnchor.get(account.anchor) : undefined;

    // How much of this person's plan the verdict poisons, if there is one.
    //
    // A blanket skip here is the defect Ruling P23 names: it is what stops a
    // leaver's account ever being disabled or archived because some rule names
    // an entitlement that has been deleted from the target. At `grants` scope
    // the ACCOUNT is reconciled normally -- so the planner can disable and
    // archive it -- while `heldWithinRemit` is left empty, because the desired
    // entitlement set for such a person is empty for want of an answer rather
    // than because they should hold nothing, and differencing against it would
    // strip somebody who is still employed.
    const scope = state.unprocessable
      ? unprocessableScope(state.unprocessable.kind)
      : null;
    if (scope === 'all') continue;
    const grantsFrozen = scope === 'grants';

    if (account?.status === 'conflict') {
      extraUnprocessable.set(state.personId, {
        kind: 'account_conflict',
        message: `this person account is in conflict: the correlation key ${account.correlationKey} already exists in the target on an account Provision did not create`,
      });
      continue;
    }

    if (object && !object.readComplete) {
      // The connector saw it but could not read it in full. Diffing against
      // half a truth is how a partial membership read turns into a mass
      // revoke, which is the whole reason Ruling P1 exists.
      extraUnprocessable.set(state.personId, {
        kind: 'target_read_incomplete',
        message: `the target returned this person account at ${object.anchor} but it could not be read in full, so it cannot be diffed against safely`,
      });
      continue;
    }

    if (state.account?.required) {
      // The map is the run's copy of the same value `state.account.container`
      // already holds. The fallback is not belt and braces: without it a
      // person whose entry the caller failed to add is not checked at all, and
      // an unchecked container is a write into a DN nobody confirmed exists.
      //
      // Compared lowercased, reported in the case the profile produced, so the
      // message names the container the administrator wrote.
      const container =
        input.desiredContainers.get(state.personId) ?? state.account.container;
      if (
        container.trim() !== '' &&
        !existingContainers.has(container.trim().toLowerCase())
      ) {
        const row = input.desiredContainerRows.get(container.trim().toLowerCase());

        if (row !== undefined && row.state === 'desired') {
          // Ruling P9 (revised). An administrator explicitly materialised this
          // unit against this target, so the container is created and the
          // person stays in the run rather than dropping out of it.
          //
          // This is the ONLY branch that can ask for a container, and it can
          // only be reached through a row. A template that rendered this same
          // DN carries no row and falls to the else below -- which is what
          // makes the narrowing structural rather than a matter of remembering
          // to check.
          if (!containersToCreate.has(row.id)) {
            containersToCreate.set(row.id, container);
          }
        } else {
          if (row !== undefined && !vanishedReported.has(row.id)) {
            // The row says the target confirmed this container and the target
            // no longer returns it. Somebody removed it.
            //
            // A finding, NEVER a re-create: re-creating it on the next
            // five-minute tick is Syntra silently fighting a domain
            // administrator, indefinitely and invisibly. Whether the container
            // should come back is not a question a scheduler can answer.
            vanishedReported.add(row.id);
            record('container_vanished', null, null, {
              dn: container,
              state: row.state,
              orgUnitContainerId: row.id,
              reason:
                'Syntra records this container as confirmed at the target and the target no longer returns it',
            });
          }
          // Unchanged in every other respect, including the scope: without a
          // container there is nowhere to put the account, so the whole person
          // is unprocessable.
          extraUnprocessable.set(state.personId, {
            kind: 'container_missing',
            message: `the container ${container} does not exist in the target; Provision does not create it`,
          });
          continue;
        }
      }
    }

    // An account Syntra holds whose anchor the target no longer returns. A
    // `pending` row is a reserved correlation key that never existed at the
    // target, so it is not a vanished account.
    if (account && account.anchor !== null && !object && account.status !== 'archived') {
      record('account_missing_at_target', account.id, null, {
        anchor: account.anchor,
        correlationKey: account.correlationKey,
        reason: 'Syntra holds this account and the target no longer returns its anchor',
      });
      actual.set(state.personId, {
        personId: state.personId,
        accountId: account.id,
        anchor: account.anchor,
        correlationKey: account.correlationKey,
        status: 'missing_at_target',
        existsAtTarget: false,
        enabledAtTarget: false,
        disabledAt: account.disabledAt,
        dn: null,
        attributes: account.lastAppliedAttributes,
        heldEntitlements: new Set(),
        heldWithinRemit: new Set(),
      });
      continue;
    }

    const heldAtTarget = new Set(object?.entitlementIds ?? []);
    const heldWithinRemit = new Set<string>();

    for (const entitlementId of heldAtTarget) {
      const inRemit = input.remit.has(entitlementId);
      // `rule` OR `request`, because both are grants PROVISION MADE, and
      // "Provision granted this" is what the branch below claims and what
      // `heldWithinRemit` means. A `manual` or `discovered` holding is one
      // Provision recorded but did not grant, and counting it here would make
      // it revocable under `additive` — contradicting this module's own rule
      // that an unmanaged entitlement is kept OUT of `heldWithinRemit` under
      // that mode, and `types.ts`'s definition of the set.
      //
      // This line used to read `h.origin === 'rule'` alone, under a comment
      // saying it was "latent today only because `apply.ts` writes
      // `origin: 'rule'` at the one site that creates these rows: a defect
      // held shut by an unrelated constant, which is not the same as a defect
      // that is not there." Automate removed that constant — `apply.ts` now
      // writes `'request'` for a holding an approved request caused — and the
      // defect came live in three places at once, all caught by
      // `automate/desired-union.test.ts`:
      //
      //   - a requested holding was reported as DRIFT under `authoritative`,
      //     when Syntra did not merely see it, it caused it and can name who
      //     approved it;
      //   - a requested holding a rule ALSO granted stopped being differenced
      //     out when both terms went away, so no revocation was proposed;
      //   - and the one that matters: **a leaver kept the entitlement their
      //     request had granted**, because it never entered `heldWithinRemit`
      //     and so was never revoked. Access outliving employment, by the
      //     twelfth distinct route found on this programme.
      const granted = account?.holdings.some(
        (h) =>
          h.entitlementId === entitlementId &&
          (h.origin === 'rule' || h.origin === 'request'),
      );

      if (granted) {
        // Agreement, and Provision's to keep converging: it granted this, so
        // it takes it away when the rules stop asking for it. That holds even
        // if the rule that asked has since been deleted and the entitlement
        // has dropped out of the remit -- otherwise deleting a rule strands
        // every grant it ever made, permanently.
        if (!grantsFrozen) heldWithinRemit.add(entitlementId);
        continue;
      }

      // The target has it and Provision never granted it. Recorded in both
      // modes; the mode decides only what happens next.
      const proposedForRevocation =
        input.enforcementMode === 'authoritative' && inRemit && !grantsFrozen;
      record('unmanaged_entitlement', account?.id ?? null, entitlementId, {
        reason: inRemit
          ? 'the target holds this entitlement and Provision did not grant it'
          : 'the target holds this entitlement and it is outside Provision remit: no business rule for this target names it',
        enforcementMode: input.enforcementMode,
        proposedForRevocation,
      });

      // `heldWithinRemit` is the set the planner differences against, and it
      // differences BOTH ways: anything in it that is not desired is revoked,
      // anything desired that is not in it is granted. Membership therefore
      // means "revocable", so an unmanaged entitlement goes IN under
      // `authoritative` -- the mode that says take charge of it -- and stays
      // OUT under `additive`, the mode that says leave it where it is.
      // Outside the remit it stays out under both: no business rule for this
      // target names it, so Provision has no opinion about it beyond having
      // written it down.
      if (proposedForRevocation) heldWithinRemit.add(entitlementId);
    }

    // Syntra granted it and the target does not have it. Convergence: putting
    // it back is the whole job.
    for (const holding of account?.holdings ?? []) {
      if (heldAtTarget.has(holding.entitlementId)) continue;
      if (!object) continue;
      record('missing_grant', account!.id, holding.entitlementId, {
        reason: 'Provision granted this entitlement and the target no longer holds it',
        origin: holding.origin,
      });
    }

    if (object && state.notYetStarted) {
      // Reported, and nothing else. The planner returns no actions for this
      // person at all, so the account keeps whatever it has: an account
      // belonging to somebody whose contract has not started is a question,
      // not an instruction (spec section 8, Ruling P10). Its own subject, so
      // it cannot collide with the status finding below on the same account.
      record(
        'unexpected_status',
        account?.id ?? null,
        null,
        {
          anchor: object.anchor,
          correlationKey: object.correlationKey,
          reason: 'this account belongs to somebody whose contract has not started',
        },
        'not_yet_started',
      );
    }

    if (object && account) {
      const expected = expectedEnabled(account.status);
      if (expected !== null && expected !== object.enabled) {
        record('unexpected_status', account.id, null, {
          syntraBelieves: account.status,
          targetReports: object.enabled ? 'active' : 'disabled',
          reason: 'the account status at the target does not match what Syntra recorded',
        });
      }
    }

    actual.set(state.personId, {
      personId: state.personId,
      accountId: account?.id ?? null,
      anchor: account?.anchor ?? null,
      correlationKey: account?.correlationKey ?? null,
      status: account?.status ?? 'absent',
      existsAtTarget: object !== undefined,
      enabledAtTarget: object?.enabled ?? false,
      disabledAt: account?.disabledAt ?? null,
      dn: object?.dn ?? null,
      attributes: account?.lastAppliedAttributes ?? {},
      heldEntitlements: heldAtTarget,
      heldWithinRemit,
    });
  }

  // Anything left at the target that no person claimed.
  for (const object of input.objects) {
    if (claimedAnchors.has(object.anchor)) continue;
    // The anchor goes in `subject`, never in `entitlementId`: that column is
    // @db.Uuid, and a target anchor is either not a UUID at all (PostgreSQL
    // rejects the insert) or a valid one pointing at no Entitlement (a
    // dangling reference the drift API and drift tab then render).
    record(
      'orphan_account',
      null,
      null,
      {
        anchor: object.anchor,
        correlationKey: object.correlationKey,
        dn: object.dn,
        reason: 'the target holds this account and it belongs to no person Syntra knows',
      },
      object.anchor,
    );
  }

  return { actual, findings, extraUnprocessable, containersToCreate };
}
