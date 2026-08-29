/**
 * Production bootstrap. Creates exactly ONE tenant with ONE admin user and
 * nothing else -- no demo groups, org units, people or applications. That is
 * the difference from `seed.ts`, which is a dev fixture hardcoded to "Acme
 * Care"/`acme.localhost` and three demo people; a real deployment has no use
 * for any of that and should not get it by accident.
 *
 * Refuses to run without MASTER_KEY, unlike the dev seed which merely warns.
 * A production tenant with a SAML tile and no signing key is a deployment an
 * operator has to come back and fix by hand; refusing up front is cheaper
 * than a 409 `saml-no-key` discovered later. It also, like the dev seed,
 * refuses to run without a >=12 character admin password.
 *
 * All the logic worth testing lives in `bootstrap-core.ts`; this file is
 * just env-reading and process exit codes.
 */
import { prisma } from './client.js';
import { bootstrapTenant, parseBootstrapConfig } from './bootstrap-core.js';

const parsed = parseBootstrapConfig(process.env);
if (!parsed.ok) {
  console.error(parsed.reason);
  process.exit(1);
}

const result = await bootstrapTenant(parsed.config);

console.log(
  result.created
    ? `Bootstrapped tenant ${result.tenantSlug} (${result.tenantDomain}).`
    : `Tenant ${result.tenantSlug} (${result.tenantDomain}) already has an admin. Nothing to do.`,
);
// The scheme is whatever the deployment was told, not a guess: a lab on plain
// HTTP reading "https://" would think something was misconfigured.
const scheme = process.env.PUBLIC_URL?.startsWith('http://') ? 'http' : 'https';
console.log(`  Reach it at ${scheme}://${result.tenantDomain}`);
console.log(`  Sign in as ${result.adminLogin}`);

await prisma.$disconnect();
