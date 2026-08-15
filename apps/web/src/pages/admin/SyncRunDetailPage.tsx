import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import type { SyncRunSummary } from '@syntra/contracts';
import { api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Change {
  id: string;
  changeType: string;
  targetType: string;
  targetId: string | null;
  sourceAnchor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: string;
  message: string | null;
}

/** The run as the API returns it, plus the changes the detail route joins on. */
interface RunDetail extends SyncRunSummary {
  changes: Change[];
}

interface SourceRow {
  id: string;
  name: string;
}

const LABELS: Record<string, string> = {
  create_user: 'Create user',
  update_user: 'Update user',
  deactivate_user: 'Deactivate user',
  reactivate_user: 'Reactivate user',
  create_group: 'Create group',
  update_group: 'Update group',
  deactivate_group: 'Deactivate group',
  add_member: 'Add group member',
  remove_member: 'Remove group member',
  create_org_unit: 'Create org unit',
  update_org_unit: 'Update org unit',
};

const summarise = (value: Record<string, unknown> | null) =>
  value === null
    ? '—'
    : Object.entries(value)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');

export function SyncRunDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApiResource<RunDetail>(
    `/api/admin/sync-runs/${id}`,
  );
  // Fetched alongside the run rather than joined server-side: the source is
  // exactly what an administrator needs to identify while staring at a
  // blocked or conflicted run, and it costs no backend change to show it.
  const { data: sourcesData } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  async function onApply() {
    setApplying(true);
    setApplyError(null);
    try {
      await api(`/api/admin/sync-runs/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      reload();
    } catch {
      setApplyError('The run could not be applied.');
    } finally {
      setApplying(false);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading || !data) {
    return (
      <Panel>
        <SkeletonRows rows={6} cols={4} />
      </Panel>
    );
  }

  const sourceName =
    sourcesData?.sources.find((source) => source.id === data.sourceId)
      ?.name ?? data.sourceId;
  const blocked = data.status === 'blocked';
  const applied = data.status === 'applied' || data.status === 'partially_applied';
  const grouped = new Map<string, Change[]>();
  for (const change of data.changes) {
    grouped.set(change.changeType, [
      ...(grouped.get(change.changeType) ?? []),
      change,
    ]);
  }

  return (
    <>
      <PageHeader
        title="Sync run"
        // A run that read 5,000 records and mapped 4,900 is not a clean run,
        // so the shortfall is in the same sentence as the total rather than
        // buried further down the page.
        description={
          `${sourceName} — ${data.recordsRead} records read` +
          (data.mappingFailures > 0
            ? `, ${data.mappingFailures} not mapped`
            : '') +
          `, ${data.changes.length} proposed changes`
        }
        actions={
          <Button
            variant="primary"
            onClick={onApply}
            loading={applying}
            disabled={blocked || applied || data.changes.length === 0}
          >
            Apply
          </Button>
        }
      />

      <div className="space-y-6">
        {blocked && (
          // A blocked run leads with why. The numbers are the point: an
          // administrator needs to see the scale before deciding anything.
          <Alert tone="danger" title="This run was blocked and will not apply">
            {data.blockedReason}
          </Alert>
        )}

        {data.error && (
          <Alert tone="danger" title="This run failed">
            {data.error}
          </Alert>
        )}

        {applyError && <Alert tone="danger">{applyError}</Alert>}

        {data.mappingFailures > 0 && (
          // These records were read but could not be understood. They are
          // deliberately not proposed for deactivation — absence has to mean
          // the source dropped them, not that we failed to map them — so this
          // alert is the only place they are visible at all.
          <Alert
            tone="warning"
            title={`${data.mappingFailures} of ${data.recordsRead} records could not be mapped`}
          >
            <p>
              They were left exactly as they are: nothing was proposed for
              them, and none of them counts as absent from the source.
            </p>
            {data.mappingFailureReasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {data.mappingFailureReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}

        {data.unresolvedMembers > 0 && (
          <Alert tone="warning" title="Some memberships could not be resolved">
            {data.unresolvedMembers} group members are outside the configured
            search base and were not synced. Widen the base to include them.
          </Alert>
        )}

        {data.changes.length === 0 ? (
          <Empty title="Nothing to change">
            Syntra already matches the source. A run with no proposed changes is
            the normal result once the directory is in step.
          </Empty>
        ) : (
          [...grouped.entries()].map(([type, changes]) => (
            <Panel
              key={type}
              title={`${LABELS[type] ?? type} (${changes.length})`}
            >
              <table className="w-full text-left">
                <thead className="border-b border-border-subtle bg-surface-2">
                  <tr className="text-sm text-muted">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      From
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      To
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr
                      key={change.id}
                      className="border-b border-border-subtle last:border-0"
                    >
                      <td className="px-4 py-2.5 text-muted">
                        {summarise(change.before)}
                      </td>
                      <td className="px-4 py-2.5 text-ink">
                        {summarise(change.after)}
                      </td>
                      <td className="px-4 py-2.5">
                        {change.status === 'conflict' ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <Status tone="warning">Conflict</Status>
                            <span className="text-sm text-muted">
                              {change.message}
                            </span>
                          </span>
                        ) : change.status === 'applied' ? (
                          <Status tone="active">Applied</Status>
                        ) : change.status === 'failed' ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <Status tone="danger">Failed</Status>
                            <span className="text-sm text-muted">
                              {change.message}
                            </span>
                          </span>
                        ) : (
                          <Status tone="neutral">{change.status}</Status>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ))
        )}

        <Link
          to="/admin/sync-runs"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to sync runs
        </Link>
      </div>
    </>
  );
}
