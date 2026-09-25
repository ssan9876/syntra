import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  AD_OU_NAME_MAX_LENGTH,
  deriveMirroredDns,
  mirrorPreview,
  switchToMirrored,
  syncMirroredContainers,
  type MirrorUnitFacts,
} from './org-unit-mirror.js';
import { containersForOrgUnit } from './org-unit-container-service.js';
import {
  createTarget,
  LadderConfigurationError,
  updateTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';

const ROOT = 'OU=Syntra,DC=acme,DC=test';

const unit = (id: string, name: string, parentId: string | null = null, status = 'active'): MirrorUnitFacts => ({
  id,
  name,
  parentId,
  status,
});

describe('deriveMirroredDns', () => {
  it('nests each unit under its ancestors, top-level unit nearest the root', () => {
    const { dns, problems } = deriveMirroredDns(
      [unit('a', 'ssander.local'), unit('b', 'IT', 'a'), unit('c', 'Helpdesk', 'b')],
      ROOT,
    );
    expect(problems).toEqual([]);
    expect(dns.get('a')).toBe(`OU=ssander.local,${ROOT}`);
    expect(dns.get('b')).toBe(`OU=IT,OU=ssander.local,${ROOT}`);
    expect(dns.get('c')).toBe(`OU=Helpdesk,OU=IT,OU=ssander.local,${ROOT}`);
  });

  it('escapes every name per RFC 4514, so a name cannot name another container', () => {
    const { dns } = deriveMirroredDns(
      [unit('a', 'Sales, West'), unit('b', '#1 = Best', 'a'), unit('c', ' padded ', 'a')],
      ROOT,
    );
    expect(dns.get('a')).toBe(`OU=Sales\\, West,${ROOT}`);
    expect(dns.get('b')).toBe(`OU=\\#1 \\= Best,OU=Sales\\, West,${ROOT}`);
    expect(dns.get('c')).toBe(`OU=\\ padded\\ ,OU=Sales\\, West,${ROOT}`);
  });

  it(`accepts a name of exactly ${AD_OU_NAME_MAX_LENGTH} characters and refuses one longer, by name, never truncating`, () => {
    const fits = 'x'.repeat(AD_OU_NAME_MAX_LENGTH);
    const long = 'q'.repeat(AD_OU_NAME_MAX_LENGTH + 1);
    const { dns, problems } = deriveMirroredDns(
      [unit('a', fits), unit('b', long), unit('c', 'Child', 'b')],
      ROOT,
    );
    expect(dns.get('a')).toBe(`OU=${fits},${ROOT}`);
    expect(dns.has('b')).toBe(false);
    expect(dns.has('c')).toBe(false);
    expect(problems).toEqual([
      expect.objectContaining({ orgUnitId: 'b', kind: 'name_too_long', message: expect.stringContaining('65 characters') }),
      expect.objectContaining({ orgUnitId: 'c', kind: 'ancestor_problem' }),
    ]);
    // Nothing anywhere holds a shortened name.
    expect([...dns.values()].some((dn) => dn.includes('q'))).toBe(false);
  });

  it('hangs the tree under whatever root it is given', () => {
    const { dns } = deriveMirroredDns([unit('a', 'IT')], 'OU=Org,OU=Syntra,DC=acme,DC=test');
    expect(dns.get('a')).toBe('OU=IT,OU=Org,OU=Syntra,DC=acme,DC=test');
  });

  it('mirrors active units only, but an inactive ancestor still names its place', () => {
    const { dns, problems } = deriveMirroredDns(
      [unit('a', 'Closed', null, 'inactive'), unit('b', 'Open', 'a')],
      ROOT,
    );
    expect(dns.has('a')).toBe(false);
    expect(dns.get('b')).toBe(`OU=Open,OU=Closed,${ROOT}`);
    expect(problems).toEqual([]);
  });

  it('refuses two units deriving one OU, and everything beneath them, rather than merging them', () => {
    const { dns, problems } = deriveMirroredDns(
      [unit('p', 'Corp'), unit('a', 'IT', 'p'), unit('b', 'it', 'p'), unit('c', 'Desk', 'a')],
      ROOT,
    );
    expect(dns.get('p')).toBe(`OU=Corp,${ROOT}`);
    expect(dns.has('a') || dns.has('b') || dns.has('c')).toBe(false);
    expect(problems.map((p) => [p.orgUnitId, p.kind]).sort()).toEqual([
      ['a', 'duplicate_dn'],
      ['b', 'duplicate_dn'],
      ['c', 'ancestor_problem'],
    ]);
  });

  it('reports a cycle instead of looping', () => {
    const { dns, problems } = deriveMirroredDns([unit('a', 'A', 'b'), unit('b', 'B', 'a')], ROOT);
    expect(dns.size).toBe(0);
    expect(problems.every((p) => p.kind === 'cycle')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Against the database, and through real runs against a FakeTarget.
// ---------------------------------------------------------------------------

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const BASE = 'DC=acme,DC=test';
const USERS = `OU=Users,${BASE}`;
const NOW = new Date('2026-06-15T00:00:00Z');
const noSleep = async () => undefined;

const adConfig = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: BASE,
  entitlementSearchBase: `OU=Groups,${BASE}`,
  archiveContainer: `OU=Archive,${BASE}`,
};

let tenantId: string;
let targetId: string;
let fake: FakeTarget;
let reviewerId: string;
let localId: string;
let itId: string;

const LOCAL_DN = `OU=ssander.local,${ROOT}`;
const IT_DN = `OU=IT,${LOCAL_DN}`;

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config: adConfig,
      bindPassword: 'secret',
    })
  ).id;
  fake = new FakeTarget();
  fake.containers.push(BASE, USERS);

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
    name: 'Everybody in Finance',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [],
  });

  ({ reviewerId, localId, itId } = await withTenant(tenantId, async (tx) => {
    const reviewer = await tx.user.create({
      data: { tenantId, login: 'reviewer', email: 'reviewer@acme.test', displayName: 'Reviewer' },
    });
    const local = await tx.orgUnit.create({ data: { tenantId, name: 'ssander.local' } });
    const it = await tx.orgUnit.create({ data: { tenantId, name: 'IT', parentId: local.id } });
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak', orgUnitId: it.id },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01T00:00:00Z'),
        department: 'Finance',
      },
    });
    return { reviewerId: reviewer.id, localId: local.id, itId: it.id };
  }));
});

const mirror = (orgUnitRootDn: string | null = ROOT) =>
  updateTarget(tenantId, provider, reviewerId, targetId, { mirrorOrgUnits: true, orgUnitRootDn });

const preview = () =>
  previewProvisionRun(tenantId, provider, targetId, { now: NOW, connector: fake as never });

const applyConfirmed = (runId: string) =>
  applyProvisionRun(tenantId, provider, runId, {
    confirm: true,
    confirmedByUserId: reviewerId,
    connector: fake as never,
    now: NOW,
    sleep: noSleep,
  });

const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

const rows = () =>
  withTenant(tenantId, (tx) =>
    tx.orgUnitContainer.findMany({ where: { targetSystemId: targetId }, orderBy: { dn: 'asc' } }),
  );

const accountDn = () => [...fake.objects.values()][0]?.dn ?? null;

describe('the mirror setting', () => {
  it('is audited from/to, and turning it on writes nothing to the directory', async () => {
    await mirror();
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(target).toMatchObject({ mirrorOrgUnits: true, orgUnitRootDn: ROOT });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.target.update' }, orderBy: { sequence: 'asc' } }),
    );
    expect(events.at(-1)!.payload).toMatchObject({
      mirrorOrgUnits: { from: false, to: true },
      orgUnitRootDn: { from: null, to: ROOT },
    });
    // No row, no run, no container: the setting alone changes nothing.
    expect(await rows()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a root that is not below the base DN', async () => {
    await expect(mirror('OU=Elsewhere,DC=other,DC=test')).rejects.toBeInstanceOf(LadderConfigurationError);
  });

  it('refuses mirroring on a target that does not place accounts in containers', async () => {
    const scim = await createTarget(tenantId, provider, null, {
      type: 'scim2',
      name: 'SCIM',
      config: { baseUrl: 'https://scim.example.test/scim/v2' },
      bindPassword: 'token',
    });
    await expect(
      updateTarget(tenantId, provider, reviewerId, scim.id, { mirrorOrgUnits: true }),
    ).rejects.toMatchObject({ code: 'mirror-unsupported', field: 'mirrorOrgUnits' });
  });
});

describe('a mirroring run', () => {
  it('creates a two-level missing tree parent first, including the missing root, and places the account in it', async () => {
    await mirror();
    const run = await preview();
    const planned = await actionsOf(run.id);
    const containers = planned.filter((a) => a.actionType === 'create_container');
    expect(containers.map((a) => (a.after as { dn: string }).dn)).toEqual([ROOT, LOCAL_DN, IT_DN]);
    const create = planned.find((a) => a.actionType === 'create_account')!;
    expect((create.after as { container: string }).container).toBe(IT_DN);
    expect(planned.indexOf(create)).toBeGreaterThan(planned.indexOf(containers.at(-1)!));

    await applyConfirmed(run.id);
    expect(fake.containers).toEqual(expect.arrayContaining([ROOT, LOCAL_DN, IT_DN]));
    expect(accountDn()).toBe(`CN=anna.novak,${IT_DN}`);
    const stored = await rows();
    expect(stored.map((r) => [r.dn, r.source, r.state])).toEqual([
      [IT_DN, 'mirrored', 'live'],
      [LOCAL_DN, 'mirrored', 'live'],
    ]);
    expect(stored.every((r) => r.anchor !== null)).toBe(true);

    // Converged: the next run proposes no structure.
    const again = await actionsOf((await preview()).id);
    expect(again.filter((a) => a.actionType.endsWith('_container'))).toEqual([]);
  });

  it('moves the OU, with the accounts in it, when a unit is renamed -- held for a person first', async () => {
    await mirror();
    await applyConfirmed((await preview()).id);

    await withTenant(tenantId, (tx) =>
      tx.orgUnit.update({ where: { id: localId }, data: { name: 'corp' } }),
    );
    const CORP = `OU=corp,${ROOT}`;
    const run = await preview();
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toContain('would move 1 container');

    const planned = await actionsOf(run.id);
    const moves = planned.filter((a) => a.actionType === 'move_container');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.after).toMatchObject({ fromDn: LOCAL_DN, dn: CORP, accounts: ['anna.novak'] });
    // The child rides along; nobody is moved one by one.
    expect(planned.map((a) => a.actionType)).toEqual(['move_container']);

    await applyConfirmed(run.id);
    expect(fake.containers).toEqual(expect.arrayContaining([CORP, `OU=IT,${CORP}`]));
    expect(fake.containers).not.toContain(LOCAL_DN);
    expect(accountDn()).toBe(`CN=anna.novak,OU=IT,${CORP}`);
    expect((await rows()).every((r) => r.previousDn === null)).toBe(true);

    const after = await actionsOf((await preview()).id);
    expect(after).toEqual([]);
  });

  it('moves a re-parented unit under its new parent', async () => {
    await mirror();
    await applyConfirmed((await preview()).id);
    // IT moves to the top level.
    await withTenant(tenantId, (tx) => tx.orgUnit.update({ where: { id: itId }, data: { parentId: null } }));
    const run = await preview();
    const moves = (await actionsOf(run.id)).filter((a) => a.actionType === 'move_container');
    expect(moves.map((a) => a.after)).toEqual([
      expect.objectContaining({ fromDn: IT_DN, dn: `OU=IT,${ROOT}` }),
    ]);
    await applyConfirmed(run.id);
    expect(accountDn()).toBe(`CN=anna.novak,OU=IT,${ROOT}`);
  });

  it('leaves a deactivated unit\'s OU and its accounts where they are, reported as no longer mirrored', async () => {
    await mirror();
    await applyConfirmed((await preview()).id);
    await withTenant(tenantId, (tx) =>
      tx.orgUnit.update({ where: { id: itId }, data: { status: 'inactive', name: 'IT (closed)' } }),
    );
    const run = await preview();
    expect((await actionsOf(run.id)).filter((a) => a.actionType.endsWith('_container'))).toEqual([]);
    expect(fake.containers).toContain(IT_DN);
    const itRow = (await rows()).find((r) => r.orgUnitId === itId)!;
    expect(itRow).toMatchObject({ dn: IT_DN, previousDn: null });

    const view = await mirrorPreview(tenantId, targetId);
    expect(view!.units.find((u) => u.id === itId)).toMatchObject({ placement: 'not_mirrored', effectiveDn: IT_DN });
  });

  it('lets a manual row win, and "Switch to mirrored" turns it into a move', async () => {
    const FLAT = `OU=IT,${ROOT}`;
    fake.containers.push(ROOT, FLAT);
    await withTenant(tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: { tenantId, orgUnitId: itId, targetSystemId: targetId, dn: FLAT, state: 'adopted', source: 'manual' },
      }),
    );
    await mirror();
    await withTenant(tenantId, (tx) =>
      syncMirroredContainers(tx, {
        tenantId,
        target: { id: targetId, type: 'activeDirectory', config: adConfig, mirrorOrgUnits: true, orgUnitRootDn: ROOT },
        actorUserId: null,
      }),
    );
    // Untouched by the mirror.
    expect((await rows()).find((r) => r.orgUnitId === itId)).toMatchObject({ dn: FLAT, source: 'manual' });
    const views = await withTenant(tenantId, (tx) => containersForOrgUnit(tx, itId));
    expect(views[0]).toMatchObject({ dn: FLAT, source: 'manual', mirroring: true, derivedDn: IT_DN });

    const switched = await switchToMirrored(tenantId, {
      orgUnitId: itId,
      targetSystemId: targetId,
      actorUserId: reviewerId,
      sourceIp: null,
    });
    expect(switched).toEqual({ ok: true, dn: IT_DN, pendingMoveFrom: FLAT });
    expect((await rows()).find((r) => r.orgUnitId === itId)).toMatchObject({
      dn: IT_DN,
      source: 'mirrored',
      previousDn: FLAT,
    });

    // The run creates `ssander.local` first, then moves the flat OU under it.
    const run = await preview();
    const structure = (await actionsOf(run.id)).filter((a) => a.actionType.endsWith('_container'));
    expect(structure.map((a) => [a.actionType, (a.after as { dn: string }).dn])).toEqual([
      ['create_container', LOCAL_DN],
      ['move_container', IT_DN],
    ]);
    await applyConfirmed(run.id);
    expect(fake.containers).toContain(IT_DN);
    expect(fake.containers).not.toContain(FLAT);
  });

  it('refuses to switch a row on a target that does not mirror', async () => {
    await withTenant(tenantId, (tx) =>
      tx.orgUnitContainer.create({
        data: { tenantId, orgUnitId: itId, targetSystemId: targetId, dn: `OU=IT,${BASE}`, source: 'manual' },
      }),
    );
    const outcome = await switchToMirrored(tenantId, {
      orgUnitId: itId,
      targetSystemId: targetId,
      actorUserId: reviewerId,
      sourceIp: null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'not_mirroring' });
  });
});

describe('mirrorPreview', () => {
  it('shows the tree -> DN mapping before mirroring is on, with an unsaved root', async () => {
    const view = await mirrorPreview(tenantId, targetId, { rootOverride: 'OU=Org,DC=acme,DC=test' });
    expect(view).toMatchObject({ mirrorOrgUnits: false, placesAccountsInContainers: true, rootDn: 'OU=Org,DC=acme,DC=test' });
    expect(view!.units.find((u) => u.id === itId)).toMatchObject({
      depth: 1,
      derivedDn: 'OU=IT,OU=ssander.local,OU=Org,DC=acme,DC=test',
      placement: 'unplaced',
    });
  });

  it('names a root outside the base as the problem', async () => {
    const view = await mirrorPreview(tenantId, targetId, { rootOverride: 'OU=X,DC=elsewhere' });
    expect(view!.rootProblem).toContain('not below');
  });
});
