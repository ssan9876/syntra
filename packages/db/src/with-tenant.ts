import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';

export type TenantClient = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `Tenant.status` of a tenant whose data has been erased. */
export const TENANT_DELETED_STATUS = 'deleted';

/**
 * Thrown when a transaction binds to a tenant that has been erased.
 *
 * A distinct class so a background job can recognise it and finish quietly:
 * a sync scheduled before the erasure has nothing to do afterwards, and
 * retrying it three times would only turn a completed deletion into an alert.
 */
export class TenantRetiredError extends Error {
  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId} has been deleted`);
    this.name = 'TenantRetiredError';
  }
}

export interface WithTenantOptions {
  /**
   * Take the tenant's binding lock exclusively. Only the tenant erasure does
   * this: it waits for every transaction already bound to the tenant and
   * holds off every new one until it commits.
   */
  exclusive?: boolean;
  /**
   * Bind even though the tenant has been erased. Only for reading what is
   * deliberately retained -- the tombstone's receipt and the audit record.
   */
  allowRetired?: boolean;
  /** Prisma's interactive-transaction timeout, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Runs `fn` in a transaction with the tenant bound for the duration.
 * Every tenant-scoped read and write must go through here: the row-level
 * security policies compare against the setting this establishes, so a query
 * issued outside it simply sees nothing.
 *
 * Binding also fences the transaction against the tenant's erasure; see
 * `syntra_bind_tenant` in the `tenant_deletion_execution` migration for why a
 * status check alone would race. A tenant that does not exist binds as
 * before -- RLS shows it nothing -- because that is what fixtures and
 * tenant-less callers have always relied on.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error(`withTenant called with a non-uuid tenantId: ${tenantId}`);
  }

  return prisma.$transaction(async (tx) => {
    // set_config with is_local=true scopes the setting to this transaction.
    // Parameterised, so the tenant id can never be interpolated into SQL.
    const [bound] = await tx.$queryRaw<{ status: string | null }[]>`
      SELECT syntra_bind_tenant(${tenantId}::uuid, ${options.exclusive === true}) AS status
    `;
    if (bound?.status === TENANT_DELETED_STATUS && options.allowRetired !== true) {
      throw new TenantRetiredError(tenantId);
    }
    return fn(tx);
  }, options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs });
}
