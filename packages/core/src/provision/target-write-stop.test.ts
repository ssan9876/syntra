import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { verifyChain } from '../audit/audit-service.js';
import {
  pauseTargetExternalWrites,
  resumeTargetExternalWrites,
  TargetWriteStopSeparationError,
} from './target-write-stop.js';

let tenantId: string; let targetId: string; let first: string; let second: string;
const now = new Date('2026-09-23T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  await withTenant(tenantId, async (tx) => {
    first = (await createUser(tx, { login: 'first', email: 'first@acme.test', displayName: 'First' })).id;
    second = (await createUser(tx, { login: 'second', email: 'second@acme.test', displayName: 'Second' })).id;
    targetId = (await tx.targetSystem.create({ data: { tenantId, name: 'AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 's' } })).id;
  });
});

describe('target external-write stop', () => {
  it('requires a different administrator to resume and audits both decisions', async () => {
    await pauseTargetExternalWrites(tenantId, targetId, first, 'Contain connector incident', new Date(now.getTime() + 60_000), now);
    await expect(resumeTargetExternalWrites(tenantId, targetId, first, 'Looks fixed', now)).rejects.toBeInstanceOf(TargetWriteStopSeparationError);
    const resumed = await resumeTargetExternalWrites(tenantId, targetId, second, 'Credential rotated and tested', now);
    expect(resumed).toMatchObject({ externalWritesPausedAt: null, externalWritesResumedByUserId: second });
    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } }));
    expect(events.map((event) => event.action)).toEqual([
      'provision.target.external_writes.pause', 'provision.target.external_writes.resume',
    ]);
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });
});
