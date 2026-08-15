import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

/**
 * The tenant settings an administrator can change from the console.
 *
 * Deliberately not the whole row. `slug` is how a request is routed to this
 * tenant and `primaryDomain` is what a security key's relying party is derived
 * from — changing either from a web form invalidates every credential
 * registered against the old value, which is an operator's decision made
 * against a runbook, not a checkbox. `status` would let an administrator
 * disable the tenant they are signed in to.
 */
export interface TenantSettings {
  name: string;
  /**
   * A second factor on top of the password for an administrative session.
   * The floor `/api/auth/elevate` imposes.
   */
  adminMfaRequired: boolean;
  /**
   * Whether a user the policy asks for a factor from may enrol one themselves,
   * mid-sign-in, after the password has been accepted.
   */
  selfEnrolmentEnabled: boolean;
  passwordMinLength: number;
}

/** What the settings screen reads, plus the two fields it must not write. */
export interface TenantView extends TenantSettings {
  slug: string;
  primaryDomain: string | null;
  /**
   * Whether a security key can be registered against this tenant at all.
   * Derived rather than stored: WebAuthn pins the relying party to the
   * tenant's own domain, and without one there is nothing to pin to. The
   * screen needs it to say why `adminMfaRequired` may be satisfiable by an
   * authenticator app only.
   */
  webauthnAvailable: boolean;
}

export async function readTenant(tx: TenantClient): Promise<TenantView> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  return {
    name: tenant.name,
    slug: tenant.slug,
    primaryDomain: tenant.primaryDomain,
    adminMfaRequired: tenant.adminMfaRequired,
    selfEnrolmentEnabled: tenant.selfEnrolmentEnabled,
    passwordMinLength: tenant.passwordMinLength,
    webauthnAvailable: tenant.primaryDomain !== null,
  };
}

/**
 * A parsed settings body. Spelled with an explicit `| undefined` rather than
 * as `Partial<TenantSettings>` because `exactOptionalPropertyTypes` treats
 * "present and undefined" as a different thing from "absent", and zod produces
 * the first.
 */
export type TenantSettingsPatch = {
  [K in keyof TenantSettings]?: TenantSettings[K] | undefined;
};

/**
 * Writes the settings this screen owns, leaving anything absent alone.
 *
 * A partial rather than a whole row: a form that did not mention a field must
 * not overwrite it, and the two fields nobody may change from here are absent
 * from `TenantSettings` altogether rather than filtered out at the last
 * moment.
 */
export async function updateTenant(
  tx: TenantClient,
  input: TenantSettingsPatch,
): Promise<TenantView> {
  const tenantId = await currentTenant(tx);
  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.adminMfaRequired === undefined
        ? {}
        : { adminMfaRequired: input.adminMfaRequired }),
      ...(input.selfEnrolmentEnabled === undefined
        ? {}
        : { selfEnrolmentEnabled: input.selfEnrolmentEnabled }),
      ...(input.passwordMinLength === undefined
        ? {}
        : { passwordMinLength: input.passwordMinLength }),
    },
  });
  return readTenant(tx);
}
