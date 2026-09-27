import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { hardDeletePerson, PersonDeletionRefusedError } from './person-deletion.js';

let tenantId: string;
let actorId: string;
let personId: string;

const now = new Date('2026-11-11T09:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    actorId = (await createUser(tx, { login: 'purger', email: 'purger@acme.test', displayName: 'P' })).id;
    const person = await tx.person.create({
      data: {
        tenantId,
        givenName: 'Anna',
        familyName: 'Novak',
        businessEmail: 'anna.novak@acme.test',
        status: 'inactive',
      },
    });
    personId = person.id;
  });
});

/** A contract, a target account, a lifecycle operation, a closed privacy case and two logins. */
async function giveThePersonHistory() {
  return withTenant(tenantId, async (tx) => {
    await tx.contract.create({ data: { tenantId, personId, startDate: now } });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Acme AD', secretName: 'target/ad/bind', config: { url: 'ldaps://dc.acme.test:636' } },
    });
    await tx.targetAccount.create({
      data: { tenantId, targetSystemId: target.id, personId, anchor: 'a1', correlationKey: 'anna.novak', status: 'inactive' },
    });
    await tx.lifecycleOperation.create({
      data: { tenantId, personId, kind: 'leaver', idempotencyKey: 'leaver-1', inputFingerprint: 'f' },
    });
    await tx.privacyCase.create({
      data: {
        tenantId,
        personId,
        reference: 'DSAR-2026-0001',
        status: 'closed',
        requestTypes: ['access'],
        reason: 'Subject asked for a copy',
        receivedAt: now,
        dueAt: now,
        verificationMethod: 'known_channel',
        verificationAttestation: 'Called back on file number',
        verifiedByUserId: actorId,
        openedByUserId: actorId,
      },
    });
    const active = await createUser(tx, { login: 'anovak', email: 'anna.novak@acme.test', displayName: 'Anna Novak' });
    const old = await createUser(tx, { login: 'anovak-old', email: 'anna.old@acme.test', displayName: 'Anna Novak' });
    await tx.user.update({ where: { id: active.id }, data: { personId } });
    await tx.user.update({ where: { id: old.id }, data: { personId, status: 'inactive' } });
    return { userIds: [active.id, old.id] };
  });
}

const purge = () =>
  withTenant(tenantId, (tx) =>
    hardDeletePerson(tx, personId, { actorUserId: actorId, reason: 'Created in error by CSV import', sourceIp: '10.0.0.1' }),
  );

describe('hardDeletePerson', () => {
  it('deletes the person and everything referencing them, and returns the counts', async () => {
    const { userIds } = await giveThePersonHistory();

    const counts = await purge();

    expect(counts).toEqual({
      contracts: 1,
      placements: 0,
      provisionReceipts: 0,
      sourceLinks: 0,
      lifecycleOperations: 1,
      duplicateReviews: 0,
      privacyCases: 1,
      provisionExceptions: 0,
      targetAccounts: 1,
      usersUnlinked: 2,
    });
    await withTenant(tenantId, async (tx) => {
      expect(await tx.person.findUnique({ where: { id: personId } })).toBeNull();
      expect(await tx.contract.count()).toBe(0);
      expect(await tx.targetAccount.count()).toBe(0);
      expect(await tx.lifecycleOperation.count()).toBe(0);
      expect(await tx.privacyCase.count()).toBe(0);
      // The logins stay, unlinked and unable to sign in.
      const users = await tx.user.findMany({ where: { id: { in: userIds } } });
      expect(users).toHaveLength(2);
      for (const user of users) {
        expect(user.personId).toBeNull();
        expect(user.status).toBe('inactive');
      }
    });
  });

  it('records one person.purged event with the reason and counts, and no personal data', async () => {
    await giveThePersonHistory();
    await purge();

    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { action: 'person.purged' } }));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({ targetType: 'Person', targetId: personId, outcome: 'success', actorUserId: actorId });
    expect(event.payload).toMatchObject({
      reason: 'Created in error by CSV import',
      counts: expect.objectContaining({ contracts: 1, usersUnlinked: 2 }),
    });
    const text = JSON.stringify(event.payload);
    for (const personal of ['Anna', 'Novak', 'anna.novak@acme.test', 'anovak']) {
      expect(text).not.toContain(personal);
    }
  });

  it('refuses an active person and changes nothing', async () => {
    await withTenant(tenantId, (tx) => tx.person.update({ where: { id: personId }, data: { status: 'active' } }));

    await expect(purge()).rejects.toMatchObject({ code: 'active' });
    await expect(purge()).rejects.toBeInstanceOf(PersonDeletionRefusedError);
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(1);
  });

  it('refuses while a privacy case is open, naming it', async () => {
    await giveThePersonHistory();
    await withTenant(tenantId, (tx) => tx.privacyCase.updateMany({ data: { status: 'open' } }));

    await expect(purge()).rejects.toMatchObject({
      code: 'open-privacy-case',
      message: expect.stringContaining('DSAR-2026-0001'),
    });
    await withTenant(tenantId, async (tx) => {
      expect(await tx.person.count()).toBe(1);
      expect(await tx.contract.count()).toBe(1);
    });
  });

  it('answers not-found for an id nobody holds', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        hardDeletePerson(tx, '00000000-0000-4000-8000-000000000000', { actorUserId: actorId, reason: 'x'.repeat(10) }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
