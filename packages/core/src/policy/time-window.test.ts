import { describe, expect, it } from 'vitest';
import { evaluateTimeWindow, isValidTimeZone, matchesTimeWindow } from './time-window.js';

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

describe('matchesTimeWindow', () => {
  const unconstrained = {
    daysOfWeek: [],
    startMinute: null,
    endMinute: null,
    timezone: null,
  };

  it('matches when nothing is constrained', () => {
    expect(matchesTimeWindow(unconstrained, at('2026-08-12T03:00:00Z'))).toBe(true);
  });

  it('matches a weekday list', () => {
    // 2026-08-12 is a Wednesday (3); 2026-08-15 is a Saturday (6).
    const weekdays = { ...unconstrained, daysOfWeek: [1, 2, 3, 4, 5] };
    expect(matchesTimeWindow(weekdays, at('2026-08-12T09:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(weekdays, at('2026-08-15T09:00:00Z'))).toBe(false);
  });

  it('matches a same-day window inclusively at both ends', () => {
    const office = { ...unconstrained, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(matchesTimeWindow(office, at('2026-08-12T09:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(office, at('2026-08-12T17:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(office, at('2026-08-12T08:59:00Z'))).toBe(false);
    expect(matchesTimeWindow(office, at('2026-08-12T17:01:00Z'))).toBe(false);
  });

  it('matches a window that wraps past midnight', () => {
    const night = { ...unconstrained, startMinute: 22 * 60, endMinute: 6 * 60 };
    expect(matchesTimeWindow(night, at('2026-08-12T23:30:00Z'))).toBe(true);
    expect(matchesTimeWindow(night, at('2026-08-12T02:00:00Z'))).toBe(true);
    expect(matchesTimeWindow(night, at('2026-08-12T12:00:00Z'))).toBe(false);
  });

  it('reads the clock in the rule timezone, not the server one', () => {
    // 07:30 UTC is 09:30 in Amsterdam in August (CEST, UTC+2).
    const office = {
      ...unconstrained,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: 'Europe/Amsterdam',
    };
    expect(matchesTimeWindow(office, at('2026-08-12T07:30:00Z'))).toBe(true);
    expect(matchesTimeWindow(office, at('2026-08-12T06:30:00Z'))).toBe(false);
  });

  it('reads the weekday in the rule timezone too', () => {
    // 2026-08-12T23:30Z is already Thursday in Amsterdam.
    const wednesday = { ...unconstrained, daysOfWeek: [3], timezone: 'Europe/Amsterdam' };
    expect(matchesTimeWindow(wednesday, at('2026-08-12T23:30:00Z'))).toBe(false);
    const thursday = { ...unconstrained, daysOfWeek: [4], timezone: 'Europe/Amsterdam' };
    expect(matchesTimeWindow(thursday, at('2026-08-12T23:30:00Z'))).toBe(true);
  });

  it('handles midnight as minute zero rather than 1440', () => {
    const earlyHours = { ...unconstrained, startMinute: 0, endMinute: 5 * 60 };
    expect(matchesTimeWindow(earlyHours, at('2026-08-12T00:00:00Z'))).toBe(true);
  });

  it('does not match when the timezone is unusable', () => {
    // Write-time validation is what keeps this from happening; if a row is
    // corrupt anyway, the rule fails to match rather than throwing into the
    // middle of a login.
    const broken = { ...unconstrained, daysOfWeek: [3], timezone: 'Middle/Earth' };
    expect(matchesTimeWindow(broken, at('2026-08-12T09:00:00Z'))).toBe(false);
  });

  it('ignores a half-specified window', () => {
    const halfOpen = { ...unconstrained, startMinute: 9 * 60, endMinute: null };
    expect(matchesTimeWindow(halfOpen, at('2026-08-12T03:00:00Z'))).toBe(true);
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
