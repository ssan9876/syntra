import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { CATALOG_ENTRIES } from './entries.js';
import {
  CatalogVariableMissingError,
  EntityIdTakenError,
  UnknownCatalogEntryError,
  createFromCatalog,
  fill,
  listCatalog,
} from './index.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('the entries', () => {
  it('have unique, stable keys', () => {
    // `catalogKey` is written onto applications, so a renamed or duplicated
    // key silently reattributes an integration somebody already built.
    const keys = CATALOG_ENTRIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('describe exactly one protocol each', () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(
        [entry.saml, entry.oidc].filter(Boolean).length,
        `${entry.key} must describe one protocol`,
      ).toBe(1);
    }
  });

  it('declare every variable their templates use', () => {
    // A template referencing a variable the form does not ask for is one that
    // throws at create time, after the administrator has filled in the form.
    for (const entry of CATALOG_ENTRIES) {
      const declared = new Set(entry.variables.map((v) => v.key));
      const templates = [
        entry.launchUrl ?? '',
        entry.saml?.spEntityId ?? '',
        ...(entry.saml?.acsUrls ?? []),
        entry.saml?.sloUrl ?? '',
        ...(entry.oidc?.redirectUris ?? []),
        ...(entry.oidc?.postLogoutRedirectUris ?? []),
      ].join(' ');
      for (const [, name] of templates.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
        expect(declared, `${entry.key} uses {{${name}}}`).toContain(name);
      }
    }
  });

  it("point at the vendor's own documentation", () => {
    // An entry is a convenience, not an authority. The link is how somebody
    // checks it against the page that is.
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.docsUrl, entry.key).toMatch(/^https:\/\//);
    }
  });

  it('never relax the signed-request default', () => {
    // `wantAuthnRequestsSigned` defaults to true by ruling. A catalog that
    // quietly turned it off for everything it touched would be the worst
    // possible thing to put in front of somebody in a hurry.
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.saml?.wantAuthnRequestsSigned, entry.key).not.toBe(false);
    }
  });

  it('is sorted by name when listed', () => {
    const names = listCatalog().map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('fill', () => {
  it('substitutes a variable', () => {
    expect(fill('https://{{workspace}}.slack.com/sso/saml', { workspace: 'acme' })).toBe(
      'https://acme.slack.com/sso/saml',
    );
  });

  it('trims what it substitutes', () => {
    // A pasted subdomain arrives with a space on it, and an ACS URL is
    // compared byte for byte at sign-in.
    expect(fill('https://{{host}}/saml/acs', { host: ' assets.acme.test ' })).toBe(
      'https://assets.acme.test/saml/acs',
    );
  });

  it('refuses a variable nobody supplied', () => {
    expect(() => fill('https://{{workspace}}.slack.com', {})).toThrow(
      CatalogVariableMissingError,
    );
  });

  it('refuses a variable supplied blank', () => {
    // `https://.slack.com/sso/saml` is not a smaller URL, it is a different
    // one, and it would fail at the first sign-in with nothing pointing back
    // at the empty box.
    expect(() => fill('https://{{workspace}}.slack.com', { workspace: '  ' })).toThrow(
      CatalogVariableMissingError,
    );
  });
});

describe('createFromCatalog', () => {
  it('refuses an entry that does not exist', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createFromCatalog(tx, { key: 'not-a-real-app', variables: {} }),
      ),
    ).rejects.toBeInstanceOf(UnknownCatalogEntryError);
  });

  it('creates the application, its SAML config and its claim mappings', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'slack', variables: { workspace: 'acme' } }),
    );

    expect(created).toMatchObject({ slug: 'slack', protocol: 'saml' });

    const config = await withTenant(tenantId, (tx) =>
      tx.samlConfig.findUniqueOrThrow({ where: { applicationId: created.applicationId } }),
    );
    expect(config.spEntityId).toBe('https://slack.com');
    expect(config.acsUrls).toEqual(['https://acme.slack.com/sso/saml']);
    expect(config.defaultAcsUrl).toBe('https://acme.slack.com/sso/saml');

    const mappings = await withTenant(tenantId, (tx) =>
      tx.claimMapping.findMany({ where: { applicationId: created.applicationId } }),
    );
    expect(mappings.map((m) => m.claimName).sort()).toEqual([
      'User.Email',
      'first_name',
      'last_name',
    ]);
  });

  it('records which entry it came from', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'slack', variables: { workspace: 'acme' } }),
    );
    const application = await withTenant(tenantId, (tx) =>
      tx.application.findUniqueOrThrow({ where: { id: created.applicationId } }),
    );
    expect(application.catalogKey).toBe('slack');
    expect(application.launchUrl).toBe('https://acme.slack.com');
  });

  it('never turns on IdP-initiated sign-in', async () => {
    // A posture an administrator adopts for a named application, not one that
    // arrives with a template they picked off a list.
    const created = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'slack', variables: { workspace: 'acme' } }),
    );
    const config = await withTenant(tenantId, (tx) =>
      tx.samlConfig.findUniqueOrThrow({ where: { applicationId: created.applicationId } }),
    );
    expect(config.allowIdpInitiated).toBe(false);
    expect(config.wantAuthnRequestsSigned).toBe(true);
  });

  it('creates an OIDC client and returns the secret once', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'grafana', variables: { host: 'grafana.acme.test' } }),
    );

    expect(created.protocol).toBe('oidc');
    expect(created.clientSecret).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const client = await withTenant(tenantId, (tx) =>
      tx.oidcClient.findUniqueOrThrow({ where: { applicationId: created.applicationId } }),
    );
    expect(client.redirectUris).toEqual([
      'https://grafana.acme.test/login/generic_oauth',
    ]);
    // Hashed, not stored. The response is the only place the secret exists.
    expect(client.clientSecretHash).not.toContain(created.clientSecret!);
    expect(client.requirePkce).toBe(true);
    // The one grant that issues a token without a decision from `authorize()`
    // is not something a template turns on.
    expect(client.clientCredentialsEnabled).toBe(false);
  });

  it('gives a second instance of one application its own slug', async () => {
    await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'snipe-it', variables: { host: 'assets.acme.test' } }),
    );
    const second = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'snipe-it', variables: { host: 'assets.eu.acme.test' } }),
    );
    // Two instances is an ordinary thing to want, not a clash to resolve by
    // inventing a name.
    expect(second.slug).toBe('snipe-it-2');
  });

  it('refuses a second application claiming one entity ID, and names the first', async () => {
    // Slack's entity ID is the constant `https://slack.com` whatever the
    // workspace, so two of them cannot be told apart from the AuthnRequest.
    // That is a protocol fact, and the refusal has to say what to do about it
    // rather than surface a unique-constraint error out of the driver.
    await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'slack', variables: { workspace: 'acme' } }),
    );

    const failure = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'slack', variables: { workspace: 'acme-eu' } }),
    ).then(
      () => null,
      (cause: unknown) => cause as Error,
    );

    expect(failure).toBeInstanceOf(EntityIdTakenError);
    expect(failure!.message).toContain('Slack');
    expect(failure!.message).toContain('https://slack.com');
    // And nothing was left behind by the attempt.
    expect(await withTenant(tenantId, (tx) => tx.application.count())).toBe(1);
  });

  it('writes nothing when a variable is missing', async () => {
    await expect(
      withTenant(tenantId, (tx) => createFromCatalog(tx, { key: 'slack', variables: {} })),
    ).rejects.toBeInstanceOf(CatalogVariableMissingError);

    // A half-created application is an entry in the console that cannot be
    // signed in to and that nothing marks as broken.
    expect(await withTenant(tenantId, (tx) => tx.application.count())).toBe(0);
  });

  it('leaves the SP certificate empty for the administrator to supply', async () => {
    // The catalog knows the vendor's URLs. It cannot know one installation's
    // signing certificate, and a placeholder there would be worse than a gap.
    const created = await withTenant(tenantId, (tx) =>
      createFromCatalog(tx, { key: 'snipe-it', variables: { host: 'assets.acme.test' } }),
    );
    const config = await withTenant(tenantId, (tx) =>
      tx.samlConfig.findUniqueOrThrow({ where: { applicationId: created.applicationId } }),
    );
    expect(config.spCertificates).toEqual([]);
  });
});
