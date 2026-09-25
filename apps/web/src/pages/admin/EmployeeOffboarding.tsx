import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, SkeletonRows, StateBadge, Table, type State } from '@syntra/ui';
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

/**
 * Target account states in the agreed status language. "Active" on somebody
 * leaving is the thing to notice, so it is `attention`, not `healthy`.
 */
const ACCOUNT_STATE: Record<string, { state: State; label: string }> = {
  active: { state: 'attention', label: 'Active' },
  pending: { state: 'pending', label: 'Pending' },
  conflict: { state: 'blocked', label: 'Conflict' },
  disabled: { state: 'inactive', label: 'Disabled' },
  archived: { state: 'inactive', label: 'Archived' },
};

function AccountState({ status }: { status: string }) {
  const known = ACCOUNT_STATE[status];
  return known ? <StateBadge state={known.state}>{known.label}</StateBadge> : <StateBadge state="attention">{status}</StateBadge>;
}

function ResultState({ status }: { status: string }) {
  if (status === 'failed') return <StateBadge state="blocked">Failed</StateBadge>;
  if (status === 'disabled' || status === 'inactive') return <StateBadge state="healthy">Disabled</StateBadge>;
  return <StateBadge state="pending">{status}</StateBadge>;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

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
        {/* Two tables rather than two sentences per row: a departure is read
            as "what is still live", and a status column scans for it where a
            run-on line of semicolons did not. */}
        <Table tight label="Linked sign-ins">
          <thead><tr><th scope="col">Linked sign-in</th><th scope="col">State</th><th scope="col">Directory write-back</th></tr></thead>
          <tbody>
            {preview.accounts.length ? preview.accounts.map((account) => {
              const manual = account.source && (!account.source.writebackEnabled || !account.source.writebackDisable);
              return <tr key={account.id}>
                <th scope="row" className="font-medium text-ink">{account.login}</th>
                <td><AccountState status={account.status} /></td>
                <td>{manual ? <StateBadge state="attention">Manual: {account.source!.name} cannot be disabled by Syntra</StateBadge> : account.source ? account.source.name : '—'}</td>
              </tr>;
            }) : <tr><td colSpan={3} className="text-muted">No linked sign-ins</td></tr>}
          </tbody>
        </Table>
        <Table tight label="Managed target accounts">
          <thead><tr><th scope="col">Target account</th><th scope="col">State</th><th scope="col">Disable after</th><th scope="col">Entitlements removed after</th><th scope="col">Archive</th></tr></thead>
          <tbody>
            {preview.targets.length ? preview.targets.map((account) => <tr key={account.id}>
              <th scope="row" className="font-medium text-ink">{account.target.name}</th>
              <td><AccountState status={account.status} /></td>
              <td>{days(account.target.disableGraceDays)}</td>
              <td>{days(account.target.entitlementRevocationDelayDays)}</td>
              <td>{account.target.archiveAfterDays === null ? 'Not scheduled' : `After ${days(account.target.archiveAfterDays)}`}</td>
            </tr>) : <tr><td colSpan={5} className="text-muted">No managed target accounts</td></tr>}
          </tbody>
        </Table>
        <Field label="Reason" value={reason} onChange={setReason} />
        <Check label="Urgent departure: apply the urgent service level and escalate if target access is not removed in time" checked={urgent} onChange={setUrgent} />
        <div className="flex gap-2"><Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void finish()}>End employment now</Button><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button></div>
      </>}
      {results && outcome && <>
        <Alert tone={results.some((item) => item.status === 'failed') ? 'warning' : 'success'} title="Employment ended">Review every result below. Target-system work may still be pending.</Alert>
        <Table tight label="Sign-in results">
          <thead><tr><th scope="col">Sign-in</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody aria-live="polite">
            {results.map((result) => <tr key={result.userId}>
              <th scope="row" className="font-medium text-ink">{result.login}</th>
              <td><ResultState status={result.status} /></td>
              <td>{result.message}</td>
            </tr>)}
          </tbody>
        </Table>
        {outcome.provisionMessage ? <Alert tone="warning">{outcome.provisionMessage}</Alert> : null}
        {outcome.sloDeadlineAt ? <dl className="text-sm"><dt className="font-medium text-muted">{outcome.priority === 'critical' ? 'Urgent' : 'Standard'} service level · target access removed by</dt><dd className="mt-0.5 font-medium text-ink">{new Date(outcome.sloDeadlineAt).toLocaleString()}</dd></dl> : null}
        {outcome.approvalRequired ? <Alert tone="info" title="Approval required">{outcome.approvalReason ?? 'A second person must approve the target work.'}</Alert> : null}
        <Link className="link" to={`/admin/lifecycle-operations/${outcome.operationId}`}>Open offboarding operation</Link>
      </>}
      {busy && !preview && <SkeletonRows rows={3} cols={3} />}
    </div>
  </Panel>;
}
