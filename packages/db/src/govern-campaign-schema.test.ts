import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from './index.js';
import { resetDatabase } from './test-support.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'Owner' },
    });
    return { snapshotId: snapshot.id, personId: person.id };
  });
  snapshotId = seeded.snapshotId;
  personId = seeded.personId;
});

const campaignData = (over: Record<string, unknown> = {}) => ({
  tenantId,
  name: 'Q2 finance review',
  scope: { resourceKinds: ['targetEntitlement'] },
  snapshotId,
  reviewerSelector: 'manager',
  reviewerConfig: {},
  fallbackSelector: 'resourceOwner',
  fallbackConfig: {},
  ownerPersonId: personId,
  opensAt: NOW,
  dueAt: new Date('2026-07-15T00:00:00Z'),
  originalDueAt: new Date('2026-07-15T00:00:00Z'),
  ...over,
});

const itemData = (campaignId: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  campaignId,
  holdingSnapshotId: snapshotId,
  subjectKey: `person:${personId}`,
  personId,
  systemId: 'sys-1',
  resourceKind: 'syntraGroup',
  resourceId: 'g',
  resourceName: 'g',
  attributions: [],
  observedAt: NOW,
  coverageStatus: 'complete',
  ...over,
});

describe('Campaign', () => {
  it('carries originalDueAt and extensionCount rather than deriving them', async () => {
    // "The campaign ran for six weeks" and "the campaign was extended three
    // times because nobody responded" are different facts about the same
    // organization, and only one of them is derivable from dueAt alone.
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.create({ data: campaignData() }),
    );
    expect(campaign.extensionCount).toBe(0);
    expect(campaign.originalDueAt).toEqual(campaign.dueAt);
    expect(campaign.status).toBe('draft');
  });

  it('refuses a fallback selector that is null', async () => {
    // The fallback is REQUIRED. A campaign whose selector resolves to nobody
    // and has no fallback is a campaign whose items block on the due date.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.campaign.create({ data: campaignData({ fallbackSelector: null }) as never }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a due date moved BACKWARDS past the original', async () => {
    // Moving the due date is an act; rewriting how long reviewers actually had
    // is a different one.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.campaign.create({
          data: campaignData({ dueAt: new Date('2026-07-01T00:00:00Z') }),
        }),
      ),
    ).rejects.toThrow(/campaign_due_not_before_original/);
  });
});

describe('CampaignItem', () => {
  it('carries the copied attributions and the risk flags', async () => {
    const item = await withTenant(tenantId, async (tx) => {
      const campaign = await tx.campaign.create({ data: campaignData() });
      return tx.campaignItem.create({
        data: itemData(campaign.id, {
          resourceKind: 'targetEntitlement',
          resourceId: 'ent-1',
          resourceName: 'Finance-Payments',
          attributions: [{ kind: 'business_rule', detail: { ruleName: 'Finance staff' } }],
          riskFlags: ['privileged', 'needs_review'],
        }),
      });
    });
    expect(item.status).toBe('pending');
    expect(item.riskFlags).toEqual(['privileged', 'needs_review']);
  });

  it('refuses a status outside the closed set', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const campaign = await tx.campaign.create({ data: campaignData() });
        return tx.campaignItem.create({
          // There is no status that means "certified because time ran out".
          data: itemData(campaign.id, { status: 'certified_by_timeout' }),
        });
      }),
    ).rejects.toThrow(/campaign_item_status/);
  });

  it('refuses a subjectKey that disagrees with the subject columns', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const campaign = await tx.campaign.create({ data: campaignData() });
        return tx.campaignItem.create({
          data: itemData(campaign.id, { subjectKey: 'person:00000000-0000-0000-0000-000000000000' }),
        });
      }),
    ).rejects.toThrow(/campaign_item_subject_key_agrees/);
  });
});

describe('CampaignDecision', () => {
  const seedDecision = async (over: Record<string, unknown> = {}) =>
    withTenant(tenantId, async (tx) => {
      const campaign = await tx.campaign.create({ data: campaignData() });
      const item = await tx.campaignItem.create({ data: itemData(campaign.id) });
      return tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId,
          decision: 'certify',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
          ...over,
        },
      });
    });

  it('is append-only: an UPDATE changes nothing and a DELETE removes nothing', async () => {
    const decision = await seedDecision();

    await withTenant(tenantId, (tx) =>
      tx.campaignDecision.updateMany({ where: { id: decision.id }, data: { decision: 'revoke' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaignDecision.deleteMany({ where: { id: decision.id } }),
    );

    const rows = await withTenant(tenantId, (tx) => tx.campaignDecision.findMany());
    expect(rows).toHaveLength(1);
    // A reversal is a NEW decision with its own reason, never an edit.
    expect(rows[0]!.decision).toBe('certify');
  });

  it('carries decidedByUserId, so a dispatch can name the account the decision came from', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'CampaignDecision'
    `;
    expect(columns.map((c) => c.column_name)).toContain('decidedByUserId');
  });

  it('REFUSES a revoke with no comment', async () => {
    // Revoking is one at a time, with a reason. This is the check the mutation
    // pass drops, so the case exists to catch that.
    await expect(seedDecision({ decision: 'revoke' })).rejects.toThrow(
      /campaign_decision_revoke_needs_comment/,
    );
  });

  it('REFUSES a bulk revoke, whatever the comment says', async () => {
    await expect(
      seedDecision({ decision: 'revoke', comment: 'no longer needed', viaBulk: true, bulkSize: 20 }),
    ).rejects.toThrow(/campaign_decision_revoke_is_not_bulk/);
  });

  it('REFUSES a bulk decision with no size, because it could not be reported', async () => {
    await expect(seedDecision({ viaBulk: true })).rejects.toThrow(
      /campaign_decision_bulk_has_size/,
    );
  });
});

describe('RevocationBatch', () => {
  it('permits one non-terminal batch per campaign', async () => {
    const campaignId = await withTenant(
      tenantId,
      async (tx) => (await tx.campaign.create({ data: campaignData() })).id,
    );

    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'previewed' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'computing' } }),
      ),
    ).rejects.toThrow();
  });

  it('has NO standalone batch: campaignId is NOT NULL', () => {
    // The schema once shipped a second partial index for batches with a NULL
    // campaignId and no production path ever created one — a control guarding a
    // population nothing produces. The remedy for a refused or lapsed exception
    // is a RemediationItem and nothing is revoked, so there was never a
    // standalone batch to guard.
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const model = schema.slice(
      schema.indexOf('model RevocationBatch {'),
      schema.indexOf('model RevocationDispatch {'),
    );
    expect(model).toMatch(/campaignId\s+String\s+@db\.Uuid/);
    expect(model).not.toMatch(/campaignId\s+String\?/);

    const migration = readFileSync(
      new URL('../prisma/migrations/20260825000000_govern_campaigns/migration.sql', import.meta.url),
      'utf8',
    );
    expect(migration).not.toContain('govern_revocation_batch_one_non_terminal_standalone');
  });

  it('admits a new batch once the previous one is terminal', async () => {
    const campaignId = await withTenant(
      tenantId,
      async (tx) => (await tx.campaign.create({ data: campaignData() })).id,
    );
    const first = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'previewed' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.update({ where: { id: first.id }, data: { status: 'applied' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'computing' } }),
    );
  });
});

describe('RevocationDispatch', () => {
  it('REFUSES an `applied` dispatch that was never confirmed', async () => {
    // The vocabulary rule, in SQL: `applied` means confirmed AND then observed.
    // A dispatch that reached `applied` with no confirmation behind it would be
    // a report claiming an outcome it never had.
    await expect(
      withTenant(tenantId, async (tx) => {
        const campaign = await tx.campaign.create({ data: campaignData() });
        const batch = await tx.revocationBatch.create({
          data: { tenantId, campaignId: campaign.id, status: 'applying' },
        });
        return tx.revocationDispatch.create({
          data: {
            tenantId,
            batchId: batch.id,
            holdingDescriptor: {},
            route: 'automate_grant',
            status: 'applied',
            appliedAt: NOW,
          },
        });
      }),
    ).rejects.toThrow(/revocation_dispatch_applied_was_confirmed/);
  });

  it('REFUSES a `requires_change` dispatch with no remediation item to work', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const campaign = await tx.campaign.create({ data: campaignData() });
        const batch = await tx.revocationBatch.create({
          data: { tenantId, campaignId: campaign.id, status: 'applying' },
        });
        return tx.revocationDispatch.create({
          data: {
            tenantId,
            batchId: batch.id,
            holdingDescriptor: {},
            route: 'requires_change',
            status: 'requires_change',
          },
        });
      }),
    ).rejects.toThrow(/revocation_dispatch_requires_change_has_item/);
  });
});

describe('RevocationOrder', () => {
  const base = () => ({
    tenantId,
    targetSystemId: '11111111-1111-1111-1111-111111111111',
    accountId: '22222222-2222-2222-2222-222222222222',
    entitlementId: '33333333-3333-3333-3333-333333333333',
    decidedByPersonId: personId,
    decidedByPersonName: 'Jan Owner',
    reason: 'reviewed and revoked in Q2 finance review',
  });

  it('permits one OPEN order per holding and admits a second once the first is terminal', async () => {
    const first = await withTenant(tenantId, (tx) => tx.revocationOrder.create({ data: base() }));
    await expect(
      withTenant(tenantId, (tx) => tx.revocationOrder.create({ data: base() })),
    ).rejects.toThrow();

    // One-shot: once applied it is terminal and does not persist as a term that
    // suppresses future grants.
    await withTenant(tenantId, (tx) =>
      tx.revocationOrder.update({ where: { id: first.id }, data: { status: 'applied' } }),
    );
    await withTenant(tenantId, (tx) => tx.revocationOrder.create({ data: base() }));
  });

  it('REFUSES an order that names no human', async () => {
    // An order with no named human is indistinguishable from the inference the
    // remit rule forbids.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.revocationOrder.create({ data: { ...base(), decidedByPersonName: '   ' } }),
      ),
    ).rejects.toThrow(/revocation_order_names_a_human/);
  });
});

describe('SodRule and SodViolation', () => {
  it('refuses a rule naming the same function twice', async () => {
    await expect(
      withTenant(tenantId, async (tx) => {
        const fn = await tx.businessFunction.create({
          data: { tenantId, name: 'Raise a payment', ownerPersonId: personId },
        });
        return tx.sodRule.create({
          data: {
            tenantId,
            name: 'Self',
            functionAId: fn.id,
            functionBId: fn.id,
            severity: 'high',
            rationale: 'x',
          },
        });
      }),
    ).rejects.toThrow(/sod_rule_functions_differ/);
  });

  it('refuses a rule with a blank rationale', async () => {
    // A rule nobody can explain is a rule nobody will defend when it fires.
    await expect(
      withTenant(tenantId, async (tx) => {
        const a = await tx.businessFunction.create({
          data: { tenantId, name: 'A', ownerPersonId: personId },
        });
        const b = await tx.businessFunction.create({
          data: { tenantId, name: 'B', ownerPersonId: personId },
        });
        return tx.sodRule.create({
          data: {
            tenantId,
            name: 'A/B',
            functionAId: a.id,
            functionBId: b.id,
            severity: 'high',
            rationale: '  ',
          },
        });
      }),
    ).rejects.toThrow(/sod_rule_rationale_not_blank/);
  });

  it('is unique per (rule, person), so a violation is updated across snapshots', async () => {
    const ruleId = await withTenant(tenantId, async (tx) => {
      const a = await tx.businessFunction.create({
        data: { tenantId, name: 'A', ownerPersonId: personId },
      });
      const b = await tx.businessFunction.create({
        data: { tenantId, name: 'B', ownerPersonId: personId },
      });
      const rule = await tx.sodRule.create({
        data: {
          tenantId,
          name: 'A/B',
          functionAId: a.id,
          functionBId: b.id,
          severity: 'critical',
          rationale: 'raising and approving a payment',
        },
      });
      return rule.id;
    });
    const row = {
      tenantId,
      ruleId,
      personId,
      holdingsA: [],
      holdingsB: [],
      contractsA: [],
      contractsB: [],
      severity: 'critical',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSnapshotId: snapshotId,
    };
    await withTenant(tenantId, (tx) => tx.sodViolation.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.sodViolation.create({ data: row })),
    ).rejects.toThrow(/Unique constraint/i);
  });
});

describe('SodException', () => {
  const seedViolation = async () =>
    withTenant(tenantId, async (tx) => {
      const a = await tx.businessFunction.create({
        data: { tenantId, name: 'A', ownerPersonId: personId },
      });
      const b = await tx.businessFunction.create({
        data: { tenantId, name: 'B', ownerPersonId: personId },
      });
      const rule = await tx.sodRule.create({
        data: {
          tenantId,
          name: 'A/B',
          functionAId: a.id,
          functionBId: b.id,
          severity: 'high',
          rationale: 'x',
        },
      });
      const violation = await tx.sodViolation.create({
        data: {
          tenantId,
          ruleId: rule.id,
          personId,
          holdingsA: [],
          holdingsB: [],
          contractsA: [],
          contractsB: [],
          severity: 'high',
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          lastSnapshotId: snapshotId,
        },
      });
      return { ruleId: rule.id, violationId: violation.id };
    });

  it('refuses a null endsAt — a perpetual exception is not representable', async () => {
    const { ruleId, violationId } = await seedViolation();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.sodException.create({
          data: {
            tenantId,
            ruleId,
            personId,
            violationId,
            justification: 'two separate engagements',
            compensatingControl: 'monthly review',
            startsAt: NOW,
            endsAt: null as never,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an exception that ends before it starts', async () => {
    const { ruleId, violationId } = await seedViolation();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.sodException.create({
          data: {
            tenantId,
            ruleId,
            personId,
            violationId,
            justification: 'two separate engagements',
            compensatingControl: 'monthly review',
            startsAt: NOW,
            endsAt: new Date('2026-06-01T00:00:00Z'),
          },
        }),
      ),
    ).rejects.toThrow(/sod_exception_ends_after_it_starts/);
  });
});

describe('ProvisionAction gains one column and nothing else', () => {
  it('carries revocationOrderId', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'ProvisionAction'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names).toContain('revocationOrderId');
    // Nothing else about Provision's table moved. Govern's opinion about a row
    // never lives on that row.
    expect(names).toContain('attributedRuleIds');
    expect(names).not.toContain('governFindingId');
  });
});

describe('ApprovalDecision gains one index and nothing else', () => {
  it('carries an index on (tenantId, decidedAt) for the reciprocity window', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'ApprovalDecision'
    `;
    expect(rows.some((r) => /decidedAt/.test(r.indexdef))).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('hides every slice-2 table from another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    await withTenant(tenantId, (tx) => tx.campaign.create({ data: campaignData() }));
    const seen = await withTenant(other.id, async (tx) => ({
      campaigns: await tx.campaign.count(),
      violations: await tx.sodViolation.count(),
      orders: await tx.revocationOrder.count(),
    }));
    expect(seen).toEqual({ campaigns: 0, violations: 0, orders: 0 });
  });
});
