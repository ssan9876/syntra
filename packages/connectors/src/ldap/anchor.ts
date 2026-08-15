/**
 * Turns whatever the server returned for the anchor attribute into a stable
 * string.
 *
 * Active Directory returns objectGUID as 16 raw bytes with the first three
 * groups little-endian. Rendering it the way Microsoft tooling does means an
 * anchor shown in Syntra can be pasted into AD and find the same object.
 * OpenLDAP returns entryUUID as text already.
 */
export function normaliseAnchor(
  attribute: string,
  raw: Buffer | string,
): string {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 16) {
      throw new Error(
        `${attribute} must be 16 bytes, received ${raw.length}`,
      );
    }
    const hex = (start: number, end: number, reverse: boolean) => {
      const slice = raw.subarray(start, end);
      const bytes = reverse ? [...slice].reverse() : [...slice];
      return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    return [
      hex(0, 4, true),
      hex(4, 6, true),
      hex(6, 8, true),
      hex(8, 10, false),
      hex(10, 16, false),
    ].join('-');
  }

  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') {
    throw new Error(`${attribute} is empty; an anchor must identify an object`);
  }
  return trimmed;
}
