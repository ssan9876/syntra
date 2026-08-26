import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows } from '@syntra/ui';
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
  // ONE header type. `LiveReportHeader` was declared here and produced by
  // nothing anywhere in the tree -- a shape the screen branched on and the
  // server could never send.
  header: ReportHeader;
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
  const [snapshotId, setSnapshotId] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const { data: snapshotList } = useApiResource<{
    snapshots: { id: string; asOf: string; status: string }[];
  }>('/api/admin/govern/snapshots?limit=25');

  const { data, error, loading } = useApiResource<SystemReport>(submitted);

  const header = data?.header;

  return (
    <>
      <PageHeader
        title="Access reports"
        description="Who has access to a system, and what the answer is built from. Every number arrives with its header."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Panel title="Who has access to this system">
        <form
          className="flex items-end gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const system = systemId.trim();
            if (system === '') {
              setSubmitted(null);
              return;
            }
            // WHICH POINT IN TIME, offered rather than assumed.
            //
            // This screen used to carry a "Live" toggle that was wired to
            // nothing: mode state was kept, a caveat was rendered, and the URL
            // was always the snapshot one -- so an administrator read a
            // snapshot believing it was live. Nothing in the tree produces a
            // `LiveReportHeader`, and a genuinely live report would mean
            // reading every connected system inside an HTTP request.
            //
            // `snapshotId` is the capability that does exist and that the
            // screen never offered. Omitted means the latest, which is what
            // `readableSnapshot` already defaults to; naming one is how an
            // auditor reads the picture a decision was made against.
            setSubmitted(
              `/api/admin/govern/reports/system?systemId=${encodeURIComponent(system)}` +
                (snapshotId === '' ? '' : `&snapshotId=${encodeURIComponent(snapshotId)}`),
            );
          }}
        >
          <Field
            label="System"
            value={systemId}
            onChange={setSystemId}
            placeholder="the target system's id"
            hint="The id of the target system to report on."
          />
          <Select
            label="Point in time"
            value={snapshotId}
            onChange={setSnapshotId}
            hint="The snapshot this report is assembled from. The latest, unless you name another."
            options={[
              { value: '', label: 'Latest complete snapshot' },
              ...(snapshotList?.snapshots ?? []).map((s) => ({
                value: s.id,
                label: `${new Date(s.asOf).toLocaleString()} — ${s.status}`,
              })),
            ]}
          />
          <Button type="submit">Run the report</Button>
        </form>
      </Panel>

      {loading && <SkeletonRows rows={6} cols={4} />}

      {header && (
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
