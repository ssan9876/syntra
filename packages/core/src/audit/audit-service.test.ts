import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  asDatabaseSuperuser,
  resetDatabase,
} from '@syntra/db/src/test-support.js';
import { listEvents, recordEvent, verifyChain } from './audit-service.js';

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

describe('listEvents', () => {
  /**
   * The per-subject log behind an account's or a person's screen.
   *
   * Both directions are asked for at once because both answer the same
   * question. "What happened to this account" without "what this account did"
   * shows an administrator being locked out and hides the administrator doing
   * the locking, and the two are the same investigation.
   */
  const about = (
    action: string,
    parts: { targetId?: string; actorUserId?: string },
  ) => ({
    ...event(action),
    targetId: parts.targetId ?? null,
    actorUserId: parts.actorUserId ?? null,
  });

  const SUBJECT = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  it('returns events the subject was the target of and the actor of', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, about('user.update', { targetId: SUBJECT }));
      await recordEvent(tx, about('user.unlock', { actorUserId: SUBJECT }));
      await recordEvent(tx, about('user.delete', { targetId: OTHER }));
    });

    const events = await withTenant(tenantId, (tx) =>
      listEvents(tx, { subjectIds: [SUBJECT] }),
    );

    expect(events.map((e) => e.action)).toEqual(['user.unlock', 'user.update']);
  });

  it('takes several subjects, so a person can ask about their accounts too', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, about('person.update', { targetId: SUBJECT }));
      await recordEvent(tx, about('user.create', { targetId: OTHER }));
      await recordEvent(tx, about('unrelated', {}));
    });

    const events = await withTenant(tenantId, (tx) =>
      listEvents(tx, { subjectIds: [SUBJECT, OTHER] }),
    );

    expect(events.map((e) => e.action)).toEqual(['user.create', 'person.update']);
  });

  it('is unfiltered when no subject is named', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, about('a', { targetId: SUBJECT }));
      await recordEvent(tx, about('b', {}));
    });

    const events = await withTenant(tenantId, (tx) => listEvents(tx, {}));
    expect(events).toHaveLength(2);
  });

  /**
   * An empty array is not "no filter". It is what a person with no linked
   * accounts and no id would produce, and answering it with the whole tenant's
   * log would put every other account's history on their screen.
   */
  it('returns nothing when the subject list is empty', async () => {
    await withTenant(tenantId, (tx) => recordEvent(tx, about('a', {})));

    const events = await withTenant(tenantId, (tx) =>
      listEvents(tx, { subjectIds: [] }),
    );
    expect(events).toEqual([]);
  });

  it('pages a filtered log with `before`', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, about('first', { targetId: SUBJECT }));
      await recordEvent(tx, about('second', { targetId: SUBJECT }));
    });

    const events = await withTenant(tenantId, (tx) =>
      listEvents(tx, { subjectIds: [SUBJECT], before: 2 }),
    );
    expect(events.map((e) => e.action)).toEqual(['first']);
  });
});

describe('the security fan-out', () => {
  /** An endpoint subscribed to the given groups or actions. */
  const seedEndpoint = async (events: string[]) =>
    withTenant(tenantId, (tx) =>
      tx.webhookEndpoint.create({
        data: {
          tenantId,
          name: 'SIEM',
          url: 'https://siem.example.test/in',
          enabled: true,
          events,
        },
      }),
    );

  const lockout = {
    actorUserId: null,
    action: 'auth.lockout',
    targetType: 'User',
    targetId: '11111111-2222-4333-8444-555555555555',
    outcome: 'failure' as const,
    sourceIp: '198.51.100.9',
    payload: { secretish: 'do-not-forward-me', failedCount: 5 },
  };

  it('writes a delivery for an endpoint that asked for it', async () => {
    await seedEndpoint(['sign-in-security']);

    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    const rows = await withTenant(tenantId, (tx) => tx.webhookDelivery.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe('auth.lockout');
  });

  it('never puts the audit payload or the address on the wire', async () => {
    // THE security property, asserted over the delivery body rather than over
    // the projection -- what matters is what actually leaves the building.
    await seedEndpoint(['sign-in-security']);

    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    const row = await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.findFirstOrThrow(),
    );
    const body = JSON.stringify(row.payload);
    expect(body).not.toContain('do-not-forward-me');
    expect(body).not.toContain('failedCount');
    expect(body).not.toContain('198.51.100.9');
    // And it does carry what a receiver needs to go and read the row.
    expect(body).toContain('auth.lockout');
    expect(body).toContain('"sequence"');
  });

  it('carries the sequence the audit row actually got', async () => {
    await seedEndpoint(['sign-in-security']);

    const audit = await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    const row = await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.findFirstOrThrow(),
    );
    expect(JSON.stringify(row.payload)).toContain(`"sequence":${audit.sequence}`);
  });

  it('does not fan out ordinary traffic', async () => {
    await seedEndpoint(['sign-in-security']);

    await withTenant(tenantId, (tx) => recordEvent(tx, event('application.launch')));

    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('does not deliver a security event to an Automate subscriber', async () => {
    await seedEndpoint(['access-requests']);

    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('delivers to an endpoint that named the one action', async () => {
    await seedEndpoint(['auth.lockout']);

    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(1);
  });

  it('writes nothing for a tenant with no endpoints', async () => {
    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('leaves the chain intact', async () => {
    // The fan-out runs inside the same transaction as the append. If it could
    // disturb the sequence or the hash, this is where that shows.
    await seedEndpoint(['sign-in-security']);

    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));
    await withTenant(tenantId, (tx) => recordEvent(tx, event('user.create')));
    await withTenant(tenantId, (tx) => recordEvent(tx, lockout));

    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toEqual({ valid: true });
  });
});
