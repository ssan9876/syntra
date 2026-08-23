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
  /**
   * The hostname this tenant answers on, and the WebAuthn relying party.
   *
   * Writable, which it was not: `slug` and this were both frozen as "the two
   * fields nobody may change from here", and freezing this one meant an
   * operator deploying Syntra at their own domain had no way to say so short
   * of SQL. Requiring database access to finish an installation is not a
   * safety property.
   *
   * `slug` stays frozen, and for a better reason: it is the fallback the
   * resolver uses when the domain does not match, so it is the way back in
   * when this field is set wrong. A tenant that could change both could
   * strand itself completely.
   *
   * Null clears it, which turns WebAuthn off for the tenant — see
   * `webauthnAvailable`.
   */
  primaryDomain: string | null;
}

/** What the settings screen reads, plus the one field it must not write. */
export interface TenantView extends TenantSettings {
  slug: string;
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
      ...(input.primaryDomain === undefined
        ? {}
        : { primaryDomain: input.primaryDomain }),
    },
  });
  return readTenant(tx);
}

/**
 * Raised when changing the domain would invalidate registered passkeys.
 *
 * Not a refusal to act — the same act awaiting a decision, which is why it
 * carries the count. WebAuthn binds every credential to the relying party it
 * was created against, so moving the domain does not migrate them: it makes
 * every one of them unusable, silently, at the next sign-in. The people
 * holding them find out when their key stops working.
 *
 * The same shape as `SourceOwnsObjectsError`, deliberately. That is the
 * conversation this is: here is the number, ask me again.
 */
export class PasskeysWouldBreakError extends Error {
  constructor(readonly count: number) {
    super(
      `changing the primary domain will invalidate ${count} registered security ` +
        `${count === 1 ? 'key' : 'keys'}: WebAuthn binds each one to the domain it ` +
        `was created against, and they cannot be migrated. Whoever holds them will ` +
        `have to enrol again.`,
    );
    this.name = 'PasskeysWouldBreakError';
  }
}

/**
 * How many passkeys a domain change would break, or zero.
 *
 * Read BEFORE the update and compared against what the caller acknowledged, so
 * a key registered between the warning and the confirmation is not silently
 * included in a decision nobody made about it.
 */
export async function passkeysAtRisk(
  tx: TenantClient,
  nextDomain: string | null | undefined,
): Promise<number> {
  if (nextDomain === undefined) return 0;
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  // Unchanged is not a change. Setting the same value again breaks nothing.
  if (tenant.primaryDomain === nextDomain) return 0;
  return tx.webAuthnCredential.count();
}
