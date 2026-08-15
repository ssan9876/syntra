import type { ReactNode } from 'react';

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';

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
};

export function Status({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
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
      {children}
    </span>
  );
}
