import type { TenantClient } from '@syntra/db';

/**
 * Reads the tenant bound by withTenant, so domain services never take a tenant
 * as a parameter and can never be called with the wrong one. Throws rather
 * than guessing when nothing is bound.
 */
export async function currentTenant(tx: TenantClient): Promise<string> {
  const rows = await tx.$queryRaw<{ tenant: string | null }[]>`
    SELECT NULLIF(current_setting('app.current_tenant', true), '') AS tenant
  `;
  const tenant = rows[0]?.tenant;
  if (!tenant) {
    throw new Error('no tenant bound — call inside withTenant');
  }
  return tenant;
}
