import { withTenant } from '@syntra/db';
import {
  adTargetConnector,
  first,
  isEnabled,
  type DiscoveredEntitlement,
  type SourceRecord,
  type TargetConnector,
} from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { desiredState } from './desired.js';
import { evaluateProvisionGuard } from './guard.js';
import { planActions } from './plan.js';
import { reconcile, unprocessableScope } from './reconcile.js';
import { remitFor } from './entitlement-service.js';
import { targetWithCredential } from './target-service.js';
import type {
  ContractFacts,
  DesiredState,
  KnownAccount,
  PersonFacts,
  RuleFacts,
  TargetObject,
} from './types.js';

const MS_PER_DAY = 86_400_000;

/**
 * Another run for this target is already non-terminal and won the race.
 *
 * The partial unique index makes two concurrent starts a database refusal
 * rather than an application race, which is right — but nothing handled the
 * resulting `P2002`, so it surfaced as an opaque Prisma error, the job failed,
 * and the scheduler recorded nothing. This is what turns it into the loud skip
 * Ruling P4 already defines.
 */
export class ProvisionRunInFlightError extends Error {
  constructor(readonly targetSystemId: string) {
    super(
      `another run for target ${targetSystemId} is already in progress; this one did not start`,
    );
    this.name = 'ProvisionRunInFlightError';
  }
}

/**
 * The four statuses `provision_run_one_non_terminal` covers, verbatim.
 *
 * Written out rather than derived, and it must stay identical to the migration:
 * a status the index constrains and this list omits is a run nothing ever
 * adopts, which bricks the target on the first crash in that state.
 */
const NON_TERMINAL = ['running', 'previewed', 'blocked', 'applying'] as const;

/**
 * Every attribute value the target returned under this name, matched
 * case-insensitively.
 *
 * LDAP attribute names are case-insensitive (RFC 4512) and servers differ on
 * the case they echo back, so `record.attributes.memberOf` is a lookup that
 * works against one directory and silently returns nothing against the next —
 * and "this account holds no groups" is not a value this subsystem may guess
 * at. `first()` from `@syntra/connectors` is the single-value half of the same
 * fold; this is the multi-value half, which that function cannot express.
 */
function valuesOf(record: SourceRecord, attribute: string): string[] {
  const wanted = attribute.toLowerCase();
  for (const [key, values] of Object.entries(record.attributes)) {
    if (key.toLowerCase() === wanted) return values;
  }
  return [];
}

/**
 * A JSON rendering with sorted keys, so two objects that say the same thing
 * compare equal.
 *
 * Needed because a `Json` column round-trips through PostgreSQL `jsonb`, which
 * does not preserve key order — it sorts by key length then bytewise. A plain
 * `JSON.stringify` comparison between a freshly built detail object and the
 * one read back therefore differs on almost every run, and the "write only
 * what changed" narrowing that keeps phase 7 inside its transaction budget
 * degrades to writing everything.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(',')}}`;
}

/**
 * Adopts every run a dead process left non-terminal, then starts a new one.
 *
 * **A run left behind must be adopted, not stepped over.** The partial unique
 * index `provision_run_one_non_terminal` refuses a second non-terminal run for
 * a target, and it covers all four of `running`, `previewed`, `blocked` and
 * `applying`. Demoting only `previewed` and `blocked` leaves a run stuck in
 * `running` (the process died in phases 2 to 6) or `applying` (it died
 * mid-apply) permanently in place, and every subsequent run for that target
 * throws on the create. Forever. One crash bricks the target.
 *
 * The three cases are adopted differently because they mean different things:
 *
 * - `previewed` / `blocked`: a plan nobody applied. Superseded — its
 *   still-proposed actions are marked so, because two overlapping plans
 *   against one target can interleave a revocation from the older behind a
 *   grant from the newer, producing a state neither plan described and nobody
 *   approved.
 * - `running`: a preview that never finished. It wrote no plan, so it is
 *   simply failed.
 * - `applying`: writes may have landed at the target. Its `in_flight` actions
 *   are resolved **against the target, outside any transaction** before
 *   anything else happens, and the run is then `partially_applied` — an honest
 *   terminal state and not a claim that it finished.
 */
async function adoptStaleRunsAndStart(
  tenantId: string,
  targetSystemId: string,
  resolveInFlight: (targetSystemId: string) => Promise<number>,
): Promise<{ id: string }> {
  const stale = await withTenant(tenantId, async (tx) => {
    const runs = await tx.provisionRun.findMany({
      where: { targetSystemId, status: { in: [...NON_TERMINAL] } },
      select: { id: true, status: true },
    });

    await tx.provisionAction.updateMany({
      where: { status: 'proposed', run: { targetSystemId } },
      data: { status: 'superseded' },
    });
    await tx.provisionRun.updateMany({
      where: { targetSystemId, status: { in: ['previewed', 'blocked'] } },
      data: {
        status: 'failed',
        error: 'superseded by a later run',
        finishedAt: new Date(),
      },
    });
    await tx.provisionRun.updateMany({
      where: { targetSystemId, status: 'running' },
      data: {
        status: 'failed',
        error: 'this run was left running by a process that did not finish',
        finishedAt: new Date(),
      },
    });

    return runs.filter((r) => r.status === 'applying');
  });

  // Outside any transaction: this reads the target. An action found in_flight
  // is in an UNKNOWN state, not a failed one, and it has to be asked about
  // before anything new is planned.
  if (stale.length > 0) {
    await resolveInFlight(targetSystemId);
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: {
          status: 'partially_applied',
          error: 'this run was interrupted mid-apply and was adopted by a later run',
          finishedAt: new Date(),
        },
      }),
    );
  }

  try {
    return await withTenant(tenantId, async (tx) => {
      const bound = await currentTenant(tx);
      return tx.provisionRun.create({
        data: { tenantId: bound, targetSystemId, status: 'running' },
      });
    });
  } catch (cause) {
    // P2002 on `provision_run_one_non_terminal`: another process created a run
    // for this target between the adoption above and this create. The database
    // refused it, which is the correct outcome — this converts it into
    // something the scheduler can record rather than an opaque 500.
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'P2002'
    ) {
      throw new ProvisionRunInFlightError(targetSystemId);
    }
    throw cause;
  }
}

export interface PreviewProvisionRunOptions {
  now?: Date;
  connector?: TargetConnector<never>;
  /** Task 14 supplies `resolveInFlightActions` here. */
  resolveInFlight?: (targetSystemId: string) => Promise<number>;
}

export interface ProvisionRunSummary {
  id: string;
  status: string;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}

/**
 * Computes the whole plan, writes it down, and stops. Applying it is a
 * separate, explicit step (Task 14) — **including for a target with
 * `autoApply` set**: nothing here writes to the target, and the guard's
 * verdict is recorded on the run rather than acted on.
 *
 * **No `tx` handle crosses a phase boundary, and nothing that touches the
 * network is inside one.** `withTenant` is `prisma.$transaction(fn)` under
 * Prisma's 5000 ms default, and a whole directory read once sat inside one,
 * which made that subsystem unable to work against a real directory.
 *
 * 1. **Adopt** whatever the last process left behind, then create the run row,
 *    so there is something to mark `failed` however the rest gives out. Short
 *    transactions with the in-flight resolution (phase 3) between them.
 * 2. Read configuration and credentials. One short transaction; returns plain
 *    data, deliberately not a `tx`.
 * 3. Resolving `in_flight` actions from a crashed run happens inside phase 1's
 *    adoption, not after it — the create is what throws, so anything after it
 *    is unreachable on exactly the run that needed it.
 * 4. Read the target: accounts, containers and the entitlement catalog, and
 *    probe each in-remit group's membership. Network. No transaction, and
 *    holding no database connection while it runs.
 * 5. Snapshot the database side in one short transaction.
 * 6. Evaluate, reconcile, plan and guard. Pure. No transaction, no I/O.
 * 7. Write every account reservation, action, exception, drift finding and the
 *    run's terminal status **in one transaction**, so that a run which fails
 *    partway writes no plan at all.
 */
export async function previewProvisionRun(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  options: PreviewProvisionRunOptions = {},
): Promise<ProvisionRunSummary> {
  const now = options.now ?? new Date();
  const connector = (options.connector ??
    adTargetConnector) as unknown as TargetConnector<unknown>;
  // Task 14 supplies the real one. Until it does, a crashed `applying` run is
  // adopted without resolving its in-flight actions, which is still strictly
  // better than the target becoming permanently unrunnable.
  const resolveInFlight = options.resolveInFlight ?? (async () => 0);

  // Phase 1, and phase 3 inside it.
  const run = await adoptStaleRunsAndStart(tenantId, targetSystemId, resolveInFlight);

  try {
    // Phase 2.
    const prepared = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.findUniqueOrThrow({
        where: { id: targetSystemId },
      });
      const config = await targetWithCredential(tx, provider, targetSystemId);
      if (!config) throw new Error('target configuration or credential missing');
      const profile = await tx.accountProfile.findFirst({ where: { targetSystemId } });
      if (!profile) throw new Error('this target has no account profile');
      // The remit is read here rather than in phase 5 because phase 4 needs
      // it: only groups a business rule names are worth probing for a
      // truncated membership, and probing every group in a domain would be an
      // arbitrary number of extra round trips.
      const remit = await remitFor(tx, targetSystemId);
      const entitlementRows = await tx.entitlement.findMany({
        where: { targetSystemId },
        select: { id: true, externalId: true, dn: true },
      });
      return { target, config, profile, remit, entitlementRows };
    });

    // Phase 4. The slow, network-bound part, holding no database connection.
    const config = prepared.config;
    const externalIdToEntitlementId = new Map(
      prepared.entitlementRows.map((r) => [r.externalId, r.id]),
    );

    // The live catalog, read now rather than trusted from the last refresh.
    const catalog: DiscoveredEntitlement[] = [];
    for await (const entitlement of connector.listEntitlements(config)) {
      catalog.push(entitlement);
    }

    /**
     * DN (lowercased) to Syntra entitlement id.
     *
     * This map is the whole reason `DiscoveredEntitlement` carries a `dn`.
     * Active Directory reports a user's group membership in `memberOf` as a
     * list of DISTINGUISHED NAMES; `Entitlement.externalId` is the group's
     * objectGUID. Keying this on externalId means every lookup misses, every
     * account reads as holding nothing, every managed holding becomes
     * permanent `missing_grant` drift, the planner re-proposes grants for the
     * entire population forever, and the revocation guard's global axis has a
     * denominator of zero. No test catches it if the fake emits `memberOf`
     * keyed the way the consumer wants to read it (Ruling P8).
     *
     * The stored `dn` from the last catalog refresh is seeded first and the
     * live read overwrites it, so a group the catalog read did not return is
     * still resolvable from the last DN Syntra saw.
     */
    const dnToEntitlementId = new Map<string, string>();
    for (const row of prepared.entitlementRows) {
      if (row.dn !== null) dnToEntitlementId.set(row.dn.toLowerCase(), row.id);
    }
    for (const entitlement of catalog) {
      const id = externalIdToEntitlementId.get(entitlement.externalId);
      if (id !== undefined) dnToEntitlementId.set(entitlement.dn.toLowerCase(), id);
    }

    /**
     * Containers, read from the target and never inferred from account DNs.
     *
     * Deriving them from the accounts the target returned makes an empty
     * container invisible, and on a first run against an empty target makes
     * every container invisible — so every person with a required account
     * becomes `container_missing`, the run proposes nothing, and the container
     * can never become visible because no account can ever be created in it
     * (Ruling P9).
     */
    const existingContainers = new Set<string>();
    for await (const container of connector.listContainers(config)) {
      existingContainers.add(container.dn.toLowerCase());
    }

    /**
     * Groups whose membership could not be read in full, and groups that were
     * probed and read cleanly.
     *
     * Global Constraint 16 makes a rule naming an `unreadable` entitlement
     * unresolvable as a whole, and until this loop existed nothing anywhere
     * ever WROTE that status. A group whose ranged read fails was treated as
     * fully read with whatever came back, which is the exact fail-open Ruling
     * P1 exists to prevent, moved one level up from the connector into the run.
     *
     * Only in-remit groups are probed: a group no business rule names cannot
     * make any rule unresolvable, and probing every group in a domain would be
     * an unbounded number of round trips for nothing.
     *
     * Both sets are kept. The promotion in phase 7 runs off `readable` and
     * never off "everything that is not unreadable" — a group that dropped out
     * of the remit, or that the catalog read did not return this time, was not
     * probed at all, and promoting it to `present` on the strength of not
     * having failed a check it never took is how a rule becomes resolvable
     * against a membership nobody has ever read.
     */
    const unreadableEntitlementIds = new Set<string>();
    const readableEntitlementIds = new Set<string>();
    for (const entitlement of catalog) {
      const id = externalIdToEntitlementId.get(entitlement.externalId);
      if (id === undefined || !prepared.remit.has(id)) continue;
      try {
        await connector.readEntitlementMembers(config, entitlement.dn);
        readableEntitlementIds.add(id);
      } catch {
        unreadableEntitlementIds.add(id);
      }
    }

    const provenanceAttribute =
      (config as { provenanceAttribute?: string }).provenanceAttribute ?? 'info';

    const objects: TargetObject[] = [];
    for await (const record of connector.read(config)) {
      /**
       * Enabled is read from the ACCOUNTDISABLE bit, never from equality with
       * 512.
       *
       * `userAccountControl === 512` is false for every account an
       * administrator has ever touched — 66048 is an ordinary enabled account
       * with a non-expiring password — so an equality test reads most of a
       * real directory as disabled, proposes `enable_account` against accounts
       * that are already enabled forever, and collapses
       * `activeAccountsAtTarget`, the disable guard's denominator, towards
       * zero. `uac.ts` names this exact spelling as the mistake it exists to
       * prevent; the fake emits a bare 512/514, so no fixture distinguishes
       * the two readings.
       *
       * An absent or unparseable value is read as NOT enabled. The connector
       * contract has no third state, and of the two available answers this is
       * the one that fails closed on the guarded axis: it shrinks
       * `activeAccountsAtTarget` towards zero, which makes a disable plan
       * refuse for want of a denominator rather than sail under an inflated
       * one. What it costs is a redundant `enable_account`, which is in the
       * additive, idempotent, deliberately unguarded class.
       */
      const uacRaw = first(record, 'userAccountControl');
      const uac = uacRaw === undefined ? Number.NaN : Number(uacRaw);
      const enabled = Number.isFinite(uac) && isEnabled(uac);

      objects.push({
        anchor: record.anchor,
        correlationKey: first(record, 'sAMAccountName') ?? '',
        dn: record.dn,
        enabled,
        provenance: first(record, provenanceAttribute) ?? null,
        // Mapped from DNs, which is what memberOf contains.
        entitlementIds: valuesOf(record, 'memberOf')
          .map((dn) => dnToEntitlementId.get(dn.toLowerCase()))
          .filter((id): id is string => id !== undefined),
        readComplete: record.readFailure === undefined,
      });
    }

    /**
     * How many accounts at the target hold each entitlement — the denominator
     * of the guard's per-entitlement axis, and the value written onto
     * `Entitlement.holderCount`.
     *
     * From the TARGET, per spec section 11, and from the same read that
     * produced the actions. Syntra's `AccountEntitlement` rows measure what
     * Provision believes it granted; on a first run, or on a target whose
     * recorded inventory has come apart, every count is zero — and Ruling P25
     * made a zero denominator against a non-zero revocation count a refusal,
     * so building this from the wrong side does not weaken the axis, it blocks
     * every run that would revoke anything.
     */
    const holdersAtTarget = new Map<string, number>();
    for (const object of objects) {
      for (const entitlementId of object.entitlementIds) {
        holdersAtTarget.set(entitlementId, (holdersAtTarget.get(entitlementId) ?? 0) + 1);
      }
    }

    /**
     * Phase 5. One short transaction for the whole database-side snapshot.
     *
     * **A known limit, recorded rather than hidden.** This loads every
     * `Person` with every `Contract`, every `TargetAccount` with its held
     * entitlements and every linked `User`, inside one Prisma interactive
     * transaction, under the 5000 ms default (Global Constraint 2). At the
     * 40,000-holding scale the guard's own docstrings assume, that will time
     * out. It is one transaction on purpose — desired state, actual state and
     * the guard's denominators must all describe the same instant, and a
     * snapshot stitched together from four unsynchronised reads is a plan
     * computed against a world that never existed.
     *
     * The fix, when a tenant reaches that size, is paged reads outside a
     * transaction for the person and account sets with a short transaction
     * around only the consistency-critical part, or a raised
     * `transactionOptions.timeout` on this call specifically. Both are
     * deliberate changes and neither is made here on speculation.
     */
    const snapshot = await withTenant(tenantId, async (tx) => {
      const persons = await tx.person.findMany({
        include: { contracts: true },
        // Total and stable. Correlation keys are generated in this order and
        // the generator's numeric suffix makes the order observable: two
        // people with the same name get `anna.novak` and `anna.novak2`, and
        // an unordered read hands them out differently on different runs,
        // proposing a rename of both people to each other's login. Ordered by
        // creation so the person who was there first keeps the plain name.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const rules = await tx.businessRule.findMany({
        where: { targetSystemId },
        include: { entitlements: true },
      });
      const entitlements = await tx.entitlement.findMany({ where: { targetSystemId } });
      const accounts = await tx.targetAccount.findMany({
        where: { targetSystemId },
        include: { entitlements: { where: { state: 'held' } } },
      });
      const users = await tx.user.findMany({
        where: { personId: { not: null } },
        select: { id: true, personId: true, status: true },
      });
      const previous = await tx.provisionRun.findFirst({
        where: { targetSystemId, status: { in: ['applied', 'partially_applied'] } },
        orderBy: { startedAt: 'desc' },
      });
      return {
        persons,
        rules,
        entitlements,
        accounts,
        users,
        previousPersons: previous?.personsWithActiveContract ?? null,
        hasEverApplied: prepared.target.lastAppliedRunAt !== null,
      };
    });

    // Phase 6. Pure computation. No transaction, no I/O.
    const horizon = new Date(now.getTime() + prepared.target.preHireDays * MS_PER_DAY);

    // The catalog's stored status, with this run's membership probe merged
    // over it. `unreadable` wins: a group whose membership could not be read
    // must make every rule naming it unresolvable NOW, on this run, not on the
    // next one after phase 7 has written the status down.
    const entitlementStatus = new Map(
      snapshot.entitlements.map((e) => [
        e.id,
        unreadableEntitlementIds.has(e.id)
          ? ('unreadable' as const)
          : (e.status as 'present' | 'missing' | 'unreadable'),
      ]),
    );
    const ruleFacts: RuleFacts[] = snapshot.rules.map((r) => ({
      id: r.id,
      name: r.name,
      condition: r.condition as never,
      grantsAccount: r.grantsAccount,
      enabled: r.enabled,
      entitlementIds: r.entitlements.map((j) => j.entitlementId),
    }));

    /**
     * Correlation keys that are spoken for, **accumulated across the loop**.
     *
     * Seeded from Syntra's own rows and the target's inventory, and then added
     * to as each person's key is generated. Without the accumulation two new
     * people with the same name are both handed `anna.novak`: neither is in
     * the seed set, the generator's numeric suffix never fires, and the
     * reservation write in phase 7 hits the unique index on
     * `(tenantId, targetSystemId, correlationKey)` — which is the backstop
     * doing its job, but it fails the whole run rather than naming the second
     * person `anna.novak2`, and it fails it again on every retry. `desired.ts`
     * reads this set once per call, so mutating it between calls is what makes
     * the generator see the keys this run has already handed out.
     */
    const takenKeys = new Set([
      ...snapshot.accounts.map((a) => a.correlationKey),
      ...objects.map((o) => o.correlationKey),
    ]);
    const knownByPerson = new Map(snapshot.accounts.map((a) => [a.personId, a]));

    const desired: DesiredState[] = [];
    const contractsByPerson = new Map<string, ContractFacts[]>();

    for (const person of snapshot.persons) {
      const contracts: ContractFacts[] = person.contracts.map((c) => ({
        id: c.id,
        sequence: c.sequence,
        isPrimary: c.isPrimary,
        startDate: c.startDate,
        endDate: c.endDate,
        department: c.department,
        jobTitle: c.jobTitle,
        costCentre: c.costCentre,
        employer: c.employer,
        location: c.location,
        fte: c.fte === null ? null : Number(c.fte),
      }));
      contractsByPerson.set(person.id, contracts);

      // The columns Person actually has. There is no `email` and no
      // `displayName` on the model, and spec section 15 forbids adding one.
      const facts: PersonFacts = {
        id: person.id,
        givenName: person.givenName,
        familyName: person.familyName,
        nameConvention: person.nameConvention,
        businessEmail: person.businessEmail,
        personalEmail: person.personalEmail,
        status: person.status,
      };

      const state = desiredState({
        person: facts,
        contracts,
        rules: ruleFacts,
        profile: {
          correlationKeyTemplate: prepared.profile.correlationKeyTemplate,
          maxUniquenessAttempts: prepared.profile.maxUniquenessAttempts,
          containerTemplate: prepared.profile.containerTemplate,
          fallbackContainer: prepared.profile.fallbackContainer,
          attributeTemplates: prepared.profile.attributeTemplates as Record<string, string>,
          baseDn: config.baseDn,
        },
        entitlementStatus,
        existingCorrelationKey: knownByPerson.get(person.id)?.correlationKey ?? null,
        takenCorrelationKeys: takenKeys,
        renameEnabled: prepared.target.renameEnabled,
        now,
        horizon,
      });
      const generatedKey = state.account?.correlationKey;
      if (typeof generatedKey === 'string' && generatedKey !== '') {
        takenKeys.add(generatedKey);
      }
      desired.push(state);
    }

    const known: KnownAccount[] = snapshot.accounts.map((a) => ({
      id: a.id,
      personId: a.personId,
      anchor: a.anchor,
      correlationKey: a.correlationKey,
      status: a.status as KnownAccount['status'],
      disabledAt: a.disabledAt,
      lastAppliedAttributes: (a.lastAppliedAttributes ?? {}) as Record<string, string[]>,
      holdings: a.entitlements.map((h) => ({
        entitlementId: h.entitlementId,
        origin: h.origin as 'rule' | 'manual' | 'discovered',
        grantedByRuleId: h.grantedByRuleId,
      })),
    }));

    const reconciled = reconcile({
      desired,
      known,
      objects,
      remit: prepared.remit,
      // Read in phase 4, not derived from the DNs of the accounts the target
      // returned. Lowercased on both sides because DN comparison is
      // case-insensitive and a profile written in one case and an OU created
      // in another is an ordinary configuration, not an error.
      existingContainers,
      // In the case the profile produced: `reconcile` lowercases for the
      // comparison and reports the original, so the exception names the
      // container the administrator wrote rather than a mangled one.
      desiredContainers: new Map(
        desired
          .filter((d) => d.account?.required)
          .map((d) => [d.personId, d.account!.container]),
      ),
      enforcementMode: prepared.target.enforcementMode as 'additive' | 'authoritative',
    });

    const actions = planActions({
      desired,
      actual: reconciled.actual,
      contractsByPerson,
      syntraUserByPerson: new Map(
        snapshot.users
          .filter((u) => u.personId !== null)
          .map((u) => [u.personId!, { id: u.id, status: u.status }]),
      ),
      pairedDirectorySource: prepared.target.pairedDirectorySourceId !== null,
      ladder: {
        entitlementRevocationDelayDays: prepared.target.entitlementRevocationDelayDays,
        disableGraceDays: prepared.target.disableGraceDays,
        archiveAfterDays: prepared.target.archiveAfterDays,
        reenableWithoutConfirmationDays: prepared.target.reenableWithoutConfirmationDays,
        renameEnabled: prepared.target.renameEnabled,
      },
      now,
    });

    const personsWithActiveContract = snapshot.persons.filter((p) =>
      p.contracts.some(
        (c) =>
          c.startDate.getTime() <= now.getTime() &&
          (c.endDate === null || c.endDate.getTime() >= now.getTime()),
      ),
    ).length;

    /**
     * The guard, at the call site.
     *
     * `autoApply` is not consulted here and is not an input to
     * `evaluateProvisionGuard`. There is deliberately no path by which a
     * schedule waives it: an unattended run is the case the control exists
     * for, and confirmation is a person reading numbers, which a scheduler
     * cannot do.
     */
    const verdict = evaluateProvisionGuard({
      actions,
      thresholds: {
        createAccountThresholdPercent: prepared.target.createAccountThresholdPercent,
        disableAccountThresholdPercent: prepared.target.disableAccountThresholdPercent,
        archiveAccountThresholdPercent: prepared.target.archiveAccountThresholdPercent,
        revokeEntitlementThresholdPercent:
          prepared.target.revokeEntitlementThresholdPercent,
        deactivateSyntraUserThresholdPercent:
          prepared.target.deactivateSyntraUserThresholdPercent,
        perEntitlementThresholdPercent: prepared.target.perEntitlementThresholdPercent,
        personPopulationDropPercent: prepared.target.personPopulationDropPercent,
      },
      accountsAtTarget: objects.length,
      // No `|| known.length` fallback. Substituting Syntra's belief whenever
      // NO account at the target is enabled replaces the denominator on
      // exactly the input the disable guard exists for -- "everything is
      // disabled" -- with a number that makes the percentage look small. If
      // the denominator is genuinely zero, the zero-accounts refusal or the
      // first-run confirmation has already caught it.
      activeAccountsAtTarget: objects.filter((o) => o.enabled).length,
      entitlementHoldingsAtTarget: objects.reduce(
        (total, o) => total + o.entitlementIds.length,
        0,
      ),
      activeSyntraUsersLinked: snapshot.users.filter((u) => u.status === 'active').length,
      holderCountByEntitlement: holdersAtTarget,
      entitlementNameById: new Map(snapshot.entitlements.map((e) => [e.id, e.displayName])),
      personsWithActiveContract,
      previousPersonsWithActiveContract: snapshot.previousPersons,
      hasEverApplied: snapshot.hasEverApplied,
    });

    const exceptions = [
      ...desired
        .filter((d) => d.unprocessable !== null)
        .map((d) => ({ personId: d.personId, ...d.unprocessable! })),
      ...[...reconciled.extraUnprocessable].map(([personId, value]) => ({
        personId,
        ...value,
      })),
    ];
    // The column counts PEOPLE. A person can collect one verdict from
    // `desiredState` and a second from `reconcile` — `unresolvable_rule` is
    // scoped to grants, so reconciliation carries on and may still find their
    // account in conflict — and reporting two would make the run's own summary
    // disagree with the list of names underneath it.
    const personsUnprocessable = new Set(exceptions.map((e) => e.personId)).size;

    const counts = (type: string) => actions.filter((a) => a.actionType === type).length;

    // Phase 7. Everything, together.
    return await withTenant(tenantId, async (tx) => {
      const bound = await currentTenant(tx);

      /**
       * The account has a durable identity in Syntra before it has one in the
       * target.
       *
       * Nothing else in the system creates a `TargetAccount`. Without this,
       * `planActions` emits `create_account` with `accountId: null`, the apply
       * resolves no account, and Task 14's `finish()` — which guards every
       * inventory write behind `if (status === 'applied' && meta.accountId)` —
       * skips the anchor, the status, the `createdActionId`, the applied
       * attributes and the `AccountEntitlement` row. Every one of them. The
       * next run then sees no account, computes `existsAtTarget: false`,
       * proposes `create_account` again, and the connector finds an object
       * under the same `sAMAccountName` carrying a different actionId and
       * returns `conflict` — so every person Provision ever created ends up
       * permanently in conflict on run two.
       *
       * Spec section 5: the correlation key is reserved HERE, by the unique
       * index on `(tenantId, targetSystemId, correlationKey)`, before anything
       * is written to the target — which is what makes two concurrent runs
       * generating the same login a race the database refuses rather than one
       * the application is trusted to avoid.
       *
       * `status: 'pending'` and a null anchor: the row is a reservation, not a
       * claim that the account exists. `reconcile` knows not to treat a
       * pending row as a vanished account, and the partial unique index on
       * `anchor` permits many null anchors and only one of each real one.
       *
       * Written with `createMany` rather than a per-person `upsert`: an upsert
       * loop is one round trip per person inside a transaction on a 5000 ms
       * budget, which at four thousand joiners cannot finish, aborts with
       * P2028, and fails identically on every retry. The upsert's `update` was
       * `{}` — an existing account's status, anchor and applied attributes
       * belong to the apply, not to a preview — so `skipDuplicates` says
       * exactly the same thing in one statement.
       */
      const needReservation = desired.filter((state) => {
        // RULING P23. `state.unprocessable` is not a blanket skip: it carries
        // a scope, and at `grants` scope only the person's entitlement set is
        // unknown. Skipping every unprocessable person here reserves no row,
        // so no account is created, so somebody who should have one silently
        // never gets it because a rule names an entitlement that was deleted.
        // Decided by the same function `reconcile` and `plan` decide it with,
        // rather than restated — three modules with three copies of this rule
        // is three chances for one of them to disagree.
        const scope = state.unprocessable
          ? unprocessableScope(state.unprocessable.kind)
          : null;
        if (scope === 'all') return false;
        if (state.notYetStarted) return false;
        // Reconciliation refused this person after desired state was computed
        // — their container is not there, their account is in conflict, or the
        // target could not be read in full for them. `planActions` proposes
        // nothing for them (they have no `actual` entry), so a reservation
        // here would sit `pending` forever, holding a login nobody will ever
        // be given, against a person nobody is acting on. Reserve exactly the
        // set the plan can name.
        if (reconciled.extraUnprocessable.has(state.personId)) return false;
        if (!state.account?.required) return false;
        return state.account.correlationKey !== null;
      });

      if (needReservation.length > 0) {
        await tx.targetAccount.createMany({
          data: needReservation.map((state) => ({
            tenantId: bound,
            targetSystemId,
            personId: state.personId,
            correlationKey: state.account!.correlationKey!,
            status: 'pending',
          })),
          skipDuplicates: true,
        });
      }

      const reservedRows = await tx.targetAccount.findMany({
        where: {
          targetSystemId,
          personId: { in: needReservation.map((state) => state.personId) },
        },
        select: { id: true, personId: true },
      });
      const accountIdByPerson = new Map(reservedRows.map((r) => [r.personId, r.id]));
      // `skipDuplicates` swallows a violation of EITHER unique index, and the
      // second one is on the correlation key. A row skipped because another
      // person already holds that login would otherwise leave this person's
      // `create_account` carrying a null accountId — the exact silent state
      // the reservation exists to prevent — so it is a refusal instead.
      const unreserved = needReservation.filter(
        (state) => !accountIdByPerson.has(state.personId),
      );
      if (unreserved.length > 0) {
        throw new Error(
          `could not reserve an account for ${unreserved.length} person(s) on this target; ` +
            `the correlation key ${unreserved[0]!.account!.correlationKey} is already held by another account`,
        );
      }

      await tx.provisionAction.createMany({
        data: actions.map((a, index) => ({
          tenantId: bound,
          runId: run.id,
          actionType: a.actionType,
          personId: a.personId,
          // The reserved row, for the actions the planner could not name one
          // for -- everything for a person who had no account before this run.
          accountId:
            a.accountId ??
            (a.personId === null ? null : (accountIdByPerson.get(a.personId) ?? null)),
          entitlementId: a.entitlementId,
          before: (a.before ?? undefined) as never,
          after: (a.after ?? undefined) as never,
          attributedRuleIds: a.attributedRuleIds,
          requiresConfirmation: a.requiresConfirmation,
          message: a.message,
          // `planActions` already returned these sorted by ACTION_ORDER, and
          // this is what preserves that through the write. `createdAt` cannot:
          // PostgreSQL's `now()` is transaction start time, so every row this
          // `createMany` writes carries an identical timestamp and ordering by
          // it imposes no order at all -- which lets a grant be attempted
          // before the create it depends on, nondeterministically.
          sequence: index,
        })),
      });

      await tx.provisionException.createMany({
        data: exceptions.map((e) => ({
          tenantId: bound,
          runId: run.id,
          personId: e.personId,
          targetSystemId,
          kind: e.kind,
          message: e.message,
        })),
      });

      /**
       * Drift, in a bounded number of statements.
       *
       * A per-finding `upsert` is one round trip each and the count is
       * unbounded: a first run against a directory Syntra holds no accounts
       * for raises one `orphan_account` per object in it. Ten thousand upserts
       * do not finish inside `withTenant`'s 5000 ms, the transaction aborts
       * with P2028, and the retry re-runs the same statements against the same
       * directory — permanently, not transiently. Sixth-and-seventh instance
       * of the same defect on this programme, so it is written as: read what
       * is there, insert what is not, stamp the rest, and update only the rows
       * whose detail genuinely changed — which on a run that saw the same
       * problems as the last one is none.
       */
      const seenAt = new Date();
      const findings = reconciled.findings;
      if (findings.length > 0) {
        const fingerprints = findings.map((f) => f.fingerprint);
        const existing = await tx.driftFinding.findMany({
          where: { targetSystemId, fingerprint: { in: fingerprints } },
          select: { fingerprint: true, subjectAnchor: true, detail: true },
        });
        const existingByFingerprint = new Map(existing.map((e) => [e.fingerprint, e]));

        const fresh = findings.filter((f) => !existingByFingerprint.has(f.fingerprint));
        if (fresh.length > 0) {
          await tx.driftFinding.createMany({
            data: fresh.map((finding) => ({
              tenantId: bound,
              targetSystemId,
              runId: run.id,
              accountId: finding.accountId,
              entitlementId: finding.entitlementId,
              subjectAnchor: finding.subjectAnchor,
              kind: finding.kind,
              detail: finding.detail as never,
              fingerprint: finding.fingerprint,
              firstSeenAt: seenAt,
              lastSeenAt: seenAt,
            })),
            // A concurrent run may have inserted the same fingerprint between
            // the read above and this write. The row exists and says the same
            // thing; the sweep below stamps it.
            skipDuplicates: true,
          });
        }

        // Every finding this run saw is stamped, new or not, so `lastSeenAt`
        // means "still true as of this run" and the dashboard can age findings
        // out. `firstSeenAt` is never touched: it is the answer to "how long
        // has this been wrong", which is the only question that makes a drift
        // list actionable.
        await tx.driftFinding.updateMany({
          where: { targetSystemId, fingerprint: { in: fingerprints } },
          data: { runId: run.id, lastSeenAt: seenAt },
        });

        for (const finding of findings) {
          const before = existingByFingerprint.get(finding.fingerprint);
          if (before === undefined) continue;
          if (
            before.subjectAnchor === finding.subjectAnchor &&
            stableJson(before.detail) === stableJson(finding.detail)
          ) {
            continue;
          }
          await tx.driftFinding.update({
            where: {
              tenantId_targetSystemId_fingerprint: {
                tenantId: bound,
                targetSystemId,
                fingerprint: finding.fingerprint,
              },
            },
            data: {
              subjectAnchor: finding.subjectAnchor,
              detail: finding.detail as never,
            },
          });
        }
      }

      /**
       * The membership probe's verdict, written down so the catalog screen and
       * the rules editor can show it and so the next run starts from it.
       *
       * Only entitlements this run actually probed move. The promotion is
       * keyed on `in: readable` and never on `notIn: unreadable`: with nothing
       * unreadable, `notIn: []` matches every row (the same Prisma semantics
       * that made an empty catalog read condemn a whole catalog in Task 12),
       * so a group that was never probed — out of remit now, or absent from
       * this run's catalog read — would be promoted to `present` on the
       * strength of not having failed a check it never took. `missing` is left
       * to `refreshEntitlements`, which is the function that knows about it.
       */
      if (unreadableEntitlementIds.size > 0) {
        await tx.entitlement.updateMany({
          where: { targetSystemId, id: { in: [...unreadableEntitlementIds] } },
          data: { status: 'unreadable' },
        });
      }
      if (readableEntitlementIds.size > 0) {
        await tx.entitlement.updateMany({
          where: {
            targetSystemId,
            status: 'unreadable',
            id: { in: [...readableEntitlementIds] },
          },
          data: { status: 'present' },
        });
      }

      /**
       * The holder count is the target's, per spec section 11, so the second
       * guard axis has a denominator on a run that has applied nothing yet.
       *
       * Grouped by value rather than written one row at a time: on a first run
       * every count changes at once, and one statement per group is the
       * transaction-budget defect again. The statement count is the number of
       * distinct counts that changed, which on a settled directory is zero.
       */
      const changedByCount = new Map<number, string[]>();
      for (const entitlement of snapshot.entitlements) {
        const holders = holdersAtTarget.get(entitlement.id) ?? 0;
        if (holders === entitlement.holderCount) continue;
        const bucket = changedByCount.get(holders) ?? [];
        bucket.push(entitlement.id);
        changedByCount.set(holders, bucket);
      }
      for (const [holders, ids] of changedByCount) {
        await tx.entitlement.updateMany({
          where: { targetSystemId, id: { in: ids } },
          data: { holderCount: holders },
        });
      }

      const status = verdict.blocked ? 'blocked' : 'previewed';
      const blockedReason = verdict.blocked ? verdict.reasons.join('; ') : null;

      const updated = await tx.provisionRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          requiresConfirmation: verdict.blocked ? verdict.requiresConfirmation : false,
          blockedReason,
          personsEvaluated: snapshot.persons.length,
          personsWithActiveContract,
          personsUnprocessable,
          accountsReadFromTarget: objects.length,
          // Read FROM THE TARGET in phase 4, which is what the column says.
          // `snapshot.entitlements.length` is Syntra's own catalog and would
          // report a number the target never gave.
          entitlementsReadFromTarget: catalog.length,
          createAccountCount: counts('create_account'),
          updateAccountCount: counts('update_account'),
          enableAccountCount: counts('enable_account'),
          disableAccountCount: counts('disable_account'),
          archiveAccountCount: counts('archive_account'),
          renameAccountCount: counts('rename_account'),
          grantEntitlementCount: counts('grant_entitlement'),
          revokeEntitlementCount: counts('revoke_entitlement'),
          deactivateSyntraUserCount: counts('deactivate_syntra_user'),
          reactivateSyntraUserCount: counts('reactivate_syntra_user'),
        },
      });

      await tx.targetSystem.update({
        where: { id: targetSystemId },
        data: { lastRunAt: new Date() },
      });

      await recordEvent(tx, {
        actorUserId: null,
        action: 'provision.run.preview',
        targetType: 'ProvisionRun',
        targetId: run.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          status,
          actions: actions.length,
          exceptions: exceptions.length,
          drift: reconciled.findings.length,
          blockedReason,
        },
      });

      return {
        id: updated.id,
        status: updated.status,
        requiresConfirmation: updated.requiresConfirmation,
        blockedReason: updated.blockedReason,
      };
    });
  } catch (cause) {
    // A run that fails partway writes no plan at all — the actions, the
    // exceptions and the terminal status are all in phase 7's single
    // transaction, which never ran.
    //
    // The failure of this write is swallowed deliberately. It is the last
    // thing standing between the caller and the real error, and a database
    // that has just gone away would otherwise replace "domain controller
    // unreachable" with a connection error about the bookkeeping — losing the
    // only piece of information anybody needed. The run stays `running` and
    // the next run adopts it.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    ).catch(() => undefined);
    throw cause;
  }
}
