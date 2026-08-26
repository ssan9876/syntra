import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from '@syntra/ui';
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
  // The denial reason, asked for IN THE PAGE. `window.prompt` returns null for
  // ever once a browser has been told to block dialogs, so a control built on
  // it stops working with no sign that it has -- the same reason StatusToggle
  // moved its own reason inline.
  const [denying, setDenying] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const deny = async (proposalId: string) => {
    try {
      await api(`/api/admin/govern/orphans/${proposalId}/deny`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setActionError(null);
      setDenying(null);
      setReason('');
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Could not record that denial.',
      );
    }
  };

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
                {/* NO CONFIRM CONTROL, deliberately.
                    It called a route whose injected `link` function throws 501
                    unconditionally, behind a confirmation that promised
                    "Provision's next run will evaluate that person's desired
                    state against this account" -- a consequence that cannot
                    happen. Confirming an owner means Provision ADOPTING an
                    existing directory object into a TargetAccount: an anchor,
                    a correlation key, a provenance marker and apply.ts's
                    reconciliation rules. That is a Provision slice, and doing
                    it here would put an access-bearing write inside Govern,
                    which boundaries.test.ts structurally forbids. */}
                <p className="mt-2 text-muted">
                  This guess cannot be confirmed from here yet — linking an account to a
                  person is a write Provision owns, and Govern deliberately makes none.
                  Denying a wrong guess is recorded either way, so the next snapshot stops
                  proposing it.
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  {denying === p.id ? (
                    <>
                      <Field label="Reason" value={reason} onChange={setReason} />
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={reason.trim() === ''}
                        onClick={() => void deny(p.id)}
                      >
                        Record it
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDenying(null);
                          setReason('');
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setDenying(p.id);
                        setReason('');
                      }}
                    >
                      Not them
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
