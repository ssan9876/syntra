import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import type { SyncRunSummary } from '@syntra/contracts';
import { ApiError, api } from '../../session/api.js';
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
  // Deliberately not persisted and not defaulted from anything: the tick is
  // the administrator's, for this run, in this sitting.
  const [confirmed, setConfirmed] = useState(false);
  /**
   * Changes held back from this apply, by id.
   *
   * Held as exclusions rather than as a selection so the default is "apply
   * the run as reviewed" — which is what Apply has always done — and leaving
   * something out is the deliberate act. `applyRun` takes an `only` list and
   * leaves everything else `proposed`, so a partial apply is resumable: the
   * run comes back `partially_applied` and the rest can be applied later.
   */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [skipping, setSkipping] = useState<string | null>(null);

  async function onApply(confirm: boolean, only: string[] | null) {
    setApplying(true);
    setApplyError(null);
    try {
      await api(`/api/admin/sync-runs/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          ...(only ? { only } : {}),
          ...(confirm ? { confirm: true } : {}),
        }),
      });
      setExcluded(new Set());
      reload();
    } catch {
      setApplyError('The run could not be applied.');
    } finally {
      setApplying(false);
    }
  }

  /**
   * Marks one proposed change as skipped, permanently, so the run can be
   * applied without it.
   *
   * Different from unticking it: a skip is recorded on the change and audited,
   * and the run's own record says the change was never applied. Unticking only
   * leaves it out of this apply, still proposed.
   */
  async function onSkip(changeId: string) {
    setSkipping(changeId);
    setApplyError(null);
    try {
      await api(`/api/admin/sync-changes/${changeId}/skip`, { method: 'POST' });
      reload();
    } catch (cause) {
      setApplyError(
        cause instanceof ApiError && cause.problem.status === 409
          ? 'That change is no longer proposed, so it cannot be skipped. Reload to see where it got to.'
          : 'That change could not be skipped.',
      );
    } finally {
      setSkipping(null);
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
  // Two different refusals. A run over the deactivation threshold can be
  // applied by someone who has read the numbers and said so; a run that read
  // no records cannot be applied at all, because an empty directory and an
  // unreachable one look identical from here.
  const confirmable = blocked && data.requiresConfirmation;
  /**
   * Whether anything is still waiting on a decision.
   *
   * Deliberately a property of the changes rather than of the run's status. A
   * `partially_applied` run is not finished: it is precisely the run that had
   * some of its changes held back, and refusing to apply the rest would make a
   * partial apply a discard.
   */
  const proposed = data.changes.filter((change) => change.status === 'proposed');
  const settled = proposed.length === 0;
  const included = proposed
    .filter((change) => !excluded.has(change.id))
    .map((change) => change.id);
  const partial = included.length > 0 && included.length < proposed.length;
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
          <div className="flex flex-wrap items-center gap-3">
            {partial && (
              // Said next to the button rather than in its label, so the
              // control an administrator (and every test) reaches for is still
              // called Apply.
              <span className="text-sm text-muted">
                {included.length} of {proposed.length} changes selected
              </span>
            )}
            <Button
              variant="primary"
              onClick={() => onApply(confirmable, partial ? included : null)}
              loading={applying}
              disabled={
                (blocked && !(confirmable && confirmed)) ||
                included.length === 0
              }
            >
              Apply
            </Button>
          </div>
        }
      />

      <div className="space-y-6">
        {blocked && (
          // A blocked run leads with why. The numbers are the point: an
          // administrator needs to see the scale before deciding anything.
          <Alert
            tone="danger"
            title={
              confirmable
                ? 'This run is over the threshold and needs your confirmation'
                : 'This run was blocked and will not apply'
            }
          >
            <p>{data.blockedReason}</p>
            {confirmable && (
              // A deliberate step, stated in words, before Apply does
              // anything at all. Never window.confirm: a native dialog is
              // dismissed reflexively and shows none of the numbers above.
              <label className="mt-3 flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>
                  I have read these numbers and want to apply this run anyway.
                </span>
              </label>
            )}
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

        {!settled && (
          <p className="text-muted">
            Untick a change to leave it out of this apply — it stays proposed
            and can be applied later. Skip it to record that it will not be
            applied at all.
          </p>
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
                    <th scope="col" className="w-10 px-4 py-2.5 font-medium">
                      <span className="sr-only">Apply</span>
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      From
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      To
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      <span className="sr-only">Skip</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr
                      key={change.id}
                      className="border-b border-border-subtle last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        {change.status === 'proposed' && (
                          <input
                            type="checkbox"
                            checked={!excluded.has(change.id)}
                            onChange={(e) =>
                              setExcluded((current) => {
                                const next = new Set(current);
                                if (e.target.checked) next.delete(change.id);
                                else next.add(change.id);
                                return next;
                              })
                            }
                            aria-label={`Apply this ${(
                              LABELS[change.changeType] ?? change.changeType
                            ).toLowerCase()} change`}
                            className="size-4 accent-primary"
                          />
                        )}
                      </td>
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
                        ) : change.status === 'skipped' ? (
                          <Status tone="inactive">Skipped</Status>
                        ) : (
                          <Status tone="neutral">{change.status}</Status>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {/* Only a proposed change can be skipped, and the
                            server says so with a 409. Offering the control on
                            an applied one would be offering a lie about what
                            the run did. */}
                        {change.status === 'proposed' && (
                          <Button
                            size="sm"
                            onClick={() => onSkip(change.id)}
                            loading={skipping === change.id}
                            disabled={applying || skipping !== null}
                          >
                            Skip
                          </Button>
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
