import { useEffect, useRef, type ReactNode } from 'react';

export interface CheckboxProps {
  checked: boolean;
  onChange(value: boolean): void;
  /**
   * Required, and always a full name: "Select Ana Ruiz", never "Select". A
   * column of checkboxes read out of context is a column of identical
   * controls otherwise.
   */
  label: string;
  /** Some but not all of the rows it governs are selected. */
  indeterminate?: boolean | undefined;
  disabled?: boolean | undefined;
}

/**
 * A bare checkbox, for a table's selection column.
 *
 * `Check` is the labelled one for forms. This is the other case — a box in a
 * row whose label is the row itself — and it was being written by hand, with
 * no `accent-primary`, so the one place the console selected in bulk rendered
 * the browser's blue.
 *
 * `indeterminate` is a DOM property with no attribute, so it is set through a
 * ref; a header box that reads "none" while half the page is selected tells
 * the reader clicking it will select, when it is about to clear.
 */
export function Checkbox({ checked, onChange, label, indeterminate, disabled }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 shrink-0 accent-primary align-middle disabled:opacity-55"
    />
  );
}

export interface BulkActionBarProps {
  /** How many rows are selected. The bar is present at zero, see below. */
  count: number;
  /** "person", "operation" — the noun being counted, singular. */
  noun: string;
  onClear(): void;
  children: ReactNode;
  /**
   * What happened to the last action, shown in the bar where the reader's eye
   * already is. "3 retried, 1 could not be retried" belongs here rather than
   * in a banner at the top of a page the reader has scrolled away from.
   */
  result?: ReactNode | undefined;
}

/**
 * The controls that act on the selected rows.
 *
 * Rendered whether or not anything is selected, with its actions disabled at
 * zero, for the reason `Pager` renders on an empty page: a bar that appears
 * on the first tick pushes the table down under the pointer that just ticked
 * it, and the second click lands on the wrong row.
 *
 * The count is a polite live region so ticking a box is heard, and the
 * selection is named — "3 operations selected" — rather than a bare figure
 * that a screen reader announces as "3".
 */
export function BulkActionBar({ count, noun, onClear, children, result }: BulkActionBarProps) {
  const plural = count === 1 ? noun : `${noun}s`;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className={[
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border px-3 py-2',
        'transition-colors duration-150 ease-out-quart',
        count > 0 ? 'border-primary/40 bg-primary-soft' : 'border-border-subtle bg-surface',
      ].join(' ')}
    >
      <span aria-live="polite" aria-atomic="true" className="text-sm font-medium text-ink tabular-nums">
        {count === 0 ? `No ${plural} selected` : `${count.toLocaleString()} ${plural} selected`}
      </span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {count > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="rounded-control px-2 py-1 text-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Clear selection
        </button>
      )}
      {result && <div className="w-full text-sm text-ink" role="status">{result}</div>}
    </div>
  );
}
