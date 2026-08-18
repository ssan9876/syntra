import { Link } from "react-router-dom";
import { Alert, Empty, Panel, SkeletonRows, Status } from "@syntra/ui";
import { PageHeader } from "./PageHeader.js";
import { useApiResource } from "./hooks.js";
import { REQUEST_LABEL, REQUEST_TONE, when } from "../automate/status.js";

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
  "blocked_no_approver",
  "fulfilment_failed",
  "partially_fulfilled",
];

export function RequestQueuePage() {
  const { data, error, loading } = useApiResource<{ requests: QueueRow[] }>(
    "/api/admin/automate/requests",
  );

  const rows = [...(data?.requests ?? [])].sort((a, b) => {
    const aStuck = STUCK.includes(a.status) ? 0 : 1;
    const bStuck = STUCK.includes(b.status) ? 0 : 1;
    if (aStuck !== bStuck) return aStuck - bStuck;
    return a.submittedAt.localeCompare(b.submittedAt);
  });

  return (
    <>
      <PageHeader
        title="Requests"
        description="Every request in this tenant, with the stuck ones first."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={6} cols={4} />}
          {!loading && rows.length === 0 && (
            <div className="p-6">
              <Empty title="No requests yet">
                Requests appear here as soon as somebody asks for something.
              </Empty>
            </div>
          )}
          {!loading && rows.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Product
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    For
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Asked
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/automate/requests/${row.id}`}
                        className="text-ink hover:text-primary"
                      >
                        {row.product?.name ?? "Requested access"}
                      </Link>
                      {row.statusReason && (
                        <p className="text-sm text-muted">{row.statusReason}</p>
                      )}
                      {row.items
                        .filter((item) => item.status === "failed")
                        .map((item, index) => (
                          // The target's own message. It is the only thing that
                          // says what to fix.
                          <p key={index} className="text-sm text-danger">
                            {item.resourceId}: {item.message}
                          </p>
                        ))}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {row.subjectPersonId}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {when(row.submittedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Status tone={REQUEST_TONE[row.status] ?? "neutral"}>
                        {REQUEST_LABEL[row.status] ?? row.status}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
