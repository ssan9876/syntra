import { withTenant, type TenantClient } from "@syntra/db";
import { recordEvent } from "../audit/audit-service.js";
// `reconcileFindings`, not `upsertFindings`: `detectSodViolations` is
// authoritative for the three SoD kinds and must close the ones that have gone.
// A whole-tenant sweep from here would close every standing finding the
// snapshot build opened minutes earlier.
import {
  reconcileFindings,
  upsertFindings,
  type FindingDraft,
} from "./finding-service.js";
import {
  buildDecisionGraph,
  type DecisionEdge,
  type GraphInput,
} from "./graph.js";
import { governSettings } from "./settings-service.js";
import { readableSnapshot, SnapshotNotReadableError } from "./readable.js";
import {
  evaluateSodRules,
  sodImpact,
  type FunctionResource,
  type PersonHolding,
  type SodImpactInput,
  type SodRuleFacts,
  type UnevaluableResource,
} from "./sod.js";
import type { ResourceKind, Severity } from "./types.js";

export async function upsertBusinessFunction(
  tenantId: string,
  actorUserId: string | null,
  input: {
    id?: string | undefined;
    name: string;
    description: string | null;
    ownerPersonId: string;
    resources: FunctionResource[];
  },
): Promise<{ id: string }> {
  // A function with no resources can never be held, and a rule over it is a
  // rule that silently never fires. Refused at save, and `evaluateSodRule`
  // refuses it again at evaluation — belt and braces, because the schema is the
  // thing a later task might replace.
  if (input.resources.length === 0) {
    throw new Error(
      "a business function must name at least one resource; a function with none can never be held, and a rule over it would silently never fire",
    );
  }

  return withTenant(tenantId, async (tx) => {
    const fn =
      input.id === undefined
        ? await tx.businessFunction.create({
            data: {
              tenantId,
              name: input.name,
              description: input.description,
              ownerPersonId: input.ownerPersonId,
            },
          })
        : await tx.businessFunction.update({
            where: { id: input.id },
            data: {
              name: input.name,
              description: input.description,
              ownerPersonId: input.ownerPersonId,
            },
          });

    await tx.businessFunctionResource.deleteMany({
      where: { functionId: fn.id },
    });
    await tx.businessFunctionResource.createMany({
      data: input.resources.map((r) => ({ tenantId, functionId: fn.id, ...r })),
    });

    await recordEvent(tx, {
      actorUserId,
      action: "govern.business_function.upsert",
      targetType: "BusinessFunction",
      targetId: fn.id,
      outcome: "success",
      sourceIp: null,
      payload: { name: input.name, resourceCount: input.resources.length },
    });
    return { id: fn.id };
  });
}

export async function upsertSodRule(
  tenantId: string,
  actorUserId: string | null,
  input: {
    id?: string | undefined;
    name: string;
    functionAId: string;
    functionBId: string;
    severity: Severity;
    rationale: string;
    exceptionWorkflowId: string | null;
    enabled: boolean;
  },
): Promise<{ id: string }> {
  if (input.functionAId === input.functionBId) {
    throw new Error(
      "a rule may not name the same business function on both sides",
    );
  }
  if (input.rationale.trim().length === 0) {
    throw new Error(
      "a rule needs a rationale saying what the risk actually is; a rule nobody can explain is a rule nobody will defend when it fires",
    );
  }

  const { id, ...fields } = input;
  return withTenant(tenantId, async (tx) => {
    const rule =
      id === undefined
        ? await tx.sodRule.create({ data: { tenantId, ...fields } })
        : await tx.sodRule.update({ where: { id }, data: { ...fields } });
    await recordEvent(tx, {
      actorUserId,
      action: "govern.sod_rule.upsert",
      targetType: "SodRule",
      targetId: rule.id,
      outcome: "success",
      sourceIp: null,
      payload: {
        name: input.name,
        severity: input.severity,
        enabled: input.enabled,
      },
    });
    return { id: rule.id };
  });
}

export interface SodFacts extends SodImpactInput {
  orphanCount: number;
  snapshotId: string;
}

/**
 * Loads everything the pure evaluator needs, from ONE readable snapshot, in one
 * short transaction returning plain data.
 *
 * Per PERSON, not per account: cross-account and cross-system by construction.
 * An unattributed account is therefore NOT SoD-checked, because the check is per
 * person and the account belongs to nobody — which is why every orphan is a
 * hole in the SoD picture as well as a finding in its own right, and why the
 * SoD dashboard carries the orphan count in its header.
 */
export async function loadSodFacts(
  tx: TenantClient,
  snapshotId?: string,
): Promise<SodFacts> {
  const snapshot = await readableSnapshot(tx, snapshotId);

  const functions = await tx.businessFunction.findMany({
    include: { resources: true },
  });
  const rules = await tx.sodRule.findMany();
  const holdings = await tx.holding.findMany({
    where: { snapshotId: snapshot.id, personId: { not: null }, state: "held" },
    select: {
      personId: true,
      systemId: true,
      resourceKind: true,
      resourceId: true,
      resourceName: true,
      attributions: { select: { detail: true, kind: true } },
    },
  });
  const gaps = await tx.coverageGap.findMany({
    where: {
      snapshotId: snapshot.id,
      kind: { in: ["resource_unreadable", "source_unread", "source_stale"] },
    },
    select: { systemId: true, resourceId: true, reason: true },
  });

  const byId = new Map(functions.map((f) => [f.id, f]));
  const toFn = (f: (typeof functions)[number]) => ({
    functionId: f.id,
    name: f.name,
    resources: f.resources.map((r) => ({
      systemId: r.systemId,
      resourceKind: r.resourceKind as ResourceKind,
      resourceId: r.resourceId,
    })),
  });

  const ruleFacts: SodRuleFacts[] = rules.flatMap((rule) => {
    const a = byId.get(rule.functionAId);
    const b = byId.get(rule.functionBId);
    if (a === undefined || b === undefined) return [];
    return [
      {
        ruleId: rule.id,
        name: rule.name,
        functionA: toFn(a),
        functionB: toFn(b),
        severity: rule.severity as Severity,
        enabled: rule.enabled,
      },
    ];
  });

  const holdingsByPerson = new Map<string, PersonHolding[]>();
  for (const h of holdings) {
    if (h.personId === null) continue;
    const contractIds = [
      ...new Set(
        h.attributions
          .map((a) => (a.detail as Record<string, unknown>)["contractId"])
          .filter((c): c is string => typeof c === "string"),
      ),
    ];
    const list = holdingsByPerson.get(h.personId) ?? [];
    list.push({
      systemId: h.systemId,
      resourceKind: h.resourceKind as ResourceKind,
      resourceId: h.resourceId,
      resourceName: h.resourceName,
      contractIds,
    });
    holdingsByPerson.set(h.personId, list);
  }

  // A gap over a whole system makes EVERY resource of that system unevaluable,
  // not only the named ones. A rule whose function names a group in a target
  // nobody has read cannot be evaluated, and calling it clear is the confident
  // wrong answer in the dangerous direction.
  const unevaluable: UnevaluableResource[] = [];
  for (const fn of functions) {
    for (const resource of fn.resources) {
      const gap = gaps.find(
        (g) =>
          g.systemId === resource.systemId &&
          (g.resourceId === null || g.resourceId === resource.resourceId),
      );
      if (gap !== undefined) {
        unevaluable.push({
          systemId: resource.systemId,
          resourceKind: resource.resourceKind as ResourceKind,
          resourceId: resource.resourceId,
          reason: gap.reason,
        });
      }
    }
  }

  return {
    rules: ruleFacts,
    holdingsByPerson,
    wouldGrant: new Map(),
    unevaluable,
    orphanCount: snapshot.unattributedAccountCount,
    snapshotId: snapshot.id,
  };
}

/**
 * A violation that persists across snapshots is UPDATED, never duplicated, so
 * the dashboard count is a count of problems and not a count of snapshots.
 */
export async function detectSodViolations(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{ open: number; unevaluable: number; resolved: number }> {
  const now = options.now ?? new Date();
  const facts = await withTenant(tenantId, (tx) =>
    loadSodFacts(tx, snapshotId),
  );
  const results = evaluateSodRules(
    facts.rules,
    facts.holdingsByPerson,
    facts.unevaluable,
  );

  const seen = new Set<string>();
  const findings: FindingDraft[] = [];
  let open = 0;
  let unevaluable = 0;

  for (const [personId, outcomes] of results) {
    for (const { ruleId, outcome } of outcomes) {
      seen.add(`${ruleId}|${personId}`);
      const rule = facts.rules.find((r) => r.ruleId === ruleId)!;

      await withTenant(tenantId, async (tx) => {
        const data = {
          severity: rule.severity,
          status: outcome.kind === "unevaluable" ? "unevaluable" : "open",
          holdingsA: (outcome.kind === "violation"
            ? outcome.holdingsA
            : []) as never,
          holdingsB: (outcome.kind === "violation"
            ? outcome.holdingsB
            : []) as never,
          contractsA: (outcome.kind === "violation"
            ? outcome.contractsA
            : []) as never,
          contractsB: (outcome.kind === "violation"
            ? outcome.contractsB
            : []) as never,
          lastSeenAt: now,
          lastSnapshotId: snapshotId,
        };

        // AN ACTIVE EXCEPTION HOLDS, and it has to be checked before the write
        // rather than instead of it. Reopening an `excepted` violation every
        // night would make a deliberate risk acceptance a decision somebody
        // re-makes daily; §15 says a lapse is the only thing that reopens one.
        const existing = await tx.sodViolation.findUnique({
          where: { tenantId_ruleId_personId: { tenantId, ruleId, personId } },
          select: { id: true, status: true },
        });
        if (
          existing !== null &&
          existing.status === "excepted" &&
          outcome.kind === "violation"
        ) {
          await tx.sodViolation.update({
            where: { id: existing.id },
            data: { lastSeenAt: now, lastSnapshotId: snapshotId },
          });
          return;
        }

        // UPSERT ON THE NATURAL KEY, which was there all along.
        //
        // `findUnique` then `create` raised P2002 the moment two detection
        // passes overlapped -- an administrator pressing "Build snapshot" while
        // the nightly job runs is all it takes. The job threw,
        // `reconcileFindings` never ran, and the rows for persons earlier in the
        // iteration were already committed, so the tenant was left with half a
        // detection pass and no reconciliation.
        //
        // NOT a singletonKey on the queue instead. Serialising would make a
        // manual snapshot wait behind an hour-long nightly build, and the
        // read-then-create is wrong on its own terms whatever schedules it: the
        // unique index exists and the code was not using it. `Scheduler.enqueue`
        // has no singleton option either, and adding one would touch every
        // subsystem's job registration for a defect that lives here.
        await tx.sodViolation.upsert({
          where: { tenantId_ruleId_personId: { tenantId, ruleId, personId } },
          create: { tenantId, ruleId, personId, firstSeenAt: now, ...data },
          update: data,
        });
      });

      if (outcome.kind === "unevaluable") {
        unevaluable += 1;
        continue;
      }
      // `evaluateSodRules` returns only non-clear outcomes, so this narrows to
      // `violation` — but the type does not say so and the compiler is right
      // to insist rather than let a future change through silently.
      if (outcome.kind !== "violation") continue;
      open += 1;
      findings.push({
        kind: "sod_violation",
        severity: rule.severity,
        subjectRefType: "sod_violation",
        subjectRefId: `${ruleId}:${personId}`,
        detail: {
          ruleName: rule.name,
          personId,
          holdingsA: outcome.holdingsA.map((h) => h.resourceName),
          holdingsB: outcome.holdingsB.map((h) => h.resourceName),
          contractsA: outcome.contractsA,
          contractsB: outcome.contractsB,
          // Every orphan is a hole in this picture as well as a finding in its
          // own right, so the count travels with the finding.
          orphanAccountsNotChecked: facts.orphanCount,
        },
      });
    }
  }

  // Anything not seen this time is resolved WITH the snapshot that showed it
  // gone, never deleted.
  const resolved = await withTenant(tenantId, async (tx) => {
    const live = await tx.sodViolation.findMany({
      where: { status: { in: ["open", "unevaluable"] } },
      select: { id: true, ruleId: true, personId: true },
    });
    const gone = live
      .filter((v) => !seen.has(`${v.ruleId}|${v.personId}`))
      .map((v) => v.id);
    if (gone.length === 0) return 0;
    const result = await tx.sodViolation.updateMany({
      where: { id: { in: gone } },
      data: { status: "resolved", lastSeenAt: now, lastSnapshotId: snapshotId },
    });
    return result.count;
  });

  // THE THREE KINDS THIS FUNCTION OWNS, named inline. A whole-tenant sweep here
  // would close every standing finding the snapshot build opened minutes
  // earlier; a sweep narrowed to these three closes an `sod_violation` whose
  // rule was disabled or whose holdings went away, which is correct and is what
  // the resolution exists for.
  await reconcileFindings(
    tenantId,
    snapshotId,
    ["sod_violation", "sod_laundering", "approval_reciprocity"],
    findings,
    { now },
  );
  return { open, unevaluable, resolved };
}

export async function previewSodRuleImpact(
  tenantId: string,
  input: { functionAId: string; functionBId: string; severity: Severity },
): Promise<{
  violatingPersons: number;
  sample: { personId: string; displayName: string }[];
  unevaluableSubjects: number;
}> {
  return withTenant(tenantId, async (tx) => {
    const facts = await loadSodFacts(tx);
    const functions = await tx.businessFunction.findMany({
      where: { id: { in: [input.functionAId, input.functionBId] } },
      include: { resources: true },
    });
    const a = functions.find((f) => f.id === input.functionAId);
    const b = functions.find((f) => f.id === input.functionBId);
    if (a === undefined || b === undefined)
      throw new Error("both business functions must exist");

    const toFn = (f: (typeof functions)[number]) => ({
      functionId: f.id,
      name: f.name,
      resources: f.resources.map((r) => ({
        systemId: r.systemId,
        resourceKind: r.resourceKind as ResourceKind,
        resourceId: r.resourceId,
      })),
    });
    const candidate: SodRuleFacts = {
      ruleId: "preview",
      name: "preview",
      functionA: toFn(a),
      functionB: toFn(b),
      severity: input.severity,
      enabled: true,
    };

    const results = evaluateSodRules(
      [candidate],
      facts.holdingsByPerson,
      facts.unevaluable,
    );
    const violating = [...results]
      .filter(([, r]) => r[0]?.outcome.kind === "violation")
      .map(([p]) => p);
    const persons = await tx.person.findMany({
      where: { id: { in: violating.slice(0, 25) } },
      select: { id: true, givenName: true, familyName: true },
    });

    return {
      // "This rule is violated by 23 persons today — show me who", BEFORE it is
      // saved rather than after.
      violatingPersons: violating.length,
      sample: persons.map((p) => ({
        personId: p.id,
        displayName: `${p.givenName} ${p.familyName}`.trim(),
      })),
      unevaluableSubjects: [...results].filter(
        ([, r]) => r[0]?.outcome.kind === "unevaluable",
      ).length,
    };
  });
}

export interface SodGrantImpact {
  violations: {
    ruleId: string;
    ruleName: string;
    severity: Severity;
    otherSideHoldings: string[];
  }[];
  hasCritical: boolean;
  hasActiveException: boolean;
}

/**
 * The pure half of `sodImpactForGrant`, over facts already loaded.
 *
 * Split out so the catalog wrapper can load the facts ONCE and evaluate forty
 * products against them, rather than re-reading the tenant's rules and the
 * subject's holdings per product.
 */
export function evaluateGrantImpact(
  facts: SodFacts,
  subjectPersonId: string,
  resources: readonly FunctionResource[],
  exceptedRuleIds: ReadonlySet<string>,
): SodGrantImpact {
  const held = facts.holdingsByPerson.get(subjectPersonId) ?? [];

  const impact = sodImpact({
    rules: facts.rules,
    holdingsByPerson: new Map([[subjectPersonId, held]]),
    wouldGrant: new Map([
      [
        subjectPersonId,
        resources.map((r) => ({
          ...r,
          resourceName: r.resourceId,
          contractIds: [],
        })),
      ],
    ]),
    unevaluable: facts.unevaluable,
  });

  const violations = impact.introduced
    .filter((i) => !exceptedRuleIds.has(i.ruleId))
    .map((i) => {
      const rule = facts.rules.find((r) => r.ruleId === i.ruleId)!;
      // The OTHER side is whichever of the two the subject already holds. The
      // grant puts them on one side; naming the holdings on the other is what
      // makes the warning actionable — "you violate this rule" is not.
      const aKeys = new Set(
        rule.functionA.resources.map(
          (r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`,
        ),
      );
      const bKeys = new Set(
        rule.functionB.resources.map(
          (r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`,
        ),
      );
      const grantedKeys = new Set(
        resources.map((r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`),
      );
      const otherSide = [...grantedKeys].some((k) => aKeys.has(k))
        ? bKeys
        : aKeys;
      return {
        ruleId: i.ruleId,
        ruleName: i.ruleName,
        severity: i.severity,
        otherSideHoldings: held
          .filter((h) =>
            otherSide.has(`${h.systemId}|${h.resourceKind}|${h.resourceId}`),
          )
          .map((h) => h.resourceName),
      };
    });

  return {
    violations,
    hasCritical: violations.some((v) => v.severity === "critical"),
    hasActiveException: exceptedRuleIds.size > 0,
  };
}

/**
 * The facts, or `null` when there is nothing to evaluate against.
 *
 * TWO absences, and both mean "no SoD picture" rather than "clean":
 *
 *  - No enabled rule. The overwhelmingly common case, and the cheap one — one
 *    count, no snapshot read, no holdings read.
 *  - No readable snapshot. SoD is detected over a snapshot; a tenant that has
 *    never built one has nothing to detect against.
 *
 * The callers that USE this are the prevention points — Automate's eligibility
 * check and the catalog warning — and they must degrade to "no warning" rather
 * than throw. A tenant whose Govern has never run would otherwise have every
 * catalog request refused by an exception nobody can act on, which is a far
 * worse failure than an unchecked grant in a tenant that has configured no
 * rules. Detection itself (`detectSodViolations`) takes an explicit snapshot id
 * and still refuses an unreadable one, because there the absence IS the answer.
 *
 * Exported for Provision's two preview surfaces -- the rule editor and the run
 * guard -- which need the same degradation for the same reason: neither may
 * refuse to preview a plan because Govern has never run.
 */
export async function loadSodFactsIfEvaluable(
  tx: TenantClient,
): Promise<SodFacts | null> {
  const ruleCount = await tx.sodRule.count({ where: { enabled: true } });
  if (ruleCount === 0) return null;
  try {
    return await loadSodFacts(tx);
  } catch (cause) {
    if (cause instanceof SnapshotNotReadableError) return null;
    throw cause;
  }
}

async function activeExceptionRuleIds(
  tx: TenantClient,
  subjectPersonId: string,
  now: Date,
): Promise<Set<string>> {
  const exceptions = await tx.sodException.findMany({
    where: { personId: subjectPersonId, status: "active", endsAt: { gt: now } },
    select: { ruleId: true },
  });
  return new Set(exceptions.map((e) => e.ruleId));
}

/**
 * The approval screen's question: would granting this create a violation, of
 * which rule, and against what does the subject already hold the other side?
 *
 * One query, at the one moment when an accountable human is looking at this
 * specific grant with the authority to refuse it.
 */
export async function sodImpactForGrant(
  tx: TenantClient,
  subjectPersonId: string,
  resource: FunctionResource,
  options: { now?: Date } = {},
): Promise<SodGrantImpact> {
  const now = options.now ?? new Date();
  const facts = await loadSodFactsIfEvaluable(tx);
  if (facts === null)
    return { violations: [], hasCritical: false, hasActiveException: false };
  const excepted = await activeExceptionRuleIds(tx, subjectPersonId, now);
  return evaluateGrantImpact(facts, subjectPersonId, [resource], excepted);
}

/**
 * The catalog form of `sodImpactForGrant`: one subject, many products.
 *
 * It loads the subject's holdings and the tenant's rules ONCE and evaluates
 * every product's grants against them, rather than repeating both reads per
 * product. A catalog page showing forty products would otherwise issue eighty
 * queries to render a warning.
 */
export async function sodImpactForProducts(
  tx: TenantClient,
  subjectPersonId: string,
  products: readonly {
    id: string;
    grants: readonly {
      targetSystemId: string | null;
      resourceType: string;
      resourceId: string;
    }[];
  }[],
  options: { now?: Date } = {},
): Promise<Map<string, SodGrantImpact>> {
  const out = new Map<string, SodGrantImpact>();
  if (products.length === 0) return out;

  const now = options.now ?? new Date();
  const facts = await loadSodFactsIfEvaluable(tx);
  if (facts === null) return out;
  const excepted = await activeExceptionRuleIds(tx, subjectPersonId, now);

  for (const product of products) {
    const impact = evaluateGrantImpact(
      facts,
      subjectPersonId,
      product.grants.map(grantResource),
      excepted,
    );
    if (impact.violations.length > 0) out.set(product.id, impact);
  }
  return out;
}

/** Automate's grant shape, in the terms the SoD evaluator works in. */
export function grantResource(grant: {
  targetSystemId: string | null;
  resourceType: string;
  resourceId: string;
}): FunctionResource {
  return {
    systemId: grant.targetSystemId ?? "syntra",
    resourceKind:
      grant.resourceType === "entitlement"
        ? "targetEntitlement"
        : grant.resourceType === "application"
          ? "application"
          : "syntraGroup",
    resourceId: grant.resourceId,
  };
}

/**
 * Section 14. The decision graph Automate's section 9 named as Govern's
 * problem, persisted.
 *
 * Automate closes every path to self-approval it can see and names the tenth
 * honestly: two-stage laundering — the subject decides stage 1 of somebody
 * else's request, who decides stage 2 of theirs. It cannot detect that from
 * inside one request, and it says so; this is the other side of that handoff.
 *
 * `buildDecisionGraph` is PURE and takes plain values. This function is the
 * only thing that reads the tables and the only thing that writes findings, so
 * the pattern logic can be exercised without a database and the database work
 * has nothing to reason about.
 *
 * `upsertFindings`, never `reconcileFindings`: this computes four kinds and a
 * whole-tenant sweep from here would close every other open finding in the
 * tenant — including the `sod_violation` rows `detectSodViolations` opened
 * seconds earlier in the same job.
 */
export async function detectDecisionGraph(
  tenantId: string,
  snapshotId: string,
  options: { now?: Date } = {},
): Promise<{
  reciprocity: number;
  cycles: number;
  laundering: number;
  autoGranted: number;
  unmergeableActors: number;
}> {
  const now = options.now ?? new Date();

  // FIVE SHORT TRANSACTIONS RETURNING PLAIN DATA, not one.
  //
  // This function read every approval decision, every delegated request, every
  // auto-granted request, every unattributed request, every live grant and the
  // FULL SNAPSHOT HOLDINGS inside a single `withTenant`. It runs inside
  // `runSnapshotJob` after earlier stages have committed, so exceeding the 5000
  // ms ceiling retried the whole job and built a second snapshot.
  //
  // `loadSodFacts` still takes a `tx` and still runs in one: Provision calls it
  // from inside its own transactions (`explain.ts`, `run-service.ts`) and
  // changing its shape would reach into a subsystem this plan does not touch.
  // What it costs here is one transaction of reads rather than one transaction
  // of everything.
  const settings = await withTenant(tenantId, (tx) => governSettings(tx));
  const cutoff = new Date(
    now.getTime() - settings.reciprocityWindowDays * 86_400_000,
  );

  // ---- edge 1: somebody decided somebody else's request -----------------
  // `(tenantId, decidedAt)` is indexed for exactly this read. Rejections are
  // excluded: refusing somebody's request is not a favour, and a pair who
  // each rejected the other three times is a disagreement, not a ring.
  const decisions = await withTenant(tenantId, (tx) =>
    tx.approvalDecision.findMany({
      where: { decision: "approve", decidedAt: { gte: cutoff } },
      select: {
        personId: true,
        via: true,
        decidedAt: true,
        step: {
          select: {
            stageSnapshot: true,
            request: { select: { id: true, subjectPersonId: true } },
          },
        },
      },
    }),
  );

  const edges: DecisionEdge[] = decisions.map((row) => ({
    kind: "decided_for",
    fromPersonId: row.personId,
    toPersonId: row.step.request.subjectPersonId,
    requestId: row.step.request.id,
    decidedAt: row.decidedAt,
    via: row.via,
    selector: ((row.step.stageSnapshot as { selector?: string }).selector ??
      null) as string | null,
  }));

  // ---- edge 2: QUALIFICATION ONE, the delegated grant -------------------
  // A graph built only from `ApprovalDecision` cannot see a pair of team
  // leads who each granted the other access to the resource they manage —
  // the same laundering pattern with LESS friction than the two-stage one,
  // since it needs no approvals at all. The row exists; it is an
  // `AccessRequest` with `origin: 'delegated_admin'` that never had a step.
  const delegated = await withTenant(tenantId, (tx) =>
    tx.accessRequest.findMany({
      where: { origin: "delegated_admin", decidedAt: { gte: cutoff } },
      select: {
        id: true,
        subjectPersonId: true,
        requestedByPersonId: true,
        decidedAt: true,
      },
    }),
  );
  for (const row of delegated) {
    edges.push({
      kind: "delegated_grant",
      fromPersonId: row.requestedByPersonId,
      toPersonId: row.subjectPersonId,
      requestId: row.id,
      decidedAt: row.decidedAt ?? now,
      via: "delegated_admin",
      selector: null,
    });
  }

  // ---- edge 3: QUALIFICATION TWO, the auto-granted request --------------
  // A product with an EMPTY stage list is approved on submission. Nobody
  // decided it, so it can neither reciprocate nor complete a cycle — and
  // counting it as a decision would put a person's name on a decision they
  // did not make. It is its own class: access nobody decided is precisely
  // the access a recertification exists to have somebody decide.
  const autoGranted = await withTenant(tenantId, (tx) =>
    tx.accessRequest.findMany({
      where: {
        origin: "catalog",
        status: { in: ["approved", "fulfilled"] },
        decidedAt: { gte: cutoff },
        steps: { none: {} },
      },
      select: { id: true, subjectPersonId: true, decidedAt: true },
    }),
  );
  for (const row of autoGranted) {
    edges.push({
      kind: "auto_granted",
      fromPersonId: null,
      toPersonId: row.subjectPersonId,
      requestId: row.id,
      decidedAt: row.decidedAt ?? now,
      via: "auto",
      selector: null,
    });
  }

  // ---- QUALIFICATION THREE: the actor with no linked person -------------
  // A service account submitting requests on people's behalf is either an
  // integration worth knowing about or a problem worth knowing about, and
  // either way silence is the wrong answer. It is REPORTED, never dropped
  // and never quietly merged onto the subject.
  const unattributedRequests = await withTenant(tenantId, (tx) =>
    tx.accessRequest.findMany({
      where: { requestedByPersonId: null, submittedAt: { gte: cutoff } },
      select: { id: true, requestedByUserId: true },
    }),
  );
  const byUser = new Map<string, string[]>();
  for (const row of unattributedRequests) {
    byUser.set(row.requestedByUserId, [
      ...(byUser.get(row.requestedByUserId) ?? []),
      row.id,
    ]);
  }

  // ---- the SoD rules, and what each request actually granted ------------
  // The laundering pattern is detectable ONLY with the rules in hand, which
  // is why it lands beside them rather than in the inventory.
  const { facts, grants } = await withTenant(tenantId, async (tx) => ({
    facts: await loadSodFacts(tx, snapshotId),
    grants: await tx.accessGrant.findMany({
      where: { requestId: { not: null } },
      select: {
        requestId: true,
        targetSystemId: true,
        resourceType: true,
        resourceId: true,
      },
    }),
  }));
  const grantedResourceByRequest = new Map<string, string>();
  for (const grant of grants) {
    if (grant.requestId === null) continue;
    grantedResourceByRequest.set(
      grant.requestId,
      grantResource(grant).resourceId,
    );
  }

  const input: GraphInput = {
    edges,
    unmergeable: [...byUser].map(([userId, requestIds]) => ({
      userId,
      requestIds,
    })),
    // Disabled rules are excluded: a rule switched off is a rule the
    // organization is not asserting, and `evaluateSodRules` skips it too.
    sodPairs: facts.rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        ruleId: rule.ruleId,
        ruleName: rule.name,
        severity: rule.severity,
        sideAResourceIds: rule.functionA.resources.map(
          (resource) => resource.resourceId,
        ),
        sideBResourceIds: rule.functionB.resources.map(
          (resource) => resource.resourceId,
        ),
      })),
    grantedResourceByRequest,
    minReciprocalDecisions: settings.minReciprocalDecisions,
    reciprocityWindowDays: settings.reciprocityWindowDays,
    now,
  };

  const report = buildDecisionGraph(input);
  const drafts: FindingDraft[] = [];

  /**
   * THE SENTENCE, on every reciprocity and cycle finding.
   *
   * In a team of four, mutual approval is not a ring; it is Tuesday. A finding
   * that reads as an accusation in that case is a finding people learn to
   * dismiss, and a control nobody reads protects nothing. `medium`, and it says
   * in words what it is.
   */
  const CONTEXT =
    "In a small team mutual approval is normal and expected. This is context for a " +
    "human to look at, not an accusation, and nothing has been blocked or removed.";

  for (const pair of report.reciprocity) {
    drafts.push({
      kind: "approval_reciprocity",
      severity: "medium",
      subjectRefType: "person_pair",
      subjectRefId: [pair.a, pair.b].sort().join(":"),
      detail: {
        a: pair.a,
        b: pair.b,
        aToB: pair.aToB,
        bToA: pair.bToA,
        requestIds: pair.requestIds,
        windowDays: input.reciprocityWindowDays,
        minimum: input.minReciprocalDecisions,
        statement: CONTEXT,
      },
    });
  }

  for (const cycle of report.cycles) {
    drafts.push({
      kind: "approval_reciprocity",
      severity: "medium",
      subjectRefType: "person_cycle",
      subjectRefId: [...cycle.path].sort().join(":"),
      detail: {
        path: cycle.path,
        requestIds: cycle.requestIds,
        statement:
          `${CONTEXT} A cycle is reported because a pairwise check cannot see one: ` +
          "A approves for B, B for C, and C for A.",
      },
    });
  }

  for (const found of report.laundering) {
    drafts.push({
      kind: "sod_laundering",
      // The RULE's own severity, and NOT soft-pedalled. This is the pattern
      // that is a finding rather than a signal: two people put each other on
      // opposite sides of a rule the organization wrote down, and the sentence
      // above would be an excuse here rather than context.
      severity: found.severity,
      subjectRefType: "sod_laundering",
      subjectRefId: `${found.ruleId}:${[found.a, found.b].sort().join(":")}`,
      detail: {
        ruleId: found.ruleId,
        ruleName: found.ruleName,
        a: found.a,
        b: found.b,
        requestIds: found.requestIds,
        statement:
          `Each of these two people decided the other onto the opposite side of "${found.ruleName}". ` +
          "Neither request violates the rule on its own, and neither person holds both sides; " +
          "together they put the organization where the rule says it must not be.",
      },
    });
  }

  for (const auto of report.autoGranted) {
    drafts.push({
      kind: "no_human_decision",
      severity: "low",
      subjectRefType: "person",
      subjectRefId: auto.toPersonId,
      detail: {
        requestIds: auto.requestIds,
        statement:
          "This access was granted by a product with no approval stages, so no human decided it. " +
          "That is a configuration choice rather than a fault; it is listed here because access " +
          "nobody decided is precisely the access a recertification exists to have somebody decide.",
      },
    });
  }

  for (const actor of report.unmergeableActors) {
    drafts.push({
      kind: "unmergeable_actor",
      severity: "low",
      subjectRefType: "user",
      subjectRefId: actor.userId,
      detail: {
        requestIds: actor.requestIds,
        statement:
          "This account submitted requests and is not linked to a person, so its requests cannot " +
          "be placed in the decision graph. It is either an integration worth knowing about or a " +
          "problem worth knowing about, and either way silence is the wrong answer.",
      },
    });
  }

  if (drafts.length > 0) await upsertFindings(tenantId, drafts, { now });

  return {
    reciprocity: report.reciprocity.length,
    cycles: report.cycles.length,
    laundering: report.laundering.length,
    autoGranted: report.autoGranted.length,
    unmergeableActors: report.unmergeableActors.length,
  };
}
