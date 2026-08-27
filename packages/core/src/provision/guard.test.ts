import { describe, expect, it } from 'vitest';
import {
  GUARDED_ACTION_TYPES,
  evaluateProvisionGuard,
  type GuardInput,
  type GuardThresholds,
} from './guard.js';
import type { PlannedAction } from './types.js';
import type { ProvisionActionType } from '@syntra/connectors';

const action = (
  actionType: ProvisionActionType,
  entitlementId: string | null = null,
): PlannedAction => ({
  actionType,
  personId: 'person-1',
  accountId: 'account-1',
  entitlementId,
  before: null,
  after: null,
  attributedRuleIds: [],
  attributedGrantIds: [],
  requiresConfirmation: false,
  revocationOrderId: null,
  message: null,
});

const many = (
  actionType: ProvisionActionType,
  count: number,
  entitlementId: string | null = null,
) => Array.from({ length: count }, () => action(actionType, entitlementId));

const thresholds = {
  createAccountThresholdPercent: 20,
  disableAccountThresholdPercent: 10,
  archiveAccountThresholdPercent: 2,
  revokeEntitlementThresholdPercent: 10,
  deactivateSyntraUserThresholdPercent: 10,
  perEntitlementThresholdPercent: 50,
  personPopulationDropPercent: 20,
};

const guard = (over: Partial<GuardInput> = {}) =>
  evaluateProvisionGuard({
    actions: [],
    thresholds,
    accountsAtTarget: 1000,
    activeAccountsAtTarget: 1000,
    entitlementHoldingsAtTarget: 40_000,
    activeSyntraUsersLinked: 1000,
    holderCountByEntitlement: new Map([['ent-a', 90]]),
    entitlementNameById: new Map([['ent-a', 'Payments Approvers']]),
    personsWithActiveContract: 1180,
    previousPersonsWithActiveContract: 1180,
    hasEverApplied: true,
    ...over,
  });

const reasonsOf = (verdict: ReturnType<typeof guard>): string[] => {
  if (!verdict.blocked) throw new Error('expected a blocked verdict, got blocked: false');
  return verdict.reasons;
};

describe('evaluateProvisionGuard — the unconditional refusals', () => {
  it('refuses a target that returned no accounts while Syntra believes it holds some', () => {
    // An empty target and an unreachable one look identical from here, and the
    // safe reading is the second. At a target, "everything is gone" drives
    // creates as well as disables.
    const verdict = guard({
      accountsAtTarget: 0,
      actions: many('create_account', 5),
    });
    // `activeAccountsAtTarget` is deliberately left at the fixture's 1000 and
    // deliberately NOT asserted on: the call site reads it from the same
    // target pass as `accountsAtTarget`
    // (`run-service.ts`: `objects.filter((o) => o.enabled)`), so inside this
    // branch it is structurally zero and no state the caller can produce puts
    // 1000 there. The message used to report it as what "Syntra holds", which
    // read as "Syntra holds 0 for it" on every real run.
    expect(verdict).toEqual({
      blocked: true,
      requiresConfirmation: false,
      reasons: [
        'the target returned no accounts at all, and a run has been applied against it before, so it is not a target that was simply never populated; an empty target and an unreachable one look identical from here, and the safe reading is the second',
      ],
    });
  });

  it('refuses a run with no persons at all, unconditionally', () => {
    const verdict = guard({ personsWithActiveContract: 0 });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    // The sentence now comes from `populationDropRefusal`, which both this
    // guard and the sweep guard share. Asserted on what it MEANS rather than
    // on a phrase, so the shared rule can be reworded without two subsystems'
    // tests having to agree on prose.
    expect(reasonsOf(verdict)[0]).toContain('no person in this tenant');
  });

  it('refuses a run where the person population collapsed', () => {
    // The signature of a broken HR feed -- a truncated export, an import that
    // ran against a staging database -- which is the accident most likely to
    // produce a plan that disables everybody.
    const verdict = guard({
      personsWithActiveContract: 800,
      previousPersonsWithActiveContract: 1180,
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('32.2%');
  });

  it('allows a population drop just under the threshold', () => {
    // 1180 -> 950 is 19.5%.
    expect(guard({ personsWithActiveContract: 950 })).toEqual({ blocked: false });
  });

  it('skips the population test on a first run, which has no previous population', () => {
    const verdict = guard({
      previousPersonsWithActiveContract: null,
      hasEverApplied: false,
      accountsAtTarget: 0,
    });
    // Not the zero-accounts refusal either: Syntra holds nothing for this
    // target yet, so there is no belief to contradict.
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect(reasonsOf(verdict)[0]).toContain('never had a run applied');
  });
});

describe('evaluateProvisionGuard — the first run', () => {
  it('always requires confirmation, regardless of size', () => {
    // The rule set has never been proved against real data, so a person reads
    // the numbers whatever they say.
    const verdict = guard({ hasEverApplied: false, actions: many('create_account', 1) });
    expect(verdict).toEqual({
      blocked: true,
      requiresConfirmation: true,
      reasons: [
        'this target has never had a run applied, so the first run is confirmed by a person whatever the thresholds say',
      ],
    });
  });

  it('states the real numbers on the axes that have a denominator', () => {
    /**
     * The premise the early return rested on — "a first run has a denominator
     * of zero for every population" — is false for four of the five axes.
     * `accountsAtTarget`, `activeAccountsAtTarget` and
     * `entitlementHoldingsAtTarget` are read FROM THE TARGET in phase 4 and
     * know nothing about whether Syntra has applied here before, and
     * `activeSyntraUsersLinked` is Syntra's own user table, which Directory
     * Sync fills independently of this target.
     *
     * `archive` is the live exposure, because it is the destructive one: a
     * first run against an existing 4,000-account directory proposing to
     * archive all of them was confirmed with no number attached at all.
     */
    const verdict = guard({
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
      accountsAtTarget: 4000,
      actions: many('archive_account', 4000),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect(reasonsOf(verdict)).toContain(
      'would archive 4000 of 4000 accounts (100.0%), above the 2% threshold',
    );
  });

  it('says an axis has no denominator rather than refusing the run for it', () => {
    // A create against a directory holding nothing at all is the ordinary
    // first run, not evidence that the plan and the inventory came from
    // different reads. Confirmable, because the alternative is a target on
    // which no first run can ever be applied.
    const verdict = guard({
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
      accountsAtTarget: 0,
      actions: many('create_account', 4000),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect(reasonsOf(verdict).join(' ')).toContain('has no denominator on this run');
  });

  it('still refuses outright when an axis that should have a denominator has none', () => {
    // An archive addresses an object that already exists at the target, so
    // proposing 40 of them while the inventory reports no accounts at all is
    // incoherent however new the target is — and it stays a refusal rather
    // than becoming a first-run footnote.
    const verdict = guard({
      hasEverApplied: false,
      previousPersonsWithActiveContract: null,
      accountsAtTarget: 0,
      actions: many('archive_account', 40),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('cannot evaluate the archive axis');
  });
});

describe('evaluateProvisionGuard — per action type', () => {
  it('passes just under the create threshold', () => {
    // 199 of 1000 is 19.9%. The previous version of this pair used 200 twice,
    // so "just under" and "exactly at" were the identical case and the
    // boundary was tested once rather than on both sides of it.
    expect(guard({ actions: many('create_account', 199) })).toEqual({ blocked: false });
  });

  it('passes exactly at the create threshold', () => {
    // "above the threshold" means strictly above. 200 of 1000 is exactly 20%.
    expect(guard({ actions: many('create_account', 200) })).toEqual({ blocked: false });
  });

  it('blocks just over the create threshold', () => {
    // Creates are guarded as well as removals, which Directory Sync does not
    // do. A rule whose condition inverted proposes an account in the finance
    // system for the entire organization, and every one of those accounts
    // leaves a mailbox and a home directory behind it.
    const verdict = guard({ actions: many('create_account', 201) });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect(reasonsOf(verdict)[0]).toContain('create 201 of 1000 accounts');
  });

  it('blocks over the disable threshold at its own 10%', () => {
    expect(guard({ actions: many('disable_account', 100) })).toEqual({ blocked: false });
    expect(guard({ actions: many('disable_account', 101) })).toMatchObject({
      blocked: true,
      requiresConfirmation: true,
    });
  });

  it('blocks over the archive threshold at its own 2%', () => {
    expect(guard({ actions: many('archive_account', 20) })).toEqual({ blocked: false });
    expect(guard({ actions: many('archive_account', 21) })).toMatchObject({
      blocked: true,
    });
  });

  it('blocks over the Syntra user deactivation threshold', () => {
    expect(guard({ actions: many('deactivate_syntra_user', 101) })).toMatchObject({
      blocked: true,
    });
  });

  it('does not threshold-guard the additive and corrective action types', () => {
    // update, enable, grant, rename and reactivate are additive or corrective,
    // and a mass grant, while undesirable, is visible in the plan and
    // reversible by the next run. Rename and re-enable have their own
    // confirmation rules.
    expect(
      guard({
        actions: [
          ...many('update_account', 1000),
          ...many('enable_account', 1000),
          ...many('grant_entitlement', 5000, 'ent-a'),
          ...many('rename_account', 1000),
          ...many('reactivate_syntra_user', 1000),
        ],
        holderCountByEntitlement: new Map([['ent-a', 10_000]]),
      }),
    ).toEqual({ blocked: false });
  });
});

describe('evaluateProvisionGuard — the second axis, per entitlement', () => {
  it('blocks when one entitlement is emptied even though the global axis is nowhere near', () => {
    // 90 revocations against 40,000 holdings is 0.2% and passes the 10%
    // global threshold without a murmur. For the 90 people it is total.
    const verdict = guard({ actions: many('revoke_entitlement', 90, 'ent-a') });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    const reasons = reasonsOf(verdict);
    expect(reasons).toHaveLength(1);
    // The reason names the entitlement, the count and the share.
    expect(reasons[0]).toContain('Payments Approvers');
    expect(reasons[0]).toContain('90 of 90');
    expect(reasons[0]).toContain('100.0%');
  });

  it('passes just under the per-entitlement threshold', () => {
    expect(guard({ actions: many('revoke_entitlement', 45, 'ent-a') })).toEqual({
      blocked: false,
    });
  });

  it('blocks just over the per-entitlement threshold', () => {
    const verdict = guard({ actions: many('revoke_entitlement', 46, 'ent-a') });
    expect(verdict).toMatchObject({ blocked: true });
    // Asserted on an asymmetric pair. The brief's only message assertion was
    // "90 of 90", which reads the same in either direction and so could not
    // tell the count from the denominator.
    expect(reasonsOf(verdict)[0]).toContain('from 46 of 90 holders (51.1%)');
  });

  it('trips the global axis without the per-entitlement axis', () => {
    // 5000 revocations spread thinly across many groups.
    const spread = Array.from({ length: 5000 }, (_, i) =>
      action('revoke_entitlement', `ent-${i % 500}`),
    );
    const holders = new Map<string, number>();
    for (let i = 0; i < 500; i += 1) holders.set(`ent-${i}`, 1000);
    const verdict = guard({
      actions: spread,
      holderCountByEntitlement: holders,
      entitlementNameById: new Map(),
    });
    expect(verdict).toMatchObject({ blocked: true });
    expect(reasonsOf(verdict)[0]).toContain('revoke 5000 of 40000 entitlement holdings');
  });

  it('reports both axes when both trip', () => {
    const verdict = guard({
      actions: many('revoke_entitlement', 5000, 'ent-a'),
      holderCountByEntitlement: new Map([['ent-a', 6000]]),
      entitlementNameById: new Map([['ent-a', 'Everyone']]),
    });
    expect(reasonsOf(verdict)).toHaveLength(2);
  });

  it('falls back to the entitlement id when no name is known', () => {
    const verdict = guard({
      actions: many('revoke_entitlement', 90, 'ent-a'),
      entitlementNameById: new Map(),
    });
    expect(reasonsOf(verdict)[0]).toContain('ent-a');
  });

  it('counts each entitlement against its own denominator', () => {
    // Two entitlements in one plan: one emptied, one barely touched. Only the
    // emptied one is reported, so the axis is not summing across groups.
    const verdict = guard({
      actions: [
        ...many('revoke_entitlement', 90, 'ent-a'),
        ...many('revoke_entitlement', 1, 'ent-b'),
      ],
      holderCountByEntitlement: new Map([
        ['ent-a', 90],
        ['ent-b', 1000],
      ]),
    });
    const reasons = reasonsOf(verdict);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('Payments Approvers');
  });

  it('ignores a revocation carrying no entitlement id', () => {
    // Nothing in the plan produces one, and a null id cannot be counted
    // against any denominator. It must not become a bucket of its own.
    expect(guard({ actions: many('revoke_entitlement', 5, null) })).toEqual({
      blocked: false,
    });
  });
});

describe('evaluateProvisionGuard — a denominator of zero is "cannot evaluate", never "nothing to worry about"', () => {
  // DEVIATION FROM THE BRIEF, with evidence.
  //
  // The brief specified `if (holders === 0) continue;` and a test asserting
  // that a plan revoking an entitlement from 5 holders passes when the target
  // reports 0 holders for it, justified as "a first grant of a brand-new group
  // has a denominator of zero and there is nothing to protect".
  //
  // That justification describes a GRANT, and this loop contains only
  // revocations. A revocation cannot reach it for an entitlement with no
  // holders at the target: `reconcile.ts` builds `heldWithinRemit` as a subset
  // of `object.entitlementIds` -- what the target actually returned for that
  // account (reconcile.ts, "const heldAtTarget = new Set(object?.entitlementIds
  // ?? [])", and every `heldWithinRemit.add` sits inside the loop over it) --
  // and `plan.ts` proposes `revoke_entitlement` only by iterating
  // `current.heldWithinRemit`. So one revocation implies at least one holder
  // at the target, and `holders === 0` implies the denominator did not come
  // from the same inventory that produced the actions.
  //
  // That is exactly the defect the pre-flight found: the connector emitted DNs
  // while the consumer looked up objectGUIDs, every holder count was zero, and
  // `continue` disabled the most-emphasised control in the spec in silence.
  // Skipping is indistinguishable from being switched off, which is why the
  // brief's own field docstring argues against a Syntra-side denominator while
  // its code keeps the line that makes the distinction moot.
  it('refuses a revocation whose entitlement reports zero holders at the target', () => {
    const verdict = guard({
      actions: many('revoke_entitlement', 5, 'ent-new'),
      holderCountByEntitlement: new Map([['ent-new', 0]]),
      entitlementNameById: new Map([['ent-new', 'Brand New Group']]),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    const reasons = reasonsOf(verdict);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('cannot evaluate');
    expect(reasons[0]).toContain('Brand New Group');
    expect(reasons[0]).toContain('5');
  });

  it('refuses a revocation whose entitlement is absent from the holder map', () => {
    // Absent and zero are the same fault wearing different clothes, and `?? 0`
    // would have conflated them into the passing case.
    const verdict = guard({
      actions: many('revoke_entitlement', 5, 'ent-unknown'),
      holderCountByEntitlement: new Map([['ent-a', 90]]),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('no holder count at all');
  });

  it('refuses the exact pre-flight failure: an entirely empty holder map', () => {
    // The connector emitted DNs, the consumer looked up objectGUIDs, every
    // lookup missed. Under the brief's `continue` this run applied 90
    // revocations -- the whole of one entitlement -- with the axis reporting
    // nothing.
    const verdict = guard({
      actions: many('revoke_entitlement', 90, 'ent-a'),
      holderCountByEntitlement: new Map(),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
  });

  it('refuses a holder count that is not a count', () => {
    for (const holders of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const verdict = guard({
        actions: many('revoke_entitlement', 5, 'ent-a'),
        holderCountByEntitlement: new Map([['ent-a', holders]]),
      });
      expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
      expect(reasonsOf(verdict)[0]).toContain('cannot evaluate');
    }
    // An infinite denominator is the one that does not announce itself: NaN
    // makes every comparison false, but Infinity makes every share 0.0% and
    // reads, at every call site, as a run well inside its thresholds.
  });

  it('refuses disables when the target reports no active accounts', () => {
    const verdict = guard({
      actions: many('disable_account', 5),
      activeAccountsAtTarget: 0,
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    // One reason, not two: the axis stops at the refusal rather than going on
    // to divide by zero and report a share of Infinity% as well.
    expect(reasonsOf(verdict)).toHaveLength(1);
    expect(reasonsOf(verdict)[0]).toContain('cannot evaluate');
    expect(reasonsOf(verdict)[0]).toContain('active accounts');
  });

  it('refuses revocations when the target reports no entitlement holdings', () => {
    // The global axis with the denominator of zero the pre-flight found: 5000
    // revocations divided by nothing, skipped, applied.
    const verdict = guard({
      actions: many('revoke_entitlement', 5000, 'ent-a'),
      entitlementHoldingsAtTarget: 0,
      holderCountByEntitlement: new Map([['ent-a', 10_000]]),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('entitlement holdings');
  });

  it('refuses Syntra user deactivations when no Syntra users are linked', () => {
    const verdict = guard({
      actions: many('deactivate_syntra_user', 5),
      activeSyntraUsersLinked: 0,
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('Syntra users');
  });

  it('says nothing about a population with a zero denominator and nothing proposed', () => {
    // The empty case that is genuinely empty. A target with no linked Syntra
    // users and no deactivations proposed is not a run that cannot be
    // evaluated; it is a run with nothing on that axis.
    expect(
      guard({
        actions: many('create_account', 1),
        activeAccountsAtTarget: 0,
        entitlementHoldingsAtTarget: 0,
        activeSyntraUsersLinked: 0,
      }),
    ).toEqual({ blocked: false });
  });

  it('reports the thresholds it could still evaluate alongside the ones it could not', () => {
    const verdict = guard({
      actions: [...many('revoke_entitlement', 5, 'ent-a'), ...many('create_account', 500)],
      holderCountByEntitlement: new Map(),
    });
    // Refused outright, not pending confirmation: one axis is unevaluable.
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    const reasons = reasonsOf(verdict);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('cannot evaluate');
    expect(reasons[1]).toContain('create 500 of 1000 accounts');
  });
});

describe('evaluateProvisionGuard — every threshold is actually consulted', () => {
  // A threshold that is stored, validated, returned by the API and never read
  // is the defect Access II shipped for token lifetimes. Each case below
  // blocks at the configured value and stops blocking when only that one
  // threshold is raised, so no threshold can be deleted from the code without
  // a test going red.
  const cases: {
    key: keyof GuardThresholds;
    over: Partial<GuardInput>;
    raised: number;
  }[] = [
    { key: 'createAccountThresholdPercent', over: { actions: many('create_account', 201) }, raised: 30 },
    { key: 'disableAccountThresholdPercent', over: { actions: many('disable_account', 101) }, raised: 30 },
    { key: 'archiveAccountThresholdPercent', over: { actions: many('archive_account', 21) }, raised: 30 },
    {
      key: 'revokeEntitlementThresholdPercent',
      over: {
        actions: many('revoke_entitlement', 5000, 'ent-a'),
        holderCountByEntitlement: new Map([['ent-a', 100_000]]),
      },
      raised: 30,
    },
    {
      key: 'deactivateSyntraUserThresholdPercent',
      over: { actions: many('deactivate_syntra_user', 101) },
      raised: 30,
    },
    {
      key: 'perEntitlementThresholdPercent',
      over: { actions: many('revoke_entitlement', 46, 'ent-a') },
      raised: 60,
    },
    {
      key: 'personPopulationDropPercent',
      over: { personsWithActiveContract: 800 },
      raised: 40,
    },
  ];

  for (const { key, over, raised } of cases) {
    it(`reads ${key}`, () => {
      expect(guard(over)).toMatchObject({ blocked: true });
      expect(guard({ ...over, thresholds: { ...thresholds, [key]: raised } })).toEqual({
        blocked: false,
      });
    });
  }

  it('blocks a single action of a type whose threshold is zero', () => {
    // Zero is not "unset". Strictly-above means one create of a thousand
    // accounts is above a 0% threshold.
    expect(
      guard({
        actions: many('create_account', 1),
        thresholds: { ...thresholds, createAccountThresholdPercent: 0 },
      }),
    ).toMatchObject({ blocked: true, requiresConfirmation: true });
  });

  it('lets a whole population through at a threshold of 100', () => {
    // The opt-out, and the only value that can express one.
    expect(
      guard({
        actions: many('create_account', 1000),
        thresholds: { ...thresholds, createAccountThresholdPercent: 100 },
      }),
    ).toEqual({ blocked: false });
  });
});

describe('evaluateProvisionGuard — a threshold it cannot compare against', () => {
  // A NaN threshold makes every `share > threshold` false, which is a guard
  // that returns "blocked: false" for every run ever proposed. The same shape
  // as the axis with the denominator of zero, one field along.
  for (const value of [Number.NaN, -1, 101, Number.POSITIVE_INFINITY]) {
    it(`refuses to run against a threshold of ${value}`, () => {
      const verdict = guard({
        actions: many('create_account', 900),
        thresholds: { ...thresholds, createAccountThresholdPercent: value },
      });
      expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
      expect(reasonsOf(verdict)[0]).toContain('createAccountThresholdPercent');
    });
  }

  it('refuses to run against a count that is not a count', () => {
    const verdict = guard({ accountsAtTarget: Number.NaN });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('accountsAtTarget');
  });

  it('refuses a negative previous population rather than reading it as growth', () => {
    const verdict = guard({ previousPersonsWithActiveContract: -1 });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)[0]).toContain('previousPersonsWithActiveContract');
  });

  it('refuses before it computes anything, so a bad threshold cannot be confirmed past', () => {
    // The plan here is over every threshold it has. The verdict is still the
    // input refusal, and it is not confirmable.
    const verdict = guard({
      actions: many('disable_account', 900),
      thresholds: { ...thresholds, disableAccountThresholdPercent: Number.NaN },
    });
    expect(reasonsOf(verdict)).toHaveLength(1);
    expect(verdict).toMatchObject({ requiresConfirmation: false });
  });
});

describe('evaluateProvisionGuard — the person population axis', () => {
  it('passes a drop of exactly the threshold', () => {
    // 1180 -> 944 is exactly 20%. Strictly-above, like every other axis here.
    expect(guard({ personsWithActiveContract: 944 })).toEqual({ blocked: false });
  });

  it('blocks a drop one person past the threshold', () => {
    expect(guard({ personsWithActiveContract: 943 })).toMatchObject({
      blocked: true,
      requiresConfirmation: false,
    });
  });

  it('does not block on growth', () => {
    expect(guard({ personsWithActiveContract: 2000 })).toEqual({ blocked: false });
  });

  it('skips the drop test when the previous population was zero', () => {
    // Nothing to divide by, and growth from nothing is not a collapse.
    expect(
      guard({ previousPersonsWithActiveContract: 0, personsWithActiveContract: 5 }),
    ).toEqual({ blocked: false });
  });

  it('refuses an empty population even on a target that has never applied', () => {
    // The no-persons refusal is upstream of the first-run rule, and it is the
    // stronger of the two: it is not confirmable.
    const verdict = guard({
      personsWithActiveContract: 0,
      previousPersonsWithActiveContract: null,
      hasEverApplied: false,
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    // The sentence now comes from `populationDropRefusal`, which both this
    // guard and the sweep guard share. Asserted on what it MEANS rather than
    // on a phrase, so the shared rule can be reworded without two subsystems'
    // tests having to agree on prose.
    expect(reasonsOf(verdict)[0]).toContain('no person in this tenant');
  });

  it('reports both hard refusals when both hold', () => {
    const verdict = guard({ personsWithActiveContract: 0, accountsAtTarget: 0 });
    expect(reasonsOf(verdict)).toHaveLength(2);
    expect(verdict).toMatchObject({ requiresConfirmation: false });
  });

  it('outranks a threshold trip, which would otherwise be confirmable', () => {
    const verdict = guard({
      personsWithActiveContract: 800,
      actions: many('disable_account', 900),
    });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    expect(reasonsOf(verdict)).toHaveLength(1);
  });
});

describe('evaluateProvisionGuard — each axis divides by its own denominator', () => {
  // Every population below is given a denominator that differs from every
  // other one, so a population wired to the wrong input field changes the
  // verdict rather than the arithmetic agreeing by coincidence. The default
  // fixture has 1000 accounts, 1000 active accounts and 1000 linked Syntra
  // users, which makes four of the five axes indistinguishable.
  it('measures disables against the active accounts, not against all of them', () => {
    // 51 of 500 active is 10.2% and blocks; 51 of 1000 accounts is 5.1% and
    // would not.
    const verdict = guard({
      actions: many('disable_account', 51),
      accountsAtTarget: 1000,
      activeAccountsAtTarget: 500,
    });
    expect(verdict).toMatchObject({ blocked: true });
    expect(reasonsOf(verdict)[0]).toContain('disable 51 of 500 active accounts');
  });

  it('measures creates against all accounts, not against the active ones', () => {
    // 150 of 1000 accounts is 15% and passes; 150 of 100 active accounts
    // would be 150%.
    expect(
      guard({
        actions: many('create_account', 150),
        accountsAtTarget: 1000,
        activeAccountsAtTarget: 100,
      }),
    ).toEqual({ blocked: false });
  });

  it('measures archives against all accounts, and says so', () => {
    const verdict = guard({
      actions: many('archive_account', 21),
      accountsAtTarget: 1000,
      activeAccountsAtTarget: 100,
    });
    expect(reasonsOf(verdict)[0]).toContain('would archive 21 of 1000 accounts');
  });

  it('measures Syntra user deactivations against the linked users', () => {
    const verdict = guard({
      actions: many('deactivate_syntra_user', 51),
      activeSyntraUsersLinked: 500,
    });
    expect(verdict).toMatchObject({ blocked: true });
    expect(reasonsOf(verdict)[0]).toContain(
      'deactivate 51 of 500 active Syntra users linked to this target',
    );
  });

  it('reports the share to one decimal place', () => {
    // 201 of 1000 is 20.1%. Rounded to whole percent it reads "20%", which is
    // the threshold it is above.
    const verdict = guard({ actions: many('create_account', 201) });
    expect(reasonsOf(verdict)[0]).toContain('(20.1%)');
    expect(reasonsOf(verdict)[0]).toContain('above the 20% threshold');
  });

  it('never counts a grant against the per-entitlement revocation axis', () => {
    // 5000 grants of an entitlement 90 people hold. Counted as revocations
    // this is 5555% of its holders; it is a grant, so it is nothing at all.
    expect(
      guard({
        actions: many('grant_entitlement', 5000, 'ent-a'),
        holderCountByEntitlement: new Map([['ent-a', 90]]),
      }),
    ).toEqual({ blocked: false });
  });
});

describe('evaluateProvisionGuard — every input it divides by is checked', () => {
  // The per-key lists in guard.ts are the kind of thing a later edit shortens
  // by one line. Each key below has a case that goes red if its check is
  // dropped, so the lists cannot silently stop covering a field.
  const thresholdKeys: (keyof GuardThresholds)[] = [
    'createAccountThresholdPercent',
    'disableAccountThresholdPercent',
    'archiveAccountThresholdPercent',
    'revokeEntitlementThresholdPercent',
    'deactivateSyntraUserThresholdPercent',
    'perEntitlementThresholdPercent',
    'personPopulationDropPercent',
  ];

  for (const key of thresholdKeys) {
    it(`refuses a run whose ${key} is not a percentage`, () => {
      const verdict = guard({ thresholds: { ...thresholds, [key]: Number.NaN } });
      expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
      expect(reasonsOf(verdict)[0]).toContain(key);
    });
  }

  const countKeys = [
    'accountsAtTarget',
    'activeAccountsAtTarget',
    'entitlementHoldingsAtTarget',
    'activeSyntraUsersLinked',
    'personsWithActiveContract',
    'previousPersonsWithActiveContract',
  ] as const;

  for (const key of countKeys) {
    it(`refuses a run whose ${key} is not a count`, () => {
      // Infinity as well as NaN. A NaN denominator makes every comparison
      // false; an infinite one makes every share 0.0%, which is worse,
      // because it produces a guard that reports a comfortable pass.
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        const verdict = guard({ [key]: value });
        expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
        expect(reasonsOf(verdict)[0]).toContain(key);
      }
    });
  }

  it('refuses on the input before it reaches any other refusal', () => {
    // A target that returned nothing AND a threshold that cannot be compared
    // against. Only the input refusal is reported: the guard stops before it
    // computes anything, so nothing downstream can depend on a number it has
    // already decided it cannot use.
    const verdict = guard({
      accountsAtTarget: 0,
      thresholds: { ...thresholds, createAccountThresholdPercent: Number.NaN },
    });
    const reasons = reasonsOf(verdict);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('createAccountThresholdPercent');
  });

  it('reports every unusable input at once rather than the first', () => {
    const verdict = guard({
      accountsAtTarget: Number.NaN,
      activeSyntraUsersLinked: -1,
      thresholds: { ...thresholds, perEntitlementThresholdPercent: 101 },
    });
    expect(reasonsOf(verdict)).toHaveLength(3);
  });
});

describe('evaluateProvisionGuard — the action types it does and does not guard', () => {
  it('guards exactly the consequential types', () => {
    // Exhaustive by construction: adding a member to ProvisionActionType makes
    // this object literal a compile error, so a new action type cannot arrive
    // unguarded without somebody deciding it should be.
    //
    // `update_account` is here because it CARRIES THE CONTAINER MOVE, which is
    // a `modifyDN` — the same LDAP operation as the archive. Only its moving
    // half is counted; a plain attribute write is still unguarded.
    const classification: Record<ProvisionActionType, boolean> = {
      create_account: true,
      disable_account: true,
      archive_account: true,
      revoke_entitlement: true,
      deactivate_syntra_user: true,
      update_account: true,
      enable_account: false,
      grant_entitlement: false,
      rename_account: false,
      reactivate_syntra_user: false,
    };
    const expected = Object.entries(classification)
      .filter(([, guarded]) => guarded)
      .map(([type]) => type)
      .sort();
    expect([...GUARDED_ACTION_TYPES].sort()).toEqual(expected);
  });

  it('counts only the action type each population names', () => {
    // 1000 additive actions plus 201 creates still reports 201, not 1201.
    // These updates carry no container, so none of them is a move.
    const verdict = guard({
      actions: [...many('update_account', 1000), ...many('create_account', 201)],
    });
    expect(reasonsOf(verdict)[0]).toContain('create 201 of 1000 accounts');
  });
});

describe('evaluateProvisionGuard — the container move inside update_account', () => {
  /** An `update_account` that moves the object, as `plan.ts` writes one. */
  const move = (count: number, to = 'OU=Finance,OU=Users,DC=acme,DC=test') =>
    Array.from({ length: count }, () => ({
      ...action('update_account'),
      before: { attributes: {}, container: 'OU=Users,DC=acme,DC=test' },
      after: { attributes: {}, container: to },
    }));

  it('caps a mass container move, which is the same LDAP operation as an archive', () => {
    /**
     * `update_account` was excluded from every population as "additive or
     * corrective" — but it carries the container move, which `apply.ts` turns
     * into a `modifyDN`. A changed `containerTemplate` proposes one for every
     * account in the tenant and moves all of them, with no cap and no
     * confirmation, while `archive_account` and `rename_account` — the same
     * operation — are both controlled.
     */
    const verdict = guard({ actions: move(1000) });
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    expect(reasonsOf(verdict)[0]).toContain(
      'would move 1000 of 1000 accounts to a different container (100.0%)',
    );
  });

  it('leaves an attribute-only update uncapped', () => {
    // The other half of the same action, which really is corrective: the
    // container is unchanged, `toWriteOperation` carries no distinguished
    // name, and the connector moves nothing.
    const attributeOnly = Array.from({ length: 1000 }, () => ({
      ...action('update_account'),
      before: { attributes: { displayName: ['old'] }, container: 'OU=Users,DC=acme,DC=test' },
      after: { attributes: { displayName: ['new'] }, container: 'OU=Users,DC=acme,DC=test' },
    }));
    expect(guard({ actions: attributeOnly })).toEqual({ blocked: false });
  });

  it('reads a differently cased container as the same container', () => {
    // Distinguished names are compared case-insensitively at the target, and
    // `apply.ts` decides whether to move on the same comparison. A guard that
    // folded case differently would count moves that never happen, or miss
    // ones that do.
    const cased = Array.from({ length: 1000 }, () => ({
      ...action('update_account'),
      before: { attributes: {}, container: 'OU=Users,DC=acme,DC=test' },
      after: { attributes: {}, container: 'ou=users,dc=acme,dc=test' },
    }));
    expect(guard({ actions: cased })).toEqual({ blocked: false });
  });

  it('passes a move that stays under the threshold', () => {
    // 20 of 1000 is 2%, and "above" means strictly above.
    expect(guard({ actions: move(20) })).toEqual({ blocked: false });
    expect(guard({ actions: move(21) })).toMatchObject({ blocked: true });
  });
});

describe('evaluateProvisionGuard — autoApply does not enter into it', () => {
  it('has no input by which a caller could waive a threshold', () => {
    /**
     * The guard is a pure function of the plan and a set of counts. There is
     * deliberately no `autoApply`, no `force` and no `override` on GuardInput.
     *
     * **Asserted against the TYPE and against the BEHAVIOUR, never against
     * `Object.keys` of a literal.** Two versions of this test have now been
     * blind to the exact change they existed to catch: the first read the keys
     * of the verdict, which of course never contains `autoApply`; the second
     * read the keys of an object literal written three lines above, which
     * would go on not containing `force` however many waivers `GuardInput`
     * grew — a fixture cannot report a field the fixture did not set.
     *
     * `NoWaiver` is the real assertion. It resolves to `never` only while
     * `GuardInput` has none of these keys, so adding one is a COMPILE error in
     * this file — which `npx tsc -b`, the gate this repository runs before
     * every commit, fails on. The runtime half below then proves the guard
     * ignores such a property even if a caller invents one.
     */
    type Waiver = 'autoApply' | 'force' | 'override' | 'confirm' | 'skipGuard';
    type NoWaiver = Extract<keyof GuardInput, Waiver>;
    const noWaiverOnGuardInput: NoWaiver[] = [];
    expect(noWaiverOnGuardInput).toEqual([]);

    const input: GuardInput = {
      actions: many('disable_account', 500),
      thresholds,
      accountsAtTarget: 1000,
      activeAccountsAtTarget: 1000,
      entitlementHoldingsAtTarget: 40_000,
      activeSyntraUsersLinked: 1000,
      holderCountByEntitlement: new Map(),
      entitlementNameById: new Map(),
      personsWithActiveContract: 1180,
      previousPersonsWithActiveContract: 1180,
      hasEverApplied: true,
    };
    // And the guard blocks it regardless of who is calling, and regardless of
    // what a caller puts beside the inputs it does read.
    expect(evaluateProvisionGuard(input)).toMatchObject({ blocked: true });
    const withWaivers = {
      ...input,
      autoApply: true,
      force: true,
      override: true,
      confirm: true,
      skipGuard: true,
    } as GuardInput;
    expect(evaluateProvisionGuard(withWaivers)).toEqual(
      evaluateProvisionGuard(input),
    );
  });

  it('does not mutate its input', () => {
    // The plan is read again after the verdict — rendered, stored, and
    // applied if somebody confirms — so a guard that decrements a denominator
    // as it counts, or sorts the actions where it stands, changes what is
    // applied. The action list is deliberately mixed and out of order so an
    // in-place sort shows up as well as a resize.
    const holders = new Map([
      ['ent-a', 90],
      ['ent-b', 40],
    ]);
    const input: GuardInput = {
      actions: [
        ...many('revoke_entitlement', 46, 'ent-a'),
        ...many('create_account', 3),
        ...many('revoke_entitlement', 2, 'ent-b'),
        ...many('archive_account', 1),
      ],
      thresholds: { ...thresholds },
      accountsAtTarget: 1000,
      activeAccountsAtTarget: 1000,
      entitlementHoldingsAtTarget: 40_000,
      activeSyntraUsersLinked: 1000,
      holderCountByEntitlement: holders,
      entitlementNameById: new Map([['ent-a', 'Payments Approvers']]),
      personsWithActiveContract: 1180,
      previousPersonsWithActiveContract: 1180,
      hasEverApplied: true,
    };
    const snapshot = JSON.stringify({
      actions: input.actions,
      thresholds: input.thresholds,
      holders: [...holders],
      names: [...input.entitlementNameById],
    });
    evaluateProvisionGuard(input);
    expect(
      JSON.stringify({
        actions: input.actions,
        thresholds: input.thresholds,
        holders: [...holders],
        names: [...input.entitlementNameById],
      }),
    ).toBe(snapshot);
  });

  it('returns a passing verdict carrying nothing else', () => {
    // `blocked: false` with a stray `reasons` key would let a caller render a
    // warning it then applies anyway.
    expect(Object.keys(guard())).toEqual(['blocked']);
  });
});
