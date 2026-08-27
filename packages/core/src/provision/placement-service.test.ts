import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  ContainerNotInTargetError,
  NoAccountToMoveError,
  clearPlacement,
  findPlacement,
  setPlacement,
} from './placement-service.js';

let tenantId: string;
let personId: string;
let targetSystemId: string;

const CONTAINERS = [
  'OU=Finance,OU=Company,DC=acme,DC=test',
  'OU=Engineering,OU=Company,DC=acme,DC=test',
];

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;

  await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Ada', familyName: 'Lovelace' },
    });
    personId = person.id;

    const target = await tx.targetSystem.create({
      data: {
        tenantId,
        name: 'AD',
        type: 'activeDirectory',
        // `tlsMode` is not decoration: `target_system_encrypted_transport`
        // refuses a target that could be configured to write in the clear.
        config: { tlsMode: 'ldaps' },
        secretName: 'target:ad',
      },
    });
    targetSystemId = target.id;

    await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId,
        personId,
        anchor: 'anchor-1',
        correlationKey: 'ada.lovelace',
        status: 'active',
      },
    });
  });
});

const move = (over: Partial<Parameters<typeof setPlacement>[1]> = {}) =>
  withTenant(tenantId, (tx) =>
    setPlacement(tx, {
      personId,
      targetSystemId,
      container: CONTAINERS[0]!,
      reason: 'moved to Finance after the reorg',
      movedByUserId: null,
      existingContainers: CONTAINERS,
      ...over,
    }),
  );

describe('setPlacement', () => {
  it('pins the account to the container', async () => {
    const placement = await move();
    expect(placement.container).toBe(CONTAINERS[0]);
    expect(
      await withTenant(tenantId, (tx) => findPlacement(tx, personId, targetSystemId)),
    ).toMatchObject({ container: CONTAINERS[0], reason: 'moved to Finance after the reorg' });
  });

  it('refuses a container the target does not have', async () => {
    // Provision creates no containers anywhere. A placement naming one that
    // does not exist is an account that fails to move on every run afterwards,
    // with the failure showing up as a connector error rather than the typo
    // it is.
    await expect(
      move({ container: 'OU=Sales,OU=Company,DC=acme,DC=test' }),
    ).rejects.toBeInstanceOf(ContainerNotInTargetError);
  });

  it("stores the target's own casing, not what was typed", async () => {
    // The planner compares the desired container against what the directory
    // reports. Two spellings of one DN look like a move that never completes.
    const placement = await move({ container: '  ou=finance,ou=company,dc=acme,dc=test  ' });
    expect(placement.container).toBe(CONTAINERS[0]);
  });

  it('refuses to pin somebody with no account in that target', async () => {
    // Pinning a container for somebody with no account would quietly change
    // where their account is CREATED — a different decision, made by the
    // profile template, and not the one Move is making.
    const other = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Grace', familyName: 'Hopper' } }),
    );
    await expect(move({ personId: other.id })).rejects.toBeInstanceOf(NoAccountToMoveError);
  });

  it('replaces an earlier placement rather than adding a second', async () => {
    await move();
    await move({ container: CONTAINERS[1]!, reason: 'moved again' });

    expect(await withTenant(tenantId, (tx) => tx.accountPlacement.count())).toBe(1);
    expect(
      await withTenant(tenantId, (tx) => findPlacement(tx, personId, targetSystemId)),
    ).toMatchObject({ container: CONTAINERS[1], reason: 'moved again' });
  });

  it('records who moved them', async () => {
    const user = await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'admin',
          email: 'admin@acme.test',
          displayName: 'Admin',
        },
      }),
    );
    const placement = await move({ movedByUserId: user.id });
    // "Who moved this and why" is the only question anybody asks about a
    // placement that disagrees with the rule.
    expect(placement.movedByUserId).toBe(user.id);
  });
});

describe('clearPlacement', () => {
  it('hands the person back to the rule', async () => {
    await move();
    expect(
      await withTenant(tenantId, (tx) => clearPlacement(tx, personId, targetSystemId)),
    ).toBe(true);
    expect(
      await withTenant(tenantId, (tx) => findPlacement(tx, personId, targetSystemId)),
    ).toBeNull();
  });

  it('moves nothing itself', async () => {
    // The next run computes the template's answer, sees the account is
    // elsewhere, and proposes the move — through the guard, in a plan somebody
    // reviews. Moving it here would be the manual path doing the planner's job
    // without the planner's controls.
    await move();
    await withTenant(tenantId, (tx) => clearPlacement(tx, personId, targetSystemId));

    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({ where: { personId } }),
    );
    expect(account.anchor).toBe('anchor-1');
  });

  it('is idempotent', async () => {
    // What somebody pressing the button twice means.
    expect(
      await withTenant(tenantId, (tx) => clearPlacement(tx, personId, targetSystemId)),
    ).toBe(false);
  });
});

describe('row-level security', () => {
  it('hides another tenant’s placements', async () => {
    await move();
    const other = await prisma.tenant.create({ data: { name: 'Globex', slug: 'globex' } });
    expect(await withTenant(other.id, (tx) => tx.accountPlacement.count())).toBe(0);
  });
});
