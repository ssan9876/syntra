import { useId } from 'react';

export interface SelectProps {
  label: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
  // `| undefined` on each, for the reason `Field` spells out: with
  // `exactOptionalPropertyTypes` on, `error={errs.name}` off a
  // `Record<string, string>` is `string | undefined` and will not assign to
  // `string?`.
  /**
   * A consequence of this choice the control cannot show. The same contract
   * as `Field`'s: conditional, a state rather than a caption.
   *
   * This replaced `hint`. `Field` and `Check` lost theirs when the console
   * stopped explaining itself, and `Select` kept one — so the three controls
   * of one form took two different kinds of sub-text, and the one that was
   * still allowed to carry a permanent sentence was the one most likely to be
   * handed one. Nothing passed it by then; the prop was an invitation.
   */
  warning?: string | undefined;
  error?: string | undefined;
  /** Marks the control invalid without repeating a message shown elsewhere. */
  invalid?: boolean | undefined;
  /** Carried to the element so a form-level `ErrorSummary` can focus it. */
  name?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
}

/**
 * `Field`'s shape, for a closed set of values.
 *
 * Label, warning and error markup are identical to `Field` on purpose — a
 * form that mixes two spellings of the same control reads as two forms.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  warning,
  error,
  invalid,
  name,
  className = '',
  disabled = false,
}: SelectProps) {
  const id = useId();
  const isInvalid = Boolean(error) || Boolean(invalid);
  const describedBy = error ? `${id}-error` : warning ? `${id}-warning` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        className={[
          'h-9 w-full rounded-control border bg-bg px-3 text-ink',
          'transition-colors duration-150',
          // The same disabled treatment as `Field`. This used to be
          // `opacity-60`, so a disabled select and a disabled input beside it
          // were two different greys.
          'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted',
          isInvalid
            ? 'border-danger'
            : 'border-border-control hover:border-border-strong',
        ].join(' ')}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {warning && !error && (
        <p id={`${id}-warning`} className="mt-1.5 text-sm text-warning">
          {warning}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
