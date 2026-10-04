/**
 * The testable half of `bootstrap.ts`, and the one way the first tenant is
 * made: the API's first-run setup (`apps/api/src/routes/setup.ts`) calls
 * `bootstrapTenant` too, so a tenant made in the browser and one made from
 * the command line are the same tenant.
 *
 * Split out for the same reason `seedMarkerFound` was pulled out of
 * `seed.ts`: the script itself reads `process.env` and calls `process.exit`
 * at module scope, which a test cannot import without also running (and
 * potentially killing the test process). Everything that has business logic
 * worth asserting on lives here instead; `bootstrap.ts` is left as thin
 * env-reading glue.
 */
import {
  createMasterKeyProvider,
  ensureActiveKey,
  parseKeyManagement,
  type KeyManagementConfig,
  type MasterKeyProvider,
  assignRole,
  createBuiltInRoles,
  createUser,
  hashPassword,
  recordEvent,
  setPasswordHash,
} from '@syntra/core';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { seedMarkerFound } from './seed-guard.js';

/**
 * The shortest first administrator password either path accepts. The same
 * figure as `Tenant.passwordMinLength`'s default, so the first password is
 * held to the policy every later one is.
 */
export const BOOTSTRAP_PASSWORD_MIN_LENGTH = 12;

export interface BootstrapConfig {
  tenantName: string;
  tenantSlug: string;
  tenantDomain: string;
  adminLogin: string;
  adminEmail: string;
  adminPassword: string;
  /** Defaults to the login, which is what the script has always done. */
  adminDisplayName?: string;
  /**
   * The same master-key configuration the API boots with -- MASTER_KEY, or
   * MASTER_KEY_PROVIDER and its variables -- so the tenant's first signing
   * key is sealed under whatever the API will read it with.
   */
  keyManagement: KeyManagementConfig;
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

  if (!adminPassword || adminPassword.length < BOOTSTRAP_PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      reason: `BOOTSTRAP_ADMIN_PASSWORD must be set and at least ${BOOTSTRAP_PASSWORD_MIN_LENGTH} characters. Refusing to bootstrap.`,
    };
  }

  let keyManagement: KeyManagementConfig;
  try {
    keyManagement = parseKeyManagement(env);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `${detail}. Refusing to bootstrap.` };
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
      keyManagement,
    },
  };
}

export interface BootstrapResult {
  created: boolean;
  tenantId: string;
  tenantSlug: string;
  tenantDomain: string | null;
  adminLogin: string;
  /** The administrator made by this call; null when `created` is false. */
  adminUserId: string | null;
}

export interface BootstrapOptions {
  /** Which path made the tenant, recorded on the `tenant.created` audit event. */
  via?: 'bootstrap' | 'setup';
  /** The address the setup request came from. Null from the command line. */
  sourceIp?: string | null;
  /**
   * The provider to seal the first signing key with. The API passes the one
   * it already holds; the script builds one from `config.keyManagement`.
   */
  keyProvider?: MasterKeyProvider;
}

/**
 * Creates the tenant, its built-in admin role and its one admin user --
 * and nothing else. Idempotent: a tenant that already carries the seed
 * markers (see `seedMarkerFound`) is left untouched, `created` comes back
 * false, and the SAML signing key is still ensured (it is its own idempotent
 * step, and a tenant bootstrapped before MASTER_KEY was wired up should not
 * stay without one forever).
 */
export async function bootstrapTenant(
  config: BootstrapConfig,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
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

  let adminUserId: string | null = null;

  await withTenant(tenant.id, async (tx) => {
    const seeded = seedMarkerFound({
      adminUser: (await tx.user.findFirst({ where: { login: config.adminLogin } })) !== null,
      builtInRole: (await tx.role.findFirst({ where: { builtIn: true } })) !== null,
    });
    if (seeded) return;

    const admin = await createUser(tx, {
      login: config.adminLogin,
      email: config.adminEmail,
      displayName: config.adminDisplayName ?? config.adminLogin,
    });
    await setPasswordHash(tx, admin.id, adminHash);

    // Owner holds everything but the restricted permissions; Data deletion
    // (`person.purge`) starts with no holder and only an Owner can assign it.
    const { owner: adminRole } = await createBuiltInRoles(tx);
    await assignRole(tx, admin.id, adminRole.id);

    // The first row in the tenant's audit chain. No actor: nobody was signed
    // in, and the account this made is the target, not the author.
    await recordEvent(tx, {
      actorUserId: null,
      action: 'tenant.created',
      targetType: 'Tenant',
      targetId: tenant.id,
      outcome: 'success',
      sourceIp: options.sourceIp ?? null,
      payload: {
        via: options.via ?? 'bootstrap',
        slug: tenant.slug,
        primaryDomain: tenant.primaryDomain,
        ownerUserId: admin.id,
        ownerRoleId: adminRole.id,
      },
    });

    adminUserId = admin.id;
  });

  // Outside the transaction for the same reason as seed.ts: RSA-2048
  // generation plus a self-signed certificate is well over a second and has
  // no business inside Prisma's interactive-transaction budget. Idempotent,
  // so running bootstrap again is a single read.
  await ensureActiveKey(
    tenant.id,
    options.keyProvider ?? createMasterKeyProvider(config.keyManagement),
    'saml',
    { commonName: tenant.primaryDomain ?? config.tenantSlug },
  );

  return {
    created: adminUserId !== null,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantDomain: tenant.primaryDomain,
    adminLogin: config.adminLogin,
    adminUserId,
  };
}
