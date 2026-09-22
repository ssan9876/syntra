import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

interface Preview {
  revision: string;
  accounts: { id: string; login: string; status: string; source: { name: string; writebackEnabled: boolean; writebackDisable: boolean } | null }[];
  targets: { id: string; status: string; correlationKey: string; disableDueAt: string | null; archiveDueAt: string | null; target: { name: string; enabled: boolean; disableGraceDays: number; entitlementRevocationDelayDays: number; archiveAfterDays: number | null } }[];
  latestAttempt: { action: string; occurredAt: string } | null;
}
interface Result { userId: string; login: string; status: string; message: string }
interface Outcome {
  results: Result[];
  operationId: string;
  provisionMessage: string | null;
  priority?: string;
  sloDeadlineAt?: string | null;
  approvalRequired?: boolean;
  approvalReason?: string | null;
}

export function EmployeeOffboarding({ personId, personName, onChanged }: { personId: string; personName: string; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setBusy(true);
    void api<Preview>(`/api/admin/persons/${personId}/offboarding`)
      .then((value) => { if (current) { setPreview(value); setProblem(null); } })
      .catch((cause: unknown) => { if (current) setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The offboarding preview could not be loaded.'); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [open, personId]);
  async function finish() {
    if (!preview) return;
    setBusy(true); setProblem(null);
    try {
      const response = await api<Outcome>(`/api/admin/persons/${personId}/offboarding`, { method: 'POST', body: JSON.stringify({ reason, revision: preview.revision, urgent }) });
      setOutcome(response); onChanged();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Employment could not be ended.');
    } finally { setBusy(false); }
  }
  if (!open) return <Button variant="danger" onClick={() => setOpen(true)}>End employment</Button>;
  const results = outcome?.results ?? null;
  return <Panel title={`End employment for ${personName}`}>
    <div className="space-y-4 p-4">
      <Alert tone="warning">This ends employment now, disables linked Syntra sign-ins, revokes sessions, and starts configured target-system leaver work. Failed or delayed target actions remain visible.</Alert>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {preview && !results && <>
        <div><h3 className="font-medium text-ink">Linked sign-ins</h3><ul className="mt-2 space-y-1">{preview.accounts.length ? preview.accounts.map((account) => <li key={account.id}>{account.login} — <Status tone={account.status === 'active' ? 'warning' : 'inactive'}>{account.status}</Status>{account.source && (!account.source.writebackEnabled || !account.source.writebackDisable) ? ` — ${account.source.name} cannot be disabled by Syntra` : ''}</li>) : <li>No linked sign-ins</li>}</ul></div>
        <div><h3 className="font-medium text-ink">Managed target accounts</h3><ul className="mt-2 space-y-1">{preview.targets.length ? preview.targets.map((account) => <li key={account.id}>{account.target.name}: {account.status}; disable grace {account.target.disableGraceDays} day(s), entitlement delay {account.target.entitlementRevocationDelayDays} day(s){account.target.archiveAfterDays === null ? ', no archive scheduled' : `, archive after ${account.target.archiveAfterDays} day(s)`}</li>) : <li>No managed target accounts</li>}</ul></div>
        <Field label="Reason" value={reason} onChange={setReason} />
        <Check label="Urgent departure: apply the urgent service level and escalate if target access is not removed in time" checked={urgent} onChange={setUrgent} />
        <div className="flex gap-2"><Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void finish()}>End employment now</Button><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
      </>}
      {results && outcome && <>
        <Alert tone={results.some((item) => item.status === 'failed') ? 'warning' : 'success'} title="Employment ended">Review every result below. Target-system work may still be pending.</Alert>
        <ul className="space-y-2">{results.map((result) => <li key={result.userId}><strong>{result.login}</strong>: {result.status}. {result.message}</li>)}</ul>
        {outcome.provisionMessage ? <Alert tone="warning">{outcome.provisionMessage}</Alert> : null}
        {outcome.sloDeadlineAt ? <p className="text-sm text-muted">{outcome.priority === 'critical' ? 'Urgent' : 'Standard'} service level: target access is due to be removed by {new Date(outcome.sloDeadlineAt).toLocaleString()}.</p> : null}
        {outcome.approvalRequired ? <Alert tone="info" title="Approval required">{outcome.approvalReason ?? 'A second person must approve the target work.'}</Alert> : null}
        <Link className="underline" to={`/admin/lifecycle-operations/${outcome.operationId}`}>Open offboarding operation</Link>
      </>}
      {busy && !preview && <p>Loading current employee access…</p>}
    </div>
  </Panel>;
}
