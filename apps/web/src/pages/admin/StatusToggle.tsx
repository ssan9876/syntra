import { useState } from 'react';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * Deactivate and reactivate, for the four things that carry a status.
 *
 * THE DEFAULT EVERYWHERE, and this control is why. Deleting a group revokes
 * access from everybody in it and takes the record of who had what with it;
 * deleting a user destroys the trail of what they held; deleting an org unit
 * does both and orphans any administrative role scoped to it. A deactivated
 * row is still listed, still shows its members, and grants nothing — and it
 * can come back.
 *
 * `DeleteButton` is the deliberate exception, added for the case this does not
 * cover: an account or container that should stop EXISTING rather than stop
 * granting, and which a directory otherwise hands back on every sync run for
 * ever. It is gated on a permission of its own, a per-source flag of its own,
 * and typing the row's name — three doors, because unlike this control it
 * cannot be undone by pressing the other button. Deactivation remains the
 * default and the one offered first.
 *
 * The reason is REQUIRED, and mandatory in the schema rather than merely asked
 * for here. A deactivation with no reason is a row that says access was taken
 * away and will not say why, which is precisely the question asked six months
 * later when nobody remembers.
 */
export function StatusToggle({
  active,
  basePath,
  label,
  reasonPrompt,
  onChanged,
}: {
  active: boolean;
  /** e.g. `/api/admin/groups/<id>` — this appends the verb. */
  basePath: string;
  /** What is being deactivated, for the confirmation: "group", "person". */
  label: string;
  reasonPrompt: string;
  onChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The reason box, open or not.
   *
   * IN THE PAGE, not `window.prompt`. A native dialog blocks the whole tab
   * while it is open, cannot be styled or validated as you type, and — the
   * reason it had to go — a browser that has been told to "prevent this page
   * from creating additional dialogs" returns null from every later call. The
   * button would then do nothing, for ever, with no error and nothing on
   * screen to explain it.
   */
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  async function send(verb: 'deactivate' | 'reactivate', body: object) {
    setBusy(true);
    setProblem(null);
    try {
      await api(`${basePath}/${verb}`, { method: 'POST', body: JSON.stringify(body) });
      setAsking(false);
      setReason('');
      onChanged();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : `That ${label} could not be changed.`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (asking) {
    return (
      // Sized to the space it is given, never wider. Two of the four pages
      // that use this are TABLES, and a fixed width here pushed the last
      // column past the viewport and put a horizontal scrollbar on the page.
      <div className="flex w-full flex-col items-stretch gap-2 text-left">
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Field
          label="Reason"
          value={reason}
          onChange={setReason}
          hint={reasonPrompt}
        />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            // Nothing is sent until there is a reason. Posting a blank and
            // letting the server refuse it reads as a broken button.
            disabled={busy || reason.trim() === ''}
            onClick={() => void send('deactivate', { reason: reason.trim() })}
          >
            Deactivate
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setAsking(false);
              setReason('');
              setProblem(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        size="sm"
        // Quiet here, filled inside the reason form. This button opens the
        // decision; the one down there takes it.
        variant={active ? 'danger-quiet' : 'secondary'}
        loading={busy}
        disabled={busy}
        onClick={() =>
          active ? setAsking(true) : void send('reactivate', {})
        }
      >
        {/* Named for what it DOES. "Delete" would be a lie, and "disable" is
            a different word for the same thing in a product whose specs,
            columns and sync changes all say deactivate. */}
        {active ? 'Deactivate' : 'Reactivate'}
      </Button>
    </>
  );
}
