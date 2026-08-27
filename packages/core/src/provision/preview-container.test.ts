import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { previewContainerForFacts } from './preview-container.js';

/**
 * The distinguished name a joiner's account WOULD be created at, rendered
 * before the person exists.
 *
 * The existing profile preview takes a personId, which is no use to the
 * onboarding form: its whole purpose is showing where somebody will land while
 * that is still free to change. This renders from typed facts instead — and
 * through `renderContainer`, the same function the run uses, so the screen an
 * administrator checks cannot disagree with what provisioning does.
 */

let tenantId: string;
let targetId: string;

const BASE_DN = 'DC=acme,DC=test';

async function seedTarget(profile?: {
  containerTemplate: string;
  fallbackContainer: string;
}) {
  const tenant = await prisma.tenant.create({
    data: { name: 'Acme', slug: `acme-${Math.abs(Date.now() % 100000)}` },
  });
  tenantId = tenant.id;

  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.create({
      data: {
        tenantId,
        name: 'AD',
        type: 'ad',
        // `tlsMode` is not decoration: a check constraint refuses a target
        // configured to reach a directory in the clear.
        config: { tlsMode: 'ldaps', url: 'ldaps://dc.acme.test:636', baseDn: BASE_DN },
        secretName: 'unused-by-this-preview',
      },
    });
    targetId = target.id;

    if (profile) {
      await tx.accountProfile.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          correlationKeyTemplate: '%person.givenName%.%person.familyName%',
          uniquenessStrategy: 'numericSuffix',
          maxUniquenessAttempts: 20,
          containerTemplate: profile.containerTemplate,
          fallbackContainer: profile.fallbackContainer,
          attributeTemplates: {},
          initialPasswordPolicy: {},
          initialPasswordDelivery: 'vaultOnly',
        },
      });
    }
    return target.id;
  });
}

const facts = (over: Record<string, string | null> = {}) => ({
  givenName: 'Maya',
  familyName: 'Okafor',
  department: 'Nursing',
  jobTitle: 'Staff Nurse',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
});

describe('previewContainerForFacts', () => {
  it('renders the container the account would be created in', async () => {
    await seedTarget({
      containerTemplate: `OU=%contract.department%,OU=Users,%baseDn%`,
      fallbackContainer: `OU=Unsorted,${BASE_DN}`,
    });

    const preview = await previewContainerForFacts(tenantId, targetId, facts(), null);

    expect(preview).toEqual({
      container: `OU=Nursing,OU=Users,${BASE_DN}`,
      fallbackUsed: false,
      missing: [],
    });
  });

  it('shows the org unit container rather than the rendered template', async () => {
    // This preview is the one screen where placement is checked while it is
    // still free to correct. A preview that disagrees with the run is worse
    // than none, because it is believed.
    await seedTarget({
      containerTemplate: `OU=%contract.department%,OU=Users,%baseDn%`,
      fallbackContainer: `OU=Unsorted,${BASE_DN}`,
    });
    const orgUnitId = await withTenant(tenantId, async (tx) => {
      const unit = await tx.orgUnit.create({ data: { tenantId, name: 'Sales' } });
      await tx.orgUnitContainer.create({
        data: {
          tenantId,
          orgUnitId: unit.id,
          targetSystemId: targetId,
          dn: `OU=Sales,OU=Users,${BASE_DN}`,
          state: 'adopted',
        },
      });
      return unit.id;
    });

    const preview = await previewContainerForFacts(tenantId, targetId, facts(), orgUnitId);

    expect(preview).toEqual({
      container: `OU=Sales,OU=Users,${BASE_DN}`,
      fallbackUsed: false,
      missing: [],
    });
  });

  it('renders the template for an org unit not materialised on this target', async () => {
    // Assigned to a unit that has no container HERE. There is no DN to place
    // them at, so the ladder falls through rather than inventing one.
    await seedTarget({
      containerTemplate: `OU=%contract.department%,OU=Users,%baseDn%`,
      fallbackContainer: `OU=Unsorted,${BASE_DN}`,
    });
    const orgUnitId = await withTenant(tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId, name: 'Sales' } }).then((u) => u.id),
    );

    const preview = await previewContainerForFacts(tenantId, targetId, facts(), orgUnitId);

    expect(preview?.container).toBe(`OU=Nursing,OU=Users,${BASE_DN}`);
  });

  it('escapes a department that would otherwise inject into the DN', async () => {
    await seedTarget({
      containerTemplate: `OU=%contract.department%,OU=Users,%baseDn%`,
      fallbackContainer: `OU=Unsorted,${BASE_DN}`,
    });

    const preview = await previewContainerForFacts(
      tenantId,
      targetId,
      facts({ department: 'Finance,OU=Domain Controllers' }),
      null,
    );

    // Through renderContainer, so the comma is escaped rather than treated as
    // a DN separator. A preview that showed the unescaped form would be
    // showing the administrator the wrong answer on the very screen they
    // check it on.
    expect(preview!.container).not.toBe(
      `OU=Finance,OU=Domain Controllers,OU=Users,${BASE_DN}`,
    );
    expect(preview!.container).toContain('\\,');
  });

  it('reports the fallback, and what was missing, when a placeholder resolves to nothing', async () => {
    await seedTarget({
      containerTemplate: `OU=%contract.department%,OU=Users,%baseDn%`,
      fallbackContainer: `OU=Unsorted,${BASE_DN}`,
    });

    const preview = await previewContainerForFacts(
      tenantId,
      targetId,
      facts({ department: null }),
      null,
    );

    // Naming the placeholder is the point: "it will go to Unsorted" without
    // saying why leaves the reader guessing which field to fill in.
    expect(preview).toEqual({
      container: `OU=Unsorted,${BASE_DN}`,
      fallbackUsed: true,
      missing: ['contract.department'],
    });
  });

  it('answers null for a target with no account profile', async () => {
    await seedTarget();

    // Not an error. A target nobody has configured a profile for simply has
    // no answer to give, and the form shows nothing rather than a warning
    // about configuration the reader did not come here to do.
    expect(await previewContainerForFacts(tenantId, targetId, facts(), null)).toBeNull();
  });

  it('answers null for a target that is not there', async () => {
    await seedTarget({
      containerTemplate: `OU=%contract.department%,%baseDn%`,
      fallbackContainer: `OU=Unsorted,${BASE_DN}`,
    });

    const missing = await previewContainerForFacts(
      tenantId,
      '00000000-0000-4000-8000-000000000000',
      facts(),
      null,
    );
    expect(missing).toBeNull();
  });
});
