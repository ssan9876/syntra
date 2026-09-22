import { useEffect, useState } from 'react';
import { Alert, Button, Check, Field, Panel } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Policy {
  requireApprovalForAccountCreation: boolean;
  requireApprovalForPrivilegedGroups: boolean;
  privilegedGroupPatterns: string[];
  requireApprovalForUrgentDeparture: boolean;
  requireApprovalForBulkRequeue: boolean;
  bulkRequeueThreshold: number;
  maxConcurrentTargetOperations: number;
  urgentLeaverSloMinutes: number;
  onboardSloHours: number;
  moveSloHours: number;
  offboardSloHours: number;
  escalationOwnerUserId: string | null;
  notifyOnFailure: boolean;
  notifyOnOverdue: boolean;
  notifyOnAccessBlocked: boolean;
  receiptRetentionDays: number;
  observationRetentionDays: number;
  notificationRetentionDays: number;
  simulationRetentionDays: number;
  auditRetentionDays: number | null;
}

interface UserRow { id: string; login: string; displayName: string }

function whole(value: string, min: number, max: number): number | null {
  const number = Number(value.trim());
  return value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max ? number : null;
}

export function LifecyclePolicyPage() {
  const resource = useApiResource<Policy>('/api/admin/lifecycle-policy');
  const users = useApiResource<{ items?: UserRow[]; users?: UserRow[] }>('/api/admin/users?pageSize=100');
  const [form, setForm] = useState<Policy | null>(null);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  const [patterns, setPatterns] = useState('');
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!resource.data) return;
    setForm(resource.data);
    setPatterns(resource.data.privilegedGroupPatterns.join(', '));
    setNumbers({
      bulkRequeueThreshold: String(resource.data.bulkRequeueThreshold),
      maxConcurrentTargetOperations: String(resource.data.maxConcurrentTargetOperations),
      urgentLeaverSloMinutes: String(resource.data.urgentLeaverSloMinutes),
      onboardSloHours: String(resource.data.onboardSloHours),
      moveSloHours: String(resource.data.moveSloHours),
      offboardSloHours: String(resource.data.offboardSloHours),
      receiptRetentionDays: String(resource.data.receiptRetentionDays),
      observationRetentionDays: String(resource.data.observationRetentionDays),
      notificationRetentionDays: String(resource.data.notificationRetentionDays),
      simulationRetentionDays: String(resource.data.simulationRetentionDays),
      auditRetentionDays: resource.data.auditRetentionDays === null ? '' : String(resource.data.auditRetentionDays),
    });
  }, [resource.data]);
  if (resource.error) return <Alert tone="danger">{resource.error}</Alert>;
  if (!form) return <Panel><div className="p-4" /></Panel>;
  const userList = users.data?.items ?? users.data?.users ?? [];
  const set = (patch: Partial<Policy>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const number = (key: string, label: string, min: number, max: number, note?: string) => (
    <Field
      label={label}
      value={numbers[key] ?? ''}
      onChange={(value) => setNumbers((current) => ({ ...current, [key]: value }))}
      error={numbers[key] !== undefined && numbers[key] !== '' && whole(numbers[key]!, min, max) === null ? `a whole number between ${min} and ${max}` : undefined}
      warning={note}
    />
  );
  const save = async () => {
    setBusy(true); setProblem(''); setNotice('');
    const bad = Object.entries(numbers).find(([key, value]) => key !== 'auditRetentionDays' && whole(value, 1, 1_000_000) === null);
    if (bad) { setProblem(`Check the number for ${bad[0]}.`); setBusy(false); return; }
    const audit = numbers.auditRetentionDays?.trim() ? whole(numbers.auditRetentionDays, 90, 3650) : null;
    if (numbers.auditRetentionDays?.trim() && audit === null) { setProblem('Audit retention must be blank (never) or between 90 and 3650 days.'); setBusy(false); return; }
    try {
      const saved = await api<Policy>('/api/admin/lifecycle-policy', {
        method: 'PATCH',
        body: JSON.stringify({
          requireApprovalForAccountCreation: form.requireApprovalForAccountCreation,
          requireApprovalForPrivilegedGroups: form.requireApprovalForPrivilegedGroups,
          privilegedGroupPatterns: patterns.split(',').map((item) => item.trim()).filter(Boolean),
          requireApprovalForUrgentDeparture: form.requireApprovalForUrgentDeparture,
          requireApprovalForBulkRequeue: form.requireApprovalForBulkRequeue,
          bulkRequeueThreshold: Number(numbers.bulkRequeueThreshold),
          maxConcurrentTargetOperations: Number(numbers.maxConcurrentTargetOperations),
          urgentLeaverSloMinutes: Number(numbers.urgentLeaverSloMinutes),
          onboardSloHours: Number(numbers.onboardSloHours),
          moveSloHours: Number(numbers.moveSloHours),
          offboardSloHours: Number(numbers.offboardSloHours),
          escalationOwnerUserId: form.escalationOwnerUserId || null,
          notifyOnFailure: form.notifyOnFailure,
          notifyOnOverdue: form.notifyOnOverdue,
          notifyOnAccessBlocked: form.notifyOnAccessBlocked,
          receiptRetentionDays: Number(numbers.receiptRetentionDays),
          observationRetentionDays: Number(numbers.observationRetentionDays),
          notificationRetentionDays: Number(numbers.notificationRetentionDays),
          simulationRetentionDays: Number(numbers.simulationRetentionDays),
          auditRetentionDays: audit,
        }),
      });
      setForm(saved);
      setNotice('Policy saved. Deadlines already set on open work are unchanged.');
    } catch (error) {
      setProblem(error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : 'The policy could not be saved.');
    } finally { setBusy(false); }
  };
  return <>
    <PageHeader title="Lifecycle policy" />
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Panel title="Approvals"><div className="space-y-3 p-4">
        <p className="text-sm text-muted">A second person must approve before a target is changed. The requester can never approve their own request. Local records (the employee, the contract, a blocked sign-in) are saved regardless; only target writes wait.</p>
        <Check label="Creating a target account" checked={form.requireApprovalForAccountCreation} onChange={(value) => set({ requireApprovalForAccountCreation: value })} />
        <Check label="Changing membership of a privileged group" checked={form.requireApprovalForPrivilegedGroups} onChange={(value) => set({ requireApprovalForPrivilegedGroups: value })} />
        <Field label="Privileged group name patterns (comma separated, matched case-insensitively)" value={patterns} onChange={setPatterns} />
        <Check label="Target work for an urgent departure" checked={form.requireApprovalForUrgentDeparture} onChange={(value) => set({ requireApprovalForUrgentDeparture: value })} />
        <Check label="Requeueing many operations at once" checked={form.requireApprovalForBulkRequeue} onChange={(value) => set({ requireApprovalForBulkRequeue: value })} />
        {number('bulkRequeueThreshold', 'Operations in one requeue that need approval', 1, 10000)}
      </div></Panel>
      <Panel title="Service levels"><div className="grid gap-4 p-4 sm:grid-cols-2">
        {number('urgentLeaverSloMinutes', 'Urgent departure: minutes to remove access', 1, 1440, 'Applies to high and critical priority departures.')}
        {number('offboardSloHours', 'Standard departure: hours', 1, 2160)}
        {number('onboardSloHours', 'Hire: hours to verified access', 1, 2160)}
        {number('moveSloHours', 'Change: hours to verified access', 1, 2160)}
        {number('maxConcurrentTargetOperations', 'Target operations in flight at once', 1, 256, 'Beyond this, work is deferred visibly and retried every 30 seconds.')}
        <div className="sm:col-span-2">
          <label className="block">
            <span className="font-medium text-ink">Escalation owner</span>
            <select className="mt-1 block w-full rounded-control border border-border-control bg-bg p-2" value={form.escalationOwnerUserId ?? ''} onChange={(event) => set({ escalationOwnerUserId: event.target.value || null })}>
              <option value="">Nobody (no escalation)</option>
              {userList.map((user) => <option key={user.id} value={user.id}>{user.displayName} ({user.login})</option>)}
            </select>
          </label>
          <p className="mt-1 text-sm text-muted">Overdue and breached work is escalated to this person once, and failed work with no owner is sent here.</p>
        </div>
      </div></Panel>
      <Panel title="Notifications"><div className="space-y-3 p-4">
        <Check label="Tell the owner when an operation fails" checked={form.notifyOnFailure} onChange={(value) => set({ notifyOnFailure: value })} />
        <Check label="Tell the owner when work passes its due time unacknowledged" checked={form.notifyOnOverdue} onChange={(value) => set({ notifyOnOverdue: value })} />
        <Check label="Tell the owner when target access is blocked by a guard" checked={form.notifyOnAccessBlocked} onChange={(value) => set({ notifyOnAccessBlocked: value })} />
        <p className="text-sm text-muted">Every message is written to the delivery record before it is sent; the operation page shows whether it went out.</p>
      </div></Panel>
      <Panel title="Retention"><div className="grid gap-4 p-4 sm:grid-cols-2">
        {number('receiptRetentionDays', 'Resolved provisioning receipts: days', 1, 3650)}
        {number('observationRetentionDays', 'Target observations on resolved work: days', 1, 3650)}
        {number('notificationRetentionDays', 'Delivered notification records: days', 1, 3650)}
        {number('simulationRetentionDays', 'Simulations: days', 1, 3650)}
        <div className="sm:col-span-2">{number('auditRetentionDays', 'Audit events: days (blank means never)', 90, 3650, 'Only events at or before a verified audit checkpoint are ever removed, so the chain still verifies.')}</div>
        <p className="text-sm text-muted sm:col-span-2">The nightly retention pass records an audit event with every count it removed.</p>
      </div></Panel>
      {problem ? <Alert tone="danger">{problem}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Button type="submit" variant="primary" loading={busy}>Save policy</Button>
    </form>
  </>;
}
