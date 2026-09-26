import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageFacts, PageHeader } from './PageHeader.js';
import { REQUEST_TYPE_LABEL, VERIFICATION_METHODS } from './PrivacyPage.js';

/**
 * One data-subject request: what was asked, what the tenant holds about the
 * person, and every act taken under the case, in order.
 *
 * The timeline is the audit log's own events for the case, so what this page
 * shows as done is what the audit chain records as done. Erasure is laid out
 * in the order the server insists on -- blockers, request, a different
 * administrator's approval -- and every refusal is shown in the server's words.
 */

interface Blocker { code: string; count: number; message: string }

interface TimelineEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  outcome: 'success' | 'failure';
  payload: Record<string, unknown> | null;
}

export interface PrivacyCaseDetail {
  case: {
    id: string;
    reference: string;
    personId: string;
    status: 'open' | 'closed';
    requestTypes: string[];
    reason: string;
    receivedAt: string;
    dueAt: string;
    verificationMethod: string;
    verificationAttestation: string;
    openedByUserId: string;
    accessExportId: string | null;
    erasureStatus: 'pending_approval' | 'completed' | 'cancelled' | null;
    erasureRequestedByUserId: string | null;
    erasureRequestedAt: string | null;
    erasureReceipt: Record<string, unknown> | null;
    closedAt: string | null;
    closureNote: string | null;
  };
  person: {
    id: string;
    name: string;
    status: string;
    externalId: string | null;
    processingRestrictedAt: string | null;
    processingRestrictedCaseId: string | null;
    erasedAt: string | null;
  };
  overdue: boolean;
  holdings: Record<string, number>;
  erasureBlockers: Blocker[];
  timeline: TimelineEvent[];
  actors: Record<string, string>;
  viewerUserId: string;
  policy: { erasureStepUpMaxAgeMinutes: number };
}

interface SubjectSection { table: string; area: string; erasure: string | null; count: number; truncated: boolean; rows: Record<string, unknown>[] }

const ACTION_LABEL: Record<string, string> = {
  'privacy.case.open': 'Case opened',
  'privacy.case.search': 'Personal data searched',
  'privacy.case.access_export': 'Access bundle requested',
  'privacy.case.rectify': 'Record rectified',
  'privacy.case.restrict': 'Processing restricted',
  'privacy.case.lift_restriction': 'Restriction lifted',
  'privacy.erasure.request': 'Erasure requested',
  'privacy.erasure.approve': 'Erasure approval',
  'privacy.erasure.cancel': 'Erasure cancelled',
  'privacy.erasure.completed': 'Erasure completed',
  'privacy.case.close': 'Case closed',
  'export.request': 'Bundle queued',
  'export.ready': 'Bundle ready',
  'export.download': 'Bundle downloaded',
  'export.expire': 'Bundle expired',
  'export.revoke': 'Bundle revoked',
  'export.fail': 'Bundle failed',
};

function message(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : 'The request failed.';
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** What a timeline entry adds beyond its label: fields, counts, the refusal. */
function detailOf(event: TimelineEvent): string {
  const payload = event.payload ?? {};
  if (event.outcome === 'failure' && typeof payload.message === 'string') return payload.message;
  if (Array.isArray(payload.fields)) return `${String(payload.record)}: ${(payload.fields as string[]).join(', ')}`;
  if (payload.tables && typeof payload.tables === 'object') {
    return `${Object.keys(payload.tables as object).length} tables`;
  }
  if (typeof payload.digest === 'string') return `receipt ${payload.digest.slice(0, 12)}…`;
  return '';
}

function download(name: string, value: unknown) {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function PrivacyCasePage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApiResource<PrivacyCaseDetail>(`/api/admin/privacy/cases/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warning' | 'success'; text: string } | null>(null);
  const [sections, setSections] = useState<SubjectSection[] | null>(null);
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState('');
  const [rectify, setRectify] = useState({ givenName: '', familyName: '', businessEmail: '', personalEmail: '' });

  if (loading && !data) return <SkeletonRows rows={4} cols={2} />;
  if (error || !data) return <Alert tone="danger">{error ?? 'The case could not be loaded.'}</Alert>;

  const { case: row, person, viewerUserId, actors } = data;
  const open = row.status === 'open';
  const base = `/api/admin/privacy/cases/${row.id}`;
  const pending = row.erasureStatus === 'pending_approval';
  const ownRequest = row.erasureRequestedByUserId === viewerUserId;
  const actor = (userId: string | null) => (userId ? (actors[userId] ?? userId.slice(0, 8)) : 'system');

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key); setNotice(null);
    try {
      const text = await action();
      setNotice({ tone: 'success', text });
      reload();
    } catch (cause) {
      setNotice({ tone: 'warning', text: message(cause) });
    } finally {
      setBusy(null);
    }
  };
  const post = (path: string, body?: unknown) =>
    api<Record<string, unknown>>(`${base}${path}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const search = () => run('search', async () => {
    const result = await api<{ sections: SubjectSection[] }>(`${base}/subject-data`);
    setSections(result.sections);
    return `Found data in ${result.sections.length} tables.`;
  });
  const bundle = () => run('bundle', async () => {
    await post('/access-bundle', {});
    return 'Access bundle queued in Activity → Exports.';
  });
  const submitRectify = () => run('rectify', async () => {
    const changes = Object.fromEntries(
      Object.entries(rectify).filter(([, value]) => value.trim() !== '').map(([key, value]) => [key, value.trim()]),
    );
    await api(`/api/admin/persons/${person.id}`, { method: 'PATCH', body: JSON.stringify({ ...changes, privacyCaseId: row.id }) });
    setRectify({ givenName: '', familyName: '', businessEmail: '', personalEmail: '' });
    return `Rectified: ${Object.keys(changes).join(', ')}.`;
  });
  const restrict = (lift: boolean) => run(lift ? 'lift' : 'restrict', async () => {
    await post(lift ? '/restriction/lift' : '/restriction');
    return lift ? 'Restriction lifted.' : 'Processing restricted.';
  });
  const erasure = (verb: 'request' | 'approve' | 'cancel') => run(verb, async () => {
    const result = await post(`/erasure/${verb}`);
    if (verb === 'approve' && result.receipt) {
      download(`syntra-erasure-receipt-${row.reference}.json`, result.receipt);
      setConfirm('');
      return 'Erasure completed. Receipt downloaded.';
    }
    return verb === 'request' ? 'Erasure requested. A different administrator must approve it.' : 'Erasure cancelled.';
  });
  const close = () => run('close', async () => {
    await post('/close', { note });
    return 'Case closed.';
  });

  const verification = VERIFICATION_METHODS.find((m) => m.value === row.verificationMethod)?.label ?? row.verificationMethod;
  const holdings = Object.entries(data.holdings).sort(([a], [b]) => a.localeCompare(b));
  const rectifyReady = Object.values(rectify).some((v) => v.trim() !== '');

  return (
    <>
      <PageHeader
        title={`${row.reference} · ${person.name}`}
        actions={<>
          {data.overdue ? <Status tone="danger">overdue</Status> : null}
          <Status tone={open ? 'primary' : 'neutral'}>{row.status}</Status>
        </>}
      />
      <div className="space-y-6">
        <div role="status" aria-live="polite">
          {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        </div>

        <PageFacts facts={[
          { label: 'Requested', value: row.requestTypes.map((t) => REQUEST_TYPE_LABEL[t] ?? t).join(', ') },
          { label: 'Received', value: when(row.receivedAt) },
          { label: 'Due', value: when(row.dueAt) },
          { label: 'Identity verified by', value: verification },
          { label: 'Person', value: <Link className="text-primary" to={`/admin/people/${person.id}`}>{person.name}</Link> },
          {
            label: 'Processing',
            value: person.erasedAt
              ? <Status tone="neutral">erased</Status>
              : person.processingRestrictedAt
                ? <Status tone="warning">restricted</Status>
                : <Status tone="active">unrestricted</Status>,
          },
        ]} />

        <Panel title="Request">
          <dl className="grid gap-2 p-4 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">Reason</dt><dd>{row.reason}</dd>
            <dt className="text-muted">Attestation</dt><dd>{row.verificationAttestation}</dd>
            {row.closureNote ? <><dt className="text-muted">Closure note</dt><dd>{row.closureNote}</dd></> : null}
          </dl>
        </Panel>

        <Panel
          title="What the tenant holds"
          actions={<>
            <Button loading={busy === 'search'} onClick={() => void search()}>Search</Button>
            {open ? <Button loading={busy === 'bundle'} onClick={() => void bundle()}>Queue access bundle</Button> : null}
          </>}
        >
          <Table tight>
            <thead><tr><th>Table</th><th>Rows</th><th>On erasure</th></tr></thead>
            <tbody>
              {(sections ?? holdings.map(([table, count]) => ({ table, count, erasure: null as string | null, truncated: false, rows: [], area: '' })))
                .map((section) => (
                  <tr key={section.table}>
                    <td className="font-mono text-xs">{section.table}</td>
                    <td>{section.count}</td>
                    <td>{section.erasure ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </Panel>

        {open && !person.erasedAt ? (
          <Panel title="Rectify">
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <Field label="Given name" value={rectify.givenName} onChange={(v) => setRectify({ ...rectify, givenName: v })} />
              <Field label="Family name" value={rectify.familyName} onChange={(v) => setRectify({ ...rectify, familyName: v })} />
              <Field label="Business email" value={rectify.businessEmail} onChange={(v) => setRectify({ ...rectify, businessEmail: v })} />
              <Field label="Personal email" value={rectify.personalEmail} onChange={(v) => setRectify({ ...rectify, personalEmail: v })} />
              <div>
                <Button loading={busy === 'rectify'} disabled={!rectifyReady} onClick={() => void submitRectify()}>Save correction</Button>
              </div>
            </div>
          </Panel>
        ) : null}

        {open ? (
          <Panel title="Restriction">
            <div className="flex flex-wrap items-center gap-3 p-4">
              {person.processingRestrictedAt
                ? <Button loading={busy === 'lift'} disabled={person.erasedAt !== null} onClick={() => void restrict(true)}>Lift restriction</Button>
                : <Button variant="danger-quiet" loading={busy === 'restrict'} onClick={() => void restrict(false)}>Restrict processing</Button>}
            </div>
          </Panel>
        ) : null}

        {row.requestTypes.includes('erasure') ? (
          <Panel
            title="Erasure"
            actions={row.erasureStatus ? <Status tone={row.erasureStatus === 'completed' ? 'neutral' : row.erasureStatus === 'pending_approval' ? 'warning' : 'neutral'}>
              {row.erasureStatus === 'pending_approval' ? 'awaiting approval' : row.erasureStatus}
            </Status> : null}
          >
            <div className="space-y-4 p-4">
              {data.erasureBlockers.length > 0 && row.erasureStatus !== 'completed' ? (
                <Alert tone="warning" title="Erasure is blocked">
                  <ul className="list-disc pl-5">
                    {data.erasureBlockers.map((b) => <li key={b.code}>{b.message}</li>)}
                  </ul>
                </Alert>
              ) : null}
              {open && !pending && row.erasureStatus !== 'completed' ? (
                <Button variant="danger" loading={busy === 'request'} disabled={data.erasureBlockers.length > 0} onClick={() => void erasure('request')}>
                  Request erasure
                </Button>
              ) : null}
              {pending ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted">Requested {when(row.erasureRequestedAt)} by {actor(row.erasureRequestedByUserId)}.</p>
                  {ownRequest ? (
                    <p className="text-sm text-muted">A different administrator must approve.</p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-3">
                      <Field
                        label="Type ERASE to approve"
                        value={confirm}
                        onChange={setConfirm}
                      />
                      <Button variant="danger" loading={busy === 'approve'} disabled={confirm !== 'ERASE'} onClick={() => void erasure('approve')}>
                        Approve erasure
                      </Button>
                    </div>
                  )}
                  <Button loading={busy === 'cancel'} onClick={() => void erasure('cancel')}>Cancel erasure</Button>
                </div>
              ) : null}
              {row.erasureStatus === 'completed' && row.erasureReceipt ? (
                <Button onClick={() => download(`syntra-erasure-receipt-${row.reference}.json`, row.erasureReceipt)}>Download receipt</Button>
              ) : null}
            </div>
          </Panel>
        ) : null}

        <Panel title="Timeline">
          <Table tight>
            <thead><tr><th>When</th><th>What</th><th>Who</th><th>Detail</th></tr></thead>
            <tbody>
              {data.timeline.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap">{when(event.occurredAt)}</td>
                  <td>
                    {ACTION_LABEL[event.action] ?? event.action}
                    {event.outcome === 'failure' ? <> <Status tone="danger">refused</Status></> : null}
                  </td>
                  <td>{actor(event.actorUserId)}</td>
                  <td className="text-muted">{detailOf(event)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        {open ? (
          <Panel title="Close case">
            <div className="flex flex-wrap items-end gap-3 p-4">
              <Field label="Closure note" value={note} onChange={setNote} placeholder="What the subject was told, and when" />
              <Button loading={busy === 'close'} disabled={pending} onClick={() => void close()}>Close case</Button>
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
