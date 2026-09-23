import { useState } from 'react';
import { Alert, Button, Field, Panel, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import type { Target } from './target-form.js';

function problem(error: unknown) {
  return error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : error instanceof Error ? error.message : 'The external-write control could not be changed.';
}

export function TargetWriteStopPanel({ target, onChanged }: { target: Target; onChanged(): void }) {
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const active = target.externalWritesPausedAt != null &&
    (target.externalWritesPauseExpiresAt == null || new Date(target.externalWritesPauseExpiresAt) > new Date());
  const submit = async (path: string, body: unknown) => {
    setBusy(true); setNotice('');
    try {
      await api(`/api/admin/targets/${target.id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setReason(''); setExpiresAt(''); onChanged();
    } catch (error) { setNotice(problem(error)); }
    finally { setBusy(false); }
  };
  return <Panel title="External writes" actions={<Status tone={active ? 'danger' : 'active'}>{active ? 'paused' : 'allowed'}</Status>}>
    <div className="space-y-4 p-4">
      {active ? <Alert tone="danger" title="Provisioning writes are stopped">
        {target.externalWritesPauseReason ?? 'Emergency stop'} · paused {new Date(target.externalWritesPausedAt!).toLocaleString()}
        {target.externalWritesPauseExpiresAt ? ` · expires ${new Date(target.externalWritesPauseExpiresAt).toLocaleString()}` : ' · no automatic expiry'}
      </Alert> : null}
      {notice ? <Alert tone="warning">{notice}</Alert> : null}
      <Field label={active ? 'Reason for resuming' : 'Reason for stopping writes'} value={reason} onChange={setReason} />
      {!active ? <Field label="Automatic expiry (optional, maximum 30 days)" type="datetime-local" value={expiresAt} onChange={setExpiresAt} /> : null}
      {active
        ? <Button loading={busy} disabled={!reason.trim()} onClick={() => void submit('external-write-resume', { reason })}>Request reviewed resume</Button>
        : <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void submit('external-write-stop', { reason, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null })}>Stop external writes</Button>}
      {active ? <p className="text-sm text-muted">A different administrator must approve the resume. Reads, previews, and evidence remain available.</p> : null}
    </div>
  </Panel>;
}
