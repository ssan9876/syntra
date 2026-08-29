import { useState } from 'react';
import { Alert, Button, Field, Select, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface Placement {
  container: string;
  reason: string;
  updatedAt: string;
}

/**
 * Where this account sits, and the control that changes it.
 *
 * Two states rather than one form. Following the rule is the ordinary case and
 * shows nothing but a Move button; being pinned is a standing disagreement
 * with the placement rule, and shows what it is and who said why — because
 * that is the only question anybody asks about an account that is not where
 * the rule puts it.
 *
 * The container list is read from the TARGET, on demand, and only when the
 * move form is open. Provision creates no containers, so this is the closed
 * set an account may go to; reading it up front would be a live call to every
 * target on every page load, for a control most visits never touch.
 */
export function Placement({
  personId,
  targetSystemId,
  targetName,
}: {
  personId: string;
  targetSystemId: string;
  targetName: string;
}) {
  const base = `/api/admin/targets/${targetSystemId}/placements/${personId}`;
  const { data, reload } = useApiResource<{ placement: Placement | null }>(base);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const containers = useApiResource<{ containers: string[] }>(
    open ? `/api/admin/targets/${targetSystemId}/containers` : null,
  );
  const placement = data?.placement ?? null;

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api<{ moved: boolean; message: string }>(base, {
        method: 'PUT',
        body: JSON.stringify({ container, reason }),
      });
      setOpen(false);
      setReason('');
      // A directory write that did not land is not a failed request: the
      // decision is recorded and the next run retries it. Saying so is more
      // useful than an error the administrator reads as "nothing happened".
      setNote(result.moved ? null : result.message);
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    setBusy(true);
    setProblem(null);
    try {
      await api(base, { method: 'DELETE' });
      // Nothing moves now. The next run computes the rule's answer and
      // proposes the move, in a plan somebody reviews.
      setNote(`${targetName} will move this account back to where the rule puts it on its next run.`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border-subtle p-4">
      {placement === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted">Placed by the rule.</span>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            Move
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Status tone="warning">Moved by hand</Status>
          <span className="font-mono text-sm text-ink">{placement.container}</span>
          <span className="text-sm text-muted">{placement.reason}</span>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            Move again
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={follow}>
            Follow the rule
          </Button>
        </div>
      )}

      {note && (
        <div className="mt-3">
          <Alert tone="warning">{note}</Alert>
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {containers.error && <Alert tone="danger">{containers.error}</Alert>}
          <Select
            label="Container"
            value={container}
            onChange={setContainer}
            disabled={containers.loading}
            options={[
              { value: '', label: containers.loading ? 'Reading the target…' : 'Choose one' },
              ...(containers.data?.containers ?? []).map((dn) => ({ value: dn, label: dn })),
            ]}
          />
          <Field label="Why" value={reason} onChange={setReason} required />
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={container === '' || reason.trim() === ''}
              onClick={submit}
            >
              Move
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
