import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  asDatabaseSuperuser,
  resetDatabase,
} from '@syntra/db/src/test-support.js';
import { recordEvent, verifyChain } from './audit-service.js';

let tenantId: string;

const event = (action: string) => ({
  actorUserId: null,
  action,
  targetType: 'User',
  targetId: null,
  outcome: 'success' as const,
  sourceIp: '10.0.0.1',
  payload: { note: action },
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('recordEvent', () => {
  it('numbers events from 1 and chains each hash to the previous', async () => {
    const first = await withTenant(tenantId, (tx) =>
      recordEvent(tx, event('user.create')),
    );
    const second = await withTenant(tenantId, (tx) =>
      recordEvent(tx, event('user.update')),
    );

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.prevHash).toBe('0'.repeat(64));
    expect(second.prevHash).toBe(first.hash);
  });

  it('keeps separate chains per tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) => recordEvent(tx, event('a')));
    const otherFirst = await withTenant(other.id, (tx) =>
      recordEvent(tx, event('b')),
    );
    expect(otherFirst.sequence).toBe(1);
    expect(otherFirst.prevHash).toBe('0'.repeat(64));
  });
});

describe('verifyChain', () => {
  it('accepts an untampered chain', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, event('a'));
      await recordEvent(tx, event('b'));
      await recordEvent(tx, event('c'));
    });
    const result = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(result).toEqual({ valid: true });
  });

  it('accepts an empty chain', async () => {
    const result = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(result).toEqual({ valid: true });
  });

  it('detects a payload altered behind the application', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, event('a'));
      await recordEvent(tx, event('b'));
      await recordEvent(tx, event('c'));
    });

    // Tampering as a superuser, which is what this defence is actually for:
    // an attacker with database access, not the application misbehaving.
    await asDatabaseSuperuser(
      `ALTER TABLE "AuditEvent" DISABLE RULE audit_no_update`,
    );
    await asDatabaseSuperuser(
      `UPDATE "AuditEvent" SET payload = '{"note":"tampered"}'::jsonb
       WHERE "tenantId" = $1::uuid AND sequence = 2`,
      [tenantId],
    );
    await asDatabaseSuperuser(
      `ALTER TABLE "AuditEvent" ENABLE RULE audit_no_update`,
    );

    const result = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(result).toEqual({ valid: false, brokenAtSequence: 2 });
  });

  it('detects a deleted event by the broken link that follows it', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, event('a'));
      await recordEvent(tx, event('b'));
      await recordEvent(tx, event('c'));
    });

    await asDatabaseSuperuser(
      `ALTER TABLE "AuditEvent" DISABLE RULE audit_no_delete`,
    );
    await asDatabaseSuperuser(
      `DELETE FROM "AuditEvent"
       WHERE "tenantId" = $1::uuid AND sequence = 2`,
      [tenantId],
    );
    await asDatabaseSuperuser(
      `ALTER TABLE "AuditEvent" ENABLE RULE audit_no_delete`,
    );

    const result = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(result).toEqual({ valid: false, brokenAtSequence: 3 });
  });
});

describe('append-only rules', () => {
  it('silently discards an ordinary update', async () => {
    const e = await withTenant(tenantId, (tx) => recordEvent(tx, event('a')));
    await withTenant(tenantId, (tx) =>
      tx.auditEvent.updateMany({
        where: { id: e.id },
        data: { action: 'changed' },
      }),
    );
    const after = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findUnique({ where: { id: e.id } }),
    );
    expect(after!.action).toBe('a');
  });

  it('silently discards an ordinary delete', async () => {
    const e = await withTenant(tenantId, (tx) => recordEvent(tx, event('a')));
    await withTenant(tenantId, (tx) =>
      tx.auditEvent.deleteMany({ where: { id: e.id } }),
    );
    const after = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findUnique({ where: { id: e.id } }),
    );
    expect(after).not.toBeNull();
  });
});
