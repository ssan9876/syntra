/**
 * The testable half of `bootstrap.ts`.
 *
 * Split out for the same reason `seedMarkerFound` was pulled out of
 * `seed.ts`: the script itself reads `process.env` and calls `process.exit`
 * at module scope, which a test cannot import without also running (and
 * potentially killing the test process). Everything that has business logic
 * worth asserting on lives here instead; `bootstrap.ts` is left as thin
 * env-reading glue.
 */
import {
  ALL_PERMISSIONS,
  ensureActiveKey,
  localMasterKeyProvider,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { seedMarkerFound } from './seed-guard.js';

export interface BootstrapConfig {
  tenantName: string;
  tenantSlug: string;
  tenantDomain: string;
  adminLogin: string;
  adminEmail: string;
  adminPassword: string;
  masterKey: Buffer;
}

export type ConfigResult =
  | { ok: true; config: BootstrapConfig }
  | { ok: false; reason: string };

/**
 * Parses and validates the environment `bootstrap.ts` reads. Pure, so it can
 * be tested without a database.
 */
export function parseBootstrapConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const tenantName = env.BOOTSTRAP_TENANT_NAME;
  const tenantSlug = env.BOOTSTRAP_TENANT_SLUG;
  const tenantDomain = env.BOOTSTRAP_TENANT_DOMAIN;
  const adminLogin = env.BOOTSTRAP_ADMIN_LOGIN ?? 'admin';
  const adminEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = env.BOOTSTRAP_ADMIN_PASSWORD;
  const masterKey = env.MASTER_KEY;

  if (!tenantName || !tenantSlug || !tenantDomain) {
    return {
      ok: false,
      reason:
        'BOOTSTRAP_TENANT_NAME, BOOTSTRAP_TENANT_SLUG and BOOTSTRAP_TENANT_DOMAIN must all be set. Refusing to bootstrap.',
    };
  }

  if (!adminEmail) {
    return { ok: false, reason: 'BOOTSTRAP_ADMIN_EMAIL must be set. Refusing to bootstrap.' };
  }

  if (!adminPassword || adminPassword.length < 12) {
    return {
      ok: false,
      reason: 'BOOTSTRAP_ADMIN_PASSWORD must be set and at least 12 characters. Refusing to bootstrap.',
    };
  }

  if (!masterKey || Buffer.from(masterKey, 'base64').length !== 32) {
    return { ok: false, reason: 'MASTER_KEY must be set to 32 base64 bytes. Refusing to bootstrap.' };
  }

  return {
    ok: true,
    config: {
      tenantName,
      tenantSlug,
      tenantDomain,
      adminLogin,
      adminEmail,
      adminPassword,
      masterKey: Buffer.from(masterKey, 'base64'),
    },
  };
}

export interface BootstrapResult {
  created: boolean;
  tenantSlug: string;
  tenantDomain: string | null;
  adminLogin: string;
}

/**
 * Creates the tenant, its built-in admin role and its one admin user --
 * and nothing else. Idempotent: a tenant that already carries the seed
 * markers (see `seedMarkerFound`) is left untouched, `created` comes back
 * false, and the SAML signing key is still ensured (it is its own idempotent
 * step, and a tenant bootstrapped before MASTER_KEY was wired up should not
 * stay without one forever).
 */
export async function bootstrapTenant(config: BootstrapConfig): Promise<BootstrapResult> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: config.tenantSlug },
    create: {
      name: config.tenantName,
      slug: config.tenantSlug,
      primaryDomain: config.tenantDomain,
    },
    update: {
      name: config.tenantName,
      primaryDomain: config.tenantDomain,
    },
  });

  // Hashed before the transaction opens, same reasoning as seed.ts: Argon2id
  // is deliberately expensive and has no business inside Prisma's 5000 ms
  // interactive-transaction budget.
  const adminHash = await hashPassword(config.adminPassword);

  let created = false;

  await withTenant(tenant.id, async (tx) => {
    const seeded = seedMarkerFound({
      adminUser: (await tx.user.findFirst({ where: { login: config.adminLogin } })) !== null,
      builtInRole: (await tx.role.findFirst({ where: { builtIn: true } })) !== null,
    });
    if (seeded) return;

    const admin = await createUser(tx, {
      login: config.adminLogin,
      email: config.adminEmail,
      displayName: config.adminLogin,
    });
    await setPasswordHash(tx, admin.id, adminHash);

    const adminRole = await createRole(tx, 'Owner', ALL_PERMISSIONS, {
      builtIn: true,
      description: 'Full administrative access to this tenant.',
    });
    await assignRole(tx, admin.id, adminRole.id);

    created = true;
  });

  // Outside the transaction for the same reason as seed.ts: RSA-2048
  // generation plus a self-signed certificate is well over a second and has
  // no business inside Prisma's interactive-transaction budget. Idempotent,
  // so running bootstrap again is a single read.
  await ensureActiveKey(
    tenant.id,
    localMasterKeyProvider(config.masterKey),
    'saml',
    { commonName: tenant.primaryDomain ?? config.tenantSlug },
  );

  return {
    created,
    tenantSlug: tenant.slug,
    tenantDomain: tenant.primaryDomain,
    adminLogin: config.adminLogin,
  };
}
