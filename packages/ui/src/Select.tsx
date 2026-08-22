import { useId } from 'react';

export interface SelectProps {
  label: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
  // `| undefined` on each, for the reason `Field` spells out: with
  // `exactOptionalPropertyTypes` on, `error={errs.name}` off a
  // `Record<string, string>` is `string | undefined` and will not assign to
  // `string?`. `Field` was widened when it hit this; `Select` was not, and the
  // two drifted — which is precisely what this shared component exists to
  // prevent.
  hint?: string | undefined;
  error?: string | undefined;
  className?: string | undefined;
}

/**
 * `Field`'s shape, for a closed set of values.
 *
 * Here rather than private to one page for the reason `buttonClasses` is
 * exported: the sources editor and the targets editor both need it, and a
 * hand-copied class list is how the two controls on the sources page had
 * already drifted from each other. Label, hint and error markup are identical
 * to `Field` on purpose — a form that mixes two spellings of the same control
 * reads as two forms.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  className = '',
}: SelectProps) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={[
          'h-9 w-full rounded-control border bg-bg px-3 text-ink',
          'transition-colors duration-150',
          error
            ? 'border-danger'
            : 'border-border-subtle hover:border-border-strong',
        ].join(' ')}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
          {hint}
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
