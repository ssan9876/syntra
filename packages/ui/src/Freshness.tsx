import { useEffect, useState } from 'react';

/** "just now", "4 min ago", "2 h ago", then a date. Coarse on purpose. */
export function relativeTime(then: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * How old the rows on screen are, and a way to fetch them again.
 *
 * An operational queue is a snapshot the moment it lands, and the console
 * gave no sign of when that moment was. A reader returning to a tab left open
 * since 8:40 was looking at 8:40's queue as if it were now — and acting on a
 * failure somebody else had already retried. The time is exact on hover and
 * coarse on screen, and it ticks, because "just now" that never changes is a
 * lie told slowly.
 */
export function RefreshStatus({
  updatedAt,
  onRefresh,
  refreshing = false,
}: {
  updatedAt: Date | null;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      {updatedAt && (
        <time dateTime={updatedAt.toISOString()} title={updatedAt.toLocaleString()}>
          Updated {relativeTime(updatedAt)}
        </time>
      )}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing || undefined}
          className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft disabled:opacity-55"
        >
          <svg
            viewBox="0 0 12 12"
            className={`size-3 ${refreshing ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M10 6a4 4 0 1 1-1.2-2.85M10 1.5v2.5H7.5" />
          </svg>
          Refresh
        </button>
      )}
    </span>
  );
}

/**
 * An identifier, set as one: monospaced, selectable in one go, and copyable.
 *
 * Run ids, hashes, correlation keys and DNs are content an operator pastes
 * into a ticket or a directory console. They were `font-mono` spans a
 * triple-click away from selecting the surrounding sentence too. `truncate`
 * keeps a 64-character hash from widening a table column; the full value
 * stays in the title and in what is copied.
 */
export function Identifier({
  value,
  truncate = false,
  copy = true,
}: {
  value: string;
  truncate?: boolean;
  copy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <span className="inline-flex max-w-full items-center gap-1 align-baseline">
      <code
        title={truncate ? value : undefined}
        className={[
          'select-all rounded bg-surface-2 px-1 py-px text-[0.8125em] text-ink',
          truncate ? 'max-w-[16ch] truncate' : 'break-all',
        ].join(' ')}
      >
        {value}
      </code>
      {copy && (
        <button
          type="button"
          onClick={() => {
            void globalThis.navigator?.clipboard?.writeText(value).then(() => setCopied(true), () => {});
          }}
          aria-label={copied ? 'Copied' : `Copy ${value}`}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink"
        >
          <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            {copied ? (
              <path d="M2.5 6.25l2.25 2.25L9.5 3.75" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <rect x="3.75" y="3.75" width="6" height="6.5" rx="1" />
                <path d="M2.25 8V2.75a1 1 0 0 1 1-1h4" />
              </>
            )}
          </svg>
        </button>
      )}
    </span>
  );
}
