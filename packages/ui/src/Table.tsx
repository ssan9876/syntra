import { useEffect, useState, type ReactNode } from 'react';

export type Density = 'comfortable' | 'compact';

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
  density,
  stickyHeader = false,
  label,
  className = '',
}: {
  children: ReactNode;
  /** For a table read as a reference rather than worked through row by row. */
  tight?: boolean;
  /**
   * The reader's own choice, from `DensityToggle`. `tight` is the page's
   * decision about what KIND of table this is; density is the operator's
   * decision about how much of it they want on screen. Either makes it tight.
   */
  density?: Density | undefined;
  /**
   * Keeps the column headings in view down a long table.
   *
   * The container becomes the scroller — capped at most of the viewport — because
   * a sticky heading sticks to its nearest scrolling ancestor, and the
   * horizontal scroll this component exists for already makes the container
   * one. Sticking to the PAGE would mean giving up the horizontal scroll,
   * which is the worse trade on a narrow console. For queues worked through
   * row by row; a twelve-row reference table does not need it.
   */
  stickyHeader?: boolean;
  /**
   * Names the table — or, with `stickyHeader`, the keyboard-scrollable
   * region around it, since a focusable scroller with no name is announced as
   * an unlabelled group and naming both would announce the name twice.
   */
  label?: string | undefined;
  className?: string;
}) {
  const compact = tight || density === 'compact';
  return (
    <div
      className={[
        'w-full overflow-x-auto',
        stickyHeader ? 'data-table-scroll max-h-[min(70vh,48rem)] overflow-y-auto' : '',
      ].join(' ')}
      {...(stickyHeader ? { tabIndex: 0, role: 'region', 'aria-label': label ?? 'Table' } : {})}
    >
      <table
        aria-label={stickyHeader ? undefined : label}
        className={[
          'data-table',
          compact ? 'data-table--tight' : '',
          stickyHeader ? 'data-table--sticky' : '',
          className,
        ]
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

/**
 * The strip between a list's filters and its table: how fresh the rows are,
 * and the reader's view preferences.
 */
export function TableToolbar({ children }: { children: ReactNode }) {
  return <div className="mb-2 flex flex-wrap items-center justify-end gap-2 text-sm">{children}</div>;
}

/**
 * "Compact" or "Comfortable", for the reader rather than the page.
 *
 * Somebody working two hundred rows of a queue on a laptop wants them tight;
 * somebody reading ten on a ward PC wants room. The console had one row
 * height by design, and it stays the default — this lets a reader opt down,
 * and `useDensity` remembers it per list.
 */
export function DensityToggle({
  value,
  onChange,
}: {
  value: Density;
  onChange(value: Density): void;
}) {
  return (
    <div role="group" aria-label="Row density" className="inline-flex rounded-control border border-border-control">
      {(['comfortable', 'compact'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={[
            'px-2 py-1 text-sm font-medium first:rounded-l-[calc(var(--radius-control)-1px)] last:rounded-r-[calc(var(--radius-control)-1px)]',
            'transition-colors duration-150 ease-out-quart',
            value === option ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink',
          ].join(' ')}
        >
          {option === 'comfortable' ? 'Comfortable' : 'Compact'}
        </button>
      ))}
    </div>
  );
}

/**
 * A preference that survives a reload, and quietly does nothing where storage
 * is refused — a locked-down kiosk profile must not lose the page over a
 * cosmetic setting.
 */
export function useStoredPreference<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* storage refused: the preference lasts the session */
    }
  }, [key, value]);
  return [value, setValue];
}

export function useDensity(list: string) {
  return useStoredPreference<Density>(`syntra.density.${list}`, 'comfortable', [
    'comfortable',
    'compact',
  ]);
}

export interface ColumnDef {
  id: string;
  label: string;
  /** A column the table makes no sense without — the record's name. */
  required?: boolean | undefined;
}

/**
 * Which optional columns are shown.
 *
 * A `<details>` rather than a scripted menu: it opens and closes from the
 * keyboard, announces its state, and needs no focus management of its own
 * because it never leaves the flow. The record's own column is marked
 * `required` and cannot be hidden — a row with no name is not a row.
 */
export function ColumnPicker({
  columns,
  hidden,
  onChange,
}: {
  columns: ColumnDef[];
  hidden: ReadonlySet<string>;
  onChange(hidden: Set<string>): void;
}) {
  const optional = columns.filter((column) => !column.required);
  if (optional.length === 0) return null;
  return (
    <details className="relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-control border border-border-control px-2 py-1 text-sm font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        Columns
        {hidden.size > 0 && (
          <span className="rounded-full bg-surface-2 px-1.5 text-xs font-semibold tabular-nums">
            {columns.length - hidden.size}/{columns.length}
          </span>
        )}
      </summary>
      <fieldset className="absolute right-0 z-[var(--z-dropdown)] mt-1 w-56 rounded-control border border-border-control bg-bg p-2 shadow-overlay">
        <legend className="sr-only">Visible columns</legend>
        {optional.map((column) => (
          <label key={column.id} className="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-surface">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={!hidden.has(column.id)}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(column.id);
                else next.add(column.id);
                onChange(next);
              }}
            />
            {column.label}
          </label>
        ))}
      </fieldset>
    </details>
  );
}

/** The set of hidden columns for one list, remembered like density. */
export function useHiddenColumns(list: string, initiallyHidden: string[] = []) {
  const key = `syntra.columns.${list}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {
      /* fall through */
    }
    return new Set(initiallyHidden);
  });
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify([...hidden]));
    } catch {
      /* storage refused */
    }
  }, [key, hidden]);
  return [hidden, setHidden] as const;
}
