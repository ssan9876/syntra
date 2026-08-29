import { describe, expect, it } from 'vitest';
import { evaluatePersonGuard, type PersonGuardInput } from './guard.js';
import type { PersonChangeType, PersonProposedChange } from './diff.js';

function change(changeType: PersonChangeType): PersonProposedChange {
  return {
    changeType,
    recordType: changeType.endsWith('_contract') ? 'contract' : 'person',
    targetId: 'x',
    externalId: '1',
    before: null,
    after: null,
    status: 'proposed',
  };
}

function input(over: Partial<PersonGuardInput> = {}): PersonGuardInput {
  return {
    changes: [],
    recordsRead: 100,
    activePersonsFromSource: 100,
    activeContractsFromSource: 100,
    thresholdPercent: 10,
    personsWithActiveContract: 100,
    previousPersonsWithActiveContract: 100,
    ...over,
  };
}

describe('evaluatePersonGuard', () => {
  it('passes a run that proposes nothing alarming', () => {
    expect(evaluatePersonGuard(input({ changes: [change('update_person')] }))).toEqual({
      blocked: false,
    });
  });

  /**
   * First and unconditional. An empty file and an unreachable server are
   * indistinguishable, the safe reading is the second, and there is nothing a
   * human could usefully confirm about it.
   */
  it('blocks a run that read nothing, with no confirmation available', () => {
    const verdict = evaluatePersonGuard(input({ recordsRead: 0 }));
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    if (verdict.blocked) expect(verdict.reason).toMatch(/returned no records/);
  });

  it('passes departures inside the threshold', () => {
    const changes = Array.from({ length: 10 }, () => change('depart_person'));
    expect(evaluatePersonGuard(input({ changes }))).toEqual({ blocked: false });
  });

  it('blocks departures over the threshold, pending confirmation', () => {
    const changes = Array.from({ length: 11 }, () => change('depart_person'));
    const verdict = evaluatePersonGuard(input({ changes }));
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/11 of 100 people/);
  });

  /**
   * Exactly at the limit is within it. An off-by-one here refuses every
   * routine month-end.
   */
  it('treats the threshold itself as inside the limit', () => {
    const changes = Array.from({ length: 10 }, () => change('depart_person'));
    expect(evaluatePersonGuard(input({ changes, thresholdPercent: 10 }))).toEqual({
      blocked: false,
    });
  });

  /**
   * Contracts get their own denominator. A wrong mapping that ended every
   * contract would otherwise sail under a threshold measured against people.
   */
  it('counts ended contracts against contracts, not against people', () => {
    const changes = Array.from({ length: 20 }, () => change('end_contract'));
    const verdict = evaluatePersonGuard(
      input({ changes, activeContractsFromSource: 100, activePersonsFromSource: 1000 }),
    );
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/contracts this source owns/);
  });

  it('has nothing to protect on a first run against an empty register', () => {
    const changes = Array.from({ length: 50 }, () => change('depart_person'));
    expect(evaluatePersonGuard(input({ changes, activePersonsFromSource: 0 }))).toEqual({
      blocked: false,
    });
  });

  /**
   * The two-source case: this run departs nobody from its own source and still
   * collapses the tenant's register, because another source feeds most of it.
   */
  it('blocks when the tenant-wide population collapses even if the share is fine', () => {
    const verdict = evaluatePersonGuard(
      input({
        changes: [change('update_person')],
        personsWithActiveContract: 40,
        previousPersonsWithActiveContract: 100,
      }),
    );
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/broken HR feed/);
  });

  it('blocks when nobody would hold an active contract at all', () => {
    const verdict = evaluatePersonGuard(
      input({ personsWithActiveContract: 0, previousPersonsWithActiveContract: 100 }),
    );
    expect(verdict).toMatchObject({ blocked: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/no person in this tenant/);
  });

  it('does not treat a first run as a collapse', () => {
    expect(
      evaluatePersonGuard(input({ previousPersonsWithActiveContract: null })),
    ).toEqual({ blocked: false });
  });

  /**
   * Both refusals reach the reader. Reporting only the first would tell an
   * administrator to confirm a departure count while hiding that the register
   * is collapsing.
   */
  it('reports both guards when both trip', () => {
    const changes = Array.from({ length: 50 }, () => change('depart_person'));
    const verdict = evaluatePersonGuard(
      input({ changes, personsWithActiveContract: 40, previousPersonsWithActiveContract: 100 }),
    );
    expect(verdict).toMatchObject({ blocked: true });
    if (verdict.blocked) {
      expect(verdict.reason).toMatch(/50 of 100 people/);
      expect(verdict.reason).toMatch(/broken HR feed/);
    }
  });

  /**
   * The drop guard's sentence is used verbatim, per its own comment: a refusal
   * that carries its own sentence is one the caller cannot paraphrase into
   * something less specific.
   */
  it('quotes the population-drop refusal rather than summarising it', () => {
    const verdict = evaluatePersonGuard(
      input({ personsWithActiveContract: 40, previousPersonsWithActiveContract: 100 }),
    );
    if (!verdict.blocked) throw new Error('expected a block');
    expect(verdict.reason).toContain('has fallen from 100 to 40');
    expect(verdict.reason).toContain('every action in this import is downstream of that count');
  });
});
