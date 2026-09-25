import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Panel,
  Select,
  SkeletonRows,
  useToast,
  type SummaryError,
} from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';

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
  lifecycleOperationRetentionDays: number;
  auditRetentionDays: number | null;
}

interface UserRow { id: string; login: string; displayName: string }

/**
 * Every whole-number setting, with its label and the range the form accepts.
 *
 * One table rather than a bound per call site, because three things read it:
 * the field, the check that runs before anything is sent, and the error
 * summary that has to name the field in the same words the field uses.
 */
const NUMBERS = {
  bulkRequeueThreshold: { label: 'Operations in one requeue that need approval', min: 1, max: 10000 },
  urgentLeaverSloMinutes: { label: 'Urgent departure (high or critical priority): minutes to remove access', min: 1, max: 1440 },
  offboardSloHours: { label: 'Standard departure: hours', min: 1, max: 2160 },
  onboardSloHours: { label: 'Hire: hours to verified access', min: 1, max: 2160 },
  moveSloHours: { label: 'Change: hours to verified access', min: 1, max: 2160 },
  maxConcurrentTargetOperations: { label: 'Target operations in flight at once', min: 1, max: 256 },
  receiptRetentionDays: { label: 'Resolved provisioning receipts: days', min: 1, max: 3650 },
  observationRetentionDays: { label: 'Target observations on resolved work: days', min: 1, max: 3650 },
  notificationRetentionDays: { label: 'Delivered notification records: days', min: 1, max: 3650 },
  simulationRetentionDays: { label: 'Simulations: days', min: 1, max: 3650 },
  lifecycleOperationRetentionDays: { label: 'Resolved operations and idempotency keys: days', min: 1, max: 3650 },
  // The one that may be blank, which means never.
  auditRetentionDays: { label: 'Audit events: days', min: 90, max: 3650 },
} as const;

type NumberKey = keyof typeof NUMBERS;

const LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(NUMBERS).map(([key, spec]) => [key, spec.label])),
  privilegedGroupPatterns: 'Privileged group name patterns',
  escalationOwnerUserId: 'Escalate overdue and unowned failed work to',
};

function whole(value: string, min: number, max: number): number | null {
  const number = Number(value.trim());
  return value.trim() !== '' && Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/** The number fields as the strings being typed, from a stored policy. */
function numbersOf(policy: Policy): Record<NumberKey, string> {
  const out = {} as Record<NumberKey, string>;
  for (const key of Object.keys(NUMBERS) as NumberKey[]) {
    const value = policy[key];
    out[key] = value === null ? '' : String(value);
  }
  return out;
}

const patternsOf = (policy: Policy) => policy.privilegedGroupPatterns.join(', ');
const patternList = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean);

/** A number that is not in range, or '' where blank is allowed. */
function numberProblem(key: NumberKey, value: string): string | undefined {
  const spec = NUMBERS[key];
  if (key === 'auditRetentionDays' && value.trim() === '') return undefined;
  return whole(value, spec.min, spec.max) === null
    ? `A whole number between ${spec.min} and ${spec.max}`
    : undefined;
}

/**
 * How lifecycle work is governed: who must approve it, how fast it must
 * finish, who is told, and how long its evidence is kept.
 *
 * One form in four stages, in that order — approvals first because they are
 * the setting that changes what happens to a request today; retention last
 * because it is set once and read at audit time. The explanatory paragraphs
 * each panel used to carry are gone; what they said that a reader needed is in
 * the labels, and the rest restated them.
 */
export function LifecyclePolicyPage() {
  const toast = useToast();
  const resource = useApiResource<Policy>('/api/admin/lifecycle-policy');
  const users = useApiResource<{ items?: UserRow[]; users?: UserRow[] }>('/api/admin/users?pageSize=100');
  /** What the server last said the policy is, for "Unsaved changes". */
  const [baseline, setBaseline] = useState<Policy | null>(null);
  const [form, setForm] = useState<Policy | null>(null);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  const [patterns, setPatterns] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const adopt = (policy: Policy) => {
    setBaseline(policy);
    setForm(policy);
    setPatterns(patternsOf(policy));
    setNumbers(numbersOf(policy));
  };

  useEffect(() => {
    if (resource.data) adopt(resource.data);
  }, [resource.data]);

  if (resource.error) return <Alert tone="danger">{resource.error}</Alert>;
  if (!form || !baseline) {
    return (
      <>
        <PageHeader title="Lifecycle policy" />
        <Panel><SkeletonRows rows={4} cols={2} /></Panel>
      </>
    );
  }

  const userList = users.data?.items ?? users.data?.users ?? [];
  const set = (patch: Partial<Policy>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const baseNumbers = numbersOf(baseline);
  const dirty =
    (Object.keys(baseline) as (keyof Policy)[]).some(
      (key) => !(key in NUMBERS) && key !== 'privilegedGroupPatterns' && form[key] !== baseline[key],
    ) ||
    (Object.keys(NUMBERS) as NumberKey[]).some((key) => (numbers[key] ?? '').trim() !== baseNumbers[key]) ||
    patternList(patterns).join(',') !== baseline.privilegedGroupPatterns.join(',');

  const number = (key: NumberKey, className?: string) => (
    <Field
      name={key}
      label={NUMBERS[key].label}
      value={numbers[key] ?? ''}
      onChange={(value) => setNumbers((current) => ({ ...current, [key]: value }))}
      inputMode="numeric"
      // Live, once something has been typed: silent while it is right,
      // stated while it is wrong. A server refusal for the same field wins.
      error={
        errors[key] ??
        (numbers[key] !== undefined && numbers[key] !== '' ? numberProblem(key, numbers[key]!) : undefined)
      }
      className={className}
      {...(key === 'auditRetentionDays' ? { placeholder: 'Never' } : {})}
    />
  );

  const save = async () => {
    setBusy(true); setProblem(null); setErrors({});
    // Checked before anything is sent, and reported the same way a server
    // refusal is: every bad number at once, each a link to its box. This used
    // to report the first one only, by its API key — "Check the number for
    // bulkRequeueThreshold" — which is a field no reader can find by that name.
    const local: Record<string, string> = {};
    for (const key of Object.keys(NUMBERS) as NumberKey[]) {
      const bad = numberProblem(key, numbers[key] ?? '');
      if (bad) local[key] = bad;
    }
    if (Object.keys(local).length > 0) { setErrors(local); setBusy(false); return; }
    const audit = numbers.auditRetentionDays?.trim() ? whole(numbers.auditRetentionDays, 90, 3650) : null;
    try {
      const saved = await api<Policy>('/api/admin/lifecycle-policy', {
        method: 'PATCH',
        body: JSON.stringify({
          requireApprovalForAccountCreation: form.requireApprovalForAccountCreation,
          requireApprovalForPrivilegedGroups: form.requireApprovalForPrivilegedGroups,
          privilegedGroupPatterns: patternList(patterns),
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
          lifecycleOperationRetentionDays: Number(numbers.lifecycleOperationRetentionDays),
          auditRetentionDays: audit,
        }),
      });
      adopt(saved);
      // The consequence rides with the confirmation: it is the thing somebody
      // who has just shortened a deadline would otherwise assume.
      toast({ tone: 'success', title: 'Policy saved', body: 'Deadlines already set on open work are unchanged.' });
    } catch (error) {
      const marked = formFieldErrors(error);
      setErrors(marked);
      setProblem(
        Object.keys(marked).length > 0
          ? null
          : error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : 'The policy could not be saved.',
      );
    } finally { setBusy(false); }
  };

  const summary: SummaryError[] = summaryErrors(errors, LABELS, problem);

  return <>
    <PageHeader title="Lifecycle policy" />
    {/* The form wraps the panel so the save bar can be sticky: `Panel` clips
        its overflow, and a sticky bar inside it would stick to the panel. */}
    <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Panel bodyClassName="space-y-8 p-4">
        <ErrorSummary errors={summary} {...(Object.keys(errors).length === 0 ? { title: 'Not saved' } : {})} />

        <FormSection title="Second approval before a target changes" number={1}>
          <Check className="sm:col-span-2" label="Creating a target account" checked={form.requireApprovalForAccountCreation} onChange={(value) => set({ requireApprovalForAccountCreation: value })} />
          <Check className="sm:col-span-2" label="Changing membership of a privileged group" checked={form.requireApprovalForPrivilegedGroups} onChange={(value) => set({ requireApprovalForPrivilegedGroups: value })} />
          <Field
            name="privilegedGroupPatterns"
            label="Privileged group name patterns, comma separated"
            value={patterns}
            onChange={setPatterns}
            placeholder="Domain Admins, *-admins"
            className="sm:col-span-2"
            error={errors.privilegedGroupPatterns}
            // A state, not a caption: the box does nothing while the approval
            // it feeds is switched off.
            warning={!form.requireApprovalForPrivilegedGroups && patterns.trim() ? 'Not used while privileged-group approval is off.' : undefined}
          />
          <Check className="sm:col-span-2" label="Target work for an urgent departure" checked={form.requireApprovalForUrgentDeparture} onChange={(value) => set({ requireApprovalForUrgentDeparture: value })} />
          <Check className="sm:col-span-2" label="Requeueing many operations at once" checked={form.requireApprovalForBulkRequeue} onChange={(value) => set({ requireApprovalForBulkRequeue: value })} />
          {number('bulkRequeueThreshold')}
        </FormSection>

        <FormSection title="Service levels" number={2}>
          {number('urgentLeaverSloMinutes', 'sm:col-span-2')}
          {number('offboardSloHours')}
          {number('onboardSloHours')}
          {number('moveSloHours')}
          {number('maxConcurrentTargetOperations')}
          <Select
            name="escalationOwnerUserId"
            label={LABELS.escalationOwnerUserId!}
            value={form.escalationOwnerUserId ?? ''}
            onChange={(value) => set({ escalationOwnerUserId: value || null })}
            options={[
              { value: '', label: 'Nobody (no escalation)' },
              ...userList.map((user) => ({ value: user.id, label: `${user.displayName} (${user.login})` })),
            ]}
            error={errors.escalationOwnerUserId}
            className="sm:col-span-2"
          />
        </FormSection>

        <FormSection title="Notifications" number={3}>
          <Check className="sm:col-span-2" label="Tell the owner when an operation fails" checked={form.notifyOnFailure} onChange={(value) => set({ notifyOnFailure: value })} />
          <Check className="sm:col-span-2" label="Tell the owner when work passes its due time unacknowledged" checked={form.notifyOnOverdue} onChange={(value) => set({ notifyOnOverdue: value })} />
          <Check className="sm:col-span-2" label="Tell the owner when target access is blocked by a guard" checked={form.notifyOnAccessBlocked} onChange={(value) => set({ notifyOnAccessBlocked: value })} />
        </FormSection>

        <FormSection title="Retention" number={4}>
          {number('receiptRetentionDays')}
          {number('observationRetentionDays')}
          {number('notificationRetentionDays')}
          {number('simulationRetentionDays')}
          {number('lifecycleOperationRetentionDays')}
          {number('auditRetentionDays')}
        </FormSection>
      </Panel>

      <FormActions sticky status={dirty ? <span className="text-muted">Unsaved changes</span> : null}>
        <Button type="submit" variant="primary" loading={busy}>Save policy</Button>
      </FormActions>
    </form>
  </>;
}
