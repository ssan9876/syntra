import { migrationState, prisma, TENANT_DELETED_STATUS, withTenant } from '@syntra/db';
import { configurationFingerprint } from '../lifecycle/management.js';
import { inspectJobHealth, jobHealthCounts, type JobHealthCount, type JobHealthFindingKind, type QueueInspector } from '../jobs/job-health.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { Transport } from '../notify/notification-service.js';
import { externalWriteStopActive } from '../provision/target-write-stop.js';
import { tenantWriteStopActive } from '../provision/tenant-write-stop.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { classifyError, type ErrorClass } from './error-class.js';
import { readiness, redactReport, type Probe } from './readiness.js';
import { buildInfo } from './version.js';

/**
 * Customer-safe status reporting (backlog #63).
 *
 * Two audiences, two answers, and the line between them is the point:
 *
 *  - A TENANT administrator sees the health of the shared components their
 *    service depends on (API, database, job queue, key provider, mail), and
 *    the degradation that is THEIRS: their write stops, their stale readiness
 *    evidence, their connectors that are failing, their stuck jobs. Nothing in
 *    it is a count, a name or a timing that another tenant's activity could
 *    move. The job queue is reported as working or not -- never its depth,
 *    which is the sum of every tenant's backlog and would tell one customer
 *    how busy the others are.
 *
 *  - The OPERATOR (`deployment.manage`) sees the installation: the same
 *    components with the readiness probes behind them, the release and its
 *    migrations, the queue's depth, and installation-wide counts of degraded
 *    tenants and stuck jobs. Counts only, and no tenant is named: in a shared
 *    deployment the holder of `deployment.manage` may itself be one
 *    customer's administrator (see the permission's own comment).
 *
 * Component checks are cached for fifteen seconds per process, so a console
 * left open on the status page cannot become a load on the KMS or the mail
 * server it is reporting on.
 */

export type ComponentState = 'operational' | 'degraded' | 'unavailable' | 'unknown';
export const STATUS_COMPONENTS = ['api', 'database', 'queue', 'key_provider', 'smtp'] as const;
export type StatusComponentName = (typeof STATUS_COMPONENTS)[number];

export interface StatusComponent {
  name: StatusComponentName;
  state: ComponentState;
  /** One sentence. Never a cause string, a host, or a count. */
  detail: string;
}

export interface StatusDeps {
  provider: MasterKeyProvider;
  /** Whether this process's scheduler started. Absent: unknown. */
  schedulerRunning?: () => boolean;
  transport?: Transport;
  /** Tests only. */
  timeoutMs?: number;
}

const COMPONENT_TIMEOUT_MS = 5_000;
const COMPONENT_CACHE_MS = 15_000;

async function within<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queueReadable(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('select 1 from pgboss.job limit 1');
    return true;
  } catch {
    return false;
  }
}

/** The shared components, as any tenant may see them. */
export async function componentHealth(deps: StatusDeps): Promise<StatusComponent[]> {
  const ms = deps.timeoutMs ?? COMPONENT_TIMEOUT_MS;
  const components: StatusComponent[] = [
    // Answering this request is the whole of the API's check.
    { name: 'api', state: 'operational', detail: 'The API is answering.' },
  ];

  let databaseUp = false;
  try {
    await within(ms, () => prisma.$queryRawUnsafe('SELECT 1'));
    databaseUp = true;
    const state = await within(ms, () => migrationState());
    components.push(
      state.ok
        ? { name: 'database', state: 'operational', detail: 'The database is reachable and its schema is current.' }
        : { name: 'database', state: 'degraded', detail: 'The database is reachable but a schema migration is incomplete.' },
    );
  } catch {
    components.push(
      databaseUp
        ? { name: 'database', state: 'degraded', detail: 'The database is reachable but its schema state could not be read.' }
        : { name: 'database', state: 'unavailable', detail: 'The database is not answering.' },
    );
  }

  const running = deps.schedulerRunning?.();
  if (running === undefined) {
    components.push({ name: 'queue', state: 'unknown', detail: 'This process does not report on background work.' });
  } else if (!running) {
    components.push({ name: 'queue', state: 'unavailable', detail: 'Background work is not running: scheduled syncs, provisioning and notifications are paused until it recovers.' });
  } else if (databaseUp && !(await within(ms, queueReadable).catch(() => false))) {
    components.push({ name: 'queue', state: 'degraded', detail: 'Background work is running but its queue could not be read.' });
  } else {
    components.push({ name: 'queue', state: 'operational', detail: 'Background work is running.' });
  }

  try {
    await within(ms, () => deps.provider.check());
    components.push({ name: 'key_provider', state: 'operational', detail: 'The key provider protects and opens stored secrets.' });
  } catch {
    components.push({ name: 'key_provider', state: 'unavailable', detail: 'The key provider is not answering: new secrets cannot be stored, and connector credentials stop opening as cached keys expire.' });
  }

  if (!deps.transport?.verify) {
    components.push({ name: 'smtp', state: 'unknown', detail: 'Outbound mail is not checked by this deployment.' });
  } else {
    const verify = deps.transport.verify.bind(deps.transport);
    try {
      await within(ms, verify);
      components.push({ name: 'smtp', state: 'operational', detail: 'The mail server accepts connections.' });
    } catch {
      components.push({ name: 'smtp', state: 'unavailable', detail: 'The mail server is not accepting connections: notifications and one-time codes by email are delayed.' });
    }
  }
  return components;
}

/** `componentHealth` behind a short per-process cache with a shared in-flight read. */
export function cachedComponentHealth(deps: StatusDeps, ttlMs = COMPONENT_CACHE_MS): () => Promise<StatusComponent[]> {
  let cached: { at: number; value: StatusComponent[] } | null = null;
  let inFlight: Promise<StatusComponent[]> | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = componentHealth(deps)
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

function overallOf(components: StatusComponent[], degraded: boolean): 'operational' | 'degraded' | 'unavailable' {
  if (components.some((c) => c.state === 'unavailable' && (c.name === 'api' || c.name === 'database'))) return 'unavailable';
  if (degraded || components.some((c) => c.state === 'unavailable' || c.state === 'degraded')) return 'degraded';
  return 'operational';
}

// ---- tenant ---------------------------------------------------------------------

/** How old a passing readiness check may be before it no longer vouches for a connector. */
export const READINESS_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
/** A failure more recent than this is a current outage. */
export const OUTAGE_WINDOW_MS = 24 * 60 * 60_000;

export interface TenantStatus {
  generatedAt: string;
  overall: 'operational' | 'degraded' | 'unavailable';
  components: StatusComponent[];
  degradation: {
    writeStop: { active: boolean; since: string | null; expiresAt: string | null };
    targetWriteStops: { targetId: string; name: string; since: string | null; expiresAt: string | null }[];
    staleReadiness: {
      targetId: string;
      name: string;
      reason: 'never_tested' | 'configuration_changed' | 'older_than_7_days' | 'failing';
      checkedAt: string | null;
    }[];
    connectorOutages: {
      systemKind: 'target' | 'directory_source' | 'hr_source';
      id: string;
      name: string;
      since: string;
      errorClass: ErrorClass;
      evidence: 'readiness_check' | 'last_run';
    }[];
    jobs: Record<JobHealthFindingKind, number>;
    queueReadable: boolean;
  };
}

/**
 * The status one tenant's administrators see. Every degradation fact is read
 * under the tenant's own RLS binding; the components are the shared ones.
 */
export async function tenantStatus(
  tenantId: string,
  components: StatusComponent[],
  options: { now?: Date; inspector?: QueueInspector } = {},
): Promise<TenantStatus> {
  const now = options.now ?? new Date();
  const outageSince = new Date(now.getTime() - OUTAGE_WINDOW_MS);

  const facts = await withTenant(tenantId, async (tx) => {
    const [stop, targets, directorySources, personSources] = await Promise.all([
      tx.tenantExternalWriteStop.findFirst(),
      tx.targetSystem.findMany({
        where: { enabled: true },
        select: {
          id: true,
          name: true,
          config: true,
          externalWritesPausedAt: true,
          externalWritesPauseExpiresAt: true,
        },
        orderBy: { name: 'asc' },
      }),
      tx.directorySource.findMany({ where: { enabled: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      tx.personSource.findMany({ where: { enabled: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const targetIds = targets.map((t) => t.id);
    const [checks, provisionFailures, syncFailures, importFailures] = await Promise.all([
      targetIds.length
        ? tx.connectionReadinessCheck.findMany({
            where: { systemKind: 'target', systemId: { in: targetIds } },
            orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
            distinct: ['systemId'],
            select: { systemId: true, status: true, checkedAt: true, configurationFingerprint: true, message: true },
          })
        : [],
      // The LAST run of each connector, and only when it failed recently: a
      // connector whose latest run succeeded is not out, however many failed
      // before it.
      latestRuns(targetIds, (ids) =>
        tx.provisionRun.findMany({
          where: { targetSystemId: { in: ids }, status: { in: ['applied', 'partially_applied', 'failed', 'previewed', 'blocked'] } },
          orderBy: { startedAt: 'desc' },
          distinct: ['targetSystemId'],
          select: { targetSystemId: true, status: true, startedAt: true, error: true },
        }),
      ),
      latestRuns(directorySources.map((s) => s.id), (ids) =>
        tx.syncRun.findMany({
          where: { sourceId: { in: ids }, status: { in: ['applied', 'partially_applied', 'failed', 'previewed', 'blocked'] } },
          orderBy: { startedAt: 'desc' },
          distinct: ['sourceId'],
          select: { sourceId: true, status: true, startedAt: true, error: true },
        }),
      ),
      latestRuns(personSources.map((s) => s.id), (ids) =>
        tx.personImportRun.findMany({
          where: { sourceId: { in: ids }, status: { in: ['applied', 'partially_applied', 'failed', 'previewed', 'blocked'] } },
          orderBy: { startedAt: 'desc' },
          distinct: ['sourceId'],
          select: { sourceId: true, status: true, startedAt: true, error: true },
        }),
      ),
    ]);
    return { stop, targets, directorySources, personSources, checks, provisionFailures, syncFailures, importFailures };
  });

  const checkOf = new Map(facts.checks.map((check) => [check.systemId, check]));
  const staleReadiness: TenantStatus['degradation']['staleReadiness'] = [];
  const connectorOutages: TenantStatus['degradation']['connectorOutages'] = [];
  for (const target of facts.targets) {
    const check = checkOf.get(target.id);
    if (!check) {
      staleReadiness.push({ targetId: target.id, name: target.name, reason: 'never_tested', checkedAt: null });
      continue;
    }
    if (check.status === 'failed') {
      staleReadiness.push({ targetId: target.id, name: target.name, reason: 'failing', checkedAt: check.checkedAt.toISOString() });
      connectorOutages.push({
        systemKind: 'target', id: target.id, name: target.name, since: check.checkedAt.toISOString(),
        errorClass: classifyError(check.message), evidence: 'readiness_check',
      });
    } else if (check.configurationFingerprint !== configurationFingerprint(target.config)) {
      staleReadiness.push({ targetId: target.id, name: target.name, reason: 'configuration_changed', checkedAt: check.checkedAt.toISOString() });
    } else if (now.getTime() - check.checkedAt.getTime() > READINESS_STALE_AFTER_MS) {
      staleReadiness.push({ targetId: target.id, name: target.name, reason: 'older_than_7_days', checkedAt: check.checkedAt.toISOString() });
    }
  }
  const outageFromRun = (
    systemKind: 'target' | 'directory_source' | 'hr_source',
    systems: { id: string; name: string }[],
    runs: { id: string; status: string; startedAt: Date; error: string | null }[],
  ) => {
    const named = new Map(systems.map((s) => [s.id, s.name]));
    for (const run of runs) {
      if (run.status !== 'failed' || run.startedAt < outageSince) continue;
      if (connectorOutages.some((o) => o.id === run.id)) continue;
      connectorOutages.push({
        systemKind, id: run.id, name: named.get(run.id) ?? '', since: run.startedAt.toISOString(),
        errorClass: classifyError(run.error), evidence: 'last_run',
      });
    }
  };
  outageFromRun('target', facts.targets, facts.provisionFailures.map((r) => ({ ...r, id: r.targetSystemId })));
  outageFromRun('directory_source', facts.directorySources, facts.syncFailures.map((r) => ({ ...r, id: r.sourceId })));
  outageFromRun('hr_source', facts.personSources, facts.importFailures.map((r) => ({ ...r, id: r.sourceId })));

  const jobs = await inspectJobHealth(tenantId, { now, ...(options.inspector ? { inspector: options.inspector } : {}) });
  const writeActive = tenantWriteStopActive(facts.stop, now);
  const targetWriteStops = facts.targets
    .filter((target) => externalWriteStopActive(target, now))
    .map((target) => ({
      targetId: target.id,
      name: target.name,
      since: target.externalWritesPausedAt?.toISOString() ?? null,
      expiresAt: target.externalWritesPauseExpiresAt?.toISOString() ?? null,
    }));

  const jobTrouble = jobs.counts.orphaned + jobs.counts.stuck + jobs.counts.poisoned > 0;
  const degraded = writeActive || targetWriteStops.length > 0 || connectorOutages.length > 0 || staleReadiness.length > 0 || jobTrouble;

  return {
    generatedAt: now.toISOString(),
    overall: overallOf(components, degraded),
    components,
    degradation: {
      writeStop: {
        active: writeActive,
        since: writeActive ? facts.stop?.pausedAt?.toISOString() ?? null : null,
        expiresAt: writeActive ? facts.stop?.pauseExpiresAt?.toISOString() ?? null : null,
      },
      targetWriteStops,
      staleReadiness,
      connectorOutages,
      jobs: jobs.counts,
      queueReadable: jobs.queueReadable,
    },
  };
}

async function latestRuns<T>(ids: string[], read: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  return ids.length === 0 ? [] : read(ids);
}

// ---- operator -------------------------------------------------------------------

export interface DeploymentStatus {
  generatedAt: string;
  overall: 'operational' | 'degraded' | 'unavailable';
  release: { version: string; commit: string | null; released: string | null };
  components: StatusComponent[];
  probes: Probe[];
  migrations: { applied: number; pending: number; failed: number; newerThanBuild: number } | null;
  queue: { readable: boolean; pending: number | null; missingSchedules: number | null };
  tenants: {
    active: number;
    withWriteStop: number;
    withJobTrouble: number;
  };
  jobs: JobHealthCount[];
}

export interface DeploymentStatusDeps extends StatusDeps {
  scheduler?: () => Scheduler | null;
  webRoot?: string | undefined;
  inspector?: QueueInspector;
}

/**
 * The installation, for whoever holds `deployment.manage`. Counts only; no
 * tenant is named or identified.
 */
export async function deploymentStatus(deps: DeploymentStatusDeps, now: Date = new Date()): Promise<DeploymentStatus> {
  const info = buildInfo();
  const [components, report] = await Promise.all([
    componentHealth(deps),
    readiness({ provider: deps.provider, webRoot: deps.webRoot, version: info.version }),
  ]);

  let migrations: DeploymentStatus['migrations'];
  try {
    const state = await migrationState();
    migrations = { applied: state.applied, pending: state.pending.length, failed: state.failed.length, newerThanBuild: state.unknown.length };
  } catch {
    migrations = null;
  }

  let pending: number | null;
  try {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `select count(*)::bigint as count from pgboss.job where state in ('created', 'retry')`,
    );
    pending = Number(rows[0]?.count ?? 0);
  } catch {
    pending = null;
  }
  let missingSchedules: number | null = null;
  const scheduler = deps.scheduler?.() ?? null;
  if (scheduler) {
    missingSchedules = await scheduler.missingSchedules().then((list) => list.length, () => null);
  }

  const tenants = await prisma.tenant.findMany({ where: { status: { not: TENANT_DELETED_STATUS } }, select: { id: true } });
  let withWriteStop = 0;
  for (const tenant of tenants) {
    const stop = await withTenant(tenant.id, (tx) => tx.tenantExternalWriteStop.findFirst());
    if (tenantWriteStopActive(stop, now)) withWriteStop += 1;
  }
  // One read of the queue for every tenant, split by tenant in memory.
  const ids = tenants.map((t) => t.id);
  const { counts, queueReadable: readable, tenantsAffected } = await jobHealthCounts(ids, {
    now,
    ...(deps.inspector ? { inspector: deps.inspector } : {}),
  });

  const degraded =
    !report.ready ||
    (migrations !== null && (migrations.pending > 0 || migrations.failed > 0)) ||
    (missingSchedules ?? 0) > 0 ||
    counts.some((c) => c.count > 0 && (c.finding === 'orphaned' || c.finding === 'poisoned' || c.finding === 'stuck'));

  return {
    generatedAt: now.toISOString(),
    overall: overallOf(components, degraded),
    release: { version: info.version, commit: info.commit, released: info.released },
    components,
    probes: redactReport(report).probes,
    migrations,
    queue: { readable, pending, missingSchedules },
    tenants: { active: tenants.length, withWriteStop, withJobTrouble: tenantsAffected },
    jobs: counts.filter((c) => c.count > 0),
  };
}
