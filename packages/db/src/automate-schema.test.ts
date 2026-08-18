import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { asDatabaseSuperuser, resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;
let personId: string;
let workflowId: string;
let productId: string;

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const o = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
  tenantId = t.id;
  otherTenantId = o.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const workflow = await tx.approvalWorkflow.create({
      data: { tenantId, name: 'Manager approval' },
    });
    const product = await tx.product.create({
      data: {
        tenantId,
        name: 'Statistics licence',
        slug: 'statistics-licence',
        kind: 'application',
        workflowId: workflow.id,
      },
    });
    return { personId: person.id, workflowId: workflow.id, productId: product.id };
  });
  personId = seeded.personId;
  workflowId = seeded.workflowId;
  productId = seeded.productId;
});

describe('automate settings', () => {
  it('defaults every number to the value the spec fixes', async () => {
    const settings = await withTenant(tenantId, (tx) =>
      tx.automateSettings.create({ data: { tenantId } }),
    );
    expect(settings.sweepSchedule).toBe('0 2 * * *');
    expect(settings.sweepThresholdPercent).toBe(10);
    expect(settings.perProductSweepThresholdPercent).toBe(50);
    expect(settings.personPopulationDropPercent).toBe(20);
    expect(settings.fulfilmentSlaHours).toBe(24);
    expect(settings.expiryWarningDays).toEqual([7, 1]);
    expect(settings.preHireHorizonDays).toBe(14);
    expect(settings.maxDelegationDays).toBe(90);
    expect(settings.maxApprovers).toBe(10);
    expect(settings.delegatedBulkLimit).toBe(25);
    // The denominator the population-collapse refusal compares against. Null
    // until a sweep has been applied, which is what makes the first sweep in
    // a tenant confirmable rather than measurable.
    expect(settings.lastAppliedSweepAt).toBeNull();
    expect(settings.personsWithActiveContractAtLastSweep).toBeNull();
  });
});

describe('product', () => {
  it('is visible to nobody by default and starts as a draft', async () => {
    const product = await withTenant(tenantId, (tx) =>
      tx.product.findUniqueOrThrow({ where: { id: productId } }),
    );
    // NULL means NOBODY. The tempting alternative -- absent means everybody --
    // is an unconfigured control that fails open.
    expect(product.audienceCondition).toBeNull();
    expect(product.status).toBe('draft');
    expect(product.durationMode).toBe('permanent');
  });

  it('refuses a fixed duration with no default number of days', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: productId },
          data: { durationMode: 'fixed', defaultDurationDays: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses requesterChoice with no cap', async () => {
    // Without a cap, requesterChoice is `permanent` with extra clicks.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: productId },
          data: { durationMode: 'requesterChoice', maxDurationDays: null },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a default duration longer than the cap', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: productId },
          data: {
            durationMode: 'requesterChoice',
            defaultDurationDays: 90,
            maxDurationDays: 30,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an entitlement grant with no target system', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.productGrant.create({
          data: {
            tenantId,
            productId,
            resourceType: 'entitlement',
            resourceId: personId,
            targetSystemId: null,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('approval stage', () => {
  const stage = (over: Record<string, unknown> = {}) => ({
    tenantId,
    workflowId,
    sequence: 1,
    name: 'Manager',
    selector: 'manager',
    fallbackSelector: 'role',
    ...over,
  });

  it('defaults to any quorum and to reminding forever', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.approvalStage.create({ data: stage() }),
    );
    expect(row.quorum).toBe('any');
    // Remind forever. A request never stops asking, and it never approves
    // itself for not having been read.
    expect(row.onTimeout).toBe('remind');
  });

  it('refuses a manager stage with no fallback selector', async () => {
    // manager, managerChain and resourceOwner are the three that legitimately
    // resolve to nobody: a person with no manager, a chain shorter than n, a
    // resource whose owner was never recorded.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({ data: stage({ fallbackSelector: null }) }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an onTimeout value that is not one of the three', async () => {
    // The one that matters is that no fourth value can be inserted. Approval
    // by inattention is a privilege grant nobody made, and this is the
    // structural half of forbidding it.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({ data: stage({ onTimeout: 'approve' }) }),
      ),
    ).rejects.toThrow();
  });

  it('refuses expire with no expiry window and escalate with no target', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({
          data: stage({ onTimeout: 'expire', expiryHours: null }),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalStage.create({
          data: stage({ onTimeout: 'escalate', escalationSelector: null }),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('approval decision', () => {
  let stepId: string;

  beforeEach(async () => {
    stepId = await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          productId,
          subjectPersonId: personId,
          requestedByUserId: personId,
        },
      });
      const step = await tx.approvalStep.create({
        data: { tenantId, requestId: request.id, sequence: 1, stageSnapshot: {} },
      });
      return step.id;
    });
  });

  it('refuses a rejection with no comment, and one with only whitespace', async () => {
    for (const comment of [null, '   ']) {
      await expect(
        withTenant(tenantId, (tx) =>
          tx.approvalDecision.create({
            data: {
              tenantId,
              stepId,
              personId,
              decision: 'reject',
              comment,
              via: 'selector',
            },
          }),
        ),
      ).rejects.toThrow();
    }
  });

  it('accepts an approval with no comment', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.create({
        data: { tenantId, stepId, personId, decision: 'approve', via: 'selector' },
      }),
    );
    expect(row.comment).toBeNull();
  });

  it('is append-only: an update changes nothing and a delete removes nothing', async () => {
    const created = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.create({
        data: {
          tenantId,
          stepId,
          personId,
          decision: 'reject',
          comment: 'not this quarter',
          via: 'selector',
        },
      }),
    );

    // The rule is DO INSTEAD NOTHING, so neither call raises -- they simply
    // do not happen. Asserting on the row afterwards is the only way to see
    // that, and asserting on a thrown error would pass while the rule was
    // missing.
    await withTenant(tenantId, (tx) =>
      tx.approvalDecision.updateMany({
        where: { id: created.id },
        data: { decision: 'approve', comment: 'changed my mind' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.approvalDecision.deleteMany({ where: { id: created.id } }),
    );

    const after = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.findUnique({ where: { id: created.id } }),
    );
    expect(after?.decision).toBe('reject');
    expect(after?.comment).toBe('not this quarter');
  });
});

describe('access grant', () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    tenantId,
    subjectPersonId: personId,
    resourceType: 'application',
    resourceId: productId,
    startsAt: day('2026-06-01'),
    status: 'active',
    ...over,
  });

  it('refuses a second live grant of the same resource to the same person', async () => {
    await withTenant(tenantId, (tx) => tx.accessGrant.create({ data: grant() }));
    await expect(
      withTenant(tenantId, (tx) =>
        tx.accessGrant.create({ data: grant({ status: 'pending' }) }),
      ),
    ).rejects.toThrow();
  });

  it('allows a new grant once the old one is no longer live', async () => {
    // This is what an extension does, and a plain unique index over the four
    // columns would forbid it.
    await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({ data: grant({ status: 'expired' }) }),
    );
    const replacement = await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({ data: grant({ startsAt: day('2026-07-01') }) }),
    );
    expect(replacement.status).toBe('active');
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.accessGrant.create({
          data: grant({ startsAt: day('2026-06-01'), endsAt: day('2026-05-01') }),
        }),
      ),
    ).rejects.toThrow();
  });

  it('starts unflagged for review', async () => {
    const row = await withTenant(tenantId, (tx) =>
      tx.accessGrant.create({ data: grant() }),
    );
    expect(row.needsReview).toBe(false);
    expect(row.reviewReason).toBeNull();
    expect(row.supersededByGrantId).toBeNull();
    expect(row.approvedByPersonId).toBeNull();
    // Nothing was written on this grant's behalf, so ending it must delete
    // nothing. An empty list is the honest default; the hazard the column
    // exists for is a delete keyed on (applicationId, userId) taking out a
    // row somebody else created.
    expect(row.writtenRowIds).toEqual([]);
  });
});

describe('resource delegation', () => {
  it('refuses a capability outside the closed set', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.resourceDelegation.create({
          data: {
            tenantId,
            resourceType: 'group',
            resourceId: productId,
            delegatePersonId: personId,
            capabilities: ['grant', 'delete_group'],
            startsAt: day('2026-06-01'),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a delegation naming both a person and a group', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.resourceDelegation.create({
          data: {
            tenantId,
            resourceType: 'group',
            resourceId: productId,
            delegatePersonId: personId,
            delegateGroupId: productId,
            capabilities: ['grant'],
            startsAt: day('2026-06-01'),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('expiry sweep', () => {
  it('refuses a second non-terminal sweep in one tenant', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'previewed' } }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.expirySweep.create({ data: { tenantId, status: 'running' } }),
      ),
    ).rejects.toThrow();
  });

  it('allows a new sweep once the previous one reached a terminal state', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'applied' } }),
    );
    const next = await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'running' } }),
    );
    expect(next.status).toBe('running');
  });

  it('treats superseded as terminal, so a blocked sweep can be got out of the way', async () => {
    // The escape hatch for the index above. Without a terminal status a
    // blocked sweep -- or one left running by a crashed process -- occupies
    // the slot forever, every later preview raises P2002, and no grant in
    // the tenant ever expires again. Task 13 performs this transition; this
    // case proves the database permits it.
    const stale = await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'blocked' } }),
    );
    const next = await withTenant(tenantId, async (tx) => {
      await tx.expirySweep.update({
        where: { id: stale.id },
        data: { status: 'superseded', finishedAt: day('2026-06-02') },
      });
      return tx.expirySweep.create({ data: { tenantId, status: 'running' } });
    });
    expect(next.status).toBe('running');
  });

  it('allows a non-terminal sweep in each of two tenants at once', async () => {
    await withTenant(tenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId, status: 'running' } }),
    );
    const other = await withTenant(otherTenantId, (tx) =>
      tx.expirySweep.create({ data: { tenantId: otherTenantId, status: 'running' } }),
    );
    expect(other.tenantId).toBe(otherTenantId);
  });
});

describe('the changes to tables other subsystems own', () => {
  it('defaults an entitlement to not requestable', async () => {
    const row = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 'target/ad/bind',
          config: {
            url: 'ldaps://dc.acme.test:636',
            tlsMode: 'ldaps',
            bindDn: 'CN=svc,DC=acme,DC=test',
            baseDn: 'DC=acme,DC=test',
          },
        },
      });
      return tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-finance',
          type: 'group',
          displayName: 'Finance',
        },
      });
    });
    // A target's catalog can be published without publishing every group in
    // the domain.
    expect(row.requestable).toBe(false);
  });
});

describe('row-level security', () => {
  it("hides another tenant's request, grant and product", async () => {
    await withTenant(otherTenantId, async (tx) => {
      const workflow = await tx.approvalWorkflow.create({
        data: { tenantId: otherTenantId, name: 'Theirs' },
      });
      const product = await tx.product.create({
        data: {
          tenantId: otherTenantId,
          name: 'Theirs',
          slug: 'theirs',
          kind: 'application',
          workflowId: workflow.id,
        },
      });
      const request = await tx.accessRequest.create({
        data: {
          tenantId: otherTenantId,
          productId: product.id,
          subjectPersonId: product.id,
          requestedByUserId: product.id,
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId: otherTenantId,
          subjectPersonId: product.id,
          resourceType: 'application',
          resourceId: product.id,
          requestId: request.id,
          startsAt: day('2026-06-01'),
          status: 'active',
        },
      });
    });

    // Read as the OTHER tenant would, with a query written as badly as
    // possible -- no tenant filter at all. The policy is what makes this
    // empty, not the where clause.
    const seen = await withTenant(tenantId, async (tx) => ({
      products: await tx.product.count({ where: { slug: 'theirs' } }),
      requests: await tx.accessRequest.count(),
      grants: await tx.accessGrant.count(),
    }));
    expect(seen).toEqual({ products: 0, requests: 0, grants: 0 });
  });

  it('refuses to write a row into another tenant', async () => {
    // WITH CHECK, not only USING. Without it, a caller bound to one tenant
    // could insert rows belonging to another and simply never see them again.
    await expect(
      withTenant(tenantId, (tx) =>
        tx.approvalWorkflow.create({
          data: { tenantId: otherTenantId, name: 'Smuggled' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('still has the policy forced against the application role', async () => {
    // A FORCE that was never applied is invisible until the day somebody
    // relies on it. Read the catalogue rather than inferring from behaviour.
    const rows = await prisma.$queryRaw<{ relname: string; relforcerowsecurity: boolean }[]>`
      SELECT relname, relforcerowsecurity FROM pg_class
      WHERE relname IN ('AccessRequest', 'AccessGrant', 'ApprovalDecision', 'NotificationOutbox')
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);
  });
});

describe('tamper detection through direct database access', () => {
  it('can be shown to bypass the rule, which is why the audit chain exists', async () => {
    // The rules stop the APPLICATION. A superuser is a different threat and a
    // different control -- recorded here so nobody later reads the append-only
    // rule as protection against database-level compromise.
    const stepId = await withTenant(tenantId, async (tx) => {
      const request = await tx.accessRequest.create({
        data: { tenantId, productId, subjectPersonId: personId, requestedByUserId: personId },
      });
      const step = await tx.approvalStep.create({
        data: { tenantId, requestId: request.id, sequence: 1, stageSnapshot: {} },
      });
      return step.id;
    });
    const created = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.create({
        data: { tenantId, stepId, personId, decision: 'approve', via: 'selector' },
      }),
    );

    await asDatabaseSuperuser('ALTER TABLE "ApprovalDecision" DISABLE RULE approval_decision_no_update');
    try {
      await asDatabaseSuperuser('UPDATE "ApprovalDecision" SET "via" = $1 WHERE id = $2', [
        'administrator',
        created.id,
      ]);
    } finally {
      await asDatabaseSuperuser('ALTER TABLE "ApprovalDecision" ENABLE RULE approval_decision_no_update');
    }

    const after = await withTenant(tenantId, (tx) =>
      tx.approvalDecision.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(after.via).toBe('administrator');
  });
});
