import { buttonClasses } from './Button.js';

export interface PagerProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Rows matching the filters, which is what the count describes. */
  total: number;
  onPage(page: number): void;
}

/**
 * Where you are in a list, and how to move.
 *
 * Buttons are disabled rather than hidden at the ends: a control that vanishes
 * moves the one beside it under the cursor somebody was about to click. The
 * count stays for the same reason a single-page list still renders this at all
 * -- "1-12 of 12" is an answer, and hiding the control would take it away.
 */
export function Pager({ page, pageSize, total, onPage }: PagerProps) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="mt-4 flex items-center justify-between gap-4 text-sm text-muted">
      {/* Polite, not assertive: the count changing is worth hearing after the
          rows do, not interrupting them. */}
      <span aria-live="polite">
        {total === 0
          ? 'No results'
          : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonClasses('secondary')}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={buttonClasses('secondary')}
          disabled={page >= lastPage}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
