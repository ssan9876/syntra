import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRestoreHold, prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { ExternalWritesPausedError } from '../provision/target-write-stop.js';
import { assertExternalWritesAllowed } from '../provision/tenant-write-stop.js';
import {
  activeRestoreHold,
  releaseRestoreHolds,
  waitForRestoreRelease,
  type RestoreHold,
} from './restore-hold.js';

const hold: RestoreHold = {
  id: '00000000-0000-4000-8000-000000000001',
  backupName: 'syntra-20261005T020000Z',
  backupTakenAt: new Date('2026-10-05T02:00:00Z'),
  backupVersion: '1.20.0',
  restoredAt: new Date('2026-10-05T14:12:00Z'),
};

describe('restore hold', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is the newest unreleased row, and releasing clears every one', async () => {
    expect(await activeRestoreHold()).toBeNull();
    await createRestoreHold({ backupName: 'syntra-20261004T020000Z', restoredAt: new Date('2026-10-05T10:00:00Z') });
    await createRestoreHold({ backupName: 'syntra-20261005T020000Z', restoredAt: new Date('2026-10-05T11:00:00Z') });
    await createRestoreHold({ backupName: 'old', restoredAt: new Date('2026-09-01T00:00:00Z'), releasedAt: new Date('2026-09-01T01:00:00Z') });

    expect((await activeRestoreHold())?.backupName).toBe('syntra-20261005T020000Z');
    expect(await releaseRestoreHolds()).toBe(2);
    expect(await activeRestoreHold()).toBeNull();
    expect(await releaseRestoreHolds()).toBe(0);
  });

  it('refuses writes to every target in every tenant while held', async () => {
    const tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.create({ data: { tenantId, name: 'AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 's' } }));

    await withTenant(tenantId, (tx) => assertExternalWritesAllowed(tx, target));

    await createRestoreHold({ backupName: 'syntra-20261005T020000Z' });
    const refused = await withTenant(tenantId, (tx) => assertExternalWritesAllowed(tx, target)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ExternalWritesPausedError);
    expect((refused as ExternalWritesPausedError).scope).toBe('installation');
    expect((refused as Error).message).toBe(
      'external writes are paused for every target: restored from syntra-20261005T020000Z and not resumed yet',
    );

    await releaseRestoreHolds();
    await withTenant(tenantId, (tx) => assertExternalWritesAllowed(tx, target));
  });
});

describe('waitForRestoreRelease', () => {
  it('resolves once released, reporting the hold once', async () => {
    const answers = [hold, hold, null];
    const onHeld = vi.fn();
    const released = await waitForRestoreRelease({
      intervalMs: 1,
      check: async () => answers.shift() ?? null,
      onHeld,
    });
    expect(released).toBe(true);
    expect(onHeld).toHaveBeenCalledTimes(1);
    expect(onHeld).toHaveBeenCalledWith(hold);
  });

  it('treats a failed check as held', async () => {
    const failure = new Error('relation "RestoreHold" does not exist');
    const answers: (Error | null)[] = [failure, null];
    const onHeld = vi.fn();
    const released = await waitForRestoreRelease({
      intervalMs: 1,
      check: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return null;
      },
      onHeld,
    });
    expect(released).toBe(true);
    expect(onHeld).toHaveBeenCalledWith(null, failure);
  });

  it('stops waiting when aborted', async () => {
    const controller = new AbortController();
    const waiting = waitForRestoreRelease({ intervalMs: 60_000, check: async () => hold, signal: controller.signal });
    controller.abort();
    expect(await waiting).toBe(false);
  });
});
