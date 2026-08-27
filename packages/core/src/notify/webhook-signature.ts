import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How far a delivery's timestamp may sit from the receiver's clock.
 *
 * Five minutes, which is the same tolerance every comparable product uses,
 * and for the same reason: it has to absorb ordinary clock skew between two
 * machines nobody promised were synchronised, while still being short enough
 * that a captured delivery is worthless by the time anyone has it.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The signature Syntra puts on an outgoing webhook.
 *
 *     X-Syntra-Signature: t=1787832000,v1=<hex sha256 hmac>
 *
 * The digest covers `"<t>.<body>"`, NOT the body alone. That is the whole
 * point of the timestamp being in the header: a signature over the body by
 * itself is a bearer token for that body for ever, and an attacker who
 * recorded one delivery could replay it indefinitely with whatever `t` they
 * liked. Binding the two together means a replay has to carry the original
 * timestamp, and the original timestamp is what `verifyWebhook` rejects.
 *
 * The scheme is versioned (`v1=`) so a future digest can be added alongside
 * rather than swapped underneath receivers who would then silently reject
 * everything.
 */
export function signWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const digest = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${digest}`;
}

/**
 * The reference verification, exported so it is not something every integrator
 * has to reinvent from prose — and so the documentation for this feature can
 * point at code that is covered by tests rather than at a paragraph.
 *
 * Returns false for everything: a bad digest, a stale timestamp, a header that
 * does not parse. It never throws. A receiver that throws on a malformed
 * signature is a receiver anybody on the internet can crash by sending it two
 * bytes, and this function is meant to sit on the edge of one.
 */
export function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  now: Date,
): boolean {
  const parsed = parseHeader(header);
  if (parsed === null) return false;

  // Checked in BOTH directions. A receiver whose clock is behind ours would
  // otherwise accept a timestamp arbitrarily far in the future, which is the
  // replay window reopened from the other side.
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - parsed.t);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${parsed.t}.${body}`).digest('hex'),
    'utf8',
  );
  const given = Buffer.from(parsed.v1, 'utf8');
  // Length-checked first: `timingSafeEqual` throws when the two differ, and
  // the throw would be the crash described above.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function parseHeader(header: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      t = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      v1 = value;
    }
  }
  if (t === null || v1 === null) return null;
  return { t, v1 };
}
