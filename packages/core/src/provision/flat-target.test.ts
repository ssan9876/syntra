import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  entraTargetConnector,
  forgetEntraTokens,
  scimTargetConnector,
  type TargetConnector,
} from '@syntra/connectors';
import {
  startFakeGraphServer,
  startFakeScimServer,
  type FakeGraphServer,
  type FakeScimServer,
} from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';
import { previewAccountProfile } from './explain.js';

/**
 * Flat targets through a REAL run: the registry's connector, a real config,
 * a fake service on the loopback address.
 *
 * Every earlier test of Entra ID and SCIM called the connector directly, and
 * that is how a target that could never create an account through Provision
 * passed certification. `listContainers` is empty for both, so the run
 * dropped every person as `container_missing`; and a generated correlation
 * key never contains `@`, so with the directory GUID as `tenantId` Entra
 * could not form a userPrincipalName either. These drive the whole loop --
 * profile, rule, preview, apply -- and look at what reached the service.
 *
 * The one seam: the database refuses a target whose stored URL is not https
 * (`target_system_encrypted_transport`), and the fakes speak http on the
 * loopback address. So the stored config names an https URL and the REAL
 * connector is handed the same config with only the URLs pointed at the fake.
 * Everything else -- the run, the apply, the connector's own logic -- is the
 * production path.
 */
const pointedAt = <C>(
  connector: TargetConnector<C>,
  rewrite: (config: Record<string, unknown>) => Record<string, unknown>,
): TargetConnector<never> =>
  new Proxy(connector, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (config: Record<string, unknown>, ...rest: unknown[]) =>
        (value as (...a: unknown[]) => unknown).call(target, rewrite(config), ...rest);
    },
  }) as unknown as TargetConnector<never>;

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const noSleep = async () => undefined;

const TENANT_GUID = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'client-secret-value';

let tenantId: string;

// Flat targets place accounts nowhere; the fields are still required by the
// schema, and `/` is the documented conventional value.
const flatProfile = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: 20,
  containerTemplate: '/',
  fallbackContainer: '/',
  attributeTemplates: {
    displayName: '%person.givenName% %person.familyName%',
    givenName: '%person.givenName%',
    familyName: '%person.familyName%',
  },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly' as const,
};

async function seedAnna() {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    return person.id;
  });
}

const seedConfirmingUser = () =>
  withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: { tenantId, login: 'reviewer', email: 'reviewer@acme.test', displayName: 'Reviewer' },
    });
    return user.id;
  });

async function profileAndRule(targetId: string) {
  await upsertAccountProfile(tenantId, null, targetId, flatProfile);
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [],
  });
}

const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

const exceptionsOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.provisionException.findMany({ where: { runId } }));

async function previewAndApply(targetId: string, connector: TargetConnector<never>) {
  const run = await previewProvisionRun(tenantId, provider, targetId, { now: NOW, connector });
  const actions = await actionsOf(run.id);
  const exceptions = await exceptionsOf(run.id);
  const confirmedByUserId = await seedConfirmingUser();
  const result = await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId,
    connector,
    now: NOW,
    sleep: noSleep,
  });
  return { run, actions, exceptions, result };
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('an Entra ID target with a GUID tenantId and a userPrincipalDomain', () => {
  let graph: FakeGraphServer;

  beforeEach(async () => {
    forgetEntraTokens();
    graph = await startFakeGraphServer({
      tenantId: TENANT_GUID,
      clientId: CLIENT,
      clientSecret: SECRET,
      users: [],
      groups: [],
    });
  });

  afterEach(async () => {
    await graph.close();
  });

  const entra = () =>
    pointedAt(entraTargetConnector, (config) => ({
      ...config,
      graphBaseUrl: graph.baseUrl,
      tokenUrl: graph.tokenUrl,
    }));

  const createEntraTarget = (userPrincipalDomain?: string) =>
    createTarget(tenantId, provider, null, {
      type: 'entraId',
      name: 'Contoso Entra',
      config: {
        tenantId: TENANT_GUID,
        clientId: CLIENT,
        graphBaseUrl: 'https://graph.fake.test/v1.0',
        tokenUrl: `https://login.fake.test/${TENANT_GUID}/oauth2/v2.0/token`,
        allowPrivateAddresses: true,
        ...(userPrincipalDomain === undefined ? {} : { userPrincipalDomain }),
      },
      bindPassword: SECRET,
    });

  it('previews a create_account, not container_missing, and creates key@domain', async () => {
    const { id: targetId } = await createEntraTarget('contoso.com');
    await profileAndRule(targetId);
    const personId = await seedAnna();

    const { actions, exceptions, result } = await previewAndApply(targetId, entra());

    expect(exceptions.map((e) => e.kind)).not.toContain('container_missing');
    expect(exceptions).toEqual([]);
    const creates = actions.filter((a) => a.actionType === 'create_account');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.personId).toBe(personId);
    expect(result.applied).toBeGreaterThan(0);
    expect(result.failed).toBe(0);

    const posts = graph.requests.filter(
      (r) => r.method === 'POST' && /^\/v1\.0\/users\/?$/.test(r.url),
    );
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { userPrincipalName?: string }).userPrincipalName).toBe(
      'anna.novak@contoso.com',
    );
    expect([...graph.users.values()].map((u) => u.userPrincipalName)).toEqual([
      'anna.novak@contoso.com',
    ]);
  });

  it('the profile preview shows the full UPN and no container problem', async () => {
    const { id: targetId } = await createEntraTarget('contoso.com');
    const personId = await seedAnna();

    const preview = await previewAccountProfile(tenantId, targetId, flatProfile, personId, NOW);

    expect(preview.problems).toEqual([]);
    expect(preview.placesAccountsInContainers).toBe(false);
    expect(preview.container).toBeNull();
    expect(preview.userPrincipalName).toBe('anna.novak@contoso.com');
  });

  it('the profile preview names the missing domain before anything is applied', async () => {
    const { id: targetId } = await createEntraTarget();
    const personId = await seedAnna();

    const preview = await previewAccountProfile(tenantId, targetId, flatProfile, personId, NOW);

    expect(preview.userPrincipalName).toBeNull();
    expect(preview.problems).toHaveLength(1);
    expect(preview.problems[0]).toMatch(/userPrincipalDomain/);
    expect(graph.requests).toEqual([]);
  });
});

describe('a SCIM 2.0 target', () => {
  let scim: FakeScimServer;

  beforeEach(async () => {
    scim = await startFakeScimServer({ bearerToken: 'scim-token', groups: [] });
  });

  afterEach(async () => {
    await scim.close();
  });

  it('is flat: the run creates the account with no container_missing', async () => {
    const { id: targetId } = await createTarget(tenantId, provider, null, {
      type: 'scim2',
      name: 'Acme SCIM',
      config: { baseUrl: 'https://scim.fake.test', allowPrivateAddresses: true },
      bindPassword: 'scim-token',
    });
    await profileAndRule(targetId);
    await seedAnna();

    const { actions, exceptions, result } = await previewAndApply(
      targetId,
      pointedAt(scimTargetConnector, (config) => ({ ...config, baseUrl: scim.baseUrl })),
    );

    expect(exceptions.map((e) => e.kind)).not.toContain('container_missing');
    expect(actions.map((a) => a.actionType)).toContain('create_account');
    expect(actions.map((a) => a.actionType)).not.toContain('create_container');
    expect(result.failed).toBe(0);
    expect([...scim.users.values()].map((u) => u.userName)).toEqual(['anna.novak']);
  });
});
