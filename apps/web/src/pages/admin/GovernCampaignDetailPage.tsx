import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Meter,
  Metric,
  MetricRow,
  Panel,
  Select,
  SkeletonRows,
  Status,
  Table,
} from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Signal {
  personId: string;
  itemsAssigned: number;
  itemsDecided: number;
  certifiedShare: number;
  medianIntervalMs: number;
  bulkShare: number;
  largestBurst: number;
  largestBurstMs: number;
  neverOpenedShare: number;
}

interface CampaignDetail {
  campaign: {
    id: string;
    name: string;
    status: string;
    dueAt: string;
    originalDueAt: string;
    snapshotId: string;
  };
  counts: {
    total: number;
    certified: number;
    revoked: number;
    requiresChange: number;
    moot: number;
    undecided: number;
    blocked: number;
  };
  coverage: { percent: number | null; denominator: number; statement: string };
  signals: Signal[];
}

export function GovernCampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<CampaignDetail>(
    id === undefined ? null : `/api/admin/govern/campaigns/${id}`,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rebaseTo, setRebaseTo] = useState('');
  const [started, setStarted] = useState<string | null>(null);

  const { data: snapshotList } = useApiResource<{
    snapshots: { id: string; asOf: string; status: string }[];
  }>('/api/admin/govern/snapshots?limit=25');

  const act = (path: string, body: unknown, onDone: (result: unknown) => void) =>
    void api(path, { method: 'POST', body: JSON.stringify(body) })
      .then((result) => {
        setActionError(null);
        onDone(result);
        reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'That did not work.',
        ),
      );

  return (
    <>
      <PageHeader
        title={data?.campaign.name ?? 'Access review'}
        description="Frozen against one snapshot. Extending the due date and rebasing onto a newer snapshot are both recorded, because a campaign that closed on time after four extensions did not close on time."
      />

      {error !== null && <Alert tone="danger">{error}</Alert>}
      {actionError !== null && <Alert tone="danger">{actionError}</Alert>}
      {started !== null && <Alert tone="info">{started}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {data !== null && (
        <div className="mt-6 space-y-6">
          <Panel title="Progress">
            <div className="space-y-5 p-4">
              {/* THE PERCENTAGE NEVER APPEARS ALONE, and it names its own
                  denominator inline. `(decided + moot) / total` is the
                  definition, printed rather than assumed: a reader who does not
                  know whether mooted items count is a reader who cannot use the
                  number.

                  Now drawn as well as printed. A reviewer scanning for "is
                  this review nearly done" was being asked to parse a sentence
                  to find out; the bar answers it before the sentence is
                  read, and the sentence still carries the definition that
                  makes the figure mean anything. */}
              {data.coverage.percent === null ? (
                <p className="text-muted">Not yet closed.</p>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-xl font-semibold tabular-nums text-ink">
                      {data.coverage.percent}% covered
                    </span>
                    <span className="text-sm text-muted">
                      of {data.coverage.denominator} items, where coverage is{' '}
                      {data.coverage.statement}
                    </span>
                  </div>
                  <Meter
                    percent={data.coverage.percent}
                    label={`covered of ${data.coverage.denominator} items`}
                  />
                </div>
              )}

              {/* Was a comma-separated sentence: "12 certified, 3 revoked, 1
                  require a change somewhere else, 0 moot, 4 undecided." Five
                  governance outcomes with nothing to tell them apart, on the
                  screen somebody opens specifically to find out where a review
                  stands. Nobody scans a sentence. */}
              <MetricRow>
                <Metric label="Certified" value={data.counts.certified} tone="success" />
                <Metric label="Revoked" value={data.counts.revoked} tone="primary" />
                <Metric
                  label="Require a change"
                  value={data.counts.requiresChange}
                  hint="Not counted as revoked anywhere in this product. Each has a remediation item with an owner."
                  quietWhenZero
                />
                <Metric
                  label="Moot"
                  value={data.counts.moot}
                  hint="The access had already gone before anybody decided."
                />
                <Metric
                  label="Undecided"
                  value={data.counts.undecided}
                  tone="warning"
                  quietWhenZero
                />
              </MetricRow>

              {data.counts.blocked > 0 && (
                <Alert tone="warning" title="Some items resolved to nobody">
                  {data.counts.blocked} item(s) have no reviewer and no fallback. They cannot be
                  decided by anybody until somebody is named.
                </Alert>
              )}
            </div>
          </Panel>

          <Panel title="Actions">
            <div className="flex flex-wrap items-end gap-2 p-4">
              {/* A campaign is created as a DRAFT and generates nothing until
                  it is started: `startCampaign` is what writes the items,
                  resolves the reviewers and sends the mail. Until this button
                  existed, every campaign the API could create sat as a draft
                  forever. */}
              {data.campaign.status === 'draft' && (
                <Button
                  variant="primary"
                  onClick={() =>
                    act(
                      `/api/admin/govern/campaigns/${data.campaign.id}/start`,
                      {},
                      (result) => {
                        const outcome = result as {
                          itemCount: number;
                          blockedCount: number;
                        };
                        setStarted(
                          `${outcome.itemCount} item(s) generated` +
                            (outcome.blockedCount === 0
                              ? '.'
                              : `, and ${outcome.blockedCount} resolved to nobody — they cannot be decided until somebody is named.`),
                        );
                      },
                    )
                  }
                >
                  Start it
                </Button>
              )}

              {/* Section 8 rule 2: a campaign whose snapshot has aged past
                  `maxSnapshotAgeDays` must be re-based before its revocations
                  can execute, and the guard refuses outright otherwise. The
                  endpoint existed; nothing could call it, so a campaign that
                  aged out was permanently unexecutable. */}
              <Select
                label="Re-base onto"
                value={rebaseTo}
                onChange={setRebaseTo}
                options={[
                  { value: '', label: 'Choose a snapshot…' },
                  ...(snapshotList?.snapshots ?? []).map((snapshot) => ({
                    value: snapshot.id,
                    label: new Date(snapshot.asOf).toLocaleString(),
                  })),
                ]}
              />
              <Button
                variant="secondary"
                disabled={rebaseTo === ''}
                onClick={() =>
                  act(
                    `/api/admin/govern/campaigns/${data.campaign.id}/rebase`,
                    { snapshotId: rebaseTo },
                    (result) => {
                      const outcome = result as { reopened: number; kept: number };
                      setStarted(
                        `${outcome.reopened} item(s) re-opened, ${outcome.kept} kept.`,
                      );
                    },
                  )
                }
              >
                Re-base
              </Button>

              <Button
                variant="secondary"
                onClick={() => {
                  const when = window.prompt('Extend the due date to (YYYY-MM-DD):');
                  if (when === null || when.trim() === '') return;
                  act(`/api/admin/govern/campaigns/${data.campaign.id}/extend`, { dueAt: when }, () => {});
                }}
              >
                Extend the due date
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  act(
                    `/api/admin/govern/campaigns/${data.campaign.id}/revocations`,
                    {},
                    (result) => setBatchId((result as { batchId: string }).batchId),
                  )
                }
              >
                Compute the revocation batch
              </Button>
              {batchId !== null && (
                <Link className="link" to={`/admin/govern/batches/${batchId}`}>
                  Open the batch
                </Link>
              )}
            </div>
          </Panel>

          {/* NOT hidden behind a toggle, and the sentence is on the panel rather
              than in a tooltip nobody opens. */}
          <Panel title="Reviewer quality" description="Context for a human, not a control.">
            <div className="p-4">
              <Alert tone="info">
                None of these are violations and this screen does not call them violations. A
                manager of a stable ten-person team who reads everything and certifies all of it
                in four minutes is behaving correctly and will look identical to a rubber-stamper
                on the aggregate.
              </Alert>
              {data.signals.length === 0 ? (
                <p className="mt-3 text-muted">
                  Nothing computed yet. These are produced when the campaign closes.
                </p>
              ) : (
                <div className="mt-3"><Table>
                  <thead>
                    <tr>
                      <th>Reviewer</th>
                      <th>Decided</th>
                      <th>Share certified</th>
                      <th>Median time on an item</th>
                      <th>Share in bulk</th>
                      <th>Longest run of consecutive decisions</th>
                      <th>Never opened the detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.signals.map((s) => (
                      <tr key={s.personId}>
                        <td>{s.personId}</td>
                        <td>
                          {s.itemsDecided} of {s.itemsAssigned}
                        </td>
                        <td>{Math.round(s.certifiedShare * 100)}%</td>
                        <td>{Math.round(s.medianIntervalMs / 1000)}s</td>
                        <td>{Math.round(s.bulkShare * 100)}%</td>
                        <td>
                          {s.largestBurst} in {Math.round(s.largestBurstMs / 1000)}s
                        </td>
                        <td>{Math.round(s.neverOpenedShare * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </Table></div>
              )}
            </div>
          </Panel>

          <p className="text-muted">
            <Status tone="neutral">{data.campaign.status.replace(/_/g, ' ')}</Status> due{' '}
            {new Date(data.campaign.dueAt).toLocaleDateString()}
            {data.campaign.dueAt !== data.campaign.originalDueAt &&
              `, extended from ${new Date(data.campaign.originalDueAt).toLocaleDateString()}`}
            .
          </p>
        </div>
      )}
    </>
  );
}
