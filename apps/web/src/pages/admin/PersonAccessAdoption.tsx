import { useState } from 'react';
import { Alert, Button, Field } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

/**
 * Adopting the account that caused a conflict.
 *
 * `conflict` means the target refused to create this account because the name
 * was already taken, and nothing clears it: `reconcile` makes the person
 * unprocessable and returns, so every later run stops in the same place
 * whatever is done in the directory.
 *
 * Syntra will not bind to an object it did not create — anybody able to create
 * an object in a target could otherwise choose a name that hands them
 * somebody's account. What stands in for that check here is a person looking at
 * a specific object and saying so, which is why the DN is read and shown before
 * the button does anything.
 */
export function Adoption({
  personId,
  targetSystemId,
  correlationKey,
}: {
  personId: string;
  targetSystemId: string;
  correlationKey: string;
}) {
  const base = `/api/admin/targets/${targetSystemId}/accounts/${personId}`;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Read when the dialog opens, never on page load: it is a live call to the
  // directory, for a control most visits never touch.
  const candidate = useApiResource<{ anchor: string; dn: string }>(
    open ? `${base}/adoption-candidate` : null,
  );
  // The object is not there. WHICH of the two reasons it is not there is the
  // question the administrator is about to answer.
  const invisible = !candidate.loading && !candidate.data && candidate.error !== null;

  async function submit(ifNoCandidate?: 'reset') {
    setBusy(true);
    setProblem(null);
    try {
      await api(`${base}/adopt`, {
        method: 'POST',
        body: JSON.stringify({ reason, ...(ifNoCandidate ? { ifNoCandidate } : {}) }),
      });
      setOpen(false);
      setReason('');
      setDone(
        ifNoCandidate
          ? 'The account will be created again on the next run.'
          : 'Adopted. The next run writes this profile onto it.',
      );
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

  return (
    <div className="border-t border-border-subtle p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted">
          The target already has an account called{' '}
          <code className="font-mono text-sm text-ink">{correlationKey}</code>.
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          Adopt
        </Button>
      </div>

      {done && (
        <div className="mt-3">
          <Alert tone="warning">{done}</Alert>
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {candidate.loading && <span className="text-muted">Reading the target…</span>}
          {candidate.data && (
            <>
              <div className="font-mono text-sm text-ink">{candidate.data.dn}</div>
              <Alert tone="warning">
                From now on Syntra manages this account: it writes this profile&rsquo;s
                attributes onto it, moves it when its org unit changes, and disables and
                archives it when the person leaves.
              </Alert>
            </>
          )}
          {invisible && <Alert tone="danger">{candidate.error}</Alert>}
          {problem && <Alert tone="danger">{problem}</Alert>}
          <Field label="Why" value={reason} onChange={setReason} required />
          <div className="flex gap-2">
            {candidate.data && (
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={reason.trim() === ''}
                onClick={() => submit()}
              >
                Adopt this account
              </Button>
            )}
            {/*
              Secondary, and only when the object is not there. The
              administrator is answering something Syntra cannot work out — an
              object outside the base DN and a deleted one look identical from
              here — and the wrong answer recreates this conflict for ever.
            */}
            {invisible && (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                disabled={reason.trim() === ''}
                onClick={() => submit('reset')}
              >
                Create it again
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
