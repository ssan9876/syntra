import { describe, expect, it } from 'vitest';
import { anyFailing, secondFactorHeadline, type AdminWithoutSecondFactor } from './sign-in-security.js';

const admin = (login: string, owner: boolean): AdminWithoutSecondFactor => ({
  userId: login,
  login,
  displayName: login,
  owner,
});

describe('secondFactorHeadline', () => {
  it('says Owners when every one listed is an Owner', () => {
    expect(secondFactorHeadline([admin('mpuleo', true), admin('rsander', true), admin('agray', true)]))
      .toBe('3 Owners have no second factor');
    expect(secondFactorHeadline([admin('mpuleo', true)])).toBe('1 Owner has no second factor');
  });

  it('says administrators when any one listed is not an Owner', () => {
    expect(secondFactorHeadline([admin('mpuleo', true), admin('helpdesk', false)]))
      .toBe('2 administrators have no second factor');
    expect(secondFactorHeadline([admin('helpdesk', false)])).toBe('1 administrator has no second factor');
  });
});

describe('anyFailing', () => {
  const passing = { adminsWithoutSecondFactor: [], adminMfaRequired: true, lockoutEnabled: true, breakGlassDesignated: true };

  it('is false only when every check passes', () => {
    expect(anyFailing(passing)).toBe(false);
    expect(anyFailing({ ...passing, lockoutEnabled: false })).toBe(true);
    expect(anyFailing({ ...passing, adminMfaRequired: false })).toBe(true);
    expect(anyFailing({ ...passing, breakGlassDesignated: false })).toBe(true);
    expect(anyFailing({ ...passing, adminsWithoutSecondFactor: [admin('a', false)] })).toBe(true);
  });
});
