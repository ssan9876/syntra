import { useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface TabDef {
  /** Appears in the URL. Stable: it outlives the label in bookmarks. */
  id: string;
  label: string;
  content: ReactNode;
  /**
   * A count worth seeing before the tab is opened — 3 blocked runs, 12
   * undecided items. Optional and deliberately not a "notification dot":
   * the number is the information, and a dot would be a decoration that
   * needs explaining.
   */
  badge?: ReactNode;
  /**
   * Filtered out entirely rather than disabled. A disabled tab tells a reader
   * about a permission they do not have and cannot obtain from this screen,
   * which is a sentence the console should not be making them read.
   */
  hidden?: boolean;
}

/**
 * A tabbed destination.
 *
 * The console's navigation collapsed from twenty-nine links into eleven, and
 * the difference did not evaporate — it moved in here. That makes a tab a
 * LOCATION rather than a widget, and the distinction is the whole design:
 *
 * - **The selection lives in the URL, not in `useState`.** An administrator
 *   pasting "the orphan accounts screen" into a ticket has to be pasting a
 *   link that opens on orphan accounts. With component state, eleven screens
 *   would silently become unlinkable the day they were merged, and the reply
 *   to that ticket would be a sentence explaining which tab to click — which
 *   is the failure this redesign exists to remove.
 * - **An unknown id falls back to the first tab.** Tabs get renamed and
 *   tickets outlive them. A blank page reads as broken; the first tab reads
 *   as the page, which is what a stale link should degrade into.
 * - **Only the mounted panel renders.** Several of these tabs are tables that
 *   fetch on mount, and rendering seven of them to hide six would turn one
 *   screen into seven requests.
 */
export function Tabs({
  label,
  tabs,
  param = 'tab',
}: {
  /** Names the strip for a screen reader. Usually the page's own title. */
  label: string;
  tabs: TabDef[];
  /** The search parameter carrying the selection. Overridden where a page has two strips. */
  param?: string;
}) {
  const [params, setParams] = useSearchParams();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const visible = tabs.filter((tab) => !tab.hidden);
  if (visible.length === 0) return null;

  const requested = params.get(param);
  const index = Math.max(
    0,
    visible.findIndex((tab) => tab.id === requested),
  );
  const current = visible[index]!;

  function select(next: number, focus: boolean) {
    const tab = visible[next];
    if (!tab) return;
    // `replace`, so arrowing across seven tabs leaves one history entry
    // rather than seven for the back button to walk out of.
    const updated = new URLSearchParams(params);
    updated.set(param, tab.id);
    setParams(updated, { replace: true });
    if (focus) refs.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const last = visible.length - 1;
    // Wraps in both directions. A strip that stops at the end makes the
    // reader reverse over six tabs to reach the one before the first.
    const moves: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  }

  return (
    <div>
      {/* `border-border-subtle`: the rule under the strip is decoration —
          the selected tab is identified by its own 2px primary edge, which
          is what 1.4.11 actually measures. */}
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="-mb-px flex gap-1 overflow-x-auto border-b border-border-subtle"
      >
        {visible.map((tab, i) => {
          const selected = i === index;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                refs.current[i] = node;
              }}
              id={`${param}-tab-${tab.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${param}-panel-${tab.id}`}
              // Roving tabindex: one stop for the strip, not seven, so a
              // keyboard reader reaches the content in two keys.
              tabIndex={selected ? 0 : -1}
              onClick={() => select(i, false)}
              className={[
                'flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-base font-medium',
                'transition-colors duration-150 ease-out-quart',
                selected
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted hover:border-border-control hover:text-ink',
              ].join(' ')}
            >
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null && (
                <span
                  className={[
                    'rounded-full px-1.5 py-px text-xs font-semibold tabular-nums',
                    selected ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-muted',
                  ].join(' ')}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id={`${param}-panel-${current.id}`}
        role="tabpanel"
        aria-labelledby={`${param}-tab-${current.id}`}
        tabIndex={0}
        className="pt-5 focus-visible:outline-none"
      >
        {current.content}
      </div>
    </div>
  );
}
