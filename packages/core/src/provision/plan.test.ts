import { describe, expect, it } from 'vitest';
import { ACTION_ORDER, addDays, planActions } from './plan.js';
import type { ActualState, ContractFacts, DesiredState, LadderSettings } from './types.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const ladder: LadderSettings = {
  entitlementRevocationDelayDays: 0,
  disableGraceDays: 0,
  archiveAfterDays: null,
  reenableWithoutConfirmationDays: 7,
  renameEnabled: false,
};

const contract = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  id: 'contract-1',
  sequence: 1,
  isPrimary: true,
  startDate: day('2020-01-01'),
  endDate: null,
  department: 'Finance',
  jobTitle: 'Analyst',
  costCentre: null,
  employer: null,
  location: null,
  fte: 1,
  ...over,
});

const desired = (over: Partial<DesiredState> = {}): DesiredState => ({
  personId: 'person-1',
  account: {
    required: true,
    attributes: { displayName: ['Anna Novak'] },
    container: 'OU=Finance,OU=Users,DC=acme,DC=test',
    enabledNow: true,
    correlationKey: 'anna.novak',
  },
  entitlements: new Set(['ent-finance']),
  attribution: new Map([
    [
      'ent-finance',
      [{ ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'contract-1' }],
    ],
  ]),
  notYetStarted: false,
  unprocessable: null,
  ...over,
});

const actual = (over: Partial<ActualState> = {}): ActualState => ({
  personId: 'person-1',
  accountId: 'account-1',
  anchor: 'anchor-1',
  correlationKey: 'anna.novak',
  status: 'active',
  existsAtTarget: true,
  enabledAtTarget: true,
  disabledAt: null,
  dn: 'CN=Anna Novak,OU=Finance,OU=Users,DC=acme,DC=test',
  attributes: { displayName: ['Anna Novak'] },
  heldEntitlements: new Set(['ent-finance']),
  heldWithinRemit: new Set(['ent-finance']),
  ...over,
});

const plan = (over: Partial<Parameters<typeof planActions>[0]> = {}) =>
  planActions({
    desired: [desired()],
    actual: new Map([['person-1', actual()]]),
    contractsByPerson: new Map([['person-1', [contract()]]]),
    syntraUserByPerson: new Map(),
    pairedDirectorySource: false,
    ladder,
    now: NOW,
    ...over,
  });

const types = (actions: ReturnType<typeof plan>) => actions.map((a) => a.actionType);

describe('addDays', () => {
  it('adds whole days without drifting across a daylight-saving boundary', () => {
    expect(addDays(day('2026-03-28'), 3)).toEqual(day('2026-03-31'));
    expect(addDays(day('2026-06-15'), 0)).toEqual(day('2026-06-15'));
  });
});

describe('planActions — a run with nothing to do', () => {
  it('proposes nothing when desired and actual agree', () => {
    expect(plan()).toEqual([]);
  });
});

describe('planActions — the joiner', () => {
  it('creates the account before granting entitlements', () => {
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            accountId: null,
            anchor: null,
            status: 'absent',
            existsAtTarget: false,
            enabledAtTarget: false,
            dn: null,
            attributes: {},
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    // Account before entitlements, always, because a grant needs an anchor.
    expect(types(actions)).toEqual(['create_account', 'grant_entitlement']);
    expect(actions[0]!.after).toEqual({
      correlationKey: 'anna.novak',
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      attributes: { displayName: ['Anna Novak'] },
      enabled: true,
    });
    expect(actions[1]!.attributedRuleIds).toEqual(['rule-finance']);
  });

  it('creates a pre-hire account disabled and grants nothing', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: false,
            correlationKey: 'anna.novak',
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({
            accountId: null,
            anchor: null,
            status: 'absent',
            existsAtTarget: false,
            enabledAtTarget: false,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['create_account']);
    expect(actions[0]!.after).toMatchObject({ enabled: false });
  });
});

describe('planActions — the mover', () => {
  it('updates attributes, grants what is newly required and revokes what is not, immediately', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'], department: ['Facilities'] },
            container: 'OU=Facilities,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
          entitlements: new Set(['ent-facilities']),
          attribution: new Map([
            [
              'ent-facilities',
              [{ ruleId: 'rule-fac', ruleName: 'Facilities', contractId: 'contract-1' }],
            ],
          ]),
        }),
      ],
    });
    // Mover revocations are immediate: the person is still present, the
    // least-privilege answer is to take the old department's access away now,
    // and if it was a mistake they are there to say so.
    expect(types(actions)).toEqual([
      'update_account',
      'grant_entitlement',
      'revoke_entitlement',
    ]);
    expect(actions[0]!.before).toEqual({
      attributes: { displayName: ['Anna Novak'] },
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
    });
    expect(actions[0]!.after).toEqual({
      // The COMPLETE managed set, not a delta: the connector writes desired
      // state, so the same update twice leaves the same result.
      attributes: { displayName: ['Anna Novak'], department: ['Facilities'] },
      container: 'OU=Facilities,OU=Users,DC=acme,DC=test',
    });
  });

  it('treats a container change as an update, leaving the anchor alone', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Facilities,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
        }),
      ],
    });
    expect(types(actions)).toEqual(['update_account']);
    expect(actions[0]!.accountId).toBe('account-1');
  });

  it('disables immediately with no grace when the account is no longer required but the person is still employed', () => {
    // A mover, not a leaver. The leaver grace timers are anchored to a
    // contract end date, and this person does not have one; inventing a
    // departure date for them would be inventing data.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      ladder: { ...ladder, disableGraceDays: 30, entitlementRevocationDelayDays: 14 },
    });
    // Revocations precede disable, and neither waits.
    expect(types(actions)).toEqual(['revoke_entitlement', 'disable_account']);
    expect(actions[1]!.message).toContain('still employed');
  });
});

describe('planActions — the leaver and the grace ladder', () => {
  const leaver = (endDate: string, over: Partial<LadderSettings> = {}) =>
    plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([['person-1', [contract({ endDate: day(endDate) })]]]),
      ladder: { ...ladder, ...over },
    });

  it('revokes and disables on the day the contract ends with the default zero grace', () => {
    expect(types(leaver('2026-06-15'))).toEqual([
      'revoke_entitlement',
      'disable_account',
    ]);
  });

  it('proposes nothing the day before a timer is due', () => {
    expect(types(leaver('2026-06-16', { disableGraceDays: 0 }))).toEqual([]);
  });

  it('proposes the disable exactly on the day it falls due', () => {
    expect(types(leaver('2026-06-08', { disableGraceDays: 7 }))).toEqual([
      'revoke_entitlement',
      'disable_account',
    ]);
  });

  it('proposes nothing the day before the disable falls due', () => {
    // The revocation delay has to move with the disable grace, or this case
    // proposes `revoke_entitlement`: the delay defaults to 0, so a contract
    // ending on the 9th makes the revocation due on the 9th and the run on the
    // 15th proposes it. "Nothing is due yet" means nothing on the whole
    // ladder, not just the rung being tested.
    expect(
      types(
        leaver('2026-06-09', {
          entitlementRevocationDelayDays: 7,
          disableGraceDays: 7,
        }),
      ),
    ).toEqual([]);
  });

  it('holds entitlements until their own delay elapses, then revokes', () => {
    expect(
      types(leaver('2026-06-12', { entitlementRevocationDelayDays: 3, disableGraceDays: 7 })),
    ).toEqual(['revoke_entitlement']);
  });

  it('archives once archiveAfterDays elapses, after the disable', () => {
    const actions = leaver('2026-03-15', { disableGraceDays: 7, archiveAfterDays: 90 });
    expect(types(actions)).toEqual([
      'revoke_entitlement',
      'disable_account',
      'archive_account',
    ]);
  });

  it('never archives when archiveAfterDays is null', () => {
    const actions = leaver('2020-01-01', { disableGraceDays: 7, archiveAfterDays: null });
    expect(types(actions)).not.toContain('archive_account');
  });

  it('runs the timers from the LATER of two contract end dates', () => {
    // A person whose second contract ran three months longer left three
    // months later. Anchoring to the first deprovisions somebody still employed.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([
        [
          'person-1',
          [
            contract({ id: 'a', endDate: day('2026-03-31') }),
            contract({ id: 'b', sequence: 2, endDate: day('2026-06-30') }),
          ],
        ],
      ]),
      ladder: { ...ladder, disableGraceDays: 0 },
    });
    expect(types(actions)).toEqual([]);
  });

  it('produces every due action at once for a departure observed late', () => {
    // A retroactive contract end whose grace had already elapsed before the
    // run first observed it produces its deprovisioning actions on that same
    // run. The grace runs from the contract end date; there is no second,
    // hidden clock that starts at observation.
    const actions = leaver('2026-01-01', {
      entitlementRevocationDelayDays: 0,
      disableGraceDays: 7,
      archiveAfterDays: 30,
    });
    expect(types(actions)).toEqual([
      'revoke_entitlement',
      'disable_account',
      'archive_account',
    ]);
    expect(actions[1]!.message).toContain('observed late');
  });
});

describe('planActions — the rehire', () => {
  const rehire = (disabledAt: string) =>
    plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day(disabledAt),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });

  it('enables the existing account rather than creating a second one', () => {
    // Keying the account on (personId, targetSystemId) is what makes this
    // automatic rather than a special case. They get their old login and their
    // old files back.
    const actions = rehire('2026-06-12');
    expect(types(actions)).toEqual(['enable_account', 'grant_entitlement']);
    expect(actions[0]!.accountId).toBe('account-1');
  });

  it('auto-applies a re-enable inside the window', () => {
    expect(rehire('2026-06-12')[0]!.requiresConfirmation).toBe(false);
  });

  it('requires confirmation for a re-enable outside the window', () => {
    // Months of accumulated entitlements are about to come back to life along
    // with the login, and an account reappearing after six months is also the
    // shape of a bad rule.
    const actions = rehire('2026-01-01');
    expect(actions[0]!.requiresConfirmation).toBe(true);
    expect(actions[0]!.message).toContain('disabled for 165 days');
  });

  it('treats exactly the boundary day as inside the window', () => {
    expect(rehire('2026-06-08')[0]!.requiresConfirmation).toBe(false);
  });
});

describe('planActions — rename', () => {
  it('proposes no rename when renameEnabled is off, even if the key changed', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.marsh',
          },
        }),
      ],
    });
    expect(types(actions)).not.toContain('rename_account');
  });

  it('proposes a confirmable rename when renameEnabled is on', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.marsh',
          },
        }),
      ],
      ladder: { ...ladder, renameEnabled: true },
    });
    expect(types(actions)).toContain('rename_account');
    expect(actions.find((a) => a.actionType === 'rename_account')!.requiresConfirmation).toBe(
      true,
    );
  });
});

describe('planActions — an account that vanished', () => {
  it('proposes a confirmable re-create and nothing else', () => {
    // An account that vanished usually vanished because somebody deleted it
    // deliberately, and an engine that silently puts it back the same night
    // is in an argument with an administrator, at nightly resolution, that
    // the administrator loses.
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'missing_at_target',
            existsAtTarget: false,
            enabledAtTarget: false,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['create_account']);
    expect(actions[0]!.requiresConfirmation).toBe(true);
    expect(actions[0]!.message).toContain('vanished');
  });
});

describe('planActions — the Syntra user', () => {
  it('deactivates the paired Syntra user alongside a disable', () => {
    // Without this, a leaver whose AD account Provision has just disabled
    // still holds a live Syntra login with a Syntra-held password.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-15') })]]]),
      syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'active' }]]]),
      pairedDirectorySource: true,
    });
    expect(types(actions)).toEqual([
      'revoke_entitlement',
      'disable_account',
      'deactivate_syntra_user',
    ]);
  });

  it('proposes nothing for the Syntra user when the target has no paired source', () => {
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-15') })]]]),
      syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'active' }]]]),
      pairedDirectorySource: false,
    });
    expect(types(actions)).not.toContain('deactivate_syntra_user');
  });

  it('reactivates the paired Syntra user alongside an enable', () => {
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day('2026-06-12'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'inactive' }]]]),
      pairedDirectorySource: true,
    });
    expect(types(actions)).toEqual([
      'enable_account',
      'reactivate_syntra_user',
      'grant_entitlement',
    ]);
  });
});

describe('planActions — the person who has not started', () => {
  it('proposes nothing at all for a future joiner who already holds an account', () => {
    // The case that made this a Ruling. Their contracts are open-ended, so
    // `latestContractEnd` is null, so `departed` is false, so the mover branch
    // takes `disableDue = true` unconditionally: an immediate revoke of
    // everything they hold and an immediate disable, carrying the message "the
    // person is still employed, so there is no departure date to measure a
    // grace period from" -- about somebody who starts in September.
    //
    // Spec section 8 requires the opposite: leave it exactly as it is and
    // report it as drift (reconcile does that). This asserts the plan is
    // EMPTY, which is the only assertion that distinguishes it from a leaver;
    // `account?.required === false` is equally true of both.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
          notYetStarted: true,
        }),
      ],
      contractsByPerson: new Map([
        ['person-1', [contract({ startDate: day('2026-09-01') })]],
      ]),
    });
    expect(actions).toEqual([]);
  });

  it('still deprovisions a leaver, who reaches the same required: false by another route', () => {
    // The guard against over-correcting: `notYetStarted` must gate on itself
    // and not on `required === false`, or nobody is ever deprovisioned again.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
          notYetStarted: false,
        }),
      ],
      contractsByPerson: new Map([
        ['person-1', [contract({ endDate: day('2026-06-15') })]],
      ]),
    });
    expect(types(actions)).toEqual(['revoke_entitlement', 'disable_account']);
  });
});

describe('planActions — persons excluded from the plan', () => {
  it('proposes nothing at all for an unprocessable person', () => {
    const actions = plan({
      desired: [
        desired({
          account: null,
          entitlements: new Set(),
          unprocessable: { kind: 'no_contracts', message: 'no contracts' },
        }),
      ],
    });
    expect(actions).toEqual([]);
  });
});

describe('ACTION_ORDER', () => {
  it('puts revocations before disable and archive last', () => {
    // Revocations precede disable so that a leaver's access is gone before
    // the account stops being writable in the way archiving makes it.
    const index = (t: string) => ACTION_ORDER.indexOf(t as never);
    expect(index('create_account')).toBeLessThan(index('update_account'));
    expect(index('update_account')).toBeLessThan(index('grant_entitlement'));
    expect(index('grant_entitlement')).toBeLessThan(index('revoke_entitlement'));
    expect(index('revoke_entitlement')).toBeLessThan(index('disable_account'));
    expect(index('disable_account')).toBeLessThan(index('archive_account'));
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief.
//
// Every test below this line exists because a branch that SKIPS a
// deprovisioning action was asked the dispatch's question: what happens to
// somebody who left last month? Six of them failed against the code as the
// brief wrote it.
// ---------------------------------------------------------------------------

describe('planActions — Ruling P23: an unresolvable rule must not keep a leaver alive', () => {
  const poisoned = (over: Partial<Parameters<typeof planActions>[0]> = {}) =>
    plan({
      desired: [
        desired({
          // `desiredState` returns its empty base for an unprocessable person,
          // so the account is null rather than a `required: false` account.
          // The planner cannot read a requirement out of it at all.
          account: null,
          entitlements: new Set(),
          attribution: new Map(),
          unprocessable: {
            kind: 'unresolvable_rule',
            message: 'the rule "Finance staff" names an entitlement missing from the catalog',
          },
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({
            // `reconcile` freezes the remit at `grants` scope, so there is
            // nothing revocable. The account is still reconciled normally.
            heldEntitlements: new Set(['ent-finance']),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-01-01') })]]]),
      ladder: { ...ladder, disableGraceDays: 7, archiveAfterDays: 30 },
      ...over,
    });

  it('still disables and archives a leaver whose rule could not be resolved', () => {
    // The brief skipped every unprocessable person outright, which is the
    // defect P23 names: access outlives employment because a rule references
    // an entitlement that no longer exists. A disabled account cannot use the
    // membership we failed to resolve, so proceeding is strictly safer than
    // waiting.
    expect(types(poisoned())).toEqual(['disable_account', 'archive_account']);
  });

  it('deactivates the paired Syntra user for that same leaver', () => {
    expect(
      types(
        poisoned({
          syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'active' }]]]),
          pairedDirectorySource: true,
        }),
      ),
    ).toEqual(['disable_account', 'deactivate_syntra_user', 'archive_account']);
  });

  it('proposes nothing for somebody still employed whose rule could not be resolved', () => {
    // The other direction, and the one that makes the scoping safe: with the
    // account decision unanswerable, the ONLY decision that does not depend on
    // the missing datum is deprovisioning somebody whose contracts have all
    // ended. An employed person is left exactly as they are.
    expect(
      types(poisoned({ contractsByPerson: new Map([['person-1', [contract()]]]) })),
    ).toEqual([]);
  });

  it('proposes nothing for a leaver whose whole record is unprocessable', () => {
    // Scope `all`, not `grants`: a template that cannot be rendered makes the
    // account decision itself unanswerable, so there is nothing to scope.
    expect(
      types(
        poisoned({
          desired: [
            desired({
              account: null,
              entitlements: new Set(),
              attribution: new Map(),
              unprocessable: {
                kind: 'template_unresolvable',
                message: 'the container template resolves to nothing',
              },
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('planActions — the paired Syntra user follows the departure, not the write', () => {
  const departedWith = (over: Partial<ActualState>) =>
    plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({ heldEntitlements: new Set(), heldWithinRemit: new Set(), ...over }),
        ],
      ]),
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-01') })]]]),
      syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'active' }]]]),
      pairedDirectorySource: true,
    });

  it('deactivates the Syntra user of a leaver whose account is already disabled at the target', () => {
    // The likeliest shape of all: an administrator disabled the account by
    // hand on the leaver's last day. The brief nested the deactivation inside
    // `disableDue && current.enabledAtTarget`, so the one write that was
    // already done silently cancelled the one that was not, and the leaver
    // kept a live Syntra login with a Syntra-held password forever.
    const actions = departedWith({
      status: 'disabled',
      enabledAtTarget: false,
      disabledAt: day('2026-06-01'),
    });
    expect(types(actions)).toEqual(['deactivate_syntra_user']);
    expect(actions[0]!.after).toEqual({ status: 'inactive', userId: 'user-1' });
  });

  it('deactivates the Syntra user of a leaver whose account vanished from the target', () => {
    expect(
      types(
        departedWith({
          status: 'missing_at_target',
          existsAtTarget: false,
          enabledAtTarget: false,
        }),
      ),
    ).toEqual(['deactivate_syntra_user']);
  });

  it('proposes nothing for a leaver who never had an account at this target', () => {
    // The boundary the fix must not cross: with no account row and nothing at
    // the target, this target has no relationship with the person to end.
    expect(
      types(
        departedWith({
          accountId: null,
          anchor: null,
          correlationKey: null,
          status: 'absent',
          existsAtTarget: false,
          enabledAtTarget: false,
          dn: null,
          attributes: {},
        }),
      ),
    ).toEqual([]);
  });

  it('leaves an already-inactive Syntra user alone', () => {
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: false,
                attributes: {},
                container: '',
                enabledNow: false,
                correlationKey: null,
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-01') })]]]),
          syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'inactive' }]]]),
          pairedDirectorySource: true,
        }),
      ),
    ).toEqual(['revoke_entitlement', 'disable_account']);
  });
});

describe('planActions — a person with two Syntra logins (Ruling P29)', () => {
  // "One person may hold several accounts: an everyday login and an admin
  // one" — `identity/person-service.ts`, in as many words. `syntraUserByPerson`
  // was a Map keyed on personId, which holds one value per key, so the second
  // login was silently dropped on the way into the planner and was never
  // proposed for deactivation on any run, ever.
  const everyday = { id: 'user-everyday', status: 'active' };
  const admin = { id: 'user-admin', status: 'active' };

  const departedWith = (logins: { id: string; status: string }[]) =>
    plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        ['person-1', actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() })],
      ]),
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-01') })]]]),
      syntraUserByPerson: new Map([['person-1', logins]]),
      pairedDirectorySource: true,
    });

  const userIds = (actions: ReturnType<typeof plan>, type: string) =>
    actions
      .filter((a) => a.actionType === type)
      .map((a) => (a.after as { userId: string }).userId);

  it('proposes a deactivation for BOTH logins on departure', () => {
    // The defect, stated as an assertion: against a Map-valued input this
    // returns one deactivation, and the login it leaves behind stays live
    // forever, because nothing re-examines a login no action ever names.
    const actions = departedWith([everyday, admin]);
    expect(types(actions)).toEqual([
      'disable_account',
      'deactivate_syntra_user',
      'deactivate_syntra_user',
    ]);
  });

  it('names WHICH login each deactivation is for', () => {
    // `applySyntraUserAction` takes an action id and resolves exactly one user
    // from `after.userId`, so two actions carrying the same id would deactivate
    // one login twice and the other never — the defect with an extra row.
    const actions = departedWith([everyday, admin]);
    expect(userIds(actions, 'deactivate_syntra_user')).toEqual([
      'user-everyday',
      'user-admin',
    ]);
    expect(
      actions
        .filter((a) => a.actionType === 'deactivate_syntra_user')
        .map((a) => a.before),
    ).toEqual([{ status: 'active' }, { status: 'active' }]);
  });

  it('does not lose the admin login when it is read first', () => {
    // Order-independent. The Map kept the LAST value written, so a fixture that
    // only ever listed the admin login second could not tell a fix from the bug.
    expect(userIds(departedWith([admin, everyday]), 'deactivate_syntra_user')).toEqual([
      'user-admin',
      'user-everyday',
    ]);
  });

  it('keeps the caller order, because the index becomes ProvisionAction.sequence', () => {
    expect(userIds(departedWith([admin, everyday]), 'deactivate_syntra_user')).not.toEqual(
      userIds(departedWith([everyday, admin]), 'deactivate_syntra_user'),
    );
  });

  it('proposes a deactivation for each of five logins', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      id: `user-${n}`,
      status: 'active',
    }));
    expect(userIds(departedWith(many), 'deactivate_syntra_user')).toEqual(
      many.map((u) => u.id),
    );
  });

  it('deactivates only the live logins, leaving an already-inactive one alone', () => {
    const actions = departedWith([everyday, { id: 'user-admin', status: 'inactive' }]);
    expect(userIds(actions, 'deactivate_syntra_user')).toEqual(['user-everyday']);
  });

  it('proposes nothing for a person with NO linked login', () => {
    // The empty case is the universal case: at a target whose paired source has
    // not run yet nobody has a Syntra login, and an empty list must behave
    // exactly like an absent key.
    expect(types(departedWith([]))).toEqual(['disable_account']);
  });

  it('proposes nothing for a person absent from the map entirely', () => {
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: false,
                attributes: {},
                container: '',
                enabledNow: false,
                correlationKey: null,
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          actual: new Map([
            [
              'person-1',
              actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() }),
            ],
          ]),
          contractsByPerson: new Map([
            ['person-1', [contract({ endDate: day('2026-06-01') })]],
          ]),
          syntraUserByPerson: new Map(),
          pairedDirectorySource: true,
        }),
      ),
    ).toEqual(['disable_account']);
  });

  it('proposes nothing for either login when the target has no paired source', () => {
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: false,
                attributes: {},
                container: '',
                enabledNow: false,
                correlationKey: null,
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          actual: new Map([
            [
              'person-1',
              actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() }),
            ],
          ]),
          contractsByPerson: new Map([
            ['person-1', [contract({ endDate: day('2026-06-01') })]],
          ]),
          syntraUserByPerson: new Map([['person-1', [everyday, admin]]]),
          pairedDirectorySource: false,
        }),
      ),
    ).toEqual(['disable_account']);
  });

  it('takes both logins from a leaver whose account was already disabled by hand', () => {
    // Route three and Ruling P29 in one fixture: the deactivations follow the
    // departure rather than the disable write, and there are two of them.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day('2026-06-01'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-01') })]]]),
      syntraUserByPerson: new Map([['person-1', [everyday, admin]]]),
      pairedDirectorySource: true,
    });
    expect(types(actions)).toEqual([
      'deactivate_syntra_user',
      'deactivate_syntra_user',
    ]);
    expect(userIds(actions, 'deactivate_syntra_user')).toEqual([
      'user-everyday',
      'user-admin',
    ]);
  });

  it('gives a returner every one of their logins back', () => {
    // The other direction of the same list. Reactivating only one would strand
    // the other inactive with nothing that ever looks at it again — the same
    // never-re-examined shape, pointed the harmless way.
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day('2026-06-12'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      syntraUserByPerson: new Map([
        [
          'person-1',
          [
            { id: 'user-everyday', status: 'inactive' },
            { id: 'user-admin', status: 'inactive' },
          ],
        ],
      ]),
      pairedDirectorySource: true,
    });
    expect(types(actions)).toEqual([
      'enable_account',
      'reactivate_syntra_user',
      'reactivate_syntra_user',
      'grant_entitlement',
    ]);
    expect(userIds(actions, 'reactivate_syntra_user')).toEqual([
      'user-everyday',
      'user-admin',
    ]);
  });

  it('gives back only the login that is not already active', () => {
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day('2026-06-12'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      syntraUserByPerson: new Map([
        [
          'person-1',
          [
            { id: 'user-everyday', status: 'active' },
            { id: 'user-admin', status: 'inactive' },
          ],
        ],
      ]),
      pairedDirectorySource: true,
    });
    expect(userIds(actions, 'reactivate_syntra_user')).toEqual(['user-admin']);
  });

  it('keeps one person’s logins away from another’s', () => {
    // Two leavers, one of them holding two logins. A grouping that appended to
    // the wrong bucket would deactivate a stranger’s login, which is the
    // failure `claimSyntraUsers` refuses to create in the first place.
    const leaver = (id: string) =>
      desired({
        personId: id,
        account: {
          required: false,
          attributes: {},
          container: '',
          enabledNow: false,
          correlationKey: null,
        },
        entitlements: new Set(),
        attribution: new Map(),
      });
    const actions = plan({
      desired: [leaver('person-1'), leaver('person-2')],
      actual: new Map([
        ['person-1', actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() })],
        [
          'person-2',
          actual({
            personId: 'person-2',
            accountId: 'account-2',
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      contractsByPerson: new Map([
        ['person-1', [contract({ endDate: day('2026-06-01') })]],
        ['person-2', [contract({ endDate: day('2026-06-01') })]],
      ]),
      syntraUserByPerson: new Map([
        ['person-1', [everyday, admin]],
        ['person-2', [{ id: 'user-bo', status: 'active' }]],
      ]),
      pairedDirectorySource: true,
    });
    expect(userIds(actions, 'deactivate_syntra_user')).toEqual([
      'user-everyday',
      'user-admin',
      'user-bo',
    ]);
  });
});

describe('planActions — case, which AD folds and PostgreSQL does not', () => {
  const withKeys = (desiredKey: string, currentKey: string) =>
    plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: desiredKey,
          },
        }),
      ],
      actual: new Map([['person-1', actual({ correlationKey: currentKey })]]),
      ladder: { ...ladder, renameEnabled: true },
    });

  it('proposes no rename when the key differs only in case', () => {
    // `sAMAccountName` is case-insensitive at the target and the generator
    // emits lowercase, so a key correlated from a pre-existing AD account
    // carries the directory's casing and differs from the generated one by
    // case alone. The brief compared with `!==`, which proposes a rename that
    // changes nothing -- every run, forever, each one asking an administrator
    // to confirm an operation documented as breaking certificate subjects,
    // profile paths, file ownership and mailbox aliases.
    expect(types(withKeys('anna.novak', 'Anna.Novak'))).toEqual([]);
  });

  it('still proposes a rename when the key genuinely differs', () => {
    expect(types(withKeys('anna.novak', 'Anna.Marsh'))).toEqual(['rename_account']);
  });

  const withAttributes = (attributes: Record<string, string[]>) =>
    plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes,
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
        }),
      ],
    });

  it('proposes no update when an attribute NAME differs only in case', () => {
    // LDAP attribute descriptions are case-insensitive (RFC 4512), so this
    // update writes the value it already holds under the name it already has.
    expect(types(withAttributes({ displayname: ['Anna Novak'] }))).toEqual([]);
  });

  it('still proposes an update when the VALUE differs under a differently-cased name', () => {
    // Values are not folded: the directory preserves the case it is given, so
    // `Anna Marsh` over `Anna Novak` is a real write.
    const actions = withAttributes({ displayname: ['Anna Marsh'] });
    expect(types(actions)).toEqual(['update_account']);
    expect(actions[0]!.after).toEqual({
      attributes: { displayname: ['Anna Marsh'] },
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
    });
  });

  it('still proposes an update when a differently-cased name arrives with a different value count', () => {
    expect(types(withAttributes({ displayname: ['Anna Novak', 'A. Novak'] }))).toEqual([
      'update_account',
    ]);
  });
});

describe('planActions — a re-enable whose disable date is unknown', () => {
  const enableWith = (over: Partial<ActualState>) =>
    plan({
      actual: new Map([
        [
          'person-1',
          actual({
            enabledAtTarget: false,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
            ...over,
          }),
        ],
      ]),
    });

  it('requires confirmation when Syntra disabled the account and has no record of when', () => {
    // The brief read a null `disabledAt` as zero days, which is the most
    // permissive possible answer to an unknown and auto-applies the re-enable.
    // An unknown date cannot be shown to be inside the window, and the
    // direction that grants access is the one that has to be shown.
    const actions = enableWith({ status: 'disabled', disabledAt: null });
    expect(types(actions)).toEqual(['enable_account', 'grant_entitlement']);
    expect(actions[0]!.requiresConfirmation).toBe(true);
    expect(actions[0]!.message).toContain('no record of when');
  });

  it('auto-applies the first enable of a pre-hire account created disabled', () => {
    // The boundary the fix must not cross: an account Syntra records as active
    // and has never disabled has no disable date because there was no disable.
    // Confirming every joiner's start date would be the over-correction.
    const actions = enableWith({ status: 'active', disabledAt: null });
    expect(types(actions)).toEqual(['enable_account', 'grant_entitlement']);
    expect(actions[0]!.requiresConfirmation).toBe(false);
  });
});

describe('planActions — the immediate disable must not claim employment it cannot see', () => {
  it('names the real reason for somebody between contracts', () => {
    // An ended contract beside a future open-ended one: `latestContractEnd` is
    // null because one contract is open-ended, so `departed` is false and the
    // disable is immediate -- correctly. But the brief's message told the
    // administrator reading it that "the person is still employed", which is
    // exactly the sentence this slice must never assert without evidence.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      contractsByPerson: new Map([
        [
          'person-1',
          [
            contract({ id: 'ended', endDate: day('2026-01-01') }),
            contract({ id: 'future', sequence: 2, startDate: day('2026-09-01') }),
          ],
        ],
      ]),
    });
    expect(types(actions)).toEqual(['revoke_entitlement', 'disable_account']);
    expect(actions[1]!.message).not.toContain('still employed');
    expect(actions[1]!.message).toContain('no contract in force today');
  });
});

describe('planActions — what is left alone', () => {
  it('does not archive an account that is already archived', () => {
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: false,
                attributes: {},
                container: '',
                enabledNow: false,
                correlationKey: null,
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          actual: new Map([
            [
              'person-1',
              actual({
                status: 'archived',
                enabledAtTarget: false,
                disabledAt: day('2026-01-08'),
                heldEntitlements: new Set(),
                heldWithinRemit: new Set(),
              }),
            ],
          ]),
          contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-01-01') })]]]),
          ladder: { ...ladder, disableGraceDays: 7, archiveAfterDays: 30 },
        }),
      ),
    ).toEqual([]);
  });

  it('never revokes an entitlement the target holds outside Provision remit', () => {
    // `heldEntitlements` is everything the target holds; `heldWithinRemit` is
    // the revocable subset. Differencing against the wrong one revokes
    // memberships no business rule for this target ever named.
    expect(
      types(
        plan({
          actual: new Map([
            [
              'person-1',
              actual({
                heldEntitlements: new Set(['ent-finance', 'ent-legacy']),
                heldWithinRemit: new Set(['ent-finance']),
              }),
            ],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it('carries the entitlement id on both a grant and a revocation', () => {
    const actions = plan({
      desired: [
        desired({
          entitlements: new Set(['ent-facilities']),
          attribution: new Map([
            [
              'ent-facilities',
              [{ ruleId: 'rule-fac', ruleName: 'Facilities', contractId: 'contract-1' }],
            ],
          ]),
        }),
      ],
    });
    expect(actions.map((a) => [a.actionType, a.entitlementId])).toEqual([
      ['grant_entitlement', 'ent-facilities'],
      ['revoke_entitlement', 'ent-finance'],
    ]);
  });
});

describe('planActions — the order the run is applied in', () => {
  it('keeps every person behind their own create and preserves input order within a type', () => {
    // The returned array order IS the `sequence` column: Task 13 writes
    // `sequence: index` from it, because `createdAt` is transaction start time
    // in PostgreSQL and is identical for every row one `createMany` writes.
    // Two people therefore have to interleave deterministically, and a grant
    // must never precede the create of the account it belongs to.
    const joiner = (personId: string, entitlementId: string) =>
      desired({
        personId,
        entitlements: new Set([entitlementId]),
        attribution: new Map([
          [
            entitlementId,
            [{ ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'contract-1' }],
          ],
        ]),
      });
    const absent = (personId: string) =>
      actual({
        personId,
        accountId: null,
        anchor: null,
        status: 'absent',
        existsAtTarget: false,
        enabledAtTarget: false,
        dn: null,
        attributes: {},
        heldEntitlements: new Set(),
        heldWithinRemit: new Set(),
      });

    const actions = plan({
      desired: [joiner('person-1', 'ent-a'), joiner('person-2', 'ent-b')],
      actual: new Map([
        ['person-1', absent('person-1')],
        ['person-2', absent('person-2')],
      ]),
      contractsByPerson: new Map([
        ['person-1', [contract()]],
        ['person-2', [contract()]],
      ]),
    });

    expect(actions.map((a) => [a.actionType, a.personId])).toEqual([
      ['create_account', 'person-1'],
      ['create_account', 'person-2'],
      ['grant_entitlement', 'person-1'],
      ['grant_entitlement', 'person-2'],
    ]);
    for (const personId of ['person-1', 'person-2']) {
      const create = actions.findIndex(
        (a) => a.personId === personId && a.actionType === 'create_account',
      );
      const grant = actions.findIndex(
        (a) => a.personId === personId && a.actionType === 'grant_entitlement',
      );
      expect(create).toBeLessThan(grant);
    }
  });
});

// ---------------------------------------------------------------------------
// Written during the mutation pass: every test below killed a mutant that
// survived everything above it.
// ---------------------------------------------------------------------------

describe('planActions — the update diff, closely', () => {
  const withDesired = (
    attributes: Record<string, string[]>,
    container = 'OU=Finance,OU=Users,DC=acme,DC=test',
  ) =>
    plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes,
            container,
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
        }),
      ],
    });

  it('proposes an update when a VALUE differs only in case', () => {
    // The other half of the folding rule: names are folded, values are not.
    // Folding both makes `ANNA NOVAK` and `Anna Novak` the same desired state
    // and the template's answer never reaches the directory.
    expect(types(withDesired({ displayName: ['ANNA NOVAK'] }))).toEqual([
      'update_account',
    ]);
  });

  it('proposes an update for an attribute the account does not have yet', () => {
    // The comparison has to walk the union of both sides. Walking only the
    // actual side misses every attribute newly added to the profile.
    expect(
      types(withDesired({ displayName: ['Anna Novak'], department: ['Finance'] })),
    ).toEqual(['update_account']);
  });

  it('proposes an update for an attribute the account has and the profile no longer sets', () => {
    // And the other direction: walking only the desired side leaves a
    // withdrawn attribute in place forever.
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: true,
                attributes: {},
                container: 'OU=Finance,OU=Users,DC=acme,DC=test',
                enabledNow: true,
                correlationKey: 'anna.novak',
              },
            }),
          ],
        }),
      ),
    ).toEqual(['update_account']);
  });

  it('proposes no update when the container differs only in case', () => {
    // A DN is case-insensitive at the target, and the case a connector returns
    // is the directory's, not the profile's.
    expect(
      types(
        plan({
          actual: new Map([
            [
              'person-1',
              actual({ dn: 'CN=Anna Novak,ou=finance,ou=users,dc=acme,dc=test' }),
            ],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it('creates rather than updates when Syntra holds a disabled account the target does not have', () => {
    // An account row with no anchor: there is no object at the target to
    // update, enable or rename, whatever status the row carries. An update
    // against an object that is not there cannot succeed at any connector.
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            anchor: null,
            status: 'disabled',
            existsAtTarget: false,
            enabledAtTarget: false,
            disabledAt: day('2026-06-12'),
            dn: null,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['create_account', 'grant_entitlement']);
    expect(actions[0]!.after).toMatchObject({ enabled: true });
  });
});

describe('planActions — the Syntra user, closely', () => {
  const rehireWith = (
    user: { id: string; status: string } | null,
    pairedDirectorySource: boolean,
  ) =>
    plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: day('2026-06-12'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      syntraUserByPerson: new Map(user ? [['person-1', [user]]] : []),
      pairedDirectorySource,
    });

  it('proposes no reactivation when the target has no paired source', () => {
    expect(types(rehireWith({ id: 'user-1', status: 'inactive' }, false))).toEqual([
      'enable_account',
      'grant_entitlement',
    ]);
  });

  it('proposes no reactivation for a Syntra user who is already active', () => {
    expect(types(rehireWith({ id: 'user-1', status: 'active' }, true))).toEqual([
      'enable_account',
      'grant_entitlement',
    ]);
  });

  it('does not deactivate the Syntra user of a leaver still inside their grace period', () => {
    // The deactivation follows the departure, but it follows the DUE
    // departure. Detaching it from the disable must not detach it from the
    // ladder, or the grace period stops meaning anything.
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: false,
                attributes: {},
                container: '',
                enabledNow: false,
                correlationKey: null,
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          actual: new Map([
            ['person-1', actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() })],
          ]),
          contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-12') })]]]),
          syntraUserByPerson: new Map([['person-1', [{ id: 'user-1', status: 'active' }]]]),
          pairedDirectorySource: true,
          ladder: { ...ladder, disableGraceDays: 30, entitlementRevocationDelayDays: 30 },
        }),
      ),
    ).toEqual([]);
  });
});

describe('planActions — the archive, closely', () => {
  const archivable = (over: Partial<Parameters<typeof planActions>[0]> = {}) =>
    plan({
      desired: [
        desired({
          account: {
            required: false,
            attributes: {},
            container: '',
            enabledNow: false,
            correlationKey: null,
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({
            enabledAtTarget: false,
            status: 'disabled',
            disabledAt: day('2026-01-08'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
      contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-01-01') })]]]),
      ladder: { ...ladder, disableGraceDays: 7, archiveAfterDays: 30 },
      ...over,
    });

  it('archives a disabled leaver once the timer has elapsed', () => {
    expect(types(archivable())).toEqual(['archive_account']);
  });

  it('does not archive an account that is not at the target', () => {
    // There is nothing there to move. Proposing it produces an action that can
    // only fail at the connector.
    expect(
      types(
        archivable({
          actual: new Map([
            [
              'person-1',
              actual({
                status: 'missing_at_target',
                existsAtTarget: false,
                enabledAtTarget: false,
                heldEntitlements: new Set(),
                heldWithinRemit: new Set(),
              }),
            ],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it('never archives a mover, who has no departure date to measure from', () => {
    // `archiveAfterDays` is measured from the contract end date, and a mover
    // does not have one. This is the branch that would read it off a null.
    expect(
      types(
        archivable({
          contractsByPerson: new Map([['person-1', [contract()]]]),
          actual: new Map([
            ['person-1', actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() })],
          ]),
        }),
      ),
    ).toEqual(['disable_account']);
  });
});

describe('planActions — the guards that hold when something upstream changes', () => {
  it('proposes nothing for a person the reconciliation produced no actual state for', () => {
    // `reconcile` omits a person whose account it could not diff safely at
    // all. The planner has nothing to compare against, so it proposes nothing
    // rather than treating an absent entry as an empty target.
    expect(
      types(plan({ desired: [desired()], actual: new Map() })),
    ).toEqual([]);
  });

  it('grants nothing from the desired set of a person whose grants are poisoned', () => {
    // Unreachable through `desiredState` today, which returns an empty set
    // with an `unresolvable_rule` verdict. It pins the guard rather than a
    // path: the empty set is empty for want of an answer, so anything that
    // ever puts entitlements in it must not cause them to be granted. The
    // revocation loop deliberately carries no such guard -- a guard whose
    // failure direction is "more access persists" is not a safety net -- so
    // the revocation this fixture's remit implies is still proposed, and that
    // asymmetry is the point of the test.
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: true,
                attributes: { displayName: ['Anna Novak'] },
                container: 'OU=Finance,OU=Users,DC=acme,DC=test',
                enabledNow: true,
                correlationKey: 'anna.novak',
              },
              entitlements: new Set(['ent-facilities']),
              attribution: new Map(),
              unprocessable: {
                kind: 'unresolvable_rule',
                message: 'a rule names an entitlement missing from the catalog',
              },
            }),
          ],
          contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-01-01') })]]]),
        }),
      ),
    ).toEqual(['revoke_entitlement']);
  });
});

describe('planActions — three more the mutation pass asked for', () => {
  it('does not enable a pre-hire whose account already exists but who has not started', () => {
    // The security property the two dates in `desiredState` exist for. The
    // account is REQUIRED before the start date and must stay disabled until
    // it; an enable driven by "the target says disabled" alone hands somebody
    // their login a fortnight early, every run, silently.
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: true,
                attributes: { displayName: ['Anna Novak'] },
                container: 'OU=Finance,OU=Users,DC=acme,DC=test',
                enabledNow: false,
                correlationKey: 'anna.novak',
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          actual: new Map([
            [
              'person-1',
              actual({
                enabledAtTarget: false,
                heldEntitlements: new Set(),
                heldWithinRemit: new Set(),
              }),
            ],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it('runs the archive timer on its own days, not on the disable grace', () => {
    // Both timers are measured from the same contract end date, which is what
    // makes reading the wrong one invisible whenever the two settings happen
    // to have both elapsed. Here the disable has fallen due and the archive
    // has not.
    expect(
      types(
        plan({
          desired: [
            desired({
              account: {
                required: false,
                attributes: {},
                container: '',
                enabledNow: false,
                correlationKey: null,
              },
              entitlements: new Set(),
              attribution: new Map(),
            }),
          ],
          actual: new Map([
            ['person-1', actual({ heldEntitlements: new Set(), heldWithinRemit: new Set() })],
          ]),
          contractsByPerson: new Map([['person-1', [contract({ endDate: day('2026-06-01') })]]]),
          ladder: { ...ladder, disableGraceDays: 7, archiveAfterDays: 90 },
        }),
      ),
    ).toEqual(['disable_account']);
  });

  it('reports whole days elapsed, rounding neither up nor to the calendar', () => {
    // `disabledAt` is a real timestamp, not a midnight-aligned contract date.
    // 164 days and 18 hours is 164 whole days; reporting 165 overstates how
    // long the account was out of use in the sentence an administrator reads
    // before deciding.
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: new Date('2026-01-01T06:00:00Z'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(actions[0]!.requiresConfirmation).toBe(true);
    expect(actions[0]!.message).toContain('disabled for 164 days');
  });
});

describe('planActions — the re-enable window is an interval, not a day count', () => {
  it('confirms a re-enable seven days and twelve hours after the disable', () => {
    // The window is decided on the instant. Rounding the elapsed time down to
    // whole days first makes a window an administrator wrote as seven days run
    // for very nearly eight, and where it lands depends on what time of day
    // the run starts -- so the same account confirms or does not depending on
    // when the scheduler happens to fire.
    const actions = plan({
      actual: new Map([
        [
          'person-1',
          actual({
            status: 'disabled',
            enabledAtTarget: false,
            disabledAt: new Date('2026-06-07T12:00:00Z'),
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['enable_account', 'grant_entitlement']);
    expect(actions[0]!.requiresConfirmation).toBe(true);
  });
});

describe('planActions — what the re-create of a vanished account carries', () => {
  it('recreates it disabled when the person has not started, and under the name it had', () => {
    // The brief's vanished-account test could not see either of these: its
    // fixture wanted an enabled account and gave the account the same key the
    // profile would generate, so `enabled: true` and "use the generated key"
    // were both indistinguishable from the right answers. A pre-hire whose
    // account somebody deleted must come back disabled, and it must come back
    // as the login they had rather than as a second name for the same person.
    const actions = plan({
      desired: [
        desired({
          account: {
            required: true,
            attributes: { displayName: ['Anna Novak'] },
            container: 'OU=Finance,OU=Users,DC=acme,DC=test',
            enabledNow: false,
            correlationKey: 'anna.novak',
          },
          entitlements: new Set(),
          attribution: new Map(),
        }),
      ],
      actual: new Map([
        [
          'person-1',
          actual({
            correlationKey: 'Anna.Novak',
            status: 'missing_at_target',
            existsAtTarget: false,
            enabledAtTarget: false,
            heldEntitlements: new Set(),
            heldWithinRemit: new Set(),
          }),
        ],
      ]),
    });
    expect(types(actions)).toEqual(['create_account']);
    expect(actions[0]!.after).toEqual({
      correlationKey: 'Anna.Novak',
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      attributes: { displayName: ['Anna Novak'] },
      enabled: false,
    });
    expect(actions[0]!.requiresConfirmation).toBe(true);
  });
});
