import type { ReactNode } from 'react';

/**
 * The scroll container every console table needed and none of them had.
 *
 * A table of people with eight columns does not fit a narrow console, and
 * without this the PAGE scrolled sideways — carrying the navigation and the
 * header off the screen to show one more column. The overflow belongs to the
 * table, so the rest of the page stays put.
 *
 * `.data-table` carries the row height, the header treatment and the hover.
 * See the component layer in `apps/web/src/index.css` for why that lives in
 * CSS rather than in per-cell utilities.
 */
export function Table({
  children,
  tight = false,
  className = '',
}: {
  children: ReactNode;
  /** For a table read as a reference rather than worked through row by row. */
  tight?: boolean;
  className?: string;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={['data-table', tight ? 'data-table--tight' : '', className]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </table>
    </div>
  );
}

/**
 * The controls belonging to one row.
 *
 * Right-aligned, wrapping, evenly spaced — and a real element rather than
 * `mr-2` on each child, which is what the users table was doing. That left
 * the trailing margin on the last control, so the column never lined up with
 * its own header, and a row with five controls was a different height from
 * one with two.
 *
 * A destructive control passed as `destructive` is separated by a rule rather
 * than sat in the row: it is the one thing here nobody arrived intending to
 * click, and a gap is not enough to say so.
 */
export function RowActions({
  children,
  destructive,
}: {
  children: ReactNode;
  destructive?: ReactNode;
}) {
  return (
    <div className="row-actions">
      {children}
      {destructive && (
        <>
          <span aria-hidden="true" className="h-5 w-px bg-border-subtle" />
          {destructive}
        </>
      )}
    </div>
  );
}
