import type { TenantClient } from '@syntra/db';
import { withTenant } from '@syntra/db';
import {
  ldapConnector,
  type ObjectType,
  type SourceRecord,
} from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { mappingsFor, sourceWithPassword } from './source-service.js';
import {
  isMappingFailure,
  mapRecord,
  type DirectoryObject,
  type MappingRule,
} from './mapping.js';
import { absentAnchors, correlate, type ExistingObject } from './correlate.js';
import { normaliseDn, parentDn } from './dn.js';
import {
  diffMemberships,
  diffObjects,
  type MembershipState,
  type ProposedChange,
} from './diff.js';
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
 *
 * ## Why this is several short transactions and not one
 *
 * `withTenant` is `prisma.$transaction(fn)`, and the client is built with no
 * `transactionOptions`, so Prisma's defaults apply: a five-second budget for
 * the whole callback. Reading a production-sized directory over the network
 * takes longer than that on its own, so a single transaction spanning the
 * LDAP read aborts with P2028 and every run against a real directory fails.
 * Raising the timeout is not the fix either — that holds a pooled database
 * connection open across a network read to a third-party server.
 *
 * So the work is phased. Each phase that touches a tenant-scoped table gets
 * its own short `withTenant`; the LDAP read (phase 3) and the diff
 * computation (phase 5) touch no database at all and run outside any
 * transaction. Nothing carries a `tx` handle across a phase boundary.
 *
 * **Phase 6 must stay one transaction.** The proposed changes and the run's
 * terminal status commit together or not at all, which is what keeps the
 * spec's promise (section 8) that "a run that fails partway writes no changes
 * at all". Splitting it would allow a run marked `previewed` with no changes
 * recorded, or changes recorded against a run still marked `running`. Equally,
 * do not re-merge the earlier phases back into it: one long transaction around
 * the directory read is the exact bug this shape exists to prevent.
 */
export async function previewRun(
  tenantId: string,
  provider: MasterKeyProvider,
  sourceId: string,
) {
  // Phase 1: create the run row, so there is something to mark `failed` no
  // matter where the rest of this gives out.
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such source: ${sourceId}`);
    const boundTenant = await currentTenant(tx);
    return tx.syncRun.create({ data: { tenantId: boundTenant, sourceId } });
  });

  try {
    // Phase 2: read the configuration out, then close the transaction. Plain
    // data, deliberately not a `tx` handle — nothing downstream may hold one
    // open across the directory read.
    const prepared = await withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
      if (!source) throw new Error(`no such source: ${sourceId}`);

      const config = await sourceWithPassword(tx, provider, sourceId);
      if (!config) throw new Error('source configuration or credential missing');

      return {
        config,
        rules: await mappingsFor(tx, sourceId),
        thresholdPercent: source.deactivationThresholdPercent,
      };
    });

    // Phase 3: the directory read, outside any transaction. This is the slow,
    // network-bound part, and it holds no database connection while it runs.
    const records: SourceRecord[] = [];
    for await (const record of ldapConnector.read(prepared.config)) {
      records.push(record);
    }

    // Phase 4: one short transaction for the whole database-side snapshot the
    // diff is computed against. `loadExisting` returns each row's current
    // field values alongside it, so this is three `findMany`s and not the six
    // it was when the field maps were loaded per object type.
    const snapshot = await withTenant(tenantId, async (tx) => ({
      existing: await loadExisting(tx),
      memberships: await currentMemberships(tx, sourceId),
    }));

    // Phase 5: pure computation. No transaction, no I/O.
    const computed = computeDiff({
      records,
      rules: prepared.rules,
      sourceId,
      existing: snapshot.existing,
      currentMemberships: snapshot.memberships,
      thresholdPercent: prepared.thresholdPercent,
    });

    // Phase 6: the proposed changes and the run's terminal status, together.
    return await withTenant(tenantId, async (tx) => {
      const tenant = await currentTenant(tx);

      await tx.syncChange.createMany({
        data: computed.changes.map((c) => ({
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

      return tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: computed.verdict.blocked ? 'blocked' : 'previewed',
          blockedReason: computed.verdict.blocked ? computed.verdict.reason : null,
          // Only the threshold refusal is confirmable. A run that read nothing
          // is refused outright, so it is written `false` rather than left to
          // read as "an administrator could wave this through".
          requiresConfirmation: computed.verdict.blocked
            ? computed.verdict.requiresConfirmation
            : false,
          recordsRead: records.length,
          unresolvedMembers: computed.unresolvedMembers,
          mappingFailures: computed.mappingFailures,
          mappingFailureReasons: computed.mappingFailureReasons,
          finishedAt: new Date(),
        },
      });
    });
  } catch (cause) {
    // Covers phases 2 through 6. Its own transaction, because the one that
    // failed is already aborted and cannot accept this update.
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

/** Everything the diff correlates against, snapshotted in one transaction. */
interface ExistingSnapshot {
  objects: ExistingObject[];
  /**
   * Current stored field values, keyed by row id. Ids are unique across the
   * three object types, so one map serves all of them.
   */
  fields: Map<string, Record<string, string>>;
}

interface DiffInput {
  records: SourceRecord[];
  rules: MappingRule[];
  sourceId: string;
  existing: ExistingSnapshot;
  currentMemberships: MembershipState[];
  thresholdPercent: number;
}

/**
 * The whole diff, as a pure function of what the source returned and what the
 * snapshot held. No transaction, no I/O: everything here is reproducible from
 * its inputs, which is what lets it sit between two short transactions rather
 * than inside one long one.
 */
function computeDiff(input: DiffInput) {
  const objects: DirectoryObject[] = [];

  // Anchors the source returned but that we could not turn into an object,
  // partitioned by type exactly as the correlation loop below is. These are
  // *not* absent: a record we failed to understand is still a record the
  // source has, and treating it as absent proposes deactivating a real person
  // on the strength of our own failure.
  const unmappable: Record<ObjectType, Set<string>> = {
    user: new Set(),
    group: new Set(),
    orgUnit: new Set(),
  };
  const failureReasons: string[] = [];
  let mappingFailures = 0;

  const unmappableAnchors = new Set<string>();

  const failed = (record: SourceRecord, reason: string) => {
    mappingFailures++;
    unmappable[record.objectType].add(record.anchor);
    unmappableAnchors.add(record.anchor);
    if (!failureReasons.includes(reason)) failureReasons.push(reason);
  };

  // Where each organizational unit SITS, keyed the way a child names it.
  //
  // Built from every record the source returned rather than from the mapped
  // ones: a unit whose `name` mapping failed is still a unit the directory
  // has, and its children are still inside it.
  const orgUnitAnchorByDn = new Map(
    input.records
      .filter((r) => r.objectType === 'orgUnit')
      .map((r) => [normaliseDn(r.dn), r.anchor]),
  );

  /**
   * The anchor of the organizational unit containing `dn`, or undefined.
   *
   * UNDEFINED IS NOT "NO PARENT". It means this run could not see the parent —
   * the unit sits above the configured search base, or its read failed — and
   * the caller must then propose nothing, leaving whatever placement Syntra
   * already holds. `fields` is differenced against what is stored, so an
   * omitted key produces no change and a key set to `''` proposes detaching
   * the row from its unit. Those are opposite answers, and the second one is
   * only ever correct when the directory actually said so.
   */
  const parentAnchorOf = (dn: string): string | undefined => {
    const parent = parentDn(dn);
    if (parent === null) return undefined;
    return orgUnitAnchorByDn.get(normaliseDn(parent));
  };

  for (const record of input.records) {
    // The connector could see the object but not read it in full — an Active
    // Directory group whose membership came back range-truncated. Treated
    // exactly like a mapping failure: counted, reported, excluded from the
    // diff, and never counted as absent.
    if (record.readFailure !== undefined) {
      failed(record, record.readFailure);
      continue;
    }

    const mapped = mapRecord(record, input.rules);
    // The anchor and the object type come from the record, not the failure:
    // the failure only knows what went wrong, and the set has to be keyed the
    // same way the per-type loop reads it.
    if (isMappingFailure(mapped)) failed(record, mapped.reason);
    else {
      // PLACEMENT IS NOT A MAPPING. `parentAnchor` rides in `fields` so the
      // ordinary field diff picks it up — before and after, one change, shown
      // to whoever reviews the run — but it is never something a mapping rule
      // may target: it comes from the directory's own hierarchy, and
      // `ASSIGNABLE_FIELDS` deliberately does not list it.
      //
      // Groups are left out. Syntra's `Group` has no organizational unit.
      if (record.objectType !== 'group') {
        const parent = parentAnchorOf(record.dn);
        if (parent !== undefined) mapped.fields.parentAnchor = parent;
      }
      objects.push(mapped);
    }
  }

  // Built from every record the source returned, not only the ones that
  // mapped. A member's anchor is known the moment the source names it; losing
  // that because some other attribute was missing would report a member the
  // source plainly returned as unresolved.
  const dnToAnchor = new Map(input.records.map((r) => [r.dn, r.anchor]));
  let unresolvedMembers = 0;
  // Groups holding a member DN this run could not resolve. Their membership
  // was read in part, and a partial read must not produce removals — see
  // `diffMemberships`.
  const incompleteGroups = new Set<string>();
  const changes: ProposedChange[] = [];

  // Groups that correlated cleanly. A conflict group is never created, so a
  // membership referencing one could never be applied: at apply time the
  // group lookup fails, the change is marked `failed`, and the whole run ends
  // `partially_applied` even though everything appliable applied cleanly. One
  // group colliding with a locally managed name should not make the run look
  // half-broken.
  const usableGroups = new Set<string>();

  // The same thing on the member axis. A user that correlates to a locally
  // managed account is a conflict and is never created with this source's
  // anchor, so an `add_member` naming it fails its user lookup at apply time
  // and drags the whole run to `partially_applied`.
  const usableMembers = new Set<string>();

  for (const type of ['user', 'group', 'orgUnit'] as const) {
    const ofType = objects.filter((o) => o.objectType === type);
    const rows = input.existing.objects.filter((e) => e.objectType === type);
    const correlations = correlate(ofType, rows, input.sourceId);
    const absent = absentAnchors(ofType, rows, input.sourceId, unmappable[type]);
    changes.push(...diffObjects(correlations, absent, input.existing.fields));

    if (type === 'group') {
      for (const correlation of correlations) {
        if (correlation.kind !== 'conflict') {
          usableGroups.add(correlation.object.anchor);
        }
      }
    }

    if (type === 'user') {
      for (const correlation of correlations) {
        if (correlation.kind !== 'conflict') {
          usableMembers.add(correlation.object.anchor);
        }
      }
    }
  }

  const membersNow = new Map(
    input.currentMemberships.map((m) => [m.groupAnchor, new Set(m.memberAnchors)]),
  );

  const desired: MembershipState[] = objects
    .filter((o) => o.objectType === 'group' && usableGroups.has(o.anchor))
    .map((group) => {
      const now = membersNow.get(group.anchor) ?? new Set<string>();
      const memberAnchors: string[] = [];

      for (const dn of group.memberDns) {
        const anchor = dnToAnchor.get(dn);
        if (!anchor) {
          // A DN naming nothing this read returned. It is NOT evidence that
          // the member left: a person who moved between organizational units
          // seconds ago is referenced by their old DN until the directory's
          // referential-integrity overlay catches up, and a member outside the
          // configured search base never appears in the read at all. Counted,
          // surfaced on the run, and — the load-bearing half — recorded as a
          // gap in this group's read, so no removal is proposed for it.
          unresolvedMembers++;
          incompleteGroups.add(group.anchor);
          continue;
        }
        // A member we could not map is left exactly as it stands: kept if
        // Syntra already holds the membership, not proposed if it does not.
        // Revoking someone's access because one of their attributes went
        // missing is the same mistake as deactivating them for it.
        if (unmappableAnchors.has(anchor) && !now.has(anchor)) continue;

        // The same rule for a member this run cannot resolve to a user of
        // this source: a conflicting account, or a DN that names something
        // that is not a user at all (a nested group). Dropping it outright
        // would be worse than proposing it — `desired` is differenced against
        // what Syntra holds, so an omitted anchor reads as "remove this
        // member" and revokes a real person's real access on the strength of
        // a name collision. Kept if held, not proposed if not.
        if (!usableMembers.has(anchor) && !now.has(anchor)) continue;
        memberAnchors.push(anchor);
      }

      return { groupAnchor: group.anchor, memberAnchors };
    });

  changes.push(...diffMemberships(desired, input.currentMemberships, incompleteGroups));

  // Derived from the same snapshot the diff was computed against rather than
  // from separate count queries: the numerator and the denominator have to
  // describe one moment for the share between them to mean anything.
  const activeFromSource = (type: ObjectType) =>
    input.existing.objects.filter(
      (e) =>
        e.objectType === type &&
        e.sourceId === input.sourceId &&
        e.status === 'active',
    ).length;

  const verdict = evaluateGuard({
    changes,
    recordsRead: input.records.length,
    activeUsersFromSource: activeFromSource('user'),
    activeGroupsFromSource: activeFromSource('group'),
    currentMembershipsFromSource: input.currentMemberships.reduce(
      (n, m) => n + m.memberAnchors.length,
      0,
    ),
    thresholdPercent: input.thresholdPercent,
  });

  return {
    changes,
    unresolvedMembers,
    mappingFailures,
    // Distinct, and capped: an outage that fails every record produces one
    // reason repeated, and the page needs a list an administrator can read.
    mappingFailureReasons: failureReasons.slice(0, 10),
    verdict,
  };
}

/**
 * Every row a run could correlate against, with its current field values, in
 * three queries. The field values ride along with the rows because the diff
 * needs both, and loading them separately meant reading each table twice.
 */
async function loadExisting(tx: TenantClient): Promise<ExistingSnapshot> {
  const users = await tx.user.findMany();
  const groups = await tx.group.findMany();
  const units = await tx.orgUnit.findMany();

  // Placement, expressed in the SOURCE's vocabulary rather than in local ids.
  // The diff compares what the directory says against what is stored, and the
  // directory speaks anchors; a row placed in a locally managed unit has no
  // anchor to offer and reads as unplaced, which is what makes the directory's
  // answer win.
  const anchorOfUnit = new Map(units.map((o) => [o.id, o.sourceAnchor ?? '']));
  const placement = (id: string | null): string =>
    id === null ? '' : (anchorOfUnit.get(id) ?? '');

  const fields = new Map<string, Record<string, string>>();
  for (const u of users) {
    fields.set(u.id, {
      login: u.login,
      email: u.email,
      displayName: u.displayName,
      parentAnchor: placement(u.orgUnitId),
    });
  }
  for (const g of groups) {
    fields.set(g.id, { name: g.name, description: g.description ?? '' });
  }
  for (const o of units) {
    fields.set(o.id, { name: o.name, parentAnchor: placement(o.parentId) });
  }

  return {
    fields,
    objects: [
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
    ],
  };
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
  opts: { only?: string[]; confirm?: boolean } = {},
) {
  const run = await withTenant(tenantId, (tx) =>
    tx.syncRun.findUnique({ where: { id: runId } }),
  );
  if (!run) throw new Error(`no such run: ${runId}`);

  // A blocked run is still fully readable, and one blocked only for exceeding
  // the threshold can be applied by someone who has read the numbers and said
  // so explicitly (spec section 9). A genuine cohort departure — a contractor
  // batch, a closed site — has to be processable through sync rather than by
  // hand. A run that read no records has `requiresConfirmation` false and is
  // refused whatever the caller sends, and the scheduler never passes
  // `confirm` at all, so `autoApply` can never satisfy this.
  if (run.status === 'blocked' && !(run.requiresConfirmation && opts.confirm)) {
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

  // Three passes, each referencing only what the ones before it have written.
  //
  //   organizational units, parents first — a unit's `parentId` and a user's
  //     `orgUnitId` both name a unit row that this run may only just have
  //     created, and a child applied before its parent resolves the parent to
  //     nothing and lands at the top of the tree;
  //   then users and groups, which name units;
  //   then memberships, which name users and groups.
  //
  // `orderBy: { id: 'asc' }` above is uuid order, which is to say no order at
  // all. Nothing in the rows themselves records the hierarchy, so it is
  // reconstructed here from the anchors the diff already carries.
  const unitChanges = changes.filter((c) => c.changeType.endsWith('_org_unit'));
  const unitByAnchor = new Map(
    unitChanges.flatMap((c) => (c.sourceAnchor === null ? [] : [[c.sourceAnchor, c]] as const)),
  );

  const units: typeof changes = [];
  const placed = new Set<string>();
  const walking = new Set<string>();
  const place = (change: (typeof changes)[number]) => {
    if (placed.has(change.id)) return;
    // A cycle cannot come out of a directory, which is a tree. It can come out
    // of a bug, and the cost of one here is a hang rather than a wrong answer,
    // so it is cheaper to refuse to recurse than to prove it impossible.
    if (walking.has(change.id)) return;
    walking.add(change.id);
    const parentAnchor = ((change.after ?? {}) as Record<string, unknown>).parentAnchor;
    if (typeof parentAnchor === 'string' && parentAnchor !== '') {
      const parent = unitByAnchor.get(parentAnchor);
      if (parent !== undefined && parent.id !== change.id) place(parent);
    }
    walking.delete(change.id);
    placed.add(change.id);
    units.push(change);
  };
  for (const change of unitChanges) place(change);

  const ordered = [
    ...units,
    ...changes.filter(
      (c) => !c.changeType.endsWith('_member') && !c.changeType.endsWith('_org_unit'),
    ),
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

/**
 * Marks a proposed change as skipped, so a run can be applied without it.
 *
 * Only a `proposed` change may be skipped. Flipping an already-applied change
 * to `skipped` would make the run's record state that a mutation which
 * committed to the directory never happened — falsifying what a run did, in a
 * product whose selling point is a tamper-evident log of exactly that.
 *
 * The status check is the `where` clause rather than a read followed by a
 * write, so two concurrent requests cannot both see `proposed` and both
 * proceed. The caller records the audit event in this same transaction.
 */
export async function skipChange(
  tx: TenantClient,
  changeId: string,
): Promise<void> {
  const { count } = await tx.syncChange.updateMany({
    where: { id: changeId, status: 'proposed' },
    data: { status: 'skipped' },
  });
  if (count === 0) {
    throw new Error('only a proposed change can be skipped');
  }
}

export async function listRuns(tx: TenantClient, sourceId?: string) {
  return tx.syncRun.findMany({
    where: sourceId ? { sourceId } : {},
    orderBy: { startedAt: 'desc' },
    take: 50,
  });
}
