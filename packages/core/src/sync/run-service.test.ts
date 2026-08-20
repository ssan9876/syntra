import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { ldapConnector } from '@syntra/connectors';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createGroup } from '../directory/group-service.js';
import { createUser } from '../directory/user-service.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';
import { applyChange } from './apply.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 5));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'ou=Shared,dc=acme,dc=test',
  groupSearchBase: 'ou=Shared,dc=acme,dc=test',
  orgUnitSearchBase: 'ou=Shared,dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Test LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('previewRun', () => {
  it('proposes creates on a first run and applies none of them', async () => {
    const run = await previewRun(tenantId, provider, sourceId);

    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBeGreaterThan(0);

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    expect(changes.filter((c) => c.changeType === 'create_user')).toHaveLength(2);
    expect(changes.every((c) => c.status === 'proposed')).toBe(true);

    // Nothing has been written to the directory yet.
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('proposes nothing on a second run over an unchanged directory', async () => {
    const first = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, first.id);

    const second = await previewRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes).toEqual([]);
  });

  it('reports a collision with a locally created account as a conflict', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );

    const run = await previewRun(tenantId, provider, sourceId);
    const conflicts = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id, status: 'conflict' } }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.message).toMatch(/locally managed/i);
  });

  it('never proposes deactivating a record it merely failed to map', async () => {
    // The failure mode this whole subsystem exists to prevent, arriving
    // through the mapping door: an attribute disappears from a subset of the
    // directory, those records stop mapping, and — before this — every one of
    // them looked absent and was proposed for deactivation.
    const first = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, first.id);

    await withTenant(tenantId, (tx) =>
      setMappings(
        tx,
        sourceId,
        DEFAULT_MAPPINGS.openLdap.map((rule) =>
          rule.objectType === 'user' && rule.isCorrelation
            ? { ...rule, sourceAttribute: 'attributeTheServerStoppedSending' }
            : rule,
        ),
      ),
    );

    const second = await previewRun(tenantId, provider, sourceId);

    expect(second.status).toBe('previewed');
    expect(second.mappingFailures).toBe(2);
    expect(second.mappingFailureReasons).toEqual([
      'the correlation attribute is missing from this record',
    ]);

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes.filter((c) => c.changeType === 'deactivate_user')).toEqual([]);
    // Nor are their group memberships quietly revoked instead.
    expect(changes.filter((c) => c.changeType === 'remove_member')).toEqual([]);

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.every((u) => u.status === 'active')).toBe(true);
  });

  it('proposes no membership removal for a group the connector could not read in full', async () => {
    // Active Directory hands back `member;range=0-1499` for a group above its
    // value-range limit, so `member` is absent and a naive read sees an empty
    // group. Before this, that proposed removing every member it had.
    const first = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, first.id);

    const real = ldapConnector.read.bind(ldapConnector);
    vi.spyOn(ldapConnector, 'read').mockImplementation(async function* (config) {
      for await (const record of real(config)) {
        if (record.objectType === 'group') {
          const { memberDns: _dropped, ...rest } = record;
          yield { ...rest, readFailure: 'membership came back range-truncated' };
        } else {
          yield record;
        }
      }
    });

    const second = await previewRun(tenantId, provider, sourceId);

    expect(second.mappingFailures).toBe(1);
    expect(second.mappingFailureReasons).toEqual([
      'membership came back range-truncated',
    ]);

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes.filter((c) => c.changeType === 'remove_member')).toEqual([]);
    expect(changes.filter((c) => c.changeType === 'deactivate_group')).toEqual([]);

    // The membership it already had is untouched.
    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany(),
    );
    expect(memberships).toHaveLength(1);
  });

  it('completes when the directory read takes longer than a transaction may', async () => {
    // Prisma's default interactive-transaction timeout is 5 seconds. A read
    // that takes longer than that must still produce a previewed run, which
    // it can only do if the read happens outside a transaction. This fails
    // with P2028 the moment anyone puts the read back inside `withTenant`.
    const real = ldapConnector.read.bind(ldapConnector);
    vi.spyOn(ldapConnector, 'read').mockImplementation(async function* (config) {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      yield* real(config);
    });

    const run = await previewRun(tenantId, provider, sourceId);

    expect(run.error).toBeNull();
    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBeGreaterThan(0);
  });
});

describe('applyRun', () => {
  it('creates the users the preview proposed', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    const applied = await applyRun(tenantId, run.id);

    expect(applied.status).toBe('applied');
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.map((u) => u.login).sort()).toEqual(['jdoe', 'sroe']);
    expect(users.every((u) => u.sourceId === sourceId)).toBe(true);
    expect(users.every((u) => u.sourceAnchor !== null)).toBe(true);
  });

  it('brings group memberships across', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ include: { user: true, group: true } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.user.login).toBe('jdoe');
    expect(memberships[0]!.group.name).toBe('Nurses');
  });

  it('does not let one conflicting group make the whole run partially applied', async () => {
    // The fixture's Nurses group collides with a locally managed one, so it
    // is a conflict and is never created. Proposing memberships against it
    // guaranteed an add_member that could not resolve its group at apply
    // time, and a run that reported itself half-broken while every appliable
    // change applied cleanly.
    await withTenant(tenantId, (tx) => createGroup(tx, 'Nurses'));

    const run = await previewRun(tenantId, provider, sourceId);
    const proposed = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    expect(
      proposed.filter((c) => c.changeType === 'add_member'),
    ).toEqual([]);
    expect(
      proposed.filter((c) => c.status === 'conflict').map((c) => c.changeType),
    ).toEqual(['create_group']);

    const applied = await applyRun(tenantId, run.id);
    expect(applied.status).toBe('applied');

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id, status: 'failed' } }),
    );
    expect(changes).toEqual([]);
  });

  it('never applies a conflict', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );
    const run = await previewRun(tenantId, provider, sourceId);
    const applied = await applyRun(tenantId, run.id);

    const local = await withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { login: 'jdoe' } }),
    );
    // The hand-made account is untouched: still local, still its own email.
    expect(local!.sourceId).toBeNull();
    expect(local!.email).toBe('local@acme.test');

    // And the run says so honestly. The conflict is reported as a conflict;
    // everything appliable applied, so the run is `applied` and not
    // `partially_applied` — the report has to distinguish "one object needs a
    // decision" from "part of this run did not land".
    expect(applied.status).toBe('applied');
    const failedChanges = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id, status: 'failed' } }),
    );
    expect(failedChanges).toEqual([]);
  });

  it('does not propose a membership for a conflicting user', async () => {
    // The fixture's jdoe is a member of Nurses. With a locally managed jdoe
    // already in Syntra, the source's jdoe is a conflict and is never created
    // with this source's anchor, so an `add_member` naming that anchor could
    // only ever fail its user lookup at apply time.
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );

    const run = await previewRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );

    expect(changes.filter((c) => c.changeType === 'add_member')).toEqual([]);
    // Not proposed is not the same as removed: Syntra holds no membership for
    // this person, so there is nothing to revoke either.
    expect(changes.filter((c) => c.changeType === 'remove_member')).toEqual([]);
    expect(
      changes.filter((c) => c.status === 'conflict').map((c) => c.changeType),
    ).toEqual(['create_user']);
  });

  it('keeps a membership Syntra already holds when the member turns into a conflict', async () => {
    // The dangerous half of the same fix. Skipping a conflicting member
    // outright would drop their anchor from the desired membership, and
    // `desired` is differenced against what Syntra holds — so the omission
    // reads as `remove_member` and revokes a real person's real access.
    const first = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, first.id);

    const jdoe = await withTenant(tenantId, (tx) =>
      tx.user.findFirstOrThrow({ where: { login: 'jdoe' } }),
    );

    // A second directory starts claiming jdoe. The anchor lookup no longer
    // finds the row for this source, the correlation key does, and it is
    // owned by someone else: a conflict, exactly as the spec requires. The
    // row keeps its anchor, so Syntra still holds the Nurses membership under
    // it.
    await withTenant(tenantId, async (tx) => {
      const other = await createSource(tx, provider, {
        name: 'Second directory',
        config,
        bindPassword: 'adminpassword',
      });
      await tx.user.update({
        where: { id: jdoe.id },
        data: { sourceId: other.id },
      });
    });

    const second = await previewRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: second.id } }),
    );

    expect(changes.filter((c) => c.changeType === 'remove_member')).toEqual([]);
    expect(
      changes.filter((c) => c.status === 'conflict').map((c) => c.changeType),
    ).toEqual(['create_user']);

    const applied = await applyRun(tenantId, second.id);
    expect(applied.status).toBe('applied');

    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany(),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.userId).toBe(jdoe.id);
  });

  it('writes an audit event for every applied change', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'sync.' } } }),
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it('applies only the changes it was asked to', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({
        where: { runId: run.id, changeType: 'create_user' },
      }),
    );

    const applied = await applyRun(tenantId, run.id, { only: [changes[0]!.id] });
    expect(applied.status).toBe('partially_applied');

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toHaveLength(1);
  });

  it('refuses to apply a blocked run', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: { status: 'blocked', blockedReason: 'test' },
      }),
    );

    await expect(applyRun(tenantId, run.id)).rejects.toThrow(/blocked/i);
  });

  it('refuses a requires-confirmation run that was not confirmed', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'blocked',
          requiresConfirmation: true,
          blockedReason: 'over the threshold',
        },
      }),
    );

    await expect(applyRun(tenantId, run.id)).rejects.toThrow(/blocked/i);
  });

  it('applies a requires-confirmation run when the caller confirms it', async () => {
    // A genuine cohort departure — a contractor batch, a closed site — has to
    // be processable through sync rather than by hand.
    const run = await previewRun(tenantId, provider, sourceId);
    await withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'blocked',
          requiresConfirmation: true,
          blockedReason: 'over the threshold',
        },
      }),
    );

    const applied = await applyRun(tenantId, run.id, { confirm: true });

    expect(applied.status).toBe('applied');
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.map((u) => u.login).sort()).toEqual(['jdoe', 'sroe']);
  });

  it('refuses a run that read nothing however hard the caller confirms', async () => {
    // The zero-record refusal is not confirmable: an empty directory and an
    // unreachable one are indistinguishable from here.
    const run = await previewRun(tenantId, provider, sourceId);
    await withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'blocked',
          requiresConfirmation: false,
          blockedReason: 'the source returned no records',
        },
      }),
    );

    await expect(
      applyRun(tenantId, run.id, { confirm: true }),
    ).rejects.toThrow(/blocked/i);
  });
});

describe('applyChange membership failure paths', () => {
  it('marks add_member failed and audits outcome failure when the group or member cannot be resolved', async () => {
    const { updated, events } = await withTenant(tenantId, async (tx) => {
      const run = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: run.id,
          changeType: 'add_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: 'group-anchor-x',
          after: { groupAnchor: 'no-such-group', memberAnchor: 'no-such-member' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, run.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.add_member' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/not found/i);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });

  it('marks remove_member failed and audits outcome failure when the group or member cannot be resolved', async () => {
    const { updated, events } = await withTenant(tenantId, async (tx) => {
      const run = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: run.id,
          changeType: 'remove_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: 'group-anchor-y',
          before: { groupAnchor: 'no-such-group', memberAnchor: 'no-such-member' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, run.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.remove_member' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/not found/i);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });

  it('applies remove_member and audits outcome success when the group and member resolve but the membership was already absent', async () => {
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const { updated, events, membershipsBefore, membershipsAfter } = await withTenant(
      tenantId,
      async (tx) => {
        const group = await tx.group.findFirstOrThrow({ where: { sourceId } });
        // sroe is deliberately not a member of Nurses (only jdoe is): this
        // exercises the "resolved, but nothing to remove" idempotent path,
        // not an accidental removal of a real membership.
        const user = await tx.user.findFirstOrThrow({ where: { sourceId, login: 'sroe' } });

        const membershipsBefore = await tx.groupMembership.count({
          where: { groupId: group.id, userId: user.id },
        });

        const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
        const change = await tx.syncChange.create({
          data: {
            tenantId,
            runId: newRun.id,
            changeType: 'remove_member',
            targetType: 'GroupMembership',
            targetId: null,
            sourceAnchor: group.sourceAnchor,
            before: { groupAnchor: group.sourceAnchor, memberAnchor: user.sourceAnchor },
            status: 'proposed',
          },
        });

        await applyChange(tx, change, sourceId, newRun.id);

        const membershipsAfter = await tx.groupMembership.count({
          where: { groupId: group.id, userId: user.id },
        });

        return {
          updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
          events: await tx.auditEvent.findMany({
            where: { action: 'sync.remove_member' },
          }),
          membershipsBefore,
          membershipsAfter,
        };
      },
    );

    // Discriminates "removed a real row" from "was already absent": both
    // counts are zero throughout, so this run genuinely had nothing to do.
    expect(membershipsBefore).toBe(0);
    expect(membershipsAfter).toBe(0);
    expect(updated!.status).toBe('applied');
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('success');
  });

  it('applies a change ONCE even when two applies hold the same proposed row', async () => {
    // `applyRun` reads the proposed changes and then applies them one
    // transaction at a time, so two applies of one run — two administrators on
    // the same screen, or an administrator racing the scheduler's autoApply —
    // both hold rows that said `proposed` when they read them. The second
    // caller here is that stale read, passed back in verbatim.
    const { users, events, row } = await withTenant(tenantId, async (tx) => {
      const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: newRun.id,
          changeType: 'create_user',
          targetType: 'User',
          targetId: null,
          sourceAnchor: 'anchor-for-a-racing-create',
          after: { login: 'twice', email: 'twice@acme.test', displayName: 'Twice' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, newRun.id);
      // The same row object, still carrying `status: 'proposed'`.
      await applyChange(tx, change, sourceId, newRun.id);

      return {
        users: await tx.user.findMany({ where: { login: 'twice' } }),
        events: await tx.auditEvent.findMany({ where: { action: 'sync.create_user' } }),
        row: await tx.syncChange.findUnique({ where: { id: change.id } }),
      };
    });

    expect(users).toHaveLength(1);
    expect(row!.status).toBe('applied');
    // The audit trail is the part the schema does not protect. A unique
    // constraint turns a duplicated create into a failed change; nothing turns
    // a duplicated event into anything but a second event saying the same
    // thing happened again.
    expect(events).toHaveLength(1);
  });

  it('refuses a CREATE carrying a field no mapping may write, and creates nobody', async () => {
    // The create paths cherry-pick named columns, so an unassignable field was
    // never going to be written — it was going to be dropped in silence. The
    // administrator reviewed a diff naming that field and would have got a row
    // without it. Failing the change is what makes the divergence visible.
    const { updated, ghost } = await withTenant(tenantId, async (tx) => {
      const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: newRun.id,
          changeType: 'create_user',
          targetType: 'User',
          targetId: null,
          sourceAnchor: 'anchor-for-a-user-that-does-not-exist',
          after: { login: 'ghost', status: 'inactive' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, newRun.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        ghost: await tx.user.findFirst({ where: { login: 'ghost' } }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/status/);
    // Nobody at all: a refusal that still creates the row is not a refusal.
    expect(ghost).toBeNull();
  });

  it('refuses an update carrying a field no mapping may write', async () => {
    // A mapping stored before setMappings started rejecting these. update_user
    // passes the mapped blob straight into update({ data }), so without this
    // second gate the directory could set a user inactive through a change
    // type the guard does not count.
    const run = await previewRun(tenantId, provider, sourceId);
    await applyRun(tenantId, run.id);

    const { updated, user, events } = await withTenant(tenantId, async (tx) => {
      const target = await tx.user.findFirstOrThrow({ where: { login: 'jdoe' } });
      const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: newRun.id,
          changeType: 'update_user',
          targetType: 'User',
          targetId: target.id,
          sourceAnchor: target.sourceAnchor,
          after: { status: 'inactive', sourceId: 'somebody-elses-source' },
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, newRun.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        user: await tx.user.findUnique({ where: { id: target.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.update_user' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/status/);
    expect(updated!.message).toMatch(/sourceId/);
    expect(user!.status).toBe('active');
    expect(user!.sourceId).toBe(sourceId);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });

  it('audits outcome failure for an unrecognized change type', async () => {
    const { updated, events } = await withTenant(tenantId, async (tx) => {
      const newRun = await tx.syncRun.create({ data: { tenantId, sourceId } });
      const change = await tx.syncChange.create({
        data: {
          tenantId,
          runId: newRun.id,
          changeType: 'rename_planet',
          targetType: 'User',
          targetId: null,
          sourceAnchor: null,
          status: 'proposed',
        },
      });

      await applyChange(tx, change, sourceId, newRun.id);

      return {
        updated: await tx.syncChange.findUnique({ where: { id: change.id } }),
        events: await tx.auditEvent.findMany({
          where: { action: 'sync.rename_planet' },
        }),
      };
    });

    expect(updated!.status).toBe('failed');
    expect(updated!.message).toMatch(/unknown change type/i);
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('failure');
  });
});
