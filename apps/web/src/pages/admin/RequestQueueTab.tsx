import { Link } from 'react-router-dom';
import {
  Alert,
  buttonClasses,
  Empty,
  Identifier,
  Panel,
  RefreshStatus,
  SkeletonRows,
  StateBadge,
  Table,
  TableToolbar,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { REQUEST_LABEL, REQUEST_STATE, when } from '../automate/status.js';

interface QueueRow {
  id: string;
  status: string;
  statusReason: string | null;
  submittedAt: string;
  subjectPersonId: string;
  product: { name: string } | null;
  items: { status: string; message: string | null; resourceId: string }[];
}

/**
 * Stuck first, then everything else, each half oldest first.
 *
 * A queue ordered only by date buries the two states that actually need a
 * human: a request nobody can approve, and one that was approved and could not
 * be applied.
 */
const STUCK = [
  'blocked_no_approver',
  'fulfilment_failed',
  'partially_fulfilled',
];

export function RequestQueueTab() {
  const { data, error, loading, updatedAt, reload } = useApiResource<{ requests: QueueRow[] }>(
    '/api/admin/automate/requests',
  );

  const rows = [...(data?.requests ?? [])].sort((a, b) => {
    const aStuck = STUCK.includes(a.status) ? 0 : 1;
    const bStuck = STUCK.includes(b.status) ? 0 : 1;
    if (aStuck !== bStuck) return aStuck - bStuck;
    return a.submittedAt.localeCompare(b.submittedAt);
  });

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && data && (
        <TableToolbar>
          <RefreshStatus updatedAt={updatedAt} onRefresh={reload} refreshing={loading} />
        </TableToolbar>
      )}
      {!error && (
        <Panel>
          {!data && <SkeletonRows rows={6} cols={4} />}
          {data && rows.length === 0 && (
            <div className="p-6">
              <Empty
                title="No requests yet"
                action={
                  <Link to="/admin/requests?tab=catalog" className={buttonClasses('secondary')}>
                    Review what can be requested
                  </Link>
                }
              />
            </div>
          )}
          {rows.length > 0 && (
            <Table stickyHeader label="Request queue">
              <thead>
                <tr>
                  <th scope="col">
                    Product
                  </th>
                  <th scope="col">
                    For
                  </th>
                  <th scope="col">
                    Asked
                  </th>
                  <th scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        to={`/admin/automate/requests/${row.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {row.product?.name ?? 'Requested access'}
                      </Link>
                      {row.statusReason && (
                        <p className="text-sm text-muted">{row.statusReason}</p>
                      )}
                      {row.items
                        .filter((item) => item.status === 'failed')
                        .map((item, index) => (
                          // The target's own message. It is the only thing that
                          // says what to fix.
                          <p key={index} className="text-sm text-danger">
                            {item.resourceId}: {item.message}
                          </p>
                        ))}
                    </td>
                    <td>
                      <Identifier value={row.subjectPersonId} truncate />
                    </td>
                    <td>
                      {when(row.submittedAt)}
                    </td>
                    <td>
                      <StateBadge state={REQUEST_STATE[row.status] ?? 'setup'}>
                        {REQUEST_LABEL[row.status] ?? row.status}
                      </StateBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
