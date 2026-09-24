import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  awsKmsProvider,
  fallbackMasterKeyProvider,
  getSecret,
  localMasterKeyProvider,
  parseKeyManagement,
  putSecret,
} from '@syntra/core';
import { fakeKms } from '@syntra/core/testing/fake-kms';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';
import { rekeyAllTenants, rekeyProviders, vaultInventory } from './rekey-core.js';

const oldKey = localMasterKeyProvider(Buffer.alloc(32, 4));
let acme: string;
let globex: string;

beforeEach(async () => {
  await resetDatabase();
  acme = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  globex = (await prisma.tenant.create({ data: { name: 'Globex', slug: 'globex' } })).id;
  await withTenant(acme, async (tx) => {
    await putSecret(tx, oldKey, 'a', 'acme-a');
    await putSecret(tx, oldKey, 'b', 'acme-b');
  });
  await withTenant(globex, (tx) => putSecret(tx, oldKey, 'a', 'globex-a'));
});

describe('rekeyAllTenants', () => {
  it('moves every tenant from the local key to KMS, audits it, and the inventory proves it', async () => {
    const kms = fakeKms();
    const arn = kms.createKey();
    const aws = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });

    const result = await rekeyAllTenants({ current: fallbackMasterKeyProvider(aws, [oldKey]), next: aws });
    expect(result.total).toBe(3);
    expect(result.tenants.map((t) => [t.slug, t.rewrapped])).toEqual([['acme', 2], ['globex', 1]]);

    expect(await vaultInventory()).toEqual([
      { tenantId: acme, slug: 'acme', keys: { [`aws-kms:${arn}`]: 2 } },
      { tenantId: globex, slug: 'globex', keys: { [`aws-kms:${arn}`]: 1 } },
    ]);
    expect(await withTenant(acme, (tx) => getSecret(tx, aws, 'b'))).toBe('acme-b');
    expect(await withTenant(globex, (tx) => getSecret(tx, aws, 'a'))).toBe('globex-a');

    const event = await withTenant(acme, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'vault.data_keys_rewrapped' } }),
    );
    expect(event.actorUserId).toBeNull();
    expect(event.payload).toEqual({
      provider: 'aws-kms',
      rewrapped: 2,
      before: { local: 2 },
      after: { [`aws-kms:${arn}`]: 2 },
    });
    // The audit record carries labels and counts -- never a key.
    expect(JSON.stringify(event.payload)).not.toMatch(/[A-Za-z0-9+/]{43}=/);
  });

  it('touches nothing when the new provider cannot answer', async () => {
    const kms = fakeKms();
    const arn = kms.createKey();
    const aws = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });
    kms.outage = true;

    await expect(rekeyAllTenants({ current: fallbackMasterKeyProvider(aws, [oldKey]), next: aws })).rejects.toThrow(/TimeoutError/);
    expect((await vaultInventory()).map((t) => t.keys)).toEqual([{ local: 2 }, { local: 1 }]);
  });

  it('rolls back only the tenant that failed, and a second run finishes the job', async () => {
    const kms = fakeKms();
    const arn = kms.createKey();
    const aws = awsKmsProvider({ keyId: arn, bindTenant: true, timeoutMs: 1000, client: kms });
    // Globex holds a row no configured key can read.
    await withTenant(globex, (tx) => putSecret(tx, localMasterKeyProvider(Buffer.alloc(32, 99)), 'orphan', 'x'));

    await expect(rekeyAllTenants({ current: fallbackMasterKeyProvider(aws, [oldKey]), next: aws })).rejects.toThrow();
    expect((await vaultInventory()).map((t) => t.keys)).toEqual([{ [`aws-kms:${arn}`]: 2 }, { local: 2 }]);

    await withTenant(globex, (tx) => tx.secret.deleteMany({ where: { name: 'orphan' } }));
    const again = await rekeyAllTenants({ current: fallbackMasterKeyProvider(aws, [oldKey]), next: aws });
    expect(again.total).toBe(3);
    expect((await vaultInventory()).map((t) => t.keys)).toEqual([{ [`aws-kms:${arn}`]: 2 }, { [`aws-kms:${arn}`]: 1 }]);
  });

  it('rotates a local key using the configuration an operator writes: MASTER_KEY plus MASTER_KEY_PREVIOUS', async () => {
    const newKey = randomBytes(32);
    const km = parseKeyManagement({
      MASTER_KEY: newKey.toString('base64'),
      MASTER_KEY_PREVIOUS: Buffer.alloc(32, 4).toString('base64'),
    });
    await rekeyAllTenants(rekeyProviders(km));

    const fresh = localMasterKeyProvider(newKey);
    expect(await withTenant(acme, (tx) => getSecret(tx, fresh, 'a'))).toBe('acme-a');
    await expect(withTenant(acme, (tx) => getSecret(tx, oldKey, 'a'))).rejects.toThrow();
  });
});
