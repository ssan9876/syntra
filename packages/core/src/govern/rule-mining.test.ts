import { describe, expect, it } from 'vitest';
import { mineRuleCandidates, type MiningSubject } from './rule-mining.js';

const names = new Map([
  ['targetEntitlement:fin-read', 'Finance — read only'],
  ['targetEntitlement:all-staff', 'All staff'],
]);

const person = (
  id: string,
  department: string | null,
  holdings: string[],
  over: Partial<MiningSubject> = {},
): MiningSubject => ({
  personId: id,
  department,
  jobTitle: null,
  location: null,
  employer: null,
  holdings,
  ...over,
});

/** `n` people in one department, all holding the same thing. */
const cohort = (department: string, n: number, holdings: string[], from = 0) =>
  Array.from({ length: n }, (_, i) => person(`p${from + i}`, department, holdings));

describe('mineRuleCandidates', () => {
  it('finds the rule a whole department already follows', () => {
    const found = mineRuleCandidates(
      cohort('Finance', 6, ['targetEntitlement:fin-read']),
      names,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      field: 'department',
      value: 'Finance',
      resourceName: 'Finance — read only',
      holders: 6,
      population: 6,
      confidence: 1,
    });
  });

  it('tolerates the exceptions that real populations have', () => {
    // A rule surfacing only at 100% surfaces almost nothing: there is always a
    // leaver mid-notice or an account created last week. The exceptions are
    // the point — they are what somebody looks at before agreeing.
    const subjects = [
      ...cohort('Finance', 9, ['targetEntitlement:fin-read']),
      person('p9', 'Finance', []),
    ];
    const found = mineRuleCandidates(subjects, names);
    expect(found[0]).toMatchObject({ holders: 9, population: 10, confidence: 0.9 });
  });

  it('says nothing below the confidence threshold', () => {
    const subjects = [
      ...cohort('Finance', 5, ['targetEntitlement:fin-read']),
      ...cohort('Finance', 5, [], 5),
    ];
    expect(mineRuleCandidates(subjects, names)).toEqual([]);
  });

  it('ignores a population too small to mean anything', () => {
    // Three out of three is 100% confidence and no evidence at all.
    expect(mineRuleCandidates(cohort('Finance', 3, ['targetEntitlement:fin-read']), names)).toEqual(
      [],
    );
  });

  it('does not treat a missing department as a cohort', () => {
    // "Everybody whose department is unset holds X" is a statement about a gap
    // in the HR feed, not a rule anybody should be offered.
    const subjects = Array.from({ length: 8 }, (_, i) =>
      person(`p${i}`, null, ['targetEntitlement:fin-read']),
    );
    expect(mineRuleCandidates(subjects, names)).toEqual([]);
  });

  it('treats a blank department the same as a missing one', () => {
    const subjects = Array.from({ length: 8 }, (_, i) =>
      person(`p${i}`, '   ', ['targetEntitlement:fin-read']),
    );
    expect(mineRuleCandidates(subjects, names)).toEqual([]);
  });

  it('reports holders outside the population, which confidence hides', () => {
    // A rule at 100% over six people, where forty others hold the same thing,
    // is not a description of that resource — it is a description of six
    // people. The figure has to be on the row.
    const subjects = [
      ...cohort('Finance', 6, ['targetEntitlement:all-staff']),
      ...cohort('Engineering', 40, ['targetEntitlement:all-staff'], 6),
    ];
    const finance = mineRuleCandidates(subjects, names).find((c) => c.value === 'Finance')!;
    expect(finance).toMatchObject({ confidence: 1, outsideHolders: 40 });
  });

  it('mines every field, not only department', () => {
    const subjects = Array.from({ length: 6 }, (_, i) =>
      person(`p${i}`, null, ['targetEntitlement:fin-read'], { jobTitle: 'Accountant' }),
    );
    const found = mineRuleCandidates(subjects, names);
    expect(found[0]).toMatchObject({ field: 'jobTitle', value: 'Accountant' });
  });

  it('puts the strongest first, and the largest before the smallest', () => {
    // A candidate covering four hundred people at 0.95 deserves more attention
    // than one covering six at 1.0 — but sorting on size alone would bury a
    // perfect rule under a mediocre big one.
    const subjects = [
      ...cohort('Finance', 6, ['targetEntitlement:fin-read']),
      ...cohort('Engineering', 20, ['targetEntitlement:all-staff'], 6),
      // One of the twenty does not hold it, so Engineering sits at 0.95.
      person('p26', 'Engineering', []),
    ];
    const found = mineRuleCandidates(subjects, names);
    expect(found[0]!.confidence).toBe(1);
    expect(found[0]!.value).toBe('Finance');
  });

  it('counts a person once however many times a holding appears', () => {
    // Holdings arrive per account, and a person with two accounts in one
    // target holds the entitlement once as far as a rule is concerned.
    const subjects = cohort('Finance', 6, [
      'targetEntitlement:fin-read',
      'targetEntitlement:fin-read',
    ]);
    expect(mineRuleCandidates(subjects, names)[0]).toMatchObject({
      holders: 6,
      confidence: 1,
    });
  });

  it('honours an explicit threshold', () => {
    const subjects = [
      ...cohort('Finance', 5, ['targetEntitlement:fin-read']),
      ...cohort('Finance', 5, [], 5),
    ];
    expect(mineRuleCandidates(subjects, names, { minConfidence: 0.5 })).toHaveLength(1);
  });

  it('names a resource it has no name for by its key, not by nothing', () => {
    const subjects = cohort('Finance', 6, ['targetEntitlement:mystery']);
    expect(mineRuleCandidates(subjects, names)[0]!.resourceName).toBe(
      'targetEntitlement:mystery',
    );
  });
});
