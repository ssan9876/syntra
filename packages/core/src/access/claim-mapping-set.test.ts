import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createApplication } from './application-service.js';
import {
  ClaimMappingSetProtocolMismatchError,
  applyClaimMappingSet,
  createClaimMapping,
  createClaimMappingSet,
  deleteClaimMappingSet,
  listClaimMappings,
  listClaimMappingSets,
} from './claim-mapping-service.js';

let tenantId: string;

const mapping = (over: Record<string, unknown> = {}) => ({
  protocol: 'saml' as const,
  claimName: 'email',
  nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
  sourceKind: 'user' as const,
  sourceField: 'email',
  contractStrategy: 'primary' as const,
  literalValue: null,
  releaseScope: null,
  multiValued: false,
  ...over,
});

const aSet = (over: Record<string, unknown> = {}) =>
  withTenant(tenantId, (tx) =>
    createClaimMappingSet(tx, {
      name: 'Standard profile',
      description: 'What every application here receives.',
      protocol: 'saml',
      mappings: [mapping(), mapping({ claimName: 'displayName', sourceField: 'displayName' })],
      ...over,
    } as never),
  );

const anApp = (type = 'saml', slug = 'crm') =>
  withTenant(tenantId, (tx) =>
    createApplication(tx, { name: 'CRM', slug, type, launchUrl: 'https://crm.acme.test/' }),
  );

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('claim mapping sets', () => {
  it('stores and lists a set', async () => {
    await aSet();
    const sets = await withTenant(tenantId, (tx) => listClaimMappingSets(tx));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.mappings).toHaveLength(2);
  });

  it('stamps every mapping onto an application', async () => {
    const set = await aSet();
    const app = await anApp();

    const result = await withTenant(tenantId, (tx) =>
      applyClaimMappingSet(tx, app.id, set.id),
    );
    expect(result).toEqual({ added: 2, alreadyPresent: 0 });

    const mappings = await withTenant(tenantId, (tx) =>
      listClaimMappings(tx, app.id, 'saml'),
    );
    expect(mappings.map((m) => m.claimName).sort()).toEqual(['displayName', 'email']);
  });

  it('leaves a claim the application already sends alone', async () => {
    // The set is the general case and a hand edit is the specific one.
    // Overwriting would lose somebody's tuning silently.
    const set = await aSet();
    const app = await anApp();
    await withTenant(tenantId, (tx) =>
      createClaimMapping(tx, app.id, mapping({ sourceField: 'businessEmail' }) as never),
    );

    const result = await withTenant(tenantId, (tx) =>
      applyClaimMappingSet(tx, app.id, set.id),
    );
    expect(result).toEqual({ added: 1, alreadyPresent: 1 });

    const kept = await withTenant(tenantId, (tx) => listClaimMappings(tx, app.id, 'saml'));
    expect(kept.find((m) => m.claimName === 'email')!.sourceField).toBe('businessEmail');
  });

  it('is idempotent', async () => {
    // Applying twice is what somebody does when they are not sure it worked.
    const set = await aSet();
    const app = await anApp();
    await withTenant(tenantId, (tx) => applyClaimMappingSet(tx, app.id, set.id));
    const again = await withTenant(tenantId, (tx) => applyClaimMappingSet(tx, app.id, set.id));

    expect(again).toEqual({ added: 0, alreadyPresent: 2 });
    expect(await withTenant(tenantId, (tx) => tx.claimMapping.count())).toBe(2);
  });

  it('refuses a set whose protocol the application does not use', async () => {
    // A SAML set on an OIDC application writes rows that protocol's builder
    // never reads — mappings that look configured and send nothing.
    const set = await aSet();
    const app = await anApp('oidc', 'grafana');

    await expect(
      withTenant(tenantId, (tx) => applyClaimMappingSet(tx, app.id, set.id)),
    ).rejects.toBeInstanceOf(ClaimMappingSetProtocolMismatchError);
  });

  it('leaves the applications alone when the set is deleted', async () => {
    // Deleting a template is not a decision about the integrations built from
    // it. Taking their mappings away would break every one at once.
    const set = await aSet();
    const app = await anApp();
    await withTenant(tenantId, (tx) => applyClaimMappingSet(tx, app.id, set.id));

    await withTenant(tenantId, (tx) => deleteClaimMappingSet(tx, set.id));

    expect(await withTenant(tenantId, (tx) => tx.claimMapping.count())).toBe(2);
    expect(await withTenant(tenantId, (tx) => listClaimMappingSets(tx))).toEqual([]);
  });

  it('does not change an application when the set is edited afterwards', async () => {
    // Applied by COPY. A set applied by reference would make one edit change
    // every live integration built from it at once.
    const set = await aSet();
    const app = await anApp();
    await withTenant(tenantId, (tx) => applyClaimMappingSet(tx, app.id, set.id));

    await withTenant(tenantId, (tx) =>
      tx.claimMappingSet.update({
        where: { id: set.id },
        data: { mappings: [] as never },
      }),
    );

    expect(
      await withTenant(tenantId, (tx) => listClaimMappings(tx, app.id, 'saml')),
    ).toHaveLength(2);
  });

  it('hides another tenant’s sets', async () => {
    await aSet();
    const other = await prisma.tenant.create({ data: { name: 'Globex', slug: 'globex' } });
    expect(await withTenant(other.id, (tx) => listClaimMappingSets(tx))).toEqual([]);
  });
});
