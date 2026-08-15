import type { ProposedChange } from './diff.js';

export interface GuardInput {
  changes: ProposedChange[];
  recordsRead: number;
  /** Active users this source currently owns — the denominator. */
  activeUsersFromSource: number;
  thresholdPercent: number;
}

export type GuardVerdict = { blocked: false } | { blocked: true; reason: string };

/**
 * Decides whether a diff is safe to apply.
 *
 * This is the protection against a source outage emptying the directory. It
 * is not advisory: a blocked run will not apply even with autoApply on,
 * because an unattended schedule is exactly when nobody is watching.
 */
export function evaluateGuard(input: GuardInput): GuardVerdict {
  if (input.recordsRead === 0) {
    return { blocked: true, reason: 'the source returned no records' };
  }

  const deactivations = input.changes.filter(
    (c) => c.changeType === 'deactivate_user' || c.changeType === 'deactivate_group',
  ).length;

  if (deactivations === 0) return { blocked: false };
  if (input.activeUsersFromSource === 0) return { blocked: false };

  const share = (deactivations / input.activeUsersFromSource) * 100;
  if (share > input.thresholdPercent) {
    return {
      blocked: true,
      reason:
        `would deactivate ${deactivations} of ${input.activeUsersFromSource} ` +
        `objects from this source (${share.toFixed(1)}%), above the ` +
        `${input.thresholdPercent}% threshold`,
    };
  }

  return { blocked: false };
}
