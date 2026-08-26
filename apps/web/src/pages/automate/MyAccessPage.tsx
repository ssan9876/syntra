import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';
import { GRANT_LABEL, GRANT_TONE, when } from './status.js';

interface GrantRow {
  id: string;
  resourceType: string;
  resourceId: string;
  productId: string | null;
  status: string;
  startsAt: string;
  endsAt: string | null;
  needsReview: boolean;
  reviewReason: string | null;
}

const LIVE = ['scheduled', 'pending', 'active'];

export function MyAccessPage() {
  const { data, error, loading, reload } = useApiResource<{
    grants: GrantRow[];
  }>('/api/portal/automate/grants');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const handBack = async (grantId: string) => {
    setBusy(grantId);
    setProblem(null);
    try {
      await api(`/api/portal/automate/grants/${grantId}/hand-back`, {
        method: 'POST',
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">My access</h1>
        <p className="mt-1 text-muted">
          Everything you hold because you asked for it. Access from your role is
          not listed here — it comes and goes with your contracts.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="warning">{problem}</Alert>}

        <div className="mt-6">
          <Panel>
            {loading && <SkeletonRows rows={4} cols={4} />}
            {!loading && (data?.grants ?? []).length === 0 && (
              <div className="p-6">
                <Empty title="You hold nothing you asked for">
                  Anything granted from the catalog appears here with its end
                  date.
                </Empty>
              </div>
            )}
            {!loading && (data?.grants ?? []).length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {data!.grants.map((grant) => (
                  <li
                    key={grant.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div>
                      <p className="font-medium text-ink">{grant.resourceId}</p>
                      <p className="text-sm text-muted">
                        From {when(grant.startsAt)}
                        {grant.endsAt === null
                          ? ', with no end date'
                          : ` until ${when(grant.endsAt)}`}
                      </p>
                      {grant.needsReview && (
                        <p className="text-sm text-warning">
                          Flagged for review: {grant.reviewReason}. Nothing has
                          been removed.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Status tone={GRANT_TONE[grant.status] ?? 'neutral'}>
                        {GRANT_LABEL[grant.status] ?? grant.status}
                      </Status>
                      {LIVE.includes(grant.status) &&
                        grant.endsAt !== null &&
                        grant.productId && (
                          // `?replaces=` is what makes this an EXTENSION rather
                          // than a second parallel grant. Without it the form
                          // submitted an ordinary request, `replacesGrantId`
                          // stayed null, and an approval left two live rows for
                          // the same resource with two expiry dates --
                          // `fulfil.ts`'s replacement path, which ends the old
                          // grant when the new one lands, was never reached.
                          <Link to={`/catalog/${grant.productId}?replaces=${grant.id}`}>
                            <Button size="sm">Extend</Button>
                          </Link>
                        )}
                      {LIVE.includes(grant.status) && (
                        <Button
                          size="sm"
                          loading={busy === grant.id}
                          onClick={() => handBack(grant.id)}
                        >
                          Hand it back
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
