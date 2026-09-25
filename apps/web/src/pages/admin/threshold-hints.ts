import { THRESHOLDS } from './target-form.js';

type ThresholdKey = (typeof THRESHOLDS)[number][0];

export interface ThresholdHint {
  /** The target form field that decides this, as `THRESHOLDS` names it. */
  key: ThresholdKey;
  /** Its label on the target's Safety thresholds section. */
  label: string;
  /** The share this run measured, where the reason states one. */
  share: number | null;
  /** The threshold the run was measured against. */
  threshold: number | null;
  /** One sentence about this particular setting, where it needs one. */
  note: string | null;
}

/** The anchor of the Safety thresholds section on the target's edit form. */
export const SAFETY_THRESHOLDS_ANCHOR = 'safety-thresholds';

const label = (key: ThresholdKey) => THRESHOLDS.find(([k]) => k === key)![1];

/**
 * Which setting each of `guard.ts`'s tripped-threshold reasons is measured
 * against. Matched on the reason's opening words, which the guard builds from
 * a fixed verb per action type (`would create`, `would disable`, …).
 */
const RULES: { pattern: RegExp; key: ThresholdKey; note?: string }[] = [
  { pattern: /^would create \d+ of \d+ accounts/, key: 'createAccountThresholdPercent' },
  { pattern: /^would disable \d+ of \d+/, key: 'disableAccountThresholdPercent' },
  { pattern: /^would archive \d+ of \d+/, key: 'archiveAccountThresholdPercent' },
  {
    pattern: /^would move \d+ of \d+/,
    key: 'archiveAccountThresholdPercent',
    note: 'Container moves are measured against the archive threshold: there is no separate setting for them.',
  },
  { pattern: /^would revoke "/, key: 'perEntitlementThresholdPercent' },
  { pattern: /^would revoke \d+ of \d+/, key: 'revokeEntitlementThresholdPercent' },
  { pattern: /^would deactivate \d+ of \d+/, key: 'deactivateSyntraUserThresholdPercent' },
  { pattern: /number of people holding an active contract has fallen/, key: 'personPopulationDropPercent' },
];

/**
 * The settings that held a blocked run, read from its recorded reason.
 *
 * Only tripped thresholds are hints: a reason that is not a number compared
 * against a setting — the first-run rule, a target with no accounts, an axis
 * with no denominator — has no field anybody could change, and naming one
 * would send them to the wrong place.
 */
export function thresholdHints(blockedReason: string | null): ThresholdHint[] {
  if (!blockedReason) return [];
  const hints: ThresholdHint[] = [];
  for (const reason of blockedReason.split('; ')) {
    const rule = RULES.find(({ pattern }) => pattern.test(reason));
    if (!rule || hints.some((hint) => hint.key === rule.key)) continue;
    const share = /\((\d+(?:\.\d+)?)%\)/.exec(reason)?.[1];
    const threshold = /above the (\d+(?:\.\d+)?)%/.exec(reason)?.[1];
    hints.push({
      key: rule.key,
      label: label(rule.key),
      share: share === undefined ? null : Number(share),
      threshold: threshold === undefined ? null : Number(threshold),
      note: rule.note ?? null,
    });
  }
  return hints;
}

/** Whether the guard held this run because it is the target's first. */
export function isFirstRunHold(blockedReason: string | null): boolean {
  return /first run is confirmed by a person/.test(blockedReason ?? '');
}
