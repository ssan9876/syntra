import type { TenantClient } from '@syntra/db';
import { FACTOR_TYPES, type FactorType } from '../../policy/types.js';
import type {
  FactorPresentation,
  FactorPresentationType,
  FactorVerifier,
  FactorVerifyContext,
  FactorVerifyResult,
} from './types.js';

const VERIFIERS = new Map<FactorPresentationType, FactorVerifier>();

/**
 * Adding a factor means adding an entry here, never editing authorize().
 * The chokepoint asks this registry what exists, what is enrolled and what
 * verifies; it does not know that TOTP and WebAuthn are the two that happen to
 * be registered.
 */
export function registerFactorVerifier(verifier: FactorVerifier): void {
  VERIFIERS.set(verifier.type, verifier);
}

export function factorVerifier(
  type: FactorPresentationType,
): FactorVerifier | undefined {
  return VERIFIERS.get(type);
}

/**
 * The policy-visible factor types the user has actually enrolled.
 *
 * Recovery codes are deliberately not a policy factor: a rule may require
 * WebAuthn, and a recovery code must not satisfy it. They are accepted as a
 * fallback for `require_mfa` only, which is decided in authorize().
 */
export async function enrolledFactorTypes(
  tx: TenantClient,
  userId: string,
): Promise<FactorType[]> {
  const found: FactorType[] = [];
  // `FACTOR_TYPES`, not a literal pair. The docstring above says adding a
  // factor means adding an entry to this registry and never editing
  // `authorize()` — which was true of the chokepoint and not of these two
  // functions, where a third type would have been silently unenrollable and
  // silently uncounted.
  for (const type of FACTOR_TYPES) {
    const verifier = VERIFIERS.get(type);
    if (verifier && (await verifier.enrolled(tx, userId))) found.push(type);
  }
  return found;
}

/**
 * The factor types a user could enrol right now, which is a property of the
 * process rather than of the user: a type with no verifier registered is not
 * something this deployment can offer, and offering it would produce a
 * challenge nobody can answer.
 */
export function enrollableFactorTypes(): FactorType[] {
  return FACTOR_TYPES.filter((type) => {
    const verifier = VERIFIERS.get(type);
    return Boolean(verifier?.enrollable);
  });
}

export async function hasRecoveryCodes(
  tx: TenantClient,
  userId: string,
): Promise<boolean> {
  const verifier = VERIFIERS.get('recovery_code');
  return verifier ? verifier.enrolled(tx, userId) : false;
}

export async function verifyFactor(
  tenantId: string,
  userId: string,
  presentation: FactorPresentation,
  context: FactorVerifyContext,
): Promise<FactorVerifyResult> {
  const verifier = VERIFIERS.get(presentation.type);
  if (!verifier) return { ok: false, reason: 'factor_not_available' };
  return verifier.verify(tenantId, userId, presentation, context);
}

/**
 * Test support only. The registry is module state and the whole suite runs in
 * one fork, so a suite that installs WebAuthn would otherwise change what a
 * later suite's `enrollableFactorTypes()` reports — and a test that passes
 * only because of what ran before it is worse than no test.
 */
export function resetFactorVerifiers(): void {
  VERIFIERS.clear();
}
