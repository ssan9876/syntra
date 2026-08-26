import { describe, expect, it } from 'vitest';
import { evaluateTimeWindow, isValidTimeZone } from './time-window.js';

const at = (iso: string) => new Date(iso);

describe('isValidTimeZone', () => {
  it('accepts an IANA zone', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isValidTimeZone('Middle/Earth')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

/**
 * These cases used to go through a boolean `matchesTimeWindow` wrapper that
 * collapsed 'unevaluable' into `false` along with a genuine 'no-match'. Moved
 * onto `evaluateTimeWindow` directly, every case keeps the shape it had --
 * `true` becomes 'match', a miss becomes 'no-match' -- except the one marked
 * below, where the old `false` was standing in for "this could not be
 * decided" rather than "this was checked and missed".
 */
describe('evaluateTimeWindow — window matching', () => {
  const unconstrained = {
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  it('matches when nothing is constrained', () => {
    expect(evaluateTimeWindow(unconstrained, at('2026-08-12T03:00:00Z'))).toBe('match');
  });

  it('matches a weekday list', () => {
    // 2026-08-12 is a Wednesday (3); 2026-08-15 is a Saturday (6).
    const weekdays = { ...unconstrained, daysOfWeek: [1, 2, 3, 4, 5] };
    expect(evaluateTimeWindow(weekdays, at('2026-08-12T09:00:00Z'))).toBe('match');
    expect(evaluateTimeWindow(weekdays, at('2026-08-15T09:00:00Z'))).toBe('no-match');
  });

  it('matches a same-day window inclusively at both ends', () => {
    const office = { ...unconstrained, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(evaluateTimeWindow(office, at('2026-08-12T09:00:00Z'))).toBe('match');
    expect(evaluateTimeWindow(office, at('2026-08-12T17:00:00Z'))).toBe('match');
    expect(evaluateTimeWindow(office, at('2026-08-12T08:59:00Z'))).toBe('no-match');
    expect(evaluateTimeWindow(office, at('2026-08-12T17:01:00Z'))).toBe('no-match');
  });

  it('matches a window that wraps past midnight', () => {
    const night = { ...unconstrained, startMinute: 22 * 60, endMinute: 6 * 60 };
    expect(evaluateTimeWindow(night, at('2026-08-12T23:30:00Z'))).toBe('match');
    expect(evaluateTimeWindow(night, at('2026-08-12T02:00:00Z'))).toBe('match');
    expect(evaluateTimeWindow(night, at('2026-08-12T12:00:00Z'))).toBe('no-match');
  });

  it('reads the clock in the rule timezone, not the server one', () => {
    // 07:30 UTC is 09:30 in Amsterdam in August (CEST, UTC+2).
    const office = {
      ...unconstrained,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: 'Europe/Amsterdam',
    };
    expect(evaluateTimeWindow(office, at('2026-08-12T07:30:00Z'))).toBe('match');
    expect(evaluateTimeWindow(office, at('2026-08-12T06:30:00Z'))).toBe('no-match');
  });

  it('reads the weekday in the rule timezone too', () => {
    // 2026-08-12T23:30Z is already Thursday in Amsterdam.
    const wednesday = { ...unconstrained, daysOfWeek: [3], timezone: 'Europe/Amsterdam' };
    expect(evaluateTimeWindow(wednesday, at('2026-08-12T23:30:00Z'))).toBe('no-match');
    const thursday = { ...unconstrained, daysOfWeek: [4], timezone: 'Europe/Amsterdam' };
    expect(evaluateTimeWindow(thursday, at('2026-08-12T23:30:00Z'))).toBe('match');
  });

  it('handles midnight as minute zero rather than 1440', () => {
    const earlyHours = { ...unconstrained, startMinute: 0, endMinute: 5 * 60 };
    expect(evaluateTimeWindow(earlyHours, at('2026-08-12T00:00:00Z'))).toBe('match');
  });

  /**
   * Write-time validation is what keeps this from happening; if a row is
   * corrupt anyway, this is the same gap a malformed IP address is: not a
   * miss, a question the rule cannot answer.
   */
  it('is unevaluable when the timezone is unusable, rather than a plain miss', () => {
    const broken = { ...unconstrained, daysOfWeek: [3], timezone: 'Middle/Earth' };
    expect(evaluateTimeWindow(broken, at('2026-08-12T09:00:00Z'))).toBe('unevaluable');
  });

  it('ignores a half-specified window', () => {
    const halfOpen = { ...unconstrained, startMinute: 9 * 60, endMinute: null };
    expect(evaluateTimeWindow(halfOpen, at('2026-08-12T03:00:00Z'))).toBe('match');
  });
});

describe('evaluateTimeWindow', () => {
  const unconstrained = {
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  it('separates "outside the window" from "could not be decided"', () => {
    const office = { ...unconstrained, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(evaluateTimeWindow(office, at('2026-08-12T12:00:00Z'))).toBe('match');
    expect(evaluateTimeWindow(office, at('2026-08-12T03:00:00Z'))).toBe('no-match');

    const broken = { ...office, timezone: 'Middle/Earth' };
    expect(evaluateTimeWindow(broken, at('2026-08-12T12:00:00Z'))).toBe('unevaluable');
  });

  it('is unconstrained when neither dimension is set', () => {
    expect(evaluateTimeWindow(unconstrained, at('2026-08-12T03:00:00Z'))).toBe('match');
  });
});
