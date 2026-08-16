/**
 * Everything a template may reference. `person` and `contract` are open string
 * maps rather than fixed shapes because the account profile's
 * `attributeTemplates` is administrator-written and may name any field the
 * loader put in; an unknown name is reported as missing, not rendered empty.
 *
 * The maps are typed `Record<string, string | null>`, but the values arrive
 * from a JSON column and from a CSV loader, so the reader checks the runtime
 * type as well. A number where a string was promised is treated as an unknown
 * field, not coerced.
 */
export interface TemplateContext {
  person: Record<string, string | null>;
  contract: Record<string, string | null>;
  /** The target's base DN. Referenced as `%baseDn%`, with no prefix. */
  baseDn: string;
}

export type TemplateResult =
  | { ok: true; value: string }
  | { ok: false; missing: string[] };

export interface RenderOptions {
  /**
   * Applied to every substituted value, after the modifier and after
   * whitespace normalisation, and to nothing else.
   *
   * This exists because a container template composes a distinguished name out
   * of HR-supplied strings. `OU=%contract.department%,OU=Users,%baseDn%` with a
   * department of `Finance,OU=Domain Controllers` lands the account in the
   * container the comma names, not the one the administrator wrote. Pass
   * {@link escapeDnValue} whenever the template being rendered is a DN.
   *
   * `%baseDn%` is deliberately exempt: it is already a DN, supplied by target
   * configuration rather than by HR data, and escaping it would turn
   * `DC=acme,DC=test` into a single literal RDN value.
   */
  escapeValue?: (value: string) => string;
}

/**
 * One placeholder, parsed. `name` is what appears in `missing` — the text
 * between the delimiters without the modifier, so `%person.givenName.first%`
 * reports as `person.givenName`, the thing an administrator would go and fix.
 */
interface Reference {
  name: string;
  scope: string;
  field: string | undefined;
  modifier: 'first' | 'initial' | undefined;
}

type Token =
  | { kind: 'literal'; text: string }
  /** A `%…%` whose contents are not a placeholder this module understands. */
  | { kind: 'malformed'; raw: string }
  | { kind: 'reference'; reference: Reference };

const REFERENCE =
  /^([a-zA-Z][a-zA-Z0-9]*)(?:\.([a-zA-Z][a-zA-Z0-9]*))?(?:\.(first|initial))?$/;

function parseReference(inner: string): Reference | undefined {
  const match = REFERENCE.exec(inner);
  if (match === null) return undefined;
  const scope = match[1]!;
  const field = match[2];
  const modifier = match[3] as 'first' | 'initial' | undefined;
  return {
    name: field === undefined ? scope : `${scope}.${field}`,
    scope,
    field,
    modifier,
  };
}

/**
 * Splits a template into literals and placeholders.
 *
 * Every `%` in a template opens a placeholder. A `%…%` that is not a
 * placeholder this module understands — a misspelled modifier, an underscore
 * in a field name, a stray percent sign — becomes a `malformed` token and is
 * reported, never passed through as literal text.
 *
 * That refusal is the point. Leaving `%contract.cost_centre%` literal renders
 * it into a DN, where AD either rejects it or creates a container nobody meant,
 * and into a login, where the sanitiser quietly turns it into
 * `contractcostcentre` — a plausible wrong answer rather than a stop.
 *
 * There is no escape for a literal percent sign, because no DN, login, UPN or
 * display name this system writes needs one.
 */
function tokenize(template: string): Token[] {
  const parts = template.split('%');
  const tokens: Token[] = [];
  // Odd indices sit between two `%`. An even number of parts means the last
  // `%` was never closed.
  const unterminated = parts.length % 2 === 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (index % 2 === 0) {
      if (part !== '') tokens.push({ kind: 'literal', text: part });
      continue;
    }
    if (unterminated && index === parts.length - 1) {
      tokens.push({ kind: 'malformed', raw: `%${part}` });
      continue;
    }
    const reference = parseReference(part);
    if (reference === undefined) {
      tokens.push({ kind: 'malformed', raw: `%${part}%` });
      continue;
    }
    tokens.push({ kind: 'reference', reference });
  }

  return tokens;
}

/**
 * Reads one field out of an open map without ever seeing the prototype.
 *
 * `context.person['constructor']` is not `undefined` — it is a function, and
 * calling `.trim()` on it throws `TypeError: raw.trim is not a function` from a
 * template an administrator typed. `hasOwnProperty` plus a runtime `typeof`
 * makes `%person.constructor%` an ordinary unknown field.
 */
function readField(
  map: Record<string, string | null>,
  field: string,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(map, field)) return undefined;
  const value = (map as Record<string, unknown>)[field];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolves a placeholder name — `person.givenName`, `contract.department`,
 * `baseDn` — against a context. `undefined` means the name is not one this
 * context can answer; `null` means the field exists and is empty.
 */
export function resolveReference(
  context: TemplateContext,
  name: string,
): string | null | undefined {
  const reference = parseReference(name);
  if (reference === undefined) return undefined;
  const { scope, field } = reference;
  if (scope === 'baseDn') return field === undefined ? context.baseDn : undefined;
  if (field === undefined) return undefined;
  if (scope === 'person') return readField(context.person, field);
  if (scope === 'contract') return readField(context.contract, field);
  return undefined;
}

/**
 * The placeholder names a template references, in order of first appearance,
 * without duplicates. Malformed placeholders are not included: they are
 * reported by {@link renderTemplate} and there is no field behind them to fix.
 */
export function templateReferences(template: string): string[] {
  const names: string[] = [];
  for (const token of tokenize(template)) {
    if (token.kind !== 'reference') continue;
    if (!names.includes(token.reference.name)) names.push(token.reference.name);
  }
  return names;
}

/**
 * Collapses whitespace and drops control characters.
 *
 * A value that is only whitespace, only control characters, or a mixture of the
 * two is indistinguishable from an absent one and is treated as absent. A value
 * with a newline in the middle — which a CSV import can produce — must not
 * reach an LDAP attribute, and `Anna  Maria` must yield the same login as
 * `Anna Maria`.
 */
function clean(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyModifier(
  value: string,
  modifier: 'first' | 'initial' | undefined,
): string {
  // `clean` has already collapsed every whitespace run to one space.
  if (modifier === 'first') return value.split(' ')[0]!;
  // By code point, not by UTF-16 unit: `value.slice(0, 1)` on a name whose
  // first character is outside the BMP yields half a surrogate pair, which is
  // an unpaired surrogate in a display name and in a DN.
  if (modifier === 'initial') return [...value][0] ?? '';
  return value;
}

/**
 * Renders a template, or refuses and says which placeholders it could not
 * resolve.
 *
 * **A missing value is never rendered as an empty string.** An empty value in
 * a DN produces `OU=,OU=Users,DC=acme,DC=test`, which is not a container; an
 * empty value in a login produces a login that collides with whatever the
 * uniqueness strategy invents next, on a person whose record is incomplete.
 * Both are the shape where a person becomes unprocessable and the run says
 * so by name (spec section 13).
 *
 * Absent, null, whitespace-only and control-characters-only are all the same
 * refusal. So is a placeholder this module cannot parse, and so is an
 * unterminated one.
 *
 * Entries in `missing` are the placeholder as written: one that parsed is
 * reported by name (`person.nickname`), and one that did not is reported raw,
 * delimiters included (`%person.given_name%`).
 *
 * **This function does not know the syntax of what it is rendering.** For a DN
 * pass `{ escapeValue: escapeDnValue }`; see {@link RenderOptions.escapeValue}.
 *
 * Pure: no clock, no database, no I/O.
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
  options: RenderOptions = {},
): TemplateResult {
  const missing: string[] = [];
  const report = (name: string): void => {
    if (!missing.includes(name)) missing.push(name);
  };

  let value = '';
  for (const token of tokenize(template)) {
    if (token.kind === 'literal') {
      value += token.text;
      continue;
    }
    if (token.kind === 'malformed') {
      report(token.raw);
      continue;
    }

    const { reference } = token;
    const raw = resolveReference(context, reference.name);
    if (raw === undefined || raw === null) {
      report(reference.name);
      continue;
    }
    const cleaned = clean(raw);
    if (cleaned === '') {
      report(reference.name);
      continue;
    }

    const substituted = applyModifier(cleaned, reference.modifier);
    // `%baseDn%` is already a DN. Escaping it would collapse
    // `DC=acme,DC=test` into one literal RDN value.
    value +=
      reference.scope === 'baseDn' || options.escapeValue === undefined
        ? substituted
        : options.escapeValue(substituted);
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value };
}

/** Characters RFC 4514 requires escaping wherever they appear in a value. */
const DN_SPECIAL = /[\\",+<>;=\u0000]/g;

/**
 * Escapes one attribute value for use inside a distinguished name (RFC 4514).
 *
 * Pass it to {@link renderTemplate} as `escapeValue` when the template is a
 * container template. Without it, a department of `Finance,OU=Domain
 * Controllers` in `OU=%contract.department%,OU=Users,%baseDn%` is not a
 * mangled DN — it is a valid DN naming a container the administrator did not
 * write, chosen by whoever can edit an HR record.
 */
export function escapeDnValue(value: string): string {
  let escaped = value.replace(DN_SPECIAL, (character) =>
    character === '\u0000' ? '\\00' : `\\${character}`,
  );
  // A leading `#` would otherwise introduce a hex-encoded BER value, and a
  // leading or trailing space is stripped by a DN parser that does not see it
  // escaped.
  if (escaped.startsWith('#') || escaped.startsWith(' ')) escaped = `\\${escaped}`;
  if (escaped.endsWith(' ')) escaped = `${escaped.slice(0, -1)}\\ `;
  return escaped;
}
