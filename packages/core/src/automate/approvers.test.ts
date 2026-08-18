import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  MAX_MANAGER_DEPTH,
  managerChainFor,
  resolveStageApprovers,
  type ApproverSelector,
  type ResolutionSubject,
  type StageSnapshot,
} from './approvers.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
/** personId by nickname, so the assertions read as sentences. */
const person: Record<string, string> = {};

/**
 * A person with an active account and an active contract: the only kind that
 * can decide anything. `manager` is who they report to.
 */
async function seedPerson(
  name: string,
  options: { manager?: string; userStatus?: string; withUser?: boolean; contract?: boolean } = {},
) {
  const { manager, userStatus = 'active', withUser = true, contract = true } = options;
  person[name] = await withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    if (contract) {
      await tx.contract.create({
        data: {
          tenantId,
          personId: p.id,
          sequence: 1,
          isPrimary: true,
          startDate: day('2020-01-01'),
          department: 'Finance',
          ...(manager === undefined ? {} : { managerPersonId: person[manager]! }),
        },
      });
    }
    if (withUser) {
      await tx.user.create({
        data: {
          tenantId,
          login: name.toLowerCase(),
          email: `${name.toLowerCase()}@acme.test`,
          displayName: name,
          personId: p.id,
          status: userStatus,
        },
      });
    }
    return p.id;
  });
  return person[name]!;
}

const stage = (over: Partial<StageSnapshot> = {}): StageSnapshot => ({
  sequence: 1,
  name: 'Stage 1',
  selector: 'manager',
  selectorConfig: {},
  quorum: 'any',
  fallbackSelector: null,
  fallbackConfig: {},
  slaHours: 48,
  onTimeout: 'remind',
  escalationSelector: null,
  escalationConfig: {},
  expiryHours: null,
  ...over,
});

const subject = (over: Partial<ResolutionSubject> = {}): ResolutionSubject => ({
  subjectPersonId: person.anna!,
  submitterPersonId: person.anna!,
  productOwnerPersonId: null,
  productOwnerGroupId: null,
  productCategory: null,
  resources: [],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  for (const key of Object.keys(person)) delete person[key];
  await seedPerson('jan');
  await seedPerson('anna', { manager: 'jan' });
});

describe('resolveStageApprovers — the selectors', () => {
  it('resolves manager from the subject own mapping contract', async () => {
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    expect(result.approvers).toEqual([
      { personId: person.jan, via: 'selector', onBehalfOfPersonId: null },
    ]);
    expect(result.usedFallback).toBe(false);
  });

  it('resolves managerChain(2) to the manager of the manager', async () => {
    await seedPerson('rik');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.jan! },
        data: { managerPersonId: person.rik! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ selector: 'managerChain', selectorConfig: { depth: 2 }, fallbackSelector: 'person', fallbackConfig: { personId: person.rik! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.rik]);
  });

  it('falls back when the chain is shorter than n', async () => {
    await seedPerson('ines');
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'managerChain',
          selectorConfig: { depth: 5 },
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers).toEqual([
      { personId: person.ines, via: 'fallback', onBehalfOfPersonId: null },
    ]);
    expect(result.usedFallback).toBe(true);
  });

  it('resolves group to every member with a person, and role to every holder', async () => {
    await seedPerson('bo');
    await seedPerson('ines');
    const { groupId, roleId } = await withTenant(tenantId, async (tx) => {
      const group = await tx.group.create({ data: { tenantId, name: 'Security' } });
      const bo = await tx.user.findFirstOrThrow({ where: { personId: person.bo! } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: group.id, userId: bo.id },
      });
      const role = await tx.role.create({
        data: { tenantId, name: 'Approvers', permissions: [] },
      });
      const ines = await tx.user.findFirstOrThrow({ where: { personId: person.ines! } });
      await tx.roleAssignment.create({
        data: { tenantId, roleId: role.id, userId: ines.id },
      });
      return { groupId: group.id, roleId: role.id };
    });

    const byGroup = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage({ selector: 'group', selectorConfig: { groupId } }), subject(), NOW),
    );
    expect(byGroup.approvers.map((a) => a.personId)).toEqual([person.bo]);

    const byRole = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage({ selector: 'role', selectorConfig: { roleId } }), subject(), NOW),
    );
    expect(byRole.approvers.map((a) => a.personId)).toEqual([person.ines]);
  });

  it('resolves resourceOwner from the ResourceOwner table, and falls back when none is recorded', async () => {
    await seedPerson('bo');
    await seedPerson('ines');
    const resourceId = person.bo!;
    const resources = [{ resourceType: 'group' as const, resourceId }];
    const withoutOwner = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'resourceOwner',
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject({ resources }),
        NOW,
      ),
    );
    expect(withoutOwner.approvers.map((a) => a.personId)).toEqual([person.ines]);

    await withTenant(tenantId, (tx) =>
      tx.resourceOwner.create({
        data: { tenantId, resourceType: 'group', resourceId, ownerPersonId: person.bo! },
      }),
    );
    const withOwner = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'resourceOwner',
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject({ resources }),
        NOW,
      ),
    );
    expect(withOwner.approvers.map((a) => a.personId)).toEqual([person.bo]);
  });
});

describe('resolveStageApprovers — who cannot act', () => {
  it('drops a person with no Syntra account at all', async () => {
    // The ordinary case of a manager who exists in the HR record and has no
    // account here: they cannot sign in, so they cannot decide.
    await seedPerson('ghost', { withUser: false });
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.ghost! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.dropped).toContainEqual({ personId: person.ghost, reason: 'no_user' });
    expect(result.approvers.map((a) => a.personId)).toEqual([person.jan]);
  });

  it('drops a person whose account is inactive', async () => {
    await seedPerson('gone', { userStatus: 'inactive' });
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.gone! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ines! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.dropped).toContainEqual({ personId: person.gone, reason: 'inactive_user' });
  });

  it('drops a person with no active contract', async () => {
    await seedPerson('left');
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.left! },
        data: { endDate: day('2026-01-01') },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.left! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ines! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.dropped).toContainEqual({
      personId: person.left,
      reason: 'no_active_contract',
    });
  });

  it('returns nobody, and does not throw, when the fallback is also empty', async () => {
    // The caller turns this into blocked_no_approver. It never auto-approves
    // and it never sits silently, but that decision belongs one level up.
    await seedPerson('ghost', { withUser: false });
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.ghost! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ghost! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers).toEqual([]);
  });
});

describe('managerChainFor', () => {
  it('terminates on a cycle instead of hanging every approval in the tenant', async () => {
    // Contract.managerPersonId is a self-reference with no database-level
    // acyclicity check, exactly like OrgUnit.parentId.
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.jan! },
        data: { managerPersonId: person.anna! },
      }),
    );
    const chain = await withTenant(tenantId, (tx) =>
      managerChainFor(tx, person.anna!, MAX_MANAGER_DEPTH, NOW),
    );
    expect(chain).toEqual([person.jan, person.anna]);
  });

  it('stops at MAX_MANAGER_DEPTH', async () => {
    let previous = 'anna';
    for (let i = 0; i < 25; i += 1) {
      const name = `boss${i}`;
      await seedPerson(name);
      const child = previous;
      await withTenant(tenantId, (tx) =>
        tx.contract.updateMany({
          where: { personId: person[child]! },
          data: { managerPersonId: person[name]! },
        }),
      );
      previous = name;
    }
    const chain = await withTenant(tenantId, (tx) =>
      managerChainFor(tx, person.anna!, 99, NOW),
    );
    expect(chain).toHaveLength(MAX_MANAGER_DEPTH);
  });
});

describe('delegation adds an approver and never replaces one', () => {
  it('routes to the delegator AND the delegate while a delegation is active', async () => {
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    // The delegator stays. Replacement would hide an approval from the person
    // accountable for it, and it is the cleanest self-approval path in the
    // design.
    expect(result.approvers).toEqual([
      { personId: person.jan, via: 'selector', onBehalfOfPersonId: null },
      { personId: person.ines, via: 'delegate', onBehalfOfPersonId: person.jan },
    ]);
  });

  it('ignores a delegation outside its own window, and one restricted to another category', async () => {
    await seedPerson('ines');
    await withTenant(tenantId, async (tx) => {
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          startsAt: day('2026-01-01'),
          endsAt: day('2026-02-01'),
        },
      });
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          category: 'Facilities',
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      });
    });
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject({ productCategory: 'Finance' }), NOW),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.jan]);
  });

  it('is not transitive', async () => {
    // A delegates to B, B delegates to C: C is not an approver of A's steps.
    await seedPerson('ines');
    await seedPerson('bo');
    await withTenant(tenantId, async (tx) => {
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.ines!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      });
      await tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.ines!,
          delegatePersonId: person.bo!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      });
    });
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    expect(result.approvers.map((a) => a.personId)).not.toContain(person.bo);
  });
});

/**
 * The invariant, as a matrix rather than a set of cases.
 *
 * Written over the selector list rather than as eight hand-written tests, so
 * that adding a selector later and forgetting the subtraction fails a test
 * rather than passing review. Each row builds a world where the subject or the
 * submitter WOULD be resolved by that selector, and asserts they are not.
 */
describe('the self-approval invariant', () => {
  const SELECTORS: ApproverSelector[] = [
    'manager',
    'managerChain',
    'productOwner',
    'resourceOwner',
    'role',
    'group',
    'person',
  ];

  /** Makes `victim` the person this selector would resolve to. */
  async function arrange(selector: ApproverSelector, victimPersonId: string) {
    return withTenant(tenantId, async (tx) => {
      switch (selector) {
        case 'manager':
        case 'managerChain':
          await tx.contract.updateMany({
            where: { personId: person.anna! },
            data: { managerPersonId: victimPersonId },
          });
          return { config: selector === 'managerChain' ? { depth: 1 } : {}, subjectOver: {} };
        case 'productOwner':
          return { config: {}, subjectOver: { productOwnerPersonId: victimPersonId } };
        case 'resourceOwner': {
          await tx.resourceOwner.create({
            data: {
              tenantId,
              resourceType: 'group',
              resourceId: person.jan!,
              ownerPersonId: victimPersonId,
            },
          });
          return {
            config: {},
            subjectOver: {
              resources: [{ resourceType: 'group' as const, resourceId: person.jan! }],
            },
          };
        }
        case 'role': {
          const role = await tx.role.create({
            data: { tenantId, name: `R-${selector}-${victimPersonId}`, permissions: [] },
          });
          const user = await tx.user.findFirstOrThrow({ where: { personId: victimPersonId } });
          await tx.roleAssignment.create({
            data: { tenantId, roleId: role.id, userId: user.id },
          });
          return { config: { roleId: role.id }, subjectOver: {} };
        }
        case 'group': {
          const group = await tx.group.create({
            data: { tenantId, name: `G-${victimPersonId}` },
          });
          const user = await tx.user.findFirstOrThrow({ where: { personId: victimPersonId } });
          await tx.groupMembership.create({
            data: { tenantId, groupId: group.id, userId: user.id },
          });
          return { config: { groupId: group.id }, subjectOver: {} };
        }
        case 'person':
          return { config: { personId: victimPersonId }, subjectOver: {} };
      }
    });
  }

  for (const selector of SELECTORS) {
    it(`never resolves the subject through ${selector}`, async () => {
      const { config, subjectOver } = await arrange(selector, person.anna!);
      const result = await withTenant(tenantId, (tx) =>
        resolveStageApprovers(
          tx,
          stage({ selector, selectorConfig: config, fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
          subject(subjectOver),
          NOW,
        ),
      );
      expect(result.approvers.map((a) => a.personId)).not.toContain(person.anna);
      expect(result.dropped).toContainEqual({ personId: person.anna, reason: 'subject' });
    });

    it(`never resolves the on-behalf submitter through ${selector}`, async () => {
      // The path a design that only checks the SUBJECT leaves open, and the
      // more dangerous one: request_on_behalf is handed out widely.
      await seedPerson('helpdesk');
      const { config, subjectOver } = await arrange(selector, person.helpdesk!);
      const result = await withTenant(tenantId, (tx) =>
        resolveStageApprovers(
          tx,
          stage({ selector, selectorConfig: config, fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
          subject({ ...subjectOver, submitterPersonId: person.helpdesk! }),
          NOW,
        ),
      );
      expect(result.approvers.map((a) => a.personId)).not.toContain(person.helpdesk);
      expect(result.dropped).toContainEqual({
        personId: person.helpdesk,
        reason: 'submitter',
      });
    });

    it(`never routes a delegate of the subject through ${selector}`, async () => {
      // The mirror image of the delegation case below, and the open one:
      // there, the SUBJECT holds a delegation from the approver and is
      // dropped as themselves. Here the subject IS the resolved approver, and
      // their delegate inherits authority derived entirely from a person the
      // resolver has just refused. One `ApprovalDelegation` row turns owning
      // a product into approving your own request.
      await seedPerson('bo');
      const { config, subjectOver } = await arrange(selector, person.anna!);
      await withTenant(tenantId, (tx) =>
        tx.approvalDelegation.create({
          data: {
            tenantId,
            delegatorPersonId: person.anna!,
            delegatePersonId: person.bo!,
            startsAt: day('2026-06-01'),
            endsAt: day('2026-07-01'),
          },
        }),
      );
      const result = await withTenant(tenantId, (tx) =>
        resolveStageApprovers(
          tx,
          stage({ selector, selectorConfig: config, fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
          subject(subjectOver),
          NOW,
        ),
      );
      expect(result.approvers.map((a) => a.personId)).not.toContain(person.bo);
    });

    it(`never routes a delegate of the on-behalf submitter through ${selector}`, async () => {
      await seedPerson('helpdesk');
      await seedPerson('bo');
      const { config, subjectOver } = await arrange(selector, person.helpdesk!);
      await withTenant(tenantId, (tx) =>
        tx.approvalDelegation.create({
          data: {
            tenantId,
            delegatorPersonId: person.helpdesk!,
            delegatePersonId: person.bo!,
            startsAt: day('2026-06-01'),
            endsAt: day('2026-07-01'),
          },
        }),
      );
      const result = await withTenant(tenantId, (tx) =>
        resolveStageApprovers(
          tx,
          stage({ selector, selectorConfig: config, fallbackSelector: 'person', fallbackConfig: { personId: person.jan! } }),
          subject({ ...subjectOver, submitterPersonId: person.helpdesk! }),
          NOW,
        ),
      );
      expect(result.approvers.map((a) => a.personId)).not.toContain(person.bo);
    });
  }

  it('drops the subject when they hold a delegation from the resolved approver', async () => {
    // Persuade your manager to delegate to you for a week and every request
    // you raise arrives in your own queue. Because delegation ADDS, dropping
    // the subject leaves the nominal approver in place and the stage works.
    await withTenant(tenantId, (tx) =>
      tx.approvalDelegation.create({
        data: {
          tenantId,
          delegatorPersonId: person.jan!,
          delegatePersonId: person.anna!,
          startsAt: day('2026-06-01'),
          endsAt: day('2026-07-01'),
        },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(tx, stage(), subject(), NOW),
    );
    expect(result.approvers).toEqual([
      { personId: person.jan, via: 'selector', onBehalfOfPersonId: null },
    ]);
  });

  it('drops the subject when they are their own manager', async () => {
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.anna! },
        data: { managerPersonId: person.anna! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ fallbackSelector: 'person', fallbackConfig: { personId: person.ines! } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.ines]);
    expect(result.usedFallback).toBe(true);
  });

  it('drops the subject wherever they appear in a manager cycle', async () => {
    // A manages B and B manages A, so managerChain(2) returns A.
    await seedPerson('ines');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person.jan! },
        data: { managerPersonId: person.anna! },
      }),
    );
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({
          selector: 'managerChain',
          selectorConfig: { depth: 2 },
          fallbackSelector: 'person',
          fallbackConfig: { personId: person.ines! },
        }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers.map((a) => a.personId)).toEqual([person.ines]);
  });

  it('returns nobody when the subject is the only member of the group selector', async () => {
    // The correct outcome: a product whose only approver is the person asking
    // is a misconfiguration, and it should be visible as one rather than
    // resolved by pretending.
    const groupId = await withTenant(tenantId, async (tx) => {
      const group = await tx.group.create({ data: { tenantId, name: 'Just Anna' } });
      const anna = await tx.user.findFirstOrThrow({ where: { personId: person.anna! } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: group.id, userId: anna.id },
      });
      return group.id;
    });
    const result = await withTenant(tenantId, (tx) =>
      resolveStageApprovers(
        tx,
        stage({ selector: 'group', selectorConfig: { groupId } }),
        subject(),
        NOW,
      ),
    );
    expect(result.approvers).toEqual([]);
  });
});
