import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Dialog, Field, Panel, useToast } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { ApiError, api } from '../../session/api.js';

const REASON_MIN_LENGTH = 10;

/**
 * Deleting a person permanently. Shown only to holders of `person.purge`
 * (the Data deletion role) and only for an inactive person: the server
 * refuses an active one. The full name is typed back and a reason given; the
 * server checks both. A refusal for a stale elevation offers the way to
 * elevate and come back, as the application delete does.
 */
export function PersonDangerZone({
  person,
}: {
  person: { id: string; givenName: string; familyName: string; status: string };
}) {
  const can = useCan();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);

  if (!can('person.purge') || person.status === 'active') return null;

  const name = `${person.givenName} ${person.familyName}`;
  const matches = typed.trim() === name.trim();
  const reasonOk = reason.trim().length >= REASON_MIN_LENGTH;

  function close() {
    setOpen(false);
    setTyped('');
    setReason('');
    setProblem(null);
  }

  async function remove() {
    if (!matches || !reasonOk) return;
    setBusy(true);
    setProblem(null);
    setStepUp(null);
    try {
      await api(`/api/admin/persons/${person.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason.trim(), confirm: typed }),
      });
      toast({ tone: 'success', title: `${name} deleted` });
      // `replace`: Back must not return to a person who no longer exists.
      navigate('/admin/users?tab=people', { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'step-up-required') {
        setOpen(false);
        setStepUp(cause.problem.detail ?? cause.problem.title);
      } else {
        setProblem(
          cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : `${name} was not deleted.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Danger zone">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="max-w-prose">
          <p className="font-medium text-ink">Delete permanently</p>
          <p className="text-sm text-muted">Cannot be undone</p>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete permanently
        </Button>
      </div>

      {problem && !open && (
        <div className="p-4 pt-0">
          <Alert tone="danger">{problem}</Alert>
        </div>
      )}
      {stepUp && (
        <div className="p-4 pt-0">
          <Alert tone="warning" title="Confirm it is you first">
            <p>{stepUp}</p>
            <Button
              type="button"
              onClick={() => navigate('/elevate', { state: { from: location } })}
              className="mt-3"
            >
              Confirm it is you
            </Button>
          </Alert>
        </div>
      )}

      <Dialog
        open={open}
        onClose={close}
        title={`Delete ${name}?`}
        actions={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!matches || !reasonOk}
              onClick={() => void remove()}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink">
          <Alert tone="warning">Cannot be undone.</Alert>
          <p>Removes:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>the person, their contracts and placements</li>
            <li>lifecycle operations, closed privacy cases and target account records</li>
          </ul>
          <p>Linked accounts are unlinked and deactivated. Accounts in target systems are not changed.</p>
          <Field
            name="reason"
            label="Reason"
            value={reason}
            onChange={setReason}
            maxLength={1000}
            warning={
              reason.trim() !== '' && !reasonOk ? `At least ${REASON_MIN_LENGTH} characters` : undefined
            }
          />
          <Field
            name="confirm-delete"
            label={`Type ${name} to confirm`}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            spellCheck={false}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
        </div>
      </Dialog>
    </Panel>
  );
}
