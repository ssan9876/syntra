import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
// `reconcileFindings`, not `upsertFindings`: `detectSodViolations` is
// authoritative for the three SoD kinds and must close the ones that have gone.
// A whole-tenant sweep from here would close every standing finding the
// snapshot build opened minutes earlier.
import { reconcileFindings, type FindingDraft } from './finding-service.js';
import { readableSnapshot, SnapshotNotReadableError } from './readable.js';
import {
  evaluateSodRules,
  sodImpact,
  type FunctionResource,
  type PersonHolding,
  type SodImpactInput,
  type SodRuleFacts,
  type UnevaluableResource,
} from './sod.js';
import type { ResourceKind, Severity } from './types.js';

export async function upsertBusinessFunction(
  tenantId: string,
  actorUserId: string | null,
  input: {
    id?: string;
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
      'a business function must name at least one resource; a function with none can never be held, and a rule over it would silently never fire',
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

    await tx.businessFunctionResource.deleteMany({ where: { functionId: fn.id } });
    await tx.businessFunctionResource.createMany({
      data: input.resources.map((r) => ({ tenantId, functionId: fn.id, ...r })),
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'govern.business_function.upsert',
      targetType: 'BusinessFunction',
      targetId: fn.id,
      outcome: 'success',
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
    id?: string;
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
    throw new Error('a rule may not name the same business function on both sides');
  }
  if (input.rationale.trim().length === 0) {
    throw new Error(
      'a rule needs a rationale saying what the risk actually is; a rule nobody can explain is a rule nobody will defend when it fires',
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
      action: 'govern.sod_rule.upsert',
      targetType: 'SodRule',
      targetId: rule.id,
      outcome: 'success',
      sourceIp: null,
      payload: { name: input.name, severity: input.severity, enabled: input.enabled },
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
export async function loadSodFacts(tx: TenantClient, snapshotId?: string): Promise<SodFacts> {
  const snapshot = await readableSnapshot(tx, snapshotId);

  const functions = await tx.businessFunction.findMany({ include: { resources: true } });
  const rules = await tx.sodRule.findMany();
  const holdings = await tx.holding.findMany({
    where: { snapshotId: snapshot.id, personId: { not: null }, state: 'held' },
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
      kind: { in: ['resource_unreadable', 'source_unread', 'source_stale'] },
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
          .map((a) => (a.detail as Record<string, unknown>)['contractId'])
          .filter((c): c is string => typeof c === 'string'),
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
  const facts = await withTenant(tenantId, (tx) => loadSodFacts(tx, snapshotId));
  const results = evaluateSodRules(facts.rules, facts.holdingsByPerson, facts.unevaluable);

  const seen = new Set<string>();
  const findings: FindingDraft[] = [];
  let open = 0;
  let unevaluable = 0;

  for (const [personId, outcomes] of results) {
    for (const { ruleId, outcome } of outcomes) {
      seen.add(`${ruleId}|${personId}`);
      const rule = facts.rules.find((r) => r.ruleId === ruleId)!;

      await withTenant(tenantId, async (tx) => {
        const existing = await tx.sodViolation.findUnique({
          where: { tenantId_ruleId_personId: { tenantId, ruleId, personId } },
        });
        const data = {
          severity: rule.severity,
          status: outcome.kind === 'unevaluable' ? 'unevaluable' : 'open',
          holdingsA: (outcome.kind === 'violation' ? outcome.holdingsA : []) as never,
          holdingsB: (outcome.kind === 'violation' ? outcome.holdingsB : []) as never,
          contractsA: (outcome.kind === 'violation' ? outcome.contractsA : []) as never,
          contractsB: (outcome.kind === 'violation' ? outcome.contractsB : []) as never,
          lastSeenAt: now,
          lastSnapshotId: snapshotId,
        };

        if (existing === null) {
          await tx.sodViolation.create({
            data: { tenantId, ruleId, personId, firstSeenAt: now, ...data },
          });
        } else if (existing.status === 'excepted' && outcome.kind === 'violation') {
          // An active exception holds. Reopening it every night would make a
          // deliberate risk acceptance a decision somebody re-makes daily.
          await tx.sodViolation.update({
            where: { id: existing.id },
            data: { lastSeenAt: now, lastSnapshotId: snapshotId },
          });
        } else {
          await tx.sodViolation.update({ where: { id: existing.id }, data });
        }
      });

      if (outcome.kind === 'unevaluable') {
        unevaluable += 1;
        continue;
      }
      // `evaluateSodRules` returns only non-clear outcomes, so this narrows to
      // `violation` — but the type does not say so and the compiler is right
      // to insist rather than let a future change through silently.
      if (outcome.kind !== 'violation') continue;
      open += 1;
      findings.push({
        kind: 'sod_violation',
        severity: rule.severity,
        subjectRefType: 'sod_violation',
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
      where: { status: { in: ['open', 'unevaluable'] } },
      select: { id: true, ruleId: true, personId: true },
    });
    const gone = live.filter((v) => !seen.has(`${v.ruleId}|${v.personId}`)).map((v) => v.id);
    if (gone.length === 0) return 0;
    const result = await tx.sodViolation.updateMany({
      where: { id: { in: gone } },
      data: { status: 'resolved', lastSeenAt: now, lastSnapshotId: snapshotId },
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
    ['sod_violation', 'sod_laundering', 'approval_reciprocity'],
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
    if (a === undefined || b === undefined) throw new Error('both business functions must exist');

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
      ruleId: 'preview',
      name: 'preview',
      functionA: toFn(a),
      functionB: toFn(b),
      severity: input.severity,
      enabled: true,
    };

    const results = evaluateSodRules([candidate], facts.holdingsByPerson, facts.unevaluable);
    const violating = [...results]
      .filter(([, r]) => r[0]?.outcome.kind === 'violation')
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
      unevaluableSubjects: [...results].filter(([, r]) => r[0]?.outcome.kind === 'unevaluable')
        .length,
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
        resources.map((r) => ({ ...r, resourceName: r.resourceId, contractIds: [] })),
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
        rule.functionA.resources.map((r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`),
      );
      const bKeys = new Set(
        rule.functionB.resources.map((r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`),
      );
      const grantedKeys = new Set(
        resources.map((r) => `${r.systemId}|${r.resourceKind}|${r.resourceId}`),
      );
      const otherSide = [...grantedKeys].some((k) => aKeys.has(k)) ? bKeys : aKeys;
      return {
        ruleId: i.ruleId,
        ruleName: i.ruleName,
        severity: i.severity,
        otherSideHoldings: held
          .filter((h) => otherSide.has(`${h.systemId}|${h.resourceKind}|${h.resourceId}`))
          .map((h) => h.resourceName),
      };
    });

  return {
    violations,
    hasCritical: violations.some((v) => v.severity === 'critical'),
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
export async function loadSodFactsIfEvaluable(tx: TenantClient): Promise<SodFacts | null> {
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
    where: { personId: subjectPersonId, status: 'active', endsAt: { gt: now } },
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
  if (facts === null) return { violations: [], hasCritical: false, hasActiveException: false };
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
    grants: readonly { targetSystemId: string | null; resourceType: string; resourceId: string }[];
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
    systemId: grant.targetSystemId ?? 'syntra',
    resourceKind:
      grant.resourceType === 'entitlement'
        ? 'targetEntitlement'
        : grant.resourceType === 'application'
          ? 'application'
          : 'syntraGroup',
    resourceId: grant.resourceId,
  };
}
