import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Proposal {
  id: string;
  systemId: string;
  accountRef: string;
  personId: string;
  proposedName: string;
  confidence: number;
  because: string;
}

export function GovernOrphansPage() {
  const { data, error, loading, reload } = useApiResource<{ proposals: Proposal[] }>(
    '/api/admin/govern/orphans',
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const proposals = data?.proposals ?? [];

  return (
    <>
      <PageHeader
        title="Orphan accounts"
        description="Accounts that belong to nobody Syntra knows, and Govern's best guess at who they are. A guess is never applied on its own."
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      <Panel>
        {loading && <SkeletonRows rows={5} cols={3} />}
        {!loading && proposals.length === 0 && (
          <div className="p-6">
            <Empty title="No accounts waiting for an owner">
              Build a snapshot and any account in a target system with no linked person is
              proposed here, with the evidence behind the guess.
            </Empty>
          </div>
        )}
        {!loading && proposals.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {proposals.map((p) => (
              <li key={p.id} className="p-4">
                <p className="font-medium text-ink">
                  {p.accountRef} in {p.systemId} → {p.proposedName}
                </p>
                <p className="text-muted">
                  {Math.round(p.confidence * 100)}% — {p.because}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      // A wrong link is somebody's access, not a labelling mistake.
                      if (
                        !window.confirm(
                          `Link ${p.accountRef} to ${p.proposedName}? Provision's next run will evaluate that person's desired state against this account.`,
                        )
                      ) {
                        return;
                      }
                      void api(`/api/admin/govern/orphans/${p.id}/confirm`, { method: 'POST' })
                        .then(() => {
                          setActionError(null);
                          reload();
                        })
                        .catch((cause: unknown) =>
                          setActionError(
                            cause instanceof ApiError
                              ? (cause.problem.detail ?? cause.problem.title)
                              : 'Could not confirm that owner.',
                          ),
                        );
                    }}
                  >
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const reason = window.prompt('Why is this not the owner?');
                      if (reason === null || reason.trim() === '') return;
                      void api(`/api/admin/govern/orphans/${p.id}/deny`, {
                        method: 'POST',
                        body: JSON.stringify({ reason }),
                      })
                        .then(() => {
                          setActionError(null);
                          reload();
                        })
                        .catch((cause: unknown) =>
                          setActionError(
                            cause instanceof ApiError
                              ? (cause.problem.detail ?? cause.problem.title)
                              : 'Could not record that denial.',
                          ),
                        );
                    }}
                  >
                    Not them
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
