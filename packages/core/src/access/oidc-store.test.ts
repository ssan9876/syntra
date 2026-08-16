import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  artifactConsume,
  artifactDestroy,
  artifactFind,
  artifactFindByUid,
  artifactRevokeByGrantId,
  artifactUpsert,
} from './oidc-store.js';

let tenantId: string;
let otherTenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
});

describe('oidc artifact store', () => {
  it('round-trips a payload', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'tok1', { accountId: 'u1', scope: 'openid' }, 3600);
    const found = await artifactFind(tenantId, 'AccessToken', 'tok1');
    expect(found?.payload).toMatchObject({ accountId: 'u1', scope: 'openid' });
  });

  it('finds a session by its uid', async () => {
    await artifactUpsert(tenantId, 'Session', 's1', { uid: 'u-abc', accountId: 'u1' }, 3600);
    const found = await artifactFindByUid(tenantId, 'Session', 'u-abc');
    expect(found?.payload).toMatchObject({ accountId: 'u1' });
  });

  it('returns null for an expired artifact rather than a stale payload', async () => {
    await artifactUpsert(tenantId, 'AuthorizationCode', 'c1', { accountId: 'u1' }, -1);
    expect(await artifactFind(tenantId, 'AuthorizationCode', 'c1')).toBeNull();
  });

  it('records consumption without destroying the row, so a replayed code is detectable', async () => {
    await artifactUpsert(tenantId, 'AuthorizationCode', 'c2', { accountId: 'u1' }, 600);
    await artifactConsume(tenantId, 'AuthorizationCode', 'c2');
    const found = await artifactFind(tenantId, 'AuthorizationCode', 'c2');
    // oidc-provider reads `consumed` off the payload it gets back and refuses
    // the second exchange itself. Deleting the row here would make a replayed
    // code look merely unknown, and the replay would go unlogged.
    expect(found).not.toBeNull();
    expect(found!.consumedAt).not.toBeNull();
  });

  it('destroys a single artifact', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'tok2', {}, 3600);
    await artifactDestroy(tenantId, 'AccessToken', 'tok2');
    expect(await artifactFind(tenantId, 'AccessToken', 'tok2')).toBeNull();
  });

  it('revokes every artifact of a grant at once', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'a', { grantId: 'g1' }, 3600);
    await artifactUpsert(tenantId, 'RefreshToken', 'r', { grantId: 'g1' }, 3600);
    await artifactUpsert(tenantId, 'AccessToken', 'b', { grantId: 'g2' }, 3600);
    await artifactRevokeByGrantId(tenantId, 'g1');
    expect(await artifactFind(tenantId, 'AccessToken', 'a')).toBeNull();
    expect(await artifactFind(tenantId, 'RefreshToken', 'r')).toBeNull();
    expect(await artifactFind(tenantId, 'AccessToken', 'b')).not.toBeNull();
  });

  it('cannot see another tenant artifact under the same id', async () => {
    await artifactUpsert(tenantId, 'AccessToken', 'shared-id', { accountId: 'acme-user' }, 3600);
    await artifactUpsert(otherTenantId, 'AccessToken', 'shared-id', { accountId: 'beta-user' }, 3600);
    // Identical artifact ids in two tenants. A store that keyed on id alone
    // would hand one tenant the other's token.
    expect((await artifactFind(tenantId, 'AccessToken', 'shared-id'))!.payload)
      .toMatchObject({ accountId: 'acme-user' });
    expect((await artifactFind(otherTenantId, 'AccessToken', 'shared-id'))!.payload)
      .toMatchObject({ accountId: 'beta-user' });
  });
});
