import type { Client } from 'ldapts';

/**
 * Active Directory's default `MaxValRange`. A group with more members than
 * this comes back as `member;range=0-1499` instead of `member`, and the
 * caller is expected to ask for the next window.
 */
export const RANGE_STEP = 1500;

export interface RangeKey {
  attribute: string;
  low: number;
  /** `'*'` marks the final window. It is the terminator, not a count. */
  high: number | '*';
}

const RANGE_PATTERN = /^([A-Za-z]+);range=(\d+)-(\d+|\*)$/i;

export function parseRangeKey(key: string): RangeKey | undefined {
  const match = RANGE_PATTERN.exec(key);
  if (!match) return undefined;
  const [, attribute, low, high] = match;
  return {
    attribute: attribute!,
    low: Number(low),
    high: high === '*' ? '*' : Number(high),
  };
}

function valuesOf(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

/**
 * Reads one multi-valued attribute in full, walking Active Directory's range
 * windows until the server marks the last one with an asterisk.
 *
 * **This never returns a partial result.** If any window fails, it throws, and
 * the caller marks the record a read failure. Half a membership is the single
 * most dangerous value in this subsystem: read naively it is a group with
 * 1,500 members that has 4,000, and the diff then proposes granting it to
 * 2,500 people or revoking it from them, depending on which way the rules
 * happen to fall. Ruling P1 exists because failing loudly was the right
 * interim behaviour for a reader and is not sufficient for a writer.
 */
export async function readRangedAttribute(
  client: Pick<Client, 'search'>,
  dn: string,
  attribute: string,
  options: { pageStep: number },
): Promise<string[]> {
  const collected: string[] = [];
  let spec = attribute;
  let previousSpec: string | undefined;
  // How many requests have been issued. The FIRST response coming back with
  // neither a plain attribute nor a ranged one means the object holds no
  // values; any LATER one means the enumeration stopped mid-walk, and those
  // two must not share a return path.
  let requested = 0;

  for (;;) {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: [spec],
    });
    requested += 1;

    const entry = (searchEntries[0] ?? {}) as Record<string, unknown>;

    // The plain name comes back when the attribute fits in one response, and
    // also on the very first request for a small group.
    const plain = Object.keys(entry).find(
      (key) => key.toLowerCase() === attribute.toLowerCase(),
    );
    if (plain) {
      collected.push(...valuesOf(entry[plain]));
      return collected;
    }

    const rangedKey = Object.keys(entry).find((key) => {
      const parsed = parseRangeKey(key);
      return parsed && parsed.attribute.toLowerCase() === attribute.toLowerCase();
    });

    // No plain attribute and no ranged one.
    //
    // On the first request that means the object genuinely holds no values for
    // it: an empty group is a real thing and must not be confused with an
    // unreadable one, so this returns [].
    //
    // On any later request it means the opposite. A walk was under way -- the
    // server had already answered with a bounded window -- and it has now
    // stopped answering, because of a transient, a referral, a sizelimit or a
    // replication hiccup. Returning what has been collected so far hands back
    // 1,500 members of a 4,000-member group as though that were the whole
    // membership, which is precisely the value the docstring above says this
    // function exists to prevent.
    if (!rangedKey) {
      if (requested > 1) {
        throw new Error(
          `the directory stopped returning ${attribute} on ${dn} partway through a ranged ` +
            `read; ${collected.length} values were collected and the enumeration is incomplete`,
        );
      }
      return collected;
    }

    const parsed = parseRangeKey(rangedKey)!;
    collected.push(...valuesOf(entry[rangedKey]));

    if (parsed.high === '*') return collected;

    const next = `${attribute};range=${parsed.high + 1}-${parsed.high + options.pageStep}`;
    if (next === previousSpec || next === spec) {
      throw new Error(
        `the directory returned the same range window twice for ${attribute} on ${dn}; ` +
          `the enumeration did not advance and would not terminate`,
      );
    }
    previousSpec = spec;
    spec = next;
  }
}
