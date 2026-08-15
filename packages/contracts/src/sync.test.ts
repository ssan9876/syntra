import { describe, expect, it } from 'vitest';
import { createSourceRequest, updateSourceRequest } from './sync.js';

const source = {
  name: 'Head office',
  config: { url: 'ldap://dc.acme.test:389' },
  bindPassword: 'adminpassword',
};

describe('the schedule a source may be given', () => {
  it('accepts an ordinary cron expression', () => {
    expect(
      createSourceRequest.safeParse({ ...source, schedule: '0 3 * * *' }).success,
    ).toBe(true);
    expect(
      updateSourceRequest.safeParse({ schedule: '*/15 8-18 * * 1-5' }).success,
    ).toBe(true);
  });

  it('refuses an expression the scheduler could not parse', () => {
    // pg-boss parses the expression before its upsert, so a malformed one
    // throws with the previous schedule row still in place: the request
    // succeeds, the console shows the new string, and the old expression keeps
    // firing. Refused here, before the transaction opens.
    for (const schedule of [
      'not a cron',
      '99 * * * *',
      'nonsense here now',
      '',
    ]) {
      expect(
        createSourceRequest.safeParse({ ...source, schedule }).success,
      ).toBe(false);
      expect(updateSourceRequest.safeParse({ schedule }).success).toBe(false);
    }
  });

  it('accepts everything pg-boss accepts, including what looks wrong', () => {
    // A four-field expression and a six-field one both parse -- the library
    // fills the missing field and reads the extra one as seconds. Neither is
    // what most people mean to type, and both are things the scheduler will
    // genuinely run, so refusing them here would reject a working schedule.
    // Matching pg-boss exactly is the contract; second-guessing it is not.
    for (const schedule of ['0 3 * *', '0 3 * * * *', '@daily']) {
      expect(
        createSourceRequest.safeParse({ ...source, schedule }).success,
      ).toBe(true);
    }
  });

  it('refuses an empty string, which the parser would read as every minute', () => {
    // Caught by the length check rather than the cron check, and worth its own
    // case: cron-parser reads '' as "* * * * *". A source meant to be
    // manual-only is `null`, not empty -- the difference between no schedule
    // and a run every sixty seconds.
    expect(updateSourceRequest.safeParse({ schedule: '' }).success).toBe(false);
  });

  it('says what was wrong with it', () => {
    const result = createSourceRequest.safeParse({
      ...source,
      schedule: 'not a cron',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/cron expression/i);
  });

  it('still allows a source with no schedule at all', () => {
    expect(createSourceRequest.safeParse(source).success).toBe(true);
    expect(updateSourceRequest.safeParse({ autoApply: true }).success).toBe(true);
  });

  it('distinguishes clearing the schedule from leaving it alone', () => {
    // `null` makes the source manual-only; absent means "do not touch it".
    expect(updateSourceRequest.safeParse({ schedule: null }).success).toBe(true);
  });

  it('refuses an update that asks for nothing', () => {
    expect(updateSourceRequest.safeParse({}).success).toBe(false);
  });
});
