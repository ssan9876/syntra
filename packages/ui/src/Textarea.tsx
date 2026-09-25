import { useId, type ComponentPropsWithRef } from 'react';

export interface TextareaProps
  extends Omit<ComponentPropsWithRef<'textarea'>, 'onChange' | 'id' | 'value'> {
  label: string;
  value: string;
  onChange(value: string): void;
  /** See `Field.warning`: a state that applies now, never a caption. */
  warning?: string | undefined;
  error?: string | undefined;
  invalid?: boolean | undefined;
  /**
   * Monospaced, for content that is data rather than prose: a certificate, a
   * claim mapping, a JSON document. Wrapping is left on — a PEM block that
   * scrolls sideways hides the line somebody is checking.
   */
  mono?: boolean | undefined;
}

/**
 * `Field`, for more than one line.
 *
 * Seven screens wrote a `<textarea>` by hand. Each chose its own border token
 * (three of them `border-subtle`, which fails 1.4.11 as a control boundary),
 * its own padding and its own error markup, and none wired an error to
 * `aria-describedby` — so the certificate a SAML screen rejected was reported
 * visually and not at all to a screen reader.
 */
export function Textarea({
  label,
  value,
  onChange,
  warning,
  error,
  invalid,
  mono = false,
  rows = 4,
  className = '',
  ...props
}: TextareaProps) {
  const id = useId();
  const isInvalid = Boolean(error) || Boolean(invalid);
  const describedBy = error ? `${id}-error` : warning ? `${id}-warning` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <textarea
        {...props}
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        className={[
          'block w-full rounded-control border bg-bg px-3 py-2 text-ink',
          'transition-colors duration-150 placeholder:text-muted',
          'disabled:bg-surface-2 disabled:text-muted',
          mono ? 'font-mono text-sm' : '',
          isInvalid ? 'border-danger' : 'border-border-control hover:border-border-strong',
        ].join(' ')}
      />
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
