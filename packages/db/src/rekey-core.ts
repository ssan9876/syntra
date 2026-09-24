/**
 * The testable half of `rekey.ts`: move every tenant's data keys to the
 * master-key provider a deployment is configured to wrap with.
 *
 * This is the operator-run maintenance wrapper around `rewrapSecrets` that
 * the master-key recovery runbook used to say did not exist. It stays OFF the
 * web: it holds every key the deployment has ever used at once, and the only
 * place that is acceptable is a shell an operator opened on purpose.
 *
 * What it does, and why each step:
 *
 *  1. `check()` the NEW provider first. A rekey into a KMS that cannot answer
 *     would fail on the first row anyway; failing before any tenant is
 *     touched is the same outcome with nothing to explain.
 *  2. Per tenant, one transaction: unwrap every data key with the deployment's
 *     composite provider (the new provider plus every decrypt-only key still
 *     configured -- MASTER_KEY, MASTER_KEY_PREVIOUS, the previous Transit key
 *     or KMS key), wrap it with the new one, write it back, and record one
 *     `vault.data_keys_rewrapped` audit event with the before-and-after
 *     inventory. A failure rolls that tenant back whole; tenants already done
 *     stay done, and running it again is safe (see `rewrapSecrets`).
 *  3. Secret VALUES are never decrypted -- only their 32-byte data keys, and
 *     each is zeroed as soon as it is rewrapped.
 *
 * Nothing here logs a key. What is printed is counts per provider label
 * (`local`, `vault-transit:syntra:v2`, `aws-kms:arn:…`), which is what an
 * operator needs to decide the old key can be removed.
 */
import {
  fallbackMasterKeyProvider,
  providersFor,
  recordEvent,
  rewrapSecrets,
  wrappedKeyInventory,
  type KeyManagementConfig,
  type MasterKeyProvider,
} from '@syntra/core';
import { prisma } from './client.js';
import { TENANT_DELETED_STATUS, withTenant } from './with-tenant.js';

export interface TenantInventory {
  tenantId: string;
  slug: string;
  keys: Record<string, number>;
}

/** Every live tenant's wrapped-key inventory. Calls no KMS. */
export async function vaultInventory(): Promise<TenantInventory[]> {
  const tenants = await prisma.tenant.findMany({
    where: { status: { not: TENANT_DELETED_STATUS } },
    select: { id: true, slug: true },
    orderBy: { slug: 'asc' },
  });
  const out: TenantInventory[] = [];
  for (const tenant of tenants) {
    out.push({
      tenantId: tenant.id,
      slug: tenant.slug,
      keys: await withTenant(tenant.id, (tx) => wrappedKeyInventory(tx)),
    });
  }
  return out;
}

export interface RekeyResult {
  tenants: { slug: string; rewrapped: number; before: Record<string, number>; after: Record<string, number> }[];
  total: number;
}

/**
 * The providers `rekey` uses, from the same configuration the API boots with.
 * No unwrap cache: a one-off pass gains nothing from one, and every unwrap
 * should prove the key it names is still usable.
 */
export function rekeyProviders(km: KeyManagementConfig): { current: MasterKeyProvider; next: MasterKeyProvider } {
  const { primary, fallbacks } = providersFor(km);
  return { current: fallbackMasterKeyProvider(primary, fallbacks), next: primary };
}

export async function rekeyAllTenants(
  providers: { current: MasterKeyProvider; next: MasterKeyProvider },
  options: { timeoutMs?: number; onTenant?: (slug: string, rewrapped: number) => void } = {},
): Promise<RekeyResult> {
  await providers.next.check();

  const tenants = await prisma.tenant.findMany({
    where: { status: { not: TENANT_DELETED_STATUS } },
    select: { id: true, slug: true },
    orderBy: { slug: 'asc' },
  });

  const result: RekeyResult = { tenants: [], total: 0 };
  for (const tenant of tenants) {
    const entry = await withTenant(
      tenant.id,
      async (tx) => {
        const before = await wrappedKeyInventory(tx);
        const { rewrapped } = await rewrapSecrets(tx, providers.current, providers.next);
        const after = await wrappedKeyInventory(tx);
        if (rewrapped > 0) {
          // Syntra's half of the access record. The KMS logs every Encrypt and
          // Decrypt this pass made; the audit chain records that an operator
          // moved this tenant's keys, to which provider, and what was there
          // before -- the part a KMS log cannot know.
          await recordEvent(tx, {
            actorUserId: null,
            action: 'vault.data_keys_rewrapped',
            targetType: 'vault',
            targetId: null,
            outcome: 'success',
            sourceIp: null,
            payload: { provider: providers.next.name, rewrapped, before, after },
          });
        }
        return { slug: tenant.slug, rewrapped, before, after };
      },
      // A remote KMS is a round trip per key, twice. Prisma's default five
      // seconds is a few dozen secrets; a tenant has more than that.
      { timeoutMs: options.timeoutMs ?? 10 * 60_000 },
    );
    options.onTenant?.(entry.slug, entry.rewrapped);
    result.tenants.push(entry);
    result.total += entry.rewrapped;
  }
  return result;
}
