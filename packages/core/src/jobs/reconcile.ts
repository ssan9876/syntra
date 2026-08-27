/**
 * Checking that a schedule was actually registered, rather than assuming.
 *
 * `scheduleBackgroundWork` calls `schedule()` for every tenant and catches
 * per-tenant so that one tenant's bad cron cannot cost everybody else their
 * sync. That catch is right, and it has a cost: a failure that hits EVERY
 * tenant is indistinguishable from one tenant's bad data, and the process
 * starts, passes its readiness probe, serves every request, and has no
 * scheduled work at all.
 *
 * It happened. Three of six schedule-key builders separated their parts with
 * colons, which pg-boss's `assertObjectName` refuses, so Automate's four jobs,
 * all seven Govern purposes and webhook delivery were never once registered on
 * the lab installation. Every one of them also has a manual path that works,
 * which is why nobody noticed. For an identity product that is not a small
 * bug: expiry sweeps not running means access that should have been revoked is
 * still granted, and the audit log looks clean because nothing happened.
 *
 * The product already states the principle, on the revocation batch screen:
 * "A dispatch is not an outcome: each one advances to confirmed when the
 * owning subsystem reports it applied." It applied that scepticism to other
 * people's subsystems and not to its own scheduler. This is the same rule,
 * turned inward.
 *
 * Pure, and separate from the pg-boss wrapper, so the comparison can be tested
 * without standing up a queue. The wrapper supplies both sides.
 */

/** The pg-boss identity of a schedule: the queue, and the key within it. */
export interface ScheduleRef {
  name: string;
  key: string;
}

/**
 * pg-boss keys its schedule table on (name, key), with key defaulting to ''.
 *
 * A space separates them, and can: `assertObjectName` restricts both halves to
 * word characters, periods, hyphens and slashes, so neither can contain one.
 */
const identity = (ref: ScheduleRef) => `${ref.name} ${ref.key}`;

export interface Intents {
  /** Record a schedule this process asked for. Call BEFORE attempting it. */
  scheduled(name: string, key: string | undefined): void;
  /** Forget one it deliberately removed. */
  unscheduled(name: string, key: string | undefined): void;
  list(): ScheduleRef[];
}

export function trackIntents(): Intents {
  // Keyed by identity so a reconciling re-run records each intent once rather
  // than accumulating a duplicate per restart.
  const intents = new Map<string, ScheduleRef>();

  return {
    scheduled(name, key) {
      const ref = { name, key: key ?? '' };
      intents.set(identity(ref), ref);
    },
    unscheduled(name, key) {
      // An unscheduled source is a schedule that SHOULD be absent. Reporting
      // it as missing would teach somebody to ignore the report, which is the
      // failure mode this whole mechanism exists to avoid.
      intents.delete(identity({ name, key: key ?? '' }));
    },
    list() {
      return [...intents.values()];
    },
  };
}

/**
 * The intents with no schedule row behind them.
 *
 * Asks only "is what I asked for there". The opposite question -- is anything
 * there I did not ask for -- has legitimate answers (another process, an older
 * release, a tenant this instance does not serve) and would make the report
 * noise, which is how a monitor stops being read.
 */
export function missingFrom(
  intended: readonly ScheduleRef[],
  actual: readonly ScheduleRef[],
): ScheduleRef[] {
  const present = new Set(actual.map(identity));
  return intended.filter((ref) => !present.has(identity(ref)));
}
