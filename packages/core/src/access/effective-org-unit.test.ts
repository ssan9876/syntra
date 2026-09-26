import { describe, expect, it } from 'vitest';
import { effectiveOrgUnit } from './effective-org-unit.js';

describe('effectiveOrgUnit', () => {
  const person = (orgUnitId: string | null, status = 'active') => ({ orgUnitId, status });

  it("uses the login's own unit when it has one, whatever the person's", () => {
    expect(effectiveOrgUnit({ orgUnitId: 'ou-own' }, person('ou-person'))).toEqual({
      orgUnitId: 'ou-own',
      source: 'account',
    });
  });

  it("falls back to the linked person's unit, and says so", () => {
    expect(effectiveOrgUnit({ orgUnitId: null }, person('ou-person'))).toEqual({
      orgUnitId: 'ou-person',
      source: 'person',
    });
  });

  it('inherits nothing with no person, or a person in no unit', () => {
    expect(effectiveOrgUnit({ orgUnitId: null }, null)).toBeNull();
    expect(effectiveOrgUnit({ orgUnitId: null }, person(null))).toBeNull();
  });

  it('inherits nothing from an inactive person, unless the caller is a review', () => {
    expect(effectiveOrgUnit({ orgUnitId: null }, person('ou-person', 'inactive'))).toBeNull();
    // An access review is looking for what a leaver still holds.
    expect(
      effectiveOrgUnit({ orgUnitId: null }, person('ou-person', 'inactive'), {
        includeInactivePerson: true,
      }),
    ).toEqual({ orgUnitId: 'ou-person', source: 'person' });
  });

  it("keeps the login's own unit even when its person is inactive", () => {
    // The login's unit never went through the person, so the person's status
    // does not gate it.
    expect(effectiveOrgUnit({ orgUnitId: 'ou-own' }, person('ou-person', 'inactive'))).toEqual({
      orgUnitId: 'ou-own',
      source: 'account',
    });
  });
});
