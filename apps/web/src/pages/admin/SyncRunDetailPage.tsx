import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  Checkbox,
  Empty,
  Panel,
  SkeletonRows,
  Table,
  useToast,
} from '@syntra/ui';
import type { SyncRunSummary } from '@syntra/contracts';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageFacts, PageHeader } from './PageHeader.js';
import { ActionState, RunState } from './run-states.js';
import {
  CancelRunButton,
  CancellationStatus,
  cancelPending,
  isCancellable,
} from './RunCancellation.js';

/** Statuses with something left to cancel, as the server's policy has them. */
const CANCELLABLE = ['queued', 'running', 'applying', 'previewed', 'blocked', 'partially_applied'];
/** Statuses in which a worker is active, so a cancel waits for a checkpoint. */
const WORKING = ['running', 'applying'];

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
  const { data, error, reload } = useApiResource<RunDetail>(
    `/api/admin/sync-runs/${id}`,
  );
  // Fetched alongside the run rather than joined server-side: the source is
  // exactly what an administrator needs to identify while staring at a
  // blocked or conflicted run, and it costs no backend change to show it.
  const { data: sourcesData } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  /**
   * A run that has not reached the directory yet, or is still reading it.
   *
   * `POST /sources/:id/run` enqueues rather than performs, so the button that
   * sends an administrator here now returns before anything has been read.
   * Without this the page they land on says `queued` and stays saying it until
   * they think to reload — which reads exactly like a run that never started.
   */
  const inFlight = data !== null && (data.status === 'queued' || data.status === 'running');

  const [applying, setApplying] = useState(false);
  /**
   * Also followed while an apply is under way — this page's own, whose POST
   * is still open, or another administrator's — and while a cancellation
   * waits for its checkpoint. Following the apply is what lets the page show
   * `applying` and offer Cancel at all: without it the status only changes
   * when the POST returns, by which time there is nothing left to stop.
   */
  const following =
    inFlight ||
    applying ||
    (data !== null && (data.status === 'applying' || cancelPending(data)));
  useEffect(() => {
    if (!following) return;
    // Two seconds, and only while in flight. A directory read takes as long as
    // it takes; polling it faster does not make it finish sooner, and polling
    // a settled run forever is a request per viewer per interval for a row
    // that will never change again.
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [following, reload]);

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
  const toast = useToast();

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
      // The per-change statuses below are the receipt; this only says the
      // click took.
      toast({ title: 'Apply finished' });
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
      toast({ title: 'Change skipped' });
      reload();
    } catch (cause) {
      setApplyError(
        cause instanceof ApiError && cause.problem.status === 409
          ? 'That change is no longer proposed.'
          : 'That change could not be skipped.',
      );
    } finally {
      setSkipping(null);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  // Skeleton only before the first answer: this page polls while a run is
  // moving, and a reload keeps the previous run on screen.
  if (!data) {
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
        status={<RunState status={data.status} />}
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
            {isCancellable(data, CANCELLABLE) && (
              <CancelRunButton
                path={`/api/admin/sync-runs/${data.id}/cancel`}
                run={data}
                working={WORKING}
                noun="sync run"
                onChanged={reload}
              />
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
      {/* The source and the shortfall were in the header's sentence. A run
          that read 5,000 records and mapped 4,900 is not a clean run, and
          two numbers side by side say that faster than a clause did. */}
      <PageFacts
        facts={[
          { label: 'Source', value: sourceName },
          { label: 'Records read', value: data.recordsRead },
          { label: 'Mapped', value: data.recordsRead - data.mappingFailures },
        ]}
      />

      <div className="space-y-6">
        <CancellationStatus run={data} noun="sync run" />
        {data.status === 'applying' && !cancelPending(data) && (
          <Alert tone="info">Applying changes</Alert>
        )}
        {inFlight && (
          // Named as a state of the DIRECTORY READ, not of the page. "Queued"
          // and "reading" are different facts — the first says the job has not
          // started, which is what an administrator needs to know before they
          // conclude their source is unreachable — and neither of them is an
          // error, which is what an empty run screen looks like.
          <Alert tone="info">
            {data.status === 'queued'
              ? 'Queued — this run has not started yet'
              : 'Reading the directory'}
          </Alert>
        )}
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
              <Check
                className="mt-3"
                checked={confirmed}
                onChange={setConfirmed}
                label="I have read these numbers and want to apply this run anyway."
              />
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
            <p>Left untouched; not treated as absent.</p>
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
            {data.unresolvedMembers} group members outside the search base were not synced.
          </Alert>
        )}

        {data.changes.length === 0 ? (
          <Empty title="Already matches the source" />
        ) : (
          [...grouped.entries()].map(([type, changes]) => (
            <Panel
              key={type}
              title={`${LABELS[type] ?? type} (${changes.length})`}
            >
              <Table stickyHeader label={`${LABELS[type] ?? type} changes`}>
                <thead>
                  <tr>
                    <th scope="col" className="w-10">
                      <span className="sr-only">Apply</span>
                    </th>
                    <th scope="col">
                      From
                    </th>
                    <th scope="col">
                      To
                    </th>
                    <th scope="col">
                      Status
                    </th>
                    <th scope="col">
                      <span className="sr-only">Skip</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr key={change.id}>
                      <td>
                        {change.status === 'proposed' && (
                          <Checkbox
                            checked={!excluded.has(change.id)}
                            onChange={(on) =>
                              setExcluded((current) => {
                                const next = new Set(current);
                                if (on) next.delete(change.id);
                                else next.add(change.id);
                                return next;
                              })
                            }
                            label={`Apply this ${(
                              LABELS[change.changeType] ?? change.changeType
                            ).toLowerCase()} change`}
                          />
                        )}
                      </td>
                      <td>
                        {summarise(change.before)}
                      </td>
                      <td className="text-ink">
                        {summarise(change.after)}
                      </td>
                      <td>
                        {change.status === 'conflict' || change.status === 'failed' ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <ActionState status={change.status} />
                            <span className="text-sm text-muted">
                              {change.message}
                            </span>
                          </span>
                        ) : (
                          <ActionState status={change.status} />
                        )}
                      </td>
                      <td className="text-right">
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
              </Table>
            </Panel>
          ))
        )}

        <Link
          to="/admin/sources?tab=runs"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to sync runs
        </Link>
      </div>
    </>
  );
}
