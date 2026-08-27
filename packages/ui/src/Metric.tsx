import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'primary';

const TONES: Record<Tone, string> = {
  neutral: 'text-ink',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  primary: 'text-primary',
};

export interface MetricProps {
  label: string;
  value: ReactNode;
  /**
   * What the figure means, when the label cannot carry it. Governance numbers
   * are almost never self-describing: "certified" and "revoked" are outcomes,
   * "requires a change" is neither, and a reader who does not know which of
   * them count as decided cannot use any of them.
   */
  hint?: string | undefined;
  tone?: Tone | undefined;
  /**
   * Draws no attention when the figure is zero. A campaign with no blocked
   * items should not have a red zero on it — an outcome that did not happen
   * is not a warning about it.
   */
  quietWhenZero?: boolean | undefined;
}

/**
 * One figure, its label, and the tone that says whether to care.
 *
 * The console reported its most important numbers as prose: seven governance
 * outcomes delivered as "12 certified, 3 revoked, 1 require a change
 * somewhere else, 0 moot, 4 undecided" — a sentence nobody can scan, on the
 * screen somebody opens specifically to find out where a review stands.
 *
 * The value is `text-xl` and tabular. Everything else on a console page sits
 * at or below body size, so a figure at 1.5rem is the only thing on the panel
 * that reads from a metre away, which is the whole job.
 */
export function Metric({ label, value, hint, tone = 'neutral', quietWhenZero }: MetricProps) {
  const isZero = value === 0 || value === '0';
  const applied = quietWhenZero && isZero ? 'neutral' : tone;
  return (
    <div className="min-w-0">
      <div
        className={[
          'text-xl font-semibold tabular-nums',
          quietWhenZero && isZero ? 'text-muted' : TONES[applied],
        ].join(' ')}
      >
        {value}
      </div>
      <div className="mt-0.5 text-sm font-medium text-ink">{label}</div>
      {hint && <div className="mt-0.5 text-sm text-muted text-pretty">{hint}</div>}
    </div>
  );
}

/**
 * A row of figures that belong to one question.
 *
 * Wraps rather than scrolls, and uses a minimum column width rather than a
 * fixed count: these appear inside panels of several widths, and a four-up
 * grid that becomes four slivers on a narrow console is worse than a two-up
 * one that stays legible.
 */
export function MetricRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-5 [grid-template-columns:repeat(auto-fit,minmax(9rem,1fr))]">
      {children}
    </div>
  );
}
