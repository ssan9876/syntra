import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type UserStatus = 'active' | 'inactive';

export interface CreateUserInput {
  login: string;
  email: string;
  displayName: string;
  orgUnitId?: string;
}

export async function createUser(tx: TenantClient, input: CreateUserInput) {
  // Checked explicitly rather than relying on the unique constraint, so the
  // caller gets a domain error it can map to 409 instead of a driver error.
  const existing = await tx.user.findFirst({ where: { login: input.login } });
  if (existing) {
    throw new Error(`login already exists: ${input.login}`);
  }

  const tenantId = await currentTenant(tx);
  return tx.user.create({
    data: {
      tenantId,
      login: input.login,
      email: input.email,
      displayName: input.displayName,
      orgUnitId: input.orgUnitId ?? null,
    },
  });
}

export async function findUserByLogin(tx: TenantClient, login: string) {
  return tx.user.findFirst({ where: { login } });
}

export async function listUsers(
  tx: TenantClient,
  opts: { status?: UserStatus } = {},
) {
  return tx.user.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: { login: 'asc' },
  });
}

/**
 * Deactivation, never deletion. A directory is a record: an account that
 * existed must remain visible and auditable after it stops being usable.
 */
export async function deactivateUser(
  tx: TenantClient,
  id: string,
  reason: string,
) {
  return tx.user.update({
    where: { id },
    data: { status: 'inactive', statusReason: reason },
  });
}

export async function reactivateUser(tx: TenantClient, id: string) {
  return tx.user.update({
    where: { id },
    data: { status: 'active', statusReason: null },
  });
}
