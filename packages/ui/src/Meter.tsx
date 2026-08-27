type Tone = 'primary' | 'success' | 'warning' | 'danger';

const FILLS: Record<Tone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface MeterProps {
  /** 0–100. Clamped, because a coverage figure computed from live counts can exceed its denominator mid-run. */
  percent: number;
  /**
   * What the bar is a proportion OF, in words. Required rather than optional:
   * a bar with no denominator is a decoration, and this product's percentages
   * are the ones an auditor asks about.
   */
  label: string;
  tone?: Tone;
}

/**
 * A proportion, drawn.
 *
 * Deliberately not a component that shows the number — the number is a
 * `Metric` and says its own denominator. This is the second channel: a reader
 * scanning a list of campaigns needs to see "nearly done" and "barely
 * started" without reading either figure.
 *
 * `role="img"` with a composed label rather than `<progress>`. A progress
 * element is a task in flight; a certification rate is a measurement of one
 * that may be finished, and screen readers announce the two differently.
 */
export function Meter({ percent, label, tone = 'primary' }: MeterProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="img"
      aria-label={`${Math.round(clamped)}% ${label}`}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-200 ease-out-quart ${FILLS[tone]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
