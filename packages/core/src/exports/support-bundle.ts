import { migrationState, prisma, withTenant } from '@syntra/db';
import { redactValue } from '@syntra/connectors';
import { classifyError, type ErrorClass } from '../health/error-class.js';
import { buildInfo } from '../health/version.js';
import { inspectJobHealth, type QueueInspector } from '../jobs/job-health.js';
import { configurationFingerprint } from '../lifecycle/management.js';
import { externalWriteStopActive } from '../provision/target-write-stop.js';
import { tenantWriteStopActive } from '../provision/tenant-write-stop.js';
import { SUPPORT_BUNDLE_MAX_WINDOW_MS, SupportBundleWindowError } from './support-bundle-window.js';

export * from './support-bundle-window.js';

/**
 * The operational support bundle (backlog #64).
 *
 * What a support engineer needs to diagnose a tenant's installation, and
 * nothing a support engineer should not hold. It is built BY ALLOW-LIST: every
 * field below was chosen, and the kinds of things it contains are
 *
 *   - identifiers (tenant, run, target, source ids -- opaque UUIDs),
 *   - fingerprints (SHA-256 of a configuration, never the configuration),
 *   - versions, migration names, statuses, timestamps and counts,
 *   - error CLASSES from a closed vocabulary (`classifyError`), never error
 *     messages -- a connector's message can carry a DN, an email address or
 *     a credential in a URL, and the class cannot.
 *
 * It contains no credentials, no vault material, no configuration values, no
 * target, source, application or person names, no audit payloads and no
 * free text anybody typed (a write stop's reason is reported as "provided").
 *
 * Then, as a second layer, every section passes through the same redaction
 * rules the logger uses (`redactValue`), so a field added here later that
 * happens to carry a secret-shaped or personal-looking value is scrubbed
 * rather than shipped. The test seeds secrets and personal data into every
 * table the bundle reads and asserts none of them survive.
 *
 * TIME-BOUNDED: the failures and audit counts are read from a window of at
 * most seven days (`SUPPORT_BUNDLE_MAX_WINDOW_MS`), enforced by the request
 * contract, by `supportBundleWindow` at request, and again here.
 */
/** Rows kept per list. Also the redaction walker's width bound. */
const LIST_LIMIT = 50;

export interface SupportBundleSection {
  name: string;
  data: unknown;
}

interface FailureRow {
  kind: string;
  id: string;
  status: string;
  at: string;
  errorClass: ErrorClass;
}

const countBy = <T>(rows: T[], key: (row: T) => string) => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
};

/**
 * The bundle's sections, already redacted. Separate from the export job so
 * the redaction test can assert on exactly what is written.
 */
export async function buildSupportBundle(
  tenantId: string,
  window: { from: Date; to: Date },
  options: { now?: Date; inspector?: QueueInspector } = {},
): Promise<SupportBundleSection[]> {
  const now = options.now ?? new Date();
  if (window.to.getTime() - window.from.getTime() > SUPPORT_BUNDLE_MAX_WINDOW_MS || window.from >= window.to) {
    throw new SupportBundleWindowError('a support bundle covers at most seven days');
  }
  const inWindow = { gte: window.from, lte: window.to };
  const info = buildInfo();

  let migrations: unknown;
  try {
    const state = await migrationState();
    migrations = {
      ok: state.ok,
      applied: state.applied,
      pending: state.pending,
      failed: state.failed,
      newerThanBuild: state.unknown,
    };
  } catch {
    migrations = { ok: null, readable: false };
  }

  // The tenant row is not under RLS; it is read by id and only fingerprinted.
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const tenantSettings = tenant
    ? (() => {
        const { name: _name, slug: _slug, primaryDomain: _domain, additionalDomains: _domains, ...settings } = tenant as Record<string, unknown>;
        void _name; void _slug; void _domain; void _domains;
        for (const volatile of ['createdAt', 'updatedAt', 'oidcConfigGeneration']) delete settings[volatile];
        return settings;
      })()
    : null;

  const facts = await withTenant(tenantId, async (tx) => {
    const [
      targets,
      directorySources,
      personSources,
      stop,
      checks,
      syncRuns,
      importRuns,
      provisionRuns,
      failedActions,
      operations,
      exports,
      receipts,
      audit,
      webhooksAbandoned,
      counts,
    ] = await Promise.all([
      tx.targetSystem.findMany({
        select: {
          id: true, type: true, enabled: true, schedule: true, autoApply: true, config: true,
          adapterChannel: true, adapterVersionPin: true,
          externalWritesPausedAt: true, externalWritesPauseExpiresAt: true, externalWritesPauseReason: true,
          maintenanceWindowEnabled: true, consecutiveSkippedRuns: true, lastRunAt: true,
        },
        orderBy: { id: 'asc' },
        take: LIST_LIMIT,
      }),
      tx.directorySource.findMany({
        select: { id: true, type: true, enabled: true, schedule: true, autoApply: true, config: true, lastRunAt: true },
        orderBy: { id: 'asc' },
        take: LIST_LIMIT,
      }),
      tx.personSource.findMany({
        select: { id: true, type: true, enabled: true, schedule: true, config: true },
        orderBy: { id: 'asc' },
        take: LIST_LIMIT,
      }),
      tx.tenantExternalWriteStop.findFirst(),
      tx.connectionReadinessCheck.findMany({
        orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
        distinct: ['systemKind', 'systemId'],
        select: { systemKind: true, systemId: true, status: true, checkedAt: true, latencyMs: true, capabilities: true, configurationFingerprint: true, message: true },
        take: LIST_LIMIT,
      }),
      tx.syncRun.findMany({
        where: { startedAt: inWindow, status: { in: ['failed', 'partially_applied', 'cancelled'] } },
        select: { id: true, status: true, startedAt: true, error: true },
        orderBy: { startedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      tx.personImportRun.findMany({
        where: { startedAt: inWindow, status: { in: ['failed', 'partially_applied', 'cancelled'] } },
        select: { id: true, status: true, startedAt: true, error: true },
        orderBy: { startedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      tx.provisionRun.findMany({
        where: { startedAt: inWindow, status: { in: ['failed', 'partially_applied', 'cancelled'] } },
        select: { id: true, status: true, startedAt: true, error: true },
        orderBy: { startedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      tx.provisionAction.findMany({
        where: { createdAt: inWindow, status: { in: ['failed', 'conflict', 'pending_retry', 'in_flight'] } },
        select: { actionType: true, status: true, message: true },
        take: 5_000,
      }),
      tx.lifecycleOperation.findMany({
        where: { updatedAt: inWindow, status: 'failed' },
        select: { id: true, kind: true, status: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      tx.dataExport.findMany({
        where: { requestedAt: inWindow, status: 'failed' },
        select: { id: true, kind: true, status: true, requestedAt: true, error: true },
        orderBy: { requestedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      tx.personProvisionReceipt.findMany({
        where: { updatedAt: inWindow, status: { in: ['failed', 'blocked', 'verification_pending'] } },
        select: { id: true, status: true, updatedAt: true, message: true },
        orderBy: { updatedAt: 'desc' },
        take: LIST_LIMIT,
      }),
      tx.auditEvent.groupBy({
        by: ['action', 'outcome'],
        where: { occurredAt: inWindow },
        _count: { _all: true },
      }),
      tx.webhookDelivery.count({ where: { deliveredAt: null, createdAt: inWindow, attempts: { gte: 1 } } }),
      Promise.all([
        tx.user.count(),
        tx.person.count(),
        tx.targetAccount.count(),
        tx.application.count(),
      ]),
    ]);
    return {
      targets, directorySources, personSources, stop, checks, syncRuns, importRuns, provisionRuns,
      failedActions, operations, exports, receipts, audit, webhooksAbandoned, counts,
    };
  });

  const failures: FailureRow[] = [
    ...facts.syncRuns.map((r) => ({ kind: 'sync_run', id: r.id, status: r.status, at: r.startedAt.toISOString(), errorClass: classifyError(r.error) })),
    ...facts.importRuns.map((r) => ({ kind: 'person_import_run', id: r.id, status: r.status, at: r.startedAt.toISOString(), errorClass: classifyError(r.error) })),
    ...facts.provisionRuns.map((r) => ({ kind: 'provision_run', id: r.id, status: r.status, at: r.startedAt.toISOString(), errorClass: classifyError(r.error) })),
    ...facts.operations.map((r) => ({ kind: `lifecycle_${r.kind}`, id: r.id, status: r.status, at: r.updatedAt.toISOString(), errorClass: 'unknown' as ErrorClass })),
    ...facts.exports.map((r) => ({ kind: `export_${r.kind}`, id: r.id, status: r.status, at: r.requestedAt.toISOString(), errorClass: classifyError(r.error) })),
    ...facts.receipts.map((r) => ({ kind: 'person_provision_receipt', id: r.id, status: r.status, at: r.updatedAt.toISOString(), errorClass: classifyError(r.message) })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const jobs = await inspectJobHealth(tenantId, { now, ...(options.inspector ? { inspector: options.inspector } : {}) });
  const [users, persons, accounts, applications] = facts.counts;
  const auditCounts = facts.audit
    .map((row) => ({ action: row.action, outcome: row.outcome, count: row._count._all }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));

  const sections: SupportBundleSection[] = [
    {
      name: 'software',
      data: {
        version: info.version,
        isRelease: info.isRelease,
        commit: info.commit,
        released: info.released,
        node: process.version,
        migrations,
      },
    },
    {
      name: 'tenant',
      data: {
        tenantId,
        status: tenant?.status ?? null,
        settingsFingerprint: tenantSettings ? configurationFingerprint(tenantSettings) : null,
        // Key names chosen so the redaction walker does not mistake a policy
        // number for a secret: a key containing "password" is redacted.
        signInPolicy: tenant
          ? {
              adminMfaRequired: tenant.adminMfaRequired,
              minimumLength: tenant.passwordMinLength,
              lockoutThreshold: tenant.lockoutThreshold,
              selfEnrolmentEnabled: tenant.selfEnrolmentEnabled,
            }
          : null,
        inventory: { users, persons, targetAccounts: accounts, applications },
      },
    },
    {
      name: 'configuration',
      data: {
        targets: facts.targets.map((t) => ({
          id: t.id,
          type: t.type,
          enabled: t.enabled,
          scheduled: t.schedule !== null,
          autoApply: t.autoApply,
          adapterChannel: t.adapterChannel,
          adapterVersionPinned: t.adapterVersionPin,
          configFingerprint: configurationFingerprint(t.config),
          maintenanceWindow: t.maintenanceWindowEnabled,
          consecutiveSkippedRuns: t.consecutiveSkippedRuns,
          lastRunAt: t.lastRunAt?.toISOString() ?? null,
        })),
        directorySources: facts.directorySources.map((s) => ({
          id: s.id,
          type: s.type,
          enabled: s.enabled,
          scheduled: s.schedule !== null,
          autoApply: s.autoApply,
          configFingerprint: configurationFingerprint(s.config),
          lastRunAt: s.lastRunAt?.toISOString() ?? null,
        })),
        hrSources: facts.personSources.map((s) => ({
          id: s.id,
          type: s.type,
          enabled: s.enabled,
          scheduled: s.schedule !== null,
          configFingerprint: configurationFingerprint(s.config),
        })),
      },
    },
    {
      name: 'write_stops',
      data: {
        tenantWide: {
          active: tenantWriteStopActive(facts.stop, now),
          pausedAt: facts.stop?.pausedAt?.toISOString() ?? null,
          expiresAt: facts.stop?.pauseExpiresAt?.toISOString() ?? null,
          reasonProvided: Boolean(facts.stop?.pauseReason),
        },
        targets: facts.targets
          .filter((t) => externalWriteStopActive(t, now))
          .map((t) => ({
            id: t.id,
            pausedAt: t.externalWritesPausedAt?.toISOString() ?? null,
            expiresAt: t.externalWritesPauseExpiresAt?.toISOString() ?? null,
            reasonProvided: Boolean(t.externalWritesPauseReason),
          })),
      },
    },
    {
      name: 'connector_readiness',
      data: facts.checks.map((c) => {
        const system = c.systemKind === 'target' ? facts.targets.find((t) => t.id === c.systemId) : undefined;
        return {
          systemKind: c.systemKind,
          systemId: c.systemId,
          status: c.status,
          checkedAt: c.checkedAt.toISOString(),
          latencyMs: c.latencyMs,
          capabilities: c.capabilities,
          current: system ? c.configurationFingerprint === configurationFingerprint(system.config) : null,
          errorClass: c.status === 'failed' ? classifyError(c.message) : null,
        };
      }),
    },
    {
      name: 'job_health',
      data: {
        queueReadable: jobs.queueReadable,
        thresholds: jobs.thresholds,
        counts: jobs.counts,
        findings: jobs.findings.slice(0, LIST_LIMIT).map((f) => ({
          finding: f.finding,
          kind: f.kind,
          subjectId: f.subjectId,
          status: f.status,
          since: f.since,
          errorClass: f.errorClass,
          inFlightActions: f.inFlightActions,
          repairs: f.repairs,
        })),
      },
    },
    {
      name: 'recent_failures',
      data: {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        total: failures.length,
        byErrorClass: countBy(failures, (f) => f.errorClass),
        recent: failures.slice(0, LIST_LIMIT),
        provisionActions: countBy(facts.failedActions, (a) => `${a.actionType} ${a.status} ${classifyError(a.message)}`)
          .slice(0, LIST_LIMIT)
          .map(({ value, count }) => {
            const [actionType, status, errorClass] = value.split(' ');
            return { actionType, status, errorClass, count };
          }),
        webhookDeliveriesUndelivered: facts.webhooksAbandoned,
      },
    },
    {
      name: 'audit_counts',
      data: {
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        total: auditCounts.reduce((sum, row) => sum + row.count, 0),
        distinctActions: auditCounts.length,
        byAction: auditCounts.slice(0, LIST_LIMIT),
      },
    },
    {
      name: 'redaction',
      data: {
        statement:
          'Built by allow-list: identifiers, fingerprints, versions, statuses, timestamps, counts and error classes. No credentials, vault material, configuration values, names, personal data, audit payloads or error messages. Every section also passed the shared log redaction rules.',
      },
    },
  ];

  return sections.map((section) => ({ name: section.name, data: redactValue(section.data) }));
}
