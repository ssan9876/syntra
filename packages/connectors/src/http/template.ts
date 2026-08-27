/**
 * What a placeholder produces when there is nothing to put there.
 *
 * A sentinel rather than `undefined` or `null`, because both of those are
 * legitimate JSON values a document might want to send, and because the
 * difference matters: `{ "department": null }` is a WRITE that clears the
 * field at the target, and an attribute nobody set must not silently become
 * one. `renderBody` drops the key instead.
 */
export const MISSING = Symbol('missing');

export interface TemplateVars {
  anchor?: string | undefined;
  correlationKey?: string | undefined;
  actionId?: string | undefined;
  entitlementId?: string | undefined;
  /** Never logged, never echoed into a message. */
  initialPassword?: string | undefined;
  reason?: string | undefined;
  enabled?: boolean | undefined;
  attributes?: Record<string, string[]> | undefined;
}

/**
 * The complete placeholder vocabulary. There is no expression language, no
 * function call, no arithmetic, and no way to add one.
 *
 * That is the entire argument for a declarative connector over a script host.
 * A document is data: it is read from the database, written by an
 * administrator through a form, and executed against systems holding the
 * organization's accounts. If it could evaluate, then whoever can edit a
 * target's configuration could run code in the API process — which is a
 * strictly larger privilege than administering a target, and one nobody would
 * have chosen to grant on purpose.
 */
/**
 * ANY `{{...}}` is a placeholder, and an unrecognised one is `MISSING`.
 *
 * Deliberately not a narrow pattern that only matches valid names. A narrow
 * one leaves `{{attr.emial}}` — or `{{1 + 1}}`, or `{{attr.__proto__}}` —
 * unmatched, which means it is sent to the target verbatim and stored as
 * somebody's email address. Recognising the syntax and refusing the name is
 * the difference between a field that is absent and a field containing the
 * text of the mistake.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The names this vocabulary admits. Everything else is `MISSING`. */
const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_-]*)?(?:\[\])?$/;

/** Own properties only. `{{attr.constructor}}` must not reach Object.prototype. */
function ownAttribute(
  attributes: Record<string, string[]> | undefined,
  name: string,
): string[] | undefined {
  if (!attributes) return undefined;
  if (!Object.prototype.hasOwnProperty.call(attributes, name)) return undefined;
  const values = attributes[name];
  return values && values.length > 0 ? values : undefined;
}

function lookup(raw: string, vars: TemplateVars): unknown {
  const name = raw.trim();
  if (!NAME.test(name)) return MISSING;
  if (name.startsWith('attr.')) {
    const wantsList = name.endsWith('[]');
    const key = name.slice(5, wantsList ? -2 : undefined);
    const values = ownAttribute(vars.attributes, key);
    if (values === undefined) return MISSING;
    return wantsList ? values : values[0];
  }
  switch (name) {
    case 'anchor':
      return vars.anchor ?? MISSING;
    case 'correlationKey':
      return vars.correlationKey ?? MISSING;
    case 'actionId':
      return vars.actionId ?? MISSING;
    case 'entitlementId':
      return vars.entitlementId ?? MISSING;
    case 'initialPassword':
      return vars.initialPassword ?? MISSING;
    case 'reason':
      return vars.reason ?? MISSING;
    case 'enabled':
      return vars.enabled ?? MISSING;
    default:
      // An unknown name is missing, not an error and not left in place. Left
      // in place it would be sent to the target verbatim, which is how
      // `{{attr.emial}}` ends up as somebody's stored email address.
      return MISSING;
  }
}

/**
 * Renders one templated string.
 *
 * A string that is EXACTLY one placeholder yields the value's own type — so
 * `"active": "{{enabled}}"` produces a boolean and `"{{attr.proxyAddresses[]}}"`
 * produces an array. A target that type-checks its own API rejects the string
 * `"true"`, and quoting is the only way to write a placeholder in JSON.
 *
 * A placeholder inside a longer string is interpolated as text, and the WHOLE
 * string is missing if any one of its placeholders is: half a sentence with a
 * hole in it is not a value anybody meant to send.
 */
export function renderValue(template: string, vars: TemplateVars): unknown {
  const whole = new RegExp(`^${PLACEHOLDER.source}$`).exec(template);
  if (whole?.[1]) return lookup(whole[1], vars);

  let missing = false;
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = lookup(name, vars);
    if (value === MISSING) {
      missing = true;
      return '';
    }
    return Array.isArray(value) ? value.join(',') : String(value);
  });
  return missing ? MISSING : rendered;
}

/**
 * Renders a whole JSON body.
 *
 * Anything that renders to `MISSING` is DROPPED — a key from an object, an
 * entry from a list — rather than sent as null. See `MISSING`. An object all
 * of whose keys drop is itself dropped, so a `name` sub-object nobody supplied
 * a part of does not arrive as `{}` and reset the target's own.
 */
export function renderBody(template: unknown, vars: TemplateVars): unknown {
  if (typeof template === 'string') return renderValue(template, vars);
  if (Array.isArray(template)) {
    const items = template.map((item) => renderBody(item, vars)).filter((v) => v !== MISSING);
    // A list that had entries and kept none is itself missing, for the same
    // reason its keys are dropped: sending `[]` is a write that CLEARS the
    // field. A list the document wrote empty stays empty, because that is
    // what the document meant.
    return template.length > 0 && items.length === 0 ? MISSING : items;
  }
  if (template !== null && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const rendered = renderBody(value, vars);
      if (rendered === MISSING) continue;
      out[key] = rendered;
    }
    // An object that had keys and kept none is missing, not `{}`. A `name`
    // sub-object nobody supplied a part of must not arrive as `{}` and reset
    // the target's own — which is exactly what `PATCH {"name": {}}` does on
    // most APIs.
    const had = Object.keys(template as object).length > 0;
    return had && Object.keys(out).length === 0 ? MISSING : out;
  }
  // Numbers, booleans, null: literals the document meant literally.
  return template;
}

export class MissingTemplateValueError extends Error {
  constructor(readonly placeholder: string) {
    super(`the request path needs {{${placeholder}}} and there is no value for it`);
    this.name = 'MissingTemplateValueError';
  }
}

/**
 * Renders a request path, escaping every substituted value.
 *
 * Two differences from `renderBody`, both deliberate:
 *
 *  - **Everything substituted is percent-encoded.** An anchor is the target's
 *    own identifier and can contain anything — a slash, a question mark, a
 *    `..`. Unescaped, one of those rewrites the request to a different
 *    endpoint than the document describes, which is request forgery driven by
 *    data the target itself supplied.
 *  - **A missing value throws.** A body may legitimately omit a key; a path
 *    may not. A URL with a segment missing is a request to a DIFFERENT
 *    resource, not to a smaller one — `/users/{{anchor}}` with no anchor is
 *    `/users/`, which on many APIs is the whole collection.
 */
export function renderPath(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = lookup(name, vars);
    if (value === MISSING) throw new MissingTemplateValueError(name);
    return encodeURIComponent(Array.isArray(value) ? value.join(',') : String(value));
  });
}
