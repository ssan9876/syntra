import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  ProductConfigurationError,
  automateSettings,
  createProduct,
  findVisibleProduct,
  previewAudience,
  searchVisibleProducts,
  subjectAudienceFacts,
  updateAutomateSettings,
  updateProduct,
  visibleProducts,
  type ProductInput,
} from './catalog-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let workflowId: string;
let annaPersonId: string;
let boPersonId: string;
let applicationId: string;
let localGroupId: string;
let syncedGroupId: string;

const product = (over: Partial<ProductInput> = {}): ProductInput => ({
  name: 'Statistics licence',
  slug: 'statistics-licence',
  kind: 'application',
  grants: [{ resourceType: 'application', resourceId: applicationId }],
  audienceCondition: {
    field: 'contract.department',
    op: 'equals',
    value: 'Finance',
  },
  workflowId,
  formSchema: [],
  durationMode: 'permanent',
  defaultDurationDays: null,
  maxDurationDays: null,
  ownerPersonId: null,
  ownerGroupId: null,
  status: 'active',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({
    data: { name: 'Acme', slug: 'acme' },
  });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const workflow = await tx.approvalWorkflow.create({
      data: { tenantId, name: 'Manager approval' },
    });
    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    const bo = await tx.person.create({
      data: { tenantId, givenName: 'Bo', familyName: 'Lind' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: bo.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Facilities',
      },
    });
    const application = await tx.application.create({
      data: { tenantId, name: 'Stats', slug: 'stats' },
    });
    const local = await tx.group.create({
      data: { tenantId, name: 'Reading room' },
    });
    const source = await tx.directorySource.create({
      data: {
        tenantId,
        name: 'Corporate LDAP',
        type: 'ldap',
        config: {},
        secretName: 'source/ldap/bind',
      },
    });
    const synced = await tx.group.create({
      data: {
        tenantId,
        name: 'Domain Users',
        sourceId: source.id,
        sourceAnchor: 'guid-domain-users',
      },
    });
    return {
      workflowId: workflow.id,
      annaPersonId: anna.id,
      boPersonId: bo.id,
      applicationId: application.id,
      localGroupId: local.id,
      syncedGroupId: synced.id,
    };
  });
  ({
    workflowId,
    annaPersonId,
    boPersonId,
    applicationId,
    localGroupId,
    syncedGroupId,
  } = seeded);
});

describe('visibility', () => {
  it('shows a product to somebody the audience admits and hides it from everybody else', async () => {
    await createProduct(tenantId, null, product());
    const forAnna = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    const forBo = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, boPersonId, NOW),
    );
    expect(forAnna.map((p) => p.slug)).toEqual(['statistics-licence']);
    expect(forBo).toEqual([]);
  });

  it('shows a product with a null audience to NOBODY, including its own owner', async () => {
    // The security default of the catalog. A product nobody configured is a
    // product nobody sees, and the editor says so.
    await createProduct(
      tenantId,
      null,
      product({ audienceCondition: null, ownerPersonId: annaPersonId }),
    );
    const forAnna = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    expect(forAnna).toEqual([]);
  });

  it('lets an update CLEAR the audience, so the product becomes visible to nobody', async () => {
    // The case `createProduct` cannot cover, and the reason the write uses
    // `Prisma.DbNull` rather than `?? undefined`: Prisma reads `undefined` as
    // "do not touch this column", so an administrator editing a product to be
    // visible to nobody would get a product whose previous audience is still
    // in force. A security default made inert by a later layer.
    const { id } = await createProduct(tenantId, null, product());
    expect(
      (
        await withTenant(tenantId, (tx) =>
          visibleProducts(tx, annaPersonId, NOW),
        )
      ).map((p) => p.slug),
    ).toEqual(['statistics-licence']);

    await updateProduct(
      tenantId,
      null,
      id,
      product({ audienceCondition: null }),
    );

    const after = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    expect(after).toEqual([]);
    const row = await withTenant(tenantId, (tx) =>
      tx.product.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.audienceCondition).toBeNull();
  });

  it('shows a product with an empty all to anybody with an active contract', async () => {
    await createProduct(
      tenantId,
      null,
      product({ audienceCondition: { all: [] } }),
    );
    const forBo = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, boPersonId, NOW),
    );
    expect(forBo.map((p) => p.slug)).toEqual(['statistics-licence']);
  });

  it('hides a draft and a retired product from the catalog', async () => {
    await createProduct(
      tenantId,
      null,
      product({ slug: 'a-draft', status: 'draft' }),
    );
    await createProduct(
      tenantId,
      null,
      product({ slug: 'a-retired', name: 'Retired', status: 'retired' }),
    );
    const forAnna = await withTenant(tenantId, (tx) =>
      visibleProducts(tx, annaPersonId, NOW),
    );
    expect(forAnna).toEqual([]);
  });

  it('answers findVisibleProduct with null rather than the row for somebody excluded', async () => {
    // Null, so the route can answer 404. A 403 confirms the thing exists, and
    // "Payroll — Executive Compensation Reporting" existing is itself
    // information about the organization.
    const { id } = await createProduct(tenantId, null, product());
    expect(
      await withTenant(tenantId, (tx) =>
        findVisibleProduct(tx, boPersonId, id, NOW),
      ),
    ).toBeNull();
    expect(
      await withTenant(tenantId, (tx) =>
        findVisibleProduct(tx, annaPersonId, id, NOW),
      ),
    ).not.toBeNull();
  });

  it('applies the same rule to search, which is the endpoint that gets written last', async () => {
    await createProduct(tenantId, null, product());
    const hits = await withTenant(tenantId, (tx) =>
      searchVisibleProducts(tx, boPersonId, 'statistic', NOW),
    );
    expect(hits).toEqual([]);
    const own = await withTenant(tenantId, (tx) =>
      searchVisibleProducts(tx, annaPersonId, 'STATISTIC', NOW),
    );
    expect(own.map((p) => p.slug)).toEqual(['statistics-licence']);
  });

  it('hides everything from somebody whose contracts have all ended', async () => {
    await createProduct(
      tenantId,
      null,
      product({ audienceCondition: { all: [] } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: annaPersonId },
        data: { endDate: day('2026-01-01') },
      }),
    );
    expect(
      await withTenant(tenantId, (tx) =>
        visibleProducts(tx, annaPersonId, NOW),
      ),
    ).toEqual([]);
  });
});

describe('subjectAudienceFacts', () => {
  it('carries the group membership and org unit chain of every account the person holds', async () => {
    const { groupId, parentOrgUnitId } = await withTenant(
      tenantId,
      async (tx) => {
        const parent = await tx.orgUnit.create({
          data: { tenantId, name: 'Head Office' },
        });
        const child = await tx.orgUnit.create({
          data: { tenantId, name: 'Finance', parentId: parent.id },
        });
        const user = await tx.user.create({
          data: {
            tenantId,
            login: 'anna',
            email: 'anna@acme.test',
            displayName: 'Anna Novak',
            personId: annaPersonId,
            orgUnitId: child.id,
          },
        });
        const group = await tx.group.create({
          data: { tenantId, name: 'Analysts' },
        });
        await tx.groupMembership.create({
          data: { tenantId, groupId: group.id, userId: user.id },
        });
        return { groupId: group.id, parentOrgUnitId: parent.id };
      },
    );

    const facts = await withTenant(tenantId, (tx) =>
      subjectAudienceFacts(tx, annaPersonId, NOW),
    );
    expect(facts.groupIds).toContain(groupId);
    // The chain, not only the leaf: a product offered to Head Office reaches
    // everyone under it.
    expect(facts.orgUnitChainIds).toContain(parentOrgUnitId);
    expect(facts.hasActiveContract).toBe(true);
  });

  it('counts an entitlement held through a live grant as held', async () => {
    // person.hasEntitlement exists for the product that only makes sense to
    // somebody who already holds the base licence. A grant that Provision has
    // not applied yet still counts: the person asked, somebody approved, and
    // the second product should be offerable now rather than after the run.
    const entitlementId = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 'target/ad/bind',
          config: { url: 'ldaps://dc.acme.test:636', tlsMode: 'ldaps' },
        },
      });
      const entitlement = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          externalId: 'guid-base',
          type: 'group',
          displayName: 'Base licence',
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId: annaPersonId,
          resourceType: 'entitlement',
          resourceId: entitlement.id,
          targetSystemId: target.id,
          startsAt: day('2026-06-01'),
          status: 'pending',
        },
      });
      return entitlement.id;
    });

    const facts = await withTenant(tenantId, (tx) =>
      subjectAudienceFacts(tx, annaPersonId, NOW),
    );
    expect(facts.entitlementIds).toContain(entitlementId);
  });
});

describe('createProduct — the configurations that are refused', () => {
  it('refuses a localGroup product naming a group a directory source owns', async () => {
    // Its membership is rewritten by that source every run; a request-granted
    // membership would survive until the small hours and then vanish, which is
    // worse than refusing it.
    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'domain-users',
        kind: 'localGroup',
        grants: [{ resourceType: 'group', resourceId: syncedGroupId }],
      }),
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProductConfigurationError);
    expect((failure as ProductConfigurationError).code).toBe('group-is-synced');
    // Naming the owning source is the difference between a refusal somebody
    // can act on and one they argue with.
    expect((failure as Error).message).toContain('Corporate LDAP');
  });

  it('accepts a localGroup product naming a locally-managed group', async () => {
    const created = await createProduct(
      tenantId,
      null,
      product({
        slug: 'reading-room',
        kind: 'localGroup',
        grants: [{ resourceType: 'group', resourceId: localGroupId }],
      }),
    );
    expect(created.id).toBeTruthy();
  });

  it('refuses a bundle whose entitlements span two target systems', async () => {
    // One Provision run must be able to fulfil the whole thing, or the bundle
    // has a fulfilment path that cannot be represented.
    const { entA, entB, targetA, targetB } = await withTenant(
      tenantId,
      async (tx) => {
        const a = await tx.targetSystem.create({
          data: {
            tenantId,
            name: 'AD A',
            secretName: 's/a',
            config: { tlsMode: 'ldaps' },
          },
        });
        const b = await tx.targetSystem.create({
          data: {
            tenantId,
            name: 'AD B',
            secretName: 's/b',
            config: { tlsMode: 'ldaps' },
          },
        });
        const entA = await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: a.id,
            externalId: 'g-a',
            type: 'group',
            displayName: 'A',
            requestable: true,
          },
        });
        const entB = await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: b.id,
            externalId: 'g-b',
            type: 'group',
            displayName: 'B',
            requestable: true,
          },
        });
        return { entA: entA.id, entB: entB.id, targetA: a.id, targetB: b.id };
      },
    );

    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'two-domains',
        kind: 'targetEntitlement',
        grants: [
          {
            resourceType: 'entitlement',
            resourceId: entA,
            targetSystemId: targetA,
          },
          {
            resourceType: 'entitlement',
            resourceId: entB,
            targetSystemId: targetB,
          },
        ],
      }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe(
      'bundle-spans-targets',
    );
  });

  it('refuses an entitlement that has not been marked requestable', async () => {
    const { entitlementId, targetSystemId } = await withTenant(
      tenantId,
      async (tx) => {
        const target = await tx.targetSystem.create({
          data: {
            tenantId,
            name: 'AD',
            secretName: 's/ad',
            config: { tlsMode: 'ldaps' },
          },
        });
        const entitlement = await tx.entitlement.create({
          data: {
            tenantId,
            targetSystemId: target.id,
            externalId: 'g-secret',
            type: 'group',
            displayName: 'Domain Admins',
          },
        });
        return { entitlementId: entitlement.id, targetSystemId: target.id };
      },
    );
    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'domain-admins',
        kind: 'targetEntitlement',
        grants: [
          {
            resourceType: 'entitlement',
            resourceId: entitlementId,
            targetSystemId,
          },
        ],
      }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe(
      'entitlement-not-requestable',
    );
  });

  it('refuses a grant whose resource type does not match the product kind', async () => {
    const failure = await createProduct(
      tenantId,
      null,
      product({
        slug: 'confused',
        kind: 'localGroup',
        grants: [{ resourceType: 'application', resourceId: applicationId }],
      }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe('kind-mismatch');
  });

  it('refuses a product with no grants at all', async () => {
    const failure = await createProduct(
      tenantId,
      null,
      product({ slug: 'empty', grants: [] }),
    ).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe('no-grants');
  });

  it('writes an audit event carrying the audience before and after', async () => {
    const { id } = await createProduct(tenantId, null, product());
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.product.create' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe(id);
    expect(events[0]?.payload).toMatchObject({ slug: 'statistics-licence' });
  });
});

describe('previewAudience', () => {
  it('counts who a condition would admit, out of everybody with an active contract', async () => {
    // The direct analogue of Provision's business-rule impact preview, and it
    // exists for the same reason: an audience whose blast radius is only
    // visible after saving is an audience that gets saved and then discovered.
    const preview = await previewAudience(
      tenantId,
      { field: 'contract.department', op: 'equals', value: 'Finance' },
      10,
      NOW,
    );
    expect(preview).toMatchObject({ matched: 1, total: 2 });
    expect(preview.sample.map((s) => s.displayName)).toEqual(['Anna Novak']);
  });

  it('reports zero for a null condition rather than everybody', async () => {
    const preview = await previewAudience(tenantId, null, 10, NOW);
    expect(preview.matched).toBe(0);
  });

  it('names everybody it matched when no limit is given', async () => {
    // The screen's promise is "412 of 1,180 -- show me who", and capping the
    // sample at 25 while leaving `matched` uncapped answers a different
    // question from the one the copy asks.
    const preview = await previewAudience(
      tenantId,
      { all: [] },
      undefined,
      NOW,
    );
    expect(preview.matched).toBe(2);
    expect(preview.sample).toHaveLength(2);
  });

  it('stays inside one transaction budget at a population the loop would not survive', async () => {
    // 300 persons at roughly seven round trips each is over two thousand
    // statements inside a `prisma.$transaction` whose default timeout is
    // 5000 ms. The set-based form issues seven queries whatever the population.
    // This case is here so that reverting to the per-person loop fails rather
    // than merely getting slower.
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 300; i += 1) {
        const person = await tx.person.create({
          data: { tenantId, givenName: `P${i}`, familyName: 'Bulk' },
        });
        await tx.contract.create({
          data: {
            tenantId,
            personId: person.id,
            sequence: 1,
            isPrimary: true,
            startDate: day('2020-01-01'),
            department: 'Finance',
          },
        });
      }
    });
    const preview = await previewAudience(
      tenantId,
      { field: 'contract.department', op: 'equals', value: 'Finance' },
      undefined,
      NOW,
    );
    expect(preview.total).toBe(302);
    expect(preview.matched).toBe(301);
  });
});

describe('automateSettings', () => {
  it('creates the row on first read with the spec defaults', async () => {
    const settings = await withTenant(tenantId, (tx) => automateSettings(tx));
    expect(settings.sweepThresholdPercent).toBe(10);
    expect(settings.delegatedBulkLimit).toBe(25);
    const again = await withTenant(tenantId, (tx) => automateSettings(tx));
    expect(again.id).toBe(settings.id);
  });

  it('audits a threshold change with the before and after', async () => {
    // Lowering a sweep threshold is functionally the same act as approving
    // everything it would otherwise have caught.
    await updateAutomateSettings(tenantId, null, { sweepThresholdPercent: 90 });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.settings.update' } }),
    );
    expect(events[0]?.payload).toMatchObject({
      changed: { sweepThresholdPercent: { from: 10, to: 90 } },
    });
  });

  it('records no change when the array setting is saved unchanged', async () => {
    // `expiryWarningDays` is `Int[]`, and `next === before[key]` is never true
    // for two arrays -- so a reference comparison writes the column and audits
    // a change on every save of a form nobody edited.
    await updateAutomateSettings(tenantId, null, { expiryWarningDays: [7, 1] });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.settings.update' } }),
    );
    expect(events).toEqual([]);
  });

  it('records the change when the array setting actually moves', async () => {
    await updateAutomateSettings(tenantId, null, {
      expiryWarningDays: [14, 7, 1],
    });
    const settings = await withTenant(tenantId, (tx) => automateSettings(tx));
    expect(settings.expiryWarningDays).toEqual([14, 7, 1]);
  });

  it('refuses a percentage outside the bounds with a message, not a 500', async () => {
    const failure = await updateAutomateSettings(tenantId, null, {
      sweepThresholdPercent: 900,
    }).catch((e: unknown) => e);
    expect((failure as ProductConfigurationError).code).toBe(
      'setting-out-of-range',
    );
    const settings = await withTenant(tenantId, (tx) => automateSettings(tx));
    expect(settings.sweepThresholdPercent).toBe(10);
  });

  it('does not race two concurrent first reads into a P2002', async () => {
    // Reachable: runOutboxJob (every minute), runTickJob (every five) and
    // runSweepJob all call this, and two of them finding nothing and both
    // creating is a unique-constraint violation out of a job whose log
    // explains nothing.
    const [a, b] = await Promise.all([
      withTenant(tenantId, (tx) => automateSettings(tx)),
      withTenant(tenantId, (tx) => automateSettings(tx)),
    ]);
    expect(a.id).toBe(b.id);
  });
});

/**
 * The per-subject helper is not called in a loop over a population.
 *
 * A static instrument, in the shape of this slice's other two: there is no
 * runtime probe for "how many round trips did that transaction make", and the
 * behavioural tests cannot tell the two implementations apart because every
 * one of them names one or two subjects.
 *
 * `subjectAudienceFacts` is roughly SEVEN round trips. `withTenant` is
 * `prisma.$transaction` with Prisma's 5000 ms default. So the helper is safe
 * exactly where the subject count is fixed and small -- the two catalog reads,
 * which answer for one person -- and is a P2028 anywhere the count comes from
 * data. `allSubjectAudienceFacts` answers for everybody in seven queries
 * whatever the population, and is what every bulk path uses.
 *
 * This caught a live one: `delegation-service.ts` called it inside
 * `for (const subjectPersonId of subjects)`, bounded by `delegatedBulkLimit`
 * -- 25 by default and up to 1000 by `SETTING_BOUNDS`, so over seven thousand
 * statements in one transaction, on a portal action a team lead takes.
 */
describe('the per-subject audience helper is not used over a population', () => {
  const DIR = 'packages/core/src/automate';

  /** Comments stripped, so a docstring naming the rule does not break it. */
  const codeOf = (path: string): string =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('is called only by the two single-person catalog reads', () => {
    const callers = readdirSync(DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /subjectAudienceFacts\s*\(/.test(codeOf(`${DIR}/${f}`)));

    // `catalog-service.ts` declares it and calls it from `visibleProducts` and
    // `findVisibleProduct`, each of which answers for ONE person. Any other
    // module calling it is answering for a set, and the set is what makes it
    // a transaction-budget defect.
    expect(callers).toEqual(['catalog-service.ts']);
  });
});
