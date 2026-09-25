import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  StateBadge,
  useToast,
  type ComboOption,
  type State,
  type SummaryError,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { PersonPicker } from './PickerNote.js';
import { usePersonReceipts } from './use-person-receipts.js';
import {
  OnboardingReceipt,
  REQUIRED,
  receiptEvidence,
  receiptState,
  type ReceiptRow,
} from './onboarding-receipt.js';

interface OperationResult {
  person: { id: string; givenName: string; familyName: string };
  operation: {
    id: string;
    status: string;
    steps: { key: string; title: string; status: string; message?: string | null }[];
  };
}

/** A lifecycle step's status as the receipt's state language. */
function stepState(status: string): { state: State; label: string } {
  switch (status) {
    case 'succeeded': return { state: 'healthy', label: 'Done' };
    case 'skipped': return { state: 'inactive', label: 'Skipped' };
    case 'failed': return { state: 'blocked', label: 'Failed' };
    case 'running': return { state: 'running', label: 'Running' };
    default: return { state: 'pending', label: status === 'pending' ? 'Queued' : status };
  }
}

function operationState(status: string): { state: State; label: string } {
  if (status === 'completed') return { state: 'healthy', label: 'Completed' };
  if (status === 'awaiting_approval') return { state: 'pending', label: 'Awaiting approval' };
  if (['queued', 'running', 'waiting'].includes(status)) return { state: 'pending', label: 'Waiting for targets' };
  return { state: 'blocked', label: 'Needs attention' };
}

/**
 * The durable receipt: the operation's own steps, then one row per target
 * from the person's provisioning receipts, polled until each target is
 * observed or needs a person. The operation says the work was QUEUED; only
 * the receipts say whether it landed.
 */
function OnboardingResult({ result }: { result: OperationResult }) {
  const receipts = usePersonReceipts(result.person.id);
  const overall = operationState(result.operation.status);
  const rows: ReceiptRow[] = [
    ...result.operation.steps.map((step) => ({
      key: step.key,
      title: step.title,
      ...stepState(step.status),
      evidence: step.message ?? undefined,
    })),
    ...(receipts.receipts ?? []).map((receipt) => ({
      key: receipt.id,
      title: receipt.targetName,
      ...receiptState(receipt),
      evidence: receiptEvidence(receipt),
    })),
  ];
  return <>
    <PageHeader
      title={`${result.person.givenName} ${result.person.familyName}`}
      status={<StateBadge state={overall.state}>{overall.label}</StateBadge>}
    />
    {receipts.problem && <div className="mb-4"><Alert tone="warning">{receipts.problem}</Alert></div>}
    <OnboardingReceipt title="Onboarding receipt" rows={rows} />
    <div className="mt-4 flex flex-wrap gap-4">
      <Link className="link font-medium" to={`/admin/people/${result.person.id}`}>Open employee</Link>
      <Link className="link" to={`/admin/lifecycle-operations/${result.operation.id}`}>Open operation timeline</Link>
      <Link className="link" to="/admin/employee-work">Open employee work</Link>
    </div>
  </>;
}

/**
 * Onboarding as one server-side operation.
 *
 * One request saves the employee, the contract, the optional login and the
 * target work, under an idempotency key held for the life of the page — so a
 * double click or a retry after a dropped connection resumes the same
 * operation rather than creating a second employee. The form is grouped the
 * way the request is, marks the three fields the server insists on, and
 * keeps its submit in reach however far down the contract fields go.
 */
export function GuidedOnboardingPage() {
  const targets = useApiResource<{ targets: { id: string; name: string; enabled: boolean }[] }>('/api/admin/targets');
  const key = useRef(crypto.randomUUID());
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({ startDate: '' });
  const [manager, setManager] = useState<ComboOption | null>(null);
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<OperationResult | null>(null);
  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const enabled = (targets.data?.targets ?? []).filter((target) => target.enabled);

  function missing(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!values.givenName?.trim()) found.givenName = 'Enter a given name';
    if (!values.familyName?.trim()) found.familyName = 'Enter a family name';
    if (!values.startDate) found.startDate = 'Enter a start date';
    if (login && !values.login?.trim()) found.login = 'Enter a login';
    if (login && !values.email?.trim()) found.email = 'Enter the login email';
    return found;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = missing();
    setProblem('');
    setErrors(invalid);
    if (Object.keys(invalid).length > 0) return;
    setBusy(true);
    // Each optional value omitted when blank: the schema validates these as
    // e-mail addresses, dates and bounded strings, and '' satisfies none.
    const optional = (...names: string[]) =>
      Object.fromEntries(names.filter((name) => values[name]?.trim()).map((name) => [name, values[name]!.trim()]));
    try {
      const response = await api<OperationResult>('/api/admin/lifecycle-operations/onboard', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: key.current,
          person: {
            givenName: values.givenName ?? '',
            familyName: values.familyName ?? '',
            ...optional('externalId', 'businessEmail', 'personalEmail'),
          },
          contract: {
            sequence: 1,
            isPrimary: true,
            startDate: values.startDate ?? '',
            ...optional('endDate', 'department', 'jobTitle', 'costCentre', 'employer', 'location'),
            ...(manager ? { managerPersonId: manager.value } : {}),
            ...(values.fte?.trim() ? { fte: Number(values.fte) } : {}),
          },
          ...(login
            ? {
                login: {
                  login: values.login ?? '',
                  email: values.email ?? '',
                  displayName: `${values.givenName ?? ''} ${values.familyName ?? ''}`.trim(),
                },
              }
            : {}),
          targetIds: enabled.map((target) => target.id),
        }),
      });
      setResult(response);
      toast({ tone: 'success', title: `${response.person.givenName} ${response.person.familyName} onboarding started` });
    } catch (error) {
      setErrors(fieldErrors(error));
      setProblem(error instanceof ApiError
        ? (error.problem.detail ?? error.problem.title)
        : error instanceof Error ? error.message : 'Onboarding could not be started.');
    } finally {
      setBusy(false);
    }
  };

  if (result) return <OnboardingResult result={result} />;

  const summary: SummaryError[] = [
    ...Object.entries(errors).map(([field, message]) => ({ field, message })),
    ...(problem ? [{ message: problem }] : []),
  ];
  const text = (name: string, label: string, extra: { type?: string; placeholder?: string; required?: boolean } = {}) => (
    <Field
      name={name}
      label={label}
      type={extra.type}
      placeholder={extra.placeholder}
      required={extra.required}
      className={extra.required ? REQUIRED : undefined}
      value={values[name] ?? ''}
      onChange={(value) => set(name, value)}
      error={errors[name]}
    />
  );

  return <>
    <PageHeader title="Onboard employee" />
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-6">
      <ErrorSummary errors={summary} title="Onboarding was not started" />
      <FormSection title="Identity">
        {text('givenName', 'Given name', { required: true, placeholder: 'Maya' })}
        {text('familyName', 'Family name', { required: true, placeholder: 'Okafor' })}
        {text('externalId', 'External id', { placeholder: 'E1042' })}
        {text('businessEmail', 'Business email', { type: 'email' })}
        {text('personalEmail', 'Personal email', { type: 'email' })}
      </FormSection>
      <FormSection title="Contract">
        {text('startDate', 'Start date', { type: 'date', required: true })}
        {text('endDate', 'End date', { type: 'date' })}
        {text('department', 'Department', { placeholder: 'Nursing' })}
        {text('jobTitle', 'Job title', { placeholder: 'Staff Nurse' })}
        {text('costCentre', 'Cost centre')}
        {text('location', 'Location')}
        {text('employer', 'Employer')}
        {text('fte', 'FTE', { placeholder: '1.0' })}
        <PersonPicker name="managerPersonId" label="Manager" value={manager} onChange={setManager} error={errors.managerPersonId} />
      </FormSection>
      <FormSection
        title="Sign-in account"
        status={<StateBadge state={login ? 'pending' : 'inactive'}>{login ? 'Will be created' : 'None'}</StateBadge>}
      >
        <Check className="sm:col-span-2" label="Create a Syntra login" checked={login} onChange={setLogin} />
        {login && <>
          {text('login', 'Login', { required: true, placeholder: 'mokafor' })}
          {text('email', 'Login email', { type: 'email', required: true })}
        </>}
      </FormSection>
      <FormSection
        title="Target systems"
        status={targets.loading && !targets.data
          ? <StateBadge state="running">Loading</StateBadge>
          : targets.error
            ? <StateBadge state="attention">Unavailable</StateBadge>
            : <StateBadge state={enabled.length > 0 ? 'pending' : 'inactive'}>{`${enabled.length} will receive work`}</StateBadge>}
      >
        {targets.error
          ? <Alert tone="warning">Targets could not be loaded: {targets.error}</Alert>
          : enabled.length > 0 && <ul className="flex flex-wrap gap-2 sm:col-span-2" aria-label="Targets receiving work">
            {enabled.map((target) => <li key={target.id} className="rounded-full border border-border-control px-2.5 py-0.5 text-sm text-ink">{target.name}</li>)}
          </ul>}
      </FormSection>
      <FormActions sticky>
        <Button type="submit" loading={busy} disabled={targets.loading && !targets.data}>Start onboarding</Button>
      </FormActions>
    </form>
  </>;
}
