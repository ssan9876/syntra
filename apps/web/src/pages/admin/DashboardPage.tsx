import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Panel, SkeletonRows, StateBadge, type State } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { Icon, type IconName } from '../../components/icons.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import type { JobHealthBody, TenantStatusBody } from './OperationsPage.js';

interface Summary {
  people: { total: number; active: number; withoutAccount: number };
  accounts: { total: number; active: number; locked: number };
}

interface Lanes {
  action: number;
  waiting: number;
  blocked: number;
  overdue: number;
}

interface TargetRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  consecutiveSkippedRuns: number;
}

interface SourceRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  schedule: string | null;
  lastRunAt: string | null;
}

interface AuditEvent {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  outcome: string;
}

/** One thing somebody should act on, with where to act on it. */
interface Item {
  key: string;
  state: State;
  label: string;
  count?: number;
  to: string;
  /** Replaces the state's own word, e.g. "Acknowledged". */
  badge?: string;
}

const MINUTE = 60_000;

/** "4 min ago", "3 h ago", "2 days ago" -- a dashboard reads age, not a timestamp. */
export function ago(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  if (ms < MINUTE) return 'just now';
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * An audit action as a phrase: `user.kindChanged` reads "User kind changed".
 * Derived rather than mapped, for the reason the roles screen derives its
 * permission groups: a table of every action here would be wrong the first
 * time somebody added one.
 */
export function describeAction(action: string): string {
  const words = action
    .replace(/[._]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TYPE_LABEL: Record<string, string> = {
  activeDirectory: 'Active Directory',
  entraId: 'Entra ID',
  scim2: 'SCIM 2.0',
  httpJson: 'REST API',
  ldap: 'Directory',
};

function systemState(system: {
  enabled: boolean;
  lastRunAt: string | null;
  consecutiveSkippedRuns?: number;
}): { state: State; label: string } {
  if (!system.enabled) return { state: 'inactive', label: 'Disabled' };
  if (system.lastRunAt === null) return { state: 'setup', label: 'Never run' };
  if ((system.consecutiveSkippedRuns ?? 0) > 0) {
    return { state: 'attention', label: `${system.consecutiveSkippedRuns} skipped` };
  }
  return { state: 'healthy', label: ago(system.lastRunAt) };
}

/**
 * The console's front page: what needs a person, how big the directory is,
 * whether the connected systems are running, and what happened last.
 *
 * Every section asks for its own permission and is absent without it, so a
 * help-desk role sees a shorter page rather than a page of refusals. Nothing
 * here is a new figure: each is the count another screen already reports, and
 * each links to that screen, because a number with no route to its rows is a
 * dead end.
 */
export function DashboardPage() {
  const can = useCan();

  const mayAudit = can('audit.read');
  const mayDirectory = can('directory.read') && can('identity.read');
  const mayWork = mayDirectory && can('provision.read');

  const status = useApiResource<TenantStatusBody>(mayAudit ? '/api/admin/status' : null);
  const jobs = useApiResource<JobHealthBody>(mayAudit ? '/api/admin/job-health' : null);
  const summary = useApiResource<Summary>(mayDirectory ? '/api/admin/directory/summary' : null);
  const unlinked = useApiResource<{ accounts: unknown[] }>(
    can('directory.read') ? '/api/admin/users/unlinked' : null,
  );
  const work = useApiResource<{ lanes?: Lanes }>(
    mayWork ? '/api/admin/employee-work?pageSize=1' : null,
  );
  const targets = useApiResource<{ targets: TargetRow[] }>(
    can('provision.read') ? '/api/admin/targets' : null,
  );
  const sources = useApiResource<{ sources: SourceRow[] }>(
    can('sync.read') ? '/api/admin/sources' : null,
  );
  const applications = useApiResource<{ applications: unknown[] }>(
    can('access.read') ? '/api/admin/applications' : null,
  );
  const incidents = useApiResource<{
    incidents: { kind: string; severity: 'critical' | 'warning'; title: string; acknowledged?: unknown }[];
  }>(mayAudit ? '/api/admin/incidents' : null);
  const activity = useApiResource<{ events: AuditEvent[] }>(
    mayAudit ? '/api/admin/audit?limit=8' : null,
  );
  const users = useApiResource<{ users: { id: string; displayName: string }[] }>(
    mayAudit && can('directory.read') ? '/api/admin/users' : null,
  );

  const items: Item[] = [];
  const degradation = status.data?.degradation;
  if (degradation?.writeStop.active) {
    items.push({ key: 'write-stop', state: 'blocked', label: 'External writes stopped', to: '/admin/targets' });
  }
  for (const stop of degradation?.targetWriteStops ?? []) {
    items.push({ key: `stop-${stop.targetId}`, state: 'blocked', label: `Writes stopped: ${stop.name}`, to: `/admin/targets/${stop.targetId}` });
  }
  for (const outage of degradation?.connectorOutages ?? []) {
    const to = outage.systemKind === 'target' ? `/admin/targets/${outage.id}` : `/admin/sources/${outage.id}`;
    items.push({ key: `outage-${outage.id}`, state: 'blocked', label: `${outage.name} unreachable`, to });
  }
  // What has stopped working, from the attention list. An acknowledged one
  // stays here -- acknowledging hides nothing -- but says somebody has it.
  for (const incident of incidents.data?.incidents ?? []) {
    items.push({
      key: `incident-${incident.kind}`,
      state: incident.acknowledged ? 'pending' : incident.severity === 'critical' ? 'blocked' : 'attention',
      label: incident.title,
      to: '/admin/activity',
      ...(incident.acknowledged ? { badge: 'Acknowledged' } : {}),
    });
  }
  const lanes = work.data?.lanes;
  if (lanes && lanes.overdue > 0) {
    items.push({ key: 'overdue', state: 'blocked', label: 'Overdue employee work', count: lanes.overdue, to: '/admin/employee-work?lane=overdue' });
  }
  if (lanes && lanes.blocked > 0) {
    items.push({ key: 'blocked', state: 'blocked', label: 'Blocked employee work', count: lanes.blocked, to: '/admin/employee-work?lane=blocked' });
  }
  if (lanes && lanes.action > 0) {
    items.push({ key: 'action', state: 'attention', label: 'Employee work to act on', count: lanes.action, to: '/admin/employee-work?lane=action' });
  }
  const findings = jobs.data?.findings.length ?? 0;
  if (findings > 0) {
    items.push({ key: 'jobs', state: 'attention', label: 'Background work to check', count: findings, to: '/admin/operations' });
  }
  for (const stale of degradation?.staleReadiness ?? []) {
    items.push({ key: `stale-${stale.targetId}`, state: 'attention', label: `Retest ${stale.name}`, to: `/admin/targets/${stale.targetId}` });
  }
  const locked = summary.data?.accounts.locked ?? 0;
  if (locked > 0) {
    items.push({ key: 'locked', state: 'attention', label: 'Accounts locked out', count: locked, to: '/admin/users' });
  }
  const orphans = unlinked.data?.accounts.length ?? 0;
  if (orphans > 0) {
    items.push({ key: 'unlinked', state: 'attention', label: 'Accounts with no person', count: orphans, to: '/admin/users/unlinked' });
  }

  const checking =
    (mayAudit && (status.loading || jobs.loading || incidents.loading)) ||
    (mayWork && work.loading) ||
    (mayDirectory && summary.loading);

  const names = new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName]));
  const systems = [
    ...(targets.data?.targets ?? []).map((t) => ({ ...t, kind: 'Target' as const, to: `/admin/targets/${t.id}` })),
    ...(sources.data?.sources ?? []).map((s) => ({ ...s, kind: 'Source' as const, to: `/admin/sources/${s.id}` })),
  ];

  const overall = status.data?.overall;

  return (
    <>
      <PageHeader
        title="Overview"
        status={
          overall === undefined ? undefined : overall === 'operational' ? (
            <StateBadge state="healthy">All systems operational</StateBadge>
          ) : (
            <Link to="/admin/operations" className="rounded-sm">
              <StateBadge state={overall === 'degraded' ? 'attention' : 'blocked'}>
                {overall === 'degraded' ? 'Degraded' : 'Unavailable'}
              </StateBadge>
            </Link>
          )
        }
      />

      {(mayAudit || mayDirectory) && (
        <section aria-labelledby="needs-you" className="mb-6">
          <h2 id="needs-you" className="mb-2 text-md font-semibold text-ink">
            Needs you
          </h2>
          {checking && items.length === 0 ? (
            <div className="rounded-panel border border-border-subtle">
              <SkeletonRows rows={2} cols={2} />
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center gap-3 rounded-panel border border-border-subtle bg-surface px-4 py-3.5">
              <StateBadge state="healthy">Nothing waiting</StateBadge>
            </div>
          ) : (
            <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
              {items.map((item) => (
                <li key={item.key}>
                  <Link
                    to={item.to}
                    className={[
                      'group flex h-full items-center gap-3 rounded-panel border bg-bg px-4 py-3',
                      'transition-colors duration-150 ease-out-quart hover:bg-surface',
                      item.state === 'blocked' ? 'border-danger/40' : 'border-border-subtle',
                    ].join(' ')}
                  >
                    {item.count !== undefined && (
                      <span
                        className={[
                          'figure min-w-[2ch] text-xl font-semibold tabular-nums',
                          item.state === 'blocked' ? 'text-danger' : 'text-warning',
                        ].join(' ')}
                      >
                        {item.count.toLocaleString()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink group-hover:text-primary">
                        {item.label}
                      </span>
                      <span className="mt-1 block">
                        <StateBadge state={item.state}>{item.badge}</StateBadge>
                      </span>
                    </span>
                    <Chevron />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <StatGrid>
        {mayDirectory && (
          <>
            <StatCard label="People" value={summary.data?.people.active ?? '—'} to="/admin/users?tab=people" />
            <StatCard label="Accounts" value={summary.data?.accounts.active ?? '—'} to="/admin/users" />
          </>
        )}
        {can('access.read') && (
          <StatCard label="Applications" value={applications.data?.applications.length ?? '—'} to="/admin/applications" />
        )}
        {can('provision.read') && (
          <StatCard label="Target systems" value={targets.data?.targets.length ?? '—'} to="/admin/targets" />
        )}
        {can('sync.read') && (
          <StatCard label="Sources" value={sources.data?.sources.length ?? '—'} to="/admin/sources" />
        )}
      </StatGrid>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {(can('provision.read') || can('sync.read')) && (
          <Panel title="Connected systems" actions={<MoreLink to="/admin/targets">Targets</MoreLink>}>
            {(targets.loading || sources.loading) && systems.length === 0 ? (
              <SkeletonRows rows={3} cols={3} />
            ) : systems.length === 0 ? (
              <EmptyLine to="/admin/provisioning-setup" icon="setup">
                Connect a system
              </EmptyLine>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {systems.map((system) => {
                  const { state, label } = systemState(system);
                  return (
                    <li key={`${system.kind}-${system.id}`}>
                      <Link
                        to={system.to}
                        className="group flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-out-quart hover:bg-surface"
                      >
                        <Icon
                          name={system.kind === 'Target' ? 'targets' : 'sources'}
                          className="size-4 text-muted group-hover:text-primary"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink">{system.name}</span>
                          <span className="block text-sm text-muted">
                            {system.kind} · {TYPE_LABEL[system.type] ?? system.type}
                          </span>
                        </span>
                        <StateBadge state={state}>{label}</StateBadge>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        )}

        {mayAudit && (
          <Panel title="Recent activity" actions={<MoreLink to="/admin/activity">All activity</MoreLink>}>
            {activity.loading && !activity.data ? (
              <SkeletonRows rows={4} cols={2} />
            ) : (activity.data?.events ?? []).length === 0 ? (
              <EmptyLine to="/admin/activity" icon="activity">
                No activity yet
              </EmptyLine>
            ) : (
              <ol className="divide-y divide-border-subtle">
                {(activity.data?.events ?? []).map((event) => (
                  <li key={event.id} className="flex items-baseline gap-3 px-4 py-2.5">
                    <span
                      aria-hidden="true"
                      className={[
                        'mt-1.5 size-1.5 shrink-0 self-start rounded-full',
                        event.outcome === 'success' ? 'bg-success' : 'bg-danger',
                      ].join(' ')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">
                        {describeAction(event.action)}
                        {event.outcome !== 'success' && <span className="sr-only"> (failed)</span>}
                      </span>
                      <span className="block truncate text-sm text-muted">
                        {event.actorUserId === null
                          ? 'System'
                          : (names.get(event.actorUserId) ?? 'An administrator')}
                      </span>
                    </span>
                    <time
                      dateTime={event.occurredAt}
                      title={new Date(event.occurredAt).toLocaleString()}
                      className="shrink-0 text-sm tabular-nums text-muted"
                    >
                      {ago(event.occurredAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0 text-muted group-hover:text-primary" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-sm font-medium text-accent underline underline-offset-2 hover:text-primary">
      {children}
    </Link>
  );
}

function EmptyLine({ to, icon, children }: { to: string; icon: IconName; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 px-4 py-4 text-muted transition-colors duration-150 ease-out-quart hover:bg-surface hover:text-ink"
    >
      <Icon name={icon} className="size-4" />
      <span className="flex-1">{children}</span>
      <Chevron />
    </Link>
  );
}
