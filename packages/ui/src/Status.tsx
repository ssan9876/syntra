import type { ReactNode } from 'react';

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  active: 'bg-success-soft text-success',
  // Deliberately legible rather than faded: an inactive account stays visible
  // and labelled, because hiding a deactivation makes the directory
  // unauditable.
  inactive: 'bg-surface-2 text-ink',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  primary: 'bg-primary-soft text-primary',
  // "Waiting on something outside Syntra." Accent, not primary: primary is
  // selection and the main action, and a queue full of amber pending badges
  // read as a queue full of things to click.
  info: 'bg-accent-soft text-accent',
};

export type Glyph = 'check' | 'alert' | 'blocked' | 'clock' | 'setup' | 'minus' | 'progress' | 'dot';

export function Status({
  tone = 'neutral',
  glyph,
  children,
}: {
  tone?: Tone;
  /** A shape beside the word, so a column of these scans before it is read. */
  glyph?: Glyph | undefined;
  children: ReactNode;
}) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
        'text-sm font-medium whitespace-nowrap',
        TONES[tone],
      ].join(' ')}
    >
      {glyph && <GlyphIcon glyph={glyph} />}
      {children}
    </span>
  );
}

/**
 * The console's agreed states, each with one tone, one shape and one default
 * word.
 *
 * Every screen had been choosing its own mapping: a failed run was `danger`
 * on one page and `warning` on the next; "waiting for verification" was amber
 * here and grey there; and a reader scanning a table could not learn what a
 * colour meant because it did not mean the same thing twice. Seven states
 * cover what an operator actually has to tell apart:
 *
 * | State       | Means                                            |
 * |-------------|--------------------------------------------------|
 * | `healthy`   | Done and confirmed. Nothing to do.               |
 * | `attention` | Works, but somebody should look.                 |
 * | `blocked`   | Cannot proceed without a person. Act on it.      |
 * | `pending`   | Waiting on something outside Syntra — a target,  |
 * |             | a read-back, an approver. Do not act yet.        |
 * | `running`   | Syntra is doing it now.                          |
 * | `setup`     | Not configured, so not yet a state at all.       |
 * | `inactive`  | Deliberately off. Shown, never hidden.           |
 *
 * The glyph is the second channel colour-blind readers need, and the reason
 * this is a component rather than a convention: 1.4.1 is met by the shape and
 * the word, never by the tint.
 */
export type State = 'healthy' | 'attention' | 'blocked' | 'pending' | 'running' | 'setup' | 'inactive';

const STATES: Record<State, { tone: Tone; glyph: Glyph; label: string }> = {
  healthy: { tone: 'active', glyph: 'check', label: 'Healthy' },
  attention: { tone: 'warning', glyph: 'alert', label: 'Needs attention' },
  blocked: { tone: 'danger', glyph: 'blocked', label: 'Blocked' },
  pending: { tone: 'info', glyph: 'clock', label: 'Pending verification' },
  running: { tone: 'primary', glyph: 'progress', label: 'In progress' },
  setup: { tone: 'neutral', glyph: 'setup', label: 'Needs setup' },
  inactive: { tone: 'inactive', glyph: 'minus', label: 'Inactive' },
};

export function StateBadge({ state, children }: { state: State; children?: ReactNode }) {
  const style = STATES[state];
  return (
    <Status tone={style.tone} glyph={style.glyph}>
      {children ?? style.label}
    </Status>
  );
}

/** The glyphs, drawn at 12px on a 12-unit grid. `currentColor` throughout. */
export function GlyphIcon({ glyph, className = 'size-3' }: { glyph: Glyph; className?: string }) {
  const common = {
    viewBox: '0 0 12 12',
    className: `${className} shrink-0`,
    'aria-hidden': true,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (glyph) {
    case 'check':
      return (
        <svg {...common}>
          <path d="M2.5 6.25l2.25 2.25L9.5 3.75" />
        </svg>
      );
    case 'alert':
      return (
        <svg {...common}>
          <path d="M6 1.5L10.75 10H1.25z" />
          <path d="M6 5v2M6 8.6v.01" />
        </svg>
      );
    case 'blocked':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M2.8 9.2l6.4-6.4" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.75 1.25" />
        </svg>
      );
    case 'setup':
      return (
        <svg {...common} strokeDasharray="2 1.6">
          <circle cx="6" cy="6" r="4.5" />
        </svg>
      );
    case 'minus':
      return (
        <svg {...common}>
          <path d="M3 6h6" />
        </svg>
      );
    case 'progress':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'dot':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}
