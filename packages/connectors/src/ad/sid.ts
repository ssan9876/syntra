/**
 * The relative identifier at the end of a security identifier.
 *
 * A user's primary group is not held in the group's `member` attribute. It is
 * held on the USER, as `primaryGroupID`, and its value is the RID -- the last
 * sub-authority -- of the group's `objectSid`. That is the only way to tell,
 * from the two objects, whether a given group is a given user's primary one,
 * and without it a revoke against a primary group is attempted, refused by the
 * directory with `noSuchAttribute` (the DN is genuinely not in `member`) and
 * then reported as `ok: true, "already in the requested state"` -- a failure
 * reported as a success, with the person keeping the access.
 *
 * ## The binary layout
 *
 * Active Directory stores `objectSid` as raw bytes:
 *
 * ```
 *   0        revision (1 byte)
 *   1        sub-authority count (1 byte)
 *   2..7     identifier authority (6 bytes, BIG-endian)
 *   8..      sub-authorities (4 bytes each, LITTLE-endian)
 * ```
 *
 * The two endiannesses in one structure are not a mistake in this comment;
 * they are the format. Only the last sub-authority is wanted here.
 *
 * The text form (`S-1-5-21-1004336348-1177238915-682003330-513`) is accepted
 * too, because a directory that is not Active Directory, or a caller that
 * normalised the value on the way in, may present it that way. Anything else
 * -- a truncated buffer, a string that is not a SID, a value the server did
 * not return -- is `undefined`, and the caller must treat that as "not
 * established" rather than as "not the primary group".
 */
export function objectSidRid(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return undefined;

  if (Buffer.isBuffer(value)) return ridFromBytes(value);

  const text = String(value).trim();
  if (text === '') return undefined;
  if (/^S-1-/i.test(text)) {
    const last = text.split('-').at(-1);
    const rid = Number(last);
    return Number.isInteger(rid) && rid >= 0 ? rid : undefined;
  }
  // ldapts decodes an attribute's bytes as UTF-8 when they happen to be valid
  // UTF-8, so a SID can arrive here as a string of the raw octets rather than
  // as a Buffer. Reading it back through latin1 would corrupt it; the bytes
  // are recovered the way they were decoded.
  return ridFromBytes(Buffer.from(text, 'utf8'));
}

function ridFromBytes(bytes: Buffer): number | undefined {
  if (bytes.length < 8) return undefined;
  const subAuthorityCount = bytes[1] ?? 0;
  if (subAuthorityCount === 0) return undefined;
  const end = 8 + subAuthorityCount * 4;
  if (bytes.length < end) return undefined;
  return bytes.readUInt32LE(end - 4);
}
