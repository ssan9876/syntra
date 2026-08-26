import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ldapWriteback } from '@syntra/connectors';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createSource } from '../sync/source-service.js';
import { createUser } from './user-service.js';
import {
  deactivateDirectoryUser,
  reactivateDirectoryUser,
} from './directory-writeback.js';
import type { Scheduler } from '../jobs/scheduler.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 17));

let tenantId: string;
let sourceId: string;
let userId: string;
let personId: string;
let actorUserId: string;

const sourceInput = {
  name: 'Head office AD',
  config: {
    url: 'ldaps://ad.acme.test',
    bindDn: 'cn=svc,dc=acme,dc=test',
    userSearchBase: 'ou=People,dc=acme,dc=test',
    groupSearchBase: 'ou=Groups,dc=acme,dc=test',
    anchorAttribute: 'objectGUID',
  },
  bindPassword: 'bind-secret',
};

/**
 * The connector is stubbed, deliberately. What it does against a real
 * directory is proved by `writeback.integration.test.ts` against live Samba;
 * what THIS file is about is the order the two writes happen in and what is
 * left behind when one of them fails, which no directory can demonstrate.
 */
const setEnabled = vi.spyOn(ldapWriteback, 'setEnabled');

beforeEach(async () => {
  await resetDatabase();
  setEnabled.mockReset();
  setEnabled.mockResolvedValue({ ok: true, message: 'disabled' });

  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      ...sourceInput,
      writebackEnabled: true,
      writebackDisable: true,
    });
    sourceId = source.id;

    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    personId = person.id;

    const user = await createUser(tx, {
      login: 'anna.novak',
      email: 'anna.novak@acme.test',
      displayName: 'Anna Novak',
    });
    userId = user.id;
    await tx.user.update({
      where: { id: user.id },
      data: { sourceId, sourceAnchor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', personId },
    });

    const actor = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    actorUserId = actor.id;
  });
});

afterEach(() => setEnabled.mockReset());

const deactivate = () =>
  deactivateDirectoryUser(tenantId, provider, {
    userId,
    reason: 'left the company',
    actorUserId,
  });

const readUser = () =>
  withTenant(tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }));

const readPerson = () =>
  withTenant(tenantId, (tx) =>
    tx.person.findUniqueOrThrow({ where: { id: personId } }),
  );

const setFlags = (flags: Record<string, boolean>) =>
  withTenant(tenantId, (tx) =>
    tx.directorySource.update({ where: { id: sourceId }, data: flags }),
  );

describe('deactivateDirectoryUser', () => {
  it('disables the account in the directory and in Syntra', async () => {
    const outcome = await deactivate();

    expect(outcome).toMatchObject({ ok: true, viaDirectory: true });
    expect(setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ bindPassword: 'bind-secret' }),
      expect.objectContaining({
        anchor: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        enabled: false,
        reason: 'left the company',
      }),
    );
    expect((await readUser()).status).toBe('inactive');
  });

  /**
   * The refusal that keeps the button honest. A local-only status change on a
   * directory-managed account is undone by the next sync run, so doing it
   * quietly would hand somebody a button that appears to work and does not.
   */
  it('refuses when write-back is not enabled, and changes nothing', async () => {
    await setFlags({ writebackDisable: false });

    const outcome = await deactivate();

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'writeback_not_enabled',
      sourceName: 'Head office AD',
    });
    expect(setEnabled).not.toHaveBeenCalled();
    expect((await readUser()).status).toBe('active');
  });

  it('refuses when the master switch is off even if the sub-flag is on', async () => {
    await setFlags({ writebackEnabled: false, writebackDisable: true });
    expect(await deactivate()).toMatchObject({ reason: 'writeback_not_enabled' });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  /**
   * Directory first. A failure has to leave both systems agreeing that
   * nothing happened -- the other ordering leaves Syntra believing something
   * the directory never accepted, which is the divergence this exists to end.
   */
  it('changes nothing locally when the directory refuses', async () => {
    setEnabled.mockResolvedValue({
      ok: false,
      failure: 'unauthorized',
      message: 'the connection lacks the rights',
    });

    const outcome = await deactivate();

    expect(outcome).toMatchObject({ ok: false, reason: 'directory_failed' });
    expect((await readUser()).status).toBe('active');
    expect((await readPerson()).departureOverride).toBeNull();
  });

  it('audits a refused attempt, so a broken bind is visible', async () => {
    setEnabled.mockResolvedValue({ ok: false, failure: 'transient', message: 'down' });
    await deactivate();

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'user.deactivate' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });

  /**
   * The step that makes this "part of the automation" rather than a flag flip:
   * the person goes onto Provision's ladder, and entitlement revocation, the
   * archive and the eventual reap all follow from the date stamped here.
   */
  it('puts the person onto the leaver ladder', async () => {
    const outcome = await deactivate();

    expect(outcome).toMatchObject({ ladderStarted: true });
    const person = await readPerson();
    expect(person.departureOverride).toBeInstanceOf(Date);
    expect(person.departureOverrideBy).toBe(actorUserId);
    expect(person.departureOverrideNote).toBe('left the company');
  });

  /**
   * A directory account with no HR record is ordinary, not an error: no
   * contracts, no rules, no provisioned account. Disabling it is the whole of
   * what there is to do.
   */
  it('still disables a user who is linked to no person', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: userId }, data: { personId: null } }),
    );

    const outcome = await deactivate();

    expect(outcome).toMatchObject({ ok: true, ladderStarted: false });
    expect((await readUser()).status).toBe('inactive');
  });

  it('revokes sessions, as the local path always did', async () => {
    await withTenant(tenantId, (tx) =>
      tx.session.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'b'.repeat(64),
          scope: 'portal',
          absoluteExpiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    );

    await deactivate();

    const live = await withTenant(tenantId, (tx) =>
      tx.session.count({ where: { userId, revokedAt: null } }),
    );
    expect(live).toBe(0);
  });

  /** A locally-managed account never had this problem and keeps its old path. */
  it('deactivates a local user without touching any directory', async () => {
    const localId = await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'local.only',
        email: 'local.only@acme.test',
        displayName: 'Local Only',
      });
      return u.id;
    });

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId: localId,
      reason: 'left',
      actorUserId,
    });

    expect(outcome).toMatchObject({ ok: true, viaDirectory: false });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('reports a user that is not there', async () => {
    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId: '00000000-0000-0000-0000-000000000000',
      reason: 'left',
      actorUserId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  /** The bind password must not reach the audit trail by any route. */
  it('never records the bind password', async () => {
    await deactivate();
    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany());
    expect(JSON.stringify(events)).not.toContain('bind-secret');
  });
});

describe('reactivateDirectoryUser', () => {
  it('clears the disable bit, the status and the ladder stamp together', async () => {
    await deactivate();
    setEnabled.mockResolvedValue({ ok: true, message: 'enabled' });

    const outcome = await reactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'came back',
      actorUserId,
    });

    expect(outcome).toMatchObject({ ok: true, viaDirectory: true });
    expect(setEnabled).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
    expect((await readUser()).status).toBe('active');
    // Left set, the ladder would archive and then reap somebody who is back.
    expect((await readPerson()).departureOverride).toBeNull();
  });

  it('leaves the deactivation in place when the directory refuses', async () => {
    await deactivate();
    setEnabled.mockResolvedValue({ ok: false, failure: 'transient', message: 'down' });

    const outcome = await reactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'came back',
      actorUserId,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'directory_failed' });
    expect((await readUser()).status).toBe('inactive');
    expect((await readPerson()).departureOverride).toBeInstanceOf(Date);
  });
});

describe('the ladder starts at the deactivation', () => {
  /**
   * A minimal `Scheduler` fake, local to this file: `deactivateDirectoryUser`
   * only ever calls `enqueue`, and the file-level `FakeScheduler` in
   * apps/api/src/test-support.ts is not importable from packages/core.
   */
  const fakeScheduler = (): Scheduler & { enqueued: { name: string; data: unknown }[] } => {
    const enqueued: { name: string; data: unknown }[] = [];
    return {
      enqueued,
      async start() {},
      async stop() {},
      register() {},
      async enqueue(name: string, data: unknown) {
        enqueued.push({ name, data });
        return 'job-1';
      },
      async schedule() {},
      async unschedule() {},
    } as unknown as Scheduler & { enqueued: { name: string; data: unknown }[] };
  };

  /** A target system holding this person a live account, for the ladder to enqueue against. */
  const givePersonATargetAccount = () =>
    withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 'target/ad/bind',
          config: { url: 'ldaps://dc.acme.test:636', tlsMode: 'ldaps' },
        },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          personId,
          anchor: 'a1',
          correlationKey: 'anna.novak',
          status: 'active',
        },
      });
      return target.id;
    });

  /**
   * Write-back design section 7.2 step 6: a Provision run is enqueued after an
   * administrative deactivation. Nothing did, so the leaver's entitlement
   * revocation, the archive into the deactivated OU and the reap on the domain
   * controller all waited for the next SCHEDULED run -- on a change whose
   * whole point is that it happens now, and whose console copy says the leaver
   * steps "follow from today".
   */
  it('enqueues a run for every target holding this person an account', async () => {
    const scheduler = fakeScheduler();
    const targetId = await givePersonATargetAccount();

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'left the organization',
      actorUserId,
      scheduler,
    });

    expect(outcome).toMatchObject({ ok: true, ladderStarted: true, runsEnqueued: 1 });
    expect(scheduler.enqueued).toEqual([
      { name: 'provision.run', data: { tenantId, targetSystemId: targetId } },
    ]);
  });

  /**
   * A user with no linked person has no contracts, no entitlement rules and no
   * provisioned account -- the disable is the whole of what there is to do --
   * so there is nothing to enqueue and nothing is.
   */
  it('enqueues nothing for a user with no person behind them', async () => {
    const scheduler = fakeScheduler();
    const unlinkedId = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'svc.backup',
        email: 'svc.backup@acme.test',
        displayName: 'Backup Service',
      });
      await tx.user.update({
        where: { id: user.id },
        data: { sourceId, sourceAnchor: 'ffffffff-0000-0000-0000-000000000001' },
      });
      return user.id;
    });

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId: unlinkedId,
      reason: 'service account retired',
      actorUserId,
      scheduler,
    });
    expect(outcome).toMatchObject({ ok: true, ladderStarted: false, runsEnqueued: 0 });
    expect(scheduler.enqueued).toHaveLength(0);
  });

  /**
   * And a failed directory write enqueues nothing either: the account is
   * exactly as it was, so a Provision run would be acting on a departure that
   * did not happen.
   */
  it('enqueues nothing when the directory refused the disable', async () => {
    const scheduler = fakeScheduler();
    setEnabled.mockResolvedValue({ ok: false, failure: 'transient', message: 'down' });
    await givePersonATargetAccount();

    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'left',
      actorUserId,
      scheduler,
    });
    expect(outcome.ok).toBe(false);
    expect(scheduler.enqueued).toHaveLength(0);
  });

  /** No scheduler is not an error: the tests that are not about it pass none. */
  it('is a no-op without a scheduler', async () => {
    await givePersonATargetAccount();
    const outcome = await deactivateDirectoryUser(tenantId, provider, {
      userId,
      reason: 'left',
      actorUserId,
    });
    expect(outcome).toMatchObject({ ok: true, runsEnqueued: 0 });
  });
});
