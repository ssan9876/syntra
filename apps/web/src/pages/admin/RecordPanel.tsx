import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Panel } from '@syntra/ui';
import { ApiError, api, type Problem } from '../../session/api.js';
import { fieldErrors } from './hooks.js';

/**
 * The record form the four directory pages share, for both creating and
 * editing.
 *
 * `Users`, `Groups`, `Org units` and `People` were read-only: the API has had
 * `POST /users`, `/groups`, `/org-units` and `/persons` since Core, and no
 * screen called any of them. The empty states even described the action —
 * "Create a group to grant the same access to several people at once" — while
 * offering no control to do it. Editing was missing for longer still: a group
 * named wrongly had to be deactivated and replaced, which loses its
 * memberships and leaves a permanent inactive row created by a typo.
 *
 * ONE component rather than eight hand-written forms, for the reason `Select`
 * is shared: the two controls on the sources page had already drifted from
 * each other when they were copied. Everything that differs is a prop;
 * everything that must not differ — where the error goes, when the button is
 * busy, what happens on success — lives here once. Creating and editing differ
 * by `method` and `initial` and nothing else, which is exactly why they are not
 * two components.
 *
 * Collapsed by default. These are listing pages first, and a form permanently
 * occupying the top of one pushes the thing you came to read below the fold.
 */
export function RecordPanel({
  title,
  submitLabel,
  method = 'POST',
  initial,
  onCancel,
  fields,
  build,
  path,
  onCreated,
  disabled,
  disabledReason,
  confirmable,
}: {
  /** The panel's heading when open, e.g. "New group". */
  title: string;
  submitLabel: string;
  /** `PATCH` edits what is there; the default creates. */
  method?: 'POST' | 'PATCH';
  /**
   * Set to render the form ALWAYS OPEN, with no trigger button of its own.
   *
   * How the edit forms are used. A listing page keeps one "which row is being
   * edited" and renders a single panel above the list, rather than giving
   * every row its own collapsed panel — which put a block-level button with a
   * bottom margin inside a table cell, and would have opened a two-column
   * form inside one too.
   */
  onCancel?: () => void;
  /**
   * The values the form opens with. Re-read every time it opens rather than
   * held in state from the first render, so a row changed by somebody else and
   * reloaded does not put stale text back on screen.
   */
  initial?: Record<string, string>;
  /**
   * Rendered with the current values and the per-field errors the server
   * returned, so a rejected field is marked where it went wrong rather than
   * in a banner that leaves the reader hunting.
   */
  fields(
    values: Record<string, string>,
    set: (key: string, value: string) => void,
    errors: Record<string, string>,
  ): ReactNode;
  /** Turns the raw values into the request body. */
  build(values: Record<string, string>): unknown;
  path: string;
  onCreated(): void;
  /** Set when the thing cannot be created yet, e.g. no org unit exists. */
  disabled?: boolean;
  disabledReason?: string;
  /**
   * Turns a rejected submit into a question rather than an error.
   *
   * Two refusals in this console are warnings and not verdicts: a second
   * account for one person, and a person who looks like somebody already here.
   * Both are legitimate often enough that refusing outright would be wrong,
   * and mistakes often enough that creating silently would be worse.
   *
   * It lives here rather than in the two forms because the alternative is two
   * implementations of "show the refusal, keep what they typed, re-post with a
   * flag" — and every bug this file has had was two copies of one behaviour
   * drifting apart.
   *
   * Return null to fall through to the ordinary error banner, so a form can
   * claim one problem type and leave every other refusal alone.
   */
  confirmable?: (problem: Problem) => {
    message: ReactNode;
    retryWith: Record<string, unknown>;
  } | null;
}) {
  const controlled = onCancel !== undefined;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initial ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The refusal waiting on somebody's decision, and how to get past it. */
  const [pending, setPending] = useState<{
    message: ReactNode;
    retryWith: Record<string, unknown>;
  } | null>(null);

  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const close = () => {
    // Send focus back where it came from. The trigger is unmounted while the
    // form is open, so this is a request honoured by the effect below once it
    // is back on the page.
    restoreFocus.current = true;
    setOpen(false);
    setValues(initial ?? {});
    setErrors({});
    setProblem(null);
    setPending(null);
    onCancel?.();
  };

  /**
   * Focus follows the disclosure, in both directions.
   *
   * Opening this panel unmounts the button that opened it, and a browser drops
   * focus from a removed element to `<body>` -- so a keyboard reader who
   * pressed "New user" landed nowhere, with nothing announced, and had to tab
   * from the top of the document to reach the form they had just asked for.
   * Closing it puts them back on the trigger rather than at the top again.
   */
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (open) {
      // The first field, not the heading: somebody who opened a form wants to
      // type into it, and the panel's title is announced by the region anyway.
      const first = panelRef.current?.querySelector<HTMLElement>(
        'input, select, textarea',
      );
      first?.focus();
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  async function submit(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setProblem(null);
    setErrors({});
    setPending(null);
    try {
      await api(path, {
        method,
        body: JSON.stringify({ ...(build(values) as object), ...extra }),
      });
      close();
      // The list reloads rather than optimistically appending. What the server
      // stored is the truth — a name it trimmed, a default it filled in — and
      // showing a guess of it teaches people to distrust the screen.
      onCreated();
    } catch (cause) {
      if (cause instanceof ApiError) {
        const ask = confirmable?.(cause.problem) ?? null;
        if (ask) {
          // Deliberately NOT auto-retrying, and deliberately keeping the typed
          // values: the point is that somebody reads the warning and decides.
          setPending(ask);
          setBusy(false);
          return;
        }
      }
      const marked = fieldErrors(cause);
      setErrors(marked);
      // A field-level message is shown against its field. The banner is for
      // everything else, and saying both would say it twice.
      if (Object.keys(marked).length > 0) {
        setProblem(null);
      } else if (cause instanceof ApiError) {
        setProblem(cause.problem.detail ?? cause.problem.title);
      } else {
        setProblem('That could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!controlled && !open) {
    return (
      <div className="mb-4 flex items-center gap-3">
        <Button
          // The page's ONE primary action. Restrained means the accent is
          // spent on the primary action, the current selection and state —
          // and "New user" on the users page is exactly that.
          variant="primary"
          ref={triggerRef}
          aria-expanded={false}
          onClick={() => {
            // Values are taken from `initial` HERE rather than only at mount,
            // so opening the form after a reload shows what is on the row now.
            setValues(initial ?? {});
            setOpen(true);
          }}
          disabled={disabled}
        >
          {submitLabel}
        </Button>
        {disabled && disabledReason && (
          // WHY, next to the control. A disabled button with no explanation is
          // indistinguishable from a broken one.
          <span className="text-muted">{disabledReason}</span>
        )}
      </div>
    );
  }

  return (
    <Panel title={title}>
      <div className="space-y-4 p-4" ref={panelRef}>
        {problem && <Alert tone="danger">{problem}</Alert>}

        {pending && (
          <Alert tone="warning" title="Check this first">
            <div className="space-y-3">
              <div>{pending.message}</div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={busy}
                  onClick={() => void submit(pending.retryWith)}
                >
                  Continue
                </Button>
              </div>
            </div>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">{fields(values, set, errors)}</div>

        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={busy}>
            {submitLabel}
          </Button>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  );
}
