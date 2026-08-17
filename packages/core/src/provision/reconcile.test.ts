import { describe, expect, it } from 'vitest';
import { driftFingerprint, reconcile, unprocessableScope } from './reconcile.js';
import type {
  DesiredState,
  KnownAccount,
  TargetObject,
  UnprocessableKind,
} from './types.js';

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
  attribution: new Map(),
  notYetStarted: false,
  unprocessable: null,
  ...over,
});

/** A person with no account of their own: a leaver, or somebody with none yet. */
const noAccount = (over: Partial<DesiredState> = {}): DesiredState =>
  desired({
    account: {
      required: false,
      attributes: {},
      container: '',
      enabledNow: false,
      correlationKey: null,
    },
    entitlements: new Set(),
    ...over,
  });

const known = (over: Partial<KnownAccount> = {}): KnownAccount => ({
  id: 'account-1',
  personId: 'person-1',
  anchor: 'anchor-1',
  correlationKey: 'anna.novak',
  status: 'active',
  disabledAt: null,
  lastAppliedAttributes: { displayName: ['Anna Novak'] },
  holdings: [
    { entitlementId: 'ent-finance', origin: 'rule', grantedByRuleId: 'rule-finance' },
  ],
  ...over,
});

const object = (over: Partial<TargetObject> = {}): TargetObject => ({
  anchor: 'anchor-1',
  correlationKey: 'anna.novak',
  dn: 'CN=Anna Novak,OU=Finance,OU=Users,DC=acme,DC=test',
  enabled: true,
  provenance: 'tenant-1/action-1',
  entitlementIds: ['ent-finance'],
  readComplete: true,
  ...over,
});

const run = (over: Partial<Parameters<typeof reconcile>[0]> = {}) =>
  reconcile({
    desired: [desired()],
    known: [known()],
    objects: [object()],
    remit: new Set(['ent-finance', 'ent-teaching']),
    // Lowercased, as the run supplies them.
    existingContainers: new Set([
      'ou=finance,ou=users,dc=acme,dc=test',
      'ou=users,dc=acme,dc=test',
    ]),
    desiredContainers: new Map([['person-1', 'OU=Finance,OU=Users,DC=acme,DC=test']]),
    enforcementMode: 'additive',
    ...over,
  });

describe('driftFingerprint', () => {
  it('is stable for the same problem and distinct for different ones', () => {
    // A finding that persists across runs is updated rather than duplicated,
    // so the count on the dashboard is a count of problems, not of runs.
    expect(driftFingerprint('unmanaged_entitlement', 'a', 'e')).toBe(
      driftFingerprint('unmanaged_entitlement', 'a', 'e'),
    );
    expect(driftFingerprint('unmanaged_entitlement', 'a', 'e')).not.toBe(
      driftFingerprint('missing_grant', 'a', 'e'),
    );
    expect(driftFingerprint('orphan_account', null, null)).toBe(
      'orphan_account:-:-:-',
    );
  });

  it('distinguishes two findings of the same kind on the same account by subject', () => {
    // Two different problems can be `unexpected_status` about one account: the
    // target reports a status Syntra did not expect, and the account belongs
    // to somebody who has not started. Sharing a fingerprint would make each
    // overwrite the other on every run, so the dashboard would show one and
    // never both, alternating.
    expect(driftFingerprint('unexpected_status', 'a', null)).not.toBe(
      driftFingerprint('unexpected_status', 'a', null, 'not_yet_started'),
    );
  });

  it('keeps an orphan out of the entitlement slot', () => {
    // The anchor identifies the orphan and belongs in `subject`.
    // `entitlementId` is a @db.Uuid column and a target anchor is not one.
    expect(driftFingerprint('orphan_account', null, null, 'anchor-9')).toBe(
      'orphan_account:-:-:anchor-9',
    );
  });

  it('distinguishes findings that differ only in the account', () => {
    expect(driftFingerprint('missing_grant', 'a', 'e')).not.toBe(
      driftFingerprint('missing_grant', 'b', 'e'),
    );
  });

  it('distinguishes findings that differ only in the entitlement', () => {
    expect(driftFingerprint('missing_grant', 'a', 'e')).not.toBe(
      driftFingerprint('missing_grant', 'a', 'f'),
    );
  });
});

describe('reconcile — the four outcomes', () => {
  it('agrees, and records nothing, when Syntra granted it and the target has it', () => {
    const result = run();
    expect(result.findings).toEqual([]);
    const actual = result.actual.get('person-1')!;
    expect(actual.existsAtTarget).toBe(true);
    expect([...actual.heldEntitlements]).toEqual(['ent-finance']);
  });

  it('records a missing grant when Syntra granted it and the target does not have it', () => {
    // Convergence, not drift policing. Provision is authoritative for what
    // Provision granted, and a grant that silently disappeared is the
    // subsystem's own state having come apart.
    const result = run({ objects: [object({ entitlementIds: [] })] });
    expect(result.findings).toEqual([
      {
        kind: 'missing_grant',
        accountId: 'account-1',
        entitlementId: 'ent-finance',
        subjectAnchor: null,
        detail: {
          reason: 'Provision granted this entitlement and the target no longer holds it',
          origin: 'rule',
        },
        fingerprint: 'missing_grant:account-1:ent-finance:-',
      },
    ]);
    // And the actual state says it is not held, so the plan proposes the grant.
    expect([...result.actual.get('person-1')!.heldEntitlements]).toEqual([]);
  });

  it('records drift and leaves it alone under additive when the target has what Provision never granted', () => {
    const result = run({
      objects: [object({ entitlementIds: ['ent-finance', 'ent-teaching'] })],
      enforcementMode: 'additive',
    });
    expect(result.findings).toEqual([
      {
        kind: 'unmanaged_entitlement',
        accountId: 'account-1',
        entitlementId: 'ent-teaching',
        subjectAnchor: null,
        detail: {
          reason: 'the target holds this entitlement and Provision did not grant it',
          enforcementMode: 'additive',
          proposedForRevocation: false,
        },
        fingerprint: 'unmanaged_entitlement:account-1:ent-teaching:-',
      },
    ]);
    // Left alone means ABSENT from the set the planner differences against.
    // `planActions` revokes everything in `heldWithinRemit` that the rules do
    // not ask for, so putting an unmanaged entitlement in that set is how
    // additive would come to revoke the one thing it promises never to touch.
    expect([...result.actual.get('person-1')!.heldWithinRemit]).toEqual([
      'ent-finance',
    ]);
    // It is still reported as held, so nothing proposes granting it either.
    expect([...result.actual.get('person-1')!.heldEntitlements].sort()).toEqual([
      'ent-finance',
      'ent-teaching',
    ]);
  });

  it('records the SAME drift under authoritative and marks it for revocation', () => {
    // Ruling P2: drift is reported under BOTH modes. Additive must mean "I saw
    // this and left it", never "I did not look".
    const result = run({
      objects: [object({ entitlementIds: ['ent-finance', 'ent-teaching'] })],
      enforcementMode: 'authoritative',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('unmanaged_entitlement');
    expect(result.findings[0]!.detail.proposedForRevocation).toBe(true);
    // And "proposed for revocation" is not a label on a finding nobody acts
    // on: the entitlement is in the set the planner differences against, which
    // is the only thing that can actually revoke it.
    expect([...result.actual.get('person-1')!.heldWithinRemit].sort()).toEqual([
      'ent-finance',
      'ent-teaching',
    ]);
  });

  it('never revokes an entitlement no rule mentions, even under authoritative', () => {
    // "Provision manages this target" and "Provision manages every group in
    // this target" are different claims, and only the first is ever true.
    const result = run({
      objects: [object({ entitlementIds: ['ent-finance', 'ent-outside'] })],
      remit: new Set(['ent-finance']),
      enforcementMode: 'authoritative',
    });
    const finding = result.findings.find((f) => f.entitlementId === 'ent-outside');
    expect(finding?.detail.proposedForRevocation).toBe(false);
    expect(finding?.detail.reason).toContain('outside');
    // And it is absent from the set the plan differences against, so nothing
    // downstream can propose revoking it either.
    expect(result.actual.get('person-1')!.heldWithinRemit.has('ent-outside')).toBe(false);
  });

  it('keeps converging something Provision granted after its rule left the remit', () => {
    // Deleting a rule takes its entitlement out of the remit. Provision still
    // granted this one, so it is still Provision's to take away when the rules
    // stop asking for it -- otherwise deleting a rule strands every grant it
    // ever made, permanently, and the only route back is by hand.
    const result = run({ remit: new Set() });
    expect(result.findings).toEqual([]);
    expect([...result.actual.get('person-1')!.heldWithinRemit]).toEqual([
      'ent-finance',
    ]);
  });

  it('records an orphan for an account belonging to no person Syntra knows', () => {
    // Provision records it and does nothing else. Deciding whether an orphan
    // should exist is Govern's.
    const result = run({
      objects: [object(), object({ anchor: 'anchor-9', correlationKey: 'someone.else' })],
    });
    expect(result.findings).toEqual([
      {
        kind: 'orphan_account',
        accountId: null,
        entitlementId: null,
        subjectAnchor: 'anchor-9',
        detail: {
          anchor: 'anchor-9',
          correlationKey: 'someone.else',
          dn: 'CN=Anna Novak,OU=Finance,OU=Users,DC=acme,DC=test',
          reason: 'the target holds this account and it belongs to no person Syntra knows',
        },
        fingerprint: 'orphan_account:-:-:anchor-9',
      },
    ]);
  });
});

describe('reconcile — what counts as an orphan', () => {
  // An orphan is an object no ROW of Syntra's claims, which is a property of
  // `known` alone. Deriving it from how far the desired loop got instead makes
  // every early exit a fresh way to report Provision's own accounts as
  // accounts it has never seen -- and then to propose dealing with them.

  it('does not orphan an account whose person is not in this run at all', () => {
    const result = run({ desired: [] });
    expect(result.findings).toEqual([]);
  });

  it('does not orphan the account of a person it cannot process', () => {
    const result = run({
      desired: [
        desired({
          account: null,
          entitlements: new Set(),
          unprocessable: { kind: 'no_contracts', message: 'no contracts' },
        }),
      ],
    });
    expect(result.findings).toEqual([]);
  });

  it('does not orphan the account of a person in conflict', () => {
    const result = run({ known: [known({ status: 'conflict' })] });
    expect(result.findings).toEqual([]);
  });

  it('does not orphan an account that could not be read in full', () => {
    const result = run({ objects: [object({ readComplete: false })] });
    expect(result.findings).toEqual([]);
  });

  it('does not orphan the account of a person whose container is missing', () => {
    const result = run({
      desiredContainers: new Map([['person-1', 'OU=Nowhere,OU=Users,DC=acme,DC=test']]),
    });
    expect(result.findings).toEqual([]);
  });

  it('reports one finding per unclaimed object', () => {
    const result = run({
      objects: [
        object(),
        object({ anchor: 'anchor-8', correlationKey: 'a.eight' }),
        object({ anchor: 'anchor-9', correlationKey: 'a.nine' }),
      ],
    });
    expect(result.findings.map((f) => f.subjectAnchor)).toEqual([
      'anchor-8',
      'anchor-9',
    ]);
  });
});

describe('reconcile — an account that vanished', () => {
  it('marks it missing_at_target and records a finding', () => {
    const result = run({ objects: [] });
    const actual = result.actual.get('person-1')!;
    expect(actual.status).toBe('missing_at_target');
    expect(actual.existsAtTarget).toBe(false);
    expect(result.findings).toEqual([
      {
        kind: 'account_missing_at_target',
        accountId: 'account-1',
        entitlementId: null,
        subjectAnchor: null,
        detail: {
          anchor: 'anchor-1',
          correlationKey: 'anna.novak',
          reason:
            'Syntra holds this account and the target no longer returns its anchor',
        },
        fingerprint: 'account_missing_at_target:account-1:-:-',
      },
    ]);
  });

  it('does not mark a pending account missing, because it never existed', () => {
    // A `pending` row is a reserved correlation key, not a vanished account.
    const result = run({
      known: [known({ anchor: null, status: 'pending', holdings: [] })],
      objects: [],
    });
    expect(result.actual.get('person-1')!.status).toBe('pending');
    expect(result.findings).toEqual([]);
  });

  it('does not mark an archived account missing, because it was meant to go', () => {
    const result = run({ known: [known({ status: 'archived' })], objects: [] });
    expect(result.actual.get('person-1')!.status).toBe('archived');
    expect(result.actual.get('person-1')!.existsAtTarget).toBe(false);
    // An object that is not there is not enabled. Defaulting the other way
    // tells the planner an archived account still needs disabling, forever.
    expect(result.actual.get('person-1')!.enabledAtTarget).toBe(false);
    // And no `missing_grant` either: there is no object to be missing from.
    expect(result.findings).toEqual([]);
  });
});

describe('reconcile — unexpected status', () => {
  it('records drift when Syntra believes an account is active and the target has it disabled', () => {
    // The residual gap named in spec section 4: an account disabled by an
    // administrator outside Provision. Recorded, not silently reversed.
    const result = run({ objects: [object({ enabled: false })] });
    expect(result.findings).toEqual([
      {
        kind: 'unexpected_status',
        accountId: 'account-1',
        entitlementId: null,
        subjectAnchor: null,
        detail: {
          syntraBelieves: 'active',
          targetReports: 'disabled',
          reason: 'the account status at the target does not match what Syntra recorded',
        },
        fingerprint: 'unexpected_status:account-1:-:-',
      },
    ]);
    expect(result.actual.get('person-1')!.enabledAtTarget).toBe(false);
  });

  it('records no status drift when Syntra believes it is disabled and it is', () => {
    const result = run({
      known: [known({ status: 'disabled', disabledAt: new Date('2026-06-01') })],
      objects: [object({ enabled: false })],
    });
    expect(result.findings).toEqual([]);
  });

  it('records drift when Syntra believes it is disabled and the target has it enabled', () => {
    const result = run({
      known: [known({ status: 'disabled', disabledAt: new Date('2026-06-01') })],
    });
    expect(result.findings).toEqual([
      {
        kind: 'unexpected_status',
        accountId: 'account-1',
        entitlementId: null,
        subjectAnchor: null,
        detail: {
          syntraBelieves: 'disabled',
          targetReports: 'active',
          reason: 'the account status at the target does not match what Syntra recorded',
        },
        fingerprint: 'unexpected_status:account-1:-:-',
      },
    ]);
  });

  it('records drift when an archived account has been switched back on', () => {
    // An archived account is a disabled one that has been put away. Somebody
    // re-enabling it is drift by exactly the same argument as re-enabling a
    // disabled one, and enumerating mismatching pairs rather than stating the
    // expectation is what left this case unreported.
    const result = run({ known: [known({ status: 'archived' })] });
    expect(result.findings).toEqual([
      {
        kind: 'unexpected_status',
        accountId: 'account-1',
        entitlementId: null,
        subjectAnchor: null,
        detail: {
          syntraBelieves: 'archived',
          targetReports: 'active',
          reason: 'the account status at the target does not match what Syntra recorded',
        },
        fingerprint: 'unexpected_status:account-1:-:-',
      },
    ]);
  });

  it('records no status drift for an archived account the target reports disabled', () => {
    const result = run({
      known: [known({ status: 'archived' })],
      objects: [object({ enabled: false })],
    });
    expect(result.findings).toEqual([]);
  });

  it('expects nothing of a pending row that already carries an anchor', () => {
    // The three-step apply can leave one: the account was created at the
    // target and the status write did not land. Syntra recorded no belief
    // about it, so there is no belief for the target to contradict, and
    // inventing one turns a crash Provision is about to converge anyway into
    // a drift finding somebody has to read and dismiss.
    // The object carries no entitlements either. With the default fixture's
    // `ent-finance` left in place this case also asserts that an entitlement
    // the target holds and Provision never granted goes unreported — which is
    // false, and is a finding `unmanaged_entitlement` exists to raise. The
    // status question is the one under test here, so the entitlement question
    // is removed from the fixture rather than asserted away.
    const result = run({
      known: [known({ status: 'pending', holdings: [] })],
      objects: [object({ entitlementIds: [] })],
    });
    expect(result.findings).toEqual([]);
    expect(result.actual.get('person-1')!.status).toBe('pending');
    expect(result.actual.get('person-1')!.existsAtTarget).toBe(true);
  });

  it('reports nothing for a person who has not started and has no account yet', () => {
    // The ordinary shape of a pre-hire: nothing at the target to report on.
    // The finding is about an ACCOUNT belonging to somebody who has not
    // started, so with no account there is no finding.
    const result = run({
      desired: [noAccount({ notYetStarted: true })],
      known: [],
      objects: [],
    });
    expect(result.findings).toEqual([]);
    expect(result.actual.get('person-1')!.accountId).toBeNull();
  });
});

describe('reconcile — the container check', () => {
  it('excludes a person whose desired container does not exist in the target', () => {
    // Provision does not create organizational units in somebody else's
    // domain, and the run says which container was missing.
    const result = run({
      desiredContainers: new Map([['person-1', 'OU=Nowhere,OU=Users,DC=acme,DC=test']]),
    });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'container_missing',
      message:
        'the container OU=Nowhere,OU=Users,DC=acme,DC=test does not exist in the target; Provision does not create it',
    });
  });

  it('does not check the container for somebody who needs no account', () => {
    const result = run({
      desired: [noAccount()],
      desiredContainers: new Map(),
    });
    expect(result.extraUnprocessable.size).toBe(0);
  });

  it('does not check the container of an account that is not required', () => {
    // The gate is `required`, not "there is an account object". A person who
    // should have no account is not made unprocessable by a container nobody
    // is going to write into -- that would freeze every other decision about
    // them, a leaver's disable and archive among them, over a DN that has no
    // bearing on any of it.
    const result = run({
      desired: [
        noAccount({
          account: {
            required: false,
            attributes: {},
            container: 'OU=Nowhere,OU=Users,DC=acme,DC=test',
            enabledNow: false,
            correlationKey: null,
          },
        }),
      ],
      desiredContainers: new Map(),
    });
    expect(result.extraUnprocessable.size).toBe(0);
    expect(result.actual.has('person-1')).toBe(true);
  });

  it('matches a container the target returned in a different case', () => {
    // AD folds case and PostgreSQL does not. A profile written in one case
    // against an OU created in another is an ordinary configuration.
    const result = run({
      existingContainers: new Set(['OU=Finance,OU=Users,DC=ACME,DC=test']),
    });
    expect(result.extraUnprocessable.size).toBe(0);
  });

  it('matches a container the profile produced in a different case', () => {
    const result = run({
      desiredContainers: new Map([['person-1', 'ou=FINANCE,ou=users,dc=acme,dc=test']]),
    });
    expect(result.extraUnprocessable.size).toBe(0);
  });

  it('still checks the container when the caller supplied no entry for the person', () => {
    // The map is the run's copy of `state.account.container`. An entry the
    // caller forgot must not turn the check off: an unchecked container is a
    // write into a DN nobody confirmed exists.
    const result = run({
      desired: [
        desired({
          account: {
            required: true,
            attributes: {},
            container: 'OU=Nowhere,OU=Users,DC=acme,DC=test',
            enabledNow: true,
            correlationKey: 'anna.novak',
          },
        }),
      ],
      desiredContainers: new Map(),
    });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'container_missing',
      message:
        'the container OU=Nowhere,OU=Users,DC=acme,DC=test does not exist in the target; Provision does not create it',
    });
  });

  it('passes a person whose own container exists when the caller supplied no entry', () => {
    const result = run({ desiredContainers: new Map() });
    expect(result.extraUnprocessable.size).toBe(0);
  });
});

describe('reconcile — persons it makes unprocessable', () => {
  it('excludes a person whose account could not be read in full', () => {
    const result = run({ objects: [object({ readComplete: false })] });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'target_read_incomplete',
      message:
        'the target returned this person account at anchor-1 but it could not be read in full, so it cannot be diffed against safely',
    });
    // And no state to diff, so nothing downstream can act on half a truth.
    expect(result.actual.has('person-1')).toBe(false);
  });

  it('excludes a person whose account is in conflict', () => {
    // A conflict is an account somebody else may own. Adopting it hands them
    // this person's entitlements, so the person is excluded from the plan
    // entirely until a human resolves it -- which makes this a security
    // control and not a tidiness rule (spec section 13).
    const result = run({ known: [known({ status: 'conflict' })] });
    expect(result.extraUnprocessable.get('person-1')).toEqual({
      kind: 'account_conflict',
      message:
        'this person account is in conflict: the correlation key anna.novak already exists in the target on an account Provision did not create',
    });
    expect(result.actual.has('person-1')).toBe(false);
  });

  it('reports an account belonging to somebody who has not started, and leaves it alone', () => {
    // Spec section 8: an account belonging to somebody whose contract has not
    // started is a question, not an instruction. It is reported and untouched
    // -- the planner returns nothing for them (Task 9) and this is where the
    // report is written. Its fingerprint carries a subject so it cannot
    // collide with, and silently overwrite, the account-status finding above.
    const result = run({ desired: [noAccount({ notYetStarted: true })] });
    const finding = result.findings.find(
      (f) => f.detail.reason === 'this account belongs to somebody whose contract has not started',
    );
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe('unexpected_status');
    expect(finding!.fingerprint).toBe('unexpected_status:account-1:-:not_yet_started');
    // Still reconciled, so the run's inventory and the guard's denominators
    // count this account. Not touching it is the planner's job, not a reason
    // to pretend it is not there.
    expect(result.actual.get('person-1')!.existsAtTarget).toBe(true);
  });

  it('leaves an already-unprocessable person entirely alone', () => {
    const result = run({
      desired: [
        desired({
          account: null,
          entitlements: new Set(),
          unprocessable: { kind: 'no_contracts', message: 'no contracts' },
        }),
      ],
    });
    // Their existing accounts and entitlements are not touched: not granted,
    // not revoked, not disabled. No findings, no actual state to diff.
    expect(result.actual.has('person-1')).toBe(false);
    expect(result.findings).toEqual([]);
  });
});

describe('unprocessableScope — Ruling P23', () => {
  it('scopes an unresolvable rule to the grant decisions it actually poisons', () => {
    expect(unprocessableScope('unresolvable_rule')).toBe('grants');
  });

  it('leaves every other kind global', () => {
    const global: UnprocessableKind[] = [
      'no_contracts',
      'template_unresolvable',
      'container_missing',
      'name_generation_exhausted',
      'target_read_incomplete',
      'account_conflict',
    ];
    for (const kind of global) {
      expect(unprocessableScope(kind)).toBe('all');
    }
  });
});

describe('reconcile — Ruling P23: a broken rule must not freeze an account', () => {
  const brokenRule = {
    kind: 'unresolvable_rule' as const,
    message:
      'the rule "Finance staff" names entitlement ent-gone, which is missing in the target catalog; the rule cannot be resolved and produces no desired state',
  };

  it('still reconciles the account of somebody whose rule cannot be resolved', () => {
    // Otherwise a leaver's account is never disabled and never archived,
    // because a rule somewhere references an entitlement that no longer
    // exists. Access outlives employment for a reason unrelated to
    // employment, which is the shape Ruling P23 refuses.
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
    });
    const actual = result.actual.get('person-1')!;
    expect(actual).toBeDefined();
    // Everything the planner needs to disable and archive it.
    expect(actual.accountId).toBe('account-1');
    expect(actual.anchor).toBe('anchor-1');
    expect(actual.status).toBe('active');
    expect(actual.existsAtTarget).toBe(true);
    expect(actual.enabledAtTarget).toBe(true);
  });

  it('proposes no entitlement change for them, because the desired set is unknown', () => {
    // Their desired set is empty for want of an answer, not because they
    // should hold nothing. `heldWithinRemit` is what `planActions`
    // differences against, so leaving it populated would revoke everything
    // from somebody who is still at their desk.
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
    });
    const actual = result.actual.get('person-1')!;
    expect([...actual.heldWithinRemit]).toEqual([]);
    // And what they hold is still inventoried, so nothing is silently dropped.
    expect([...actual.heldEntitlements]).toEqual(['ent-finance']);
  });

  it('surfaces their drift rather than skipping it', () => {
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
      objects: [object({ entitlementIds: [] })],
    });
    expect(result.findings.map((f) => f.kind)).toEqual(['missing_grant']);
  });

  it('never proposes revoking their unmanaged entitlements, even under authoritative', () => {
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
      objects: [object({ entitlementIds: ['ent-finance', 'ent-teaching'] })],
      enforcementMode: 'authoritative',
    });
    const finding = result.findings.find((f) => f.kind === 'unmanaged_entitlement')!;
    expect(finding.detail.proposedForRevocation).toBe(false);
    expect([...result.actual.get('person-1')!.heldWithinRemit]).toEqual([]);
  });

  it('still excludes them entirely when their account cannot be read in full', () => {
    // The scoping is about which DECISION is poisoned. A half-read object
    // poisons the account decision too, so it is still global.
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
      objects: [object({ readComplete: false })],
    });
    expect(result.actual.has('person-1')).toBe(false);
    expect(result.extraUnprocessable.get('person-1')?.kind).toBe('target_read_incomplete');
  });

  it('still excludes them entirely when their account is in conflict', () => {
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
      known: [known({ status: 'conflict' })],
    });
    expect(result.actual.has('person-1')).toBe(false);
    expect(result.extraUnprocessable.get('person-1')?.kind).toBe('account_conflict');
  });

  it('reports their account as vanished when the target no longer returns it', () => {
    const result = run({
      desired: [
        desired({ account: null, entitlements: new Set(), unprocessable: brokenRule }),
      ],
      objects: [],
    });
    expect(result.findings.map((f) => f.kind)).toEqual(['account_missing_at_target']);
    expect(result.actual.get('person-1')!.status).toBe('missing_at_target');
  });
});
