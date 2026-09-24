import type { TenantClient } from '@syntra/db';
import type { TenantSettingsRequest } from '@syntra/contracts';
import {
  DomainTakenError,
  PasskeysWouldBreakError,
  assertDomainsFree,
  currentTenant,
  enrolledFactorTypes,
  hasRecoveryCodes,
  passkeysAtRisk,
  readTenant,
  recordEvent,
  sessionLifetimeProblem,
  updateTenant,
  type TenantView,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';

export type TenantSettingsBody = TenantSettingsRequest;

/** Who is making the change effective: the caller, or the approving administrator. */
export interface TenantSettingsActor {
  userId: string;
  satisfiedFactor: string | null;
  sourceIp: string | null;
  /** Present when the change was held and is being applied by its approver. */
  changeRequestId?: string;
}

/**
 * Validates and writes the tenant's settings, with its audit events, inside
 * the caller's transaction.
 *
 * Shared by `PUT /tenant` and by the approval of a held authentication-policy
 * change, so a held change is applied by exactly the checks the direct route
 * runs -- judged against the APPROVER, who is the person the change would
 * lock out if it could.
 */
export async function applyTenantSettings(
  tx: TenantClient,
  actor: TenantSettingsActor,
  body: TenantSettingsBody,
): Promise<TenantView> {
  const before = await readTenant(tx);
  const after = { ...before, ...body };

  // The one combination that locks the console from the inside.
  //
  // `adminMfaRequired` with self-enrolment off means an administrator who
  // holds no factor is refused outright rather than offered one — the
  // chokepoint answers `factor_not_enrolled`, and there is no self-service way
  // back. Checked against the administrator making the change, because they
  // are the one this would certainly shut out and the one standing in front of
  // a screen that can say so. With self-enrolment left on, the same pair is
  // survivable: the next elevation offers enrolment, which is the whole reason
  // that default exists.
  if (after.adminMfaRequired && !after.selfEnrolmentEnabled) {
    const held = await enrolledFactorTypes(tx, actor.userId);
    const recovery = await hasRecoveryCodes(tx, actor.userId);
    if (held.length === 0 && !recovery) {
      throw new ProblemError(
        409,
        'would-lock-you-out',
        'Set up your own second factor first',
        'Requiring a factor for the console while self-enrolment is off refuses anyone who does not already hold one — including you. Enrol from the Security page, then save this again.',
      );
    }
  }

  // THE DOMAIN IS THE WEBAUTHN RELYING PARTY, and moving it does not migrate
  // the keys bound to the old one — it makes every one of them unusable,
  // silently, at whatever moment its holder next tries to sign in. So the
  // change is refused until somebody has been shown the number and sent it
  // back.
  //
  // The same conversation `DELETE /sources/:id` has about the accounts a source
  // owns: 409 carrying the count, then the same request again with the count
  // acknowledged.
  const { ackPasskeys, ...settings } = body;

  // Pairs of lifetimes are judged on the MERGED settings. The schema has
  // already held each number to its platform bound; what it cannot see is a
  // body lowering the portal lifetime below the admin one already stored.
  const lifetimeProblem = sessionLifetimeProblem({
    portalSessionIdleMinutes: settings.portalSessionIdleMinutes ?? before.portalSessionIdleMinutes,
    portalSessionAbsoluteMinutes: settings.portalSessionAbsoluteMinutes ?? before.portalSessionAbsoluteMinutes,
    adminSessionIdleMinutes: settings.adminSessionIdleMinutes ?? before.adminSessionIdleMinutes,
    adminSessionAbsoluteMinutes: settings.adminSessionAbsoluteMinutes ?? before.adminSessionAbsoluteMinutes,
  });
  if (lifetimeProblem) {
    throw new ProblemError(422, 'invalid-session-policy', 'Those session lifetimes do not fit together', lifetimeProblem);
  }

  // THE PHISHING-RESISTANT CONSOLE SETTING, AND THE THREE WAYS IT LOCKS THE
  // TENANT OUT OF ITS OWN CONSOLE.
  //
  // With it on, an administrative session needs a WebAuthn assertion to exist
  // and to stay alive (see `authorize.ts` and `session-service.ts`) and no
  // forced enrolment is offered at elevation. So each of these is refused
  // rather than warned about:
  const webauthnRequiredAfter = settings.adminWebauthnRequired ?? before.adminWebauthnRequired;
  const primaryDomainAfter = settings.primaryDomain === undefined ? before.primaryDomain : settings.primaryDomain;
  if (webauthnRequiredAfter) {
    // 1. No primary domain means no relying party, and no key can sign
    //    anything. Covers both switching it on without one and clearing the
    //    domain while it is on.
    if (primaryDomainAfter === null) {
      throw new ProblemError(
        409,
        'security-keys-unavailable',
        'Security keys need a primary domain',
        'Requiring a security key for the console with no primary domain set would refuse every administrator. Set the domain first.',
      );
    }
    // 2. Moving the domain while it is on invalidates every key at once,
    //    including every administrator's. The passkey acknowledgement below is
    //    the right conversation for staff; for the console it is a lockout, so
    //    the setting has to come off first.
    if (before.adminWebauthnRequired && settings.primaryDomain !== undefined && settings.primaryDomain !== before.primaryDomain) {
      throw new ProblemError(
        409,
        'security-key-policy-pins-domain',
        'Turn off the security-key requirement before moving the domain',
        'Moving the primary domain invalidates every registered security key, including every administrator’s, and the console would then refuse all of them.',
      );
    }
    // 3. Switching it on from a session a key did not establish. The caller
    //    must PROVE, in this request, that they can satisfy the rule they are
    //    imposing — holding a registered key is not proof that it works on
    //    this domain, and a session a key established is. Checked only on the
    //    transition, so a tenant already under the setting can save unrelated
    //    changes from any live session (which, under the setting, a key
    //    established anyway).
    if (!before.adminWebauthnRequired) {
      const held = await enrolledFactorTypes(tx, actor.userId);
      if (!held.includes('webauthn')) {
        throw new ProblemError(
          409,
          'would-lock-you-out',
          'Register a security key first',
          'Requiring a security key for the console refuses anyone who does not hold one — including you. Register one from the Security page, elevate with it, then save this again.',
        );
      }
      if (actor.satisfiedFactor !== 'webauthn') {
        throw new ProblemError(
          409,
          'security-key-session-required',
          'Elevate with your security key first',
          'Your current console session was not established with a security key, and turning this on would end it. Leave the console, elevate again using your key, then save this again.',
        );
      }
    }
  }

  // Before anything is written. `resolveTenantId` returns the FIRST match, so
  // two tenants claiming one hostname is not an error at request time — it is
  // whichever row the database happened to return, which is the quietest
  // possible way to serve one organization's data to another.
  try {
    await assertDomainsFree(tx, settings);
  } catch (cause) {
    if (cause instanceof DomainTakenError) {
      throw new ProblemError(409, 'domain-taken', 'That hostname is in use', cause.message, { domain: cause.domain });
    }
    throw cause;
  }

  const atRisk = await passkeysAtRisk(tx, settings.primaryDomain);
  if (atRisk > 0 && ackPasskeys !== atRisk) {
    const error = new PasskeysWouldBreakError(atRisk);
    throw new ProblemError(409, 'passkeys-would-break', 'Confirmation required', error.message, { passkeys: atRisk });
  }

  const saved = await updateTenant(tx, settings);
  const tenantId = await currentTenant(tx);
  const provenance = actor.changeRequestId ? { changeRequestId: actor.changeRequestId } : {};

  // Same transaction as the change, like every other admin mutation. Both
  // settings, always, rather than only what the body mentioned: an operator
  // reading this log later wants the state that resulted, not the diff of a
  // form they cannot see.
  await recordEvent(tx, {
    actorUserId: actor.userId,
    action: 'tenant.settings_updated',
    targetType: 'Tenant',
    targetId: tenantId,
    outcome: 'success',
    sourceIp: actor.sourceIp,
    payload: {
      changed: Object.keys(settings),
      adminMfaRequired: saved.adminMfaRequired,
      selfEnrolmentEnabled: saved.selfEnrolmentEnabled,
      passwordMinLength: saved.passwordMinLength,
      lockoutThreshold: saved.lockoutThreshold,
      lockoutWindowMinutes: saved.lockoutWindowMinutes,
      lockoutDurationMinutes: saved.lockoutDurationMinutes,
      passwordMaxAgeDays: saved.passwordMaxAgeDays,
      passwordHistoryDepth: saved.passwordHistoryDepth,
      primaryDomain: saved.primaryDomain,
      additionalDomains: saved.additionalDomains,
      // On the event whether or not any broke, so "who moved the domain, when,
      // and what did it cost" is answerable from the log alone.
      passkeysInvalidated: atRisk,
      portalSessionIdleMinutes: saved.portalSessionIdleMinutes,
      portalSessionAbsoluteMinutes: saved.portalSessionAbsoluteMinutes,
      adminSessionIdleMinutes: saved.adminSessionIdleMinutes,
      adminSessionAbsoluteMinutes: saved.adminSessionAbsoluteMinutes,
      adminWebauthnRequired: saved.adminWebauthnRequired,
      ...provenance,
    },
  });

  // Its own event as well, only when it flips. Weakening or strengthening how
  // the console is protected is the kind of change a security notification
  // policy alerts on, and an alert keyed on a dedicated action is one nobody
  // has to write a payload filter for.
  if (saved.adminWebauthnRequired !== before.adminWebauthnRequired) {
    await recordEvent(tx, {
      actorUserId: actor.userId,
      action: saved.adminWebauthnRequired ? 'tenant.admin_webauthn_required' : 'tenant.admin_webauthn_relaxed',
      targetType: 'Tenant',
      targetId: tenantId,
      outcome: 'success',
      sourceIp: actor.sourceIp,
      payload: { adminWebauthnRequired: saved.adminWebauthnRequired, ...provenance },
    });
  }
  return saved;
}
