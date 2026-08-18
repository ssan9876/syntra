import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { useApiResource } from '../../session/use-api-resource.js';
import { REQUEST_LABEL, REQUEST_TONE, when } from './status.js';

interface RequestRow {
  id: string;
  status: string;
  statusReason: string | null;
  submittedAt: string;
  product: { name: string } | null;
}

export function MyRequestsPage() {
  const { data, error, loading } = useApiResource<{ requests: RequestRow[] }>(
    '/api/portal/automate/requests',
  );

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">My requests</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="mt-6">
          <Panel>
            {loading && <SkeletonRows rows={4} cols={3} />}
            {!loading && (data?.requests ?? []).length === 0 && (
              <div className="p-6">
                <Empty title="You have not asked for anything yet">
                  Anything you request appears here with where it is and who it is with.
                </Empty>
              </div>
            )}
            {!loading && (data?.requests ?? []).length > 0 && (
              <ul className="divide-y divide-border-subtle">
                {data!.requests.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <Link to={`/requests/${row.id}`} className="font-medium text-ink hover:text-primary">
                        {row.product?.name ?? 'Requested access'}
                      </Link>
                      <p className="text-sm text-muted">Asked on {when(row.submittedAt)}</p>
                      {row.statusReason && (
                        <p className="text-sm text-muted">{row.statusReason}</p>
                      )}
                    </div>
                    <Status tone={REQUEST_TONE[row.status] ?? 'neutral'}>
                      {REQUEST_LABEL[row.status] ?? row.status}
                    </Status>
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
