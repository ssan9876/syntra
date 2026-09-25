import type { ReactNode } from 'react';
import { StateBadge, Status, type SummaryError } from '@syntra/ui';

/**
 * The state words the long editors share: whether the draft on screen has been
 * saved, and whether a result shown beside it still describes it.
 *
 * Kept in one place because the connector editors each grew a test report or a
 * preview, and the usability review found the same fault in all of them — a
 * result that described the PREVIOUS draft looked exactly like one that
 * described this one. The words are fixed here so "out of date" means the same
 * thing on every screen, and a reader who has learned it once can trust it.
 */

/** Beside a stale result, and on its section: the result no longer applies. */
export const STALE_LABEL = 'Out of date — run again';

export function StaleBadge({ children = STALE_LABEL }: { children?: ReactNode }) {
  return <StateBadge state="attention">{children}</StateBadge>;
}

/**
 * The `status` slot of a long form's `FormActions`: what decides whether to
 * press Save, beside Save. `undefined` when there is nothing to say, so the
 * slot does not render an empty live region.
 */
export function draftStatus({
  dirty,
  stale,
}: {
  dirty: boolean;
  /** "Test result is out of date", "Preview is out of date" — or nothing. */
  stale?: string | null | undefined;
}): ReactNode {
  if (!dirty && !stale) return undefined;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {dirty && (
        <Status tone="neutral" glyph="dot">
          Unsaved changes
        </Status>
      )}
      {stale && <StateBadge state="attention">{stale}</StateBadge>}
    </span>
  );
}

/**
 * Field errors as `ErrorSummary` entries, each labelled the way the control
 * is labelled on screen.
 *
 * A field the form has no control for keeps its message but loses its link:
 * an entry that focuses nothing when clicked is worse than plain text.
 */
export function summaryOf(
  invalid: Record<string, string>,
  labels: Record<string, string>,
): SummaryError[] {
  return Object.entries(invalid).map(([field, message]) => {
    const label = labels[field];
    return label
      ? { field, message: `${label}: ${message}` }
      : { message: `${field}: ${message}` };
  });
}

/**
 * A stable fingerprint of whatever a result was produced from.
 *
 * Compared by value, deliberately: the question a stale badge answers is
 * "would running it again send something different", and an edit that is
 * typed and then undone does not change the answer.
 */
export const draftKey = (value: unknown) => JSON.stringify(value);
