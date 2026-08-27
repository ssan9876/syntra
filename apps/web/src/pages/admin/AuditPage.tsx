import { Alert, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface AuditEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  action: string;
  targetType: string;
  outcome: string;
  sourceIp: string | null;
  payload: Record<string, unknown>;
}

interface AuditResponse {
  events: AuditEvent[];
  chainValid: boolean;
  brokenAtSequence?: number;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export function AuditPage() {
  const { data, error, loading } = useApiResource<AuditResponse>(
    '/api/admin/audit?limit=100',
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every privileged action, in order. Each entry is hashed against the one before it."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && data && !data.chainValid && (
        // Rendering a tampered log as if it were trustworthy would be worse
        // than having no log, so the warning leads the page.
        <div className="mb-6">
          <Alert tone="danger" title="This audit log has been altered">
            Verification failed at entry {data.brokenAtSequence}. An entry at or
            before that point was changed or removed outside Syntra. Treat
            everything below as unverified and investigate the database
            directly.
          </Alert>
        </div>
      )}

      {!error && data?.chainValid && data.events.length > 0 && (
        <p className="mb-4 flex items-center gap-2 text-muted">
          <Status tone="active">Chain verified</Status>
          <span>No entry has been altered or removed.</span>
        </p>
      )}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={8} cols={4} />}

          {!loading && data?.events.length === 0 && (
            <div className="p-6">
              <Empty title="Nothing recorded yet">
                Sign-ins, account changes and permission grants appear here as
                they happen.
              </Empty>
            </div>
          )}

          {!loading && data && data.events.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    #
                  </th>
                  <th scope="col">
                    When
                  </th>
                  <th scope="col">
                    Action
                  </th>
                  <th scope="col">
                    Outcome
                  </th>
                  <th
                    scope="col"
                    className="max-lg:hidden"
                  >
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td className="tabular-nums">
                      {event.sequence}
                    </td>
                    <td className="whitespace-nowrap">
                      {when(event.occurredAt)}
                    </td>
                    <td className="text-ink">
                      {event.action}
                    </td>
                    <td>
                      <Status
                        tone={event.outcome === 'success' ? 'active' : 'danger'}
                      >
                        {event.outcome}
                      </Status>
                    </td>
                    <td className="max-w-[28ch] truncate max-lg:hidden">
                      {summarize(event.payload)}
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

/** The payload shape varies by action, so render it as readable pairs. */
function summarize(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload ?? {});
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ');
}
