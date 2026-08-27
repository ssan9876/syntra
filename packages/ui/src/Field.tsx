import { useId, type InputHTMLAttributes } from 'react';

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'id'> {
  label: string;
  value: string;
  onChange(value: string): void;
  // `| undefined` on each, deliberately. `exactOptionalPropertyTypes` is on
  // repo-wide, and every caller computes these from a lookup --
  // `error={errors.name}` off a `Record<string, string>` is `string |
  // undefined` -- so without it the ordinary usage is a type error and the
  // call sites grow conditional spreads for a value the component is happy to
  // receive. Widening here permits strictly more and changes no behaviour.
  hint?: string | undefined;
  error?: string | undefined;
  /** Marks the control invalid without repeating a message shown elsewhere. */
  invalid?: boolean | undefined;
}

export function Field({
  label,
  value,
  onChange,
  hint,
  error,
  invalid,
  className = '',
  ...props
}: FieldProps) {
  const id = useId();
  const isInvalid = Boolean(error) || Boolean(invalid);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <input
        {...props}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        className={[
          'h-9 w-full rounded-control border bg-bg px-3',
          'text-ink transition-colors duration-150',
          // Placeholder must clear 4.5:1 too, so it uses muted rather than
          // the browser's washed-out default.
          'placeholder:text-muted',
          'disabled:bg-surface-2 disabled:text-muted',
          isInvalid
            ? 'border-danger'
            : 'border-border-control hover:border-border-strong',
        ].join(' ')}
      />
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
