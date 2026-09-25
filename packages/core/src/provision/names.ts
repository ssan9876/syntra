import {
  EMAIL_LOCAL_PART_MAX_LENGTH,
  type CorrelationKeyCharset,
} from '@syntra/connectors';
import {
  renderTemplate,
  resolveReference,
  templateReferences,
  type TemplateContext,
} from './templates.js';

/**
 * Re-exported rather than redefined: the connector layer owns what a target
 * accepts (`correlationKeyPolicyFor`), and a second copy of the number here
 * would be a second place for Active Directory's limit to drift.
 */
export { SAM_ACCOUNT_NAME_MAX_LENGTH } from '@syntra/connectors';

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
  /** The whole key's cap, domain included. From `correlationKeyPolicyFor`. */
  maxLength: number;
  /**
   * Which characters the TARGET accepts, from `correlationKeyPolicyFor`.
   * Required, not defaulted: a caller that forgot it would silently generate
   * Active Directory keys for a target that needs email addresses, which is
   * the bug this parameter exists to close.
   */
  charset: CorrelationKeyCharset;
  maxAttempts: number;
}

export type NameGenerationResult =
  | { ok: true; correlationKey: string }
  | { ok: false; reason: 'template_unresolvable'; missing: string[] }
  | { ok: false; reason: 'exhausted'; attempts: number }
  /**
   * The template rendered, but not into anything the target's rule can hold:
   * two `@`, an `@` with nothing on one side, or a domain that alone leaves
   * no room under the cap. Reported with the reason in words, rather than
   * repaired: dropping one `@` of two picks an address nobody wrote.
   */
  | { ok: false; reason: 'malformed'; message: string };

/**
 * Lowercased, ASCII-folded, apostrophes and spaces and anything else stripped.
 *
 * `sam` is Active Directory's `[a-z0-9.-]`, byte for byte what this function
 * always did. `email` additionally keeps `_`, `+` and `@`; everything it
 * strips, `sam` strips too, so a template with no `@` in it renders the same
 * key under either rule apart from the underscores and plus signs `email`
 * keeps (and the longer cap `generateCorrelationKey` applies).
 */
function sanitise(value: string, charset: CorrelationKeyCharset): string {
  const lowered = foldToAscii(value).toLowerCase();
  return charset === 'email'
    ? lowered.replace(/[^a-z0-9._+@-]/g, '')
    : lowered.replace(/[^a-z0-9.-]/g, '');
}

/**
 * The rendered key split into the part a suffix and a truncation may touch and
 * the part neither may: `{ local: 'anna.novak', domain: '@contoso.com' }`.
 * Under `sam`, and for an email-rule key with no `@`, the domain is empty.
 */
type SplitKey = { ok: true; local: string; domain: string } | { ok: false; message: string };

function splitKey(sanitised: string, charset: CorrelationKeyCharset): SplitKey {
  if (charset === 'sam') {
    return { ok: true, local: sanitised.replace(/^[.-]+|[.-]+$/g, ''), domain: '' };
  }
  const parts = sanitised.split('@');
  if (parts.length > 2) {
    return {
      ok: false,
      message: `renders "${sanitised}", which has more than one @; a username on this target may hold one address at most`,
    };
  }
  // Separators are trimmed from the ends of the local part as `sam` trims
  // them from the whole key -- `_` and `+` included, so `_anna` and `anna_`
  // render `anna` exactly as they always did.
  const local = (parts[0] ?? '').replace(/^[._+-]+|[._+-]+$/g, '');
  if (parts.length === 1) return { ok: true, local, domain: '' };

  // A domain holds no `_` or `+`, and never starts or ends on a separator.
  const domain = (parts[1] ?? '').replace(/[_+]/g, '').replace(/^[.-]+|[.-]+$/g, '');
  if (local === '' || domain === '') {
    return {
      ok: false,
      message: `renders "${sanitised}", which has nothing on one side of its @; an address needs both a name and a domain`,
    };
  }
  return { ok: true, local, domain: `@${domain}` };
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
    (name) => sanitise(resolveReference(input.context, name) ?? '', input.charset) === '',
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

  const split = splitKey(sanitise(rendered.value, input.charset), input.charset);
  if (!split.ok) return { ok: false, reason: 'malformed', message: split.message };
  const base = split.local;
  const domain = split.domain;
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

  // The local part's own cap. `maxLength` bounds the whole key; an address
  // additionally caps the part before the `@` at 64 (RFC 5321), and an
  // email-rule key without an `@` is a bare local part and takes the same cap.
  // `sam` has no split, so its only cap is `maxLength` -- as before.
  const localCap =
    input.charset === 'email'
      ? Math.min(EMAIL_LOCAL_PART_MAX_LENGTH, input.maxLength - domain.length)
      : input.maxLength;
  if (localCap < 1) {
    // Truncating the domain would make a different address, and truncating
    // the local part to nothing would make no address: the key cannot exist
    // on this target, and saying so beats sending one the target refuses.
    return {
      ok: false,
      reason: 'malformed',
      message: `renders an address whose domain "${domain.slice(1)}" alone leaves no room under this target's ${input.maxLength}-character limit`,
    };
  }

  // `sAMAccountName` is case-insensitive at the target, and this generator
  // only ever emits lowercase, so the comparison is done in lowercase on both
  // sides. The targets the email rule serves compare usernames and addresses
  // case-insensitively too, for the same reason.
  const reserved = new Set<string>();
  for (const key of input.taken) reserved.add(key.trim().toLowerCase());

  let attempted = 0;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const suffix = attempt === 1 ? '' : String(attempt);
    const room = localCap - suffix.length;
    // The suffix alone has filled the cap. Every further attempt is longer, so
    // there is nothing left to try rather than a key to truncate into shape.
    if (room < 1) break;
    attempted = attempt;

    // A truncation that lands on a separator would end the key in `.` or `-`.
    // Active Directory refuses a `sAMAccountName` ending in a period outright,
    // and `anna.` is not a name anybody meant. Trimming can never empty the
    // candidate: `base` starts with a letter or a digit.
    //
    // Only the local part is truncated and only the local part is suffixed:
    // `anna.novak2@contoso.com`, never `anna.novak@contoso.com2` (a different
    // domain) nor an address cut off half way through its domain.
    const truncated = base
      .slice(0, room)
      .replace(input.charset === 'email' ? /[._+-]+$/ : /[.-]+$/, '');
    const candidate = `${truncated}${suffix}${domain}`;
    if (!reserved.has(candidate)) return { ok: true, correlationKey: candidate };
  }

  return { ok: false, reason: 'exhausted', attempts: attempted };
}
