import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

/**
 * Operations: service status (backlog #63), background-work health and its
 * repairs (#57), and the support bundle (#64).
 *
 * Everything on this page is about THIS tenant, with one exception that is
 * labelled as such: the shared components every tenant depends on. Nothing
 * here can show another tenant's activity, because the server never sends it.
 */

type ComponentState = 'operational' | 'degraded' | 'unavailable' | 'unknown';

export interface TenantStatusBody {
  overall: 'operational' | 'degraded' | 'unavailable';
  generatedAt: string;
  components: { name: string; state: ComponentState; detail: string }[];
  degradation: {
    writeStop: { active: boolean; since: string | null; expiresAt: string | null };
    targetWriteStops: { targetId: string; name: string; since: string | null }[];
    staleReadiness: { targetId: string; name: string; reason: string; checkedAt: string | null }[];
    connectorOutages: { systemKind: string; id: string; name: string; since: string; errorClass: string }[];
    queueReadable: boolean;
  };
}

export interface JobFinding {
  id: string;
  finding: 'orphaned' | 'stuck' | 'duplicated' | 'delayed' | 'poisoned' | 'saturation_deferred';
  kind: string;
  subjectId: string;
  status: string | null;
  since: string;
  detail: string;
  repairs: ('requeue' | 'mark_failed' | 'release_lease')[];
}

export interface JobHealthBody {
  queueReadable: boolean;
  findings: JobFinding[];
}

const STATE_LABEL: Record<ComponentState, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

const COMPONENT_LABEL: Record<string, string> = {
  api: 'API',
  database: 'Database',
  queue: 'Background work',
  key_provider: 'Key provider',
  smtp: 'Outbound mail',
};

const STATE_TONE: Record<ComponentState, 'active' | 'warning' | 'danger' | 'neutral'> = {
  operational: 'active',
  degraded: 'warning',
  unavailable: 'danger',
  unknown: 'neutral',
};

const FINDING_LABEL: Record<JobFinding['finding'], string> = {
  orphaned: 'Orphaned',
  stuck: 'Stuck',
  duplicated: 'Duplicated',
  delayed: 'Delayed',
  poisoned: 'Failing repeatedly',
  saturation_deferred: 'Waiting for capacity',
};

const FINDING_TONE: Record<JobFinding['finding'], 'danger' | 'warning' | 'neutral'> = {
  orphaned: 'danger',
  stuck: 'danger',
  poisoned: 'danger',
  delayed: 'warning',
  duplicated: 'neutral',
  saturation_deferred: 'neutral',
};

const KIND_LABEL: Record<string, string> = {
  sync_run: 'Directory sync run',
  person_import_run: 'HR import run',
  provision_run: 'Provisioning run',
  person_provision_receipt: 'Target operation',
  data_export: 'Export',
  lifecycle_operation: 'Lifecycle operation',
  scheduled_job: 'Scheduled job',
};

const REPAIR_LABEL: Record<JobFinding['repairs'][number], string> = {
  requeue: 'Requeue',
  mark_failed: 'Mark failed',
  release_lease: 'Release',
};

const READINESS_REASON: Record<string, string> = {
  never_tested: 'never tested',
  configuration_changed: 'configuration changed since the last test',
  older_than_7_days: 'last tested more than a week ago',
  failing: 'last test failed',
};

const when = (iso: string | null) => (iso === null ? '—' : new Date(iso).toLocaleString());

function problemOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;
}

function StatusPanel() {
  const { data, error, loading } = useApiResource<TenantStatusBody>('/api/admin/status');
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading && !data) return <Panel title="Service status"><SkeletonRows rows={5} cols={2} /></Panel>;
  if (!data) return null;
  const d = data.degradation;
  const overallTone = data.overall === 'operational' ? 'active' : data.overall === 'degraded' ? 'warning' : 'danger';
  return (
    <Panel title="Service status" actions={<Status tone={overallTone}>{STATE_LABEL[data.overall]}</Status>}>
      <div className="space-y-5 p-4">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Shared components</h3>
          <ul className="space-y-2">
            {data.components.map((component) => (
              <li key={component.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-36 shrink-0 font-medium text-ink">{COMPONENT_LABEL[component.name] ?? component.name}</span>
                <Status tone={STATE_TONE[component.state]}>{STATE_LABEL[component.state]}</Status>
                {/* Said only when something is wrong: "The API is answering"
                    beside a green Operational is the badge read aloud. */}
                {component.state !== 'operational' && (
                  <span className="text-sm text-muted">{component.detail}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">This tenant</h3>
          <ul className="space-y-1 text-sm">
            {d.writeStop.active && (
              <li><Status tone="danger">write stop</Status> All targets since {when(d.writeStop.since)}.</li>
            )}
            {d.targetWriteStops.map((stop) => (
              <li key={stop.targetId}><Status tone="warning">write stop</Status> <Link className="text-primary underline" to={`/admin/targets/${stop.targetId}`}>{stop.name}</Link> since {when(stop.since)}.</li>
            ))}
            {d.connectorOutages.map((outage) => (
              <li key={`${outage.systemKind}-${outage.id}`}><Status tone="danger">outage</Status> {outage.name || outage.systemKind}: {outage.errorClass.replace('_', ' ')} since {when(outage.since)}.</li>
            ))}
            {d.staleReadiness.filter((r) => r.reason !== 'failing').map((stale) => (
              <li key={stale.targetId}><Status tone="warning">stale readiness</Status> <Link className="text-primary underline" to={`/admin/targets/${stale.targetId}`}>{stale.name}</Link>: {READINESS_REASON[stale.reason] ?? stale.reason}.</li>
            ))}
            {!d.writeStop.active && d.targetWriteStops.length === 0 && d.connectorOutages.length === 0 && d.staleReadiness.length === 0 && (
              <li className="text-muted">No write stops or outages</li>
            )}
          </ul>
        </div>
        <p className="text-xs text-muted">Checked {when(data.generatedAt)}</p>
      </div>
    </Panel>
  );
}

function JobHealthPanel() {
  const can = useCan();
  const mayRepair = can('tenant.manage');
  const { data, error, loading, reload } = useApiResource<JobHealthBody>('/api/admin/job-health');
  const [pending, setPending] = useState<{ finding: JobFinding; action: JobFinding['repairs'][number] } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  async function repair() {
    if (!pending) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await api<{ repair: { outcome: string; detail: string } }>('/api/admin/job-health/repair', {
        method: 'POST',
        body: JSON.stringify({ kind: pending.finding.kind, subjectId: pending.finding.subjectId, action: pending.action, reason }),
      });
      setAnnouncement(`${REPAIR_LABEL[pending.action]}: ${response.repair.outcome === 'noop' ? 'nothing to do — ' : ''}${response.repair.detail}`);
      setPending(null);
      setReason('');
      reload();
    } catch (cause) {
      setProblem(problemOf(cause, 'The repair could not be applied.'));
    } finally {
      setBusy(false);
    }
  }

  const findings = data?.findings ?? [];
  return (
    <Panel title="Background work">
      <div className="space-y-4 p-4">
        <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
        {announcement && <Alert tone="success">{announcement}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {data && !data.queueReadable && (
          <Alert tone="warning">Job queue unreadable — lost jobs go undetected.</Alert>
        )}
        {loading && !data && <SkeletonRows rows={3} cols={4} />}
        {data && findings.length === 0 && <Empty title="Nothing stuck" />}
        {findings.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th scope="col">Work</th>
                <th scope="col">Finding</th>
                <th scope="col" className="max-lg:hidden">Since</th>
                <th scope="col">What it means</th>
                <th scope="col"><span className="sr-only">Repairs</span></th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.id}>
                  <td className="text-ink">
                    {KIND_LABEL[finding.kind] ?? finding.kind}
                    {finding.status && <div className="text-xs text-muted">{finding.status}</div>}
                  </td>
                  <td><Status tone={FINDING_TONE[finding.finding]}>{FINDING_LABEL[finding.finding]}</Status></td>
                  <td className="whitespace-nowrap max-lg:hidden">{when(finding.since)}</td>
                  <td className="text-sm">{finding.detail}</td>
                  <td>
                    <div className="flex justify-end gap-2">
                      {mayRepair && finding.repairs.map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant={action === 'requeue' ? 'secondary' : 'danger-quiet'}
                          onClick={() => { setPending({ finding, action }); setProblem(null); }}
                        >
                          {REPAIR_LABEL[action]}
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {pending && (
          <div className="space-y-3 rounded-panel border border-border-subtle p-4">
            <p className="font-medium text-ink">
              {REPAIR_LABEL[pending.action]} this {(KIND_LABEL[pending.finding.kind] ?? pending.finding.kind).toLowerCase()}?
            </p>
            <p className="text-sm text-muted">{pending.finding.detail}</p>
            <Field label="Reason" value={reason} onChange={setReason} autoFocus />
            <div className="flex gap-2">
              <Button
                variant={pending.action === 'requeue' ? 'primary' : 'danger'}
                loading={busy}
                disabled={reason.trim().length < 10}
                onClick={() => void repair()}
              >
                {REPAIR_LABEL[pending.action]}
              </Button>
              <Button variant="secondary" onClick={() => { setPending(null); setReason(''); }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

const WINDOWS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
];

function SupportBundlePanel() {
  const [days, setDays] = useState('1');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  async function generate() {
    setBusy(true);
    setMessage(null);
    try {
      const from = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
      await api('/api/admin/exports', { method: 'POST', body: JSON.stringify({ kind: 'support_bundle', params: { from } }) });
      setMessage({ tone: 'success', text: 'Support bundle requested.' });
    } catch (cause) {
      setMessage({ tone: 'danger', text: problemOf(cause, 'The support bundle could not be requested.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Support bundle">
      <div className="space-y-4 p-4">
        <div role="status" aria-live="polite">
          {message && <Alert tone={message.tone}>{message.text}{message.tone === 'success' && <> <Link className="underline" to="/admin/activity?tab=exports">Open exports</Link></>}</Alert>}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Covering" value={days} onChange={setDays} options={WINDOWS} className="w-56" />
          <Button loading={busy} onClick={() => void generate()}>Generate support bundle</Button>
        </div>
      </div>
    </Panel>
  );
}

export function OperationsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader title="Operations" />
      <div className="space-y-6">
        <StatusPanel />
        <JobHealthPanel />
        {can('tenant.manage') && <SupportBundlePanel />}
      </div>
    </>
  );
}
