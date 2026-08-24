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

/** The 8-4-4-4-12 shape `normaliseAnchor` renders a 16-byte anchor into. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The inverse of `normaliseAnchor`: the value to search for, to find the
 * object an anchor names.
 *
 * A Buffer for `objectGUID` and the string itself for a text anchor. It is
 * handed to a PROGRAMMATIC equality filter rather than interpolated into a
 * filter string, and that is not a style preference -- a filter string cannot
 * carry this value at all. RFC 4515 says to write each byte as a hex escape,
 * and ldapts parses a filter string itself and does not turn those escapes
 * back into bytes: the search is well formed, reaches the server, and matches
 * nothing. Silently. Every write-back would report "no such account" against
 * an account that is right there.
 *
 * Building the filter programmatically also means the value never passes
 * through a parser, so there is no escaping to get wrong and no filter
 * injection to defend against.
 *
 * The first three groups are byte-reversed back, because `normaliseAnchor`
 * reversed them on the way in to render the GUID the way Microsoft tooling
 * does. Getting that reversal wrong does not fail loudly either -- it names a
 * DIFFERENT object, and the write-back lands on whoever that is. The tests
 * assert the round trip against the original bytes for exactly that reason.
 */
export function anchorSearchValue(anchor: string): Buffer | string {
  if (!GUID.test(anchor)) return anchor;

  const groups = anchor.split('-');
  const bytes = (hex: string, reverse: boolean): number[] => {
    const pairs = hex.match(/../g) ?? [];
    return (reverse ? [...pairs].reverse() : pairs).map((pair) =>
      Number.parseInt(pair, 16),
    );
  };
  return Buffer.from([
    ...bytes(groups[0]!, true),
    ...bytes(groups[1]!, true),
    ...bytes(groups[2]!, true),
    ...bytes(groups[3]!, false),
    ...bytes(groups[4]!, false),
  ]);
}
