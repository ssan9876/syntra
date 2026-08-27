import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createApplication } from './application-service.js';
import {
  resolveAcsUrl,
  upsertSamlConfig,
  type SamlConfigInput,
  type SamlConfigRecord,
} from './saml-config-service.js';

const baseConfig = (overrides: Partial<SamlConfigRecord> = {}): SamlConfigRecord => ({
  id: 'cfg-1',
  applicationId: 'app-1',
  spEntityId: 'https://sp.example.test/metadata',
  acsUrls: ['https://sp.example.test/acs', 'https://sp.example.test/acs2'],
  defaultAcsUrl: 'https://sp.example.test/acs',
  acsBinding: 'HTTP-POST',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  nameIdClaim: null,
  spCertificates: [],
  wantAuthnRequestsSigned: false,
  encryptAssertions: false,
  encryptionCertificate: null,
  sloUrl: null,
  sloBinding: 'HTTP-POST',
  allowIdpInitiated: false,
  wsFedEnabled: false,
  assertionLifetimeMs: 300_000,
  ...overrides,
});

describe('resolveAcsUrl', () => {
  it('accepts a requested URL that exactly matches an allowlist entry', () => {
    const config = baseConfig();
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs2')).toBe(
      'https://sp.example.test/acs2',
    );
  });

  it('falls back to the recorded default when nothing was requested', () => {
    const config = baseConfig();
    expect(resolveAcsUrl(config, null)).toBe('https://sp.example.test/acs');
    expect(resolveAcsUrl(config, '')).toBe('https://sp.example.test/acs');
  });

  it('resolves to null, never to acsUrls[0], when there is no default and nothing was requested', () => {
    // This is the exact fallback the plan revision removed: a config with no
    // default must refuse rather than silently pick the first allowlist
    // entry, because metadata re-import can reorder that list with no write
    // and no audit event.
    const config = baseConfig({ defaultAcsUrl: null });
    expect(resolveAcsUrl(config, null)).toBeNull();
  });

  it('resolves to null when the recorded default is not itself on the allowlist', () => {
    // Defensive: a corrupted or hand-edited row must not be trusted just
    // because a defaultAcsUrl column is populated.
    const config = baseConfig({ defaultAcsUrl: 'https://sp.example.test/stale' });
    expect(resolveAcsUrl(config, null)).toBeNull();
  });

  it('refuses a requested URL that is a prefix of a registered one', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs/callback'] });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs')).toBeNull();
  });

  it('refuses a requested URL that extends a registered one', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs/evil')).toBeNull();
    expect(resolveAcsUrl(config, 'https://sp.example.test/acsX')).toBeNull();
  });

  it('refuses a requested URL that differs only in scheme', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'http://sp.example.test/acs')).toBeNull();
  });

  it('refuses a requested URL that differs only in host case', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://SP.example.test/acs')).toBeNull();
  });

  it('refuses a requested URL that differs only by a trailing slash', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs/')).toBeNull();
  });

  it('refuses a requested URL for a different service provider entirely', () => {
    const config = baseConfig({ acsUrls: ['https://sp.example.test/acs'] });
    expect(resolveAcsUrl(config, 'https://attacker.test/acs')).toBeNull();
  });

  it('refuses everything when the allowlist is empty', () => {
    const config = baseConfig({ acsUrls: [], defaultAcsUrl: null });
    expect(resolveAcsUrl(config, 'https://sp.example.test/acs')).toBeNull();
    expect(resolveAcsUrl(config, null)).toBeNull();
  });
});

describe('wantAuthnRequestsSigned defaults to true (ruling A2-10)', () => {
  let tenantId: string;
  let applicationId: string;

  // Scoped to this describe. A top-level hook here would become a root-level
  // hook for anything that imports this file for its `baseConfig` fixture.
  beforeEach(async () => {
    await resetDatabase();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = tenant.id;
    applicationId = await withTenant(tenantId, async (tx) => {
      const application = await createApplication(tx, {
        name: 'CRM', slug: 'crm', type: 'saml',
      });
      return application.id;
    });
  });

  const written = (over: Partial<SamlConfigInput> = {}): SamlConfigInput => ({
    spEntityId: 'https://sp.example.test/metadata',
    acsUrls: ['https://sp.example.test/acs'],
    defaultAcsUrl: 'https://sp.example.test/acs',
    acsBinding: 'HTTP-POST',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    nameIdClaim: null,
    spCertificates: [],
    encryptAssertions: false,
    encryptionCertificate: null,
    sloUrl: null,
    sloBinding: 'HTTP-POST',
    allowIdpInitiated: false,
    assertionLifetimeMs: 300_000,
    ...over,
  });

  it('requires signed requests when the caller says nothing', async () => {
    const config = await withTenant(tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, written()),
    );
    expect(config.wantAuthnRequestsSigned).toBe(true);
  });

  it('lets a caller turn it off deliberately, and keeps it off', async () => {
    // The whole point of the ruling is that false becomes a choice rather than
    // an inheritance. If this failed, "default true" would have quietly become
    // "always true".
    const off = await withTenant(tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, written({ wantAuthnRequestsSigned: false })),
    );
    expect(off.wantAuthnRequestsSigned).toBe(false);

    const reread = await withTenant(tenantId, (tx) =>
      tx.samlConfig.findUniqueOrThrow({ where: { applicationId } }),
    );
    expect(reread.wantAuthnRequestsSigned).toBe(false);
  });

  it('applies the default on update as well as on insert, because this is a whole-record write', async () => {
    await withTenant(tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, written({ wantAuthnRequestsSigned: false })),
    );
    // Second write says nothing about signing. `upsertSamlConfig` replaces
    // every column — it is not a patch — so the default applies here too. This
    // is asserted rather than left implicit because it is the surprising half:
    // a future partial-update route must read the row first instead of reusing
    // this function.
    const again = await withTenant(tenantId, (tx) =>
      upsertSamlConfig(tx, applicationId, written()),
    );
    expect(again.wantAuthnRequestsSigned).toBe(true);
  });

  it('has the same default in the generated client, for a Prisma caller that omits the field', async () => {
    // Prisma fills a static scalar `@default` in client-side, from the
    // datamodel inlined into the generated client — it does not omit the
    // column and let PostgreSQL decide. So this asserts the *client's*
    // default, which is what any Prisma caller that skips the seam actually
    // gets, and it is why a schema change without `prisma generate` silently
    // keeps the old value.
    const row = await withTenant(tenantId, (tx) =>
      tx.samlConfig.create({
        data: {
          tenantId,
          applicationId,
          spEntityId: 'https://sp.example.test/metadata',
          acsUrls: ['https://sp.example.test/acs'],
          defaultAcsUrl: 'https://sp.example.test/acs',
        },
      }),
    );
    expect(row.wantAuthnRequestsSigned).toBe(true);
  });

  it('has the same default on the column itself, which is what the migration changed', async () => {
    // Raw SQL, because the test above cannot reach the column default:
    // Prisma always sends a value. This is an INSERT that genuinely omits the
    // column, so PostgreSQL is the one deciding — the backstop for anything
    // that reaches this table without Prisma at all. Still inside
    // `withTenant`, because `SamlConfig` is FORCE ROW LEVEL SECURITY and a
    // raw INSERT outside a bound transaction is refused, not silently
    // untenanted.
    const row = await withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "SamlConfig" ("id", "tenantId", "applicationId", "spEntityId", "acsUrls", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${applicationId}::uuid,
                'https://sp.example.test/metadata', ARRAY['https://sp.example.test/acs'], now())
      `;
      return tx.samlConfig.findUniqueOrThrow({ where: { applicationId } });
    });
    expect(row.wantAuthnRequestsSigned).toBe(true);
  });
});
