/**
 * `pnpm --filter @syntra/db rekey` -- move every data key to the configured
 * master-key provider. Env-reading glue only; the logic is `rekey-core.ts`.
 *
 *   rekey --status   counts of data keys per provider and key version, per
 *                    tenant. Calls no KMS; safe at any time.
 *   rekey --yes      rewrap every tenant's data keys under the provider
 *                    MASTER_KEY_PROVIDER names, reading them with whichever
 *                    configured key recognises each one.
 *
 * Reads the SAME environment the API does (`.env`, or the release layout's
 * `shared/.env`), because the point is that the keys end up under exactly the
 * provider the API will read them with. See docs/operate.md (Runbooks),
 * "Procedure B", for the full migration and rotation sequences.
 */
import { keyManagementWarnings, parseKeyManagement } from '@syntra/core';
import { prisma } from './client.js';
import { rekeyAllTenants, rekeyProviders, vaultInventory } from './rekey-core.js';

const args = new Set(process.argv.slice(2));

let km;
try {
  km = parseKeyManagement(process.env);
} catch (cause) {
  console.error(`Invalid key-management configuration — ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}

const printInventory = async () => {
  for (const tenant of await vaultInventory()) {
    const parts = Object.entries(tenant.keys).map(([label, count]) => `${label}=${count}`);
    console.log(`  ${tenant.slug}: ${parts.length > 0 ? parts.join(', ') : 'no secrets'}`);
  }
};

try {
  if (args.has('--status')) {
    console.log(`Configured provider: ${km.provider}`);
    for (const warning of keyManagementWarnings(km)) console.log(`  note: ${warning}`);
    console.log('Data keys by provider:');
    await printInventory();
  } else if (args.has('--yes')) {
    console.log(`Rewrapping every tenant's data keys under ${km.provider}.`);
    const result = await rekeyAllTenants(rekeyProviders(km), {
      onTenant: (slug, rewrapped) => console.log(`  ${slug}: ${rewrapped} rewrapped`),
    });
    console.log(`Done: ${result.total} data key(s) across ${result.tenants.length} tenant(s).`);
    console.log('Data keys by provider now:');
    await printInventory();
  } else {
    console.error('Usage: rekey --status | rekey --yes');
    process.exitCode = 2;
  }
} catch (cause) {
  // The message only: provider errors are written to be safe to print, and a
  // stack adds nothing an operator can act on at this point.
  console.error(`rekey failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
