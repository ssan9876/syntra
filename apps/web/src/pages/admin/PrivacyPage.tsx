import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Check, Empty, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

/**
 * Data-subject requests (backlog #70): the case register, and opening a case.
 *
 * A case is about one person, so opening one starts from finding that person.
 * The search reads the person register, which needs `identity.read`; a
 * privacy officer without it can still arrive here from the person's own page
 * (`?person=<id>`), which is where most cases start.
 */

export interface PrivacyCaseSummary {
  id: string;
  reference: string;
  personId: string;
  personName: string;
  status: 'open' | 'closed';
  requestTypes: string[];
  receivedAt: string;
  dueAt: string;
  overdue: boolean;
  erasureStatus: 'pending_approval' | 'completed' | 'cancelled' | null;
}

interface PersonHit {
  id: string;
  givenName: string;
  familyName: string;
  externalId: string | null;
  status: string;
}

export const REQUEST_TYPE_LABEL: Record<string, string> = {
  access: 'Access',
  rectification: 'Rectification',
  restriction: 'Restriction',
  erasure: 'Erasure',
};

export const VERIFICATION_METHODS = [
  { value: 'in_person', label: 'In person' },
  { value: 'known_channel', label: 'Known contact channel' },
  { value: 'document', label: 'Identity document' },
  { value: 'authenticated_session', label: 'Signed-in session' },
  { value: 'other', label: 'Other' },
];

const MIN_TEXT = 10;

function message(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : 'The request failed.';
}

const day = (iso: string) => new Date(iso).toLocaleDateString();

function OpenCaseForm({ initialPersonId, onOpened }: { initialPersonId: string | null; onOpened(id: string): void }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<PersonHit[] | null>(null);
  const [personId, setPersonId] = useState<string | null>(initialPersonId);
  const [personLabel, setPersonLabel] = useState<string | null>(initialPersonId);
  const [types, setTypes] = useState<Record<string, boolean>>({ access: true });
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('document');
  const [attestation, setAttestation] = useState('');
  const [dueInDays, setDueInDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    try {
      const found = await api<{ persons: PersonHit[] }>(`/api/admin/persons?q=${encodeURIComponent(term)}&pageSize=10`);
      setHits(found.persons);
    } catch (cause) {
      setError(message(cause));
    }
  };

  const chosen = Object.entries(types).filter(([, on]) => on).map(([type]) => type);
  const due = Number(dueInDays);
  const ready = personId !== null && chosen.length > 0 && reason.trim().length >= MIN_TEXT
    && attestation.trim().length >= MIN_TEXT && Number.isInteger(due) && due >= 1 && due <= 90;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const created = await api<{ case: { id: string } }>('/api/admin/privacy/cases', {
        method: 'POST',
        body: JSON.stringify({
          personId, requestTypes: chosen, reason: reason.trim(), verificationMethod: method,
          verificationAttestation: attestation.trim(), dueInDays: due,
        }),
      });
      onOpened(created.case.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Open a case">
      <div className="space-y-4 p-4">
        {error ? <Alert tone="warning">{error}</Alert> : null}
        {personId === null ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Find the person" value={term} onChange={setTerm} placeholder="Name, email or HR id" />
              <Button variant="secondary" disabled={term.trim().length === 0} onClick={() => void search()}>Search</Button>
            </div>
            {hits !== null && hits.length === 0 ? <p className="text-sm text-muted">Nobody matches.</p> : null}
            {hits && hits.length > 0 ? (
              <ul className="space-y-1">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <Button
                      variant="secondary"
                      onClick={() => { setPersonId(hit.id); setPersonLabel(`${hit.givenName} ${hit.familyName}${hit.externalId ? ` (${hit.externalId})` : ''}`); }}
                    >
                      {hit.givenName} {hit.familyName}{hit.externalId ? ` · ${hit.externalId}` : ''}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Subject</span>
            <span className="font-medium text-ink">{personLabel}</span>
            <Button variant="secondary" onClick={() => { setPersonId(null); setPersonLabel(null); }}>Change</Button>
          </div>
        )}

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-ink">What the person asked for</legend>
          {Object.entries(REQUEST_TYPE_LABEL).map(([type, label]) => (
            <Check key={type} label={label} checked={types[type] === true} onChange={(on) => setTypes({ ...types, [type]: on })} />
          ))}
        </fieldset>
        <Field
          label="Request and how it arrived"
          value={reason}
          onChange={setReason}
          placeholder="e.g. Letter received 1 Sept, ref PRIV-9 (no personal data)"
          warning={reason.trim().length > 0 && reason.trim().length < MIN_TEXT ? `At least ${MIN_TEXT} characters` : undefined}
        />
        <Select label="Identity verified by" value={method} onChange={setMethod} options={VERIFICATION_METHODS} />
        <Field
          label="Verification attestation"
          value={attestation}
          onChange={setAttestation}
          placeholder="What was checked, and by whom"
          warning={attestation.trim().length > 0 && attestation.trim().length < MIN_TEXT ? `At least ${MIN_TEXT} characters` : undefined}
        />
        <Field
          label="Due in days"
          value={dueInDays}
          onChange={setDueInDays}
          inputMode="numeric"
          warning={Number.isInteger(due) && due > 30 && due <= 90 ? 'Beyond one month: record why the deadline was extended' : undefined}
        />
        <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>Open case</Button>
      </div>
    </Panel>
  );
}

export function PrivacyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [showClosed, setShowClosed] = useState(false);
  const list = useApiResource<{ cases: PrivacyCaseSummary[] }>(
    `/api/admin/privacy/cases${showClosed ? '' : '?status=open'}`,
  );
  const cases = list.data?.cases ?? [];

  return (
    <>
      <PageHeader title="Privacy requests" />
      <div className="space-y-6">
        <Panel
          title="Cases"
          actions={<Check label="Include closed" checked={showClosed} onChange={setShowClosed} />}
        >
          {list.error ? <Alert tone="danger">{list.error}</Alert> : null}
          {list.loading && !list.data ? <SkeletonRows rows={3} cols={5} /> : null}
          {list.data && cases.length === 0 ? <Empty title="No cases" /> : null}
          {cases.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Person</th>
                  <th>Requested</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => (
                  <tr key={row.id}>
                    <td><Link className="font-medium text-primary" to={`/admin/privacy/${row.id}`}>{row.reference}</Link></td>
                    <td>{row.personName}</td>
                    <td>{row.requestTypes.map((t) => REQUEST_TYPE_LABEL[t] ?? t).join(', ')}</td>
                    <td>{day(row.dueAt)} {row.overdue ? <Status tone="danger">overdue</Status> : null}</td>
                    <td>
                      <Status tone={row.status === 'open' ? 'primary' : 'neutral'}>{row.status}</Status>
                      {row.erasureStatus === 'pending_approval' ? <> <Status tone="warning">erasure awaiting approval</Status></> : null}
                      {row.erasureStatus === 'completed' ? <> <Status tone="neutral">erased</Status></> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </Panel>
        <OpenCaseForm initialPersonId={params.get('person')} onOpened={(id) => navigate(`/admin/privacy/${id}`)} />
      </div>
    </>
  );
}
