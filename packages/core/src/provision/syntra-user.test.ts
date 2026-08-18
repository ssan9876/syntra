import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { SYNC_JOB } from '../sync/jobs.js';
import { driftFingerprint } from './reconcile.js';
import {
  applySyntraUserAction,
  claimSyntraUsers,
  enqueuePairedSync,
  NotASyntraUserActionError,
  ProvisionActionNotFoundError,
  SyntraUserActionNotApplicableError,
  SyntraUserActionPayloadError,
  SyntraUserNotFoundError,
} from './syntra-user.js';

let tenantId: string;
let targetId: string;
let sourceId: string;
let personId: string;

/**
 * Prisma's default interactive-transaction timeout, which `withTenant` does
 * not override. The budget every "no I/O inside a transaction" rule in this
 * package is measured against.
 */
const PRISMA_TRANSACTION_MS = 5000;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const source = await tx.directorySource.create({
      data: {
        tenantId,
        name: 'Acme AD read',
        config: {},
        secretName: 'source/bind',
      },
    });
    const target = await tx.targetSystem.create({
      data: {
        tenantId,
        name: 'Acme AD write',
        config: { tlsMode: 'ldaps', url: 'ldaps://dc.acme.test:636' },
        secretName: 'target/bind',
        pairedDirectorySourceId: source.id,
      },
    });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    return { sourceId: source.id, targetId: target.id, personId: person.id };
  });
  sourceId = seeded.sourceId;
  targetId = seeded.targetId;
  personId = seeded.personId;
});

describe('claimSyntraUsers', () => {
  it('links a user to the person whose account carries the same anchor', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
        },
      });
    });

    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 1,
      conflicts: 0,
    });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({}));
    // Ownership is established by the anchor both subsystems already agree on,
    // never by a name.
    expect(user.personId).toBe(personId);
  });

  it('leaves a user already linked to a different person and reports drift', async () => {
    const otherPersonId = await withTenant(tenantId, async (tx) => {
      const other = await tx.person.create({
        data: { tenantId, givenName: 'Bo', familyName: 'Lind' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
          personId: other.id,
        },
      });
      return other.id;
    });

    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 1,
    });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({}));
    expect(user.personId).toBe(otherPersonId);
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).toContain('unexpected_status');
    // Recorded with no run in flight. This fixture seeds none, and resolving
    // one with `findFirstOrThrow` turned the drift report into an exception --
    // so this test failed for a reason that had nothing to do with what it was
    // testing.
    expect(findings[0]!.runId).toBeNull();
    // And its own fingerprint, so it cannot overwrite reconcile's
    // account-status finding about the same account.
    expect(findings[0]!.fingerprint).toMatch(/:syntra_user_link$/);
  });

  it('claims nothing when the target has no paired source', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { pairedDirectorySourceId: null },
      }),
    );
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('never matches on login when the anchors differ', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'a-completely-different-guid',
        },
      });
    });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  // --- added ---

  const seedAccount = (
    data: Partial<{
      personId: string;
      anchor: string | null;
      correlationKey: string;
      status: string;
    }> = {},
  ) =>
    withTenant(tenantId, (tx) =>
      tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
          ...data,
        },
      }),
    );

  const seedUser = (
    data: Partial<{
      login: string;
      email: string;
      sourceId: string | null;
      sourceAnchor: string | null;
      personId: string | null;
      status: string;
    }> = {},
  ) =>
    withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
          ...data,
        },
      }),
    );

  it('claims the login of a person whose account is already disabled', async () => {
    // The whole reason this function exists. `planActions` proposes
    // `deactivate_syntra_user` only for a person it can find a linked user
    // for, so a claim that skipped a disabled account would leave the leaver
    // whose account was disabled before the login was ever claimed holding a
    // live Syntra login, with a Syntra-held password, for good.
    await seedAccount({ status: 'disabled' });
    await seedUser();
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 1,
      conflicts: 0,
    });
  });

  it('claims the login of a person whose account is archived', async () => {
    await seedAccount({ status: 'archived' });
    await seedUser();
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 1,
      conflicts: 0,
    });
  });

  it('claims nothing when there are no accounts at all', async () => {
    await seedUser();
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('claims nothing from a pending account, which has no anchor yet', async () => {
    await seedAccount({ anchor: null, status: 'pending' });
    await seedUser({ sourceAnchor: null });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({}));
    expect(user.personId).toBeNull();
  });

  it('claims nothing on an empty anchor, which is not an identity', async () => {
    // The empty value matching everything it is compared against: a blank
    // `contains` matching every person, an empty `notIn` excluding nobody,
    // and here an empty anchor handing an arbitrary login to an arbitrary
    // person.
    await seedAccount({ anchor: '' });
    await seedUser({ sourceAnchor: '' });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({}));
    expect(user.personId).toBeNull();
  });

  it('reports no conflict for an empty anchor either', async () => {
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedAccount({ anchor: '' });
    await seedUser({ sourceAnchor: '', personId: other.id });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('ignores a user on a different directory source', async () => {
    const otherSource = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: { tenantId, name: 'Other', config: {}, secretName: 'other/bind' },
      }),
    );
    await seedAccount();
    await seedUser({ sourceId: otherSource.id });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('ignores a user with no directory source at all', async () => {
    await seedAccount();
    await seedUser({ sourceId: null });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('ignores an account belonging to another target system', async () => {
    const otherTarget = await withTenant(tenantId, (tx) =>
      tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Other AD',
          config: { tlsMode: 'ldaps', url: 'ldaps://other.acme.test:636' },
          secretName: 'other/target',
          pairedDirectorySourceId: sourceId,
        },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: otherTarget.id,
          personId,
          anchor: 'guid-anna',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      }),
    );
    await seedUser();
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('compares anchors exactly, never by folded case', async () => {
    // Both sides are written by `normaliseAnchor`, which renders every anchor
    // in lower case, so they already agree. Task 11's fast path was a defect
    // because it widened this comparison where the path beside it did not.
    await seedAccount({ anchor: 'guid-anna' });
    await seedUser({ sourceAnchor: 'GUID-ANNA' });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('leaves a user already linked to the right person, and reports nothing', async () => {
    await seedAccount();
    await seedUser({ personId });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings).toEqual([]);
  });

  it('writes no audit event when it changed nothing', async () => {
    await seedAccount();
    await seedUser({ personId });
    await claimSyntraUsers(tenantId, targetId);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.users.claimed' } }),
    );
    expect(events).toEqual([]);
  });

  it('records the claim in the audit chain', async () => {
    await seedAccount();
    await seedUser();
    await claimSyntraUsers(tenantId, targetId);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.users.claimed' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.targetId).toBe(targetId);
    expect(events[0]!.targetType).toBe('TargetSystem');
    expect(events[0]!.payload).toMatchObject({ claimed: 1, conflicts: 0, sourceId });
  });

  it('is idempotent: a second claim changes nothing', async () => {
    await seedAccount();
    await seedUser();
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 1,
      conflicts: 0,
    });
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 0,
      conflicts: 0,
    });
  });

  it('claims five hundred logins inside one transaction budget', async () => {
    // `withTenant` is `prisma.$transaction(fn)` on Prisma's five-second
    // default, and the FIRST claim against a target paired with a source that
    // already holds the whole directory claims every user at once. One update
    // per user is a round trip each, over budget, and permanently so, because
    // a retry re-runs the same volume.
    const persons = Array.from({ length: 500 }, (_, i) => ({
      id: randomUUID(),
      tenantId,
      givenName: 'P',
      familyName: `Person${i}`,
    }));
    await withTenant(tenantId, async (tx) => {
      await tx.person.createMany({ data: persons });
      await tx.targetAccount.createMany({
        data: persons.map((p, i) => ({
          tenantId,
          targetSystemId: targetId,
          personId: p.id,
          anchor: `guid-${i}`,
          correlationKey: `person${i}`,
          status: 'active',
        })),
      });
      await tx.user.createMany({
        data: persons.map((p, i) => ({
          tenantId,
          login: `person${i}`,
          email: `person${i}@acme.test`,
          displayName: `Person ${i}`,
          sourceId,
          sourceAnchor: `guid-${i}`,
        })),
      });
    });

    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 500,
      conflicts: 0,
    });
    const linked = await withTenant(tenantId, (tx) =>
      tx.user.count({ where: { personId: { not: null } } }),
    );
    expect(linked).toBe(500);
  });

  it('does not overwrite reconcile account-status drift about the same account', async () => {
    const account = await seedAccount();
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedUser({ personId: other.id });
    // Exactly the fingerprint `reconcile` builds for account-status drift.
    await withTenant(tenantId, (tx) =>
      tx.driftFinding.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          accountId: account.id,
          kind: 'unexpected_status',
          detail: { reason: 'disabled at the target' },
          fingerprint: driftFingerprint('unexpected_status', account.id, null),
        },
      }),
    );

    await claimSyntraUsers(tenantId, targetId);

    const findings = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findMany({ orderBy: { fingerprint: 'asc' } }),
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.fingerprint)).toEqual([
      driftFingerprint('unexpected_status', account.id, null),
      driftFingerprint('unexpected_status', account.id, null, 'syntra_user_link'),
    ]);
  });

  it('carries the user and both persons in the finding detail', async () => {
    const account = await seedAccount();
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    const user = await seedUser({ personId: other.id });

    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    expect(finding.accountId).toBe(account.id);
    expect(finding.subjectAnchor).toBeNull();
    expect(finding.detail).toMatchObject({
      userId: user.id,
      linkedPersonId: other.id,
      accountPersonId: personId,
    });
  });

  it('re-observes a standing conflict without duplicating or restarting it', async () => {
    await seedAccount();
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedUser({ personId: other.id });

    await claimSyntraUsers(tenantId, targetId);
    const first = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    await claimSyntraUsers(tenantId, targetId);
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());

    expect(findings).toHaveLength(1);
    // "How long has this been wrong" is the question that makes a drift list
    // actionable, so the first sighting is never restamped.
    expect(findings[0]!.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
    // And stamped, so "still true as of now" is a fact the dashboard can age
    // a finding out on.
    expect(findings[0]!.lastSeenAt.getTime()).toBeGreaterThan(
      first.lastSeenAt.getTime(),
    );
  });

  it('refreshes a finding whose stored detail is stale in its wording alone', async () => {
    const account = await seedAccount();
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    const user = await seedUser({ personId: other.id });
    // What an earlier release wrote: the same three ids, a different sentence.
    await withTenant(tenantId, (tx) =>
      tx.driftFinding.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          accountId: account.id,
          kind: 'unexpected_status',
          detail: {
            reason: 'linked to somebody else',
            userId: user.id,
            linkedPersonId: other.id,
            accountPersonId: personId,
          },
          fingerprint: driftFingerprint(
            'unexpected_status',
            account.id,
            null,
            'syntra_user_link',
          ),
        },
      }),
    );

    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    expect((finding.detail as { reason: string }).reason).not.toBe(
      'linked to somebody else',
    );
  });

  it('updates the detail when the account itself moves to another person', async () => {
    const account = await seedAccount();
    const bo = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedUser({ personId: bo.id });
    await claimSyntraUsers(tenantId, targetId);

    const cas = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Cas', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.update({ where: { id: account.id }, data: { personId: cas.id } }),
    );
    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    // Only this field moved: the user and the person it is linked to did not.
    expect(finding.detail).toMatchObject({
      linkedPersonId: bo.id,
      accountPersonId: cas.id,
    });
  });

  it('updates the detail when a different login carries the same anchor', async () => {
    await seedAccount();
    const bo = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    const first = await seedUser({ personId: bo.id });
    await claimSyntraUsers(tenantId, targetId);

    await withTenant(tenantId, (tx) => tx.user.delete({ where: { id: first.id } }));
    const second = await seedUser({
      login: 'anna.novak.2',
      email: 'anna2@acme.test',
      personId: bo.id,
    });
    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    // Only the user moved: both persons are the same as before.
    expect(finding.detail).toMatchObject({
      userId: second.id,
      linkedPersonId: bo.id,
      accountPersonId: personId,
    });
  });

  it('replaces a stored detail that is not an object at all', async () => {
    const account = await seedAccount();
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedUser({ personId: other.id });
    await claimSyntraUsers(tenantId, targetId);
    // A JSON null in a NOT NULL jsonb column: legal, and reading a field off
    // it is a TypeError rather than a comparison that says "not the same".
    await withTenant(tenantId, (tx) =>
      tx.$executeRaw`UPDATE "DriftFinding" SET "detail" = 'null'::jsonb WHERE "accountId" = ${account.id}::uuid`,
    );

    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    expect(finding.detail).toMatchObject({ accountPersonId: personId });
  });

  it('updates the detail when the conflicting link moves to a third person', async () => {
    await seedAccount();
    const bo = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    const user = await seedUser({ personId: bo.id });
    await claimSyntraUsers(tenantId, targetId);

    const cas = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Cas', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { personId: cas.id } }),
    );
    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    expect(finding.detail).toMatchObject({ linkedPersonId: cas.id });
  });

  it('attributes the finding to the most recent run when there is one', async () => {
    await seedAccount();
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedUser({ personId: other.id });
    const latest = await withTenant(tenantId, async (tx) => {
      await tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'applied',
          startedAt: new Date('2026-08-01T00:00:00Z'),
        },
      });
      return tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'applied',
          startedAt: new Date('2026-08-10T00:00:00Z'),
        },
      });
    });

    await claimSyntraUsers(tenantId, targetId);

    const finding = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({}),
    );
    expect(finding.runId).toBe(latest.id);
  });

  it('refuses a target that does not exist', async () => {
    await expect(claimSyntraUsers(tenantId, randomUUID())).rejects.toThrow();
  });

  it('cannot reach another tenant that happens to hold the same anchor', async () => {
    // The claim and the conflict scan are raw SQL. Both spell their tenant
    // predicates out AND rely on the forced `tenant_isolation` policy, and a
    // join written in SQL is exactly where a reviewer should want a fixture
    // rather than an argument. Two tenants, one anchor string, one claim.
    const beta = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    const foreign = await withTenant(beta.id, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId: beta.id, name: 'Beta read', config: {}, secretName: 'b/src' },
      });
      const target = await tx.targetSystem.create({
        data: {
          tenantId: beta.id,
          name: 'Beta write',
          config: { tlsMode: 'ldaps', url: 'ldaps://dc.beta.test:636' },
          secretName: 'b/target',
          pairedDirectorySourceId: source.id,
        },
      });
      const person = await tx.person.create({
        data: { tenantId: beta.id, givenName: 'Bea', familyName: 'Torg' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId: beta.id,
          targetSystemId: target.id,
          personId: person.id,
          anchor: 'guid-anna',
          correlationKey: 'bea.torg',
          status: 'active',
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: beta.id,
          login: 'bea.torg',
          email: 'bea@beta.test',
          displayName: 'Bea Torg',
          sourceId: source.id,
          sourceAnchor: 'guid-anna',
        },
      });
      return { userId: user.id };
    });

    await seedAccount();
    await seedUser();
    expect(await claimSyntraUsers(tenantId, targetId)).toEqual({
      claimed: 1,
      conflicts: 0,
    });

    const untouched = await withTenant(beta.id, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: foreign.userId } }),
    );
    expect(untouched.personId).toBeNull();
  });
});

describe('applySyntraUserAction', () => {
  const seedAction = async (actionType: string, userStatus: string) =>
    withTenant(tenantId, async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId,
          sourceAnchor: 'guid-anna',
          personId,
          status: userStatus,
        },
      });
      const run = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applying' },
      });
      const action = await tx.provisionAction.create({
        data: {
          tenantId,
          runId: run.id,
          actionType,
          personId,
          after: {
            userId: user.id,
            status: actionType === 'deactivate_syntra_user' ? 'inactive' : 'active',
          },
        },
      });
      return { userId: user.id, actionId: action.id };
    });

  it('deactivates the user and writes the audit event in the same transaction', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    await applySyntraUserAction(tenantId, actionId, null);

    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    // Without this, a leaver whose AD account Provision has just disabled
    // still holds a live Syntra login with a Syntra-held password.
    expect(user.status).toBe('inactive');

    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('applied');
    expect(action.appliedAt).not.toBeNull();

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetId: actionId } }),
    );
    // Exactly one event: these two action types call no connector, so there is
    // no intent-then-result pair and no in-flight state to resolve.
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('provision.action.result');
  });

  it('reactivates the user', async () => {
    const { userId, actionId } = await seedAction('reactivate_syntra_user', 'inactive');
    await applySyntraUserAction(tenantId, actionId, null);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('active');
  });

  it('writes nothing else about the user', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    const before = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    await applySyntraUserAction(tenantId, actionId, null);
    const after = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    // Not its mapped fields, not its memberships, not its person link.
    expect(after.displayName).toBe(before.displayName);
    expect(after.email).toBe(before.email);
    expect(after.personId).toBe(before.personId);
  });

  // --- added ---

  it('refuses an action type that is not one of the two, without activating anybody', async () => {
    // The ternary reads every type that is not `deactivate_syntra_user` as a
    // reactivation, so a mis-routed `disable_account` would turn a leaver's
    // login back ON.
    const { userId, actionId } = await seedAction('disable_account', 'inactive');
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      NotASyntraUserActionError,
    );
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('proposed');
  });

  it('refuses a reactivation a later run superseded', async () => {
    // A decision somebody already reversed. Re-running it is how a leaver
    // gets their login back.
    const { userId, actionId } = await seedAction('reactivate_syntra_user', 'inactive');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { status: 'superseded' },
      }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionNotApplicableError,
    );
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
  });

  it('refuses an action that was skipped', async () => {
    const { actionId } = await seedAction('reactivate_syntra_user', 'inactive');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({ where: { id: actionId }, data: { status: 'skipped' } }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionNotApplicableError,
    );
  });

  it('refuses to apply an action a second time', async () => {
    const { actionId } = await seedAction('deactivate_syntra_user', 'active');
    await applySyntraUserAction(tenantId, actionId, null);
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionNotApplicableError,
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetId: actionId } }),
    );
    expect(events).toHaveLength(1);
  });

  it('applies an action left pending_retry', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { status: 'pending_retry', attempts: 2 },
      }),
    );
    await applySyntraUserAction(tenantId, actionId, null);
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('applied');
    // Counted, not reset: a column that says 1 after three tries is useless.
    expect(action.attempts).toBe(3);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
  });

  it('deactivates on the action type even when the payload says otherwise', async () => {
    // `after.status` is what the planner recorded for the review screen. If it
    // were the instruction, a row whose payload and type disagree would decide
    // which of the two wins, and one of those answers is a live login.
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { after: { userId, status: 'active' } },
      }),
    );
    await applySyntraUserAction(tenantId, actionId, null);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
  });

  it('deactivates a user who is already inactive, and still records the result', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'inactive');
    await applySyntraUserAction(tenantId, actionId, null);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('applied');
  });

  it('deactivates the login of a person who has no target account at all', async () => {
    // The deactivation follows the departure, not the disable write. A leaver
    // whose account an administrator had already disabled by hand -- or whose
    // account had vanished -- must still lose the Syntra login.
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    const accounts = await withTenant(tenantId, (tx) => tx.targetAccount.count());
    expect(accounts).toBe(0);
    await applySyntraUserAction(tenantId, actionId, null);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('inactive');
  });

  it('records the actor, the previous status and the new one', async () => {
    const actor = await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'admin',
          email: 'admin@acme.test',
          displayName: 'Admin',
        },
      }),
    );
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    await applySyntraUserAction(tenantId, actionId, actor.id);
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { targetId: actionId } }),
    );
    expect(event.actorUserId).toBe(actor.id);
    expect(event.targetType).toBe('ProvisionAction');
    expect(event.outcome).toBe('success');
    expect(event.payload).toMatchObject({
      actionType: 'deactivate_syntra_user',
      userId,
      status: 'inactive',
      previousStatus: 'active',
    });
  });

  it('refuses an action that names no Syntra user', async () => {
    const { actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { after: { status: 'inactive' } },
      }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionPayloadError,
    );
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('proposed');
  });

  it('refuses an action whose after is null', async () => {
    const { actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.$executeRaw`UPDATE "ProvisionAction" SET "after" = NULL WHERE id = ${actionId}::uuid`,
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionPayloadError,
    );
  });

  it('refuses a user id that is not a string', async () => {
    const { actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { after: { userId: 7, status: 'inactive' } },
      }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionPayloadError,
    );
  });

  it('refuses an empty user id', async () => {
    const { actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { after: { userId: '', status: 'inactive' } },
      }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserActionPayloadError,
    );
  });

  it('names the user it cannot find rather than failing opaquely', async () => {
    const { actionId } = await seedAction('deactivate_syntra_user', 'active');
    const missing = randomUUID();
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { after: { userId: missing, status: 'inactive' } },
      }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow(
      SyntraUserNotFoundError,
    );
  });

  it('names the action it cannot find', async () => {
    await expect(
      applySyntraUserAction(tenantId, randomUUID(), null),
    ).rejects.toThrow(ProvisionActionNotFoundError);
  });

  it('commits nothing when the user named does not exist', async () => {
    const { userId, actionId } = await seedAction('deactivate_syntra_user', 'active');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: actionId },
        data: { after: { userId: randomUUID(), status: 'inactive' } },
      }),
    );
    await expect(applySyntraUserAction(tenantId, actionId, null)).rejects.toThrow();
    const action = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findUniqueOrThrow({ where: { id: actionId } }),
    );
    expect(action.status).toBe('proposed');
    expect(action.appliedAt).toBeNull();
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { targetId: actionId } }),
    );
    expect(events).toEqual([]);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.status).toBe('active');
  });
});

describe('enqueuePairedSync', () => {
  it('enqueues a run of the paired directory source', async () => {
    const enqueue = vi.fn(async () => 'job-1');
    const scheduler = { enqueue } as never;
    expect(await enqueuePairedSync(scheduler, tenantId, targetId)).toBe(true);
    // An existing job on an existing queue, not a new mechanism. A freshly
    // provisioned person cannot sign in to Syntra until the next directory
    // sync, and this is the cheap mitigation.
    expect(enqueue).toHaveBeenCalledWith(SYNC_JOB, { tenantId, sourceId });
  });

  it('does nothing when there is no paired source', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { pairedDirectorySourceId: null },
      }),
    );
    const enqueue = vi.fn();
    expect(
      await enqueuePairedSync({ enqueue } as never, tenantId, targetId),
    ).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // --- added ---

  it('reports false when the queue declined the job', async () => {
    const enqueue = vi.fn(async () => null);
    expect(await enqueuePairedSync({ enqueue } as never, tenantId, targetId)).toBe(
      false,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses a target that does not exist', async () => {
    const enqueue = vi.fn(async () => 'job-1');
    await expect(
      enqueuePairedSync({ enqueue } as never, tenantId, randomUUID()),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it(
    'enqueues outside the transaction that read the target',
    { timeout: 30_000 },
    async () => {
      /**
       * The distinguishing signal is the DURATION, not a read.
       *
       * This test used to open a nested `withTenant` inside `enqueue` and
       * assert it could read the target. It could not fail: the nested
       * transaction takes a DIFFERENT pooled connection and reads a row
       * committed in `beforeEach`, so it succeeds whether or not the outer
       * transaction is still open. It was guarding a transaction-budget
       * invariant with nothing.
       *
       * `withTenant` is `prisma.$transaction(fn)` on Prisma's 5000 ms default,
       * and that budget is exactly what an enqueue inside the transaction
       * spends: `scheduler.enqueue` is a write to pg-boss over its own
       * connection, and in production it is as slow as that queue is. So the
       * fake queue is made slower than the budget. Outside the transaction —
       * where the code puts it — nothing is held and this passes. Moved
       * inside, Prisma rolls the transaction back at 5000 ms and the commit
       * fails with P2028, which is precisely the production failure this
       * placement exists to prevent: a target that cannot be provisioned at
       * all whenever the queue is slow.
       */
      const enqueue = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, PRISMA_TRANSACTION_MS + 800));
        return 'job-1';
      });
      expect(await enqueuePairedSync({ enqueue } as never, tenantId, targetId)).toBe(
        true,
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
    },
  );
});
