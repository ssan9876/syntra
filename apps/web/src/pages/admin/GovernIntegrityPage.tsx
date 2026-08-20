import { useState } from 'react';
import { Alert, Button, Panel, SkeletonRows } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface IntegrityStatus {
  headSequence: number;
  headHash: string;
  lastCheckpoint: {
    sequence: number;
    verifiedAt: string;
    signed: boolean;
    keyId: string | null;
    signatureState: string;
  } | null;
  checkpointStatement: string;
  lastCheck: {
    fromSequence: number;
    toSequence: number;
    result: string;
    startedAt: string;
    mode: string;
  } | null;
  anchoring: { configured: boolean; lastAnchoredSequence: number | null; statement: string };
}

export function GovernIntegrityPage() {
  const { data, error, loading, reload } = useApiResource<IntegrityStatus>(
    '/api/admin/govern/integrity',
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const status = data;

  return (
    <>
      <PageHeader
        title="Audit integrity"
        description="What the hash chain proves, what it cannot prove, and when it was last checked."
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={5} cols={2} />}

      {status && (
        <div className="space-y-6">
          {/* NEVER a green tick. A tenant that has not configured anchoring sees
              what that means, in the API's own words. `Alert` has no `success`
              tone, and that is convenient here rather than a limitation. */}
          <Alert
            tone={status.anchoring.configured ? 'info' : 'warning'}
            title={
              status.anchoring.configured
                ? 'Anchoring is configured'
                : 'Anchoring is not configured'
            }
          >
            {status.anchoring.statement}
          </Alert>

          <Alert tone="info" title="What the last checkpoint is worth">
            {status.checkpointStatement}
          </Alert>

          <Panel title="The chain" description="Head, last checkpoint, last verification.">
            <dl className="grid grid-cols-2 gap-2 p-4">
              <dt className="text-muted">Head sequence</dt>
              <dd className="text-ink">{status.headSequence}</dd>
              <dt className="text-muted">Last checkpoint</dt>
              <dd className="text-ink">
                {status.lastCheckpoint === null
                  ? 'none'
                  : `${status.lastCheckpoint.sequence} — ${
                      status.lastCheckpoint.signed ? 'signed' : 'unsigned'
                    }`}
              </dd>
              <dt className="text-muted">Last verification</dt>
              <dd className="text-ink">
                {status.lastCheck === null
                  ? 'never'
                  : `${status.lastCheck.mode}, ${status.lastCheck.fromSequence}–${status.lastCheck.toSequence}, ${status.lastCheck.result}`}
              </dd>
            </dl>
          </Panel>

          <Button
            onClick={() => {
              void api('/api/admin/govern/integrity/verify', { method: 'POST' })
                .then(() => {
                  setActionError(null);
                  reload();
                })
                .catch((cause: unknown) =>
                  setActionError(
                    cause instanceof ApiError
                      ? (cause.problem.detail ?? cause.problem.title)
                      : 'Could not verify the chain.',
                  ),
                );
            }}
          >
            Verify now
          </Button>
        </div>
      )}
    </>
  );
}
