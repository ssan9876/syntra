import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'primary';

const TONES: Record<Tone, string> = {
  neutral: 'text-ink',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  primary: 'text-primary',
};

export interface StatCardProps {
  label: string;
  value: ReactNode;
  tone?: Tone | undefined;
  /**
   * Where this figure lives in full.
   *
   * A card that reports three blocked runs and cannot be clicked is a dead
   * end: the reader has been told there is a problem and handed no route to
   * it, and the console's answer to "now what" becomes a sentence somebody
   * has to write underneath. The link IS that sentence, spent as structure.
   */
  to?: string | undefined;
  /**
   * Draws no attention when the figure is zero.
   *
   * Every merged page now opens with a row of these, so a healthy console
   * shows a lot of noughts at once. Colouring them is how a reader learns
   * that red on this screen means nothing.
   */
  quietWhenZero?: boolean | undefined;
}

/**
 * One figure, in card chrome, at the top of a destination.
 *
 * The console used to answer "is anything wrong here" only by being read —
 * you opened a table, sorted it, and worked it out. Eleven merged
 * destinations make that worse rather than better, because each one now holds
 * what used to be up to seven screens. The cards are what keeps a merged page
 * scannable: the summary comes first, at a size that reads from a metre away,
 * and the tabs beneath it are where you go once you know which one you want.
 */
export function StatCard({ label, value, tone = 'neutral', to, quietWhenZero }: StatCardProps) {
  const isZero = value === 0 || value === '0';
  const quiet = quietWhenZero && isZero;

  const body = (
    <>
      <div
        className={[
          'text-2xl font-semibold tabular-nums',
          quiet ? 'text-muted' : TONES[tone],
        ].join(' ')}
      >
        {value}
      </div>
      <div className="mt-1 text-sm font-medium text-muted">{label}</div>
    </>
  );

  const shell =
    'rounded-panel border border-border-subtle bg-surface px-4 py-3 transition-colors duration-150 ease-out-quart';

  if (!to) return <div className={shell}>{body}</div>;

  return (
    <Link
      to={to}
      // `border-control` on hover, not a colour change on the figure: the
      // affordance belongs to the card, and 1.4.11 measures the boundary.
      className={`${shell} block hover:border-border-control hover:bg-surface-2`}
    >
      {body}
    </Link>
  );
}

/**
 * The row the cards sit in.
 *
 * `auto-fit` with a minimum rather than a fixed count, for the same reason
 * `MetricRow` does it: these carry two figures on one screen and six on
 * another, and a hard four-up becomes four slivers on a narrow console.
 */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(10rem,1fr))]">
      {children}
    </div>
  );
}
