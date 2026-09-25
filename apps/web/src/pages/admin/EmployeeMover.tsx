import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, FormActions, StateBadge, Status, Table, useToast, type ComboOption } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PersonPicker } from './PickerNote.js';

interface ContractSummary {
  sequence: number;
  department: string | null;
  jobTitle: string | null;
  location?: string | null;
  costCentre?: string | null;
  employer?: string | null;
  managerPersonId?: string | null;
}

interface Named { entitlementId: string; displayName: string; privileged: boolean }
interface AccessDelta {
  targetSystemId: string;
  targetName: string;
  accountStatus: string;
  account: 'create' | 'enable' | 'keep' | 'disable' | 'none';
  add: Named[];
  retain: Named[];
  remove: Named[];
  unverified: boolean;
  unprocessable: { kind: string; message: string } | null;
}

interface MoverPreview {
  tenantId: string;
  personId: string;
  contractSequence: number;
  revision: string;
  requested: Record<string, string | number | null>;
  changes: { field: string; before: string | number | null; after: string | number | null }[];
  contract?: { startDate: string; endDate: string | null; isPrimary: boolean };
  manager?: { before: string | null; after: string | null };
  access?: AccessDelta[];
  approval?: { required: boolean; reason: string | null };
  sloMinutes?: number | null;
}

const FIELD_LABEL: Record<string, string> = {
  department: 'Department',
  jobTitle: 'Role',
  location: 'Location',
  costCentre: 'Cost centre',
  employer: 'Employer',
  managerPersonId: 'Manager',
  fte: 'FTE',
};

const ACCOUNT_LABEL: Record<AccessDelta['account'], string> = {
  create: 'Create account',
  enable: 'Enable account',
  keep: 'Keep account',
  disable: 'Disable account',
  none: 'No account',
};

function names(list: Named[]) {
  if (list.length === 0) return <span className="text-muted">none</span>;
  return <ul className="space-y-0.5">{list.map((item) => <li key={item.entitlementId}>{item.displayName}{item.privileged ? <> <Status tone="danger">privileged</Status></> : null}</li>)}</ul>;
}

export function EmployeeMover({
  personId,
  contract,
  onApplied,
}: {
  personId: string;
  contract: ContractSummary;
  onApplied?: () => void;
}) {
  const [values, setValues] = useState({
    department: contract.department ?? '',
    jobTitle: contract.jobTitle ?? '',
    location: contract.location ?? '',
    costCentre: contract.costCentre ?? '',
    employer: contract.employer ?? '',
  });
  // The manager is chosen by searching the directory, not by pasting an id.
  // The current one arrives as an id only, so its name is read once to fill
  // the box; until it lands the id stands in, which is still the right value.
  const [manager, setManager] = useState<ComboOption | null>(
    contract.managerPersonId ? { value: contract.managerPersonId, label: contract.managerPersonId } : null,
  );
  const current = useApiResource<{ givenName: string; familyName: string }>(
    contract.managerPersonId ? `/api/admin/persons/${contract.managerPersonId}` : null,
  );
  useEffect(() => {
    if (!current.data || !contract.managerPersonId) return;
    const label = `${current.data.givenName} ${current.data.familyName}`;
    setManager((existing) => (existing && existing.value === contract.managerPersonId ? { ...existing, label } : existing));
  }, [current.data, contract.managerPersonId]);
  const [preview, setPreview] = useState<MoverPreview | null>(null);
  /** The draft was edited after the preview on screen was computed. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const toast = useToast();

  const change = (field: keyof typeof values, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (preview) setStale(true);
    setPreview(null);
    setMessage('');
  };
  const changeManager = (next: ComboOption | null) => {
    setManager(next);
    if (preview) setStale(true);
    setPreview(null);
    setMessage('');
  };

  const review = async () => {
    setBusy(true);
    setMessage('');
    setOperationId(null);
    try {
      const result = await api<MoverPreview>(`/api/admin/persons/${personId}/mover/preview`, {
        method: 'POST',
        body: JSON.stringify({
          contractSequence: contract.sequence,
          changes: {
            department: values.department || null,
            jobTitle: values.jobTitle || null,
            location: values.location || null,
            costCentre: values.costCentre || null,
            employer: values.employer || null,
            managerPersonId: manager?.value ?? null,
          },
        }),
      });
      setPreview(result);
      setStale(false);
      setMessage(result.changes.length ? 'Review the changes below.' : 'No employment changes found.');
    } catch (error) {
      setMessage(error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : error instanceof Error ? error.message : 'The change could not be previewed.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setMessage('');
    try {
      const operation = await api<{ id: string; status: string }>(`/api/admin/persons/${personId}/mover/apply`, {
        method: 'POST',
        body: JSON.stringify(preview),
      });
      setPreview(null);
      setOperationId(operation.id);
      setMessage(operation.status === 'awaiting_approval'
        ? 'Employment details saved. Target changes wait for a second person to approve them.'
        : 'Employment change completed.');
      toast({ tone: 'success', title: operation.status === 'awaiting_approval' ? 'Employment change awaiting approval' : 'Employment change applied' });
      onApplied?.();
    } catch (error) {
      setPreview(null);
      setMessage(
        error instanceof ApiError
          ? `${error.problem.detail ?? error.problem.title} Preview the current employee state again.`
          : error instanceof Error
            ? `${error.message} Preview the current employee state again.`
            : 'The change could not be applied. Preview it again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const access = preview?.access ?? [];
  const unverified = access.some((delta) => delta.unverified);
  // Not a `Panel`: a panel clips its overflow, and the manager picker's list
  // is an overlay that has to hang below the box.
  return (
    <section aria-labelledby={`mover-${personId}`} className="rounded-panel border border-border-subtle bg-bg">
      <header className="rounded-t-panel border-b border-border-subtle bg-surface px-4 py-3">
        <h2 id={`mover-${personId}`} className="text-md font-semibold text-ink">Change employment</h2>
      </header>
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="department" label="New department" value={values.department} onChange={(value) => change('department', value)} />
          <Field name="jobTitle" label="New job title" value={values.jobTitle} onChange={(value) => change('jobTitle', value)} />
          <Field name="location" label="New location" value={values.location} onChange={(value) => change('location', value)} />
          <Field name="costCentre" label="New cost centre" value={values.costCentre} onChange={(value) => change('costCentre', value)} />
          <Field name="employer" label="New employer" value={values.employer} onChange={(value) => change('employer', value)} />
          <PersonPicker name="managerPersonId" label="New manager" value={manager} onChange={changeManager} exclude={personId} />
        </div>
        <div aria-live="polite">{message && <Alert tone={message.includes('could not') || message.includes('changed since') ? 'danger' : 'info'}>{message}</Alert>}</div>
        {operationId ? <Link className="link" to={`/admin/lifecycle-operations/${operationId}`}>Open the mover operation</Link> : null}
        {preview && preview.changes.length > 0 && (
          <section aria-label="Employment changes" className="space-y-2 text-sm">
            <h3 className="font-medium text-ink">Employment changes</h3>
            {preview.contract ? <p className="text-muted">Contract {preview.contractSequence}{preview.contract.isPrimary ? ' (primary)' : ''}: {new Date(preview.contract.startDate).toLocaleDateString()} – {preview.contract.endDate ? new Date(preview.contract.endDate).toLocaleDateString() : 'open-ended'}</p> : null}
            <ul className="space-y-1">
              {preview.changes.map((item) => (
                <li key={item.field}>
                  <strong>{FIELD_LABEL[item.field] ?? item.field}</strong>: {item.field === 'managerPersonId' && preview.manager ? `${preview.manager.before ?? 'empty'} → ${preview.manager.after ?? 'empty'}` : `${String(item.before ?? 'empty')} → ${String(item.after ?? 'empty')}`}
                </li>
              ))}
            </ul>
          </section>
        )}
        {preview && (
          <section aria-label="Target access preview" className="space-y-2 text-sm">
            <h3 className="font-medium text-ink">Target access</h3>
            {unverified ? <Alert tone="warning">At least one target's entitlement catalog has not been confirmed against the target. Removals shown there are possibilities, not promises.</Alert> : null}
            {access.length === 0 ? <p className="text-muted">No enabled target system to plan against.</p> : (
              <Table tight>
                <thead><tr><th scope="col">Target</th><th scope="col">Account</th><th scope="col">Add</th><th scope="col">Retain</th><th scope="col">Remove</th></tr></thead>
                <tbody>
                  {access.map((delta) => <tr key={delta.targetSystemId}>
                    <td>{delta.targetName}{delta.unverified ? <> <Status tone="warning">unverified</Status></> : null}{delta.unprocessable ? <p className="text-muted">{delta.unprocessable.message}</p> : null}</td>
                    <td>{ACCOUNT_LABEL[delta.account]} <span className="text-muted">({delta.accountStatus})</span></td>
                    <td>{names(delta.add)}</td>
                    <td>{names(delta.retain)}</td>
                    <td>{names(delta.remove)}</td>
                  </tr>)}
                </tbody>
              </Table>
            )}
            {preview.approval?.required ? <Alert tone="info" title="Approval will be required">{preview.approval.reason}</Alert> : null}
            {preview.sloMinutes ? <p className="text-muted">Service level: {preview.sloMinutes} minutes from apply.</p> : null}
          </section>
        )}
        <FormActions
          status={stale
            ? <StateBadge state="attention">Preview out of date</StateBadge>
            : preview && preview.changes.length > 0 ? <StateBadge state="pending">Previewed, not applied</StateBadge> : null}
        >
          <Button variant={preview ? 'secondary' : 'primary'} loading={busy} onClick={() => void review()}>Preview change</Button>
          {preview && preview.changes.length > 0 && (
            <Button loading={busy} variant="danger" onClick={() => void apply()}>
              Apply reviewed change
            </Button>
          )}
        </FormActions>
      </div>
    </section>
  );
}
