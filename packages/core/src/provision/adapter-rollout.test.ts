import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  CONNECTOR_CAPABILITIES,
  connectorMetadataFromReleases,
  type ConnectorAdapterRelease,
  type ConnectorCapability,
  type ConnectorReleaseCatalog,
} from '@syntra/connectors';
import { FakeTarget } from '@syntra/connectors/testing';
import { verifyChain } from '../audit/audit-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun, ProvisionRunNotConfirmableError } from './apply.js';
import {
  AdapterSelectionError,
  AdapterVersionChangedError,
  AdapterWritesBlockedError,
  adapterWriteContext,
  clearDeprecationOverride,
  grantDeprecationOverride,
  rollbackTargetAdapter,
  setTargetAdapterSelection,
  targetAdapterReport,
} from './adapter-rollout.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 41));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-09-23T12:00:00Z');
const noSleep = async () => undefined;

let tenantId: string;
let targetId: string;
let actor: string;
let fake: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

const release = (over: Partial<ConnectorAdapterRelease> & { capabilities?: readonly ConnectorCapability[] } = {}): ConnectorAdapterRelease => {
  const { capabilities, ...rest } = over;
  return {
    adapterVersion: '1.0.0',
    connectorApiVersion: 1,
    channel: 'stable',
    supportState: 'supported',
    rollout: 'general',
    deprecationDate: null,
    certification: {
      contractVersion: 1,
      status: 'passed',
      verifiedAt: '2026-09-23',
      evidence: 'test fixture',
      capabilities: capabilities ?? CONNECTOR_CAPABILITIES,
    },
    ...rest,
  };
};

/** A catalog for the fixture's Active Directory target, built from releases. */
const catalogOf = (...releases: ConnectorAdapterRelease[]): ConnectorReleaseCatalog => (type) =>
  connectorMetadataFromReleases({ type, displayName: type, releases });

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config,
      bindPassword: 'secret',
    })
  ).id;
  fake = new FakeTarget();
  fake.containers.push(USERS);
  fake.entitlements.push({ externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' });
  const entitlementId = await withTenant(tenantId, async (tx) => {
    actor = (
      await tx.user.create({ data: { tenantId, login: 'reviewer', email: 'reviewer@acme.test', displayName: 'Reviewer' } })
    ).id;
    const person = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
    await tx.contract.create({
      data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: new Date('2020-01-01T00:00:00Z'), department: 'Finance' },
    });
    return (
      await tx.entitlement.create({
        data: { tenantId, targetSystemId: targetId, externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' },
      })
    ).id;
  });
  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: USERS,
    fallbackContainer: USERS,
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
});

const preview = (releaseCatalog?: ConnectorReleaseCatalog) =>
  previewProvisionRun(tenantId, provider, targetId, {
    now: NOW,
    connector: fake as never,
    ...(releaseCatalog === undefined ? {} : { releaseCatalog }),
  });

const apply = (runId: string, releaseCatalog?: ConnectorReleaseCatalog) =>
  applyProvisionRun(tenantId, provider, runId, {
    confirm: true,
    confirmedByUserId: actor,
    connector: fake as never,
    now: NOW,
    sleep: noSleep,
    ...(releaseCatalog === undefined ? {} : { releaseCatalog }),
  });

const runOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: runId } }));
const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }));

/** Everything a rollout must not touch: configuration, profile, rules, accounts. */
const storedIntent = () =>
  withTenant(tenantId, async (tx) => ({
    config: (await tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } })).config,
    profile: await tx.accountProfile.findFirstOrThrow({ where: { targetSystemId: targetId } }),
    rules: await tx.businessRule.findMany({ where: { targetSystemId: targetId }, include: { entitlements: true } }),
    accounts: await tx.targetAccount.findMany({ where: { targetSystemId: targetId }, orderBy: { id: 'asc' } }),
  }));

describe('capability enforcement at plan time', () => {
  it.each(['create_account', 'grant_entitlement'] as const)(
    'refuses %s when the exact release is not certified for it, visibly and without blocking the rest',
    async (capability) => {
      const narrow = catalogOf(release({ capabilities: CONNECTOR_CAPABILITIES.filter((c) => c !== capability) }));
      const run = await preview(narrow);
      expect(run.status).not.toBe('failed');

      const actions = await actionsOf(run.id);
      const refused = actions.filter((a) => a.status === 'refused');
      expect(refused.map((a) => a.actionType)).toEqual([capability]);
      expect(refused[0]!.message).toMatch(new RegExp(`adapter 1\\.0\\.0 is not certified to`));
      // The rest of the plan is still there to apply.
      expect(actions.filter((a) => a.status === 'proposed').map((a) => a.actionType)).not.toContain(capability);

      const persisted = await runOf(run.id);
      expect(persisted).toMatchObject({ adapterVersion: '1.0.0', capabilityRefusedCount: 1 });
      expect(persisted.capabilityRefusal).toMatch(/^1 action refused: activeDirectory adapter 1\.0\.0 is not certified/);

      const result = await apply(run.id, narrow);
      expect(result.refused).toBe(0);
      expect(fake.calls.map((c) => c.op)).not.toContain(capability);
      // A plan that could not do everything it proposed does not finish `applied`.
      expect(result.status).toBe('partially_applied');
    },
  );

  it('refuses every connector write through a release whose certification failed', async () => {
    const failed = catalogOf(release({ certification: { ...release().certification, status: 'failed' } }));
    const run = await preview(failed);
    const actions = await actionsOf(run.id);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.status === 'refused')).toBe(true);
    expect((await runOf(run.id)).capabilityRefusal).toMatch(/no passing certification \(failed\)/);
  });

  it('refuses at apply time a capability withdrawn after the preview, and records it on the run', async () => {
    const run = await preview();
    expect((await runOf(run.id)).capabilityRefusedCount).toBe(0);
    const withdrawn = catalogOf(release({ capabilities: CONNECTOR_CAPABILITIES.filter((c) => c !== 'grant_entitlement') }));
    const result = await apply(run.id, withdrawn);
    expect(result.refused).toBe(1);
    expect(fake.calls.map((c) => c.op)).toEqual(['create_account']);
    const grant = (await actionsOf(run.id)).find((a) => a.actionType === 'grant_entitlement')!;
    expect(grant).toMatchObject({ status: 'refused', attempts: 0 });
    expect(await runOf(run.id)).toMatchObject({ capabilityRefusedCount: 1, status: 'partially_applied' });
  });

  it('refuses what the configuration does not advertise even when certified', () => {
    // A document-driven target whose document declares a disable and no
    // entitlement operations: the release is certified to grant, this
    // configuration cannot.
    const context = adapterWriteContext({
      id: 't', type: 'httpJson',
      config: { document: { account: { disable: { method: 'POST', path: '/users/{id}/disable' } } } },
      adapterChannel: 'stable', adapterVersionPin: null,
      deprecationOverrideVersion: null, deprecationOverrideReason: null, deprecationOverrideExpiresAt: null,
    });
    expect(context.refusalFor('grant_entitlement')).toMatch(/does not advertise the ability to grant entitlements/);
    expect(context.refusalFor('disable_account')).toBeNull();
    // Syntra-only actions touch no adapter.
    expect(context.refusalFor('deactivate_syntra_user')).toBeNull();
  });
});

describe('canary and rollback', () => {
  const canaryCatalog = catalogOf(
    release({ adapterVersion: '1.0.0' }),
    // A new release on the canary channel, certified for less so its plans
    // are distinguishable.
    release({
      adapterVersion: '1.1.0',
      channel: 'canary',
      rollout: 'controlled',
      capabilities: CONNECTOR_CAPABILITIES.filter((c) => c !== 'grant_entitlement'),
    }),
  );

  it('canaries a new release on one target and rolls it back without changing stored intent', async () => {
    await setTargetAdapterSelection(tenantId, actor, targetId, { channel: 'canary', version: null, reason: 'Canary 1.1.0 on the pilot directory' }, { catalog: canaryCatalog, now: NOW });
    const canaryRun = await preview(canaryCatalog);
    expect(await runOf(canaryRun.id)).toMatchObject({ adapterVersion: '1.1.0', capabilityRefusedCount: 1 });
    expect((await targetAdapterReport(tenantId, targetId, { catalog: canaryCatalog, now: NOW })).selection)
      .toMatchObject({ channel: 'canary', rollbackVersion: '1.0.0' });
    // Captured after the canary preview reserved its accounts: the rollback
    // is what must leave all of this alone.
    const before = await storedIntent();

    await rollbackTargetAdapter(tenantId, actor, targetId, 'Canary misread group membership', { catalog: canaryCatalog, now: NOW });
    const report = await targetAdapterReport(tenantId, targetId, { catalog: canaryCatalog, now: NOW });
    expect(report.selection).toMatchObject({ channel: 'stable', pinnedVersion: '1.0.0', rollbackVersion: null });
    expect(report.effective).toMatchObject({ source: 'pin', release: { adapterVersion: '1.0.0' } });

    // The plan computed for the canary is not executed by the rolled-back code.
    await expect(apply(canaryRun.id, canaryCatalog)).rejects.toBeInstanceOf(AdapterVersionChangedError);
    expect(fake.calls).toEqual([]);
    expect((await runOf(canaryRun.id)).status).toBe(canaryRun.status);

    // Configuration, profile, rules and accounts are exactly what they were.
    expect(await storedIntent()).toEqual(before);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'provision.target.adapter' } }, orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([
      ['provision.target.adapter.select', actor],
      ['provision.target.adapter.rollback', actor],
    ]);
    expect(events[1]!.payload).toMatchObject({ fromVersion: '1.1.0', toVersion: '1.0.0' });
    expect(await withTenant(tenantId, (tx) => verifyChain(tx))).toMatchObject({ valid: true });
  });

  it('refuses a rollback with nowhere to go, an uncertified selection, and an unknown pin', async () => {
    await expect(rollbackTargetAdapter(tenantId, actor, targetId, 'Nothing to roll back to', { catalog: canaryCatalog }))
      .rejects.toBeInstanceOf(AdapterSelectionError);
    const uncertified = catalogOf(release(), release({ adapterVersion: '2.0.0', channel: 'canary', certification: { ...release().certification, status: 'not-run' } }));
    await expect(setTargetAdapterSelection(tenantId, actor, targetId, { channel: 'canary', version: null, reason: 'Try the untested one' }, { catalog: uncertified }))
      .rejects.toThrow(/no passing certification/);
    await expect(setTargetAdapterSelection(tenantId, actor, targetId, { channel: 'stable', version: '9.9.9', reason: 'Pin to nothing at all' }, { catalog: uncertified }))
      .rejects.toThrow(/no activeDirectory adapter release 9\.9\.9/);
  });
});

describe('deprecation', () => {
  const deprecated = catalogOf(release({ supportState: 'deprecated', deprecationDate: '2026-09-01' }));

  it('blocks new writes past the deprecation date until a bounded, audited override exists', async () => {
    const blocked = await preview(deprecated);
    expect(blocked).toMatchObject({ status: 'blocked', requiresConfirmation: false });
    expect(blocked.blockedReason).toMatch(/passed its deprecation date \(2026-09-01\)/);
    await expect(apply(blocked.id, deprecated)).rejects.toBeInstanceOf(ProvisionRunNotConfirmableError);

    const report = await targetAdapterReport(tenantId, targetId, { catalog: deprecated, now: NOW });
    expect(report.warnings[0]).toMatch(/passed its deprecation date/);
    expect(report.writesBlockedReason).not.toBeNull();

    await expect(grantDeprecationOverride(tenantId, actor, targetId, { reason: 'Migration scheduled next sprint', expiresAt: new Date(NOW.getTime() + 31 * 86_400_000) }, { catalog: deprecated, now: NOW }))
      .rejects.toThrow(/at most 30 days/);
    await grantDeprecationOverride(tenantId, actor, targetId, { reason: 'Migration scheduled next sprint', expiresAt: new Date(NOW.getTime() + 7 * 86_400_000) }, { catalog: deprecated, now: NOW });

    const allowed = await preview(deprecated);
    expect(allowed.status).not.toBe('failed');
    expect(allowed.blockedReason ?? '').not.toMatch(/deprecation/);

    // Past the override's expiry, the apply boundary refuses on its own --
    // the date can pass between a preview and its apply.
    await expect(
      applyProvisionRun(tenantId, provider, allowed.id, {
        confirm: true, confirmedByUserId: actor, connector: fake as never, sleep: noSleep,
        releaseCatalog: deprecated, now: new Date(NOW.getTime() + 8 * 86_400_000),
      }),
    ).rejects.toBeInstanceOf(AdapterWritesBlockedError);
    expect(fake.calls).toEqual([]);

    const result = await apply(allowed.id, deprecated);
    expect(result.applied).toBeGreaterThan(0);

    await clearDeprecationOverride(tenantId, actor, targetId, 'Migration finished early');
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'provision.target.adapter.deprecation' } }, orderBy: { sequence: 'asc' } }),
    );
    expect(events.map((e) => e.action)).toEqual([
      'provision.target.adapter.deprecation_override.grant',
      'provision.target.adapter.deprecation_override.clear',
    ]);
  });

  it('refuses an override for a release that is not deprecated', async () => {
    await expect(grantDeprecationOverride(tenantId, actor, targetId, { reason: 'Nothing to override here', expiresAt: new Date(NOW.getTime() + 86_400_000) }, { now: NOW }))
      .rejects.toThrow(/is not deprecated/);
  });

  it('enforces the 30-day bound in the database as well', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.targetSystem.update({
          where: { id: targetId },
          data: {
            deprecationOverrideVersion: '1.0.0', deprecationOverrideReason: 'Straight to the database',
            deprecationOverrideAt: NOW, deprecationOverrideExpiresAt: new Date(NOW.getTime() + 40 * 86_400_000),
            deprecationOverrideByUserId: actor,
          },
        }),
      ),
    ).rejects.toThrow(/TargetSystem_deprecation_override_valid/);
  });
});
