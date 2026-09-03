import { useId, type ComponentPropsWithRef } from 'react';

// `ComponentPropsWithRef`, matching Button and for the same reason: a caller
// that puts a form on screen in place of a control has to move focus into it,
// and the confirmation field of a destructive action is the one place where
// landing nowhere is most expensive. The ref rides through the `...props`
// spread onto the input below.
export interface FieldProps
  extends Omit<ComponentPropsWithRef<'input'>, 'onChange' | 'id'> {
  label: string;
  value: string;
  onChange(value: string): void;
  // `| undefined` on each, deliberately. `exactOptionalPropertyTypes` is on
  // repo-wide, and every caller computes these from a lookup --
  // `error={errors.name}` off a `Record<string, string>` is `string |
  // undefined` -- so without it the ordinary usage is a type error and the
  // call sites grow conditional spreads for a value the component is happy to
  // receive. Widening here permits strictly more and changes no behaviour.
  /**
   * A consequence of using this control that the control cannot show.
   *
   * NOT help text, and deliberately not the `hint` it replaced. A hint was
   * permanent: a sentence under every field, shown to everybody, forever,
   * whether or not it applied — and eighty-nine of them turned the console's
   * forms into prose about themselves. Anything a hint said about what a
   * field IS belongs in its label; what is left is the smaller set of things
   * a field can DO that a reader could not have predicted, and those are
   * states.
   *
   * So pass this conditionally. A warning that is always on is a hint wearing
   * a warning's colour, and the reader will learn to skip it just as fast.
   */
  warning?: string | undefined;
  error?: string | undefined;
  /** Marks the control invalid without repeating a message shown elsewhere. */
  invalid?: boolean | undefined;
}

export function Field({
  label,
  value,
  onChange,
  warning,
  error,
  invalid,
  className = '',
  ...props
}: FieldProps) {
  const id = useId();
  const isInvalid = Boolean(error) || Boolean(invalid);
  // The warning keeps the accessible description the hint used to provide.
  // Dropping `hint` without this would have taken information away from
  // screen-reader users in the name of removing prose.
  const describedBy = error ? `${id}-error` : warning ? `${id}-warning` : undefined;

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
      {/* An error wins. An error is about what the reader just did; a
          warning is about what happens next, and showing both leaves them
          working out which one is blocking. */}
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
