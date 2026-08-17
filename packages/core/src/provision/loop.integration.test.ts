import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'ldapts';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// The plain module, not the smoke test. Importing a test file executes it:
// its hooks and its five tests would register inside THIS file's collection
// and run again, against fixtures they already created.
//
// `@syntra/connectors/testing` and not a deep `src/ad/...` path: the package
// declares an `exports` map, and an `exports` map denies every unlisted
// subpath (TS2307).
import {
  connectAsSambaAdmin,
  purgeSubtree,
  sambaConnection,
} from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';
import { refreshEntitlements } from './entitlement-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const samba = sambaConnection();
const testOu = `OU=LoopTest,${samba.baseDn}`;
const groupsOu = `OU=LoopGroups,${samba.baseDn}`;
const archiveOu = `OU=LoopArchive,${samba.baseDn}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let targetId: string;
let personId: string;
let admin: Client;

const config = {
  url: samba.url,
  tlsMode: 'ldaps' as const,
  // The container's certificate is self-signed. Deliberate and explicit: with
  // verification on, no connection establishes at all.
  rejectUnauthorized: false,
  bindDn: samba.bindDn,
  baseDn: testOu,
  entitlementSearchBase: groupsOu,
  archiveContainer: archiveOu,
};

beforeEach(async () => {
  await resetDatabase();
  admin = await connectAsSambaAdmin();
  for (const ou of [testOu, groupsOu, archiveOu]) {
    await admin
      .add(ou, { objectClass: ['top', 'organizationalUnit'] })
      .catch(() => undefined);
  }
  // Every object under the three OUs, deepest first. A fixture that only
  // clears users leaves the groups behind, and the second run of this file
  // fails on AlreadyExists.
  for (const ou of [testOu, groupsOu, archiveOu]) {
    await purgeSubtree(admin, ou);
  }
  await admin.add(`CN=LoopFinance,${groupsOu}`, {
    objectClass: ['top', 'group'],
    sAMAccountName: 'LoopFinance',
  });

  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      name: 'Samba AD',
      config,
      bindPassword: samba.bindPassword,
    })
  ).id;

  await refreshEntitlements(tenantId, provider, null, targetId);
  const entitlementId = await withTenant(
    tenantId,
    async (tx) =>
      (await tx.entitlement.findFirstOrThrow({ where: { targetSystemId: targetId } }))
        .id,
  );

  personId = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: {
        tenantId,
        givenName: 'Loop',
        familyName: 'Tester',
        businessEmail: 'loop@syntra.test',
      },
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

    /**
     * A staff around them, matched by no rule.
     *
     * NOT decoration, and this is the finding this fixture exists to record:
     * with one person in the tenant, the leaver run finds ZERO persons holding
     * an active contract and the guard refuses it outright and
     * non-confirmably — correctly, because a population that collapses to
     * nothing is indistinguishable from a broken HR feed. The plan's leaver
     * and rehire scenarios could not run at all against a tenant of one.
     *
     * Six, not one: `personPopulationDropPercent` defaults to 20, so a tenant
     * of two blocks just as hard on a 50% drop. Seven going to six is 14.3%.
     */
    for (let i = 0; i < 6; i += 1) {
      const other = await tx.person.create({
        data: {
          tenantId,
          givenName: 'Loop',
          familyName: `Bystander${i}`,
          businessEmail: `bystander${i}@syntra.test`,
        },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: other.id,
          sequence: 1,
          isPrimary: true,
          startDate: day('2020-01-01'),
          department: 'Facilities',
        },
      });
    }
    return person.id;
  });

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: testOu,
    fallbackContainer: testOu,
    attributeTemplates: {
      displayName: '%person.givenName% %person.familyName%',
      givenName: '%person.givenName%',
      sn: '%person.familyName%',
    },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
}, 180_000);

/** A real user: confirming a run records who confirmed it, and both halves are required. */
const confirmingUser = () =>
  withTenant(
    tenantId,
    async (tx) =>
      (
        await tx.user.create({
          data: {
            tenantId,
            login: `loop-reviewer-${Date.now()}`,
            email: 'loop-reviewer@syntra.test',
            displayName: 'Loop Reviewer',
          },
        })
      ).id,
  );

const cycle = async (now: Date) => {
  const run = await previewProvisionRun(tenantId, provider, targetId, { now });
  const result = await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId: await confirmingUser(),
  });
  return { run, result };
};

const accounts = () =>
  withTenant(tenantId, (tx) => tx.targetAccount.findMany({}));

const searchFor = (sam: string) =>
  admin.search(testOu, {
    scope: 'sub',
    filter: `(sAMAccountName=${sam})`,
    attributes: ['userAccountControl', 'memberOf'],
  });

describe('the whole loop against a real domain controller', () => {
  it(
    'creates the account and its group on a first run, and is a no-op on the second',
    async () => {
      await cycle(day('2026-06-15'));
      const [account] = await accounts();
      expect(account).toBeDefined();
      expect(account!.anchor).not.toBeNull();
      expect(account!.status).toBe('active');

      const { searchEntries } = await searchFor('loop.tester');
      expect(searchEntries).toHaveLength(1);
      // The entitlement was granted at the target, not merely recorded here.
      expect(String(searchEntries[0]!.memberOf ?? '')).toContain('LoopFinance');

      const second = await previewProvisionRun(tenantId, provider, targetId, {
        now: day('2026-06-16'),
      });
      const actions = await withTenant(tenantId, (tx) =>
        tx.provisionAction.findMany({ where: { runId: second.id } }),
      );
      // Convergence. A second run over an unchanged world proposes nothing.
      expect(actions).toEqual([]);
    },
    180_000,
  );

  it(
    'carries a leaver through disable without ever deleting',
    async () => {
      await cycle(day('2026-06-15'));
      await withTenant(tenantId, (tx) =>
        tx.contract.updateMany({
          where: { personId },
          data: { endDate: day('2026-06-20') },
        }),
      );
      await cycle(day('2026-06-21'));

      const [account] = await accounts();
      expect(account!.status).toBe('disabled');
      // The object is still there. Provision never deletes.
      const { searchEntries } = await searchFor('loop.tester');
      expect(searchEntries).toHaveLength(1);
      expect(String(searchEntries[0]!.userAccountControl)).toBe('514');
    },
    180_000,
  );

  it(
    're-enables the same account on a rehire rather than creating a second',
    async () => {
      await cycle(day('2026-06-15'));
      const [first] = await accounts();

      await withTenant(tenantId, (tx) =>
        tx.contract.updateMany({
          where: { personId },
          data: { endDate: day('2026-06-20') },
        }),
      );
      await cycle(day('2026-06-21'));
      await withTenant(tenantId, (tx) =>
        tx.contract.updateMany({ where: { personId }, data: { endDate: null } }),
      );
      await cycle(day('2026-06-24'));

      const after = await accounts();
      expect(after).toHaveLength(1);
      // Their old login and their old files, which is what everybody expects.
      expect(after[0]!.anchor).toBe(first!.anchor);
      expect(after[0]!.status).toBe('active');
    },
    180_000,
  );

  it(
    'generates the next free name rather than adopting an account it did not create',
    async () => {
      // Somebody else's `loop.tester`, present before the run reads the
      // target. Provision never adopts an object it did not create, and the
      // uniqueness generator excludes every name the target already holds.
      await admin.add(`CN=loop.tester,${testOu}`, {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        sAMAccountName: 'loop.tester',
        userAccountControl: '514',
      });
      await cycle(day('2026-06-15'));

      const [account] = await accounts();
      expect(account!.status).toBe('active');
      expect(account!.correlationKey).not.toBe('loop.tester');
      // The stranger's account is untouched: still disabled, still theirs.
      const { searchEntries } = await searchFor('loop.tester');
      expect(searchEntries).toHaveLength(1);
      expect(String(searchEntries[0]!.userAccountControl)).toBe('514');
    },
    180_000,
  );

  it(
    'records a conflict when the name is taken between the plan and the write',
    async () => {
      // The collision the generator CANNOT dodge, and the only one that
      // produces a `conflict`: the plan reserved `loop.tester` because the
      // name was free when the target was read, and somebody else took it
      // before the create ran. Seeding it before the preview instead — which
      // is what the plan's own test did, and what Task 14's conflict test did
      // before it was corrected — tests the uniqueness generator and reports
      // it as a test of conflict handling.
      const run = await previewProvisionRun(tenantId, provider, targetId, {
        now: day('2026-06-15'),
      });
      await admin.add(`CN=loop.tester,${testOu}`, {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        sAMAccountName: 'loop.tester',
        userAccountControl: '514',
      });
      await applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId: await confirmingUser(),
      });

      const [account] = await accounts();
      expect(account!.status).toBe('conflict');
      expect(account!.anchor).toBeNull();
    },
    180_000,
  );
});
