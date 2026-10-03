import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  OWNER_PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../../test-support.js';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login: 'admin', email: 'admin@acme.test', displayName: 'Ada' });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, 'Owner', OWNER_PERMISSIONS);
    await assignRole(tx, user.id, role.id);
  });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const first = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${first}` },
    payload: { password: PASSWORD },
  });
  cookie = up.cookies.find((c) => c.name === 'syntra_session')!.value;
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) => {
  const headers = { host: TEST_HOST, cookie: `syntra_session=${cookie}` };
  return body === undefined
    ? ctx.app.inject({ method, url, headers })
    : ctx.app.inject({ method, url, headers, payload: body as object });
};

const HELPDESK = {
  name: 'Acme Helpdesk',
  category: 'itsm',
  description: 'Ticketing. One entry per helpdesk instance.',
  launchUrl: 'https://{{instance}}.helpdesk.example.test',
  variables: [{ key: 'instance', label: 'Instance name', example: 'acme' }],
  saml: {
    spEntityId: 'https://{{instance}}.helpdesk.example.test/saml',
    acsUrls: ['https://{{instance}}.helpdesk.example.test/saml/acs'],
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    wantAuthnRequestsSigned: false,
    claims: [{ claimName: 'email', sourceKind: 'user', sourceField: 'email' }],
  },
};

describe('catalog templates', () => {
  it('saves an entry, lists it beside the built-in ones, and makes applications from it', async () => {
    const saved = await call('POST', '/api/admin/catalog/templates', HELPDESK);
    expect(saved.statusCode).toBe(201);
    const key = saved.json().key as string;
    expect(key).toMatch(/^custom-[0-9a-f-]{36}$/);

    const catalog = await call('GET', '/api/admin/catalog');
    const mine = catalog.json().entries.filter((e: { source: string }) => e.source === 'tenant');
    expect(mine.map((e: { name: string }) => e.name)).toEqual(['Acme Helpdesk']);
    expect(catalog.json().entries.some((e: { source: string; key: string }) => e.source === 'builtin' && e.key === 'slack')).toBe(true);

    const created = await call('POST', '/api/admin/applications/from-catalog', { key, variables: { instance: 'emea' } });
    expect(created.statusCode).toBe(201);
    const saml = await call('GET', `/api/admin/applications/${created.json().applicationId}/saml`);
    expect(saml.json()).toMatchObject({
      spEntityId: 'https://emea.helpdesk.example.test/saml',
      acsUrls: ['https://emea.helpdesk.example.test/saml/acs'],
    });
    const claims = await call('GET', `/api/admin/applications/${created.json().applicationId}/claims`);
    expect(claims.json().saml.map((c: { claimName: string }) => c.claimName)).toEqual(['email']);
  });

  it('refuses an undeclared variable, an unused one and a URL that cannot render, by path', async () => {
    const res = await call('POST', '/api/admin/catalog/templates', {
      ...HELPDESK,
      variables: [
        { key: 'instance', label: 'Instance name', example: 'acme' },
        { key: 'region', label: 'Region', example: 'eu' },
      ],
      launchUrl: '{{instance}}.helpdesk.example.test',
      saml: { ...HELPDESK.saml, spEntityId: 'https://{{tenant}}.helpdesk.example.test' },
    });
    expect(res.statusCode).toBe(400);
    const paths = JSON.stringify(res.json());
    expect(paths).toContain('launchUrl');
    expect(paths).toContain('{{tenant}} is not a declared variable');
    expect(paths).toContain('{{region}} is not used');
  });

  it('refuses a name already in use against the field', async () => {
    await call('POST', '/api/admin/catalog/templates', HELPDESK);
    const again = await call('POST', '/api/admin/catalog/templates', HELPDESK);
    expect(again.statusCode).toBe(409);
    expect(again.json().errors).toEqual([{ path: 'name', message: 'Catalog entry "Acme Helpdesk" already exists.' }]);
  });

  it('deletes an entry, leaving applications made from it', async () => {
    const key = (await call('POST', '/api/admin/catalog/templates', HELPDESK)).json().key as string;
    const app = await call('POST', '/api/admin/applications/from-catalog', { key, variables: { instance: 'emea' } });
    const id = key.slice('custom-'.length);

    expect((await call('DELETE', `/api/admin/catalog/templates/${id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/admin/applications/${app.json().applicationId}/saml`)).statusCode).toBe(200);
    const gone = await call('POST', '/api/admin/applications/from-catalog', { key, variables: { instance: 'apac' } });
    expect(gone.statusCode).toBe(404);
  });

  it('drafts an entry from an application configured by hand', async () => {
    const app = await call('POST', '/api/admin/applications/setup', {
      name: 'Wiki',
      protocol: 'oidc',
      launchUrl: 'https://wiki.example.test',
      oidc: { redirectUris: ['https://wiki.example.test/callback'] },
    });
    const draft = await call('GET', `/api/admin/applications/${app.json().applicationId}/catalog-draft`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      name: 'Wiki',
      launchUrl: 'https://wiki.example.test',
      variables: [],
      oidc: {
        redirectUris: ['https://wiki.example.test/callback'],
        claims: [{ claimName: 'groups', sourceKind: 'groups', multiValued: true }],
      },
    });

    // The draft saves as it is.
    expect((await call('POST', '/api/admin/catalog/templates', draft.json())).statusCode).toBe(201);
  });
});
