import {
  renderTemplate,
  resolveReference,
  templateReferences,
  type TemplateContext,
} from './templates.js';

/**
 * `sAMAccountName` is capped at 20 characters by Active Directory, must be
 * unique in the domain, and is the thing a collision actually collides on.
 */
export const SAM_ACCOUNT_NAME_MAX_LENGTH = 20;

/**
 * Letters that survive NFKD decomposition with no ASCII inside them: strokes,
 * ligatures and the handful of letters that simply are not a Latin base letter
 * plus an accent.
 *
 * Applied *after* decomposition rather than before, so a precomposed letter
 * that carries both a stroke and an accent is still folded: `Ǿ` decomposes to
 * `Ø` plus an acute, the acute is dropped, and the `Ø` that is left reaches
 * this table. Folding first would leave `Ǿ` untouched and drop it entirely.
 *
 * `ĳ`, `ﬁ`, `ŀ` and `ŉ` are absent on purpose — NFKD already turns those into
 * ASCII, and `names.test.ts` proves it rather than assuming it.
 */
const LIGATURES = new Map<string, string>([
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['ß', 'ss'],
  ['ẞ', 'SS'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['ł', 'l'],
  ['Ł', 'L'],
  ['þ', 'th'],
  ['Þ', 'TH'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
  ['ŧ', 't'],
  ['Ŧ', 'T'],
  ['ı', 'i'],
  ['ĸ', 'k'],
  ['ə', 'e'],
  ['Ə', 'E'],
]);

/**
 * Folds a name to ASCII: accents to their base letters, the handful of letters
 * that need a table, and anything with no ASCII equivalent dropped.
 *
 * Dropped, not replaced with a placeholder: a login containing `?` is worse
 * than a shorter one, and a name that folds away entirely is caught by the
 * caller as an unresolvable template rather than becoming an empty login.
 *
 * Compatibility decomposition (NFKD) rather than canonical (NFD), because NFD
 * leaves `ĳ` — one character, and the ordinary spelling of a Dutch name —
 * with no ASCII in it at all, so `Ĳsbrand` would fold to `sbrand` and become
 * somebody else's login. NFKD also normalises full-width forms and the
 * non-breaking space, both of which arrive from spreadsheet exports.
 */
export function foldToAscii(value: string): string {
  const decomposed = value
    .normalize('NFKD')
    // Combining diacritical marks.
    .replace(/[\u0300-\u036f]/g, '');
  return [...decomposed]
    .map((character) => LIGATURES.get(character) ?? character)
    .join('')
    .replace(/[^ -~]/g, '');
}

export interface NameGenerationInput {
  template: string;
  context: TemplateContext;
  /**
   * Every key already reserved: Syntra's own `TargetAccount.correlationKey`
   * rows for this target, unioned with the target's current inventory. Both,
   * because Syntra holds keys the target has not seen yet (a `pending`
   * account) and the target holds keys Syntra never made — `krbtgt`,
   * `Administrator`, and every account somebody created by hand.
   *
   * Compared case-insensitively. `sAMAccountName` is case-insensitive in
   * Active Directory, so an inventory entry of `Anna.Novak` reserves
   * `anna.novak`; a case-sensitive `Set.has` would hand out a key the
   * directory then refuses on the write, and the refusal arrives one network
   * round trip and one audit event too late.
   */
  taken: ReadonlySet<string>;
  maxLength: number;
  maxAttempts: number;
}

export type NameGenerationResult =
  | { ok: true; correlationKey: string }
  | { ok: false; reason: 'template_unresolvable'; missing: string[] }
  | { ok: false; reason: 'exhausted'; attempts: number };

/** Lowercased, ASCII-folded, apostrophes and spaces and anything else stripped. */
function sanitise(value: string): string {
  return foldToAscii(value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');
}

/**
 * Names the fields behind a value that folded away to nothing.
 *
 * Derived from the template's own placeholders rather than from every key in
 * `context.person`: a template may resolve entirely out of `contract`, and a
 * person record carries fields no template mentions. Reporting the whole
 * person map would name empty fields nobody asked for and stay silent about
 * the contract field that actually produced the empty key.
 */
function foldedAwayFields(input: NameGenerationInput): string[] {
  const references = templateReferences(input.template);
  const folded = references.filter(
    (name) => sanitise(resolveReference(input.context, name) ?? '') === '',
  );
  if (folded.length > 0) return folded;
  // Every referenced value has ASCII in it somewhere, but what the modifiers
  // selected out of them did not — `%person.givenName.initial%` on `李Anna`.
  // Nothing narrower than "one of these" is true.
  if (references.length > 0) return references;
  // A template with no placeholders at all that sanitises to nothing, e.g.
  // `"---"`. There is no field to name.
  return ['template'];
}

/**
 * Generates a correlation key, trying the base value then the base value with
 * an incrementing numeric suffix, truncating from the right to stay within the
 * cap **while preserving the suffix**.
 *
 * Preserving the suffix is the load-bearing half. Truncating a 20-character
 * limit naively cuts the digits off, which produces exactly the name the
 * suffix was invented to avoid — and the uniqueness check then passes because
 * the truncated candidate was never in `taken`, right up until the target
 * refuses it.
 *
 * A generation that cannot produce a unique key within the attempt limit does
 * not pick something arbitrary. It fails, and the caller makes that person
 * unprocessable for that target and says so by name.
 *
 * Uniqueness is *checked* here and *enforced* by the unique index on
 * `(tenantId, targetSystemId, correlationKey)`. All three columns are NOT
 * NULL, so that index constrains every row — PostgreSQL would not constrain
 * rows where any of them was null. Two concurrent runs generating the same
 * name for two different people is a race the database refuses, not one this
 * function is trusted to avoid.
 *
 * Pure: no clock, no database, no I/O.
 *
 * @throws RangeError if `maxLength` is not a positive integer. That is a
 * programming error rather than bad data — no administrator-settable field
 * feeds it — and the alternatives are worse: `maxLength: 0` yields the empty
 * login, and a negative one makes `slice(0, room)` count from the end and
 * return a key longer than the cap it was given.
 */
export function generateCorrelationKey(
  input: NameGenerationInput,
): NameGenerationResult {
  if (!Number.isInteger(input.maxLength) || input.maxLength < 1) {
    throw new RangeError(
      `maxLength must be a positive integer, received ${String(input.maxLength)}`,
    );
  }

  const rendered = renderTemplate(input.template, input.context);
  if (!rendered.ok) {
    return {
      ok: false,
      reason: 'template_unresolvable',
      missing: rendered.missing,
    };
  }

  const base = sanitise(rendered.value).replace(/^[.-]+|[.-]+$/g, '');
  if (base === '') {
    // The template resolved, but every character folded away — a name written
    // entirely in a script with no ASCII equivalent. Report it the same way as
    // an unresolvable template, naming the fields that produced nothing, so
    // the exception a human reads points at a record they can fix.
    return {
      ok: false,
      reason: 'template_unresolvable',
      missing: foldedAwayFields(input),
    };
  }

  // `sAMAccountName` is case-insensitive at the target, and this generator
  // only ever emits lowercase, so the comparison is done in lowercase on both
  // sides.
  const reserved = new Set<string>();
  for (const key of input.taken) reserved.add(key.trim().toLowerCase());

  let attempted = 0;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const suffix = attempt === 1 ? '' : String(attempt);
    const room = input.maxLength - suffix.length;
    // The suffix alone has filled the cap. Every further attempt is longer, so
    // there is nothing left to try rather than a key to truncate into shape.
    if (room < 1) break;
    attempted = attempt;

    // A truncation that lands on a separator would end the key in `.` or `-`.
    // Active Directory refuses a `sAMAccountName` ending in a period outright,
    // and `anna.` is not a name anybody meant. Trimming can never empty the
    // candidate: `base` starts with a letter or a digit.
    const truncated = base.slice(0, room).replace(/[.-]+$/, '');
    const candidate = `${truncated}${suffix}`;
    if (!reserved.has(candidate)) return { ok: true, correlationKey: candidate };
  }

  return { ok: false, reason: 'exhausted', attempts: attempted };
}
