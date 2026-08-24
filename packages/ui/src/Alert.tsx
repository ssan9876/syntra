import type { ReactNode } from 'react';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, { box: string; title: string }> = {
  info: { box: 'border-border-subtle bg-surface', title: 'text-ink' },
  // The `--color-success` tokens already existed and `Status` already used
  // them for `active`; this tone was simply missing, so confirming a completed
  // action had to borrow `info` and read as a notice rather than a result.
  success: { box: 'border-success/35 bg-success-soft', title: 'text-success' },
  warning: { box: 'border-warning/35 bg-warning-soft', title: 'text-warning' },
  danger: { box: 'border-danger/35 bg-danger-soft', title: 'text-danger' },
};

/**
 * Full border and a tinted ground. Never a thick coloured left stripe: it is
 * decoration masquerading as a signal.
 */
export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const style = TONES[tone];
  return (
    <div
      role="alert"
      className={`rounded-panel border px-4 py-3 ${style.box}`}
    >
      {title && <p className={`font-semibold ${style.title}`}>{title}</p>}
      <div className={`text-ink ${title ? 'mt-1' : ''}`}>{children}</div>
    </div>
  );
}
