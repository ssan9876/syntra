import { afterEach, describe, expect, it } from 'vitest';
import { startFakeGraphServer, type FakeGraphServer } from '../testing/fake-graph-server.js';
import { discoverEntraCredentialExpiry } from './credential-expiry.js';
import { forgetEntraTokens } from './graph.js';
import { ENTRA_CAPABILITY_MATRIX } from './capabilities.js';

const TENANT = 'contoso.example';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const SECRET = 'abc-the-client-secret';

let server: FakeGraphServer | undefined;
afterEach(async () => {
  forgetEntraTokens();
  await server?.close();
  server = undefined;
});

const config = () => ({
  tenantId: TENANT,
  clientId: CLIENT,
  graphBaseUrl: server!.baseUrl,
  tokenUrl: server!.tokenUrl,
  allowPrivateAddresses: true,
  bindPassword: SECRET,
});

describe('Entra credential expiry discovery', () => {
  it('matches the held secret by its hint and reports the other credentials on the registration', async () => {
    server = await startFakeGraphServer({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: SECRET,
      applications: [
        {
          appId: CLIENT,
          passwordCredentials: [
            { hint: 'abc', displayName: 'Syntra', endDateTime: '2027-03-01T00:00:00Z' },
            { hint: 'zzz', displayName: 'Old', endDateTime: '2026-10-01T00:00:00Z' },
          ],
          keyCredentials: [{ displayName: 'CN=cert', endDateTime: '2028-01-01T00:00:00Z' }],
        },
      ],
    });
    const result = await discoverEntraCredentialExpiry(config());
    expect(result).toMatchObject({ status: 'found', expiresAt: '2027-03-01T00:00:00.000Z', ambiguous: false });
    if (result.status !== 'found') throw new Error('unreachable');
    expect(result.others.map((o) => o.type).sort()).toEqual(['certificate', 'secret']);
    // Never the secret, and the hint is Graph's, not ours.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const read = server.requests.find((r) => r.url.includes('/applications('));
    expect(decodeURIComponent(read!.url)).toContain(`applications(appId='${CLIENT}')`);
  });

  it('reports not_permitted, not a failure, when Application.Read.All was never granted', async () => {
    server = await startFakeGraphServer({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET });
    const result = await discoverEntraCredentialExpiry(config());
    expect(result.status).toBe('not_permitted');
  });

  it('reports unmatched when the registration no longer carries the held secret', async () => {
    server = await startFakeGraphServer({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: SECRET,
      applications: [{ appId: CLIENT, passwordCredentials: [{ hint: 'xyz', endDateTime: '2027-03-01T00:00:00Z' }] }],
    });
    expect((await discoverEntraCredentialExpiry(config())).status).toBe('unmatched');
  });

  it('reports a refused credential as failed, with the AADSTS code only', async () => {
    server = await startFakeGraphServer({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'something-else' });
    const result = await discoverEntraCredentialExpiry(config());
    expect(result).toMatchObject({ status: 'failed' });
    if (result.status === 'failed') expect(result.message).toMatch(/AADSTS7000215/);
  });

  it('is listed in the matrix as optional, with the one permission it needs', () => {
    const entry = ENTRA_CAPABILITY_MATRIX.entries.readCredentialExpiry;
    expect(entry.requiredPermissions).toEqual(['Application.Read.All']);
    expect(entry.note).toMatch(/OPTIONAL/);
  });
});
