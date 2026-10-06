import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Dialog } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

export interface RestoreHoldStatus {
  hold: {
    backupName: string;
    backupTakenAt: string | null;
    backupVersion: string | null;
    restoredAt: string;
  } | null;
  mayResume: boolean;
}

const POLL_MS = 60_000;

/**
 * Shown on every console page while a restore has not been resumed. Background
 * work and writes to target systems are paused for the whole installation, so
 * every administrator sees why; only a `deployment.manage` holder is offered
 * the button.
 */
export function RestoreHoldBanner() {
  const [status, setStatus] = useState<RestoreHoldStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<RestoreHoldStatus>('/api/admin/restore-hold')
        .then(setStatus)
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/restore-hold/resume', { method: 'POST' });
      setConfirming(false);
      await load();
    } catch (cause) {
      // Somebody else resumed it first: the outcome they wanted.
      if (cause instanceof ApiError && cause.kind === 'not-held') {
        setConfirming(false);
        await load();
      } else {
        setError(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Resume failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  const hold = status?.hold;
  if (!hold) return null;

  const taken = hold.backupTakenAt ? `, taken ${new Date(hold.backupTakenAt).toLocaleString()}` : '';

  return (
    <div className="mb-4">
      <Alert tone="warning" title="Background work paused after restore">
        Restored from <span className="font-mono">{hold.backupName}</span>
        {taken}. Scheduled runs, queued jobs and writes to target systems wait until resumed.
        {status.mayResume ? (
          <div className="mt-3">
            <Button size="sm" onClick={() => setConfirming(true)}>
              Resume
            </Button>
          </div>
        ) : null}
      </Alert>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Resume background work?"
        actions={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void resume()}>
              Resume
            </Button>
          </>
        }
      >
        <p>Scheduled runs and queued jobs start, and target systems accept writes again, in every tenant.</p>
        {error ? (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
