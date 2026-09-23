import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createHash } from 'node:crypto';
import { stableStringify } from '../audit/audit-service.js';
import { assessTenantOffboarding, createTenantDataExport } from './offboarding-service.js';

let tenantId: string;
let actorId: string;

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  actorId = await withTenant(tenantId, async (tx) => (await tx.user.create({
    data: { tenantId, login: 'owner', email: 'owner@acme.test', displayName: 'Owner' },
  })).id);
});

describe('assessTenantOffboarding', () => {
  it('creates a digest-bound audit receipt without reading secret material', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await tx.person.create({ data: { tenantId, givenName: 'Ada', familyName: 'Lovelace' } });
      await tx.contract.create({ data: { tenantId, personId: person.id, startDate: new Date('2026-01-01'), sequence: 1 } });
      await tx.secret.create({ data: { tenantId, name: 'connector', ciphertext: Buffer.from('ciphertext'), iv: Buffer.alloc(12), tag: Buffer.alloc(16), wrappedDek: Buffer.from('wrapped'), dekIv: Buffer.alloc(12), dekTag: Buffer.alloc(16) } });
    });

    const assessment = await assessTenantOffboarding(tenantId, actorId);

    expect(assessment.deletionReady).toBe(true);
    expect(assessment.inventory).toMatchObject({ people: 1, contracts: 1, secrets: 1 });
    expect(assessment.digest).toMatch(/^[a-f0-9]{64}$/);
    const event = await withTenant(tenantId, (tx) => tx.auditEvent.findUniqueOrThrow({ where: { id: assessment.receipt.auditEventId } }));
    expect(event.payload).toMatchObject({ digest: assessment.digest, inventory: { secrets: 1 } });
    expect(JSON.stringify(event.payload)).not.toContain('ciphertext');
  });

  it('refuses readiness while legal holds or unresolved operations exist', async () => {
    await withTenant(tenantId, async (tx) => {
      const operation = await tx.lifecycleOperation.create({
        data: { tenantId, kind: 'move', idempotencyKey: 'open', status: 'running', inputFingerprint: 'x', input: {} },
      });
      await tx.lifecycleLegalHold.create({
        data: { tenantId, subjectType: 'lifecycle_operation', subjectId: operation.id, reference: 'CASE-7', reason: 'Litigation hold', placedByUserId: actorId },
      });
    });

    const assessment = await assessTenantOffboarding(tenantId, actorId);

    expect(assessment.deletionReady).toBe(false);
    expect(assessment.blockers).toEqual({ activeLegalHolds: 1, unresolvedLifecycleOperations: 1 });
  });
});

describe('createTenantDataExport', () => {
  it('creates a deterministic portable artifact and a receipt without credential material', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.person.create({
        data: { tenantId, givenName: 'Grace', familyName: 'Hopper', personalEmail: 'grace@home.test' },
      });
      await tx.secret.create({
        data: { tenantId, name: 'connector', ciphertext: Buffer.from('never-export-this'), iv: Buffer.alloc(12), tag: Buffer.alloc(16), wrappedDek: Buffer.from('wrapped-key'), dekIv: Buffer.alloc(12), dekTag: Buffer.alloc(16) },
      });
    });

    const artifact = await createTenantDataExport(tenantId, actorId);
    const { digest, receipt: _receipt, ...document } = artifact;

    expect(artifact.schema).toBe('syntra.tenant-export.v1');
    expect(artifact.data.people).toHaveLength(1);
    expect(artifact.data.users).toHaveLength(1);
    expect(digest).toBe(createHash('sha256').update(stableStringify(document)).digest('hex'));
    expect(JSON.stringify(artifact)).not.toContain('never-export-this');
    expect(JSON.stringify(artifact)).not.toContain('wrapped-key');
    expect(artifact.exclusions).toContain('password hashes and password history');

    const event = await withTenant(tenantId, (tx) => tx.auditEvent.findUniqueOrThrow({
      where: { id: artifact.receipt.auditEventId },
    }));
    expect(event).toMatchObject({ action: 'tenant.offboarding.exported' });
    expect(event.payload).toMatchObject({ digest, recordCounts: { people: 1, users: 1 } });
  });
});
