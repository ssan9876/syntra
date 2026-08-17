import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `@syntra/connectors/testing`, not the package root. Commit `00b7631` took
// `FakeTarget` out of the root barrel deliberately — a fake reachable from
// production code is a fake that will eventually be reached — and the package
// declares an `exports` map, so the root import the brief specified does not
// resolve at all.
import type { SourceRecord } from '@syntra/connectors';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  updateTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';
import { previewProvisionRun, ProvisionRunInFlightError } from './run-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let targetId: string;
let entitlementId: string;
let target: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

async function seedPerson(givenName: string, familyName: string, endDate: Date | null) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName, familyName } });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        endDate,
        department: 'Finance',
      },
    });
    return person.id;
  });
}

/** An object at the target, created the way the target itself would create it. */
async function seedObject(correlationKey: string, options: { holdsFinance?: boolean } = {}) {
  const created = await target.write({ domain: 'acme.test' } as never, {
    op: 'create_account',
    actionId: `seed-${correlationKey}`,
    correlationKey,
    attributes: { distinguishedName: [`CN=${correlationKey},${USERS}`] },
    enabled: true,
    initialPassword: 'Aa1!seed-password',
  });
  if (options.holdsFinance) {
    await target.write({ domain: 'acme.test' } as never, {
      op: 'grant_entitlement',
      actionId: `seed-g-${correlationKey}`,
      anchor: created.anchor!,
      entitlementId: 'guid-finance',
    });
  }
  return created.anchor!;
}

/** Syntra's own record of an account that already exists at the target. */
async function seedKnownAccount(
  personId: string,
  anchor: string,
  correlationKey: string,
  options: { holdsFinance?: boolean } = {},
) {
  return withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId,
        anchor,
        correlationKey,
        status: 'active',
        lastAppliedAttributes: { displayName: ['Anna Novak'] },
      },
    });
    if (options.holdsFinance) {
      await tx.accountEntitlement.create({
        data: { tenantId, accountId: account.id, entitlementId, origin: 'rule' },
      });
    }
    return account.id;
  });
}

/**
 * The same target, with every record it returns passed through `map`.
 *
 * A delegating object rather than a spread of the instance: every connector
 * member lives on `FakeTarget.prototype`, so `{ ...target }` carries none of
 * them at all.
 */
const mapping = (map: (record: SourceRecord) => SourceRecord) => ({
  test: (c: never) => target.test(c),
  discoverSchema: (c: never) => target.discoverSchema(c),
  listEntitlements: (c: never) => target.listEntitlements(c),
  listContainers: (c: never) => target.listContainers(c),
  readEntitlementMembers: (c: never, dn: string) =>
    target.readEntitlementMembers(c, dn),
  write: (c: never, op: never) => target.write(c, op),
  read: async function* (c: never) {
    for await (const record of target.read(c)) yield map(record);
  },
});

/**
 * A `userAccountControl` of the caller's choosing.
 *
 * It has to be an override on `read` rather than an attribute written onto the
 * seeded object, because `FakeTarget.read` writes `userAccountControl` AFTER
 * spreading the object's own attributes and would overwrite it.
 */
const withUserAccountControl = (value: string) =>
  mapping((record) => ({
    ...record,
    attributes: { ...record.attributes, userAccountControl: [value] },
  }));

/**
 * A directory that echoes attribute names back in lower case.
 *
 * Which is a thing directories do: RFC 4512 makes attribute names
 * case-insensitive and servers differ on the case they return. `FakeTarget`
 * emits exactly the case the consumer expects, so nothing built on it alone
 * can tell a case-sensitive property read from a folded lookup -- Ruling P8,
 * one level up.
 */
const withFoldedAttributeNames = () =>
  mapping((record) => ({
    ...record,
    attributes: Object.fromEntries(
      Object.entries(record.attributes).map(([key, values]) => [
        key.toLowerCase(),
        values,
      ]),
    ),
  }));

/** The same target, recording which entitlements the run asked it about. */
const recordingProbes = (probed: string[]) => ({
  ...mapping((record) => record),
  readEntitlementMembers: (c: never, dn: string) => {
    probed.push(dn);
    return target.readEntitlementMembers(c, dn);
  },
});

const markApplied = () =>
  withTenant(tenantId, (tx) =>
    tx.targetSystem.update({
      where: { id: targetId },
      data: { lastAppliedRunAt: new Date() },
    }),
  );

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
  });
  targetId = created.id;

  target = new FakeTarget();
  // Containers are READ from the target. Without this the target holds no
  // container at all, every person with a required account becomes
  // `container_missing`, and the run proposes nothing -- which is the
  // greenfield deadlock, and it is a fixture that has to reproduce the real
  // shape rather than be worked around.
  target.containers.push(USERS);
  target.entitlements.push({
    externalId: 'guid-finance',
    dn: FINANCE_DN,
    type: 'group',
    displayName: 'Finance',
  });

  entitlementId = await withTenant(tenantId, async (tx) =>
    (
      await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-finance',
          dn: FINANCE_DN,
          type: 'group',
          displayName: 'Finance',
          status: 'present',
        },
      })
    ).id,
  );

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=Users,DC=acme,DC=test',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
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
});

const preview = () =>
  previewProvisionRun(tenantId, provider, targetId, { now: NOW, connector: target as never });

// `sequence`, not `createdAt`. Every row phase 7 writes carries the same
// createdAt -- PostgreSQL's now() is transaction start time -- so an assertion
// on action order that reads by createdAt is asserting nothing and is flaky in
// whichever direction the planner happens to have returned.
const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

describe('previewProvisionRun', () => {
  it('proposes a create and a grant on a first run, and blocks it for confirmation', async () => {
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    // A first run always requires confirmation, regardless of size: every
    // population has a denominator of zero.
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(true);
    expect(run.blockedReason).toContain('never had a run applied');

    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
    // Ordered, and recoverable from the database. Two rows written by one
    // createMany share a createdAt to the microsecond.
    expect(actions.map((a) => a.sequence)).toEqual([0, 1]);

    // Spec section 5: the account has a durable identity in Syntra before it
    // has one in the target, and the correlation key is reserved by the unique
    // index before anything is written anywhere. Nothing else in the system
    // creates this row -- without it the apply has no account to write the
    // anchor onto and the next run proposes the same create again.
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.status).toBe('pending');
    expect(account.anchor).toBeNull();
    expect(account.correlationKey).toBe('anna.novak');
    // And every action for that person names it, so the apply can find it.
    expect(actions.every((a) => a.accountId === account.id)).toBe(true);
  });

  it('proposes a create on a first run against a genuinely empty target', async () => {
    // The greenfield case, and the one the container check used to deadlock.
    // Deriving the container set from the DNs of the accounts the target
    // returned makes it empty when the target is empty, so every person
    // becomes `container_missing` and the run proposes nothing -- and the
    // container can never become visible, because no account can ever be
    // created in it (Ruling P9).
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany(),
    );
    expect(exceptions).toEqual([]);
  });

  it('still refuses a person routed at a container the target does not hold', async () => {
    // The other half of the same ruling: the check is read from the target,
    // and it does NOT disable itself. Provision does not create organizational
    // units in somebody else's domain, and the exception names the container.
    await seedPerson('Anna', 'Novak', null);
    await upsertAccountProfile(tenantId, null, targetId, {
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
      maxUniquenessAttempts: 20,
      containerTemplate: 'OU=Nowhere,DC=acme,DC=test',
      fallbackContainer: 'OU=Nowhere,DC=acme,DC=test',
      attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
      initialPasswordPolicy: { length: 24 },
      initialPasswordDelivery: 'vaultOnly',
    });
    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);
    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany(),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.kind).toBe('container_missing');
    expect(exceptions[0]!.message).toContain('OU=Nowhere,DC=acme,DC=test');
  });

  it('reserves no account for a person reconciliation refused', async () => {
    // The reservation loop and the planner have to name the SAME people. A
    // person whose container is missing gets no `actual` entry, so
    // `planActions` proposes nothing for them -- and a reservation written
    // anyway is a `pending` row holding a login that will never be issued,
    // against somebody nobody is acting on, forever. It also silently reserves
    // the name away from whoever could have used it.
    await seedPerson('Anna', 'Novak', null);
    await upsertAccountProfile(tenantId, null, targetId, {
      correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
      maxUniquenessAttempts: 20,
      containerTemplate: 'OU=Nowhere,DC=acme,DC=test',
      fallbackContainer: 'OU=Nowhere,DC=acme,DC=test',
      attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
      initialPasswordPolicy: { length: 24 },
      initialPasswordDelivery: 'vaultOnly',
    });
    await preview();
    const accounts = await withTenant(tenantId, (tx) => tx.targetAccount.findMany());
    expect(accounts).toEqual([]);
  });

  it('gives two people with the same name two different logins', async () => {
    // `takenCorrelationKeys` is read once per person, so the run has to add
    // each generated key to it as it goes. Passing the seed set unchanged
    // hands both Anna Novaks `anna.novak`: the generator's numeric suffix
    // never fires, the second reservation violates the unique index on
    // (tenantId, targetSystemId, correlationKey), and the whole run fails --
    // identically on every retry, because nothing about the input changed.
    await seedPerson('Anna', 'Novak', null);
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();

    const accounts = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findMany({ orderBy: { correlationKey: 'asc' } }),
    );
    expect(accounts.map((a) => a.correlationKey)).toEqual(['anna.novak', 'anna.novak2']);
    const actions = await actionsOf(run.id);
    expect(actions.filter((a) => a.actionType === 'create_account')).toHaveLength(2);
    expect(actions.every((a) => a.accountId !== null)).toBe(true);
  });

  it('maps membership from distinguished names, which is what the target reports', async () => {
    // Against real Active Directory `memberOf` is a list of DNs and
    // `Entitlement.externalId` is an objectGUID. Keying the map on externalId
    // makes every lookup miss -- silently -- so every managed holding becomes
    // permanent `missing_grant` drift, the planner re-proposes grants for the
    // whole population every run, and the revocation guard's global axis has a
    // denominator of zero.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();

    const run = await preview();
    // Nothing to do: the target holds what Syntra granted. If the DN mapping
    // missed, this would propose `grant_entitlement` and record a
    // `missing_grant` finding.
    expect(await actionsOf(run.id)).toEqual([]);
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).not.toContain('missing_grant');
  });

  it('resolves membership from the last DN Syntra saw when the catalog misses it', async () => {
    // The stored `dn` is seeded into the map first and the live catalog read
    // overwrites it, so a group this run's read did not return is still
    // resolvable. Without the seed one flaky catalog read turns every managed
    // holding into `missing_grant` drift and re-proposes the whole
    // population's grants.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();
    target.entitlements.length = 0;

    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).not.toContain('missing_grant');
  });

  it('reads enabled from the disable bit, never from equality with 512', async () => {
    // 66048 is an ordinary enabled account whose password does not expire.
    // `userAccountControl === '512'` reads it as DISABLED, which proposes an
    // enable against an account that is already on -- every run, forever --
    // and drops it out of `activeAccountsAtTarget`, the disable guard's
    // denominator. `uac.ts` names this exact spelling as the mistake it exists
    // to prevent, and `FakeTarget` emits a bare 512/514, so no fixture built
    // out of it alone can tell the two readings apart -- Ruling P8, one level
    // up: a fake that speaks only the values the consumer expects.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();

    const enabledRun = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: withUserAccountControl('66048') as never,
    });
    expect((await actionsOf(enabledRun.id)).map((a) => a.actionType)).not.toContain(
      'enable_account',
    );

    // The disable bit set on the same flags. Read as disabled, and the enable
    // that the joiner path owes it is proposed.
    const disabledRun = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: withUserAccountControl('66050') as never,
    });
    expect((await actionsOf(disabledRun.id)).map((a) => a.actionType)).toContain(
      'enable_account',
    );
  });

  it('avoids a login an account at the target already holds', async () => {
    // `takenCorrelationKeys` is seeded from BOTH Syntra's own rows and the
    // target's inventory. Dropping the target half generates `anna.novak` for
    // somebody else's existing account: Syntra holds no row for a foreign
    // object, so the reservation succeeds, and the create then fails at the
    // directory as a conflict -- on every run, forever.
    target.seedForeignObject('anna.novak');
    await seedPerson('Anna', 'Novak', null);
    await preview();
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.correlationKey).toBe('anna.novak2');
  });

  it('reads attributes whose names the directory folded to lower case', async () => {
    // Three case-sensitive property reads in one test. Anna is settled at the
    // target, so `memberOf` resolving proves itself by the absence of a grant
    // and `userAccountControl` resolving by the absence of an enable; Bea's
    // login proves `sAMAccountName` resolved, because the name she would
    // otherwise be given belongs to an account the directory already holds.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    target.seedForeignObject('bea.olsen');
    await seedPerson('Bea', 'Olsen', null);
    await markApplied();

    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: withFoldedAttributeNames() as never,
    });
    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
    const bea = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({ where: { status: 'pending' } }),
    );
    expect(bea.correlationKey).toBe('bea.olsen2');
  });

  it('marks a group whose membership cannot be read unreadable, and freezes the rule naming it', async () => {
    // Global Constraint 16, and the status nothing used to write. A group
    // whose ranged read fails was previously treated as fully read with
    // whatever came back -- the exact fail-open Ruling P1 exists to prevent,
    // moved from the connector up into the run.
    await seedPerson('Anna', 'Novak', null);
    target.unreadableEntitlementDns.add(FINANCE_DN);

    const run = await preview();
    expect(await actionsOf(run.id)).toEqual([]);

    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany(),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.kind).toBe('unresolvable_rule');
    expect(exceptions[0]!.message).toContain('unreadable');

    const entitlement = await withTenant(tenantId, (tx) =>
      tx.entitlement.findUniqueOrThrow({ where: { id: entitlementId } }),
    );
    expect(entitlement.status).toBe('unreadable');
  });

  it('promotes a group back to present only once it has been read again', async () => {
    await seedPerson('Anna', 'Novak', null);
    target.unreadableEntitlementDns.add(FINANCE_DN);
    await preview();
    target.unreadableEntitlementDns.delete(FINANCE_DN);
    await preview();

    const entitlement = await withTenant(tenantId, (tx) =>
      tx.entitlement.findUniqueOrThrow({ where: { id: entitlementId } }),
    );
    expect(entitlement.status).toBe('present');
  });

  it('probes only the groups a business rule names', async () => {
    // Every probe is a round trip, and narrowing to the remit is what bounds
    // their number by what an administrator configured rather than by the size
    // of the domain. A group no rule names cannot make any rule unresolvable,
    // so probing it buys nothing -- and on a domain with five thousand groups
    // it is five thousand round trips before the run has read one account.
    const unnamedDn = 'CN=Unnamed,OU=Groups,DC=acme,DC=test';
    target.entitlements.push({
      externalId: 'guid-unnamed',
      dn: unnamedDn,
      type: 'group',
      displayName: 'Unnamed',
    });
    await withTenant(tenantId, (tx) =>
      tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-unnamed',
          dn: unnamedDn,
          type: 'group',
          displayName: 'Unnamed',
          status: 'present',
        },
      }),
    );
    await seedPerson('Anna', 'Novak', null);

    const probed: string[] = [];
    await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: recordingProbes(probed) as never,
    });
    expect(probed).toEqual([FINANCE_DN]);
  });

  it('leaves an unreadable group this run never probed alone', async () => {
    // The promotion is keyed on what was READ, never on "everything that did
    // not fail". Only in-remit groups are probed, so a group that has dropped
    // out of the remit takes no check at all -- and promoting it on the
    // strength of not having failed one makes a rule naming it resolvable
    // again, evaluated against a membership nobody could read. `notIn: []`
    // matching every row is the same Prisma edge that condemned a whole
    // catalog in Task 12, inverted.
    await seedPerson('Anna', 'Novak', null);
    target.unreadableEntitlementDns.add(FINANCE_DN);
    await preview();

    // Out of remit: no rule names it any more, so nothing probes it.
    await withTenant(tenantId, (tx) => tx.businessRule.deleteMany({}));
    await preview();

    const entitlement = await withTenant(tenantId, (tx) =>
      tx.entitlement.findUniqueOrThrow({ where: { id: entitlementId } }),
    );
    expect(entitlement.status).toBe('unreadable');
  });

  it('adopts a run left non-terminal by a dead process instead of refusing forever', async () => {
    // The partial unique index covers running, previewed, blocked AND
    // applying. Demoting only two of the four leaves a crashed run in place,
    // the create violates the index, and every subsequent run for this target
    // throws -- permanently. One crash bricks the target.
    await seedPerson('Anna', 'Novak', null);
    for (const status of ['running', 'applying'] as const) {
      await withTenant(tenantId, (tx) =>
        tx.provisionRun.deleteMany({ where: { targetSystemId: targetId } }),
      );
      await withTenant(tenantId, (tx) =>
        tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status },
        }),
      );

      const run = await preview();
      expect(run.id).toBeDefined();

      const runs = await withTenant(tenantId, (tx) =>
        tx.provisionRun.findMany({ orderBy: { startedAt: 'asc' } }),
      );
      expect(runs).toHaveLength(2);
      // `running` never wrote a plan, so it failed. `applying` may have landed
      // writes at the target, so it is partially_applied -- an honest terminal
      // state and not a claim that it finished.
      expect(runs[0]!.status).toBe(status === 'running' ? 'failed' : 'partially_applied');
    }
  });

  it('resolves a crashed run in-flight actions before creating the new run', async () => {
    // The seam Task 14 fills. It has to be called BEFORE the create, because
    // the create is what throws when the crashed run is still non-terminal --
    // so a call placed after it is unreachable on exactly the run that needed
    // it.
    await seedPerson('Anna', 'Novak', null);
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applying' },
      }),
    );
    const seen: string[] = [];
    let runsWhenCalled = -1;
    await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
      resolveInFlight: async (id) => {
        seen.push(id);
        runsWhenCalled = await withTenant(tenantId, (tx) => tx.provisionRun.count());
        return 0;
      },
    });
    expect(seen).toEqual([targetId]);
    // One run: the crashed one. The new one does not exist yet.
    expect(runsWhenCalled).toBe(1);
  });

  it('names the run that lost the race instead of surfacing a Prisma error', async () => {
    // Two processes starting a run for one target is a race the database
    // refuses, which is right -- but an unhandled P2002 surfaces as an opaque
    // error, the job fails, and the scheduler records nothing. The in-flight
    // seam is the one point where another writer can deterministically get in
    // between the adoption and the create.
    await seedPerson('Anna', 'Novak', null);
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applying' },
      }),
    );
    await expect(
      previewProvisionRun(tenantId, provider, targetId, {
        now: NOW,
        connector: target as never,
        resolveInFlight: async () => {
          await withTenant(tenantId, (tx) =>
            tx.provisionRun.deleteMany({ where: { targetSystemId: targetId } }),
          );
          await withTenant(tenantId, (tx) =>
            tx.provisionRun.create({
              data: { tenantId, targetSystemId: targetId, status: 'running' },
            }),
          );
          return 0;
        },
      }),
    ).rejects.toBeInstanceOf(ProvisionRunInFlightError);
  });

  it('records the counts on the run', async () => {
    await seedPerson('Anna', 'Novak', null);
    // A second entitlement Syntra holds and the target does not offer, so
    // `entitlementsReadFromTarget` cannot be satisfied by Syntra's own catalog
    // size -- which is a different number, about a different thing, that the
    // column would report without anybody noticing.
    await withTenant(tenantId, (tx) =>
      tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-ghost',
          type: 'group',
          displayName: 'Ghost',
        },
      }),
    );
    const run = await preview();
    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }),
    );
    expect(row.personsEvaluated).toBe(1);
    expect(row.personsWithActiveContract).toBe(1);
    expect(row.createAccountCount).toBe(1);
    expect(row.grantEntitlementCount).toBe(1);
    // Read FROM THE TARGET, not from Syntra's own catalog.
    expect(row.entitlementsReadFromTarget).toBe(1);

    const targetRow = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(targetRow.lastRunAt).not.toBeNull();
  });

  it('writes a ProvisionException naming a person with no contracts', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Bo', familyName: 'Lind' } }),
    );
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();

    const exceptions = await withTenant(tenantId, (tx) =>
      tx.provisionException.findMany({ include: { person: true } }),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.person.givenName).toBe('Bo');
    expect(exceptions[0]!.kind).toBe('no_contracts');

    // And nothing is proposed for them.
    const actions = await actionsOf(run.id);
    expect(actions.every((a) => a.personId !== exceptions[0]!.personId)).toBe(true);

    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }),
    );
    expect(row.personsUnprocessable).toBe(1);
  });

  it('writes the plan and the terminal status in one transaction', async () => {
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { actions: true },
      }),
    );
    // There is no readable state in which a run is previewed with no actions,
    // or holds actions while still running.
    expect(row.status).not.toBe('running');
    expect(row.actions.length).toBeGreaterThan(0);
    expect(row.finishedAt).not.toBeNull();
  });

  it('supersedes a previous run still proposed', async () => {
    await seedPerson('Anna', 'Novak', null);
    const first = await preview();
    const second = await preview();

    const superseded = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findMany({ where: { runId: first.id } }),
    );
    expect(superseded.every((a) => a.status === 'superseded')).toBe(true);
    // A superseded action that still needs doing reappears in the run that
    // superseded it.
    const current = await actionsOf(second.id);
    expect(current.map((a) => a.actionType)).toEqual([
      'create_account',
      'grant_entitlement',
    ]);
  });

  it('marks the run failed and writes no plan when the target read throws', async () => {
    await seedPerson('Anna', 'Novak', null);
    // Prototype-preserving. A plain `{ ...target }` copies only the instance's
    // OWN enumerable properties, and every connector method lives on
    // `FakeTarget.prototype` -- so the spread has no `listEntitlements` at
    // all, phase 4 dies on a TypeError about a missing function, and the test
    // passes for a reason that has nothing to do with a directory being
    // unreachable.
    const exploding = Object.assign(
      Object.create(Object.getPrototypeOf(target) as object),
      target,
      {
        read: () => {
          throw new Error('domain controller unreachable');
        },
      },
    );
    await expect(
      previewProvisionRun(tenantId, provider, targetId, {
        now: NOW,
        connector: exploding as never,
      }),
    ).rejects.toThrow('domain controller unreachable');

    const runs = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findMany({ include: { actions: true } }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    // A run that fails partway writes no plan at all.
    expect(runs[0]!.actions).toEqual([]);
    expect(runs[0]!.error).toContain('domain controller unreachable');
    // Nor an account reservation, nor an exception, nor a drift finding.
    const accounts = await withTenant(tenantId, (tx) => tx.targetAccount.findMany());
    expect(accounts).toEqual([]);
  });

  it('records drift under additive without proposing a revocation', async () => {
    // Ruling P2. Additive means "I saw this and left it".
    //
    // The account is recorded WITHOUT the holding: an `unmanaged_entitlement`
    // is by definition one the target holds and Provision never granted, so a
    // fixture that writes the `AccountEntitlement` row first and then grants
    // the same entitlement at the target describes agreement, not drift --
    // `reconcile` sees a recorded grant, calls it Provision's own to keep
    // converging, and records nothing. The finding this test is about is then
    // unreachable and the assertion passes only if it is deleted.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak');
    await seedKnownAccount(personId, anchor, 'anna.novak');
    await markApplied();
    // Granted by hand at the target, outside Provision.
    await target.write({ domain: 'acme.test' } as never, {
      op: 'grant_entitlement',
      actionId: 'by-hand',
      anchor,
      entitlementId: 'guid-finance',
    });

    const run = await preview();
    const findings = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(findings.map((f) => f.kind)).toContain('unmanaged_entitlement');

    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).not.toContain('revoke_entitlement');
  });

  it('updates a persisting drift finding rather than duplicating it', async () => {
    await seedPerson('Anna', 'Novak', null);
    target.seedForeignObject('stranger');
    await preview();
    await preview();
    const findings = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findMany({ where: { kind: 'orphan_account' } }),
    );
    // The count on the dashboard is a count of problems, not of runs.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      findings[0]!.firstSeenAt.getTime(),
    );
  });

  it('keeps firstSeenAt and follows the detail when a finding changes', async () => {
    await seedPerson('Anna', 'Novak', null);
    const anchor = target.seedForeignObject('stranger');
    await preview();
    const before = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({ where: { kind: 'orphan_account' } }),
    );
    // The same object, moved. Same fingerprint (the anchor is immutable), a
    // different DN in the detail.
    target.objects.get(anchor)!.dn = `CN=stranger,OU=Elsewhere,DC=acme,DC=test`;
    const second = await preview();

    const after = await withTenant(tenantId, (tx) =>
      tx.driftFinding.findFirstOrThrow({ where: { kind: 'orphan_account' } }),
    );
    expect(after.id).toBe(before.id);
    expect(after.firstSeenAt.getTime()).toBe(before.firstSeenAt.getTime());
    expect((after.detail as { dn: string }).dn).toBe('CN=stranger,OU=Elsewhere,DC=acme,DC=test');
    expect(after.runId).toBe(second.id);
  });

  it('refuses outright when the target returns nothing while Syntra holds accounts', async () => {
    const personId = await seedPerson('Anna', 'Novak', null);
    await withTenant(tenantId, async (tx) => {
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: 'anchor-existing',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
    });
    await markApplied();
    target.returnsNothing = true;

    const run = await preview();
    expect(run.status).toBe('blocked');
    // There is nothing an administrator could usefully confirm about a
    // directory that may simply be unreachable.
    expect(run.requiresConfirmation).toBe(false);
    expect(run.blockedReason).toContain('no accounts at all');
  });

  it('audits the preview', async () => {
    await seedPerson('Anna', 'Novak', null);
    const run = await preview();
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { action: 'provision.run.preview' },
      }),
    );
    expect(event.targetId).toBe(run.id);
    expect((event.payload as { status: string }).status).toBe('blocked');
  });
});

/**
 * The guard, at the call site.
 *
 * Task 10 proved all seven thresholds are consulted INSIDE the module. Nothing
 * in it could prove the module is called, and a bounded exemption that was
 * never bounded at the call site is the defect this project has already
 * shipped once. These are the tests that make the call site the thing under
 * test: a blocked run applies nothing, and `autoApply` does not change that.
 */
describe('the guard at the call site', () => {
  const noWritesAtTarget = () =>
    expect(target.calls.map((c) => c.op)).toEqual([]);

  it('blocks a run over the create threshold and asks for confirmation', async () => {
    // One account at the target, two joiners. 2 of 1 is 200%, above the 20%
    // default -- and this is the ordinary threshold path, not the first-run
    // refusal, because the target has applied before.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();
    await seedPerson('Bea', 'Olsen', null);
    await seedPerson('Cato', 'Praz', null);
    target.calls.length = 0;
    const before = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );

    const run = await preview();
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(true);
    expect(run.blockedReason).toContain('above the 20% threshold');

    // Blocked means blocked: nothing was written to the target, every action
    // is still merely proposed, and the target has not been recorded as having
    // had a run applied.
    noWritesAtTarget();
    const actions = await actionsOf(run.id);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.status === 'proposed')).toBe(true);
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.lastAppliedRunAt?.getTime()).toBe(before.lastAppliedRunAt?.getTime());
    // The reserved accounts are reservations, not accounts.
    const accounts = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findMany({ where: { status: 'pending' } }),
    );
    expect(accounts.every((a) => a.anchor === null)).toBe(true);
  });

  it('does not apply a blocked run on a target with autoApply set', async () => {
    // `autoApply` is not an input to the guard and there is no path by which a
    // schedule waives it. An unattended run is the case the control exists for.
    await updateTarget(tenantId, provider, null, targetId, { autoApply: true });
    await seedPerson('Anna', 'Novak', null);
    target.calls.length = 0;

    const run = await preview();
    expect(run.status).toBe('blocked');
    noWritesAtTarget();
    const actions = await actionsOf(run.id);
    expect(actions.every((a) => a.status === 'proposed')).toBe(true);
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.lastAppliedRunAt).toBeNull();
  });

  it('does not apply an unblocked run on a target with autoApply set either', async () => {
    // The preview computes and stops, whatever the verdict. Applying is Task
    // 14's, explicitly, and nothing on this path can reach a target.
    await updateTarget(tenantId, provider, null, targetId, { autoApply: true });
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();
    await seedPerson('Bea', 'Olsen', null);
    // Room for the one create this run proposes.
    await updateTarget(tenantId, provider, null, targetId, {
      thresholds: { createAccountThresholdPercent: 100 },
    });
    target.calls.length = 0;

    const run = await preview();
    expect(run.status).toBe('previewed');
    expect(run.blockedReason).toBeNull();
    noWritesAtTarget();
    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toContain('create_account');
    expect(actions.every((a) => a.status === 'proposed')).toBe(true);
  });

  it('counts holders from the target, not from Syntra own grants', async () => {
    // Ruling P25. The per-entitlement denominator is the target's holder
    // count, and it must come from the same read that produced the actions.
    // Here two of the three holders are accounts Syntra has no row for, so a
    // count taken from `AccountEntitlement` would be 1, one revocation would
    // be 100% of it, and the run would be blocked -- on a plan that touches a
    // third of one group.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedObject('stranger.one', { holdsFinance: true });
    await seedObject('stranger.two', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();
    // The rule stops naming Finance, so Anna's recorded grant is revoked.
    await withTenant(tenantId, (tx) => tx.ruleEntitlement.deleteMany({}));
    // 1 of 3 holdings is 33%, so the global revocation axis needs room too.
    await updateTarget(tenantId, provider, null, targetId, {
      thresholds: { revokeEntitlementThresholdPercent: 50 },
    });

    const run = await preview();
    const actions = await actionsOf(run.id);
    expect(actions.map((a) => a.actionType)).toEqual(['revoke_entitlement']);
    expect(run.status).toBe('previewed');

    const entitlement = await withTenant(tenantId, (tx) =>
      tx.entitlement.findUniqueOrThrow({ where: { id: entitlementId } }),
    );
    expect(entitlement.holderCount).toBe(3);

    const row = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: run.id } }),
    );
    expect(row.accountsReadFromTarget).toBe(3);
    expect(row.revokeEntitlementCount).toBe(1);
  });

  it('blocks a revocation that empties a group of most of its holders', async () => {
    // The same setup with one holder instead of three: 1 of 1 is 100%, above
    // the 50% per-entitlement default. This is the axis the pre-flight found
    // silently switched off, and it is reached from the run.
    const personId = await seedPerson('Anna', 'Novak', null);
    const anchor = await seedObject('anna.novak', { holdsFinance: true });
    await seedKnownAccount(personId, anchor, 'anna.novak', { holdsFinance: true });
    await markApplied();
    await withTenant(tenantId, (tx) => tx.ruleEntitlement.deleteMany({}));
    await updateTarget(tenantId, provider, null, targetId, {
      thresholds: { revokeEntitlementThresholdPercent: 100 },
    });
    target.calls.length = 0;

    const run = await preview();
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(true);
    expect(run.blockedReason).toContain('per-entitlement threshold');
    noWritesAtTarget();
  });
});
