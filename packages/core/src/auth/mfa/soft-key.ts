import {
  createSign,
  generateKeyPairSync,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { RelyingParty } from './relying-party.js';

/**
 * Test support only. A software authenticator, shared by the two suites that
 * need one.
 *
 * It lives outside the WebAuthn suite because `authorize()` has to be driven
 * by a real key as well: the chokepoint threads the caller's relying party
 * into the verifier, and a stub verifier that ignores it would let a
 * regression dropping or hardcoding the relying party pass every test — which
 * is the whole of the phishing resistance a security key is bought for.
 */
const b64u = (buf: Buffer) => buf.toString('base64url');

/**
 * A minimal software authenticator: an ES256 key pair, CBOR-encoded COSE
 * public key, and authenticator data assembled by hand. It signs what a real
 * key would sign, so verifyAuthenticationResponse does real work.
 */
export class SoftKey {
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
