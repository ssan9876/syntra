import { useId, type ReactNode } from 'react';

export interface CheckProps {
  checked: boolean;
  onChange(value: boolean): void;
  label: ReactNode;
  /**
   * Something that will override this box, shown only while it actually
   * will. See `Field`'s note: this replaced a permanent `hint`.
   */
  warning?: string | undefined;
  className?: string;
  disabled?: boolean;
}

/**
 * A checkbox, its label, and anything currently overriding it.
 *
 * This used to carry a permanent `hint`, on the reasoning that a bare label
 * rarely says what a checkbox actually does. That reasoning was right about
 * the symptom and wrong about the cure: a checkbox whose label does not say
 * what it does needs a better label, not a sentence underneath it. The one
 * thing a label genuinely cannot carry is a condition that changes — that
 * something ELSE is currently going to overrule this box — and that is what
 * `warning` is for.
 */
export function Check({
  checked,
  onChange,
  label,
  warning,
  className = '',
  disabled,
}: CheckProps) {
  const id = useId();
  return (
    <div className={className}>
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={warning ? `${id}-warning` : undefined}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span>
          <span className="font-medium text-ink">{label}</span>
          {warning && (
            <span id={`${id}-warning`} className="mt-0.5 block text-sm text-warning">
              {warning}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
