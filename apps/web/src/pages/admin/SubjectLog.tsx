import { Alert, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';

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

/**
 * What happened to one account, or one person, and what they did.
 *
 * The audit log answers "everything, in order", which is complete and
 * therefore useless as a place to notice something about ONE subject. This is
 * the same log with the question narrowed to whoever is on the screen — the
 * detail an administrator opened the account for in the first place, rather
 * than a link to a feed they then have to search.
 *
 * Three decisions worth keeping:
 *
 *  - **The filter is the server's.** Fetching a recent page and narrowing it in
 *    the browser silently drops everything older than the window, so a quiet
 *    account reads as one nothing ever happened to. That is a wrong answer
 *    presented as a confident one.
 *  - **Several subjects at once.** A person's history is their own record plus
 *    every account linked to them; the person page already holds that list, so
 *    it passes all of them and the endpoint stays ignorant of what a person is.
 *  - **No subjects means no request.** An empty list would drop the filter and
 *    return the entire tenant's log, which is the opposite of what this panel
 *    is for.
 *
 * Without `audit.read` the panel still renders, and says the log is not
 * visible.
 *
 * It used to render as nothing at all, on the reasoning that a permanent
 * permission error tells an administrator about a right they cannot grant
 * themselves, once per visit. That reasoning is right where this console
 * applies it elsewhere — a nav link the reader cannot use is invisible among a
 * dozen others, and a tab that is never offered leaves a strip that still
 * looks complete. Absence there is unremarkable.
 *
 * A panel missing from the middle of a RECORD is not unremarkable. The reader
 * knows the screen has sections, sees a gap where one should be, and concludes
 * the feature failed to load — which is the one thing this is not. So the
 * heading stays, every reader gets the same record shape, and only the
 * contents differ.
 *
 * The permission is NAMED, deliberately. The objection to naming it was that a
 * reader cannot grant it to themselves; the answer is that without the name
 * they cannot ask the person who can. `audit.read` is a concrete noun on the
 * Roles screen, not jargon, to the only audience that sees this.
 *
 * Still makes no request: the server would refuse it, and a 403 in the network
 * log is a support question nobody needs to answer.
 */
export function SubjectLog({ subjects }: { subjects: string[] }) {
  const can = useCan();
  const allowed = can('audit.read');

  const query = subjects
    .map((id) => `subject=${encodeURIComponent(id)}`)
    .join('&');
  // Null rather than a bare `/audit`: see the note above about an empty
  // subject list. Also null without the permission, so the hook makes no
  // request the server would refuse.
  const path =
    allowed && subjects.length > 0 ? `/api/admin/audit?limit=50&${query}` : null;

  const { data, error, loading } = useApiResource<AuditResponse>(path);

  if (!allowed) {
    return (
      <Panel title="Activity">
        <Empty title="Not visible to you">
          Reading an account&apos;s history needs the <code>audit.read</code>{' '}
          permission.
        </Empty>
      </Panel>
    );
  }

  // Narrowed once, here. A 200 that arrives without its collection — an error
  // document, a truncated proxy reply — must render as an empty log rather
  // than throw inside render and take the whole screen with it.
  const events = data?.events ?? [];

  return (
    <Panel title="Activity">
      {error && (
        <div className="p-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {!error && data && !data.chainValid && (
        // Leads, as it does on the full log. Rendering a tampered log as if it
        // were trustworthy is worse than having no log.
        <div className="p-4">
          <Alert tone="danger" title="This audit log has been altered">
            Verification failed at entry {data.brokenAtSequence}. An entry at or
            before that point was changed or removed outside Syntra. Treat
            everything below as unverified and investigate the database
            directly.
          </Alert>
        </div>
      )}

      {/* NO "chain verified" line, unlike the full log. `chainValid` is a
          statement about every entry ever recorded; saying it above a filtered
          slice would read as a claim that these particular rows were verified
          together, which is not what was checked. The warning above is
          asymmetric on purpose — a tamper anywhere in the chain is relevant to
          a reader of any part of it, and a clean chain is not evidence about
          this subject. */}

      {loading && <SkeletonRows rows={5} cols={4} />}

      {!loading && !error && events.length === 0 && (
        <div className="p-6">
          <Empty title="Nothing recorded yet" />
        </div>
      )}

      {!loading && !error && events.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col" className="max-lg:hidden">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap">{when(event.occurredAt)}</td>
                <td className="text-ink">{event.action}</td>
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
  );
}

/** The payload shape varies by action, so render it as readable pairs. */
function summarize(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload ?? {});
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ');
}
