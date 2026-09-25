import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Metric, MetricRow, Panel, StateBadge } from '@syntra/ui';
import type { VerdictResult } from './lifecycle-verdict.js';
import { canRetry, runPath } from './PersonProvisionReceipts.js';
import type { PersonProvisionReceipt } from './provision-on-create.js';
import type { PersonReceipts } from './use-person-receipts.js';

/**
 * The verdict's working: how many targets stand at each stage, and the one
 * thing to do next.
 *
 * It sits above everything else on the person because it answers the two
 * questions the page exists for — can they start, has their access ended —
 * and the answer has to arrive with its evidence and its next step, not as
 * a badge the reader then has to go and verify in four other places.
 */
export function PersonLifecycleSummary({
  personId,
  result,
  receipts,
  liveSignIns,
  liveTargetAccounts,
}: {
  personId: string;
  result: VerdictResult;
  receipts: PersonReceipts;
  liveSignIns: number;
  liveTargetAccounts: number | null;
}) {
  const { verdict, counts, firstIntervention } = result;

  if (verdict === 'ending' || verdict === 'ended') {
    return (
      <Panel title="Departure">
        <div className="space-y-4 p-4">
          <MetricRow>
            <Metric label="Live sign-ins" value={liveSignIns} tone="warning" quietWhenZero />
            <Metric
              label="Live target accounts"
              value={liveTargetAccounts ?? <span className="text-base font-medium text-muted">Not visible</span>}
              tone="warning"
              quietWhenZero
            />
          </MetricRow>
          {verdict === 'ending' && (
            <NextAction>
              <Link className="link" to="/admin/employee-work?kind=offboarding">Review unfinished departures</Link>
            </NextAction>
          )}
        </div>
      </Panel>
    );
  }

  if (verdict === 'none') {
    return (
      <Panel title="Provisioning">
        <div className="p-4">
          <NextAction>
            <Link className="link" to={`/admin/people/${personId}/access`}>Check which rules apply to this person</Link>
          </NextAction>
        </div>
      </Panel>
    );
  }

  const notApplied = counts.planned + counts.applying;
  return (
    <Panel title="Provisioning">
      <div className="space-y-4 p-4">
        <MetricRow>
          <Metric label="Not yet applied" value={notApplied} tone="primary" quietWhenZero />
          <Metric label="Awaiting read-back" value={counts.awaiting_read_back} tone="primary" quietWhenZero />
          <Metric label="Observed" value={counts.observed} tone="success" quietWhenZero />
          <Metric label="No account needed" value={counts.no_account} quietWhenZero />
          <Metric label="Needs intervention" value={counts.intervention} tone="danger" quietWhenZero />
        </MetricRow>
        {verdict === 'intervention' && firstIntervention && (
          <InterventionAction receipt={firstIntervention as PersonProvisionReceipt} receipts={receipts} />
        )}
        {verdict === 'waiting' && (
          <NextAction>
            {notApplied > 0 ? (
              <StateBadge state="running">
                Wait for {notApplied} target{notApplied === 1 ? '' : 's'} to apply
              </StateBadge>
            ) : (
              <StateBadge state="pending">Wait for directory read-back</StateBadge>
            )}
          </NextAction>
        )}
      </div>
    </Panel>
  );
}

function NextAction({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-subtle pt-3">
      <span className="text-sm font-medium text-muted">Next</span>
      {children}
    </div>
  );
}

function InterventionAction({ receipt, receipts }: { receipt: PersonProvisionReceipt; receipts: PersonReceipts }) {
  const run = runPath(receipt);
  return (
    <NextAction>
      <span className="font-medium text-ink">{receipt.targetName}</span>
      {receipt.message && <span className="text-sm text-ink">{receipt.message}</span>}
      {run && <Link className="link" to={run}>Review the {receipt.targetName} run</Link>}
      {canRetry(receipt) && (
        <Button
          size="sm"
          variant="secondary"
          loading={receipts.busy === receipt.id}
          disabled={receipts.busy !== null}
          onClick={() => { void receipts.retry(receipt); }}
        >
          Retry {receipt.targetName}
        </Button>
      )}
    </NextAction>
  );
}
