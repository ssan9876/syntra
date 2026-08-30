import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  API_TOKEN_PREFIX,
  hashApiToken,
  issueApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken,
  touchApiToken,
} from './api-token-service.js';

let tenantId: string;
let userId: string;

const issue = (over: Partial<Parameters<typeof issueApiToken>[1]> = {}) =>
  withTenant(tenantId, (tx) =>
    issueApiToken(tx, {
      userId,
      name: 'SCIM from Workday',
      scopes: [],
      expiresAt: null,
      createdBy: null,
      ...over,
    }),
  );

const readRow = () => withTenant(tenantId, (tx) => tx.apiToken.findFirstOrThrow());

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'scim', email: 'scim@acme.test', displayName: 'SCIM' }),
  );
  userId = user.id;
});

describe('issueApiToken', () => {
  it('returns a prefixed token and stores only a digest', async () => {
    const issued = await issue();

    expect(issued.token.startsWith(API_TOKEN_PREFIX)).toBe(true);

    const row = await readRow();
    // The value must not be recoverable from the row by any route.
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row.tokenHash).toBe(hashApiToken(issued.token));
  });

  it('mints a different token every time', async () => {
    const a = await issue();
    const b = await issue();
    expect(a.token).not.toBe(b.token);
  });

  it('carries enough entropy to be worth storing as a digest', async () => {
    // 32 bytes, base64url, after the prefix.
    const issued = await issue();
    expect(issued.token.slice(API_TOKEN_PREFIX.length).length).toBeGreaterThanOrEqual(43);
  });
});

describe('resolveApiToken', () => {
  it('resolves a live token to its account and scopes', async () => {
    const issued = await issue({ scopes: ['directory.read'] });

    const resolved = await withTenant(tenantId, (tx) => resolveApiToken(tx, issued.token));

    expect(resolved).toMatchObject({ userId, scopes: ['directory.read'] });
  });

  it('does not resolve a revoked token', async () => {
    const issued = await issue();
    await withTenant(tenantId, (tx) => revokeApiToken(tx, issued.id));

    expect(await withTenant(tenantId, (tx) => resolveApiToken(tx, issued.token))).toBeNull();
  });

  it('does not resolve an expired token', async () => {
    const issued = await issue({ expiresAt: new Date(Date.now() - 1000) });

    expect(await withTenant(tenantId, (tx) => resolveApiToken(tx, issued.token))).toBeNull();
  });

  it('resolves a token whose expiry is still ahead', async () => {
    const issued = await issue({ expiresAt: new Date(Date.now() + 3_600_000) });

    expect(await withTenant(tenantId, (tx) => resolveApiToken(tx, issued.token))).not.toBeNull();
  });

  it('does not resolve an unknown token', async () => {
    expect(
      await withTenant(tenantId, (tx) => resolveApiToken(tx, `${API_TOKEN_PREFIX}nope`)),
    ).toBeNull();
  });

  it('does not resolve a value without the prefix', async () => {
    // Not this product's credential, and hashing it to find out is work done
    // on behalf of whoever sent it.
    const issued = await issue();
    const unprefixed = issued.token.slice(API_TOKEN_PREFIX.length);

    expect(await withTenant(tenantId, (tx) => resolveApiToken(tx, unprefixed))).toBeNull();
  });

  it('refuses every failure the same way', async () => {
    // A caller learns the credential did not work, never which of the four it
    // was. The audit log records the distinction; the answer does not.
    const revoked = await issue();
    await withTenant(tenantId, (tx) => revokeApiToken(tx, revoked.id));
    const expired = await issue({ expiresAt: new Date(Date.now() - 1000) });

    const answers = await withTenant(tenantId, async (tx) => [
      await resolveApiToken(tx, revoked.token),
      await resolveApiToken(tx, expired.token),
      await resolveApiToken(tx, `${API_TOKEN_PREFIX}unknown`),
      await resolveApiToken(tx, 'not-even-a-syntra-token'),
    ]);

    expect(answers).toEqual([null, null, null, null]);
  });

  it('does not resolve a token from another tenant', async () => {
    const issued = await issue();
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });

    // No `where` on tenant anywhere: row-level security is what is being
    // asserted, not an application filter.
    expect(await withTenant(other.id, (tx) => resolveApiToken(tx, issued.token))).toBeNull();
  });
});

describe('touchApiToken', () => {
  it('records first use', async () => {
    const issued = await issue();
    expect((await readRow()).lastUsedAt).toBeNull();

    await withTenant(tenantId, (tx) => touchApiToken(tx, issued.id));

    expect((await readRow()).lastUsedAt).not.toBeNull();
  });

  it('does not write again within the minute', async () => {
    // A busy integration would otherwise turn every read into a write.
    const issued = await issue();
    await withTenant(tenantId, (tx) => touchApiToken(tx, issued.id));
    const first = (await readRow()).lastUsedAt;

    await withTenant(tenantId, (tx) => touchApiToken(tx, issued.id));

    expect((await readRow()).lastUsedAt).toEqual(first);
  });

  it('writes again once the minute has passed', async () => {
    const issued = await issue();
    await withTenant(tenantId, (tx) => touchApiToken(tx, issued.id));
    const first = (await readRow()).lastUsedAt!;

    await withTenant(tenantId, (tx) =>
      touchApiToken(tx, issued.id, new Date(first.getTime() + 61_000)),
    );

    expect((await readRow()).lastUsedAt!.getTime()).toBeGreaterThan(first.getTime());
  });
});

describe('listApiTokens', () => {
  it('never returns the digest', async () => {
    await issue();

    const [view] = await withTenant(tenantId, (tx) => listApiTokens(tx, userId));

    expect(JSON.stringify(view)).not.toContain('tokenHash');
    expect(view).not.toHaveProperty('tokenHash');
  });

  it('omits a revoked token', async () => {
    const issued = await issue();
    await withTenant(tenantId, (tx) => revokeApiToken(tx, issued.id));

    expect(await withTenant(tenantId, (tx) => listApiTokens(tx, userId))).toEqual([]);
  });
});

describe('revokeApiToken', () => {
  it('answers false for a token already revoked', async () => {
    const issued = await issue();

    expect(await withTenant(tenantId, (tx) => revokeApiToken(tx, issued.id))).toBe(true);
    expect(await withTenant(tenantId, (tx) => revokeApiToken(tx, issued.id))).toBe(false);
  });
});
