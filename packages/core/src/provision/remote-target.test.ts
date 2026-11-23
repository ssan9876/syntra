import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase, verifyTestEmailDomains } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { correlationAttributeFor } from './observed-key.js';
import {
  LadderConfigurationError,
  createTarget,
  targetWithCredential,
  testTargetConfiguration,
  updateTarget,
} from './target-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const SECRET = 'remote-shared-secret-0123456789abcdef';
let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  await verifyTestEmailDomains(t.id);
  tenantId = t.id;
});

const createRemote = (overrides: { config?: Record<string, unknown>; bindPassword?: string } = {}) =>
  createTarget(tenantId, provider, null, {
    type: 'remote',
    name: 'HR system',
    config: overrides.config ?? { baseUrl: 'https://hr.acme.test/syntra' },
    bindPassword: overrides.bindPassword ?? SECRET,
  });

describe('connector service targets', () => {
  it('saves one with its defaults and hands the connector the shared secret', async () => {
    const { id } = await createRemote();
    const row = await withTenant(tenantId, (tx) => tx.targetSystem.findUniqueOrThrow({ where: { id } }));
    expect(row.type).toBe('remote');
    expect(row.config).toEqual({
      baseUrl: 'https://hr.acme.test/syntra',
      placesAccountsInContainers: false,
      pageSize: 200,
      timeoutMs: 30_000,
      allowPrivateAddresses: false,
    });
    expect(row.deleteAfterDays).toBeNull();
    const merged = await withTenant(tenantId, (tx) => targetWithCredential(tx, provider, id));
    expect(merged?.bindPassword).toBe(SECRET);
  });

  it('is refused by the database without https', async () => {
    await expect(createRemote({ config: { baseUrl: 'http://hr.acme.test/syntra' } })).rejects.toThrow(
      /target_system_encrypted_transport/,
    );
  });

  it('refuses a shared secret shorter than 32 characters, on create and on update', async () => {
    await expect(createRemote({ bindPassword: 'too-short' })).rejects.toMatchObject({
      code: 'short-shared-secret',
      field: 'bindPassword',
      message: 'Shared secret is shorter than 32 characters.',
    });
    const { id } = await createRemote();
    await expect(updateTarget(tenantId, provider, null, id, { bindPassword: 'too-short' })).rejects.toBeInstanceOf(
      LadderConfigurationError,
    );
  });

  it('lends its secret to a connection test only for the same service URL', async () => {
    const { id } = await createRemote();
    const elsewhere = await testTargetConfiguration(tenantId, provider, {
      type: 'remote',
      config: { baseUrl: 'https://attacker.example/syntra' },
      borrowFromTargetId: id,
    });
    expect(elsewhere).toEqual({
      ok: false,
      message: 'a saved credential can only be reused by a target of the same type and transport',
    });
    const same = await testTargetConfiguration(tenantId, provider, {
      type: 'remote',
      config: { baseUrl: 'https://hr.acme.test/syntra/' },
      borrowFromTargetId: id,
    });
    // Borrowed, so the test reached the network (and found no such host).
    expect(same.ok).toBe(false);
    expect(same.message).not.toMatch(/saved credential/);
  });

  it('correlates on the login the service reports as a typed field', () => {
    expect(correlationAttributeFor('remote', {})).toBe('correlationKey');
  });
});
