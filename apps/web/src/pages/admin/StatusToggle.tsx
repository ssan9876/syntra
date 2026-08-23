import { useState } from 'react';
import { Alert, Button } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * Deactivate and reactivate, for the three things that carry a status.
 *
 * DELETE IS NOT AN OPTION ANYWHERE IN THIS PRODUCT, and this control is why.
 * Deleting a group revokes access from everybody in it and takes the record of
 * who had what with it; deleting a user destroys the trail of what they held.
 * A deactivated row is still listed, still shows its members, and grants
 * nothing — and it can come back. The specs say it in as many words:
 * "Deactivation never deletes."
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

  async function run(verb: 'deactivate' | 'reactivate') {
    // The reason is collected BEFORE anything is sent, and an empty one
    // abandons the whole action rather than sending a blank the server will
    // reject — a refusal after the fact reads as a bug in the button.
    let reason: string | null = null;
    if (verb === 'deactivate') {
      reason = window.prompt(reasonPrompt);
      if (reason === null || reason.trim() === '') return;
    }

    setBusy(true);
    setProblem(null);
    try {
      await api(`${basePath}/${verb}`, {
        method: 'POST',
        body: JSON.stringify(reason === null ? {} : { reason }),
      });
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

  return (
    <>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        size="sm"
        variant={active ? 'danger' : 'secondary'}
        loading={busy}
        disabled={busy}
        onClick={() => void run(active ? 'deactivate' : 'reactivate')}
      >
        {/* Named for what it DOES. "Delete" would be a lie, and "disable" is
            a different word for the same thing in a product whose specs,
            columns and sync changes all say deactivate. */}
        {active ? 'Deactivate' : 'Reactivate'}
      </Button>
    </>
  );
}
