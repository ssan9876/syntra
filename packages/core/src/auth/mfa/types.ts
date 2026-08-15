import type { TenantClient } from '@syntra/db';
import type { RelyingParty } from './relying-party.js';

export type FactorPresentation =
  | { type: 'totp'; code: string }
  | { type: 'webauthn'; assertion: unknown }
  | { type: 'recovery_code'; code: string };

export type FactorPresentationType = FactorPresentation['type'];

export type FactorVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Everything a verifier may know about the request beyond the presentation
 * itself. One object rather than a growing tail of positional arguments, and
 * every field is supplied by the caller — a verifier reads no clock and no
 * ambient state of its own, which is what makes it testable.
 */
export interface FactorVerifyContext {
  now: Date;
  relyingParty: RelyingParty;
}

/**
 * One second factor.
 *
 * `verify` takes a tenantId, not a transaction, and opens whatever it needs
 * internally. WebAuthn verification is signature checking and may consult
 * external metadata; running it inside the caller's interactive transaction
 * would put network and CPU work under Prisma's 5000 ms transaction timeout,
 * which is how a slow authenticator becomes a failed login and an aborted
 * transaction.
 *
 * `enrollable` says whether a user may add this factor themselves during a
 * forced-enrolment challenge. Recovery codes are not enrollable: they are a
 * fallback you generate once you already hold a real factor, and offering them
 * as the way to satisfy a require_mfa rule would make the rule meaningless.
 */
export interface FactorVerifier {
  type: FactorPresentationType;
  enrollable: boolean;
  enrolled(tx: TenantClient, userId: string): Promise<boolean>;
  verify(
    tenantId: string,
    userId: string,
    presentation: FactorPresentation,
    context: FactorVerifyContext,
  ): Promise<FactorVerifyResult>;
}
