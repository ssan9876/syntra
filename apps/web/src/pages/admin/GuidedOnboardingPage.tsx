import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, Status } from '@syntra/ui';
import { api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface OperationResult {
  person: { id: string; givenName: string; familyName: string };
  operation: {
    id: string;
    status: string;
    steps: { key: string; title: string; status: string; message?: string | null }[];
  };
}

export function GuidedOnboardingPage() {
  const targets = useApiResource<{ targets: { id: string; name: string; enabled: boolean }[] }>('/api/admin/targets');
  const key = useRef(crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>({ startDate: '' });
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<OperationResult | null>(null);
  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const submit = async () => {
    setBusy(true);
    setProblem('');
    try {
      const response = await api<OperationResult>('/api/admin/lifecycle-operations/onboard', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: key.current,
          person: {
            givenName: values.givenName ?? '',
            familyName: values.familyName ?? '',
            ...(values.externalId ? { externalId: values.externalId } : {}),
            ...(values.businessEmail ? { businessEmail: values.businessEmail } : {}),
          },
          contract: {
            sequence: 1,
            isPrimary: true,
            startDate: values.startDate ?? '',
            ...(values.department ? { department: values.department } : {}),
            ...(values.jobTitle ? { jobTitle: values.jobTitle } : {}),
          },
          ...(login
            ? {
                login: {
                  login: values.login ?? '',
                  email: values.loginEmail ?? '',
                  displayName: `${values.givenName ?? ''} ${values.familyName ?? ''}`.trim(),
                },
              }
            : {}),
          targetIds: (targets.data?.targets ?? []).filter((target) => target.enabled).map((target) => target.id),
        }),
      });
      setResult(response);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Onboarding could not be started.');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const waiting = ['queued', 'running', 'waiting'].includes(result.operation.status);
    return <>
      <PageHeader title={`${result.person.givenName} ${result.person.familyName}`} />
      <div aria-live="polite"><Alert tone={waiting ? 'info' : result.operation.status === 'completed' ? 'success' : 'danger'}>{waiting ? 'Onboarding is waiting for target systems.' : result.operation.status === 'completed' ? 'Onboarding completed.' : 'Onboarding needs attention.'}</Alert></div>
      <Panel title="Durable onboarding receipt"><ol className="divide-y divide-border-subtle">{result.operation.steps.map((step) => <li key={step.key} className="flex items-start justify-between gap-4 p-4"><div><strong>{step.title}</strong>{step.message && <p className="text-sm text-muted">{step.message}</p>}</div><Status tone={step.status === 'succeeded' || step.status === 'skipped' ? 'active' : step.status === 'failed' ? 'danger' : 'warning'}>{step.status}</Status></li>)}</ol></Panel>
      <div className="mt-4 flex gap-4"><Link className="font-medium text-primary underline" to={`/admin/people/${result.person.id}`}>Open employee</Link><Link className="text-primary underline" to={`/admin/lifecycle-operations/${result.operation.id}`}>Open operation timeline</Link><Link className="text-primary underline" to="/admin/employee-work">Open employee work</Link></div>
    </>;
  }

  return <>
    <PageHeader title="Onboard employee" />
    <p className="mb-4 max-w-3xl text-sm text-muted">One request saves the employee, contract, optional login, and target work. Refreshing the page after submission does not create a second employee.</p>
    {problem && <div className="mb-4" aria-live="assertive"><Alert tone="danger">{problem}</Alert></div>}
    <div className="space-y-4">
      <Panel title="Employee"><div className="grid gap-4 p-4 sm:grid-cols-2"><Field label="Given name" value={values.givenName ?? ''} onChange={(value) => set('givenName', value)} /><Field label="Family name" value={values.familyName ?? ''} onChange={(value) => set('familyName', value)} /><Field label="External id" value={values.externalId ?? ''} onChange={(value) => set('externalId', value)} /><Field label="Business email" type="email" value={values.businessEmail ?? ''} onChange={(value) => set('businessEmail', value)} /></div></Panel>
      <Panel title="Employment"><div className="grid gap-4 p-4 sm:grid-cols-2"><Field label="Start date" type="date" value={values.startDate ?? ''} onChange={(value) => set('startDate', value)} /><Field label="Department" value={values.department ?? ''} onChange={(value) => set('department', value)} /><Field label="Job title" value={values.jobTitle ?? ''} onChange={(value) => set('jobTitle', value)} /></div></Panel>
      <Panel title="Syntra login"><div className="space-y-4 p-4"><Check label="Create a Syntra login" checked={login} onChange={setLogin} />{login && <div className="grid gap-4 sm:grid-cols-2"><Field label="Login" value={values.login ?? ''} onChange={(value) => set('login', value)} /><Field label="Login email" type="email" value={values.loginEmail ?? ''} onChange={(value) => set('loginEmail', value)} /></div>}</div></Panel>
      <Panel title="Target systems"><div className="p-4 text-sm text-muted">{targets.loading ? 'Loading target systems…' : targets.error ? `Targets could not be loaded: ${targets.error}` : `${(targets.data?.targets ?? []).filter((target) => target.enabled).length} enabled target system(s) will receive durable work receipts.`}</div></Panel>
      <div className="sticky bottom-0 flex justify-end border-t border-border-subtle bg-bg/95 py-4 backdrop-blur"><Button loading={busy} disabled={targets.loading || !values.givenName || !values.familyName || !values.startDate} onClick={() => void submit()}>Start onboarding</Button></div>
    </div>
  </>;
}
