import type { ReactNode } from 'react';

export interface CheckProps {
  checked: boolean;
  onChange(value: boolean): void;
  label: ReactNode;
  hint?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * A checkbox with its label and its consequence.
 *
 * The `hint` is not decoration on this product: every checkbox in the console
 * turns something on that has an effect somebody has to be able to predict,
 * and a bare label rarely says what that effect is.
 */
export function Check({
  checked,
  onChange,
  label,
  hint,
  className = '',
  disabled,
}: CheckProps) {
  return (
    <div className={className}>
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span>
          <span className="font-medium text-ink">{label}</span>
          {hint && <span className="mt-0.5 block text-sm text-muted">{hint}</span>}
        </span>
      </label>
    </div>
  );
}
