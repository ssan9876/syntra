import type { TenantClient } from '@syntra/db';
import { describe, expect, it } from 'vitest';
import { resolveContractForMapping } from '../identity/contract-service.js';
import {
  activeBetween,
  activeOn,
  desiredState,
  departureDate,
  personDisplayName,
  resolveMappingContract,
} from './desired.js';
import type { ContractFacts, PersonFacts, ProfileFacts, RuleFacts } from './types.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const person: PersonFacts = {
  id: 'person-1',
  givenName: 'Anna',
  familyName: 'Novak',
  nameConvention: 'familyName',
  businessEmail: 'anna@acme.test',
  personalEmail: null,
  status: 'active',
};

const contract = (over: Partial<ContractFacts> = {}): ContractFacts => ({
  id: 'contract-1',
  sequence: 1,
  isPrimary: true,
  startDate: day('2020-01-01'),
  endDate: null,
  department: 'Finance',
  jobTitle: 'Analyst',
  costCentre: 'CC-100',
  employer: 'Acme Care',
  location: 'Utrecht',
  fte: 1,
  ...over,
});

const profile: ProfileFacts = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,%baseDn%',
  fallbackContainer: 'OU=Users,DC=acme,DC=test',
  attributeTemplates: {
    displayName: '%person.givenName% %person.familyName%',
    userPrincipalName: '%person.givenName.first%.%person.familyName%@acme.test',
    mail: '%person.businessEmail%',
  },
  baseDn: 'DC=acme,DC=test',
};

const financeRule: RuleFacts = {
  id: 'rule-finance',
  name: 'Finance staff',
  condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
  grantsAccount: true,
  enabled: true,
  entitlementIds: ['ent-finance'],
};

const teachingRule: RuleFacts = {
  id: 'rule-teaching',
  name: 'Teaching staff',
  condition: { field: 'contract.department', op: 'equals', value: 'Teaching' },
  grantsAccount: true,
  enabled: true,
  entitlementIds: ['ent-teaching'],
};

/** A rule that matches every contract, for the cases that are not about matching. */
const everyoneRule: RuleFacts = {
  ...financeRule,
  id: 'rule-everyone',
  name: 'Everyone',
  condition: { all: [] },
};

const present = new Map<string, 'present' | 'missing' | 'unreadable'>([
  ['ent-finance', 'present'],
  ['ent-teaching', 'present'],
]);

const evaluate = (
  contracts: ContractFacts[],
  rules: RuleFacts[] = [financeRule],
  over: Partial<Parameters<typeof desiredState>[0]> = {},
) =>
  desiredState({
    person,
    contracts,
    rules,
    // Widened deliberately rather than made optional with a default: `grants`
    // optional is exactly the shape that would let `run-service.ts` forget to
    // pass it and produce a plan that silently revokes every requested
    // entitlement in the tenant.
    grants: [],
    profile,
    entitlementStatus: present,
    existingCorrelationKey: null,
    takenCorrelationKeys: new Set<string>(),
    containerOverride: null,
    renameEnabled: false,
    now: NOW,
    horizon: NOW,
    ...over,
  });

describe('activeOn', () => {
  it('includes a contract on its first and last day', () => {
    const c = contract({ startDate: NOW, endDate: NOW });
    expect(activeOn([c], NOW)).toHaveLength(1);
  });

  it('excludes a contract that has not started and one that has ended', () => {
    expect(activeOn([contract({ startDate: day('2026-07-01') })], NOW)).toEqual([]);
    expect(activeOn([contract({ endDate: day('2026-06-14') })], NOW)).toEqual([]);
  });
});

describe('activeBetween', () => {
  it('includes a contract in force for only part of the window', () => {
    // The case a single instant misses in both directions: this contract is
    // over before the horizon and had not begun at `now`.
    const c = contract({ startDate: day('2026-06-20'), endDate: day('2026-06-22') });
    expect(activeBetween([c], NOW, day('2026-06-29'))).toHaveLength(1);
    expect(activeOn([c], NOW)).toEqual([]);
    expect(activeOn([c], day('2026-06-29'))).toEqual([]);
  });

  it('includes contracts touching either bound and excludes those outside', () => {
    const from = day('2026-06-15');
    const to = day('2026-06-29');
    expect(activeBetween([contract({ startDate: to })], from, to)).toHaveLength(1);
    expect(activeBetween([contract({ endDate: from })], from, to)).toHaveLength(1);
    expect(activeBetween([contract({ startDate: day('2026-06-30') })], from, to)).toEqual(
      [],
    );
    expect(activeBetween([contract({ endDate: day('2026-06-14') })], from, to)).toEqual(
      [],
    );
  });

  it('gives the same window when the bounds arrive the wrong way round', () => {
    // The empty window is the answer that strips somebody's access, so the
    // bounds are ordered internally rather than trusted.
    const rows = [contract({ startDate: day('2026-06-20'), endDate: day('2026-06-22') })];
    expect(activeBetween(rows, day('2026-06-29'), NOW)).toEqual(
      activeBetween(rows, NOW, day('2026-06-29')),
    );
  });
});

describe('departureDate', () => {
  const ON = day('2026-08-01');

  it('takes the later of two contracts that have both ended', () => {
    // A person whose second contract ran three months longer left three
    // months later. Anchoring the ladder to the first end date deprovisions
    // somebody who is still employed.
    const end = departureDate(
      [
        contract({ id: 'a', endDate: day('2026-03-31') }),
        contract({ id: 'b', endDate: day('2026-06-30') }),
      ],
      ON,
    );
    expect(end).toEqual(day('2026-06-30'));
  });

  it('returns null while a started contract is open-ended', () => {
    expect(
      departureDate(
        [
          contract({ id: 'a', endDate: day('2026-03-31') }),
          contract({ id: 'b', endDate: null }),
        ],
        ON,
      ),
    ).toBeNull();
  });

  it('keeps a future end date, because a scheduled departure is still one', () => {
    // Somebody employed today on a fixed-term contract that ends next month
    // has stopped-being-employed scheduled. The ladder anchors to it and waits
    // rather than reading them as a mover and disabling them now.
    expect(
      departureDate([contract({ id: 'a', endDate: day('2026-09-30') })], ON),
    ).toEqual(day('2026-09-30'));
  });

  it('ignores a contract that has not started, however far ahead it ends', () => {
    /**
     * The gap between two FIXED-TERM contracts, which is the case the old
     * "latest end date on any contract" reading got wrong and the old
     * docstring's escape hatch did not cover. Nothing here is open-ended, so
     * the maximum end date is 2027-05-31 — fifteen months ahead — and every
     * ladder timer measured from it falls due in 2027. Not one step fires
     * during the gap: no revocation, no disable, no archive, and no drift
     * finding either, because the person is not left in a state anything
     * reports. They keep an enabled account and every entitlement until June.
     */
    expect(
      departureDate(
        [
          contract({ id: 'ended', endDate: day('2026-01-31') }),
          contract({
            id: 'future',
            sequence: 2,
            startDate: day('2026-09-01'),
            endDate: day('2027-05-31'),
          }),
        ],
        day('2026-03-01'),
      ),
    ).toEqual(day('2026-01-31'));
  });

  it('reads the same gap the same way when the future contract is open-ended', () => {
    // The two shapes of the same gap. Answering them differently is what the
    // old reading did, and there is no sense in which somebody between an
    // ended contract and a permanent one that starts in September stopped
    // being employed on a different day than if it were fixed-term.
    expect(
      departureDate(
        [
          contract({ id: 'ended', endDate: day('2026-01-31') }),
          contract({ id: 'future', sequence: 2, startDate: day('2026-09-01') }),
        ],
        day('2026-03-01'),
      ),
    ).toEqual(day('2026-01-31'));
  });

  it('returns null for no contracts, and for only-future ones', () => {
    // Neither is a departure. `desiredState` answers both elsewhere — an
    // incomplete record is unprocessable and a future joiner is
    // `notYetStarted` — and inventing a date for either would be inventing
    // data.
    expect(departureDate([], ON)).toBeNull();
    expect(
      departureDate([contract({ id: 'a', startDate: day('2026-09-01') })], ON),
    ).toBeNull();
  });
});

describe('departureDate with an administrative override', () => {
  const contract = (
    startDate: string,
    endDate: string | null,
  ): ContractFacts => ({
    id: `c-${startDate}`,
    sequence: 1,
    isPrimary: true,
    startDate: new Date(startDate),
    endDate: endDate === null ? null : new Date(endDate),
    department: null,
    jobTitle: null,
    costCentre: null,
    employer: null,
    location: null,
    fte: null,
  });

  const OVERRIDE = new Date('2026-08-23T00:00:00Z');
  const NOW = new Date('2026-08-23T12:00:00Z');

  /**
   * The case the whole feature turns on. A permanent employee has no end date,
   * so the contract table says "not leaving" forever. If contracts won, the
   * Deactivate button would be a no-op for exactly the people it is most often
   * used on.
   */
  it('wins over an open-ended contract, which otherwise never departs', () => {
    const contracts = [contract('2020-01-01', null)];
    expect(departureDate(contracts, NOW)).toBeNull();
    expect(departureDate(contracts, NOW, OVERRIDE)).toEqual(OVERRIDE);
  });

  it('wins over a later contract end date', () => {
    const contracts = [contract('2020-01-01', '2027-12-31')];
    expect(departureDate(contracts, NOW, OVERRIDE)).toEqual(OVERRIDE);
  });

  it('wins over an earlier contract end date too', () => {
    // Not "the earlier of the two". A human said today; today is the answer.
    const contracts = [contract('2020-01-01', '2021-01-31')];
    expect(departureDate(contracts, NOW, OVERRIDE)).toEqual(OVERRIDE);
  });

  it('falls back to the contracts when the override is cleared', () => {
    const contracts = [contract('2020-01-01', '2026-06-30')];
    expect(departureDate(contracts, NOW, null)).toEqual(new Date('2026-06-30'));
    expect(departureDate(contracts, NOW, undefined)).toEqual(new Date('2026-06-30'));
  });

  it('departs somebody with no contracts at all', () => {
    // A directory-only person: nothing in the HR feed to derive a date from,
    // which is precisely when a human has to supply one.
    expect(departureDate([], NOW)).toBeNull();
    expect(departureDate([], NOW, OVERRIDE)).toEqual(OVERRIDE);
  });
});

describe('personDisplayName', () => {
  it('joins the two name parts and trims them', () => {
    expect(personDisplayName({ ...person, givenName: ' Anna ', familyName: 'Novak' })).toBe(
      'Anna Novak',
    );
  });

  it('does not leave a dangling space when one part is blank', () => {
    expect(personDisplayName({ ...person, familyName: '   ' })).toBe('Anna');
    expect(personDisplayName({ ...person, givenName: '', familyName: 'Novak' })).toBe(
      'Novak',
    );
  });
});

describe('resolveMappingContract', () => {
  it('prefers the primary contract when it is currently active', () => {
    // The same rule Access uses for claim mappings, so the department printed
    // in the directory is the department the SAML assertion carries.
    const primary = contract({ id: 'p', sequence: 5, isPrimary: true });
    const other = contract({ id: 'o', sequence: 1, isPrimary: false });
    expect(resolveMappingContract([other, primary], NOW)?.id).toBe('p');
  });

  it('falls back to the lowest sequence when the primary is not active', () => {
    const primary = contract({
      id: 'p',
      sequence: 5,
      isPrimary: true,
      endDate: day('2026-01-01'),
    });
    const low = contract({ id: 'low', sequence: 2, isPrimary: false });
    const high = contract({ id: 'high', sequence: 9, isPrimary: false });
    expect(resolveMappingContract([high, primary, low], NOW)?.id).toBe('low');
  });

  it('returns null when nothing is active', () => {
    expect(resolveMappingContract([contract({ endDate: day('2020-01-01') })], NOW)).toBeNull();
  });
});

describe('desiredState — the joiner', () => {
  it('requires an enabled account with the rule entitlement and full attribution', () => {
    const result = evaluate([contract()]);
    expect(result.personId).toBe('person-1');
    expect(result.unprocessable).toBeNull();
    expect(result.notYetStarted).toBe(false);
    expect(result.account).toEqual({
      required: true,
      attributes: {
        displayName: ['Anna Novak'],
        userPrincipalName: ['Anna.Novak@acme.test'],
        mail: ['anna@acme.test'],
      },
      container: 'OU=Finance,OU=Users,DC=acme,DC=test',
      enabledNow: true,
      correlationKey: 'anna.novak',
    });
    expect([...result.entitlements]).toEqual(['ent-finance']);
    expect(result.attribution.get('ent-finance')).toEqual([
      { ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'contract-1' },
    ]);
  });

  it('generates a key within the sAMAccountName length cap', () => {
    // 20 characters, because that is what Active Directory accepts. A cap
    // taken from anywhere else -- or not passed at all -- produces a name the
    // generator believes is unique and the directory refuses on the write, one
    // network round trip and one audit event too late.
    const result = evaluate([contract()], [financeRule], {
      person: { ...person, familyName: 'Vandenberghe-Vermeulen' },
    });
    expect(result.account?.correlationKey).toBe('anna.vandenberghe-ve');
    expect(result.account?.correlationKey).toHaveLength(20);
  });

  it('keeps an existing correlation key rather than regenerating it', () => {
    // Somebody marrying does not get a new login. Renaming breaks certificate
    // subjects, profile paths, file ownership and every downstream system that
    // keyed on it.
    const result = evaluate([contract({ department: 'Finance' })], [financeRule], {
      existingCorrelationKey: 'a.novak',
    });
    expect(result.account?.correlationKey).toBe('a.novak');
  });
});

describe('desiredState — concurrent contracts', () => {
  it('unions entitlements across two concurrent contracts', () => {
    // A researcher who is 0.6 FTE in physics and 0.4 FTE teaching holds two
    // contracts, and both are true at once. Union is the only composition
    // that gets that right.
    const result = evaluate(
      [
        contract({ id: 'c-fin', sequence: 1, department: 'Finance', fte: 0.6 }),
        contract({
          id: 'c-teach',
          sequence: 2,
          isPrimary: false,
          department: 'Teaching',
          fte: 0.4,
        }),
      ],
      [financeRule, teachingRule],
    );
    expect([...result.entitlements].sort()).toEqual(['ent-finance', 'ent-teaching']);
    expect(result.attribution.get('ent-teaching')).toEqual([
      { ruleId: 'rule-teaching', ruleName: 'Teaching staff', contractId: 'c-teach' },
    ]);
  });

  it('records both attributions when two contracts satisfy the same rule', () => {
    const result = evaluate(
      [
        contract({ id: 'c1', sequence: 1 }),
        contract({ id: 'c2', sequence: 2, isPrimary: false }),
      ],
      [financeRule],
    );
    expect(result.attribution.get('ent-finance')).toEqual([
      { ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'c1' },
      { ruleId: 'rule-finance', ruleName: 'Finance staff', contractId: 'c2' },
    ]);
  });

  it('keeps the account and the surviving entitlement when one of two contracts ends', () => {
    // The case a model flattened onto the user record gets silently wrong in
    // the dangerous direction: it usually revokes everything.
    const result = evaluate(
      [
        contract({
          id: 'c-fin',
          sequence: 1,
          department: 'Finance',
          endDate: day('2026-05-31'),
        }),
        contract({
          id: 'c-teach',
          sequence: 2,
          isPrimary: false,
          department: 'Teaching',
        }),
      ],
      [financeRule, teachingRule],
    );
    expect(result.account?.required).toBe(true);
    expect([...result.entitlements]).toEqual(['ent-teaching']);
    expect(result.attribution.has('ent-finance')).toBe(false);
  });

  it('takes attributes from the primary contract when several are active', () => {
    const result = evaluate(
      [
        contract({ id: 'c-fin', sequence: 3, isPrimary: true, department: 'Finance' }),
        contract({
          id: 'c-teach',
          sequence: 1,
          isPrimary: false,
          department: 'Teaching',
        }),
      ],
      [financeRule, teachingRule],
    );
    // Not "Teaching", even though that contract has the lower sequence: the
    // primary is active, so it wins -- exactly as resolveContractForMapping
    // decides it for claims.
    expect(result.account?.container).toBe('OU=Finance,OU=Users,DC=acme,DC=test');
  });

  it('takes attributes from the contract in force today, not from one inside the pre-hire window', () => {
    // The pre-hire window widens *whether* an account is required. It must not
    // widen *whose department gets printed on it*: the contract that supplies
    // attributes is the one in force now, and only a person with none at all
    // falls back to the window. Otherwise a primary contract starting next
    // week silently relabels an employee who is at their desk today.
    const result = evaluate(
      [
        contract({ id: 'today', sequence: 5, isPrimary: false, department: 'Finance' }),
        contract({
          id: 'next-week',
          sequence: 1,
          isPrimary: true,
          department: 'Teaching',
          startDate: day('2026-06-25'),
        }),
      ],
      [financeRule, teachingRule],
      { horizon: day('2026-07-01') },
    );
    expect(result.account?.container).toBe('OU=Finance,OU=Users,DC=acme,DC=test');
  });
});

describe('desiredState — the leaver', () => {
  it('requires no account when every contract has ended', () => {
    const result = evaluate([contract({ endDate: day('2026-05-31') })]);
    expect(result.unprocessable).toBeNull();
    expect(result.account).toEqual({
      required: false,
      attributes: {},
      container: '',
      enabledNow: false,
      correlationKey: null,
    });
    expect([...result.entitlements]).toEqual([]);
  });

  it('gives each empty account its own attributes object', () => {
    // A shared `EMPTY_ACCOUNT` spread into every result is a shallow copy:
    // every leaver in the run would share one `attributes` object, and the
    // first consumer to write to it would corrupt the rest.
    const a = evaluate([contract({ endDate: day('2026-05-31') })]);
    const b = evaluate([contract({ endDate: day('2026-05-31') })]);
    expect(a.account?.attributes).not.toBe(b.account?.attributes);
  });
});

describe('desiredState — the mover whose account is no longer required', () => {
  it('requires no account while the person still holds an active contract', () => {
    // A mover, not a leaver: they moved from finance to facilities and the
    // finance system is not theirs. The ladder's timers are anchored to a
    // contract end date and this person does not have one.
    const result = evaluate([contract({ department: 'Facilities' })]);
    expect(result.account?.required).toBe(false);
    expect([...result.entitlements]).toEqual([]);
  });
});

describe('desiredState — the pre-hire horizon', () => {
  it('requires a disabled account for a contract starting inside the horizon', () => {
    const horizon = day('2026-07-01');
    const result = evaluate([contract({ startDate: day('2026-06-25') })], [financeRule], {
      horizon,
    });
    // Created, named, placed and password-set -- and left disabled, holding
    // nothing. A pre-hire never holds access before their start date.
    expect(result.account?.required).toBe(true);
    expect(result.account?.enabledNow).toBe(false);
    expect(result.account?.container).toBe('OU=Finance,OU=Users,DC=acme,DC=test');
    expect([...result.entitlements]).toEqual([]);
  });

  it('keeps the account of somebody whose contract ends inside the horizon', () => {
    // The horizon is `now + preHireDays`, so asking only at the horizon asks
    // "will they be employed in a fortnight". This person answers no and is at
    // their desk today: a one-sided horizon reports required: false, which the
    // planner reads as a mover and treats with an immediate disable and an
    // immediate revoke of everything -- five days before they leave, and while
    // their entitlements, computed at `now`, are still desired.
    const result = evaluate([contract({ endDate: day('2026-06-20') })], [financeRule], {
      horizon: day('2026-06-29'),
    });
    expect(result.account?.required).toBe(true);
    expect(result.account?.enabledNow).toBe(true);
    expect([...result.entitlements]).toEqual(['ent-finance']);
    expect(result.notYetStarted).toBe(false);
  });

  it('marks a contract starting beyond the horizon as not yet started, distinctly from a leaver', () => {
    // The previous version of this test asserted only `required === false`,
    // which is EQUALLY TRUE of a leaver -- and that is precisely the assertion
    // that cannot tell the two apart. It passed while the planner proposed an
    // immediate revoke-everything and disable for somebody who starts in
    // September, with the message "the person is still employed, so there is
    // no departure date to measure a grace period from" (Ruling P10).
    const horizon = day('2026-07-01');
    const result = evaluate([contract({ startDate: day('2026-09-01') })], [financeRule], {
      horizon,
    });
    expect(result.account?.required).toBe(false);
    expect([...result.entitlements]).toEqual([]);
    expect(result.notYetStarted).toBe(true);
  });

  it('does not mark a leaver as not yet started', () => {
    // The discriminator. A leaver reaches the same `required: false` by a
    // different route and must keep reaching the ladder.
    const result = evaluate([contract({ endDate: day('2026-05-31') })]);
    expect(result.account?.required).toBe(false);
    expect(result.notYetStarted).toBe(false);
  });

  it('does not mark a contract starting exactly on the horizon as not yet started', () => {
    // The boundary is inclusive on both sides: this person starts within the
    // window, so they are a pre-hire and not a future joiner. Here no rule
    // matches them, so `required` is false for a third reason again -- which
    // is what makes `notYetStarted` the only field that can tell the three
    // apart.
    const horizon = day('2026-07-01');
    const result = evaluate(
      [contract({ department: 'Facilities', startDate: horizon })],
      [financeRule],
      { horizon },
    );
    expect(result.account?.required).toBe(false);
    expect(result.notYetStarted).toBe(false);
  });

  it('does not mark somebody with one ended and one future contract as not yet started', () => {
    // They have a departure date — the end of the contract that ENDED, which
    // `departureDate` answers whether or not the future one is open-ended. The
    // fixture used to leave the future contract open-ended while the comment
    // claimed a departure date, and under the old maximum-end-date reading there
    // was none: the case passed for a reason other than the one it stated. Now
    // it is asserted rather than described, and in both shapes.
    const ended = contract({ id: 'past', endDate: day('2026-05-31') });
    const openEnded = contract({ id: 'future', sequence: 2, startDate: day('2026-09-01') });
    const fixedTerm = contract({
      id: 'future',
      sequence: 2,
      startDate: day('2026-09-01'),
      endDate: day('2027-08-31'),
    });
    for (const future of [openEnded, fixedTerm]) {
      const result = evaluate([ended, future]);
      expect(result.notYetStarted).toBe(false);
      expect(departureDate([ended, future], NOW)).toEqual(day('2026-05-31'));
    }
  });

  it('enables the account and grants entitlements on the start date', () => {
    const start = day('2026-06-15');
    const result = evaluate([contract({ startDate: start })], [financeRule], {
      now: start,
      horizon: day('2026-06-22'),
    });
    expect(result.account?.enabledNow).toBe(true);
    expect([...result.entitlements]).toEqual(['ent-finance']);
  });
});

describe('desiredState — persons Provision cannot process', () => {
  it('makes a person with no contracts at all unprocessable, not a leaver', () => {
    // The entire lesson of the previous slice, restated. An incomplete record
    // is not a departure, and computing it as one revokes real access.
    const result = evaluate([]);
    expect(result.unprocessable).toEqual({
      kind: 'no_contracts',
      message:
        'Anna Novak holds no contracts at all, so their access cannot be computed; this is an incomplete record, not a departure',
    });
    expect(result.account).toBeNull();
    expect([...result.entitlements]).toEqual([]);
  });

  it('names a person by id when both name parts are blank', () => {
    // `Array.join` returns `''` rather than null, so a `?? person.id` written
    // after it is dead code and the exception reads " holds no contracts at
    // all" with nothing in it anybody can look up.
    const result = desiredState({
      person: { ...person, givenName: '  ', familyName: '' },
      contracts: [],
      rules: [financeRule],
      grants: [],
      profile,
      entitlementStatus: present,
      existingCorrelationKey: null,
      takenCorrelationKeys: new Set(),
      containerOverride: null,
      renameEnabled: false,
      now: NOW,
      horizon: NOW,
    });
    expect(result.unprocessable?.message).toBe(
      'person-1 holds no contracts at all, so their access cannot be computed; this is an incomplete record, not a departure',
    );
  });

  it('makes a person the rule reaches unprocessable when it names a missing entitlement', () => {
    // The WHOLE rule is unresolvable, not just that entitlement. Evaluating it
    // without the missing one produces a desired set that lacks it, and the
    // diff then proposes revoking it from everybody who holds it.
    const status = new Map<string, 'present' | 'missing' | 'unreadable'>([
      ['ent-finance', 'missing'],
    ]);
    const result = evaluate([contract()], [financeRule], { entitlementStatus: status });
    expect(result.unprocessable).toEqual({
      kind: 'unresolvable_rule',
      message:
        'the rule "Finance staff" names entitlement ent-finance, which is missing in the target catalog; the rule cannot be resolved for this person and produces no desired state',
    });
    expect(result.account).toBeNull();
  });

  it('leaves a person the rule does NOT reach processable', () => {
    /**
     * The blast radius, which used to be the whole tenant. The check returned
     * before any condition was evaluated, so one entitlement deleted from the
     * target froze `grants` for every person in it: a rule affecting three
     * people in Finance stopped every joiner, every mover and every grant
     * everywhere. `unresolvable_rule` is scoped to `grants` precisely because
     * it is a narrow failure; applying it to everybody is the same over-reach
     * one level up.
     *
     * This person is in Facilities. The Finance rule cannot reach them, and
     * whether its entitlement exists says nothing about their access.
     */
    const status = new Map<string, 'present' | 'missing' | 'unreadable'>([
      ['ent-finance', 'missing'],
    ]);
    const result = evaluate([contract({ department: 'Facilities' })], [financeRule], {
      entitlementStatus: status,
    });
    expect(result.unprocessable).toBeNull();
    expect(result.account).not.toBeNull();
    expect([...result.entitlements]).toEqual([]);
  });

  it('makes every person unprocessable when a rule names an unreadable entitlement', () => {
    const status = new Map<string, 'present' | 'missing' | 'unreadable'>([
      ['ent-finance', 'unreadable'],
    ]);
    const result = evaluate([contract()], [financeRule], { entitlementStatus: status });
    expect(result.unprocessable?.kind).toBe('unresolvable_rule');
    expect(result.unprocessable?.message).toContain('unreadable');
  });

  it('refuses a blank attribute template rather than writing a zero-length value', () => {
    /**
     * A template with no reference in it renders `{ ok: true, value: '' }` —
     * nothing was missing, because nothing was asked for — so the old code
     * wrote `['']` into the desired attributes. Active Directory refuses a
     * zero-length value, so the `update_account` fails; a failed action leaves
     * `lastAppliedAttributes` untouched, so the next run computes the same
     * difference and proposes the same failing write, for that person and
     * every other person the profile applies to, on every run, for ever.
     */
    const result = evaluate([contract()], [financeRule], {
      profile: { ...profile, attributeTemplates: { title: '', displayName: '%person.givenName%' } },
    });
    expect(result.unprocessable?.kind).toBe('template_unresolvable');
    expect(result.unprocessable?.message).toContain('empty value');
  });

  it('refuses a whitespace-only attribute template for the same reason', () => {
    const result = evaluate([contract()], [financeRule], {
      profile: { ...profile, attributeTemplates: { title: '   ' } },
    });
    expect(result.unprocessable?.kind).toBe('template_unresolvable');
  });

  it('treats an entitlement absent from the catalog entirely as missing', () => {
    // An entitlement the target read never mentioned is not "fine by default".
    // Reading an absent key as present is how a rule silently stops granting
    // the thing it exists to grant.
    const result = evaluate([contract()], [
      { ...financeRule, entitlementIds: ['ent-never-heard-of'] },
    ]);
    expect(result.unprocessable?.kind).toBe('unresolvable_rule');
    expect(result.unprocessable?.message).toContain('missing');
  });

  it('does not let a disabled rule with a missing entitlement freeze everybody', () => {
    // A rule that is switched off produces no desired state either way, so it
    // cannot make anybody unprocessable. Otherwise an administrator disabling
    // a broken rule -- the obvious remedy -- would change nothing.
    const result = evaluate(
      [contract()],
      [
        { ...financeRule, enabled: false, entitlementIds: ['ent-nowhere'] },
        teachingRule,
      ],
    );
    expect(result.unprocessable).toBeNull();
    expect(result.account?.required).toBe(false);
  });

  it('makes a person unprocessable when an attribute template cannot resolve', () => {
    const result = desiredState({
      person: { ...person, businessEmail: null },
      contracts: [contract()],
      rules: [financeRule],
      grants: [],
      profile,
      entitlementStatus: present,
      existingCorrelationKey: null,
      takenCorrelationKeys: new Set(),
      containerOverride: null,
      renameEnabled: false,
      now: NOW,
      horizon: NOW,
    });
    expect(result.unprocessable).toEqual({
      kind: 'template_unresolvable',
      message:
        'the account profile template for "mail" references person.businessEmail, which resolves to nothing for this person',
    });
  });

  it('falls back rather than failing when the container template resolves to nothing', () => {
    // A required fallback exists precisely so an empty department does not
    // make somebody unprocessable. A container that does not EXIST in the
    // target is a different failure, detected against the target's inventory
    // in reconcile.
    const result = evaluate([contract({ department: null })], [everyoneRule]);
    expect(result.unprocessable).toBeNull();
    expect(result.account?.container).toBe('OU=Users,DC=acme,DC=test');
  });

  it('lets a manual placement beat the template', () => {
    // The whole point of `AccountPlacement`. Without this, the planner
    // computes the template's answer, finds the account somewhere else, and
    // proposes a `modifyDN` putting the person straight back — within five
    // minutes, silently, with the console still showing the move as done.
    const result = evaluate([contract({ department: 'Finance' })], [everyoneRule], {
      containerOverride: 'OU=Engineering,OU=Users,DC=acme,DC=test',
    });
    expect(result.account?.container).toBe('OU=Engineering,OU=Users,DC=acme,DC=test');
  });

  it('lets a manual placement beat the fallback too', () => {
    // An override is a decision somebody recorded a reason for. Falling back
    // from it would discard that decision at the moment it mattered.
    const result = evaluate([contract({ department: null })], [everyoneRule], {
      containerOverride: 'OU=Engineering,OU=Users,DC=acme,DC=test',
    });
    expect(result.unprocessable).toBeNull();
    expect(result.account?.container).toBe('OU=Engineering,OU=Users,DC=acme,DC=test');
  });

  it('is not a placement when the override is blank', () => {
    // A blank DN is a write into somebody else's directory at a location
    // nobody chose. It has to read as "no override", not as "the root".
    const result = evaluate([contract({ department: null })], [everyoneRule], {
      containerOverride: '   ',
    });
    expect(result.account?.container).toBe('OU=Users,DC=acme,DC=test');
  });

  it('refuses to place an account when the container resolves to nothing and there is no fallback', () => {
    // Spec section 13: a template that resolves to nothing AND has no
    // fallback. An empty container is a write into somebody else's directory
    // at a location nobody chose, so it fails closed.
    const result = evaluate([contract({ department: null })], [everyoneRule], {
      profile: { ...profile, fallbackContainer: '' },
    });
    expect(result.unprocessable).toEqual({
      kind: 'template_unresolvable',
      message:
        'the container template references contract.department, which resolves to nothing for this person, and the profile has no fallback container',
    });
    expect(result.account).toBeNull();
  });

  it('makes a person unprocessable when name generation is exhausted', () => {
    const taken = new Set(['anna.novak']);
    for (let n = 2; n <= 20; n += 1) taken.add(`anna.novak${n}`);
    const result = evaluate([contract()], [financeRule], {
      takenCorrelationKeys: taken,
      containerOverride: null,
    });
    expect(result.unprocessable).toEqual({
      kind: 'name_generation_exhausted',
      message:
        'no unique account name could be generated for Anna Novak within 20 attempts',
    });
  });

  it('does not run name generation at all for somebody who needs no account', () => {
    // A leaver whose name would collide must not become unprocessable for it:
    // that would freeze the deprovisioning of the person the ladder exists for.
    const taken = new Set(['anna.novak']);
    for (let n = 2; n <= 20; n += 1) taken.add(`anna.novak${n}`);
    const result = evaluate([contract({ endDate: day('2026-01-01') })], [financeRule], {
      takenCorrelationKeys: taken,
      containerOverride: null,
    });
    expect(result.unprocessable).toBeNull();
    expect(result.account?.required).toBe(false);
  });
});

describe('desiredState — the container is a distinguished name', () => {
  const injected = 'Finance,OU=Domain Controllers';

  it('escapes HR-supplied values into the container', () => {
    // Ruling P22. Unescaped, this is not a mangled DN -- it is a VALID one
    // naming a container the administrator never wrote, so placement in the
    // directory is chosen by whoever can edit an HR record.
    const result = evaluate([contract({ department: injected })], [everyoneRule]);
    expect(result.account?.container).toBe(
      'OU=Finance\\,OU\\=Domain Controllers,OU=Users,DC=acme,DC=test',
    );
  });

  it('does not escape the same value into an ordinary attribute', () => {
    // Escaping is a property of the DN, not of the value. A display name is
    // not a DN and must not acquire backslashes.
    const result = evaluate([contract({ department: injected })], [everyoneRule], {
      profile: {
        ...profile,
        attributeTemplates: { department: '%contract.department%' },
      },
    });
    expect(result.account?.attributes.department).toEqual([injected]);
  });
});

describe('desiredState — renaming', () => {
  it('keeps the existing key when renaming is off, even when the template would produce another', () => {
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'a.novak',
      renameEnabled: false,
    });
    expect(result.account?.correlationKey).toBe('a.novak');
  });

  it('regenerates the key when renaming is on, so the planner has something to propose', () => {
    // Without this the setting has nothing behind it: desiredState returns the
    // existing key unconditionally, `state.account.correlationKey !==
    // current.correlationKey` can never hold, and rename_account is dead code
    // with a toggle in front of it.
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'a.novak',
      renameEnabled: true,
    });
    expect(result.account?.correlationKey).toBe('anna.novak');
  });

  it('does not propose a rename away from the person’s own key in the target’s casing', () => {
    // `takenCorrelationKeys` is Syntra's rows unioned with the TARGET's
    // inventory, and the target's copy of this person's own account carries
    // the directory's casing. Excluding it case-sensitively leaves it in the
    // set, so generation folds it, finds a collision with the person's own
    // login, and proposes renaming them to `anna.novak2`.
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'anna.novak',
      renameEnabled: true,
      takenCorrelationKeys: new Set(['Anna.Novak']),
      containerOverride: null,
    });
    expect(result.account?.correlationKey).toBe('anna.novak');
  });

  it('keeps the existing key when renaming is on and generation cannot produce one', () => {
    // A rename is never worth making somebody unprocessable for. Their login
    // is not the thing that needs fixing.
    const taken = new Set(['anna.novak']);
    for (let n = 2; n <= 20; n += 1) taken.add(`anna.novak${n}`);
    const result = evaluate([contract()], [financeRule], {
      existingCorrelationKey: 'a.novak',
      renameEnabled: true,
      takenCorrelationKeys: taken,
      containerOverride: null,
    });
    expect(result.unprocessable).toBeNull();
    expect(result.account?.correlationKey).toBe('a.novak');
  });
});

describe('desiredState — rules that are off or grant no account', () => {
  it('ignores a disabled rule entirely', () => {
    const result = evaluate([contract()], [{ ...financeRule, enabled: false }]);
    expect(result.account?.required).toBe(false);
    expect([...result.entitlements]).toEqual([]);
  });

  it('grants the entitlement without requiring an account when grantsAccount is false', () => {
    const result = evaluate(
      [contract()],
      [
        { ...financeRule, grantsAccount: false },
        { ...teachingRule, grantsAccount: true },
      ],
    );
    // The entitlement is still desired -- it is granted on whatever account
    // the person has for other reasons -- but this rule does not by itself
    // justify creating one.
    expect([...result.entitlements]).toEqual(['ent-finance']);
    expect(result.account?.required).toBe(false);
  });
});

describe('resolveMappingContract agrees with resolveContractForMapping', () => {
  /**
   * A stub transaction returning the same contract rows, so the two
   * implementations are compared on identical input. Not a mock of the answer
   * -- the real function runs, over a fake `findMany`.
   */
  type ContractWhere = {
    startDate: { lte: Date };
    OR: ({ endDate: null } | { endDate: { gte: Date } })[];
  };

  /**
   * The stub applies the WHOLE `where`, including `OR`.
   *
   * It used to destructure `OR` and never read it, filtering on its own
   * restatement of "ends on or after `on`" instead — so the active-contract
   * half of `activeContracts` was compared against the test's own copy of it
   * rather than against the query, and changing that clause in
   * `contract-service.ts` would not have failed a single case here. Only the
   * precedence half was really under test. Now the clause is interpreted the
   * way PostgreSQL would: every disjunct is tried and any match passes.
   */
  const matchesOr = (contract: ContractFacts, or: ContractWhere['OR']): boolean =>
    or.some((clause) =>
      clause.endDate === null
        ? contract.endDate === null
        : contract.endDate !== null &&
          contract.endDate.getTime() >= clause.endDate.gte.getTime(),
    );

  const txOver = (rows: ContractFacts[]) =>
    ({
      contract: {
        findMany: async ({ where }: { where: ContractWhere }) =>
          rows
            .filter(
              (c) =>
                c.startDate.getTime() <= where.startDate.lte.getTime() &&
                matchesOr(c, where.OR),
            )
            .sort((a, b) => a.sequence - b.sequence),
      },
    }) as unknown as TenantClient;

  const cases: { name: string; rows: ContractFacts[] }[] = [
    {
      name: 'an active primary beside a lower-sequence non-primary',
      rows: [
        contract({ id: 'p', sequence: 5, isPrimary: true }),
        contract({ id: 'o', sequence: 1, isPrimary: false }),
      ],
    },
    {
      name: 'an ended primary and two active non-primaries',
      rows: [
        contract({ id: 'p', sequence: 5, isPrimary: true, endDate: day('2026-01-01') }),
        contract({ id: 'low', sequence: 2, isPrimary: false }),
        contract({ id: 'high', sequence: 9, isPrimary: false }),
      ],
    },
    { name: 'a single active contract', rows: [contract({ id: 'only' })] },
  ];

  for (const { name, rows } of cases) {
    it(`agrees on ${name}`, async () => {
      const viaCore = await resolveContractForMapping(
        txOver(rows),
        'person-1',
        'primary',
        NOW,
      );
      const fallback =
        viaCore ??
        (await resolveContractForMapping(txOver(rows), 'person-1', 'lowestSequence', NOW));
      expect(resolveMappingContract(rows, NOW)?.id).toBe(fallback?.id ?? null);
    });
  }
});
