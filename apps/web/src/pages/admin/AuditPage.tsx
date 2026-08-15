import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
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
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    #
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Action
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Outcome
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium max-lg:hidden"
                  >
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr
                    key={event.id}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="px-4 py-2.5 text-muted tabular-nums">
                      {event.sequence}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                      {when(event.occurredAt)}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-ink">
                      {event.action}
                    </td>
                    <td className="px-4 py-2.5">
                      <Status
                        tone={event.outcome === 'success' ? 'active' : 'danger'}
                      >
                        {event.outcome}
                      </Status>
                    </td>
                    <td className="max-w-[28ch] truncate px-4 py-2.5 text-muted max-lg:hidden">
                      {summarize(event.payload)}
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

/** The payload shape varies by action, so render it as readable pairs. */
function summarize(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload ?? {});
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ');
}
