import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * Cooperative cancellation, as the three run pages (directory sync, HR import,
 * provisioning) show it. One component so the three say the same thing: the
 * server's model is shared (`jobs/cancellation.ts`), and a console that
 * described it three ways would teach three different expectations.
 */

export type CancelState = 'requested' | 'cancelled' | 'moot' | null;

export interface CancellableRun {
  status: string;
  cancelState?: CancelState;
}

/**
 * Whether a run still has anything to cancel. Mirrors the server's policy:
 * anything not yet finished. The server is the authority — a stale page that
 * offers the button gets a 409 with the reason, which this shows.
 */
export function isCancellable(run: CancellableRun, cancellable: readonly string[]): boolean {
  return run.cancelState !== 'requested' && cancellable.includes(run.status);
}

/** A run whose worker has been asked to stop and has not yet reached a checkpoint. */
export const cancelPending = (run: CancellableRun) => run.cancelState === 'requested';

/**
 * The Cancel control and its confirmation.
 *
 * Confirmed inline rather than with `window.confirm`, for the reason the sync
 * page gives for its threshold tick: a native dialog is dismissed reflexively
 * and says nothing about consequences. The confirmation says what stopping
 * means for THIS run — a working run stops at its next checkpoint, keeping
 * everything it already did; a waiting one is discarded outright.
 *
 * Focus follows the confirmation both ways, as `DeleteButton` does: opening
 * moves focus to the confirming button, and backing out returns it.
 */
export function CancelRunButton({
  path,
  run,
  working,
  noun,
  onChanged,
}: {
  /** e.g. `/api/admin/sync-runs/<id>/cancel` */
  path: string;
  run: CancellableRun;
  /** Statuses in which a worker is active, so a request waits for a checkpoint. */
  working: readonly string[];
  /** "sync run", "import run", "provisioning run". */
  noun: string;
  onChanged(): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
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

  const close = () => {
    restoreFocus.current = true;
    setOpen(false);
    setProblem(null);
  };

  async function cancel() {
    setBusy(true);
    setProblem(null);
    try {
      await api(path, { method: 'POST', body: JSON.stringify({}) });
      setOpen(false);
      onChanged();
    } catch (cause) {
      // The server's sentence wins: "already finished" is the common answer,
      // and it is a fact about the run, not a failure of the button.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : `The ${noun} could not be cancelled.`,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="danger-quiet"
        ref={triggerRef}
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        Cancel run
      </Button>
    );
  }

  const isWorking = working.includes(run.status);
  return (
    <div className="w-full space-y-2 sm:max-w-md">
      <Alert tone="danger" title={`Cancel this ${noun}?`}>
        {isWorking
          ? `It stops at its next checkpoint — between two items, never in the middle of one. Everything it has already done stays done and recorded; nothing after that point is attempted.`
          : `Nothing is working on it yet, so it is cancelled now. What it proposed will not be applied; the next run proposes whatever is still needed.`}
      </Alert>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          ref={confirmRef}
          loading={busy}
          disabled={busy}
          onClick={() => void cancel()}
        >
          Cancel this {noun}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={close}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * Where a cancellation stands, said in the page body and announced politely.
 *
 * `role="status"` around the alert, so a screen reader hears the change from
 * "requested" to "cancelled" as the page polls, without it interrupting.
 */
export function CancellationStatus({
  run,
  noun,
}: {
  run: CancellableRun & {
    cancelRequestedAt?: string | null;
    cancelResolvedAt?: string | null;
  };
  noun: string;
}) {
  let body: ReactNode = null;
  if (run.cancelState === 'requested') {
    body = (
      <Alert tone="warning" title="Cancellation requested">
        This {noun} stops at its next checkpoint. The item in progress finishes
        first, so nothing is left half-written. This page follows it.
      </Alert>
    );
  } else if (run.status === 'cancelled') {
    body = (
      <Alert tone="info" title={`This ${noun} was cancelled`}>
        Everything below marked applied was done before it stopped and stays
        done. Anything it did not reach is marked as not attempted and can be
        picked up by the next run.
      </Alert>
    );
  } else if (run.cancelState === 'moot') {
    body = (
      <Alert tone="info" title="Cancellation arrived too late">
        A cancellation was requested, but the {noun} finished before it
        reached another checkpoint, so it ended normally.
      </Alert>
    );
  }
  return <div role="status" aria-live="polite">{body}</div>;
}
