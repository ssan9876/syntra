import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Panel, RefreshStatus, StateBadge, Table } from '@syntra/ui';
import { latestPerTarget, needsManualVerification, receiptStage } from './lifecycle-verdict.js';
import type { PersonProvisionReceipt } from './provision-on-create.js';
import type { PersonReceipts } from './use-person-receipts.js';

/** Where a receipt's exact run lives. The run, never "the newest run". */
export function runPath(receipt: Pick<PersonProvisionReceipt, 'targetSystemId' | 'runId'>): string | null {
  return receipt.runId ? `/admin/targets/${receipt.targetSystemId}/runs/${receipt.runId}` : null;
}

/** Receipts a retry can move: stuck on a person, or evaluated to nothing. */
export function canRetry(receipt: Pick<PersonProvisionReceipt, 'status' | 'message'>): boolean {
  return receiptStage(receipt) === 'intervention' || receipt.status === 'no_match';
}

function NotYet() {
  return <span className="text-muted">Not yet</span>;
}

/**
 * The three pieces of evidence a target owes before a person can work:
 * Syntra PLANNED the change, the target ACCEPTED it, and a read-back OBSERVED
 * it. Each is a cell of its own so a column scan shows where a hire is
 * stuck, and so "applied" can never be mistaken for "observed" — the gap
 * between those two is exactly the one the product exists to close.
 */
function stages(receipt: PersonProvisionReceipt): [ReactNode, ReactNode, ReactNode] {
  const noChange = /no change/i.test(receipt.message ?? '');
  switch (receipt.status) {
    case 'pending':
      return [<StateBadge state="pending">Queued</StateBadge>, <NotYet />, <NotYet />];
    case 'deferred':
      return [<StateBadge state="pending">Deferred</StateBadge>, <NotYet />, <NotYet />];
    case 'planning':
      return [<StateBadge state="running">Planning</StateBadge>, <NotYet />, <NotYet />];
    case 'applying':
      return [<StateBadge state="healthy">Planned</StateBadge>, <StateBadge state="running">Applying</StateBadge>, <NotYet />];
    case 'verification_pending':
      return [
        <StateBadge state="healthy">Planned</StateBadge>,
        <StateBadge state="healthy">{noChange ? 'No change needed' : 'Applied'}</StateBadge>,
        needsManualVerification(receipt)
          ? <StateBadge state="attention">Manual verification required</StateBadge>
          : <StateBadge state="pending">Waiting for directory read-back</StateBadge>,
      ];
    case 'applied':
      return [
        <StateBadge state="healthy">Planned</StateBadge>,
        <StateBadge state="healthy">{noChange ? 'No change needed' : 'Applied'}</StateBadge>,
        <StateBadge state="healthy">Observed</StateBadge>,
      ];
    case 'no_match':
      return [
        <StateBadge state="healthy">Evaluated</StateBadge>,
        <StateBadge state="inactive">No account needed</StateBadge>,
        <span className="text-muted">Not applicable</span>,
      ];
    case 'failed':
    case 'blocked': {
      const badge = <StateBadge state="blocked">{receipt.status === 'failed' ? 'Failed' : 'Blocked'}</StateBadge>;
      // With a run, planning produced something and the failure is at or
      // after the write. Without one it never got that far.
      return receipt.runId
        ? [<StateBadge state="healthy">Planned</StateBadge>, badge, <NotYet />]
        : [badge, <NotYet />, <NotYet />];
    }
    default:
      return [<StateBadge state="attention">{receipt.status}</StateBadge>, <NotYet />, <NotYet />];
  }
}

/**
 * Per-target provisioning evidence for one person.
 *
 * Presentational: the receipts are fetched once by the page, which also
 * derives the verdict in its header from them. Only the latest receipt per
 * target is a row — an older failure that a retry has since resolved is
 * history, and listing it beside the success is how a finished hire used to
 * look broken.
 */
export function PersonProvisionReceipts({ state }: { state: PersonReceipts }) {
  const { receipts, problem, forbidden, updatedAt, refreshing, busy, reload, retry } = state;
  if (forbidden) return null;
  if (receipts === null && !problem) return null;
  const rows = latestPerTarget(receipts ?? []) as PersonProvisionReceipt[];
  if (!rows.length && !problem) return null;
  return (
    <Panel
      title="Provisioning evidence"
      actions={<RefreshStatus updatedAt={updatedAt} onRefresh={reload} refreshing={refreshing} />}
    >
      {problem && (
        <div className="p-4">
          <Alert tone="warning" title="Receipts unavailable">{problem}</Alert>
        </div>
      )}
      {rows.length > 0 && (
        <Table label="Provisioning evidence">
          <thead>
            <tr>
              <th scope="col">Target</th>
              <th scope="col">Planned</th>
              <th scope="col">Applied</th>
              <th scope="col">Observed</th>
              <th scope="col">Detail</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody aria-live="polite">
            {rows.map((receipt) => {
              const [planned, applied, observed] = stages(receipt);
              const run = runPath(receipt);
              return (
                <tr key={receipt.id}>
                  <th scope="row" className="font-medium text-ink">{receipt.targetName}</th>
                  <td>{planned}</td>
                  <td>{applied}</td>
                  <td>{observed}</td>
                  <td className="text-sm text-muted">{receipt.message ?? '—'}</td>
                  <td>
                    <span className="flex flex-wrap items-center justify-end gap-3">
                      {run && (
                        <Link className="link whitespace-nowrap" to={run}>
                          Review exact run<span className="sr-only"> for {receipt.targetName}</span>
                        </Link>
                      )}
                      {canRetry(receipt) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === receipt.id}
                          disabled={busy !== null}
                          onClick={() => { void retry(receipt); }}
                        >
                          {receipt.status === 'no_match' ? 'Evaluate again' : 'Retry unfinished work'}
                          <span className="sr-only"> for {receipt.targetName}</span>
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
