import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { purgeDepartedPersons, readPersonPurgePolicy, setPersonPurgePolicy } from './person-purge.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-01T03:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let tenantId: string;
let adminId: string;
let deletingTarget: string;
let keepingTarget: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme', personPurgeAfterDays: 30 } })).id;
  await withTenant(tenantId, async (tx) => {
    adminId = (await tx.user.create({ data: { tenantId, login: 'owner', email: 'owner@acme.test', displayName: 'Owner' } })).id;
    const target = (name: string, deleteAfterDays: number | null) =>
      tx.targetSystem.create({
        data: { tenantId, name, type: 'activeDirectory', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: `target/${name}`, deleteAfterDays },
      });
    deletingTarget = (await target('AD', 30)).id;
    keepingTarget = (await target('Kept', null)).id;
  });
});

async function person(
  name: string,
  opts: { status?: string; leftDaysAgo?: number | null; sourceOwned?: boolean; accounts?: { target: string; status: string }[] },
) {
  return withTenant(tenantId, async (tx) => {
    let sourceId: string | null = null;
    if (opts.sourceOwned) {
      sourceId = (await tx.personSource.create({
        data: { tenantId, name: `HR ${name}`, type: 'csv', config: {}, secretName: `hr.${name}`, feedMode: 'snapshot' },
      })).id;
    }
    const p = await tx.person.create({
      data: {
        tenantId,
        givenName: name,
        familyName: 'Test',
        status: opts.status ?? 'inactive',
        sourceId,
        departureOverride: opts.leftDaysAgo === null || opts.leftDaysAgo === undefined ? null : daysAgo(opts.leftDaysAgo),
      },
    });
    for (const [i, a] of (opts.accounts ?? []).entries()) {
      await tx.targetAccount.create({
        data: { tenantId, targetSystemId: a.target, personId: p.id, correlationKey: `${name.toLowerCase()}${i}`, status: a.status },
      });
    }
    return p.id;
  });
}

const exists = (id: string) => withTenant(tenantId, (tx) => tx.person.findUnique({ where: { id } })).then((p) => p !== null);

describe('purgeDepartedPersons', () => {
  it('deletes an inactive person past the date whose deleting-target accounts are gone', async () => {
    const gone = await person('Gone', { leftDaysAgo: 40, accounts: [{ target: deletingTarget, status: 'deleted' }, { target: keepingTarget, status: 'disabled' }] });
    const outcome = await purgeDepartedPersons(tenantId, NOW);
    expect(outcome).toMatchObject({ off: false, deleted: 1, held: false });
    expect(await exists(gone)).toBe(false);
    const event = await withTenant(tenantId, (tx) => tx.auditEvent.findFirstOrThrow({ where: { action: 'person.purged', targetId: gone } }));
    expect(event.actorUserId).toBeNull();
    expect(JSON.stringify(event.payload)).not.toContain('Gone');
  });

  it('waits while an account on a deleting target is not deleted yet', async () => {
    const waiting = await person('Waiting', { leftDaysAgo: 40, accounts: [{ target: deletingTarget, status: 'disabled' }] });
    const outcome = await purgeDepartedPersons(tenantId, NOW);
    expect(outcome).toMatchObject({ deleted: 0, waiting: 1 });
    expect(await exists(waiting)).toBe(true);
  });

  it('leaves the recent leaver, the active person and the source-owned person', async () => {
    const recent = await person('Recent', { leftDaysAgo: 10 });
    const active = await person('Active', { status: 'active', leftDaysAgo: null });
    const owned = await person('Owned', { leftDaysAgo: 90, sourceOwned: true });
    await purgeDepartedPersons(tenantId, NOW);
    expect(await exists(recent)).toBe(true);
    expect(await exists(active)).toBe(true);
    expect(await exists(owned)).toBe(true);
  });

  it('does nothing while the policy is off', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { personPurgeAfterDays: null } });
    const old = await person('Old', { leftDaysAgo: 400 });
    expect(await purgeDepartedPersons(tenantId, NOW)).toMatchObject({ off: true, deleted: 0 });
    expect(await exists(old)).toBe(true);
  });

  it('deletes nobody when more than 10% of people would go at once, and says so', async () => {
    const leavers = [];
    for (let i = 0; i < 6; i += 1) leavers.push(await person(`Leaver${i}`, { leftDaysAgo: 60 }));
    for (let i = 0; i < 20; i += 1) await person(`Stayer${i}`, { status: 'active', leftDaysAgo: null });
    const outcome = await purgeDepartedPersons(tenantId, NOW);
    expect(outcome).toMatchObject({ held: true, deleted: 0, due: 6 });
    for (const id of leavers) expect(await exists(id)).toBe(true);
    const held = await withTenant(tenantId, (tx) => tx.auditEvent.findFirst({ where: { action: 'person.purge.held' } }));
    expect(held).not.toBeNull();
  });
});

describe('the purge policy', () => {
  it('reads, changes and audits the number of days', async () => {
    await withTenant(tenantId, async (tx) => {
      expect(await readPersonPurgePolicy(tx)).toEqual({ afterDays: 30 });
      await setPersonPurgePolicy(tx, null, { userId: adminId, sourceIp: null });
      expect(await readPersonPurgePolicy(tx)).toEqual({ afterDays: null });
      const event = await tx.auditEvent.findFirstOrThrow({ where: { action: 'person.purge_policy.updated' } });
      expect(event.payload).toEqual({ before: 30, after: null });
      await expect(setPersonPurgePolicy(tx, 0, { userId: adminId, sourceIp: null })).rejects.toThrow(RangeError);
    });
  });
});
