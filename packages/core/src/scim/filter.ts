import { ScimError } from './resource.js';

export interface ScimFilter {
  attribute: string;
  value: string;
}

/**
 * `<attribute> eq "<value>"`, case-insensitive on the operator, with escaped
 * quotes inside the value.
 *
 * Deliberately nothing else. That is not a shortcut taken to save work — it is
 * what Entra and Okta actually send, every time, because their provisioning
 * flows correlate by exactly one attribute before deciding whether to POST or
 * PATCH. The rest of the grammar — `and`, `or`, `not`, `co`, `sw`, `pr`,
 * complex attribute paths, nested groupings — is a parser with its own surface
 * and its own bugs, written to serve no client this product will meet.
 *
 * The important half is the REFUSAL. A filter this server half-understands and
 * applies wrongly returns the wrong users, and the client believes the answer:
 * an unmatched `userName eq` becomes a POST, and a filter that silently
 * ignored an `and` clause returns somebody else's account and becomes a PATCH
 * of it. A 400 an integrator can read is strictly better than a plausible
 * wrong answer.
 */
const EQ = /^\s*(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

export function parseScimFilter(
  filter: string | undefined,
  allowed: readonly string[],
): ScimFilter | null {
  if (filter === undefined || filter.trim() === '') return null;

  const match = EQ.exec(filter);
  if (match === null) {
    throw new ScimError(
      400,
      'invalidFilter',
      `Only '<attribute> eq "value"' is supported, for: ${allowed.join(', ')}`,
    );
  }

  const attribute = match[1]!;
  // Case-insensitively, because SCIM attribute names are case-insensitive and
  // a client sending `username` is not making a mistake.
  const known = allowed.find(
    (candidate) => candidate.toLowerCase() === attribute.toLowerCase(),
  );
  if (known === undefined) {
    throw new ScimError(
      400,
      'invalidFilter',
      `Cannot filter on '${attribute}'. Supported: ${allowed.join(', ')}`,
    );
  }

  // `\"` back to `"`, `\\` back to `\`. Anything else escaped is passed
  // through as itself: this is a value, not a pattern, and it goes into a
  // Prisma `where` as data rather than into SQL.
  const value = match[2]!.replace(/\\(.)/g, '$1');

  return { attribute: known, value };
}

/**
 * `startIndex` and `count`, validated.
 *
 * 1-BASED. `startIndex=0` is refused rather than quietly read as 1: a client
 * that is off by one is a client whose next page skips a resource, and
 * silently correcting it hides the bug until somebody notices a missing user.
 */
export function parsePagination(
  startIndex: string | undefined,
  count: string | undefined,
  maxCount: number,
): { startIndex: number; count: number } {
  const parsedStart = startIndex === undefined ? 1 : Number(startIndex);
  if (!Number.isInteger(parsedStart) || parsedStart < 1) {
    throw new ScimError(400, 'invalidValue', 'startIndex is 1-based and must be at least 1');
  }

  const parsedCount = count === undefined ? maxCount : Number(count);
  if (!Number.isInteger(parsedCount) || parsedCount < 0) {
    throw new ScimError(400, 'invalidValue', 'count must be zero or more');
  }

  // Capped rather than refused: a client asking for more than the server will
  // give is not making an error, and `ServiceProviderConfig` publishes the cap
  // so it can know before it asks.
  return { startIndex: parsedStart, count: Math.min(parsedCount, maxCount) };
}
