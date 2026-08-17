import { Link } from 'react-router-dom';
import {
  Alert,
  Empty,
  Panel,
  SkeletonRows,
  Status,
  buttonClasses,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface TargetRow {
  id: string;
  name: string;
  enabled: boolean;
  enforcementMode: 'additive' | 'authoritative';
  schedule: string | null;
  lastRunAt: string | null;
  lastAppliedRunAt: string | null;
  /** Ruling P4. Written by the scheduler since Task 16; read here. */
  consecutiveSkippedRuns: number;
  lastSkipReason: string | null;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : 'Never run';

/**
 * The one column that answers "is this target actually working?".
 *
 * Ruling P4: a target that has skipped repeatedly must be *visibly*
 * distinguishable from one running cleanly. The count and the reason are
 * written to `TargetSystem` on every skipped schedule and, until this column
 * existed, were read by nothing — which this programme has already rejected
 * once, when an audit event nobody reads was offered as sufficient surfacing
 * for forced enrolment. A skipped schedule is not a quiet fact: the target has
 * silently stopped provisioning, and the count is how long it has been doing
 * so.
 *
 * Ordered deliberately. A disabled target that has also been skipping reads as
 * skipping, because that is the more surprising of the two: a schedule that
 * did not start is a fault, and "disabled" is a decision somebody made.
 */
function health(target: TargetRow): {
  tone: 'active' | 'inactive' | 'danger';
  label: string;
  title?: string;
} {
  if (target.consecutiveSkippedRuns > 0) {
    return {
      tone: 'danger',
      label: `${target.consecutiveSkippedRuns} scheduled run${
        target.consecutiveSkippedRuns === 1 ? '' : 's'
      } skipped`,
      ...(target.lastSkipReason === null ? {} : { title: target.lastSkipReason }),
    };
  }
  if (!target.enabled) return { tone: 'inactive', label: 'Disabled' };
  return { tone: 'active', label: 'Running cleanly' };
}

export function TargetsPage() {
  const { data, error, loading } = useApiResource<{ targets: TargetRow[] }>(
    '/api/admin/targets',
  );

  return (
    <>
      <PageHeader
        title="Target systems"
        description="Where Provision creates and maintains accounts. Nothing is written until a run is reviewed."
        actions={
          <Link to="/admin/targets/new" className={buttonClasses('primary')}>
            New target
          </Link>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={4} cols={5} />}

          {!loading && data?.targets.length === 0 && (
            <div className="p-6">
              <Empty
                title="No target systems yet"
                action={
                  <Link
                    to="/admin/targets/new"
                    className={buttonClasses('primary')}
                  >
                    Connect a target
                  </Link>
                }
              >
                A target is where Provision writes accounts and entitlements.
                Directory sources read; targets are written to.
              </Empty>
            </div>
          )}

          {!loading && data && data.targets.length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Enforcement
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium max-sm:hidden"
                  >
                    Schedule
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium max-sm:hidden"
                  >
                    Last run
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.targets.map((target) => {
                  const state = health(target);
                  return (
                    <tr
                      key={target.id}
                      className="border-b border-border-subtle last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/admin/targets/${target.id}`}
                          className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                        >
                          {target.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        {/* Ruling P2: the mode is per target and visible on
                            the target's own screen. Authoritative is the mode
                            that removes what Provision did not grant, so it
                            is never the quiet one. */}
                        <Status
                          tone={
                            target.enforcementMode === 'authoritative'
                              ? 'warning'
                              : 'neutral'
                          }
                        >
                          {target.enforcementMode}
                        </Status>
                      </td>
                      <td className="px-4 py-2.5 text-muted max-sm:hidden">
                        {target.schedule ?? 'By hand only'}
                      </td>
                      <td className="px-4 py-2.5 text-muted max-sm:hidden">
                        {when(target.lastRunAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span title={state.title}>
                          <Status tone={state.tone}>{state.label}</Status>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
