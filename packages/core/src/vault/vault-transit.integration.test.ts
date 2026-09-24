import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { rekeyAllTenants, rekeyProviders, vaultInventory } from '@syntra/db/src/rekey-core.js';
import { createMasterKeyProvider, parseKeyManagement } from './key-management.js';
import { describeWrappedKey, localMasterKeyProvider } from './master-key.js';
import { getSecret, putSecret } from './vault-service.js';
import { vaultTransitProvider } from './vault-transit.js';

/**
 * The Transit provider against a REAL Vault (or OpenBao) dev server.
 *
 *   pnpm vault:up && pnpm vault:wait && SYNTRA_TEST_WORKERS=2 pnpm vitest run \
 *     packages/core/src/vault/vault-transit.integration.test.ts
 *
 * Skipped when nothing answers on VAULT_ADDR, so `pnpm test` stays hermetic
 * on a machine without the container. With VAULT_TRANSIT_INTEGRATION=1 --
 * which CI sets after starting the container -- an unreachable server is a
 * FAILURE instead: a suite that quietly skips in CI reads as a suite that
 * passed.
 *
 * What only a real server can show, and so what this file is for: that the
 * tenant AAD is actually authenticated by Transit (a unit test can only show
 * that we send it), that key versions and `min_decryption_version` behave as
 * the runbook says, that a least-privilege AppRole policy is enough, and that
 * a revoked token is refused.
 *
 * Everything it needs beyond the dev server's root token -- a Transit mount,
 * its key, an AppRole, a policy -- it creates under names unique to the run.
 */
const address = process.env.VAULT_ADDR ?? 'http://127.0.0.1:8200';
const rootToken = process.env.VAULT_DEV_ROOT_TOKEN ?? 'syntra-dev-root';
const required = process.env.VAULT_TRANSIT_INTEGRATION === '1';

const reachable = await fetch(`${address}/v1/sys/health`, { signal: AbortSignal.timeout(1500) }).then(
  (r) => r.ok,
  () => false,
);
if (required && !reachable) {
  throw new Error(`VAULT_TRANSIT_INTEGRATION=1 but no unsealed Vault answers at ${address}`);
}

const run = randomBytes(4).toString('hex');
const mount = `transit-it-${run}`;
const approleMount = `approle-it-${run}`;
const tenantA = { tenantId: '11111111-1111-4111-8111-111111111111' };
const tenantB = { tenantId: '22222222-2222-4222-8222-222222222222' };

async function vault(method: string, path: string, body?: unknown, token = rootToken): Promise<Record<string, unknown>> {
  const response = await fetch(`${address}/v1/${path}`, {
    method,
    headers: { 'x-vault-token': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const withToken = (token: string, keyName = 'syntra') =>
  vaultTransitProvider({ address, keyName, mountPath: mount, auth: { method: 'token', token }, timeoutMs: 5000 });

describe.skipIf(!reachable)('vault-transit against a real Vault', () => {
  let roleId = '';
  let secretId = '';

  beforeAll(async () => {
    await vault('POST', `sys/mounts/${mount}`, { type: 'transit' });
    await vault('POST', `${mount}/keys/syntra`, {});
    await vault('POST', `${mount}/keys/other`, {});
    // The policy the configure docs recommend: encrypt and decrypt on ONE
    // key, nothing else -- not read, not rotate, not the other key.
    await vault('PUT', `sys/policies/acl/syntra-it-${run}`, {
      policy: `path "${mount}/encrypt/syntra" { capabilities = ["update"] }\npath "${mount}/decrypt/syntra" { capabilities = ["update"] }`,
    });
    await vault('POST', `sys/auth/${approleMount}`, { type: 'approle' });
    await vault('POST', `auth/${approleMount}/role/syntra`, { token_policies: [`syntra-it-${run}`], token_ttl: '10m' });
    roleId = String(((await vault('GET', `auth/${approleMount}/role/syntra/role-id`)).data as { role_id: string }).role_id);
    secretId = String(((await vault('POST', `auth/${approleMount}/role/syntra/secret-id`, {})).data as { secret_id: string }).secret_id);
  });

  it('round-trips a data key and passes check()', async () => {
    const provider = withToken(rootToken);
    const dek = randomBytes(32);
    const wrapped = await provider.wrap(dek, tenantA);
    expect(wrapped.ciphertext.toString('utf8')).toMatch(/^vault:v1:/);
    expect((await provider.unwrap(wrapped, tenantA)).equals(dek)).toBe(true);
    await expect(provider.check()).resolves.toBeUndefined();
  });

  it('really authenticates the tenant AAD: another tenant cannot unwrap the key', async () => {
    const provider = withToken(rootToken);
    const wrapped = await provider.wrap(randomBytes(32), tenantA);
    await expect(provider.unwrap(wrapped, tenantB)).rejects.toThrow(/HTTP 400/);
  });

  it('works with a least-privilege AppRole, and that role can use no other key', async () => {
    const auth = { method: 'approle' as const, roleId, secretId, mountPath: approleMount };
    const provider = vaultTransitProvider({ address, keyName: 'syntra', mountPath: mount, auth, timeoutMs: 5000 });
    await expect(provider.check()).resolves.toBeUndefined();

    const other = vaultTransitProvider({ address, keyName: 'other', mountPath: mount, auth, timeoutMs: 5000 });
    await expect(other.check()).rejects.toThrow(/HTTP 403: .*permission denied/);
  });

  it('refuses a revoked token -- revocation takes effect on the next call', async () => {
    const created = await vault('POST', 'auth/token/create', { policies: [`syntra-it-${run}`], ttl: '10m' });
    const token = String((created.auth as { client_token: string }).client_token);
    const provider = withToken(token);
    const wrapped = await provider.wrap(randomBytes(32), tenantA);

    await vault('POST', 'auth/token/revoke', { token });
    await expect(provider.unwrap(wrapped, tenantA)).rejects.toThrow(/HTTP 403/);
    await expect(provider.check()).rejects.toThrow(/HTTP 403/);
  });

  it('follows key versions: rotate, rekey to the latest, then retire the old version', async () => {
    await vault('POST', `sys/mounts/${mount}-v`, { type: 'transit' });
    const provider = vaultTransitProvider({
      address, keyName: 'versioned', mountPath: `${mount}-v`, auth: { method: 'token', token: rootToken }, timeoutMs: 5000,
    });
    await vault('POST', `${mount}-v/keys/versioned`, {});

    const dek = randomBytes(32);
    const v1 = await provider.wrap(dek, tenantA);
    expect(describeWrappedKey(v1)).toBe('vault-transit:versioned:v1');

    await vault('POST', `${mount}-v/keys/versioned/rotate`, {});
    const v2 = await provider.wrap(dek, tenantA);
    expect(describeWrappedKey(v2)).toBe('vault-transit:versioned:v2');
    // The old version still decrypts until it is retired.
    expect((await provider.unwrap(v1, tenantA)).equals(dek)).toBe(true);

    // Rekey with the same provider on both sides moves a v1 row to v2 --
    // exactly what `rewrapSecrets(tx, composite, primary)` does per row.
    const moved = await provider.wrap(await provider.unwrap(v1, tenantA), tenantA);
    expect(describeWrappedKey(moved)).toBe('vault-transit:versioned:v2');

    // Revocation of the old version.
    await vault('POST', `${mount}-v/keys/versioned/config`, { min_decryption_version: 2 });
    await expect(provider.unwrap(v1, tenantA)).rejects.toThrow(/HTTP 400/);
    expect((await provider.unwrap(moved, tenantA)).equals(dek)).toBe(true);
  });

  describe('the vault itself, configured the way an operator would', () => {
    const env = () => ({
      MASTER_KEY_PROVIDER: 'vault-transit',
      VAULT_ADDR: address,
      VAULT_TRANSIT_MOUNT: mount,
      VAULT_TRANSIT_KEY: 'syntra',
      VAULT_ROLE_ID: roleId,
      VAULT_SECRET_ID: secretId,
      VAULT_APPROLE_MOUNT: approleMount,
      MASTER_KEY: Buffer.alloc(32, 5).toString('base64'),
    });

    it('migrates local secrets into Transit with rekey, and the local key reads nothing afterwards', async () => {
      await resetDatabase();
      const tenant = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
      const local = localMasterKeyProvider(Buffer.alloc(32, 5));
      await withTenant(tenant, async (tx) => {
        await putSecret(tx, local, 'ldap.bindPassword', 'hunter2');
        await putSecret(tx, local, 'webhook.secret', 'whsec');
      });

      const km = parseKeyManagement(env());
      // During the window, the API's provider already writes to Transit and
      // still reads the local rows.
      const api = createMasterKeyProvider(km);
      await withTenant(tenant, (tx) => putSecret(tx, api, 'scim.token', 'scim'));
      expect(await withTenant(tenant, (tx) => getSecret(tx, api, 'ldap.bindPassword'))).toBe('hunter2');

      const result = await rekeyAllTenants(rekeyProviders(km));
      expect(result.total).toBe(3);
      expect((await vaultInventory())[0]!.keys).toEqual({ 'vault-transit:syntra:v1': 3 });

      // With MASTER_KEY removed, Transit alone reads everything.
      const { MASTER_KEY: _removed, ...withoutLocal } = env();
      const after = createMasterKeyProvider(parseKeyManagement(withoutLocal));
      expect(await withTenant(tenant, (tx) => getSecret(tx, after, 'ldap.bindPassword'))).toBe('hunter2');
      expect(await withTenant(tenant, (tx) => getSecret(tx, after, 'webhook.secret'))).toBe('whsec');
      expect(await withTenant(tenant, (tx) => getSecret(tx, after, 'scim.token'))).toBe('scim');
      await expect(withTenant(tenant, (tx) => getSecret(tx, local, 'ldap.bindPassword'))).rejects.toThrow(/not by the local MASTER_KEY/);
    });
  });
});
