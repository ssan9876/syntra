import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  WorkflowConfigurationError,
  loadWorkflowStages,
  previewWorkflowResolution,
  upsertWorkflow,
  type StageInput,
  type WorkflowInput,
} from './workflow-service.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let annaPersonId: string;
let janPersonId: string;
let securityGroupId: string;

const stage = (over: Partial<StageInput> = {}): StageInput => ({
  sequence: 1,
  name: 'Manager',
  selector: 'manager',
  selectorConfig: {},
  quorum: 'any',
  fallbackSelector: 'person',
  fallbackConfig: { personId: janPersonId },
  slaHours: 48,
  onTimeout: 'remind',
  escalationSelector: null,
  escalationConfig: {},
  expiryHours: null,
  ...over,
});

const workflow = (over: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name: 'Two stage',
  description: null,
  enabled: true,
  stages: [stage()],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const jan = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'de Vries' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: jan.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
      },
    });
    await tx.user.create({
      data: {
        tenantId,
        login: 'jan',
        email: 'jan@acme.test',
        displayName: 'Jan de Vries',
        personId: jan.id,
      },
    });
    const anna = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: anna.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        managerPersonId: jan.id,
      },
    });
    await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: anna.id,
      },
    });
    const group = await tx.group.create({ data: { tenantId, name: 'Security' } });
    return { annaPersonId: anna.id, janPersonId: jan.id, securityGroupId: group.id };
  });
  ({ annaPersonId, janPersonId, securityGroupId } = seeded);
});

describe('upsertWorkflow', () => {
  it('stores a workflow and reads its stages back as snapshots', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    const stages = await withTenant(tenantId, (tx) => loadWorkflowStages(tx, id));
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      sequence: 1,
      selector: 'manager',
      quorum: 'any',
      onTimeout: 'remind',
      fallbackSelector: 'person',
    });
  });

  it('accepts a workflow with zero stages and says loudly what that means', async () => {
    // The empty list IS the auto-grant mechanism -- not a flag, not a special
    // case. Configuring one is a privileged act with an audit event, because
    // a workflow edited from two stages to zero is functionally the same act
    // as approving everything that product will ever grant.
    const { id } = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({ name: 'Granted immediately', stages: [] }),
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'automate.workflow.upsert' } }),
    );
    expect(events[0]?.payload).toMatchObject({ stageCount: 0, grantsImmediately: true });
    expect(await withTenant(tenantId, (tx) => loadWorkflowStages(tx, id))).toEqual([]);
  });

  it('records the before and after stage count when a workflow is edited to zero', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    await upsertWorkflow(tenantId, null, id, workflow({ stages: [] }));
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'automate.workflow.upsert' },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events[1]?.payload).toMatchObject({ previousStageCount: 1, stageCount: 0 });
  });

  it('refuses a manager stage with no fallback, naming the field', async () => {
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({ stages: [stage({ fallbackSelector: null })] }),
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkflowConfigurationError);
    expect((failure as WorkflowConfigurationError).code).toBe('fallback-required');
  });

  it('refuses an all quorum on a group larger than maxApprovers', async () => {
    // A stage requiring the unanimous approval of a 400-member group never
    // completes, and a workflow that cannot complete is a request that sits
    // forever.
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 12; i += 1) {
        const user = await tx.user.create({
          data: {
            tenantId,
            login: `member${i}`,
            email: `member${i}@acme.test`,
            displayName: `Member ${i}`,
          },
        });
        await tx.groupMembership.create({
          data: { tenantId, groupId: securityGroupId, userId: user.id },
        });
      }
    });
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({
            selector: 'group',
            selectorConfig: { groupId: securityGroupId },
            quorum: 'all',
            fallbackSelector: null,
          }),
        ],
      }),
    ).catch((e: unknown) => e);
    expect((failure as WorkflowConfigurationError).code).toBe('quorum-too-large');
    expect((failure as Error).message).toContain('10');
  });

  it('allows an all quorum on a group inside the limit', async () => {
    await withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirstOrThrow({ where: { personId: janPersonId } });
      await tx.groupMembership.create({
        data: { tenantId, groupId: securityGroupId, userId: user.id },
      });
    });
    const created = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({
            selector: 'group',
            selectorConfig: { groupId: securityGroupId },
            quorum: 'all',
            fallbackSelector: null,
          }),
        ],
      }),
    );
    expect(created.id).toBeTruthy();
  });

  it('refuses a managerChain depth outside one to five', async () => {
    for (const depth of [0, 6]) {
      const failure = await upsertWorkflow(
        tenantId,
        null,
        null,
        workflow({
          name: `Depth ${depth}`,
          stages: [stage({ selector: 'managerChain', selectorConfig: { depth } })],
        }),
      ).catch((e: unknown) => e);
      expect((failure as WorkflowConfigurationError).code).toBe('chain-depth');
    }
  });

  it('refuses stage sequences that are not one, two, three', async () => {
    // A gap or a duplicate makes "the next stage" ambiguous, and the request
    // walks them in order.
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({ stages: [stage({ sequence: 1 }), stage({ sequence: 3 })] }),
    ).catch((e: unknown) => e);
    expect((failure as WorkflowConfigurationError).code).toBe('sequence-gap');
  });

  it('refuses a selector whose configuration names nothing', async () => {
    const failure = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [stage({ selector: 'group', selectorConfig: {}, fallbackSelector: null })],
      }),
    ).catch((e: unknown) => e);
    expect((failure as WorkflowConfigurationError).code).toBe('selector-config-missing');
  });

  it('replaces the stage list whole rather than merging it', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    await upsertWorkflow(
      tenantId,
      null,
      id,
      workflow({
        stages: [
          stage({ sequence: 1, name: 'Owner', selector: 'person', selectorConfig: { personId: janPersonId }, fallbackSelector: null }),
        ],
      }),
    );
    const stages = await withTenant(tenantId, (tx) => loadWorkflowStages(tx, id));
    expect(stages).toHaveLength(1);
    expect(stages[0]?.name).toBe('Owner');
  });
});

describe('previewWorkflowResolution', () => {
  it('names the people a real subject would land on, stage by stage', async () => {
    const { id } = await upsertWorkflow(tenantId, null, null, workflow());
    const preview = await previewWorkflowResolution(tenantId, id, annaPersonId, null, NOW);
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ sequence: 1, blocked: false, usedFallback: false });
    expect(preview[0]?.approvers).toEqual([
      { personId: janPersonId, displayName: 'Jan de Vries', via: 'selector' },
    ]);
  });

  it('shows who was dropped and why, by name', async () => {
    // "stage 2: Security Team (4 valid of 6 members; 2 dropped: inactive
    // account, subject)". The reason is the useful half.
    const { id } = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({ selector: 'person', selectorConfig: { personId: annaPersonId }, fallbackSelector: null }),
        ],
      }),
    );
    const preview = await previewWorkflowResolution(tenantId, id, annaPersonId, null, NOW);
    expect(preview[0]?.dropped).toEqual([
      { personId: annaPersonId, displayName: 'Anna Novak', reason: 'subject' },
    ]);
    expect(preview[0]?.blocked).toBe(true);
  });

  it('marks a stage blocked when the selector and the fallback both resolve to nobody', async () => {
    const { id } = await upsertWorkflow(
      tenantId,
      null,
      null,
      workflow({
        stages: [
          stage({
            selector: 'group',
            selectorConfig: { groupId: securityGroupId },
            fallbackSelector: 'group',
            fallbackConfig: { groupId: securityGroupId },
          }),
        ],
      }),
    );
    const preview = await previewWorkflowResolution(tenantId, id, annaPersonId, null, NOW);
    expect(preview[0]?.blocked).toBe(true);
    expect(preview[0]?.approvers).toEqual([]);
  });
});
