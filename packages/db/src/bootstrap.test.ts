import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';
import { bootstrapTenant, parseBootstrapConfig, type BootstrapConfig } from './bootstrap-core.js';

const validEnv = (): NodeJS.ProcessEnv => ({
  BOOTSTRAP_TENANT_NAME: 'Northwind',
  BOOTSTRAP_TENANT_SLUG: 'northwind',
  BOOTSTRAP_TENANT_DOMAIN: 'idm.northwind.example',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@northwind.example',
  BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery',
  MASTER_KEY: randomBytes(32).toString('base64'),
});

const validConfig = (): BootstrapConfig => {
  const parsed = parseBootstrapConfig(validEnv());
  if (!parsed.ok) throw new Error('test fixture env should parse');
  return parsed.config;
};

describe('parseBootstrapConfig', () => {
  it('accepts a complete environment, defaulting the admin login to admin', () => {
    const parsed = parseBootstrapConfig(validEnv());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.adminLogin).toBe('admin');
    expect(parsed.config.tenantSlug).toBe('northwind');
    expect(parsed.config.masterKey.length).toBe(32);
  });

  it('honours an explicit admin login', () => {
    const parsed = parseBootstrapConfig({ ...validEnv(), BOOTSTRAP_ADMIN_LOGIN: 'root' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.adminLogin).toBe('root');
  });

  it('refuses a short admin password', () => {
    const parsed = parseBootstrapConfig({ ...validEnv(), BOOTSTRAP_ADMIN_PASSWORD: 'short' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('BOOTSTRAP_ADMIN_PASSWORD');
  });

  it('refuses a missing admin password', () => {
    const env = validEnv();
    delete env.BOOTSTRAP_ADMIN_PASSWORD;
    const parsed = parseBootstrapConfig(env);
    expect(parsed.ok).toBe(false);
  });

  it('refuses a missing MASTER_KEY', () => {
    const env = validEnv();
    delete env.MASTER_KEY;
    const parsed = parseBootstrapConfig(env);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('MASTER_KEY');
  });

  it('refuses a MASTER_KEY that is not 32 bytes', () => {
    const parsed = parseBootstrapConfig({
      ...validEnv(),
      MASTER_KEY: randomBytes(16).toString('base64'),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('MASTER_KEY');
  });

  it('refuses when the tenant identity is incomplete', () => {
    const env = validEnv();
    delete env.BOOTSTRAP_TENANT_DOMAIN;
    const parsed = parseBootstrapConfig(env);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('BOOTSTRAP_TENANT_DOMAIN');
  });

  it('refuses a missing admin email', () => {
    const env = validEnv();
    delete env.BOOTSTRAP_ADMIN_EMAIL;
    const parsed = parseBootstrapConfig(env);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('BOOTSTRAP_ADMIN_EMAIL');
  });
});

describe('bootstrapTenant', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates the tenant, a built-in admin role, and one admin user -- nothing else', async () => {
    const config = validConfig();
    const result = await bootstrapTenant(config);

    expect(result.created).toBe(true);
    expect(result.tenantSlug).toBe('northwind');
    expect(result.tenantDomain).toBe('idm.northwind.example');
    expect(result.adminLogin).toBe('admin');

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'northwind' } });

    await withTenant(tenant.id, async (tx) => {
      const users = await tx.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0]!.login).toBe('admin');
      expect(users[0]!.email).toBe('admin@northwind.example');

      const roles = await tx.role.findMany();
      expect(roles).toHaveLength(1);
      expect(roles[0]!.builtIn).toBe(true);
      expect(roles[0]!.permissions.length).toBeGreaterThan(0);

      const assignments = await tx.roleAssignment.findMany();
      expect(assignments).toHaveLength(1);
      expect(assignments[0]!.userId).toBe(users[0]!.id);
      expect(assignments[0]!.roleId).toBe(roles[0]!.id);

      // Nothing beyond the one admin: no demo groups, org units, people,
      // applications -- unlike seed.ts, this is deliberately empty.
      expect(await tx.group.count()).toBe(0);
      expect(await tx.orgUnit.count()).toBe(0);
      expect(await tx.person.count()).toBe(0);
      expect(await tx.application.count()).toBe(0);
    });

    // The SAML signing key was established from MASTER_KEY, same as
    // seed.ts. Read through withTenant: SigningKey carries FORCE ROW LEVEL
    // SECURITY, so an unscoped read sees nothing even though the row exists.
    const keys = await withTenant(tenant.id, (tx) => tx.signingKey.findMany());
    expect(keys.length).toBeGreaterThan(0);
  });

  it('is a no-op the second time: same tenant, same one admin, nothing duplicated', async () => {
    const config = validConfig();
    const first = await bootstrapTenant(config);
    expect(first.created).toBe(true);

    const second = await bootstrapTenant(config);
    expect(second.created).toBe(false);
    expect(second.tenantSlug).toBe('northwind');

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'northwind' } });
    const tenants = await prisma.tenant.findMany({ where: { slug: 'northwind' } });
    expect(tenants).toHaveLength(1);

    await withTenant(tenant.id, async (tx) => {
      expect(await tx.user.count()).toBe(1);
      expect(await tx.role.count()).toBe(1);
      expect(await tx.roleAssignment.count()).toBe(1);
    });
  });
});
