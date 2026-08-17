/**
 * The provenance marker: one format, one parser, and every caller on both.
 *
 * The marker is what makes a non-idempotent `create_account` safe to retry.
 * A create that lands and then loses its response leaves an object in the
 * target that nothing in Syntra has recorded; the next run finds it by
 * correlation key and has to answer one question about it — *did this action
 * create it?* Answer "no" wrongly and the create is a permanent `conflict`
 * over an account Syntra itself made. Answer "yes" wrongly and Syntra hands
 * one person's existing account to another.
 *
 * That question is answered by writing a marker on the create and reading it
 * back later. **The write and the read live in two different packages** —
 * `@syntra/connectors` writes it inside `adTargetConnector.write`, and
 * `@syntra/core`'s apply loop reads it back off `connector.read` when it
 * resolves in-flight actions after an interrupted run. Two hand-rolled halves
 * of one format drift, and the drift is silent in the direction that matters:
 * a reader that no longer recognises the marker reports every interrupted
 * create as somebody else's account.
 *
 * So the format is not a string literal anywhere. It is
 * {@link provenanceValue} and {@link provenanceActionId}, and the composite
 * {@link readProvenanceActionId} for a caller holding an attribute bag rather
 * than a single value.
 */

/**
 * The literal that opens a marker.
 *
 * Deliberately not a bare id: the attribute it lives in is an ordinary Notes
 * field an administrator also writes to, so the marker has to be
 * recognisable *inside* other text rather than owning the whole value.
 */
export const PROVENANCE_MARKER_PREFIX = 'syntra-provision action=';

/** What a disable reason is prefixed with, so a later disable can replace it. */
const NOTE_PREFIX = '[syntra] ';

/**
 * Matches one whole marker: the prefix, at a token boundary, and the
 * non-whitespace run after it.
 *
 * `(?:^|\s)` is why the marker survives being embedded in an administrator's
 * own text, and `\S+` is why the id is read whole. Neither piece is optional:
 * without the boundary `notsyntra-provision action=x` parses, and without the
 * whole-token capture `abc-1` matches an object created by `abc-10`.
 *
 * The prefix carries no regular-expression metacharacters, which is the only
 * reason it can be interpolated here; `provenanceValue` refuses an id that
 * would break the same assumption from the other side.
 */
const MARKER = new RegExp(`(?:^|\\s)${PROVENANCE_MARKER_PREFIX}(\\S+)`);
const EVERY_MARKER = new RegExp(`(?:^|\\s)${PROVENANCE_MARKER_PREFIX}\\S+`, 'g');

/**
 * The marker naming `actionId`. The only place this string is built.
 *
 * Refuses an id carrying whitespace rather than writing a marker that reads
 * back as a different id than the one it was given. `provenanceActionId`
 * stops at the first space, so `provenanceActionId(provenanceValue(x)) === x`
 * would quietly stop holding — and that round trip is the entire guarantee
 * this pair exists to provide. Action ids are cuids; an id with a space in it
 * is a bug upstream, and it should surface where it is introduced.
 */
export function provenanceValue(actionId: string): string {
  if (actionId === '' || /\s/.test(actionId)) {
    throw new Error(
      `an action id cannot be written into a provenance marker if it is empty or contains whitespace; received ${JSON.stringify(actionId)}`,
    );
  }
  return `${PROVENANCE_MARKER_PREFIX}${actionId}`;
}

/**
 * The action id a provenance marker names, or undefined.
 *
 * Parsed and compared whole, never `marker.includes(actionId)`. A substring
 * test adopts the account created by action `abc-10` while replaying action
 * `abc-1` -- which is the one outcome the marker exists to prevent, handing
 * one person's account to another. Ids are cuids in production and a
 * prefix collision is unlikely; "unlikely" is not the guarantee this check is
 * supposed to carry.
 *
 * Callers compare the RESULT with `===`. There is no shape of this function's
 * output that a substring test on the input would be the right way to use.
 */
export function provenanceActionId(marker: string): string | undefined {
  return MARKER.exec(marker)?.[1];
}

/**
 * The action id named by an object's provenance attribute, or undefined.
 *
 * The read half, for a caller holding an attribute bag rather than one value:
 * `@syntra/core`'s apply loop reads `SourceRecord.attributes`, the connector
 * reads an ldapts entry, and both are `Record<string, unknown>` in practice.
 *
 * Two things it does that a caller reaching into the bag by hand does not:
 *
 * - **`provenanceAttribute`, never the literal `info`.** The attribute is
 *   configurable and a deployment that nominated an extensionAttribute would
 *   otherwise have every interrupted create read as somebody else's account.
 * - **Case-insensitive on the key and multi-valued tolerant.** LDAP attribute
 *   names fold case and the server chooses the spelling it returns.
 */
export function readProvenanceActionId(
  attributes: Readonly<Record<string, unknown>>,
  provenanceAttribute: string,
): string | undefined {
  const key = Object.keys(attributes).find(
    (name) => name.toLowerCase() === provenanceAttribute.toLowerCase(),
  );
  if (key === undefined) return undefined;
  for (const value of toValues(attributes[key])) {
    const actionId = provenanceActionId(value);
    if (actionId !== undefined) return actionId;
  }
  return undefined;
}

/**
 * The value to write into the provenance attribute so that it carries exactly
 * one marker for `actionId` and keeps everything else it already held.
 *
 * `create_account` builds its `add` from an account profile's attribute
 * templates, and a template is perfectly entitled to write to `info`. Letting
 * either side simply win is wrong in both directions: the template winning
 * makes the object unrecognisable as ours, so one failed password write turns
 * the create into a permanent conflict; the marker winning silently discards
 * what the administrator asked to be written.
 *
 * Neither has to win, because the parser reads a marker embedded in other
 * text. Any marker already present is stripped first, so re-composing is
 * idempotent and the result never names two actions.
 */
export function withProvenanceMarker(
  existing: string | undefined,
  actionId: string,
): string {
  // The marker first: it is the machine-readable part, and a value that gets
  // truncated somewhere downstream loses prose before it loses meaning.
  return [provenanceValue(actionId), ...withoutMarkers(existing)].join('\n');
}

/**
 * The value to write into the provenance attribute when disabling, carrying
 * the reason and keeping everything else — the marker included.
 *
 * The previous implementation wrote `replace` over the literal `info` with
 * `[syntra] <reason>` and nothing else. That destroyed whatever an
 * administrator had in Notes, and by default destroyed the provenance marker
 * with it, which is worse than the lost prose: an account disabled by the
 * ladder is exactly an account a later run may need to recognise as Syntra's.
 *
 * A previous `[syntra]` note is replaced rather than accumulated, so
 * disabling twice does not grow the attribute without bound.
 *
 * Deliberately **not** length-capped. `info` on Active Directory holds 1024
 * characters, but the attribute is configurable and guessing a limit for one
 * that was not nominated here would silently truncate an administrator's
 * text. An over-long value is refused by the directory, classified by
 * `classifyLdapError` and reported — which is the loud failure this
 * subsystem prefers to a quiet lossy write.
 */
export function withProvenanceNote(existing: string | undefined, note: string): string {
  const kept = splitLines(existing).filter(
    (line) => !line.trimStart().startsWith(NOTE_PREFIX),
  );
  return [...kept, `${NOTE_PREFIX}${note}`].join('\n');
}

function splitLines(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  return value.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** Every line of `existing`, with any marker token removed from each. */
function withoutMarkers(existing: string | undefined): string[] {
  return splitLines(existing)
    .map((line) => line.replace(EVERY_MARKER, '').trimEnd())
    .filter((line) => line.trim() !== '');
}

function toValues(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((value) =>
    Buffer.isBuffer(value) ? value.toString('utf8') : String(value),
  );
}
