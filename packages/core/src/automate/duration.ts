// `addDays` comes from Provision's planner, which already owns the one
// implementation of date arithmetic in this codebase. Redefining it here
// would give `packages/core/src/index.ts` two `addDays` exports, which is an
// ambiguous re-export and a build error -- and, worse, two implementations of
// month-boundary arithmetic to keep in agreement.
import { addDays } from '../provision/plan.js';

export type DurationMode = 'permanent' | 'fixed' | 'requesterChoice';

export interface DurationPolicy {
  durationMode: DurationMode;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
}

export type DurationOutcome =
  | { ok: true; days: number | null }
  | { ok: false; message: string };

/**
 * What duration a submission actually gets.
 *
 * `permanent` ignores the request entirely -- there is no end date to argue
 * about. `fixed` ignores it too, because the product decided. Only
 * `requesterChoice` reads it, and the cap is checked HERE as well as on the
 * form, because a form is a convenience and not a control.
 */
export function resolveRequestedDuration(
  policy: DurationPolicy,
  requestedDays: number | null,
): DurationOutcome {
  if (policy.durationMode === 'permanent') return { ok: true, days: null };
  if (policy.durationMode === 'fixed') return { ok: true, days: policy.defaultDurationDays };

  const days = requestedDays ?? policy.defaultDurationDays;
  if (days === null) return { ok: false, message: 'Say how long this is needed for' };
  if (!Number.isInteger(days) || days <= 0) {
    return { ok: false, message: 'Ask for a whole number of days, at least one' };
  }
  if (policy.maxDurationDays !== null && days > policy.maxDurationDays) {
    return {
      ok: false,
      message: `This product may be held for at most ${policy.maxDurationDays} days`,
    };
  }
  return { ok: true, days };
}

/**
 * An approver may SHORTEN a duration when deciding, and may not lengthen it.
 *
 * Shortening a permanent grant is refused rather than honoured: `null` to
 * thirty days is not a shortening, it is a change to the product's
 * `durationMode` made one request at a time, and that is a catalog decision.
 */
export function applyShortening(
  days: number | null,
  shortenedToDays: number | null,
): DurationOutcome {
  if (shortenedToDays === null) return { ok: true, days };
  if (!Number.isInteger(shortenedToDays) || shortenedToDays <= 0) {
    return { ok: false, message: 'A shortened duration is a whole number of days' };
  }
  if (days === null) {
    return {
      ok: false,
      message: 'This product grants permanent access; you can approve it or refuse it',
    };
  }
  if (shortenedToDays > days) {
    return { ok: false, message: 'An approver may shorten a request, never lengthen it' };
  }
  return { ok: true, days: shortenedToDays };
}

export interface GrantWindowInput {
  now: Date;
  /** Null for a permanent grant. */
  days: number | null;
  /** A start the requester deliberately chose. */
  requestedStartsAt: Date | null;
  /** The subject's earliest contract start, when that is in the future. */
  earliestContractStart: Date | null;
}

/**
 * When a grant runs.
 *
 * A grant starts at the moment of fulfilment, or a later date the requester
 * chose, or the subject's contract start where that is in the future --
 * whichever is latest. The last case is the pre-hire: the grant is
 * `scheduled`, confers nothing, and becomes `pending` on the day.
 *
 * The duration is measured from `startsAt`, not from now. Thirty days of a
 * pre-hire's access are thirty days of employment, not thirty days of waiting.
 */
export function grantWindow(input: GrantWindowInput): {
  startsAt: Date;
  endsAt: Date | null;
  scheduled: boolean;
} {
  const candidates = [input.now];
  if (input.requestedStartsAt !== null && input.requestedStartsAt > input.now) {
    candidates.push(input.requestedStartsAt);
  }
  if (input.earliestContractStart !== null && input.earliestContractStart > input.now) {
    candidates.push(input.earliestContractStart);
  }
  const startsAt = candidates.reduce((a, b) => (a > b ? a : b));

  return {
    startsAt,
    endsAt: input.days === null ? null : addDays(startsAt, input.days),
    scheduled: startsAt > input.now,
  };
}

/**
 * Whether a grant's window covers `now`.
 *
 * `startsAt` is inclusive and `endsAt` is exclusive: the end date is the
 * moment access stops. This is the boundary the nightly sweep reads, and
 * getting it the other way round leaves everybody holding their access for one
 * extra day.
 */
export function grantInForce(
  grant: { startsAt: Date; endsAt: Date | null },
  now: Date,
): boolean {
  if (now < grant.startsAt) return false;
  return grant.endsAt === null || now < grant.endsAt;
}
