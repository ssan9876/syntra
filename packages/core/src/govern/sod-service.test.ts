import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  detectDecisionGraph,
  detectSodViolations,
  previewSodRuleImpact,
  sodImpactForGrant,
  upsertBusinessFunction,
  upsertSodRule,
} from './sod-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');

/**
 * REAL UUIDS, because `ProductGrant.resourceId` and `targetSystemId` are
 * `@db.Uuid` and the eligibility cases write one. `Holding.systemId` and
 * `resourceId` are plain text, so the plan's `'ad'` / `'ent-raise'` worked for
 * the detection half and made every eligibility case a Postgres cast error.
 * One id per thing, used on both sides, is the only version that is true of
 * production.
 */
const SYSTEM_AD = '10000000-0000-0000-0000-0000000000ad';
const SYSTEM_SAAS = '10000000-0000-0000-0000-000000005aa5';
const ENT_RAISE = '20000000-0000-0000-0000-000000000001';
const ENT_APPROVE = '20000000-0000-0000-0000-000000000002';

let tenantId: string;
let snapshotId: string;
let ruleId: string;
let annaId: string;
let bramId: string;
let raiseFnId: string;
let approveFnId: string;
/** An account for the requests the graph reads. `requestedByUserId` is NOT NULL. */
let submitterUserId: string;

/**
 * Anna holds BOTH sides, across two systems and two accounts — the classic real
 * violation. Bram holds one side only, so a detector that fired on everybody
 * fails as loudly as one that fired on nobody.
 */
async function seed(options: { gapOnApprove?: boolean } = {}) {
  return withTenant(tenantId, async (tx) => {
    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const bram = await tx.person.create({
      data: { tenantId, givenName: 'Bram', familyName: 'Visser' },
    });
    const teaching = await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      },
    });
    const research = await tx.contract.create({
      data: { tenantId, personId: anna.id, sequence: 2, startDate: new Date('2021-01-01') },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: bram.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      },
    });

    const snapshot = await tx.accessSnapshot.create({
      data: {
        tenantId,
        kind: 'manual',
        status: 'complete',
        asOf: NOW,
        unattributedAccountCount: 4,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        sourceKind: 'syntraInternal',
        sourceId: 'syntra',
        sourceName: 'Syntra',
        completeness: 'complete',
        staleness: 'fresh',
        freshnessSlaHours: 24,
      },
    });

    const holding = async (
      personId: string,
      systemId: string,
      resourceId: string,
      name: string,
      contractId: string,
    ) => {
      const row = await tx.holding.create({
        data: {
          tenantId,
          snapshotId: snapshot.id,
          subjectKey: `person:${personId}`,
          personId,
          systemKind: 'targetSystem',
          systemId,
          resourceKind: 'targetEntitlement',
          resourceId,
          resourceName: name,
          state: 'held',
          observedAt: NOW,
          observedVia: 'provision',
          firstSeenAt: NOW,
          attributionCount: 1,
        },
      });
      await tx.holdingAttribution.create({
        data: {
          tenantId,
          holdingId: row.id,
          kind: 'business_rule',
          refType: 'BusinessRule',
          refId: 'rule-x',
          detail: { contractId, ruleEnabled: true },
          resolvedAt: NOW,
        },
      });
    };

    await holding(anna.id, SYSTEM_AD, ENT_RAISE, 'AP entry', teaching.id);
    await holding(anna.id, SYSTEM_SAAS, ENT_APPROVE, 'AP approve', research.id);
    await holding(bram.id, SYSTEM_AD, ENT_RAISE, 'AP entry', teaching.id);

    if (options.gapOnApprove === true) {
      await tx.coverageGap.create({
        data: {
          tenantId,
          snapshotId: snapshot.id,
          kind: 'resource_unreadable',
          systemKind: 'targetSystem',
          systemId: SYSTEM_SAAS,
          resourceId: ENT_APPROVE,
          reason: 'AP approve is unreadable at its target',
        },
      });
    }

    return { snapshotId: snapshot.id, annaId: anna.id, bramId: bram.id };
  });
}

async function seedRule() {
  const raise = await upsertBusinessFunction(tenantId, null, {
    name: 'Raise a payment',
    description: null,
    ownerPersonId: annaId,
    resources: [{ systemId: SYSTEM_AD, resourceKind: 'targetEntitlement', resourceId: ENT_RAISE }],
  });
  const approve = await upsertBusinessFunction(tenantId, null, {
    name: 'Approve a payment',
    description: null,
    ownerPersonId: annaId,
    resources: [{ systemId: SYSTEM_SAAS, resourceKind: 'targetEntitlement', resourceId: ENT_APPROVE }],
  });
  const rule = await upsertSodRule(tenantId, null, {
    name: 'Payment raising and approval',
    functionAId: raise.id,
    functionBId: approve.id,
    severity: 'critical',
    rationale: 'the same person must not be able to raise a payment and approve it',
    exceptionWorkflowId: null,
    enabled: true,
  });
  return { raiseId: raise.id, approveId: approve.id, ruleId: rule.id };
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await seed();
  snapshotId = seeded.snapshotId;
  annaId = seeded.annaId;
  bramId = seeded.bramId;
  const rule = await seedRule();
  ruleId = rule.ruleId;
  raiseFnId = rule.raiseId;
  approveFnId = rule.approveId;
  submitterUserId = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@a.test',
        displayName: 'Anna Novak',
        personId: annaId,
      },
    });
    return user.id;
  });
});

describe('detection', () => {
  it('persists ONE violation with the holdings and the contracts on each side', async () => {
    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ open: 1, unevaluable: 0 });

    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      personId: annaId,
      ruleId,
      status: 'open',
      severity: 'critical',
    });
    // "You violate this rule" is not actionable; "these holdings put you on the
    // A side" is.
    expect((violations[0]!.holdingsA as { resourceName: string }[])[0]!.resourceName).toBe(
      'AP entry',
    );
    expect((violations[0]!.holdingsB as { resourceName: string }[])[0]!.resourceName).toBe(
      'AP approve',
    );
    // The concurrent-contract case: an exception whose basis is "these are two
    // separate engagements" is reviewable only because these are recorded.
    expect(violations[0]!.contractsA as string[]).toHaveLength(1);
    expect(violations[0]!.contractsB as string[]).toHaveLength(1);
    expect(violations[0]!.contractsA).not.toEqual(violations[0]!.contractsB);
  });

  it('does not raise a violation for somebody holding one side only', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations.map((v) => v.personId)).not.toContain(bramId);
  });

  it('UPDATES a persisting violation rather than duplicating it across snapshots', async () => {
    // The dashboard count is a count of problems, not a count of snapshots.
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const later = new Date(NOW.getTime() + 86_400_000);
    await detectSodViolations(tenantId, snapshotId, { now: later });

    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.firstSeenAt).toEqual(NOW);
    expect(violations[0]!.lastSeenAt).toEqual(later);
  });

  it('marks a rule UNEVALUABLE when a function’s resource sits behind a coverage gap', async () => {
    // A row with status `unevaluable`, NOT an absent row, so the screen can say
    // "we could not check this" rather than showing a clean board. Quietly
    // evaluating without it produces a confident wrong answer in the dangerous
    // direction.
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await seed({ gapOnApprove: true });
    snapshotId = seeded.snapshotId;
    annaId = seeded.annaId;
    ruleId = (await seedRule()).ruleId;

    // TWO, not one: the count is per (rule, person) — the key `SodViolation`
    // itself uses — and both Anna and Bram hold the readable side, so for both
    // of them the answer turns on the part that could not be read. A person
    // holding neither side is still `clear`, which is what keeps one unread
    // target from putting the whole tenant on the board.
    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ open: 0, unevaluable: 2 });
    const violations = await withTenant(tenantId, (tx) => tx.sodViolation.findMany());
    expect(violations.map((v) => v.status)).toEqual(['unevaluable', 'unevaluable']);
  });

  it('marks a rule unevaluable for a gap over the WHOLE SYSTEM, not only the named resource', async () => {
    // A gap with a null resourceId is "this source could not be read at all".
    // Matching only on an exact resource id would call every rule over that
    // system clear.
    await withTenant(tenantId, (tx) =>
      tx.coverageGap.create({
        data: {
          tenantId,
          snapshotId,
          kind: 'source_unread',
          systemKind: 'targetSystem',
          systemId: SYSTEM_SAAS,
          resourceId: null,
          reason: 'the SaaS target has never been read',
        },
      }),
    );
    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ open: 0, unevaluable: 2 });
  });

  it('leaves an EXCEPTED violation excepted rather than reopening it nightly', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.sodViolation.updateMany({ where: { personId: annaId }, data: { status: 'excepted' } }),
    );
    await detectSodViolations(tenantId, snapshotId, { now: new Date(NOW.getTime() + 86_400_000) });
    const violation = await withTenant(tenantId, (tx) => tx.sodViolation.findFirstOrThrow());
    expect(violation.status).toBe('excepted');
  });

  it('RESOLVES a violation that stopped being observed, naming the snapshot', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.holding.deleteMany({ where: { snapshotId, resourceId: ENT_APPROVE } }),
    );
    const result = await detectSodViolations(tenantId, snapshotId, { now: NOW });
    expect(result.resolved).toBe(1);
    const violation = await withTenant(tenantId, (tx) => tx.sodViolation.findFirstOrThrow());
    expect(violation).toMatchObject({ status: 'resolved', lastSnapshotId: snapshotId });
  });

  it('carries the orphan count on the finding, because orphans are NOT SoD-checked', async () => {
    // The check is per person and an unattributed account belongs to nobody, so
    // every orphan is a hole in the SoD picture as well as a finding in its own
    // right. The SoD dashboard carries the count in its header for that reason.
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_violation' } }),
    );
    expect((finding.detail as { orphanAccountsNotChecked?: number }).orphanAccountsNotChecked).toBe(
      4,
    );
  });
});

describe('save-time validation', () => {
  it('refuses a business function with NO resources', async () => {
    await expect(
      upsertBusinessFunction(tenantId, null, {
        name: 'Empty',
        description: null,
        ownerPersonId: annaId,
        resources: [],
      }),
    ).rejects.toThrow(/at least one resource/i);
  });

  it('refuses a rule whose rationale is blank', async () => {
    // The empty string is the universal justification.
    await expect(
      upsertSodRule(tenantId, null, {
        name: 'Blank',
        functionAId: raiseFnId,
        functionBId: approveFnId,
        severity: 'high',
        rationale: '   ',
        exceptionWorkflowId: null,
        enabled: true,
      }),
    ).rejects.toThrow(/rationale/i);
  });

  it('refuses a rule naming the same function on both sides', async () => {
    await expect(
      upsertSodRule(tenantId, null, {
        name: 'Self',
        functionAId: raiseFnId,
        functionBId: raiseFnId,
        severity: 'high',
        rationale: 'x',
        exceptionWorkflowId: null,
        enabled: true,
      }),
    ).rejects.toThrow(/same business function/i);
  });
});

describe('previewSodRuleImpact — before it is saved, not after', () => {
  it('names who violates the candidate rule today', async () => {
    const preview = await previewSodRuleImpact(tenantId, {
      functionAId: raiseFnId,
      functionBId: approveFnId,
      severity: 'critical',
    });
    expect(preview.violatingPersons).toBe(1);
    expect(preview.sample[0]).toMatchObject({ personId: annaId, displayName: 'Anna Novak' });
  });
});

describe('sodImpactForGrant — the approval screen’s question', () => {
  it('names the rule and the EXISTING holdings on the other side', async () => {
    const impact = await withTenant(tenantId, (tx) =>
      sodImpactForGrant(
        tx,
        bramId,
        { systemId: SYSTEM_SAAS, resourceKind: 'targetEntitlement', resourceId: ENT_APPROVE },
        { now: NOW },
      ),
    );
    expect(impact.hasCritical).toBe(true);
    expect(impact.violations[0]).toMatchObject({ ruleName: 'Payment raising and approval' });
    expect(impact.violations[0]!.otherSideHoldings).toEqual(['AP entry']);
  });

  it('reports NOTHING for a grant that creates no violation', async () => {
    const impact = await withTenant(tenantId, (tx) =>
      sodImpactForGrant(
        tx,
        bramId,
        { systemId: SYSTEM_AD, resourceKind: 'targetEntitlement', resourceId: ENT_RAISE },
        { now: NOW },
      ),
    );
    expect(impact.violations).toEqual([]);
    expect(impact.hasCritical).toBe(false);
  });

  it('does not report a rule an ACTIVE exception already covers', async () => {
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    await withTenant(tenantId, async (tx) => {
      const violation = await tx.sodViolation.findFirstOrThrow();
      await tx.sodException.create({
        data: {
          tenantId,
          ruleId,
          personId: bramId,
          violationId: violation.id,
          justification: 'two separate engagements',
          compensatingControl: 'monthly review',
          startsAt: NOW,
          endsAt: new Date(NOW.getTime() + 30 * 86_400_000),
          status: 'active',
        },
      });
    });
    const impact = await withTenant(tenantId, (tx) =>
      sodImpactForGrant(
        tx,
        bramId,
        { systemId: SYSTEM_SAAS, resourceKind: 'targetEntitlement', resourceId: ENT_APPROVE },
        { now: NOW },
      ),
    );
    expect(impact.violations).toEqual([]);
  });

  it('reports NOTHING, rather than throwing, in a tenant with no snapshot', async () => {
    // The prevention points must degrade to "no warning" when Govern has never
    // run. A tenant whose eligibility check threw here would have every catalog
    // request refused by an exception nobody can act on — a far worse failure
    // than an unchecked grant in a tenant that has configured no rules.
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Fresh', slug: 'fresh' } });
    const impact = await withTenant(t.id, (tx) =>
      sodImpactForGrant(
        tx,
        '00000000-0000-0000-0000-000000000001',
        { systemId: SYSTEM_AD, resourceKind: 'targetEntitlement', resourceId: ENT_RAISE },
        { now: NOW },
      ),
    );
    expect(impact).toEqual({ violations: [], hasCritical: false, hasActiveException: false });
  });
});

describe('Automate’s eligibility re-check', () => {
  const seedProduct = async () =>
    withTenant(tenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({ data: { tenantId, name: 'wf' } });
      const product = await tx.product.create({
        data: {
          tenantId,
          name: 'AP approve',
          slug: 'ap-approve',
          kind: 'targetEntitlement',
          workflowId: workflow.id,
          status: 'active',
          audienceCondition: { all: [] },
        },
      });
      await tx.productGrant.create({
        data: {
          tenantId,
          productId: product.id,
          resourceType: 'entitlement',
          resourceId: ENT_APPROVE,
          targetSystemId: SYSTEM_SAAS,
        },
      });
      return product.id;
    });

  it('refuses a CRITICAL grant with reason sod_violation', async () => {
    const { checkEligibility } = await import('../automate/eligibility.js');
    const productId = await seedProduct();

    const outcome = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, productId, bramId, NOW),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'sod_violation' });
    expect((outcome as { message: string }).message).toContain('Payment raising and approval');
  });

  it('does NOT refuse a HIGH-severity grant, so nobody is frozen for somebody else’s rule', async () => {
    // Only `critical` refuses. Below that the approver is told and approving
    // records an acknowledgement that becomes a pending exception request.
    // Blocking here would be the unprocessable-person trap, inverted, produced
    // by a governance control.
    const { checkEligibility } = await import('../automate/eligibility.js');
    await withTenant(tenantId, (tx) =>
      tx.sodRule.update({ where: { id: ruleId }, data: { severity: 'high' } }),
    );
    const productId = await seedProduct();

    const outcome = await withTenant(tenantId, (tx) =>
      checkEligibility(tx, productId, bramId, NOW),
    );
    expect(outcome.ok).toBe(true);
  });
});

/**
 * §14's persistence half.
 *
 * `graph.test.ts` covers the patterns over plain values. This covers the part
 * that reads the tables and writes the findings — the half that, missing,
 * leaves `buildDecisionGraph` a correct pure function nothing in the product
 * ever calls.
 */
describe('detectDecisionGraph', () => {
  /** One approved decision by `decider` on a request whose subject is `subject`. */
  async function approval(
    decider: string,
    subject: string,
    options: { grantedResourceId?: string; decidedAt?: Date } = {},
  ): Promise<string> {
    return withTenant(tenantId, async (tx) => {
      const decidedAt = options.decidedAt ?? NOW;
      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          subjectPersonId: subject,
          requestedByUserId: submitterUserId,
          requestedByPersonId: subject,
          origin: 'catalog',
          status: 'approved',
          submittedAt: decidedAt,
          decidedAt,
        },
      });
      const step = await tx.approvalStep.create({
        data: {
          tenantId,
          requestId: request.id,
          sequence: 1,
          stageSnapshot: { selector: 'manager' },
          status: 'approved',
          closedAt: decidedAt,
        },
      });
      await tx.approvalDecision.create({
        data: {
          tenantId,
          stepId: step.id,
          personId: decider,
          decision: 'approve',
          via: 'selector',
          decidedAt,
        },
      });
      if (options.grantedResourceId !== undefined) {
        await tx.accessGrant.create({
          data: {
            tenantId,
            subjectPersonId: subject,
            requestId: request.id,
            resourceType: 'entitlement',
            resourceId: options.grantedResourceId,
            targetSystemId: SYSTEM_AD,
            origin: 'request',
            startsAt: decidedAt,
            status: 'active',
          },
        });
      }
      return request.id;
    });
  }

  it('reads reciprocity out of ApprovalDecision and says it is not an accusation', async () => {
    for (let i = 0; i < 3; i += 1) {
      await approval(annaId, bramId);
      await approval(bramId, annaId);
    }
    const result = await detectDecisionGraph(tenantId, snapshotId, { now: NOW });
    expect(result.reciprocity).toBe(1);

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({
        where: { kind: 'approval_reciprocity', subjectRefType: 'person_pair' },
      }),
    );
    // ONE finding, not one per axis: the cycle detector must not report the
    // same pair a second time.
    expect(
      await withTenant(tenantId, (tx) =>
        tx.governFinding.count({ where: { kind: 'approval_reciprocity' } }),
      ),
    ).toBe(1);
    expect(finding.severity).toBe('medium');
    expect(finding.subjectRefId).toBe([annaId, bramId].sort().join(':'));
    // THE SENTENCE. In a team of four, mutual approval is not a ring; it is
    // Tuesday, and a finding that reads as an accusation there is a finding
    // people learn to dismiss.
    const detail = finding.detail as { statement?: string; aToB?: number };
    expect(detail.statement).toContain('normal and expected');
    expect(detail.statement).toContain('not an accusation');
    expect(detail.aToB).toBe(3);
  });

  it('EXCLUDES rejections — a pair who refused each other is a disagreement', async () => {
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        for (const [decider, subject] of [
          [annaId, bramId],
          [bramId, annaId],
        ] as const) {
          const request = await tx.accessRequest.create({
            data: {
              tenantId,
              subjectPersonId: subject,
              requestedByUserId: submitterUserId,
              requestedByPersonId: subject,
              origin: 'catalog',
              status: 'rejected',
              submittedAt: NOW,
              decidedAt: NOW,
            },
          });
          const step = await tx.approvalStep.create({
            data: {
              tenantId,
              requestId: request.id,
              sequence: 1,
              stageSnapshot: { selector: 'manager' },
              status: 'rejected',
            },
          });
          await tx.approvalDecision.create({
            data: {
              tenantId,
              stepId: step.id,
              personId: decider,
              decision: 'reject',
              comment: 'no',
              via: 'selector',
              decidedAt: NOW,
            },
          });
        }
      }
    });
    expect((await detectDecisionGraph(tenantId, snapshotId, { now: NOW })).reciprocity).toBe(0);
  });

  it('QUALIFICATION ONE: a delegated grant is an edge with no ApprovalDecision behind it', async () => {
    // A graph built only from `ApprovalDecision` cannot see a pair of team
    // leads who each granted the other access to the resource they manage.
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        for (const [granter, subject] of [
          [annaId, bramId],
          [bramId, annaId],
        ] as const) {
          await tx.accessRequest.create({
            data: {
              tenantId,
              subjectPersonId: subject,
              requestedByUserId: submitterUserId,
              requestedByPersonId: granter,
              origin: 'delegated_admin',
              resourceType: 'entitlement',
              resourceId: ENT_RAISE,
              status: 'approved',
              submittedAt: NOW,
              decidedAt: NOW,
            },
          });
        }
      }
    });
    expect((await detectDecisionGraph(tenantId, snapshotId, { now: NOW })).reciprocity).toBe(1);
  });

  it('QUALIFICATION TWO: an auto-granted request is its own class, with nobody named', async () => {
    await withTenant(tenantId, (tx) =>
      tx.accessRequest.create({
        data: {
          tenantId,
          subjectPersonId: bramId,
          requestedByUserId: submitterUserId,
          requestedByPersonId: bramId,
          origin: 'catalog',
          status: 'approved',
          submittedAt: NOW,
          decidedAt: NOW,
        },
      }),
    );
    const result = await detectDecisionGraph(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ autoGranted: 1, reciprocity: 0, cycles: 0 });

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'no_human_decision' } }),
    );
    expect(finding.subjectRefId).toBe(bramId);
    expect((finding.detail as { statement?: string }).statement).toContain('no human decided it');
  });

  it('QUALIFICATION THREE: an actor with no linked person is REPORTED, never dropped', async () => {
    await withTenant(tenantId, async (tx) => {
      const service = await tx.user.create({
        data: { tenantId, login: 'svc', email: 'svc@a.test', displayName: 'Integration' },
      });
      await tx.accessRequest.create({
        data: {
          tenantId,
          subjectPersonId: bramId,
          requestedByUserId: service.id,
          requestedByPersonId: null,
          origin: 'catalog',
          status: 'pending_approval',
          submittedAt: NOW,
        },
      });
    });
    const result = await detectDecisionGraph(tenantId, snapshotId, { now: NOW });
    expect(result.unmergeableActors).toBe(1);
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'unmergeable_actor' } }),
    );
    expect((finding.detail as { statement?: string }).statement).toContain('silence is the wrong');
  });

  it('raises SoD laundering at the RULE’s own severity, and does not soft-pedal it', async () => {
    // Neither request violates the rule on its own and neither person holds
    // both sides. Together they put the organization where the rule says it
    // must not be — and that is a finding rather than a signal.
    await approval(annaId, bramId, { grantedResourceId: ENT_RAISE });
    await approval(bramId, annaId, { grantedResourceId: ENT_APPROVE });

    const result = await detectDecisionGraph(tenantId, snapshotId, { now: NOW });
    expect(result.laundering).toBe(1);

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'sod_laundering' } }),
    );
    expect(finding.severity).toBe('critical');
    const detail = finding.detail as { statement?: string; ruleName?: string };
    expect(detail.ruleName).toBe('Payment raising and approval');
    expect(detail.statement).toContain('opposite side');
    // The reciprocity sentence would be an excuse here, not context.
    expect(detail.statement).not.toContain('normal and expected');
  });

  it('raises nothing for a DISABLED rule', async () => {
    await withTenant(tenantId, (tx) =>
      tx.sodRule.update({ where: { id: ruleId }, data: { enabled: false } }),
    );
    await approval(annaId, bramId, { grantedResourceId: ENT_RAISE });
    await approval(bramId, annaId, { grantedResourceId: ENT_APPROVE });
    expect((await detectDecisionGraph(tenantId, snapshotId, { now: NOW })).laundering).toBe(0);
  });

  it('does NOT close the sod_violation findings the same job just opened', async () => {
    // `upsertFindings`, never `reconcileFindings`. This computes four kinds,
    // and a whole-tenant sweep from here would close every other open finding
    // in the tenant — including the ones `detectSodViolations` wrote seconds
    // earlier in the same snapshot job.
    await detectSodViolations(tenantId, snapshotId, { now: NOW });
    const before = await withTenant(tenantId, (tx) =>
      tx.governFinding.count({ where: { kind: 'sod_violation', status: 'open' } }),
    );
    expect(before).toBe(1);

    await approval(annaId, bramId);
    await detectDecisionGraph(tenantId, snapshotId, { now: NOW });

    expect(
      await withTenant(tenantId, (tx) =>
        tx.governFinding.count({ where: { kind: 'sod_violation', status: 'open' } }),
      ),
    ).toBe(1);
  });

  it('reports nothing at all over an empty tenant', async () => {
    expect(await detectDecisionGraph(tenantId, snapshotId, { now: NOW })).toEqual({
      reciprocity: 0,
      cycles: 0,
      laundering: 0,
      autoGranted: 0,
      unmergeableActors: 0,
    });
    expect(await withTenant(tenantId, (tx) => tx.governFinding.count())).toBe(0);
  });
});
