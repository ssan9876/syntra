import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../../tenant-context.js';
import { registerFactorVerifier } from './registry.js';
import type { RelyingParty, RelyingPartyIdentity } from './relying-party.js';
import type { FactorVerifier, FactorVerifyResult } from './types.js';

export const WEBAUTHN_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

type Purpose = 'register' | 'authenticate';

/**
 * Issues a challenge and stores it, replacing any live one.
 *
 * A partial unique index allows only one live challenge per user and purpose,
 * so the previous one is consumed first rather than left valid: two open
 * challenges means a challenge captured from one flow can be answered in
 * another.
 */
async function issueChallenge(
  tenantId: string,
  userId: string,
  purpose: Purpose,
  challenge: string,
  now: Date,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.webAuthnChallenge.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.webAuthnChallenge.create({
      data: {
        tenantId: await currentTenant(tx),
        userId,
        purpose,
        challenge,
        expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_LIFETIME_MS),
      },
    });
  });
}

/**
 * Takes the live challenge and marks it used in one conditional update, so two
 * concurrent responses cannot both claim it. Returns null when there is none.
 */
async function consumeChallenge(
  tenantId: string,
  userId: string,
  purpose: Purpose,
  now: Date,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.webAuthnChallenge.findFirst({
      where: { userId, purpose, consumedAt: null },
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= now.getTime()) {
      await tx.webAuthnChallenge.update({
        where: { id: row.id },
        data: { consumedAt: now },
      });
      return null;
    }
    const claimed = await tx.webAuthnChallenge.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    return claimed.count === 1 ? row.challenge : null;
  });
}

export async function beginWebAuthnRegistration(
  tenantId: string,
  userId: string,
  rp: RelyingPartyIdentity,
  now: Date = new Date(),
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await withTenant(tenantId, (tx) =>
    tx.webAuthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    }),
  );

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: userId,
    // Registering a key the user already holds silently replaces it on some
    // authenticators; excluding them makes the browser say so instead.
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: row.transports as AuthenticatorTransportFuture[],
    })),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  await issueChallenge(tenantId, userId, 'register', options.challenge, now);
  return options;
}

export type RegistrationOutcome =
  | { ok: true; credentialId: string }
  | { ok: false; reason: string };

export async function finishWebAuthnRegistration(
  tenantId: string,
  userId: string,
  rp: RelyingPartyIdentity,
  label: string,
  response: RegistrationResponseJSON,
  now: Date = new Date(),
): Promise<RegistrationOutcome> {
  const challenge = await consumeChallenge(tenantId, userId, 'register', now);
  if (!challenge) return { ok: false, reason: 'webauthn_no_challenge' };

  // Outside any transaction: attestation verification is CBOR parsing,
  // signature checking and possibly a metadata lookup, and Prisma's
  // interactive transactions time out at 5000 ms.
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch {
    return { ok: false, reason: 'webauthn_registration_rejected' };
  }
  if (!verification.verified) {
    return { ok: false, reason: 'webauthn_registration_rejected' };
  }

  const { credential, fmt } = verification.registrationInfo;

  await withTenant(tenantId, async (tx) => {
    await tx.webAuthnCredential.create({
      data: {
        tenantId: await currentTenant(tx),
        userId,
        credentialId: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: (credential.transports ?? []) as string[],
        attestationType: fmt,
        rpId: rp.id,
        label,
      },
    });
  });

  return { ok: true, credentialId: credential.id };
}

export async function beginWebAuthnAuthentication(
  tenantId: string,
  userId: string,
  rp: RelyingParty,
  now: Date = new Date(),
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const credentials = await withTenant(tenantId, (tx) =>
    tx.webAuthnCredential.findMany({
      where: { userId, rpId: rp.id },
      select: { credentialId: true, transports: true },
    }),
  );

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: credentials.map((row) => ({
      id: row.credentialId,
      transports: row.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: 'preferred',
  });

  await issueChallenge(tenantId, userId, 'authenticate', options.challenge, now);
  return options;
}

export async function hasWebAuthn(tx: TenantClient, userId: string): Promise<boolean> {
  return (await tx.webAuthnCredential.count({ where: { userId } })) > 0;
}

export async function listWebAuthnCredentials(tx: TenantClient, userId: string) {
  return tx.webAuthnCredential.findMany({
    where: { userId },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function removeWebAuthnCredential(
  tx: TenantClient,
  userId: string,
  id: string,
): Promise<void> {
  await tx.webAuthnCredential.deleteMany({ where: { id, userId } });
}

function asAssertion(value: unknown): AuthenticationResponseJSON | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AuthenticationResponseJSON>;
  if (typeof candidate.id !== 'string') return null;
  if (!candidate.response || typeof candidate.response !== 'object') return null;
  const inner = candidate.response as unknown as Record<string, unknown>;
  if (typeof inner['clientDataJSON'] !== 'string') return null;
  if (typeof inner['authenticatorData'] !== 'string') return null;
  if (typeof inner['signature'] !== 'string') return null;
  return candidate as AuthenticationResponseJSON;
}

/**
 * The verifier the chokepoint consults.
 *
 * Three checks beyond the signature, all of which the specification calls for
 * and none of which the library can make on our behalf:
 *
 * - The credential was registered against the RP ID this request arrived on.
 *   Syntra picks a tenant from the Host header, so a credential enrolled at one
 *   tenant's hostname must not assert at another's.
 * - The signature counter strictly increases. A counter that stands still or
 *   goes backwards is how a cloned authenticator shows itself, and the library
 *   only enforces it when it is handed the stored value — which is why the
 *   stored value is passed in and the result is written back.
 * - The stored counter is advanced with a conditional update whose row count is
 *   checked, so two concurrent assertions cannot both be accepted.
 */
export function webauthnVerifier(): FactorVerifier {
  return {
    type: 'webauthn',
    // A user with no factor may add a passkey mid-sign-in when policy demands
    // one: most devices already have a platform authenticator built in.
    enrollable: true,

    async enrolled(tx, userId) {
      return hasWebAuthn(tx, userId);
    },

    async verify(tenantId, userId, presentation, context): Promise<FactorVerifyResult> {
      const { now, relyingParty: rp } = context;
      if (presentation.type !== 'webauthn') {
        return { ok: false, reason: 'webauthn_malformed' };
      }
      const assertion = asAssertion(presentation.assertion);
      if (!assertion) return { ok: false, reason: 'webauthn_malformed' };

      const row = await withTenant(tenantId, (tx) =>
        tx.webAuthnCredential.findFirst({
          where: { credentialId: assertion.id, userId },
        }),
      );
      if (!row) {
        // Consume the challenge anyway: an unknown credential id must not
        // leave a live challenge behind for a second guess.
        await consumeChallenge(tenantId, userId, 'authenticate', now);
        return { ok: false, reason: 'webauthn_unknown_credential' };
      }
      if (row.rpId !== rp.id) {
        await consumeChallenge(tenantId, userId, 'authenticate', now);
        return { ok: false, reason: 'webauthn_wrong_rp' };
      }

      const challenge = await consumeChallenge(tenantId, userId, 'authenticate', now);
      if (!challenge) return { ok: false, reason: 'webauthn_no_challenge' };

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: assertion,
          expectedChallenge: challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          credential: {
            id: row.credentialId,
            publicKey: new Uint8Array(row.publicKey),
            // The column is BigInt because counters are uint32; the library
            // wants a number. Exact well past uint32, so the conversion cannot
            // lose a step.
            counter: Number(row.counter),
            transports: row.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: false,
        });
      } catch (cause) {
        // The library throws rather than returning false when the counter does
        // not advance. Distinguishing that from a bad signature matters: one is
        // a typo-level failure, the other is evidence of a cloned key.
        const message = cause instanceof Error ? cause.message : '';
        if (message.includes('counter')) {
          return { ok: false, reason: 'webauthn_counter_regressed' };
        }
        return { ok: false, reason: 'webauthn_assertion_rejected' };
      }

      if (!verification.verified) {
        return { ok: false, reason: 'webauthn_assertion_rejected' };
      }

      const next = verification.authenticationInfo.newCounter;
      const stored = Number(row.counter);
      if (next <= stored && !(next === 0 && stored === 0)) {
        return { ok: false, reason: 'webauthn_counter_regressed' };
      }

      const advanced = await withTenant(tenantId, (tx) =>
        tx.webAuthnCredential.updateMany({
          where: { id: row.id, counter: { lt: BigInt(next) } },
          data: { counter: BigInt(next), lastUsedAt: now },
        }),
      );
      if (advanced.count !== 1 && next !== 0) {
        return { ok: false, reason: 'webauthn_counter_regressed' };
      }
      if (next === 0) {
        // An authenticator that does not implement a counter reports 0 forever.
        // There is no replay evidence to be had from it; record the use and
        // move on rather than refusing every assertion after the first.
        await withTenant(tenantId, (tx) =>
          tx.webAuthnCredential.update({
            where: { id: row.id },
            data: { lastUsedAt: now },
          }),
        );
      }

      return { ok: true };
    },
  };
}

export function installWebAuthnVerifier(): void {
  registerFactorVerifier(webauthnVerifier());
}
