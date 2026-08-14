import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';

export type TenantClient = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction with the tenant bound for the duration.
 * Every tenant-scoped read and write must go through here: the row-level
 * security policies compare against the setting this establishes, so a query
 * issued outside it simply sees nothing.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error(`withTenant called with a non-uuid tenantId: ${tenantId}`);
  }

  return prisma.$transaction(async (tx) => {
    // set_config with is_local=true scopes the setting to this transaction.
    // Parameterised, so the tenant id can never be interpolated into SQL.
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}
