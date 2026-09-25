import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Dialog, Panel, StateBadge } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * "Waiting for your approval": the held actions of a run that has ENDED.
 *
 * A target with auto-apply on applies every run it starts, and an unattended
 * apply confirms nothing, so a rename, a re-enable outside the window or the
 * re-create of a vanished account is left `proposed` on a run that finished
 * `partially_applied`. A finished run cannot be applied again, so the run's
 * Apply is not offered here and never was -- which left those changes with no
 * way through the console at all.
 *
 * Approving one does not replay it. The action was planned against the target
 * as that run read it, and writing it now could write a stale plan. The
 * server records a standing, single-use approval of exactly this change for
 * 24 hours and queues a run; that run reads the target again and applies the
 * change only if it plans the very same one. The dialog says so, because
 * "Approve" on a finished run otherwise reads as "do it now".
 */

export interface HeldPerson {
  id: string;
  givenName: string | null;
  familyName: string | null;
}

export interface HeldAction {
  id: string;
  actionType: string;
  status: string;
  before?: unknown;
  after?: unknown;
  person: HeldPerson | null;
}

export type ApprovalState = 'pending' | 'consumed' | 'expired' | 'revoked';

export interface HeldActionView {
  actionId: string;
  status?: string;
  approvable: boolean;
  reason: string | null;
  approval: {
    id: string;
    state: ApprovalState;
    approvedAt: string;
    expiresAt: string;
    consumedAt: string | null;
  } | null;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const nameOf = (person: HeldPerson | null) =>
  person === null
    ? 'Not attributed to a person'
    : `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim() || person.id;

const TITLES: Record<string, string> = {
  rename_account: 'Rename the account',
  enable_account: 'Enable the account again',
  create_account: 'Re-create the account',
};

/** Before → after, in the words of the change rather than its JSON. */
export function changeSummary(action: HeldAction): string {
  const before = record(action.before);
  const after = record(action.after);
  switch (action.actionType) {
    case 'rename_account':
      return `${text(before.correlationKey) ?? '(unknown)'} → ${text(after.correlationKey) ?? '(unknown)'}`;
    case 'enable_account':
      return 'disabled → enabled';
    case 'create_account':
      return `not at the target → ${text(after.correlationKey) ?? 'a new account'}`;
    default:
      return `${JSON.stringify(action.before ?? null)} → ${JSON.stringify(action.after ?? null)}`;
  }
}

/** What approving it will do, said before anybody presses the button. */
function consequence(action: HeldAction): string {
  const before = record(action.before);
  const after = record(action.after);
  switch (action.actionType) {
    case 'rename_account':
      return `The sign-in name for ${nameOf(action.person)} changes from ${text(before.correlationKey) ?? 'its current value'} to ${text(after.correlationKey) ?? 'the new value'}. Anything that stored the old name — saved sign-ins, profile paths, scripts — stops matching.`;
    case 'enable_account':
      return `${nameOf(action.person)}'s account is enabled again, and everything it still holds comes back with the sign-in.`;
    case 'create_account':
      return `An account for ${nameOf(action.person)} is created again at the target. It vanished; if somebody deleted it on purpose, this undoes that.`;
    default:
      return `This ${action.actionType} is applied to ${nameOf(action.person)}'s account.`;
  }
}

function ApprovalBadge({ view }: { view: HeldActionView }) {
  const approval = view.approval;
  if (approval === null) return <StateBadge state="attention">Waiting for approval</StateBadge>;
  switch (approval.state) {
    case 'pending':
      return <StateBadge state="pending">Approved — waiting for the next run</StateBadge>;
    case 'consumed':
      return <StateBadge state="healthy">Approved and applied by a later run</StateBadge>;
    case 'expired':
      return <StateBadge state="inactive">Approval expired unused</StateBadge>;
    case 'revoked':
      return <StateBadge state="inactive">Approval revoked</StateBadge>;
  }
}

export function HeldActionApprovals({
  targetId,
  runId,
  views,
  actions,
  onChanged,
}: {
  targetId: string;
  runId: string;
  views: HeldActionView[];
  actions: HeldAction[];
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState<HeldAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  const byId = new Map(actions.map((action) => [action.id, action]));
  const rows = views
    .map((view) => ({ view, action: byId.get(view.actionId) }))
    .filter((row): row is { view: HeldActionView; action: HeldAction } => row.action !== undefined);
  if (rows.length === 0) return null;

  const path = (actionId: string) =>
    `/api/admin/targets/${targetId}/runs/${runId}/actions/${actionId}/approve`;

  async function approve(action: HeldAction) {
    setBusy(true);
    setProblem(null);
    try {
      await api(path(action.id), { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setAsking(null);
      setQueued(true);
      onChanged();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The approval could not be recorded.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(action: HeldAction) {
    setBusy(true);
    setProblem(null);
    try {
      await api(path(action.id), { method: 'DELETE' });
      setQueued(false);
      onChanged();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The approval could not be revoked.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Waiting for your approval">
      <div className="space-y-3 p-4" data-testid="held-actions">
        <p className="max-w-[72ch] text-muted">
          This run finished without these changes: each needs a person&rsquo;s
          confirmation, and the run applied automatically, which confirms
          nothing. Approving one does not replay it. A new run is queued, reads
          the target again, and applies the change only if it still plans
          exactly this one. An approval is used once and lapses after 24 hours.
        </p>
        {queued && (
          <Alert tone="success" title="Approved — a run has been queued">
            It appears on the{' '}
            <Link className="link" to={`/admin/targets/${targetId}/runs`}>
              runs page
            </Link>{' '}
            once the worker picks it up.
          </Alert>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <ul className="divide-y divide-border-subtle">
          {rows.map(({ view, action }) => (
            <li key={action.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">
                    {TITLES[action.actionType] ?? action.actionType}
                  </span>
                  <span className="text-ink">{nameOf(action.person)}</span>
                  <ApprovalBadge view={view} />
                </div>
                <p className="mt-0.5 font-mono text-sm text-ink">{changeSummary(action)}</p>
                {!view.approvable && view.reason && view.approval?.state !== 'pending' && (
                  <p className="mt-0.5 text-sm text-muted">Cannot be approved here: {view.reason}.</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {view.approval?.state === 'pending' && (
                  <Button size="sm" variant="ghost" onClick={() => revoke(action)} disabled={busy}>
                    Revoke approval
                  </Button>
                )}
                {view.approvable && (
                  <Button size="sm" variant="primary" onClick={() => setAsking(action)} disabled={busy}>
                    Approve
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? `${TITLES[asking.actionType] ?? asking.actionType}?` : ''}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => setAsking(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              onClick={() => asking && approve(asking)}
            >
              Approve and queue a run
            </Button>
          </>
        }
      >
        {asking && (
          <div className="space-y-2">
            <p>{consequence(asking)}</p>
            <p className="font-mono text-sm">{changeSummary(asking)}</p>
            <p className="text-muted">
              A run is queued now. It reads the target again and applies this
              change only if it plans exactly the same one; otherwise the
              approval lapses unused after 24 hours. Nothing else in the run is
              confirmed by this.
            </p>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}
