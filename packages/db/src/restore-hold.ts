import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';

/**
 * A restore nobody has resumed yet. Installation-wide, and without row-level
 * security, so it is read the same way inside a tenant transaction and
 * outside one. Here rather than in `@syntra/core` because this package owns
 * the client.
 */
export interface RestoreHoldRow {
  id: string;
  backupName: string;
  backupTakenAt: Date | null;
  backupVersion: string | null;
  restoredAt: Date;
}

type Client = Pick<Prisma.TransactionClient, 'restoreHold'>;

/**
 * The newest unreleased hold, or null. Pass the transaction when there is
 * one, so the check reads the same snapshot and takes no second connection.
 */
export async function findActiveRestoreHold(client: Client = prisma): Promise<RestoreHoldRow | null> {
  return client.restoreHold.findFirst({
    where: { releasedAt: null },
    orderBy: { restoredAt: 'desc' },
    select: { id: true, backupName: true, backupTakenAt: true, backupVersion: true, restoredAt: true },
  });
}

/**
 * Puts the installation on hold. The restore tools write the row with SQL
 * (ops/restore-hold.sql) because the API may not be running; this is the same
 * row for code that has a client.
 */
export async function createRestoreHold(hold: {
  backupName: string;
  backupTakenAt?: Date | null;
  backupVersion?: string | null;
  restoredAt?: Date;
  releasedAt?: Date | null;
}): Promise<RestoreHoldRow> {
  return prisma.restoreHold.create({
    data: hold,
    select: { id: true, backupName: true, backupTakenAt: true, backupVersion: true, restoredAt: true },
  });
}

/**
 * The newest hold row, released or not. A new one means a restore happened,
 * whether or not somebody has already resumed it.
 */
export async function findLatestRestoreHold(client: Client = prisma): Promise<RestoreHoldRow | null> {
  return client.restoreHold.findFirst({
    orderBy: { restoredAt: 'desc' },
    select: { id: true, backupName: true, backupTakenAt: true, backupVersion: true, restoredAt: true },
  });
}

/** Releases every unreleased hold and returns how many there were. */
export async function releaseAllRestoreHolds(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.restoreHold.updateMany({
    where: { releasedAt: null },
    data: { releasedAt: now },
  });
  return count;
}
