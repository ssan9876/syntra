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
 * Rendered whether or not the page it describes holds any rows: `total` is the
 * answer to "how many are there", the rows on screen are not, and a list is
 * paged from a number the browser cannot see. A pager gated on the rows would
 * disappear from `?page=9` of a three-page result -- taking with it the only
 * control that gets back.
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
  const atStart = page <= 1;
  const atEnd = page >= lastPage;

  return (
    // Named, because two bare Previous/Next buttons are unlabelled out of
    // context: a screen reader listing the landmarks of a directory screen
    // otherwise offers "navigation" and leaves the reader to open it and find
    // out which one it was.
    <nav
      aria-label="Pages"
      className="mt-4 flex items-center justify-between gap-4 text-sm text-muted"
    >
      {/* Polite, not assertive: the count changing is worth hearing after the
          rows do, not interrupting them.

          The region is the element, and the count is its text. A live region
          that arrives carrying its own announcement announces nothing -- a
          screen reader reports what CHANGES inside a region it was already
          watching -- so this element exists on every render of the pager,
          including the one where the search emptied the list. That is also why
          the pager itself is no longer gated on having rows. */}
      <span aria-live="polite" aria-atomic="true">
        {total === 0
          ? 'No results'
          : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex gap-2">
        {/* `aria-disabled` and a guarded handler rather than `disabled`.
            Clicking Next onto the last page used to disable the button under
            the pointer, and the browser drops focus from a disabled element to
            `<body>` -- so a keyboard reader who paged to the end restarted from
            the top of the document. The control stays focusable and says it
            does nothing; the styling follows the attribute. */}
        <button
          type="button"
          className={buttonClasses(
            'secondary',
            'md',
            'aria-disabled:opacity-55 aria-disabled:pointer-events-none',
          )}
          aria-disabled={atStart || undefined}
          onClick={() => {
            if (!atStart) onPage(page - 1);
          }}
        >
          Previous
        </button>
        <button
          type="button"
          className={buttonClasses(
            'secondary',
            'md',
            'aria-disabled:opacity-55 aria-disabled:pointer-events-none',
          )}
          aria-disabled={atEnd || undefined}
          onClick={() => {
            if (!atEnd) onPage(page + 1);
          }}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
