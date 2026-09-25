import { useState } from 'react';
import { Alert, Metric, MetricRow, Panel, Select, SkeletonRows, StateBadge, Table } from '@syntra/ui';
import { useApiResource } from './hooks.js';

interface HealthBucket {
  date: string; readinessChecks: number; readinessFailures: number; authenticationFailures: number;
  averageLatencyMs: number | null; p95LatencyMs: number | null; provisionActions: number;
  failedActions: number; ambiguousActions: number; throttledActions: number; retries: number; readBackChecks: number;
  incompleteReadBacks: number;
}
interface HealthSeries {
  totals: Omit<HealthBucket, 'date' | 'averageLatencyMs' | 'p95LatencyMs'>;
  series: HealthBucket[];
}

const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export function TargetHealthPanel({ targetId }: { targetId: string }) {
  const [days, setDays] = useState('30');
  const resource = useApiResource<HealthSeries>(`/api/admin/targets/${targetId}/health-series?days=${days}`);
  // During a rolling upgrade the web build can briefly meet an older API (or
  // an intermediary can return a valid JSON object for the wrong route). Do
  // not let a malformed optional panel take down the target editor.
  const data = resource.data?.totals && Array.isArray(resource.data.series) ? resource.data : null;
  const incompleteRate = data && data.totals.readBackChecks
    ? Math.round((data.totals.incompleteReadBacks / data.totals.readBackChecks) * 100)
    : 0;
  // The period's verdict, in the console's agreed states, beside the title:
  // "is this connector all right" is answered before the table is read.
  // Nothing checked and nothing written is `inactive` — no evidence either
  // way — never a quiet `healthy`.
  const totals = data?.totals;
  const verdict = !totals ? null
    : totals.authenticationFailures > 0 || totals.readinessFailures > 0 || totals.ambiguousActions > 0
      ? <StateBadge state="attention" />
      : totals.readinessChecks === 0 && totals.provisionActions === 0
        ? <StateBadge state="inactive">No activity</StateBadge>
        : <StateBadge state="healthy" />;
  return <Panel title="Connector health" actions={verdict}>
    <div className="space-y-5 p-4">
      <Select className="max-w-48" label="Period" value={days} onChange={setDays} options={RANGE_OPTIONS} />
      {resource.error ? <Alert tone="danger">{resource.error}</Alert> : null}
      {resource.data && !data ? <Alert tone="warning">Connector health history is unavailable from this server version.</Alert> : null}
      {!resource.data && !resource.error ? <SkeletonRows rows={5} cols={5} /> : null}
      {data ? <>
        <MetricRow>
          <Metric label="Authentication failures" value={data.totals.authenticationFailures} tone="danger" quietWhenZero />
          <Metric label="Throttled actions" value={data.totals.throttledActions} tone="warning" quietWhenZero />
          <Metric label="Unknown outcomes" value={data.totals.ambiguousActions} tone="danger" quietWhenZero />
          <Metric label="Retries" value={data.totals.retries} tone="warning" quietWhenZero />
          <Metric label="Incomplete read-back" value={`${incompleteRate}%`} tone={incompleteRate ? 'warning' : 'success'} />
        </MetricRow>
        <Table tight><thead><tr>
          <th scope="col">UTC date</th><th scope="col">Connection</th><th scope="col">Latency avg / p95</th>
          <th scope="col">Actions</th><th scope="col">Retries</th><th scope="col">Read-back</th>
        </tr></thead><tbody aria-live="polite">
          {[...data.series].reverse().map((row) => <tr key={row.date}>
            <td>{row.date}</td>
            <td>{row.readinessChecks ? <StateBadge state={row.readinessFailures ? 'attention' : 'healthy'}>{row.readinessChecks - row.readinessFailures}/{row.readinessChecks} passed{row.authenticationFailures ? ` · ${row.authenticationFailures} auth` : ''}</StateBadge> : '—'}</td>
            <td>{row.averageLatencyMs === null ? '—' : `${row.averageLatencyMs} / ${row.p95LatencyMs} ms`}</td>
            <td>{row.provisionActions ? `${row.provisionActions - row.failedActions - row.ambiguousActions}/${row.provisionActions} succeeded${row.throttledActions ? ` · ${row.throttledActions} throttled` : ''}${row.ambiguousActions ? ` · ${row.ambiguousActions} unknown` : ''}` : '—'}</td>
            <td>{row.retries || '—'}</td>
            <td>{row.readBackChecks ? `${row.readBackChecks - row.incompleteReadBacks}/${row.readBackChecks} complete` : '—'}</td>
          </tr>)}
        </tbody></Table>
      </> : null}
    </div>
  </Panel>;
}
