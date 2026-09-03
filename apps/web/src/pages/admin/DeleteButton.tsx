import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * The one control in this console that destroys something.
 *
 * Everything else in the directory deactivates, and `StatusToggle` explains at
 * length why. This exists for the case that rule does not cover: an account or
 * a container that should not merely stop granting access but stop being
 * there — and which, left deactivated, the directory keeps returning on every
 * sync run for ever.
 *
 * The name is typed rather than the button clicked twice, and the difference
 * is the point. A second click is not a second decision; it is the same one,
 * reflexively, a few hundred milliseconds later. Typing the login or the unit
 * name requires reading which row this is, which is exactly the check that
 * fails when somebody deletes the wrong one.
 *
 * The match is exact rather than a prefix, and what was typed is discarded on
 * cancel — otherwise reopening the confirmation finds it already satisfied,
 * leaving one click between a stray reopen and a destroyed account.
 */
export function DeleteButton({
  path,
  label,
  confirmWord,
  warning,
  onDeleted,
}: {
  /** e.g. `/api/admin/users/<id>` */
  path: string;
  /** What is being deleted, for the confirming button: "user", "org unit". */
  label: string;
  /** The login or name the reader must type. */
  confirmWord: string;
  /** What this will do, said before it is done. */
  warning: string;
  onDeleted(): void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const close = () => {
    restoreFocus.current = true;
    setOpen(false);
    setTyped('');
    setProblem(null);
  };

  /**
   * Focus follows the confirmation, in both directions.
   *
   * Pressing Delete unmounts the button that was pressed, and a browser drops
   * focus from a removed element to `<body>`. For a DESTRUCTIVE action that
   * meant a keyboard reader heard nothing, then had to tab the length of the
   * page to reach the confirmation field for the thing they had just asked to
   * delete. Cancelling puts them back on the row they were on.
   */
  const confirmRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (open) {
      confirmRef.current?.focus();
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  async function remove() {
    setBusy(true);
    setProblem(null);
    try {
      await api(path, { method: 'DELETE' });
      close();
      onDeleted();
    } catch (cause) {
      // THE SERVER'S OWN SENTENCE WINS. It knows why — a source not allowed
      // deletion, a unit that still holds people, a bind without the right —
      // and flattening those to "could not be deleted" sends the reader
      // looking for a permission that was never the problem.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : `That ${label} could not be deleted.`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      // `danger-quiet`, not `danger`. A filled red button repeated on every
      // row of a table is a table that looks like a hazard; the filled one is
      // spent on the control that actually does it.
      <Button
        size="sm"
        variant="danger-quiet"
        ref={triggerRef}
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Alert tone="danger" title={`Delete this ${label}?`}>
        {warning}
      </Alert>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Field
        label={`To confirm, type ${confirmWord}`}
        value={typed}
        onChange={setTyped}
        ref={confirmRef}
      />
      <div className="flex gap-2">
        <Button
          variant="danger"
          disabled={typed !== confirmWord || busy}
          loading={busy}
          onClick={() => void remove()}
        >
          Delete {label}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={close}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
