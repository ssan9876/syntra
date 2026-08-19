import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface SourceLine {
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  lastSuccessfulReadAt: string | null;
  completeness: string;
  staleness: string;
  ageHours: number | null;
  gapCount: number;
  freshnessSlaHours: number;
}

interface SnapshotDetail {
  snapshot: {
    id: string;
    asOf: string;
    status: string;
    holdingCount: number;
    unattributableCount: number;
    coverageGapCount: number;
    unattributedAccountCount: number;
    personsWithActiveContract: number;
    sources: SourceLine[];
  };
  gapsByKind: { kind: string; _count: { _all: number } }[];
}

const COMPLETENESS_LABEL: Record<string, string> = {
  complete: 'Read completely',
  partial: 'Partially read',
  unread: 'Never read',
};

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function GovernSnapshotDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<SnapshotDetail>(
    id ? `/api/admin/govern/snapshots/${id}` : null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const snapshot = data?.snapshot;

  return (
    <>
      <PageHeader
        title="Snapshot"
        {...(snapshot
          ? {
              description: `Assembled ${longDate(snapshot.asOf)}. That is when Govern put the picture together — not when any of these systems was last read.`,
            }
          : {})}
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {snapshot && data && (
        <div className="space-y-6">
          {/* The uncomfortable numbers come FIRST, above the totals. */}
          <Panel title="What nobody can explain">
            <div className="grid grid-cols-3 gap-4 p-4">
              <div>
                <p className="text-2xl font-semibold text-ink">{snapshot.unattributableCount}</p>
                <p className="text-muted">holdings nobody can explain</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">{snapshot.coverageGapCount}</p>
                <p className="text-muted">regions this snapshot could not describe</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {snapshot.unattributedAccountCount}
                </p>
                <p className="text-muted">accounts belonging to nobody Syntra knows</p>
              </div>
            </div>
          </Panel>

          <Panel title="Totals">
            <div className="grid grid-cols-2 gap-4 p-4">
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {snapshot.holdingCount.toLocaleString()}
                </p>
                <p className="text-muted">holdings</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-ink">
                  {snapshot.personsWithActiveContract.toLocaleString()}
                </p>
                <p className="text-muted">people with an active contract</p>
              </div>
            </div>
          </Panel>

          <Panel
            title="Sources"
            description="When each system was last read, and how completely. This is the clock that matters."
          >
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle text-sm text-muted">
                <tr>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Last successful read</th>
                  <th className="px-4 py-2">Freshness</th>
                  <th className="px-4 py-2">Completeness</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {snapshot.sources.map((source) => (
                  <tr
                    key={`${source.sourceKind}:${source.sourceId}`}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="px-4 py-2 font-medium text-ink">{source.sourceName}</td>
                    <td className="px-4 py-2 text-muted">
                      {source.lastSuccessfulReadAt === null
                        ? 'never'
                        : `${longDate(source.lastSuccessfulReadAt)} — ${Math.round(
                            source.ageHours ?? 0,
                          )} hours ago`}
                    </td>
                    <td className="px-4 py-2">
                      {/* Words, not a colour alone. A badge that only differs by
                          hue is unreadable to a reader who cannot see the hue,
                          and this is the number the whole report rests on. */}
                      <Status tone={source.staleness === 'fresh' ? 'active' : 'danger'}>
                        {source.staleness === 'fresh' ? 'Fresh' : 'Stale'}
                      </Status>
                      <span className="ml-2 text-muted">
                        against a {source.freshnessSlaHours}-hour SLA
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <Status tone={source.completeness === 'complete' ? 'active' : 'warning'}>
                        {COMPLETENESS_LABEL[source.completeness] ?? source.completeness}
                      </Status>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {source.sourceKind !== 'syntraInternal' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            void api(
                              `/api/admin/govern/sources/${source.sourceKind}/${source.sourceId}/refresh`,
                              { method: 'POST' },
                            )
                              .then((result) => {
                                const owner =
                                  (result as { owner?: string }).owner ?? 'the owning subsystem';
                                setActionError(null);
                                window.alert(
                                  `Enqueued ${owner}'s own job. Govern does not read this source itself and does not hold the answer; the next snapshot will show what it found.`,
                                );
                                reload();
                              })
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof ApiError
                                    ? (cause.problem.detail ?? cause.problem.title)
                                    : 'Could not enqueue a refresh.',
                                ),
                              );
                          }}
                        >
                          Refresh now
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {data.gapsByKind.length > 0 && (
            <Panel title="Coverage gaps">
              <ul className="p-4">
                {data.gapsByKind.map((gap) => (
                  <li key={gap.kind} className="text-ink">
                    {gap._count._all} × {gap.kind.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
