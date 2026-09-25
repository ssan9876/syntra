import { Link } from 'react-router-dom';
import {
  Alert,
  Empty,
  Panel,
  SkeletonRows,
  StateBadge,
  Status,
  Table,
  buttonClasses,
  type State,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { TenantWriteStopPanel } from './TenantWriteStopPanel.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';

interface TargetRow {
  id: string;
  name: string;
  type: string;
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
 * How each connector type reads on the list, so targets are distinguishable
 * at a glance.
 *
 * A record rather than a chain of ternaries: the previous shape read
 * "anything that is not scim2 is Active Directory", which labelled a third
 * connector type as the wrong system rather than as an unknown one.
 */
const TYPE_LABELS: Record<string, string> = {
  activeDirectory: 'Active Directory',
  scim2: 'SCIM 2.0',
  httpJson: 'REST API',
};

const typeLabel = (type: string) => TYPE_LABELS[type] ?? type;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * An **upper bound** on the gap between two fires of a cron expression.
 *
 * Deliberately not a cron parser. The rule is only ever used to decide "has
 * this target gone quiet for longer than its own schedule could explain", and
 * for that a bound that errs coarse is the safe direction: a target firing
 * every fifteen minutes is bounded at an hour rather than at fifteen minutes,
 * so it is reported late rather than reported wrongly. A field that is
 * anything but a wildcard is treated as constraining that field, whatever it
 * constrains it to.
 *
 * `null` for an expression this cannot read, which switches staleness off
 * entirely rather than guessing — the scheduler validates the expression at
 * the contract boundary (`cronExpression` in `packages/contracts/src/sync.ts`),
 * so an unreadable one here is this function's limitation, not a fault to
 * report on the target.
 */
function cadenceCeilingMs(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/);
  // Six fields is cron-parser's optional leading seconds; the coarse fields
  // are the ones that matter, so the seconds field is dropped.
  if (fields.length === 6) fields.shift();
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const open = (field: string) => field === '*' || field === '?';
  if (!open(month)) return 366 * DAY;
  if (!open(dayOfMonth)) return 31 * DAY;
  if (!open(dayOfWeek)) return 7 * DAY;
  if (!open(hour)) return DAY;
  if (!open(minute)) return HOUR;
  return MINUTE;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "3 hours", "9 days" — the coarsest unit that is not zero. */
function duration(ms: number): string {
  if (ms < HOUR) return plural(Math.max(1, Math.floor(ms / MINUTE)), 'minute');
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  return plural(Math.floor(ms / DAY), 'day');
}

/** "3 hours ago", from a fixed `now` so the badge is testable. */
function since(iso: string, now: number): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  return ms < HOUR ? 'in the last hour' : `${duration(ms)} ago`;
}

/**
 * The one column that answers "is this target actually working?".
 *
 * **It does not read `consecutiveSkippedRuns` as evidence of health.** That
 * counter answers a different question — "did a previous run block this one" —
 * and `runProvisionJob` zeroes it the moment a run *starts*, before the preview
 * is attempted (`jobs.ts`, the `consecutiveSkippedRuns: 0` update that guards
 * `return { proceed: true }`). A target whose bind credential was rotated
 * therefore starts a run every night, resets the counter, and fails; on the
 * old rule this column read *Running cleanly* for ever.
 *
 * What is actually evidence is `lastRunAt`. `run-service.ts` writes it in
 * exactly one place: the transaction that records a **finished** preview. A
 * preview that throws marks its run `failed` and never reaches it, so a target
 * whose runs all fail is a target whose `lastRunAt` has stopped moving — and a
 * scheduled target that has not completed a run in twice its own cadence is
 * reported, with the timestamp said out loud rather than left to a column that
 * `max-sm:hidden` takes away.
 *
 * Ruling P4 still leads: a target that has skipped repeatedly must be visibly
 * distinguishable from one running cleanly, and a disabled target that has
 * also been skipping reads as skipping, because a schedule that did not start
 * is a fault and "disabled" is a decision somebody made.
 */
function health(
  target: TargetRow,
  now: number,
): {
  /**
   * Absent where the row makes no claim about health: a target run by hand
   * is not late, and not healthy either — it is simply when it last ran.
   */
  state?: State;
  label: string;
  title?: string;
} {
  if (target.consecutiveSkippedRuns > 0) {
    return {
      state: 'blocked',
      label: `${target.consecutiveSkippedRuns} scheduled run${
        target.consecutiveSkippedRuns === 1 ? '' : 's'
      } skipped`,
      ...(target.lastSkipReason === null ? {} : { title: target.lastSkipReason }),
    };
  }
  if (!target.enabled) return { state: 'inactive', label: 'Disabled' };

  const stale =
    'A run records this timestamp only when its preview finishes. A run that ' +
    'starts and then fails — a rotated bind credential, a controller that is ' +
    'not answering — leaves it exactly where it was.';

  if (target.schedule === null) {
    // Nothing is late when nothing is scheduled, so this states the fact and
    // makes no claim about health either way.
    return target.lastRunAt === null
      ? { state: 'setup', label: 'Never run', title: 'This target runs by hand only.' }
      : {
          label: `Ran ${since(target.lastRunAt, now)}`,
          title: 'This target runs by hand only.',
        };
  }

  if (target.lastRunAt === null) {
    return {
      state: 'blocked',
      label: 'No run has ever completed',
      title: stale,
    };
  }

  const ceiling = cadenceCeilingMs(target.schedule);
  const age = now - new Date(target.lastRunAt).getTime();
  if (ceiling !== null && age > 2 * ceiling) {
    return {
      state: 'blocked',
      label: `No completed run for ${duration(age)}`,
      title: stale,
    };
  }

  return {
    state: 'healthy',
    label: `Ran ${since(target.lastRunAt, now)}`,
    title:
      'A run completed within this target’s own schedule. This says a run ' +
      'finished, not that everything it proposed was applied.',
  };
}

export function TargetsPage() {
  const { data, error } = useApiResource<{ targets: TargetRow[] }>(
    '/api/admin/targets',
  );
  // Narrowed once, and reused by both the summary cards and the table.
  // The optional chain used to guard `data` and then walk straight into
  // the collection, so a 200 arriving without it threw inside render.
  const targets = data?.targets ?? [];

  // Read once per paint rather than per row, so two rows in one table cannot
  // be judged against two different clocks.
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Target systems"
        actions={
          <Link to="/admin/targets/new" className={buttonClasses('primary')}>
            New target
          </Link>
        }
      />

      {/* A target that is skipping its schedule is this module's quiet
          failure: it looks healthy, it is enabled, and nothing is being
          provisioned. Silent while it is zero. */}
      <StatGrid>
        <StatCard label="Targets" value={targets.length} />
        <StatCard label="Enabled" value={targets.filter((t) => t.enabled).length} tone="success" />
        <StatCard
          label="Skipping runs"
          value={targets.filter((t) => t.consecutiveSkippedRuns > 0).length}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      {/* Above the list, because while it is active nothing below it writes. */}
      <div className="mb-5">
        <TenantWriteStopPanel />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!error && (
        <Panel>
          {!data && <SkeletonRows rows={4} cols={5} />}

          {data?.targets.length === 0 && (
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

          {data && data.targets.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Name
                  </th>
                  <th scope="col">
                    Enforcement
                  </th>
                  <th
                    scope="col"
                    className="max-sm:hidden"
                  >
                    Schedule
                  </th>
                  {/* Never `max-sm:hidden`. This timestamp is the evidence
                      the Status column's judgement is made from, and hiding it
                      on the screens most likely to be in somebody's hand left
                      the badge unfalsifiable. */}
                  <th scope="col">
                    Last run
                  </th>
                  <th scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.targets.map((target) => {
                  const state = health(target, now);
                  return (
                    <tr key={target.id}>
                      <td>
                        <Link
                          to={`/admin/targets/${target.id}`}
                          className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                        >
                          {target.name}
                        </Link>
                        <span className="ml-2">
                          <Status tone="neutral">{typeLabel(target.type)}</Status>
                        </span>
                      </td>
                      <td>
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
                      <td className="max-sm:hidden">
                        {/* A link to where the schedule is set, and a title
                            saying so: "By hand only" read as a verdict
                            somebody had to go and find the cure for. */}
                        {target.schedule ?? (
                          <Link
                            to={`/admin/targets/${target.id}`}
                            title="No schedule is set. Open the target and enter a cron expression under Schedule and enforcement to run it automatically."
                            className="text-muted underline-offset-2 hover:text-ink hover:underline"
                          >
                            By hand only
                          </Link>
                        )}
                      </td>
                      <td>
                        {when(target.lastRunAt)}
                      </td>
                      <td>
                        <span title={state.title}>
                          {state.state ? (
                            <StateBadge state={state.state}>{state.label}</StateBadge>
                          ) : (
                            <Status tone="neutral" glyph="dot">
                              {state.label}
                            </Status>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
