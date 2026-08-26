import type { ConditionResult } from './ip-match.js';

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface LocalClock {
  day: number;
  minute: number;
}

/**
 * The weekday and minute-of-day at `now` in `zone`. hourCycle 'h23' is not
 * optional: with hour12 false, some ICU builds render midnight as 24 rather
 * than 00, which puts every early-hours request outside every window.
 */
function localClock(now: Date, zone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  let day = -1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') day = DAY_INDEX[part.value] ?? -1;
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }

  return { day, minute: hour * 60 + minute };
}

export interface TimeWindow {
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

/**
 * Whether `now` falls inside the rule's window.
 *
 * An empty day list and a missing start or end are not conditions: they leave
 * that dimension unconstrained. Both ends of the minute range are inclusive,
 * and a range whose end is below its start wraps past midnight — 22:00 to
 * 06:00 is one window, not an empty one.
 *
 * A timezone the platform cannot resolve means the condition cannot be
 * decided, and `unevaluable` says so rather than pretending it was a miss.
 * Write-time validation is what keeps that from happening; this is the
 * backstop, and it must not throw, because a throw here lands in the middle of
 * a login.
 */
export function evaluateTimeWindow(window: TimeWindow, now: Date): ConditionResult {
  const constrainsDays = window.daysOfWeek.length > 0;
  const constrainsHours =
    window.startMinute !== null && window.endMinute !== null;
  if (!constrainsDays && !constrainsHours) return 'match';

  const zone = window.timezone ?? 'UTC';
  let clock: LocalClock;
  try {
    clock = localClock(now, zone);
  } catch {
    return 'unevaluable';
  }
  if (clock.day < 0) return 'unevaluable';

  if (constrainsDays && !window.daysOfWeek.includes(clock.day)) return 'no-match';

  if (constrainsHours) {
    const start = window.startMinute!;
    const end = window.endMinute!;
    const inside =
      start <= end
        ? clock.minute >= start && clock.minute <= end
        : clock.minute >= start || clock.minute <= end;
    if (!inside) return 'no-match';
  }

  return 'match';
}


// There is deliberately no boolean `matchesTimeWindow` wrapper any more, for
// the same reason `ip-match.ts` gives: `evaluateTimeWindow` answers three
// things, and a rule this cannot evaluate is not the same as a rule that does
// not match. Nothing outside its own test ever called it.
