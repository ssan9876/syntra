import { useState } from 'react';
import { Alert, Button, Field, Panel, StateBadge, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';

function problem(error: unknown) {
  return error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : error instanceof Error ? error.message : 'The external-write control could not be changed.';
}

export interface WriteStopState {
  pausedAt: string | null;
  pauseReason: string | null;
  pauseExpiresAt: string | null;
}

/**
 * Whether a stop is in force, judged the way the server judges it: placed, and
 * either no expiry or an expiry still in the future. An expired stop the sweep
 * has not closed yet is already not refusing anything, so it must not look as
 * if it were.
 */
export function writeStopActive(state: WriteStopState): boolean {
  return state.pausedAt != null && (state.pauseExpiresAt == null || new Date(state.pauseExpiresAt) > new Date());
}

/**
 * The emergency-stop control, for either scope.
 *
 * One component for the target and the tenant stop, because the two have the
 * same rules -- mandatory reason, optional expiry of at most 30 days, reviewed
 * resume by a different administrator -- and an operator reaching for one in
 * an incident should find exactly the control they already know.
 */
export function ExternalWriteStopPanel({
  title,
  stoppedTitle,
  state,
  basePath,
  onChanged,
}: {
  title: string;
  /** What the danger alert says while the stop is active. */
  stoppedTitle: string;
  state: WriteStopState;
  /** The route prefix; `external-write-stop` and `external-write-resume` are appended. */
  basePath: string;
  onChanged(): void;
}) {
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // The stop form is an emergency control: one button until somebody reaches
  // for it, not two empty fields on every visit to the page.
  const [stopping, setStopping] = useState(false);
  const active = writeStopActive(state);
  const submit = async (path: string, body: unknown) => {
    setBusy(true); setNotice('');
    try {
      await api(`${basePath}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setReason(''); setExpiresAt(''); setStopping(false); onChanged();
    } catch (error) { setNotice(problem(error)); }
    finally { setBusy(false); }
  };
  return <Panel title={title} actions={active ? <StateBadge state="blocked">Paused</StateBadge> : <StateBadge state="healthy">Allowed</StateBadge>}>
    <div className="space-y-4 p-4">
      {active ? <Alert tone="danger" title={stoppedTitle}>
        {state.pauseReason ?? 'Emergency stop'} · paused {new Date(state.pausedAt!).toLocaleString()}
        {state.pauseExpiresAt ? ` · expires ${new Date(state.pauseExpiresAt).toLocaleString()}` : ' · no automatic expiry'}
      </Alert> : null}
      <div aria-live="polite">{notice ? <Alert tone="warning">{notice}</Alert> : null}</div>
      {active
        ? <div className="max-w-xl space-y-3">
          <Field name="reason" label="Reason for resuming" value={reason} onChange={setReason} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button loading={busy} disabled={!reason.trim()} onClick={() => void submit('external-write-resume', { reason })}>Request reviewed resume</Button>
            <Status tone="neutral">Needs another administrator</Status>
          </div>
        </div>
        // One press, deliberately, where every other destructive control in
        // the console takes two: this is the incident button, and the
        // mandatory reason is the second decision. What it gets instead is a
        // boundary of its own in the danger colour, so it never reads as one
        // more field in a settings panel.
        : !stopping
        ? <Button variant="danger-quiet" onClick={() => setStopping(true)}>Stop writes</Button>
        : <div role="group" aria-label="Stop external writes" className="max-w-xl space-y-3 rounded-panel border border-danger/40 p-3">
          <Field name="reason" label="Reason for stopping writes" value={reason} onChange={setReason} />
          <Field name="expiresAt" label="Automatic expiry (optional, maximum 30 days)" type="datetime-local" value={expiresAt} onChange={setExpiresAt} />
          <div className="border-t border-border-subtle pt-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void submit('external-write-stop', { reason, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null })}>Stop external writes</Button>
              <Button variant="secondary" disabled={busy} onClick={() => { setStopping(false); setReason(''); setExpiresAt(''); }}>Cancel</Button>
            </div>
          </div>
        </div>}
    </div>
  </Panel>;
}
