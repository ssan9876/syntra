import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  createHash,
  randomBytes,
} from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import type { RelyingParty, RelyingPartyIdentity } from './relying-party.js';
import {
  beginWebAuthnAuthentication,
  beginWebAuthnRegistration,
  finishWebAuthnRegistration,
  hasWebAuthn,
  listWebAuthnCredentials,
  removeWebAuthnCredential,
  webauthnVerifier,
} from './webauthn.js';

let tenantId: string;
let userId: string;

/** What verification needs. */
const RP: RelyingParty = {
  id: 'acme.syntra.test',
  origin: 'http://acme.syntra.test',
};

/** What registration needs: the same, plus a name for the browser prompt. */
const RP_ID: RelyingPartyIdentity = { ...RP, name: 'Acme' };

const b64u = (buf: Buffer) => buf.toString('base64url');

/**
 * A minimal software authenticator: an ES256 key pair, CBOR-encoded COSE
 * public key, and authenticator data assembled by hand. It signs what a real
 * key would sign, so verifyAuthenticationResponse does real work.
 */
class SoftKey {
  readonly credentialId = randomBytes(32);
  counter = 0;
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as {
      x: string;
      y: string;
    };
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    // CBOR map of 5 pairs: kty 2, alg -7, crv 1, x, y.
    return Buffer.concat([
      Buffer.from([0xa5]),
      Buffer.from([0x01, 0x02]),
      Buffer.from([0x03, 0x26]),
      Buffer.from([0x20, 0x01]),
      Buffer.from([0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ]);
  }

  private authData(rpId: string, includeCredential: boolean): Buffer {
    const rpIdHash = createHash('sha256').update(rpId).digest();
    // UP | UV, plus AT when an attested credential is included.
    const flags = Buffer.from([includeCredential ? 0x45 : 0x05]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    if (!includeCredential) return Buffer.concat([rpIdHash, flags, counter]);

    const aaguid = Buffer.alloc(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([
      rpIdHash,
      flags,
      counter,
      aaguid,
      idLength,
      this.credentialId,
      this.coseKey(),
    ]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(challenge: string, rp: RelyingParty) {
    const authData = this.authData(rp.id, true);
    const clientDataJSON = this.clientData('webauthn.create', challenge, rp.origin);
    // fmt "none", attStmt {}, authData.
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      Buffer.from([0x63]),
      Buffer.from('fmt'),
      Buffer.from([0x64]),
      Buffer.from('none'),
      Buffer.from([0x67]),
      Buffer.from('attStmt'),
      Buffer.from([0xa0]),
      Buffer.from([0x68]),
      Buffer.from('authData'),
      Buffer.from([0x59]),
      (() => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(authData.length);
        return len;
      })(),
      authData,
    ]);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['usb' as const],
      },
    };
  }

  assert(challenge: string, rp: RelyingParty, counterOverride?: number) {
    if (counterOverride !== undefined) this.counter = counterOverride;
    else this.counter += 1;

    const authData = this.authData(rp.id, false);
    const clientDataJSON = this.clientData('webauthn.get', challenge, rp.origin);
    const signed = Buffer.concat([
      authData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const signature = createSign('SHA256').update(signed).sign(this.keys.privateKey);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
    };
  }
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

async function register(key: SoftKey, label = 'YubiKey') {
  const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
  return finishWebAuthnRegistration(
    tenantId,
    userId,
    RP_ID,
    label,
    key.register(options.challenge, RP) as never,
  );
}

const verify = (assertion: unknown, at = new Date(), rp: RelyingParty = RP) =>
  webauthnVerifier().verify(
    tenantId,
    userId,
    { type: 'webauthn', assertion },
    { now: at, relyingParty: rp },
  );

describe('WebAuthn registration', () => {
  it('stores the credential with its public key, counter and RP ID', async () => {
    const key = new SoftKey();
    const outcome = await register(key);
    expect(outcome).toMatchObject({ ok: true });

    const row = await withTenant(tenantId, (tx) => tx.webAuthnCredential.findFirst());
    expect(row).toMatchObject({
      userId,
      rpId: RP.id,
      label: 'YubiKey',
      attestationType: 'none',
      transports: ['usb'],
    });
    expect(row!.publicKey.length).toBeGreaterThan(0);
    expect(await withTenant(tenantId, (tx) => hasWebAuthn(tx, userId))).toBe(true);
  });

  it('consumes the challenge, so a registration cannot be replayed', async () => {
    const key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    const response = key.register(options.challenge, RP);
    await finishWebAuthnRegistration(tenantId, userId, RP_ID, 'One', response as never);

    const again = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_ID,
      'Two',
      response as never,
    );
    expect(again).toEqual({ ok: false, reason: 'webauthn_no_challenge' });
  });

  it('refuses a registration from a different origin', async () => {
    const key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    const evil: RelyingParty = { ...RP, origin: 'http://evil.example' };
    const outcome = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_ID,
      'Bad',
      key.register(options.challenge, evil) as never,
    );
    expect(outcome).toEqual({ ok: false, reason: 'webauthn_registration_rejected' });
  });

  it('refuses a registration for a different RP ID', async () => {
    const key = new SoftKey();
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    const evil: RelyingParty = { ...RP, id: 'evil.example' };
    const outcome = await finishWebAuthnRegistration(
      tenantId,
      userId,
      RP_ID,
      'Bad',
      key.register(options.challenge, evil) as never,
    );
    expect(outcome).toEqual({ ok: false, reason: 'webauthn_registration_rejected' });
  });

  it('excludes credentials the user already holds', async () => {
    const key = new SoftKey();
    await register(key);
    const options = await beginWebAuthnRegistration(tenantId, userId, RP_ID);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([
      key.credentialId.toString('base64url'),
    ]);
  });
});

describe('WebAuthn assertion', () => {
  let key: SoftKey;

  beforeEach(async () => {
    key = new SoftKey();
    await register(key);
  });

  it('accepts a valid assertion and advances the stored counter', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const result = await verify(key.assert(options.challenge, RP));
    expect(result).toEqual({ ok: true });

    const row = await withTenant(tenantId, (tx) => tx.webAuthnCredential.findFirst());
    // The column is BigInt (see webauthn.ts's note on why); the software
    // authenticator's counter is a plain number.
    expect(Number(row!.counter)).toBe(key.counter);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('refuses a counter that goes backwards — the mark of a cloned key', async () => {
    const first = await beginWebAuthnAuthentication(tenantId, userId, RP);
    await verify(key.assert(first.challenge, RP));

    const second = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const result = await verify(key.assert(second.challenge, RP, 1));
    expect(result).toEqual({ ok: false, reason: 'webauthn_counter_regressed' });
  });

  it('still classifies the library counter error by its message', async () => {
    // webauthnVerifier distinguishes a cloned key from a bad signature by
    // looking for "counter" in the message @simplewebauthn/server throws.
    // Confirmed against verifyAuthenticationResponse.js:144-150 in 13.3.2 —
    // this test is what notices if a future version rewords it, because the
    // classification would silently degrade to webauthn_assertion_rejected and
    // a cloned key would look like a typo.
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const assertion = key.assert(options.challenge, RP);
    const row = await withTenant(tenantId, (tx) => tx.webAuthnCredential.findFirst());

    await expect(
      verifyAuthenticationResponse({
        response: assertion as never,
        expectedChallenge: options.challenge,
        expectedOrigin: RP.origin,
        expectedRPID: RP.id,
        credential: {
          id: row!.credentialId,
          publicKey: new Uint8Array(row!.publicKey),
          // Ahead of what the authenticator will report, so the guard fires.
          counter: key.counter + 5,
          transports: [],
        },
        requireUserVerification: false,
      }),
    ).rejects.toThrow(/counter/i);
  });

  it('refuses a counter that stands still', async () => {
    const first = await beginWebAuthnAuthentication(tenantId, userId, RP);
    await verify(key.assert(first.challenge, RP));
    const used = key.counter;

    const second = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const result = await verify(key.assert(second.challenge, RP, used));
    expect(result).toEqual({ ok: false, reason: 'webauthn_counter_regressed' });
  });

  it('refuses an assertion over a challenge that was never issued', async () => {
    const result = await verify(key.assert('bm90LWEtY2hhbGxlbmdl', RP));
    expect(result).toEqual({ ok: false, reason: 'webauthn_no_challenge' });
  });

  it('refuses a replayed assertion', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const assertion = key.assert(options.challenge, RP);
    expect(await verify(assertion)).toEqual({ ok: true });
    expect(await verify(assertion)).toEqual({ ok: false, reason: 'webauthn_no_challenge' });
  });

  it('refuses an assertion signed for another origin', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const evil: RelyingParty = { ...RP, origin: 'http://evil.example' };
    const result = await verify(key.assert(options.challenge, evil));
    expect(result).toEqual({ ok: false, reason: 'webauthn_assertion_rejected' });
  });

  it('refuses an assertion signed under another RP ID', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const evil: RelyingParty = { ...RP, id: 'evil.example' };
    const result = await verify(key.assert(options.challenge, evil));
    expect(result).toEqual({ ok: false, reason: 'webauthn_assertion_rejected' });
  });

  it('refuses a credential registered under a different RP ID than the request', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const assertion = key.assert(options.challenge, RP);
    // Same assertion, different host on the request. Syntra picks a tenant
    // from the Host header, so a credential enrolled at one tenant hostname
    // must not assert at another tenant.
    const result = await verify(assertion, new Date(), {
      ...RP,
      id: 'other.syntra.test',
    });
    expect(result).toEqual({ ok: false, reason: 'webauthn_wrong_rp' });
  });

  it('refuses an unknown credential id', async () => {
    const options = await beginWebAuthnAuthentication(tenantId, userId, RP);
    const stranger = new SoftKey();
    const result = await verify(stranger.assert(options.challenge, RP));
    expect(result).toEqual({ ok: false, reason: 'webauthn_unknown_credential' });
  });

  it('refuses garbage that is not an assertion at all', async () => {
    expect(await verify({ nonsense: true })).toEqual({
      ok: false,
      reason: 'webauthn_malformed',
    });
    expect(await verify(null)).toEqual({ ok: false, reason: 'webauthn_malformed' });
  });
});

describe('listing and removal', () => {
  it('lists credentials without their public keys', async () => {
    await register(new SoftKey(), 'Laptop');
    const rows = await withTenant(tenantId, (tx) => listWebAuthnCredentials(tx, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Laptop' });
    expect(JSON.stringify(rows)).not.toContain('publicKey');
  });

  it('removes only the named credential and only for its owner', async () => {
    await register(new SoftKey(), 'A');
    const rows = await withTenant(tenantId, (tx) => listWebAuthnCredentials(tx, userId));
    await withTenant(tenantId, (tx) => removeWebAuthnCredential(tx, userId, rows[0]!.id));
    expect(await withTenant(tenantId, (tx) => hasWebAuthn(tx, userId))).toBe(false);
  });
});
