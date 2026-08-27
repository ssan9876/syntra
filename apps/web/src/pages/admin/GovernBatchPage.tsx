import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Dispatch {
  id: string;
  route: string;
  status: string;
  message: string | null;
  sequence: number;
  holdingDescriptor: {
    subjectKey?: string;
    resourceName?: string;
    explanation?: string;
    notRemoved?: string[];
  };
}

interface BatchResponse {
  batch: {
    id: string;
    status: string;
    requiresConfirmation: boolean;
    blockedReason: string | null;
    proposedCount: number;
    requiresChangeCount: number;
    dispatchedCount: number;
    failedCount: number;
  };
  dispatches: Dispatch[];
  withheldOutOfScope: number;
}

/**
 * What each route DOES, in a sentence.
 *
 * The route name is the vocabulary this subsystem is built on, and a screen
 * that prints `requires_change_directory_source` at somebody about to press an
 * irreversible button has told them nothing.
 */
const ROUTE_LABEL: Record<string, string> = {
  automate_grant: 'Ends the grant',
  revocation_order: 'Removes it at the target',
  requires_change_rule: 'Cannot be removed: a rule grants it',
  requires_change_role: 'Cannot be removed: a Syntra role',
  requires_change_directory_source: 'Cannot be removed: a directory source owns it',
  requires_change_direct_assignment: 'Cannot be removed: assigned by hand in Syntra',
  requires_change_account: 'Cannot be removed: this is an account, not an entitlement',
  requires_change_syntra_user: 'Cannot be removed: this is a Syntra login',
};

const DISPATCHABLE = ['automate_grant', 'revocation_order'];

export function GovernBatchPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<BatchResponse>(
    id === undefined ? null : `/api/admin/govern/batches/${id}`,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = data?.dispatches ?? [];
  const dispatchable = rows.filter((d) => DISPATCHABLE.includes(d.route));
  // By ROUTE, not by status. Every row is `proposed` at compute time — the
  // route is what distinguishes a removal from a change request, and it is what
  // `confirmRevocationBatch` switches on.
  const requiresChange = rows.filter((d) => !DISPATCHABLE.includes(d.route));
  const blocked = data?.batch.status === 'blocked';
  const finished =
    data !== null &&
    ['applied', 'partially_applied', 'superseded'].includes(data.batch.status);

  return (
    <>
      <PageHeader
        title="Revocations"
        description="Nothing here has happened yet. This is the last point at which a mistake costs nothing."
      />

      {error !== null && <Alert tone="danger">{error}</Alert>}
      {actionError !== null && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {/* A blocked batch LEADS with why and the numbers — above the rows, the
          same screen shape as Directory Sync's blocked run and Provision's
          blocked plan, because an administrator should not have to learn a
          third one. */}
      {blocked && (
        <Alert tone="danger" title="This batch will not run, and confirming will not change that">
          {data?.batch.blockedReason}
        </Alert>
      )}
      {data?.batch.requiresConfirmation === true && !blocked && (
        <Alert tone="warning" title="This batch needs an explicit confirmation">
          {data.batch.blockedReason}
        </Alert>
      )}
      {data !== null && data.withheldOutOfScope > 0 && (
        <Alert tone="info" title="Some rows are outside what you may see">
          {data.withheldOutOfScope} of this batch&rsquo;s rows are about people outside your org
          unit and are not listed. The counts above are the whole batch.
        </Alert>
      )}

      {data !== null && (
        <div className="mt-6 space-y-6">
          <Panel title={`${dispatchable.length} removals Govern can dispatch`}>
            <Table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Resource</th>
                  <th>What happens</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dispatchable.map((d) => (
                  <tr key={d.id}>
                    <td>{d.holdingDescriptor.subjectKey ?? 'a subject'}</td>
                    <td>
                      {d.holdingDescriptor.resourceName ?? 'this holding'}
                    </td>
                    <td>
                      <Status tone="primary">{ROUTE_LABEL[d.route] ?? d.route}</Status>
                    </td>
                    <td className="text-right">
                      {d.status === 'proposed' && !finished ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const reason = window.prompt('Why are you skipping this one?');
                            if (reason === null || reason.trim() === '') return;
                            void api(`/api/admin/govern/dispatches/${d.id}/skip`, {
                              method: 'POST',
                              body: JSON.stringify({ reason }),
                            })
                              .then(() => {
                                setActionError(null);
                                reload();
                              })
                              .catch(() => setActionError('Could not skip that row.'));
                          }}
                        >
                          Skip
                        </Button>
                      ) : (
                        <Status tone="inactive">{d.status}</Status>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>

          {/* Its own panel. These are NOT revocations, this screen does not call
              them one, and the campaign's revoked total never includes them. */}
          {requiresChange.length > 0 && (
            <Panel
              title={`${requiresChange.length} that require a change somewhere else`}
              description="These will not be removed by this batch. Each gets a remediation item with an owner when the batch is confirmed."
            >
              <ul className="divide-y divide-border-subtle">
                {requiresChange.map((d) => (
                  <li key={d.id} className="p-4">
                    <p className="font-medium text-ink">
                      {d.holdingDescriptor.subjectKey ?? 'a subject'} &mdash;{' '}
                      {d.holdingDescriptor.resourceName ?? 'this holding'}
                    </p>
                    <p className="text-muted">
                      {d.holdingDescriptor.explanation ?? ROUTE_LABEL[d.route] ?? d.route}
                    </p>
                    {(d.holdingDescriptor.notRemoved ?? []).length > 0 && (
                      // The partial-removal trap, named. A reader who is not
                      // told which attributions survive reads "removed".
                      <p className="text-muted">
                        Not removed: {(d.holdingDescriptor.notRemoved ?? []).join(', ')}.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {!finished && (
            <Button
              variant="danger"
              disabled={blocked}
              onClick={() => {
                if (
                  !window.confirm(
                    `Dispatch ${dispatchable.length} removals? This is irreversible.`,
                  )
                ) {
                  return;
                }
                // `confirmed: true` is sent EXPLICITLY. The field is required by
                // the body schema and is never defaulted: §13's second axis is a
                // confirmation somebody makes on purpose, and a default would
                // make it a formality every caller passes by not thinking.
                void api(`/api/admin/govern/batches/${data.batch.id}/confirm`, {
                  method: 'POST',
                  body: JSON.stringify({ confirmed: true }),
                })
                  .then(() => {
                    setActionError(null);
                    reload();
                  })
                  .catch((cause: unknown) =>
                    setActionError(
                      cause instanceof ApiError
                        ? (cause.problem.detail ?? cause.problem.title)
                        : 'Could not confirm this batch.',
                    ),
                  );
              }}
            >
              Confirm and dispatch
            </Button>
          )}

          {finished && (
            <Alert tone="info" title={`This batch is ${data.batch.status}`}>
              {data.batch.dispatchedCount} dispatched, {data.batch.requiresChangeCount} require a
              change elsewhere, {data.batch.failedCount} failed. A dispatch is not an outcome:
              each one advances to <em>confirmed</em> when the owning subsystem reports it applied,
              and to <em>applied</em> only when a later snapshot no longer shows the holding.
            </Alert>
          )}
        </div>
      )}
    </>
  );
}
