import { useState, type ReactNode } from 'react';
import { Alert, Button, Panel } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors } from './hooks.js';

/**
 * The create form the four directory pages share.
 *
 * `Users`, `Groups`, `Org units` and `People` were read-only: the API has had
 * `POST /users`, `/groups`, `/org-units` and `/persons` since Core, and no
 * screen called any of them. The empty states even described the action —
 * "Create a group to grant the same access to several people at once" — while
 * offering no control to do it.
 *
 * One component rather than four hand-written forms, for the reason `Select`
 * is shared: the two controls on the sources page had already drifted from
 * each other when they were copied. Everything that differs between the four
 * is a prop; everything that must not differ — where the error goes, when the
 * button is busy, what happens on success — lives here once.
 *
 * Collapsed by default. These are listing pages first, and a form permanently
 * occupying the top of one pushes the thing you came to read below the fold.
 */
export function CreatePanel({
  title,
  submitLabel,
  fields,
  build,
  path,
  onCreated,
  disabled,
  disabledReason,
}: {
  /** The panel's heading when open, e.g. "New group". */
  title: string;
  submitLabel: string;
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
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const close = () => {
    setOpen(false);
    setValues({});
    setErrors({});
    setProblem(null);
  };

  async function submit() {
    setBusy(true);
    setProblem(null);
    setErrors({});
    try {
      await api(path, { method: 'POST', body: JSON.stringify(build(values)) });
      close();
      // The list reloads rather than optimistically appending. What the server
      // stored is the truth — a name it trimmed, a default it filled in — and
      // showing a guess of it teaches people to distrust the screen.
      onCreated();
    } catch (cause) {
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

  if (!open) {
    return (
      <div className="mb-4 flex items-center gap-3">
        <Button onClick={() => setOpen(true)} disabled={disabled}>
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
      <div className="space-y-4 p-4">
        {problem && <Alert tone="danger">{problem}</Alert>}

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
