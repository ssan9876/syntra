import { describe, expect, it } from 'vitest';
import {
  applyShortening,
  grantInForce,
  grantWindow,
  resolveRequestedDuration,
  type DurationPolicy,
} from './duration.js';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const NOW = day('2026-06-15');

const policy = (over: Partial<DurationPolicy> = {}): DurationPolicy => ({
  durationMode: 'requesterChoice',
  defaultDurationDays: 30,
  maxDurationDays: 90,
  ...over,
});

describe('resolveRequestedDuration', () => {
  it('gives a permanent product no end date, whatever the requester asked for', () => {
    expect(
      resolveRequestedDuration(
        policy({ durationMode: 'permanent', defaultDurationDays: null, maxDurationDays: null }),
        365,
      ),
    ).toEqual({ ok: true, days: null });
  });

  it('gives a fixed product its own number of days, ignoring the request', () => {
    expect(
      resolveRequestedDuration(
        policy({ durationMode: 'fixed', defaultDurationDays: 14, maxDurationDays: null }),
        90,
      ),
    ).toEqual({ ok: true, days: 14 });
  });

  it('defaults requesterChoice to the product default when nothing was asked', () => {
    expect(resolveRequestedDuration(policy(), null)).toEqual({ ok: true, days: 30 });
  });

  it('accepts exactly the cap and refuses one day beyond it', () => {
    // The boundary, both sides. `maxDurationDays` is validated on the form and
    // AGAIN at submission, and a form is not a control.
    expect(resolveRequestedDuration(policy(), 90)).toEqual({ ok: true, days: 90 });
    const over = resolveRequestedDuration(policy(), 91);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('unreachable');
    expect(over.message).toContain('90');
  });

  it('refuses zero, a negative, and a fraction', () => {
    for (const days of [0, -1, 1.5]) {
      expect(resolveRequestedDuration(policy(), days).ok).toBe(false);
    }
  });
});

describe('applyShortening', () => {
  it('lets an approver shorten', () => {
    // A manager who will allow three weeks but not three months should be
    // able to say so without a rejection and a resubmission.
    expect(applyShortening(90, 21)).toEqual({ ok: true, days: 21 });
  });

  it('refuses to lengthen', () => {
    const result = applyShortening(21, 90);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('shorten');
  });

  it('refuses to put an end date on a permanent grant', () => {
    // Shortening `null` is not lengthening, but it changes the product's own
    // durationMode after the fact, which is a decision the catalog makes and
    // not one an approver does. Refused rather than silently honoured.
    expect(applyShortening(null, 30).ok).toBe(false);
  });

  it('is a no-op when the approver shortened nothing', () => {
    expect(applyShortening(30, null)).toEqual({ ok: true, days: 30 });
    expect(applyShortening(null, null)).toEqual({ ok: true, days: null });
  });
});

describe('grantWindow', () => {
  it('starts now and ends the requested number of days later', () => {
    expect(
      grantWindow({ now: NOW, days: 30, requestedStartsAt: null, earliestContractStart: null }),
    ).toEqual({ startsAt: NOW, endsAt: day('2026-07-15'), scheduled: false });
  });

  it('has no end date for a permanent grant', () => {
    expect(
      grantWindow({ now: NOW, days: null, requestedStartsAt: null, earliestContractStart: null }),
    ).toEqual({ startsAt: NOW, endsAt: null, scheduled: false });
  });

  it('schedules from a future contract start, and measures the duration from there', () => {
    // The pre-hire. The grant confers nothing until the day, and its thirty
    // days are thirty days of employment rather than thirty days of waiting.
    expect(
      grantWindow({
        now: NOW,
        days: 30,
        requestedStartsAt: null,
        earliestContractStart: day('2026-07-01'),
      }),
    ).toEqual({ startsAt: day('2026-07-01'), endsAt: day('2026-07-31'), scheduled: true });
  });

  it('ignores a contract start in the past', () => {
    expect(
      grantWindow({
        now: NOW,
        days: 7,
        requestedStartsAt: null,
        earliestContractStart: day('2020-01-01'),
      }).startsAt,
    ).toEqual(NOW);
  });

  it('takes the later of a requested start and a future contract start', () => {
    expect(
      grantWindow({
        now: NOW,
        days: null,
        requestedStartsAt: day('2026-08-01'),
        earliestContractStart: day('2026-07-01'),
      }).startsAt,
    ).toEqual(day('2026-08-01'));
  });
});

describe('grantInForce', () => {
  const grant = { startsAt: day('2026-06-01'), endsAt: day('2026-06-15') };

  it('is in force the day before the end date', () => {
    expect(grantInForce(grant, day('2026-06-14'))).toBe(true);
  });

  it('is in force at the instant of the end date and not after it', () => {
    // The boundary that decides whether the sweep removes it tonight or
    // tomorrow night. `endsAt` is the moment access stops, so the instant
    // itself is out.
    expect(grantInForce(grant, day('2026-06-15'))).toBe(false);
    expect(grantInForce(grant, new Date('2026-06-14T23:59:59Z'))).toBe(true);
  });

  it('is not in force before it starts', () => {
    // A scheduled grant never confers access before its start date.
    expect(grantInForce(grant, day('2026-05-31'))).toBe(false);
    expect(grantInForce(grant, day('2026-06-01'))).toBe(true);
  });

  it('never ends when there is no end date', () => {
    expect(grantInForce({ startsAt: day('2020-01-01'), endsAt: null }, NOW)).toBe(true);
  });
});
