import type { ReactNode } from 'react';

type Tone = 'neutral' | 'warning' | 'danger' | 'primary';

export interface SegmentOption {
  value: string;
  label: string;
  /** The server's count for this segment. Shown whether or not it is selected. */
  count?: number | undefined;
  /**
   * The tone the count takes when it is not zero. A lane of blocked work with
   * three items in it should read as three problems before its label is read.
   */
  tone?: Tone | undefined;
}

const COUNT_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  primary: 'bg-primary-soft text-primary',
};

/**
 * One choice from a short, fixed set of filters, shown all at once.
 *
 * For four or five options a `<select>` hides the very thing a filter row is
 * for — the reader has to open it to find out what the other lanes are and
 * how full they are. Laid out, the counts ARE the summary, and picking one is
 * one click rather than two.
 *
 * `aria-pressed` buttons in a named group rather than a radiogroup: each
 * option is an action that changes the list, it is Tab-reachable like every
 * other filter control on the page, and it announces as "pressed" — which is
 * exactly the state it holds. The selection is always the caller's, and on
 * every list in this console that means the URL.
 */
export function Segmented({
  label,
  value,
  onChange,
  options,
}: {
  /** Names the group for a screen reader. Not drawn. */
  label: string;
  value: string;
  onChange(value: string): void;
  options: SegmentOption[];
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap gap-1 rounded-control border border-border-control bg-surface p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        const tone = option.count ? option.tone ?? 'neutral' : 'neutral';
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={[
              'inline-flex items-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1 text-sm font-medium',
              'transition-colors duration-150 ease-out-quart',
              selected
                ? 'bg-bg text-ink shadow-raised ring-1 ring-border-control'
                : 'text-muted hover:bg-surface-2 hover:text-ink',
            ].join(' ')}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={[
                  'rounded-full px-1.5 text-xs font-semibold tabular-nums',
                  COUNT_TONES[tone],
                ].join(' ')}
              >
                {option.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface ActiveFilter {
  /** Stable key, usually the URL parameter the filter lives in. */
  key: string;
  /** What is in effect, in words: "Lane: Blocked", "Search: “archer”". */
  label: string;
  onRemove(): void;
}

/**
 * What the list is currently filtered by, each removable, and a way back to
 * the whole list.
 *
 * A filter held in the URL survives a reload and a pasted link — which is the
 * point of it — and that is also how a reader lands on a list that is quietly
 * showing four rows of four hundred. The chips are what make "this is
 * filtered" visible without reading every control above the table.
 *
 * Renders nothing when no filter is active. An empty row saying "No filters"
 * is a sentence about an absence.
 */
export function FilterChips({
  filters,
  onReset,
}: {
  filters: ActiveFilter[];
  onReset(): void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Active filters" role="group">
      {filters.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex items-center gap-1 rounded-full border border-border-control bg-bg py-0.5 pl-2.5 pr-1 text-sm text-ink"
        >
          {filter.label}
          <button
            type="button"
            onClick={filter.onRemove}
            aria-label={`Remove filter ${filter.label}`}
            className="inline-flex size-5 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}
      {filters.length > 0 && (
        <button
          type="button"
          onClick={onReset}
          className="rounded-control px-1.5 py-0.5 text-sm font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current"
        >
          Reset filters
        </button>
      )}
    </div>
  );
}

/**
 * The row of controls above a list: search, filters, and whatever else the
 * list offers, laid out once.
 *
 * `ListControls` is the search box and status select every directory list
 * shares; this is the frame for a list that needs more than that. It wraps
 * rather than scrolls, and the trailing slot is pushed to the far edge so a
 * "refreshed 2 minutes ago" or a density toggle does not sit in the middle of
 * the filters it is not part of.
 */
export function FilterBar({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-2">
      {children}
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
