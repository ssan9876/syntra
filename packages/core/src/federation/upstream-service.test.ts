import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  findUpstream,
  findUpstreamBySlug,
  listUpstreams,
  upsertUpstream,
  upstreamClientSecret,
  type UpstreamInput,
} from './upstream-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 5));

let tenantId: string;
let otherTenantId: string;

const input = (over: Partial<UpstreamInput> = {}): UpstreamInput => ({
  slug: 'entra',
  name: 'Entra ID',
  protocol: 'oidc',
  enabled: true,
  issuerUrl: 'https://login.example.test/tenant',
  clientId: 'syntra',
  scopes: ['openid', 'profile', 'email'],
  idpEntityId: null,
  ssoUrl: null,
  idpSloUrl: null,
  ssoBinding: 'HTTP-Redirect',
  idpCertificates: [],
  wantAssertionsSigned: true,
  loginAttribute: 'preferred_username',
  emailAttribute: 'email',
  displayNameAttribute: 'name',
  groupsAttribute: null,
  createUsers: true,
  allowLoginAdoption: false,
  refreshOnLogin: true,
  defaultOrgUnitId: null,
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const o = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  otherTenantId = o.id;
});

/** listUpstreams inside a transaction, which is the only way it is callable. */
const listAll = (tenant: string) => withTenant(tenant, (tx) => listUpstreams(tx));

describe('upsertUpstream', () => {
  it('creates an upstream and reads it back', async () => {
    const created = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input()),
    );
    expect(created).toMatchObject({
      slug: 'entra',
      protocol: 'oidc',
      issuerUrl: 'https://login.example.test/tenant',
      scopes: ['openid', 'profile', 'email'],
      wantAssertionsSigned: true,
    });

    const found = await findUpstream(tenantId, created.id);
    expect(found?.id).toBe(created.id);
    expect(await findUpstreamBySlug(tenantId, 'entra')).toMatchObject({ id: created.id });
  });

  it('updates in place rather than adding a second row for the same slug', async () => {
    const first = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ name: 'Entra ID' })),
    );
    const second = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ name: 'Entra ID (production)' })),
    );
    expect(second.id).toBe(first.id);
    expect(await listAll(tenantId)).toHaveLength(1);
    expect(second.name).toBe('Entra ID (production)');
  });

  it('puts the client secret in the vault and never in a column', async () => {
    const created = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ clientSecret: 'sup3r-s3cret' })),
    );

    const row = await withTenant(tenantId, (tx) =>
      tx.upstreamIdp.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.clientSecretName).toBe('upstream:entra:client_secret');
    // Nothing on the record, and nothing on the row, is the secret itself.
    expect(JSON.stringify(row)).not.toContain('sup3r-s3cret');
    expect(JSON.stringify(created)).not.toContain('sup3r-s3cret');

    const stored = await withTenant(tenantId, (tx) =>
      tx.secret.findFirstOrThrow({ where: { name: 'upstream:entra:client_secret' } }),
    );
    expect(Buffer.from(stored.ciphertext).toString('utf8')).not.toContain('sup3r-s3cret');

    expect(await upstreamClientSecret(tenantId, provider, created.id)).toBe('sup3r-s3cret');
  });

  it('leaves an existing secret alone when the input carries none', async () => {
    const created = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ clientSecret: 'first' })),
    );
    await withTenant(tenantId, (tx) => upsertUpstream(tx, provider, input({ name: 'Renamed' })));
    expect(await upstreamClientSecret(tenantId, provider, created.id)).toBe('first');
  });

  it('answers null for an upstream that has no secret', async () => {
    const created = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input()),
    );
    expect(await upstreamClientSecret(tenantId, provider, created.id)).toBeNull();
  });
});

describe('reading upstreams', () => {
  it('lists this tenant\'s upstreams by name, and nobody else\'s', async () => {
    await withTenant(tenantId, async (tx) => {
      await upsertUpstream(tx, provider, input({ slug: 'zeta', name: 'Zeta' }));
      await upsertUpstream(tx, provider, input({ slug: 'alpha', name: 'Alpha' }));
    });
    await withTenant(otherTenantId, (tx) =>
      upsertUpstream(tx, provider, input({ slug: 'entra', name: 'Beta Entra' })),
    );

    expect((await listAll(tenantId)).map((u) => u.name)).toEqual(['Alpha', 'Zeta']);
    expect((await listAll(otherTenantId)).map((u) => u.name)).toEqual(['Beta Entra']);
  });

  it('does not hand a disabled upstream to a login', async () => {
    // A disabled upstream is one an administrator turned off. Routing rules
    // outlive it, so the lookup a login makes is what has to refuse.
    const created = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ enabled: false })),
    );
    expect(await findUpstream(tenantId, created.id)).toBeNull();
    expect(await findUpstreamBySlug(tenantId, 'entra')).toBeNull();
    // Still visible to administration, which is where it gets re-enabled.
    expect(await listAll(tenantId)).toHaveLength(1);
  });

  it('does not find another tenant\'s upstream by its id', async () => {
    const created = await withTenant(otherTenantId, (tx) =>
      upsertUpstream(tx, provider, input()),
    );
    expect(await findUpstream(tenantId, created.id)).toBeNull();
    expect(await findUpstreamBySlug(tenantId, 'entra')).toBeNull();
    expect(await upstreamClientSecret(tenantId, provider, created.id)).toBeNull();
  });
});

describe('allowLoginAdoption: the default has to survive every layer', () => {
  it('is false for a row written without ever naming the column', async () => {
    // The layer under the service. A row can arrive from a migration, a
    // restore, a script, or code written before the column existed — and the
    // question "what does adoption do for a row nobody set this on" is
    // answered by the DATABASE, not by any default further up.
    await withTenant(tenantId, (tx) =>
      tx.$executeRaw`
        INSERT INTO "UpstreamIdp" ("id", "tenantId", "slug", "name", "protocol", "updatedAt")
        VALUES (gen_random_uuid(), current_setting('app.current_tenant')::uuid,
                'legacy', 'Legacy IdP', 'oidc', now())
      `,
    );

    const rows = await withTenant(tenantId, (tx) => listUpstreams(tx));
    const legacy = rows.find((row) => row.slug === 'legacy');
    expect(legacy?.allowLoginAdoption).toBe(false);
  });

  it('survives a round trip that does not mention it', async () => {
    // `upsertUpstream` spreads its input, so a field the caller leaves at
    // false must come back false rather than picking up a value from the row
    // it is updating.
    const created = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ slug: 'round-trip' })),
    );
    expect(created.allowLoginAdoption).toBe(false);

    const on = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ slug: 'round-trip', allowLoginAdoption: true })),
    );
    expect(on.allowLoginAdoption).toBe(true);

    // AND BACK OFF AGAIN. A setting that can be turned on and not off is not a
    // setting, and an upsert that spreads its input can silently become one.
    const off = await withTenant(tenantId, (tx) =>
      upsertUpstream(tx, provider, input({ slug: 'round-trip' })),
    );
    expect(off.allowLoginAdoption).toBe(false);
  });
});
