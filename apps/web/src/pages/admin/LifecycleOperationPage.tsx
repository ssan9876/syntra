import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, Select, Status, Table } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageFacts, PageHeader } from './PageHeader.js';

interface TargetState { accountPresent: boolean; enabled: boolean; entitlements: string[] }
interface Observation {
  id: string; matches: boolean; completeness: string; observedAt: string;
  expected: TargetState; observed: TargetState | null;
  differences: { path: string; expected: unknown; observed: unknown }[];
}
interface Attempt {
  id: string; attempt: number; status: string; message: string | null; responseCategory: string | null;
  startedAt: string | null; completedAt: string | null; recordedAt: string; evidence: unknown;
}
interface Step {
  id: string; key: string; title: string; status: string; message: string | null; responseCategory: string | null;
  startedAt: string | null; completedAt: string | null; evidence: unknown;
  observations?: Observation[]; attempts?: Attempt[];
}
interface Operation {
  id: string; personId: string | null; personName: string | null; kind: string; status: string; attempt: number;
  ownerUserId: string | null; ownerName: string | null; priority: string; dueAt: string | null; acknowledgedAt: string | null;
  approvalRequired: boolean; approvalReason: string | null; requestedByName: string | null;
  approvedAt: string | null; approvedByName: string | null; rejectedAt: string | null; rejectedByName: string | null; rejectionReason: string | null;
  sloMinutes: number | null; sloDeadlineAt: string | null; sloBreachedAt: string | null;
  escalatedAt: string | null; escalatedToName: string | null; overdueReason: string | null;
  caseStatus: string; resolvedAt: string | null; resolvedByName: string | null;
  resolutionCode: string | null; resolutionSummary: string | null; caseEvents: CaseEvent[];
  createdAt: string; completedAt: string | null;
  steps: Step[];
}
interface Delivery {
  id: string; template: string; to: string; attempts: number; lastError: string | null; sentAt: string | null; createdAt: string;
}
interface LegalHold {
  id: string; reference: string; reason: string; placedAt: string; releasedAt: string | null;
}
interface CaseEvent {
  id: string; kind: string; actorName: string | null; message: string | null; metadata: Record<string, unknown>; createdAt: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  confirmed: 'Confirmed by read-back',
  read_back_incomplete: 'Read-back incomplete — manual verification',
  transient: 'Target unavailable (retried)',
  throttled: 'Target throttled (retry scheduled)',
  unauthorized: 'Credential or consent refused — not retried',
  not_found: 'Target object missing — manual work',
  conflict: 'Conflict at the target',
  rejected: 'Rejected by the target',
  blocked: 'Blocked by a safety guard',
  unavailable: 'Not attempted or not answered',
  no_change_required: 'No change was required',
};

function when(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

function stateSummary(state: TargetState | null) {
  if (!state) return 'No state was recorded.';
  return `Account ${state.accountPresent ? 'present' : 'absent'} · ${state.enabled ? 'enabled' : 'disabled'} · ${state.entitlements.length ? state.entitlements.join(', ') : 'no entitlements'}`;
}

function tone(status: string): 'active' | 'danger' | 'warning' | 'inactive' | 'neutral' | 'primary' {
  if (status === 'completed' || status === 'succeeded') return 'active';
  if (status === 'failed' || status === 'rejected' || status === 'abandoned') return 'danger';
  if (status === 'awaiting_approval') return 'primary';
  if (status === 'cancelled' || status === 'skipped') return 'inactive';
  if (status === 'manual') return 'warning';
  return 'warning';
}

function problemText(error: unknown, fallback: string) {
  return error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : error instanceof Error ? error.message : fallback;
}

function ObservationForm({ operationId, step, onDone }: { operationId: string; step: Step; onDone(message: string): void }) {
  const latest = step.observations?.[0];
  const [present, setPresent] = useState(latest?.observed?.accountPresent ?? true);
  const [enabled, setEnabled] = useState(latest?.observed?.enabled ?? true);
  const [entitlements, setEntitlements] = useState((latest?.observed?.entitlements ?? []).join(', '));
  const [expectedPresent, setExpectedPresent] = useState(latest?.expected.accountPresent ?? true);
  const [expectedEnabled, setExpectedEnabled] = useState(latest?.expected.enabled ?? true);
  const [expectedEntitlements, setExpectedEntitlements] = useState((latest?.expected.entitlements ?? []).join(', '));
  const [complete, setComplete] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const split = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/lifecycle-operations/${operationId}/observations`, {
        method: 'POST',
        body: JSON.stringify({
          stepKey: step.key,
          expected: { accountPresent: expectedPresent, enabled: expectedEnabled, attributes: {}, entitlements: split(expectedEntitlements) },
          observed: { accountPresent: present, enabled, attributes: {}, entitlements: split(entitlements), complete },
          manualConfirmation: confirm,
        }),
      });
      onDone('Observation recorded.');
    } catch (error) {
      onDone(problemText(error, 'The observation could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mt-3 space-y-3 rounded border border-border-subtle p-3" aria-label={`Record observed state for ${step.title}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="text-sm text-muted">Record what you saw at the target. A match completes the step; a confirmed mismatch or an incomplete read leaves it for a person and keeps the evidence.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="space-y-2"><legend className="font-medium text-ink">Expected</legend>
          <Check label="Account should exist" checked={expectedPresent} onChange={setExpectedPresent} />
          <Check label="Account should be enabled" checked={expectedEnabled} onChange={setExpectedEnabled} />
          <Field label="Expected entitlement IDs" value={expectedEntitlements} onChange={setExpectedEntitlements} placeholder="comma separated" />
        </fieldset>
        <fieldset className="space-y-2"><legend className="font-medium text-ink">Observed</legend>
          <Check label="Account exists" checked={present} onChange={setPresent} />
          <Check label="Account is enabled" checked={enabled} onChange={setEnabled} />
          <Field label="Observed entitlement IDs" value={entitlements} onChange={setEntitlements} placeholder="comma separated" />
        </fieldset>
      </div>
      <Check label="I could read the whole state (uncheck if the read was partial)" checked={complete} onChange={setComplete} />
      <Check label="Confirm this state by hand even if it differs from what was expected" checked={confirm} onChange={setConfirm} />
      <Button type="submit" loading={busy}>Record observation</Button>
    </form>
  );
}

const RESOLUTION_OPTIONS = [
  { value: 'recovered', label: 'Recovered after retry' },
  { value: 'manually_verified', label: 'Manually verified' },
  { value: 'configuration_corrected', label: 'Configuration corrected' },
  { value: 'accepted_risk', label: 'Accepted risk' },
  { value: 'duplicate', label: 'Duplicate work' },
  { value: 'cancelled', label: 'Cancelled' },
];

function CaseHistoryPanel({ operation, onChanged }: { operation: Operation; onChanged(message: string): void }) {
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('recovered');
  const [busy, setBusy] = useState(false);
  const submit = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    try {
      await api(`/api/admin/lifecycle-operations/${operation.id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setMessage('');
      onChanged(done);
    } catch (error) {
      onChanged(problemText(error, 'The case update could not be saved.'));
    } finally { setBusy(false); }
  };
  const events = operation.caseEvents ?? [];
  const resolved = operation.caseStatus === 'resolved';
  return <Panel title="Case history" actions={<Status tone={resolved ? 'active' : 'warning'}>{resolved ? 'resolved' : 'open'}</Status>}>
    <div className="space-y-4 p-4">
      {resolved ? <Alert tone="info" title={`${operation.resolutionCode?.replaceAll('_', ' ') ?? 'Resolved'} · ${when(operation.resolvedAt)}`}>
        {operation.resolutionSummary} {operation.resolvedByName ? `— ${operation.resolvedByName}` : ''}
      </Alert> : null}
      {events.length ? <Table tight><thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Operator</th><th scope="col">Details</th></tr></thead><tbody aria-live="polite">
        {events.map((event) => <tr key={event.id}><td>{when(event.createdAt)}</td><td><Status tone={event.kind === 'resolution' ? 'active' : event.kind === 'reopened' ? 'warning' : 'neutral'}>{event.kind}</Status></td><td>{event.actorName ?? 'System'}</td><td>{event.message ?? (event.kind === 'assignment' ? `Owner or due date updated` : '—')}</td></tr>)}
      </tbody></Table> : <p className="text-sm text-muted">No case activity has been recorded yet.</p>}
      <form className="grid gap-3 sm:grid-cols-[minmax(18rem,1fr)_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void submit('case-notes', { message }, 'Case note saved.'); }}>
        <Field label="Add an escalation or investigation note" value={message} onChange={setMessage} />
        <Button type="submit" variant="secondary" loading={busy} disabled={!message.trim()}>Add note</Button>
      </form>
      {resolved ? <Button variant="secondary" loading={busy} disabled={!message.trim()} onClick={() => void submit('reopen', { reason: message }, 'Case reopened.')}>Reopen with note</Button> : <div className="grid gap-3 sm:grid-cols-[minmax(14rem,0.5fr)_minmax(18rem,1fr)_auto] sm:items-end">
        <Select label="Resolution" value={code} onChange={setCode} options={RESOLUTION_OPTIONS} />
        <Field label="Resolution summary" value={message} onChange={setMessage} />
        <Button loading={busy} disabled={!message.trim()} onClick={() => void submit('resolve', { code, summary: message }, 'Case resolved.')}>Resolve case</Button>
      </div>}
    </div>
  </Panel>;
}

function LegalHoldPanel({ operationId }: { operationId: string }) {
  const resource = useApiResource<{ holds: LegalHold[] }>(
    `/api/admin/lifecycle-legal-holds?active=false&subjectType=lifecycle_operation&subjectId=${operationId}`,
  );
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // A 403 means this operator may work the lifecycle queue but may not see
  // legal matters. Do not turn that deliberate field-level boundary into a
  // broken-looking panel.
  if (resource.error) return null;
  const holds = resource.data?.holds ?? [];
  const active = holds.filter((hold) => hold.releasedAt === null);
  const place = async () => {
    setBusy(true); setNotice('');
    try {
      await api('/api/admin/lifecycle-legal-holds', {
        method: 'POST',
        body: JSON.stringify({ subjectType: 'lifecycle_operation', subjectId: operationId, reference, reason }),
      });
      setReference(''); setReason(''); setNotice('Legal hold placed. Retention is suspended for this operation.'); resource.reload();
    } catch (error) { setNotice(problemText(error, 'The legal hold could not be placed.')); }
    finally { setBusy(false); }
  };
  const release = async (holdId: string) => {
    setBusy(true); setNotice('');
    try {
      await api(`/api/admin/lifecycle-legal-holds/${holdId}/release`, { method: 'POST' });
      setNotice('Legal hold released. Normal retention policy applies again.'); resource.reload();
    } catch (error) { setNotice(problemText(error, 'The legal hold could not be released.')); }
    finally { setBusy(false); }
  };
  return <Panel title="Legal holds" actions={active.length ? <Status tone="warning">{active.length} active</Status> : undefined}>
    <div className="space-y-4 p-4">
      {active.length > 0 ? <Alert tone="warning" title="Retention suspended">This operation and its linked receipts, observations, and delivery records are preserved.</Alert> : null}
      {holds.length > 0 ? <Table tight><thead><tr><th scope="col">Reference</th><th scope="col">Reason</th><th scope="col">Placed</th><th scope="col">State</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {holds.map((hold) => <tr key={hold.id}><td className="font-mono">{hold.reference}</td><td>{hold.reason}</td><td>{when(hold.placedAt)}</td><td>{hold.releasedAt ? <Status tone="inactive">released {when(hold.releasedAt)}</Status> : <Status tone="warning">active</Status>}</td><td className="text-right">{hold.releasedAt ? null : <Button size="sm" variant="danger-quiet" loading={busy} onClick={() => void release(hold.id)}>Release hold</Button>}</td></tr>)}
      </tbody></Table> : null}
      <form className="grid gap-3 sm:grid-cols-[minmax(12rem,0.7fr)_minmax(18rem,1fr)_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void place(); }}>
        <Field label="Matter or case reference" value={reference} onChange={setReference} />
        <Field label="Preservation reason" value={reason} onChange={setReason} />
        <Button type="submit" loading={busy} disabled={!reference.trim() || !reason.trim()}>Place legal hold</Button>
      </form>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
    </div>
  </Panel>;
}

export function LifecycleOperationPage() {
  const { id = '' } = useParams();
  const resource = useApiResource<Operation>(`/api/admin/lifecycle-operations/${id}`);
  const deliveries = useApiResource<{ notifications: Delivery[] }>(`/api/admin/lifecycle-operations/${id}/notifications`);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [observing, setObserving] = useState<string | null>(null);
  const [history, setHistory] = useState<Set<string>>(new Set());
  if (resource.loading || !resource.data) return resource.error ? <Alert tone="danger">{resource.error}</Alert> : <Panel><div className="p-4" /></Panel>;
  const operation = resource.data;
  const open = !['completed', 'cancelled', 'rejected'].includes(operation.status);
  const pendingApproval = operation.approvalRequired && !operation.approvedAt && !operation.rejectedAt;
  const act = async (path: string, body: unknown, done: string, failed: string) => {
    setBusy(true);
    try {
      await api(`/api/admin/lifecycle-operations/${id}/${path}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      resource.reload();
      deliveries.reload();
      setNotice(done);
    } catch (error) {
      setNotice(problemText(error, failed));
    } finally {
      setBusy(false);
    }
  };
  const toggleHistory = (stepId: string) => setHistory((current) => {
    const next = new Set(current);
    if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
    return next;
  });
  return <>
    <PageHeader title={`${operation.kind} operation${operation.personName ? ` — ${operation.personName}` : ''}`} actions={operation.personId ? <Link className="underline" to={`/admin/people/${operation.personId}`}>Employee record</Link> : undefined} />
    <PageFacts facts={[
      { label: 'Status', value: <Status tone={tone(operation.status)}>{operation.status.replace('_', ' ')}</Status> },
      { label: 'Attempt', value: operation.attempt },
      { label: 'Priority', value: operation.priority },
      { label: 'Owner', value: operation.ownerName ?? 'Unassigned' },
      { label: 'Due', value: when(operation.dueAt) },
      { label: 'Acknowledged', value: operation.acknowledgedAt ? when(operation.acknowledgedAt) : 'No' },
      { label: 'Service level', value: operation.sloMinutes === null ? 'None' : `${operation.sloMinutes} min · deadline ${when(operation.sloDeadlineAt)}` },
      { label: 'Requested by', value: operation.requestedByName ?? '—' },
      { label: 'Created', value: when(operation.createdAt) },
      { label: 'Completed', value: when(operation.completedAt) },
    ]} />
    {operation.overdueReason ? <Alert tone="danger" title="Overdue">{operation.overdueReason}{operation.escalatedAt ? ` Escalated to ${operation.escalatedToName ?? 'the configured owner'} at ${when(operation.escalatedAt)}.` : ''}</Alert> : null}
    {operation.sloBreachedAt && !operation.overdueReason ? <Alert tone="warning" title="Service level breached">Completed after its deadline; breached at {when(operation.sloBreachedAt)}.</Alert> : null}
    {operation.approvalRequired ? <Panel title="Approval"><div className="space-y-3 p-4">
      <p>{operation.approvalReason ?? 'Policy requires a second person to approve this operation.'}</p>
      {operation.approvedAt ? <p><Status tone="active">Approved</Status> by {operation.approvedByName ?? 'an administrator'} at {when(operation.approvedAt)}</p> : null}
      {operation.rejectedAt && operation.status === 'rejected' ? <p><Status tone="danger">Rejected</Status> by {operation.rejectedByName ?? 'an administrator'} at {when(operation.rejectedAt)}: {operation.rejectionReason}</p> : null}
      {pendingApproval ? <>
        <p className="text-sm text-muted">Nothing has been written to a target. The person who requested this cannot approve it.</p>
        <Field label="Reason (required to reject)" value={reason} onChange={setReason} />
        <div className="flex flex-wrap gap-2">
          <Button loading={busy} onClick={() => void act('approve', undefined, 'Approved. Target work has been queued.', 'The operation could not be approved.')}>Approve and run</Button>
          <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void act('reject', { reason }, 'Rejected.', 'The operation could not be rejected.')}>Reject</Button>
        </div>
      </> : null}
    </div></Panel> : null}
    <Panel title="Operation timeline"><div className="space-y-4 p-4">
      <ol className="space-y-4" aria-live="polite">{operation.steps.map((step) => {
        const observation = step.observations?.[0];
        const attempts = step.attempts ?? [];
        return <li key={step.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2"><strong>{step.title}</strong> <Status tone={tone(step.status)}>{step.status}</Status>{step.responseCategory ? <span className="text-sm text-muted">· {CATEGORY_LABEL[step.responseCategory] ?? step.responseCategory}</span> : null}</div>
          <p className="text-sm text-muted">Planned: {step.title}. Started {when(step.startedAt)} · finished {when(step.completedAt)} · attempts recorded: {attempts.length}</p>
          {step.message ? <p className="text-sm">{step.message}</p> : null}
          {observation ? <div className="mt-2 border-t border-border-subtle pt-2 text-sm space-y-1">
            <p><strong>{observation.matches ? 'Verified' : observation.completeness === 'incomplete' ? 'Manual verification required' : 'Observed drift'}</strong> · {when(observation.observedAt)}</p>
            <p><span className="text-muted">Expected:</span> {stateSummary(observation.expected)}</p>
            <p><span className="text-muted">Observed:</span> {stateSummary(observation.observed)}</p>
            {observation.differences.length ? <ul className="list-disc pl-5 text-muted">{observation.differences.map((difference) => <li key={difference.path}>{difference.path}: expected {JSON.stringify(difference.expected)}, observed {JSON.stringify(difference.observed)}</li>)}</ul> : null}
          </div> : null}
          <div className="flex flex-wrap gap-2">
            {attempts.length > 0 ? <Button size="sm" variant="ghost" aria-expanded={history.has(step.id)} onClick={() => toggleHistory(step.id)}>{history.has(step.id) ? 'Hide attempt history' : `Show attempt history (${attempts.length})`}</Button> : null}
            {open && step.key === 'targets' && step.status !== 'succeeded' && step.status !== 'skipped' ? <Button size="sm" variant="secondary" onClick={() => setObserving(observing === step.id ? null : step.id)}>{observing === step.id ? 'Close observation form' : 'Record observed state'}</Button> : null}
          </div>
          {history.has(step.id) ? <Table tight><thead><tr><th scope="col">Attempt</th><th scope="col">Outcome</th><th scope="col">Target response</th><th scope="col">Started</th><th scope="col">Finished</th><th scope="col">Message</th></tr></thead><tbody>
            {attempts.map((attempt) => <tr key={attempt.id}><td>{attempt.attempt}</td><td><Status tone={tone(attempt.status)}>{attempt.status}</Status></td><td>{attempt.responseCategory ? CATEGORY_LABEL[attempt.responseCategory] ?? attempt.responseCategory : '—'}</td><td>{when(attempt.startedAt)}</td><td>{when(attempt.completedAt)}</td><td>{attempt.message ?? '—'}</td></tr>)}
          </tbody></Table> : null}
          {observing === step.id ? <ObservationForm operationId={operation.id} step={step} onDone={(message) => { setNotice(message); setObserving(null); resource.reload(); }} /> : null}
        </li>;
      })}</ol>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={busy} onClick={() => void act('acknowledge', undefined, 'Work acknowledged.', 'Could not acknowledge the operation.')}>{operation.acknowledgedAt ? 'Acknowledged' : 'Acknowledge work'}</Button>
        {open && !pendingApproval ? <Button loading={busy} onClick={() => void act('retry', undefined, 'Operation requeued as a new attempt. Earlier evidence is kept.', 'Could not requeue the operation.')}>Retry operation</Button> : null}
        {open ? <>
          <Field label="Cancellation reason" value={reason} onChange={setReason} />
          <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => void act('cancel', { reason }, 'Operation cancelled. Nothing at a target was undone.', 'Could not cancel the operation.')}>Cancel operation</Button>
        </> : null}
      </div>
    </div></Panel>
    <CaseHistoryPanel operation={operation} onChanged={(message) => { setNotice(message); resource.reload(); }} />
    <Panel title="Notification delivery">
      <div className="p-4">
        {deliveries.data?.notifications.length ? <Table tight><thead><tr><th scope="col">Message</th><th scope="col">To</th><th scope="col">Queued</th><th scope="col">Delivery</th></tr></thead><tbody>
          {deliveries.data.notifications.map((row) => <tr key={row.id}><td>{row.template}</td><td>{row.to}</td><td>{when(row.createdAt)}</td><td>{row.sentAt ? <Status tone="active">sent {when(row.sentAt)}</Status> : row.lastError ? <Status tone="danger">failed ×{row.attempts}: {row.lastError}</Status> : <Status tone="warning">queued</Status>}</td></tr>)}
        </tbody></Table> : <p className="text-sm text-muted">No notification has been queued for this operation.</p>}
      </div>
    </Panel>
    <LegalHoldPanel operationId={operation.id} />
  </>;
}
