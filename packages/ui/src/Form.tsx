import { useEffect, useRef, type ReactNode } from 'react';

export interface SummaryError {
  /**
   * The `name` of the control the message belongs to. Clicking the entry
   * focuses it. Omitted for a problem with the form as a whole.
   */
  field?: string | undefined;
  message: string;
}

/**
 * Every problem with a submitted form, in one place, at the top.
 *
 * Field errors belong against their fields, and they stay there. But the
 * target editor is four screens long, and a submit that failed on a field
 * three screens up used to leave the reader looking at an unchanged button
 * with no idea anything had happened. This is the one message that is
 * guaranteed to be where they are looking: it takes focus when it appears,
 * and each line is a link to the control that needs fixing.
 *
 * Renders nothing when there are no errors, so it can sit in the form
 * permanently.
 */
export function ErrorSummary({
  errors,
  title = 'Fix these before saving',
}: {
  errors: SummaryError[];
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const signature = errors.map((e) => `${e.field ?? ''}:${e.message}`).join('|');

  useEffect(() => {
    if (signature) ref.current?.focus();
  }, [signature]);

  if (errors.length === 0) return null;

  function focusField(name: string) {
    const form = ref.current?.closest('form') ?? document;
    const control = form.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`);
    control?.focus();
    control?.scrollIntoView?.({ block: 'center' });
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="rounded-panel border border-danger/35 bg-danger-soft px-4 py-3 focus-visible:outline-danger"
    >
      <p className="font-semibold text-danger">{title}</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink">
        {errors.map((error) => (
          <li key={`${error.field ?? ''}:${error.message}`}>
            {error.field ? (
              <button
                type="button"
                onClick={() => focusField(error.field!)}
                className="text-left underline decoration-danger/40 underline-offset-2 hover:decoration-current"
              >
                {error.message}
              </button>
            ) : (
              error.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One stage of a long form.
 *
 * The target editor put a connection, an enforcement mode, lifecycle timings
 * and seven safety thresholds in one undifferentiated column. Somebody
 * correcting a threshold scrolled past a bind password to find it, and
 * somebody setting up a first target could not tell where the part they had
 * to fill in stopped and the part they could leave alone began.
 *
 * A heading and a rule, no card. The form is already inside a panel, and a
 * bordered box per section inside it is a card inside a card. `status` is the
 * section's STATE — "2 need attention", "Not tested" — never a description;
 * the console does not explain itself, and a section that needs a paragraph
 * to be understood needs splitting instead.
 *
 * `number` puts the sequence on the heading for a form that must be done in
 * order. Most need not be, and should not claim to be.
 */
export function FormSection({
  title,
  number,
  status,
  id,
  children,
}: {
  title: string;
  number?: number | undefined;
  status?: ReactNode;
  /** An anchor another screen can link to (`…#id`). */
  id?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 border-t border-border-subtle pt-5 first:border-t-0 first:pt-0">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 text-md font-semibold text-ink">
          {number !== undefined && (
            <span
              aria-hidden="true"
              className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted tabular-nums"
            >
              {number}
            </span>
          )}
          {title}
        </h3>
        {status && <div className="text-sm">{status}</div>}
      </header>
      {/* The measure. A two-column grid on a wide console keeps a label and
          its control within one eye movement; a single field stretched across
          1400px makes the reader hunt for its right edge. */}
      <div className="grid max-w-4xl gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * The bar holding a long form's save and cancel.
 *
 * The usability review put it plainly: the target editor's completion
 * controls were four screens below the field somebody had just changed.
 * `sticky` keeps them in reach for exactly as long as the form is on screen,
 * and no longer — it is sticky within the form, not fixed to the viewport, so
 * it scrolls away with the form rather than hovering over the next panel.
 *
 * Only for a form longer than a screen. A three-field form with a sticky bar
 * is chrome over nothing. `status` is where "Unsaved changes" or "Preview is
 * out of date" goes: the state that decides whether to press the button,
 * beside the button.
 */
export function FormActions({
  children,
  status,
  sticky = false,
}: {
  children: ReactNode;
  status?: ReactNode;
  sticky?: boolean;
}) {
  return (
    <div
      className={[
        'flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-border-subtle pt-4',
        sticky
          ? 'sticky bottom-0 z-[var(--z-sticky)] -mx-4 mt-2 bg-bg/95 px-4 pb-4 backdrop-blur-sm'
          : '',
      ].join(' ')}
    >
      {status && <div className="mr-auto text-sm" role="status">{status}</div>}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
