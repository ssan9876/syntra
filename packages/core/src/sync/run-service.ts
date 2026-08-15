import type { TenantClient } from '@syntra/db';
import { withTenant } from '@syntra/db';
import { ldapConnector, type SourceRecord } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { mappingsFor, sourceWithPassword } from './source-service.js';
import { isMappingFailure, mapRecord, type DirectoryObject } from './mapping.js';
import { absentAnchors, correlate, type ExistingObject } from './correlate.js';
import { diffMemberships, diffObjects, type MembershipState } from './diff.js';
import { evaluateGuard } from './guard.js';
import { applyChange } from './apply.js';

/**
 * Reads the source, computes the whole diff, and stops.
 *
 * Nothing here writes to the directory. The run and its proposed changes are
 * the entire output, which is what makes "what you reviewed is what you
 * applied" true rather than approximately true.
 *
 * Takes a tenantId, not a caller's transaction, and opens its own
 * transactions internally. The read from the directory and the diff
 * computation can fail partway through (a dropped LDAP connection, a
 * paging error); when that happens the run still needs to be durably
 * marked `failed` with a reason. If all of this ran inside one transaction
 * supplied by the caller, the failure would have already aborted that
 * transaction, and the very `syncRun.update()` meant to record the failure
 * would fail too — leaving the run stuck at `running` forever. Running the
 * failure-recording update in a fresh transaction is what makes it durable.
 */
export async function previewRun(
  tenantId: string,
  provider: MasterKeyProvider,
  sourceId: string,
) {
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such source: ${sourceId}`);
    const boundTenant = await currentTenant(tx);
    return tx.syncRun.create({ data: { tenantId: boundTenant, sourceId } });
  });

  try {
    return await withTenant(tenantId, async (tx) => {
      const tenant = await currentTenant(tx);
      const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
      if (!source) throw new Error(`no such source: ${sourceId}`);

      const config = await sourceWithPassword(tx, provider, sourceId);
      if (!config) throw new Error('source configuration or credential missing');
      const rules = await mappingsFor(tx, sourceId);

      const records: SourceRecord[] = [];
      for await (const record of ldapConnector.read(config)) records.push(record);

      const objects: DirectoryObject[] = [];
      for (const record of records) {
        const mapped = mapRecord(record, rules);
        if (!isMappingFailure(mapped)) objects.push(mapped);
      }

      const dnToAnchor = new Map(objects.map((o) => [o.dn, o.anchor]));
      let unresolved = 0;

      const existing = await loadExisting(tx);
      const changes = [];

      for (const type of ['user', 'group', 'orgUnit'] as const) {
        const ofType = objects.filter((o) => o.objectType === type);
        const rows = existing.filter((e) => e.objectType === type);
        const correlations = correlate(ofType, rows, sourceId);
        const absent = absentAnchors(ofType, rows, sourceId);
        changes.push(...diffObjects(correlations, absent, await currentFieldsFor(tx, type)));
      }

      const desired: MembershipState[] = objects
        .filter((o) => o.objectType === 'group')
        .map((group) => {
          const memberAnchors: string[] = [];
          for (const dn of group.memberDns) {
            const anchor = dnToAnchor.get(dn);
            if (anchor) memberAnchors.push(anchor);
            else unresolved++;
          }
          return { groupAnchor: group.anchor, memberAnchors };
        });

      changes.push(...diffMemberships(desired, await currentMemberships(tx, sourceId)));

      await tx.syncChange.createMany({
        data: changes.map((c) => ({
          tenantId: tenant,
          runId: run.id,
          changeType: c.changeType,
          targetType: c.targetType,
          targetId: c.targetId,
          sourceAnchor: c.sourceAnchor,
          before: (c.before ?? undefined) as never,
          after: (c.after ?? undefined) as never,
          status: c.status,
          message: c.message ?? null,
        })),
      });

      const activeUsersFromSource = await tx.user.count({
        where: { sourceId, status: 'active' },
      });
      const verdict = evaluateGuard({
        changes,
        recordsRead: records.length,
        activeUsersFromSource,
        thresholdPercent: source.deactivationThresholdPercent,
      });

      return tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: verdict.blocked ? 'blocked' : 'previewed',
          blockedReason: verdict.blocked ? verdict.reason : null,
          requiresConfirmation: verdict.blocked,
          recordsRead: records.length,
          unresolvedMembers: unresolved,
          finishedAt: new Date(),
        },
      });
    });
  } catch (cause) {
    return withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          error: cause instanceof Error ? cause.message : 'run failed',
          finishedAt: new Date(),
        },
      }),
    );
  }
}

async function loadExisting(tx: TenantClient): Promise<ExistingObject[]> {
  const users = await tx.user.findMany();
  const groups = await tx.group.findMany();
  const units = await tx.orgUnit.findMany();

  return [
    ...users.map((u) => ({
      id: u.id,
      objectType: 'user' as const,
      sourceId: u.sourceId,
      sourceAnchor: u.sourceAnchor,
      correlationValue: u.login,
      status: u.status,
    })),
    ...groups.map((g) => ({
      id: g.id,
      objectType: 'group' as const,
      sourceId: g.sourceId,
      sourceAnchor: g.sourceAnchor,
      correlationValue: g.name,
      status: g.status,
    })),
    ...units.map((o) => ({
      id: o.id,
      objectType: 'orgUnit' as const,
      sourceId: o.sourceId,
      sourceAnchor: o.sourceAnchor,
      correlationValue: o.name,
      status: 'active',
    })),
  ];
}

async function currentFieldsFor(
  tx: TenantClient,
  type: 'user' | 'group' | 'orgUnit',
): Promise<Map<string, Record<string, string>>> {
  const map = new Map<string, Record<string, string>>();

  if (type === 'user') {
    for (const u of await tx.user.findMany()) {
      map.set(u.id, {
        login: u.login,
        email: u.email,
        displayName: u.displayName,
      });
    }
  } else if (type === 'group') {
    for (const g of await tx.group.findMany()) {
      map.set(g.id, { name: g.name, description: g.description ?? '' });
    }
  } else {
    for (const o of await tx.orgUnit.findMany()) {
      map.set(o.id, { name: o.name });
    }
  }

  return map;
}

async function currentMemberships(
  tx: TenantClient,
  sourceId: string,
): Promise<MembershipState[]> {
  const groups = await tx.group.findMany({
    where: { sourceId },
    include: { memberships: { include: { user: true } } },
  });

  return groups
    .filter((g) => g.sourceAnchor !== null)
    .map((g) => ({
      groupAnchor: g.sourceAnchor!,
      memberAnchors: g.memberships
        .map((m) => m.user.sourceAnchor)
        .filter((a): a is string => a !== null),
    }));
}

/**
 * Applies the proposed changes of a run, in the order they were computed so
 * that objects exist before memberships reference them. Conflicts are never
 * applied.
 *
 * Takes a tenantId, not a caller's transaction, and opens a fresh
 * `withTenant` transaction for each change. PostgreSQL aborts a transaction
 * the instant a statement inside it errors, so a single shared transaction
 * cannot both apply several changes and recover from one of them failing:
 * the very `syncChange.update()` meant to mark that change `failed` would
 * itself fail against the aborted transaction. Scoping each change to its
 * own transaction means one failure rolls back only that change — the
 * directory row and its `SyncChange` status commit together or not at all —
 * while every other change in the run is unaffected and the loop genuinely
 * continues, per the spec (docs/superpowers/specs/2026-08-15-syntra-directory-sync-design.md, §10).
 */
export async function applyRun(
  tenantId: string,
  runId: string,
  opts: { only?: string[] } = {},
) {
  const run = await withTenant(tenantId, (tx) =>
    tx.syncRun.findUnique({ where: { id: runId } }),
  );
  if (!run) throw new Error(`no such run: ${runId}`);
  if (run.status === 'blocked') {
    throw new Error(
      `run is blocked and cannot be applied: ${run.blockedReason ?? 'unknown reason'}`,
    );
  }

  const changes = await withTenant(tenantId, (tx) =>
    tx.syncChange.findMany({
      where: {
        runId,
        status: 'proposed',
        ...(opts.only ? { id: { in: opts.only } } : {}),
      },
      orderBy: { id: 'asc' },
    }),
  );

  // Objects before memberships: a membership references rows that the same
  // run may only just have created.
  const ordered = [
    ...changes.filter((c) => !c.changeType.endsWith('_member')),
    ...changes.filter((c) => c.changeType.endsWith('_member')),
  ];

  for (const change of ordered) {
    try {
      await withTenant(tenantId, (tx) => applyChange(tx, change, run.sourceId, runId));
    } catch (cause) {
      // A fresh transaction: the one applyChange ran in is already aborted
      // and cannot accept this update.
      await withTenant(tenantId, (tx) =>
        tx.syncChange.update({
          where: { id: change.id },
          data: {
            status: 'failed',
            message: cause instanceof Error ? cause.message : 'failed to apply',
          },
        }),
      );
    }
  }

  const remaining = await withTenant(tenantId, (tx) =>
    tx.syncChange.count({ where: { runId, status: 'proposed' } }),
  );
  const failed = await withTenant(tenantId, (tx) =>
    tx.syncChange.count({ where: { runId, status: 'failed' } }),
  );

  return withTenant(tenantId, (tx) =>
    tx.syncRun.update({
      where: { id: runId },
      data: {
        status: remaining > 0 || failed > 0 ? 'partially_applied' : 'applied',
        finishedAt: new Date(),
      },
    }),
  );
}

export async function skipChange(
  tx: TenantClient,
  changeId: string,
): Promise<void> {
  await tx.syncChange.update({
    where: { id: changeId },
    data: { status: 'skipped' },
  });
}

export async function listRuns(tx: TenantClient, sourceId?: string) {
  return tx.syncRun.findMany({
    where: sourceId ? { sourceId } : {},
    orderBy: { startedAt: 'desc' },
    take: 50,
  });
}
