import { useId, type InputHTMLAttributes } from 'react';

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'id'> {
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  error?: string;
  /** Marks the control invalid without repeating a message shown elsewhere. */
  invalid?: boolean;
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
            : 'border-border-subtle hover:border-border-strong',
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
