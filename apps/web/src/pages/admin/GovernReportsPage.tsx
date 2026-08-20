import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface ReportSourceLine {
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  lastSuccessfulReadAt: string | null;
  completeness: string;
  staleness: string;
}

interface ReportHeader {
  live: false;
  snapshotId: string;
  asOf: string;
  sources: ReportSourceLine[];
  coverageGapCount: number;
  unattributableCount: number;
  unattributedAccountCount: number;
  scopeDescription: string;
}

interface LiveReportHeader {
  live: true;
  computedAt: string;
  exportable: false;
  caveat: string;
}

interface Tri {
  known: boolean;
  value?: number;
  reason?: string;
}

interface SystemAccessRow {
  subjectKey: string;
  personId: string | null;
  displayName: string;
  bucket: string;
  resources: {
    resourceName: string;
    state: string;
    observedAt: string;
    provenance: string;
    lastCertifiedAt: string | null;
  }[];
}

interface SystemReport {
  header: ReportHeader | LiveReportHeader;
  body: { rows: SystemAccessRow[]; holderCount: Tri; withheldForScope?: number };
}

const BUCKET_LABEL: Record<string, string> = {
  unattributable: 'Nothing explains this',
  no_active_contract: 'No active contract',
  unattributed_account: 'Belongs to nobody Syntra knows',
  other: 'Explained',
};

/**
 * NEVER a zero, a dash or an omission. The reason is what makes an unknown
 * actionable rather than a dead end — §8 rule 3.
 */
const renderCount = (count: Tri) =>
  count.known ? (
    <strong className="text-ink">{(count.value ?? 0).toLocaleString()}</strong>
  ) : (
    <span className="text-warning" title={count.reason}>
      unknown — {count.reason}
    </span>
  );

export function GovernReportsPage() {
  const [systemId, setSystemId] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [mode, setMode] = useState<'snapshot' | 'live'>('snapshot');

  const { data, error, loading } = useApiResource<SystemReport>(
    submitted === null
      ? null
      : `/api/admin/govern/reports/system?systemId=${encodeURIComponent(submitted)}`,
  );

  const header = data?.header;

  return (
    <>
      <PageHeader
        title="Access reports"
        description="Who has access to a system, and what the answer is built from. Every number arrives with its header."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mb-4 flex items-center gap-3">
        <Button
          size="sm"
          variant={mode === 'snapshot' ? 'primary' : 'secondary'}
          onClick={() => setMode('snapshot')}
        >
          Point in time
        </Button>
        <Button
          size="sm"
          variant={mode === 'live' ? 'primary' : 'secondary'}
          onClick={() => setMode('live')}
        >
          Live
        </Button>
        {mode === 'live' && (
          <span className="text-muted">
            A live report has no as-of time, so it cannot be exported as evidence.
          </span>
        )}
      </div>

      <Panel title="Who has access to this system">
        <form
          className="flex items-end gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(systemId.trim() === '' ? null : systemId.trim());
          }}
        >
          <Field
            label="System"
            value={systemId}
            onChange={setSystemId}
            placeholder="the target system's id"
            hint="The id of the target system to report on."
          />
          <Button type="submit">Run the report</Button>
        </form>
      </Panel>

      {loading && <SkeletonRows rows={6} cols={4} />}

      {header && !header.live && (
        <Panel title="What this report is built from">
          <dl className="grid grid-cols-2 gap-2 p-4">
            <dt className="text-muted">Assembled</dt>
            <dd className="text-ink">{new Date(header.asOf).toLocaleString()}</dd>
            <dt className="text-muted">Holdings nobody can explain</dt>
            <dd className="text-ink">{header.unattributableCount}</dd>
            <dt className="text-muted">Regions this could not describe</dt>
            <dd className="text-ink">{header.coverageGapCount}</dd>
            <dt className="text-muted">Accounts belonging to nobody</dt>
            <dd className="text-ink">{header.unattributedAccountCount}</dd>
          </dl>
          <ul className="border-t border-border-subtle p-4">
            {header.sources.map((s) => (
              <li key={`${s.sourceKind}:${s.sourceId}`} className="text-muted">
                {s.sourceName}: last read{' '}
                {s.lastSuccessfulReadAt === null
                  ? 'never'
                  : new Date(s.lastSuccessfulReadAt).toLocaleString()}
                , {s.completeness}, {s.staleness}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data && (
        <Panel title="Holders">
          <p className="border-b border-border-subtle px-4 py-3 text-muted">
            Holders: {renderCount(data.body.holderCount)}
            {typeof data.body.withheldForScope === 'number' && data.body.withheldForScope > 0 && (
              <span className="ml-2 text-warning">
                {data.body.withheldForScope} row(s) withheld: outside your organizational scope.
              </span>
            )}
          </p>
          {data.body.rows.length === 0 ? (
            <div className="p-6">
              <Empty title="Nobody holds anything in this system">
                Either the system was read and is empty, or it is not in the snapshot at all —
                the header above says which.
              </Empty>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle text-sm text-muted">
                <tr>
                  <th className="px-4 py-2">Who</th>
                  <th className="px-4 py-2">Why they are on this list</th>
                  <th className="px-4 py-2">What they hold</th>
                </tr>
              </thead>
              <tbody>
                {data.body.rows.map((row) => (
                  <tr key={row.subjectKey} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2 font-medium text-ink">{row.displayName}</td>
                    <td className="px-4 py-2 text-muted">
                      {BUCKET_LABEL[row.bucket] ?? row.bucket}
                    </td>
                    <td className="px-4 py-2 text-muted">
                      <ul>
                        {row.resources.map((resource) => (
                          <li key={`${resource.resourceName}:${resource.observedAt}`}>
                            {resource.resourceName} — {resource.provenance}
                            {'; last confirmed '}
                            {new Date(resource.observedAt).toLocaleDateString()}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
