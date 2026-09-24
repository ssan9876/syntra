import type { TenantClient } from '@syntra/db';
import { readTenant, type TenantView } from '../tenant/tenant-service.js';
import { revisionOf } from './change-control.js';

/**
 * Which tenant sign-in settings a change would WEAKEN.
 *
 * The `auth_policy` change class holds relaxations only. Tightening a sign-in
 * rule needs no second opinion -- it is what an administrator does in the
 * middle of an incident, alone, at speed -- while loosening one is exactly
 * the change a compromised or careless administrator would make first.
 *
 * Each rule reads the direction the setting protects in:
 *  - a requirement switched off (admin MFA, the console security key), or a
 *    weaker factor switched on (emailed codes);
 *  - a shorter minimum password, a shallower history;
 *  - lockout: off (threshold 0) from on, a higher threshold, a shorter window
 *    or a shorter lock (0 means "until an administrator lifts it", the
 *    strictest);
 *  - password expiry: off (0) from on, or a longer age;
 *  - any session lifetime made longer.
 */
export function authPolicyRelaxations(
  before: Pick<TenantView,
    'adminMfaRequired' | 'adminWebauthnRequired' | 'emailOtpEnabled' | 'passwordMinLength' | 'passwordHistoryDepth' |
    'lockoutThreshold' | 'lockoutWindowMinutes' | 'lockoutDurationMinutes' | 'passwordMaxAgeDays' |
    'portalSessionIdleMinutes' | 'portalSessionAbsoluteMinutes' | 'adminSessionIdleMinutes' | 'adminSessionAbsoluteMinutes'>,
  patch: Partial<Record<string, unknown>>,
): string[] {
  const relaxed: string[] = [];
  const next = <K extends keyof typeof before>(key: K): (typeof before)[K] =>
    (patch[key] === undefined ? before[key] : patch[key]) as (typeof before)[K];

  if (before.adminMfaRequired && !next('adminMfaRequired')) relaxed.push('adminMfaRequired');
  if (before.adminWebauthnRequired && !next('adminWebauthnRequired')) relaxed.push('adminWebauthnRequired');
  if (!before.emailOtpEnabled && next('emailOtpEnabled')) relaxed.push('emailOtpEnabled');
  if (next('passwordMinLength') < before.passwordMinLength) relaxed.push('passwordMinLength');
  if (next('passwordHistoryDepth') < before.passwordHistoryDepth) relaxed.push('passwordHistoryDepth');

  const threshold = next('lockoutThreshold');
  if (before.lockoutThreshold > 0 && (threshold === 0 || threshold > before.lockoutThreshold)) relaxed.push('lockoutThreshold');
  if (next('lockoutWindowMinutes') < before.lockoutWindowMinutes) relaxed.push('lockoutWindowMinutes');
  const duration = next('lockoutDurationMinutes');
  if (duration !== before.lockoutDurationMinutes &&
      (before.lockoutDurationMinutes === 0 || (duration !== 0 && duration < before.lockoutDurationMinutes))) {
    relaxed.push('lockoutDurationMinutes');
  }
  const maxAge = next('passwordMaxAgeDays');
  if (before.passwordMaxAgeDays > 0 && (maxAge === 0 || maxAge > before.passwordMaxAgeDays)) relaxed.push('passwordMaxAgeDays');

  for (const key of ['portalSessionIdleMinutes', 'portalSessionAbsoluteMinutes', 'adminSessionIdleMinutes', 'adminSessionAbsoluteMinutes'] as const) {
    if (next(key) > before[key]) relaxed.push(key);
  }
  return relaxed;
}

export const TENANT_SETTINGS_OPERATION = 'tenant.settings';

/** The whole settings view: any edit to the tenant's settings since the request is staleness. */
export async function tenantSettingsRevision(tx: TenantClient): Promise<string> {
  return revisionOf(await readTenant(tx));
}
