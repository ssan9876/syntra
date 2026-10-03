import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { acknowledgeIncident, listIncidents, resolveIncident } from './incidents.js';

let tenantId: string;
const NOW = new Date('2026-08-26T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const incidents = () => withTenant(tenantId, (tx) => listIncidents(tx, NOW));
const kinds = async () => (await incidents()).map((i) => i.kind);

async function aTarget(over: Record<string, unknown> = {}) {
  return withTenant(tenantId, (tx) =>
    tx.targetSystem.create({
      data: {
        tenantId,
        name: 'AD',
        type: 'activeDirectory',
        config: { tlsMode: 'ldaps' },
        secretName: 's/ad',
        ...over,
      },
    }),
  );
}

async function anEndpoint() {
  return withTenant(tenantId, (tx) =>
    tx.webhookEndpoint.create({
      data: { tenantId, name: 'Ticketing', url: 'https://hooks.example.test/x' },
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('listIncidents', () => {
  it('says nothing when nothing is wrong', async () => {
    // An empty list is the answer somebody wants most often, and a dashboard
    // that manufactures a row to look busy is one people stop reading.
    expect(await incidents()).toEqual([]);
  });

  it('reports a webhook that has given up, not one still retrying', async () => {
    const endpoint = await anEndpoint();
    await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.createMany({
        data: [
          // Given up.
          {
            tenantId,
            endpointId: endpoint.id,
            event: 'automate-stage-opened',
            payload: {},
            attempts: 6,
            nextAttemptAt: NOW,
          },
          // Still trying — not an incident. Every entry here has already
          // failed for good.
          {
            tenantId,
            endpointId: endpoint.id,
            event: 'automate-stage-opened',
            payload: {},
            attempts: 2,
            nextAttemptAt: NOW,
          },
        ],
      }),
    );

    const found = await incidents();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'webhook_undelivered', count: 1, severity: 'critical' });
  });

  it('does not report a webhook that was delivered on its last attempt', async () => {
    const endpoint = await anEndpoint();
    await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.create({
        data: {
          tenantId,
          endpointId: endpoint.id,
          event: 'automate-stage-opened',
          payload: {},
          attempts: 6,
          deliveredAt: NOW,
          nextAttemptAt: NOW,
        },
      }),
    );
    expect(await kinds()).toEqual([]);
  });

  it('reports mail nobody ever received', async () => {
    await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.create({
        data: {
          tenantId,
          template: 'automate-stage-opened',
          to: 'approver@acme.test',
          attempts: 5,
        },
      }),
    );
    const found = await incidents();
    // An approver who was never told is a request nobody is working on.
    expect(found[0]).toMatchObject({ kind: 'notification_undelivered', severity: 'critical' });
  });

  it('reports a target whose scheduled runs are being skipped, by name', async () => {
    await aTarget({ name: 'Samba AD', consecutiveSkippedRuns: 3, lastSkippedAt: daysAgo(1) });
    const found = await incidents();
    expect(found[0]!.kind).toBe('target_runs_skipped');
    // Named, not counted. "Three targets" sends somebody to a list to work out
    // which three.
    // Named in its own item, with the skip it recorded, rather than in a list
    // run together inside the sentence.
    expect(found[0]!.items[0]!.label).toContain('Samba AD');
  });

  it('reports a scheduled target whose runs start and never finish', async () => {
    // The rotated-credential shape: a run begins every night, fails, and
    // resets the skip counter — so `lastRunAt` is the only thing that shows it.
    await aTarget({ name: 'Stale AD', schedule: '0 2 * * *', lastRunAt: daysAgo(9) });
    const found = await incidents();
    expect(found[0]).toMatchObject({ kind: 'target_never_completed' });
    expect(found[0]!.items[0]!.label).toBe('Stale AD');
  });

  it('does not report a target that ran recently', async () => {
    await aTarget({ schedule: '0 2 * * *', lastRunAt: daysAgo(1) });
    expect(await kinds()).toEqual([]);
  });

  it('does not report a manual target that has simply not been run', async () => {
    // No schedule means nothing is late. Reporting it would put a permanent
    // row on the page for a target working exactly as configured.
    await aTarget({ schedule: null, lastRunAt: null });
    expect(await kinds()).toEqual([]);
  });

  it('does not report a disabled target', async () => {
    await aTarget({ enabled: false, schedule: '0 2 * * *', lastRunAt: daysAgo(30) });
    expect(await kinds()).toEqual([]);
  });

  it('counts a failed sync as a warning, and says what it costs', async () => {
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: { tenantId, name: 'HR', type: 'csv', config: {}, secretName: 's/hr' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.syncRun.create({
        data: { tenantId, sourceId: source.id, status: 'failed', startedAt: daysAgo(2) },
      }),
    );
    const found = await incidents();
    expect(found[0]).toMatchObject({ kind: 'sync_run_failed', severity: 'warning' });
    // The person register is upstream of every other decision.
    expect(found[0]!.detail).toMatch(/person data/i);
  });

  it('ignores a failure older than the window', async () => {
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: { tenantId, name: 'HR', type: 'csv', config: {}, secretName: 's/hr' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.syncRun.create({
        data: { tenantId, sourceId: source.id, status: 'failed', startedAt: daysAgo(30) },
      }),
    );
    expect(await kinds()).toEqual([]);
  });

  it('does not report a REFUSED delegated task run', async () => {
    // A refusal is the escalation guard working. Listing it as an incident
    // would train people to ignore the one signal that means somebody tried to
    // reach further than they should.
    const task = await withTenant(tenantId, (tx) =>
      tx.delegatedTask.create({
        data: { tenantId, name: 'Unlock', actionKey: 'unlock_account', formSchema: [] },
      }),
    );
    const user = await withTenant(tenantId, (tx) =>
      tx.user.create({
        data: { tenantId, login: 'a', email: 'a@acme.test', displayName: 'A' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.delegatedTaskRun.createMany({
        data: [
          {
            tenantId,
            taskId: task.id,
            runByUserId: user.id,
            outcome: 'refused',
            message: 'out of reach',
            createdAt: daysAgo(1),
          },
          {
            tenantId,
            taskId: task.id,
            runByUserId: user.id,
            outcome: 'failure',
            message: 'the group went away',
            createdAt: daysAgo(1),
          },
        ],
      }),
    );

    const found = await incidents();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'task_failing', count: 1 });
  });

  it('names each failed run with its target and its error, scrubbed', async () => {
    const target = await aTarget({ name: 'Snipe-IT' });
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: target.id,
          status: 'failed',
          startedAt: daysAgo(1),
          error: 'POST /api/v1/users as admin@acme.test: 401 Unauthorized',
        },
      }),
    );
    const found = (await incidents()).find((i) => i.kind === 'provision_run_failed')!;
    expect(found.resolvable).toBe(true);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ label: 'Snipe-IT' });
    expect(found.items[0]!.detail).toContain('401 Unauthorized');
    // An address in a stored error is personal data and never reaches the page.
    expect(found.items[0]!.detail).not.toContain('admin@acme.test');
    expect(found.items[0]!.href).toMatch(new RegExp(`^/admin/targets/${target.id}/runs/`));
  });

  it('resolving counts only newer failures, and a newer one brings it back', async () => {
    const target = await aTarget();
    const fail = (at: Date) =>
      withTenant(tenantId, (tx) =>
        tx.provisionRun.create({ data: { tenantId, targetSystemId: target.id, status: 'failed', startedAt: at } }),
      );
    await fail(daysAgo(2));
    const actor = await withTenant(tenantId, (tx) =>
      tx.user.create({ data: { tenantId, login: 'ops', email: 'ops@acme.test', displayName: 'Ops' } }),
    );
    await withTenant(tenantId, (tx) =>
      resolveIncident(tx, tenantId, 'provision_run_failed', actor.id, 'rotated the key', daysAgo(1)),
    );
    expect(await kinds()).not.toContain('provision_run_failed');

    await fail(new Date(NOW.getTime() - 3_600_000));
    const back = (await incidents()).find((i) => i.kind === 'provision_run_failed')!;
    expect(back.count).toBe(1);
  });

  it('an acknowledgement stands until something newer happens', async () => {
    const target = await aTarget();
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({ data: { tenantId, targetSystemId: target.id, status: 'failed', startedAt: daysAgo(2) } }),
    );
    const actor = await withTenant(tenantId, (tx) =>
      tx.user.create({ data: { tenantId, login: 'ops', email: 'ops@acme.test', displayName: 'Ops' } }),
    );
    await withTenant(tenantId, (tx) =>
      acknowledgeIncident(tx, tenantId, 'provision_run_failed', actor.id, 'on it', daysAgo(1)),
    );
    const acked = (await incidents()).find((i) => i.kind === 'provision_run_failed')!;
    // Acknowledging hides nothing: still listed, now with who has it.
    expect(acked.acknowledged).toMatchObject({ byUserId: actor.id, note: 'on it' });

    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: target.id, status: 'failed', startedAt: new Date(NOW.getTime() - 60_000) },
      }),
    );
    expect((await incidents()).find((i) => i.kind === 'provision_run_failed')!.acknowledged).toBeNull();
  });

  it('offers no resolution for a condition, which clears when fixed', async () => {
    await aTarget({ name: 'Samba AD', schedule: '0 * * * *', consecutiveSkippedRuns: 2, lastSkippedAt: daysAgo(0) });
    const found = (await incidents()).find((i) => i.kind === 'target_runs_skipped')!;
    expect(found.resolvable).toBe(false);
  });

  describe('a target whose runs keep ending partially applied', () => {
    /** A finished run, `hoursAgo` back, with one action per given outcome. */
    async function aRun(targetId: string, status: string, hoursAgo: number, actions: string[] = []) {
      const at = new Date(NOW.getTime() - hoursAgo * 3_600_000);
      return withTenant(tenantId, async (tx) => {
        const run = await tx.provisionRun.create({
          data: { tenantId, targetSystemId: targetId, status, startedAt: at, finishedAt: at },
        });
        for (const [sequence, outcome] of actions.entries()) {
          await tx.provisionAction.create({
            data: {
              tenantId,
              runId: run.id,
              actionType: 'update_account',
              sequence,
              status: outcome,
              requiresConfirmation: outcome === 'proposed',
              message: outcome === 'failed' ? 'PATCH /Users/42 as admin@acme.test: SCIM 400 invalidValue' : null,
            },
          });
        }
        return run;
      });
    }

    it('names the target and how many runs in a row, and links the latest run', async () => {
      const target = await aTarget({
        name: 'fmx.ssander.xyz',
        type: 'scim2',
        config: { baseUrl: 'https://fmx.ssander.xyz/scim/v2' },
      });
      for (const h of [5, 4, 3, 2]) await aRun(target.id, 'partially_applied', h, ['applied', 'failed']);
      const latestRun = await aRun(target.id, 'partially_applied', 1, ['applied', 'failed', 'failed']);

      const found = (await incidents()).find((i) => i.kind === 'target_runs_partially_applied')!;
      expect(found).toMatchObject({ severity: 'warning', count: 1, resolvable: false });
      expect(found.detail).toBe(
        'Target "fmx.ssander.xyz": last 5 runs partially applied. Open the latest run to see the failed actions.',
      );
      expect(found.href).toBe(`/admin/targets/${target.id}/runs`);
      expect(found.items[0]).toMatchObject({
        label: 'fmx.ssander.xyz · 5 partially applied',
        href: `/admin/targets/${target.id}/runs/${latestRun.id}`,
      });
      expect(found.items[0]!.detail).toContain('2 actions failed in the latest run');
      expect(found.items[0]!.detail).toContain('SCIM 400');
      expect(found.items[0]!.detail).not.toContain('admin@acme.test');
    });

    it('is not raised by fewer than three', async () => {
      const target = await aTarget();
      await aRun(target.id, 'partially_applied', 2, ['failed']);
      await aRun(target.id, 'partially_applied', 1, ['failed']);
      expect(await kinds()).not.toContain('target_runs_partially_applied');
    });

    it('clears when a run fully applies', async () => {
      const target = await aTarget();
      for (const h of [6, 5, 4]) await aRun(target.id, 'partially_applied', h, ['failed']);
      expect(await kinds()).toContain('target_runs_partially_applied');

      await aRun(target.id, 'applied', 3, ['applied']);
      expect(await kinds()).not.toContain('target_runs_partially_applied');

      // Partial runs before the clean one no longer count towards a new streak.
      await aRun(target.id, 'partially_applied', 2, ['failed']);
      await aRun(target.id, 'partially_applied', 1, ['failed']);
      expect(await kinds()).not.toContain('target_runs_partially_applied');
    });

    it('does not count runs that are partial only because actions are held for confirmation', async () => {
      // Held actions are on the attention summary, waiting for an approval.
      const target = await aTarget();
      for (const h of [3, 2, 1]) await aRun(target.id, 'partially_applied', h, ['applied', 'proposed']);
      expect(await kinds()).not.toContain('target_runs_partially_applied');
    });

    it('does not report a disabled target', async () => {
      const target = await aTarget({ enabled: false });
      for (const h of [3, 2, 1]) await aRun(target.id, 'partially_applied', h, ['failed']);
      expect(await kinds()).not.toContain('target_runs_partially_applied');
    });

    it('keeps an acknowledgement while the same streak goes on', async () => {
      const target = await aTarget();
      for (const h of [10, 9, 8]) await aRun(target.id, 'partially_applied', h, ['failed']);
      const actor = await withTenant(tenantId, (tx) =>
        tx.user.create({ data: { tenantId, login: 'ops', email: 'ops@acme.test', displayName: 'Ops' } }),
      );
      await withTenant(tenantId, (tx) =>
        acknowledgeIncident(
          tx,
          tenantId,
          'target_runs_partially_applied',
          actor.id,
          'vendor ticket open',
          new Date(NOW.getTime() - 7 * 3_600_000),
        ),
      );
      // Another hourly run with the same failure is not something new.
      await aRun(target.id, 'partially_applied', 1, ['failed']);
      const acked = (await incidents()).find((i) => i.kind === 'target_runs_partially_applied')!;
      expect(acked.acknowledged).toMatchObject({ note: 'vendor ticket open' });

      // A second target starting a streak is.
      const other = await aTarget({ name: 'Snipe-IT', secretName: 's/snipe' });
      for (const h of [3, 2, 1]) await aRun(other.id, 'partially_applied', h, ['failed']);
      const back = (await incidents()).find((i) => i.kind === 'target_runs_partially_applied')!;
      expect(back.count).toBe(2);
      expect(back.acknowledged).toBeNull();
    });
  });

  it('puts what is worst first', async () => {
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: { tenantId, name: 'HR', type: 'csv', config: {}, secretName: 's/hr' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.syncRun.create({
        data: { tenantId, sourceId: source.id, status: 'failed', startedAt: daysAgo(1) },
      }),
    );
    await aTarget({ consecutiveSkippedRuns: 1, lastSkippedAt: daysAgo(3) });

    const found = await incidents();
    // Critical before warning, whatever their timestamps say.
    expect(found.map((i) => i.severity)).toEqual(['critical', 'warning']);
  });

  it('shows another tenant nothing of this one', async () => {
    await anEndpoint();
    const other = await prisma.tenant.create({ data: { name: 'Globex', slug: 'globex' } });
    expect(await withTenant(other.id, (tx) => listIncidents(tx, NOW))).toEqual([]);
  });
});
