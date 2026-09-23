import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { entraIdDocument } from '@syntra/connectors';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import { createTarget, updateTarget } from './target-service.js';
import {
  applyDocumentEntraMigration,
  previewDocumentEntraMigration,
  TargetMigrationNotAvailableError,
  TargetMigrationPreviewStaleError,
} from './target-migration.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 23));
let tenantId: string;

const legacyDocument = () => {
  const document = structuredClone(entraIdDocument);
  if (document.auth.type !== 'oauth2') throw new Error('fixture must use OAuth');
  document.auth.tokenUrl = 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token';
  document.auth.clientId = '11111111-2222-3333-4444-555555555555';
  return document;
};

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
});

describe('document-driven Entra migration', () => {
  it('previews and applies in place while preserving the credential and writing an audit receipt', async () => {
    const { id } = await createTarget(tenantId, provider, null, {
      name: 'Legacy Entra',
      type: 'httpJson',
      config: { document: legacyDocument() },
      bindPassword: 'preserved-client-secret',
      schedule: '0 2 * * *',
    });

    const preview = await previewDocumentEntraMigration(tenantId, id);
    expect(preview).toMatchObject({
      targetId: id,
      from: { type: 'httpJson' },
      to: {
        type: 'entraId',
        config: {
          tenantId: 'contoso.onmicrosoft.com',
          clientId: '11111111-2222-3333-4444-555555555555',
        },
      },
      preserved: { targetId: true, credential: true, schedule: true },
    });
    expect(preview.revision).toMatch(/^[a-f0-9]{64}$/);

    await applyDocumentEntraMigration(tenantId, null, id, preview.revision);
    const evidence = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.findUniqueOrThrow({ where: { id } });
      const secret = await getSecret(tx, provider, target.secretName);
      const event = await tx.auditEvent.findFirstOrThrow({
        where: { action: 'provision.target.connector-migrate', targetId: id },
      });
      return { target, secret, event };
    });
    expect(evidence.target).toMatchObject({ id, type: 'entraId', schedule: '0 2 * * *' });
    expect(evidence.secret).toBe('preserved-client-secret');
    expect(evidence.event.payload).toMatchObject({
      revision: preview.revision,
      fromType: 'httpJson',
      toType: 'entraId',
    });
  });

  it('rejects a stale preview without changing the adapter', async () => {
    const { id } = await createTarget(tenantId, provider, null, {
      name: 'Legacy Entra',
      type: 'httpJson',
      config: { document: legacyDocument() },
      bindPassword: 'secret',
    });
    const preview = await previewDocumentEntraMigration(tenantId, id);
    await updateTarget(tenantId, provider, null, id, { name: 'Changed after preview' });

    await expect(
      applyDocumentEntraMigration(tenantId, null, id, preview.revision),
    ).rejects.toBeInstanceOf(TargetMigrationPreviewStaleError);
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id } }),
    );
    expect(target.type).toBe('httpJson');
  });

  it('refuses a non-Entra HTTP target', async () => {
    const document = legacyDocument();
    document.baseUrl = 'https://api.example.com/v1';
    const { id } = await createTarget(tenantId, provider, null, {
      name: 'Other API',
      type: 'httpJson',
      config: { document },
      bindPassword: 'secret',
    });
    await expect(previewDocumentEntraMigration(tenantId, id)).rejects.toBeInstanceOf(
      TargetMigrationNotAvailableError,
    );
  });
});
