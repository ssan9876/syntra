/**
 * Reading and writing one field of a connector document by dotted path.
 *
 * The builder edits the document in place rather than holding a form model of
 * its own, so a key the builder has no control for survives every edit and
 * the JSON tab always shows exactly what will be saved.
 */

export type Doc = Record<string, unknown>;

function isRecord(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAt(doc: unknown, path: string): unknown {
  let node: unknown = doc;
  for (const key of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * A copy of `doc` with `path` set to `value`. `undefined` removes the key, and
 * an object left empty by a removal is removed too, so clearing the last field
 * of an optional section takes the section out rather than leaving `{}`.
 */
export function setAt(doc: Doc, path: string, value: unknown): Doc {
  const [head, ...rest] = path.split('.');
  const key = head!;
  if (rest.length === 0) {
    const next = { ...doc };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  }
  const child = isRecord(doc[key]) ? (doc[key] as Doc) : {};
  const updated = setAt(child, rest.join('.'), value);
  const next = { ...doc };
  if (Object.keys(updated).length === 0) delete next[key];
  else next[key] = updated;
  return next;
}

/** A string for a text box: absent and non-string values read as ''. */
export function textAt(doc: unknown, path: string): string {
  const value = getAt(doc, path);
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Blank text means "leave the key out", which is how optional fields stay optional. */
export function setText(doc: Doc, path: string, text: string): Doc {
  return setAt(doc, path, text.trim() === '' ? undefined : text);
}

/** Whole numbers, or absent. Anything else typed is kept as text for the schema to name. */
export function setNumber(doc: Doc, path: string, text: string): Doc {
  if (text.trim() === '') return setAt(doc, path, undefined);
  const n = Number(text);
  return setAt(doc, path, Number.isFinite(n) ? n : text);
}

/** Status lists such as `401, 403`. */
export function numbersOf(text: string): number[] {
  return text
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** A blank document a hand-made application starts from. */
export function blankDocument(): Doc {
  return {
    name: '',
    version: 1,
    baseUrl: 'https://',
    auth: { type: 'bearer' },
    headers: {},
    account: {
      list: { path: '/users', paging: { style: 'none' } },
      anchorAt: 'id',
      correlationAt: 'username',
      fields: {},
    },
  };
}

/**
 * Body rows for create and update, from the field mapping: each mapped target
 * field is sent with its Syntra attribute. Fields read only from the target
 * (`enabled`, `anchor`) are left out.
 */
export function bodyFromFields(fields: Record<string, string>): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [targetField, attribute] of Object.entries(fields)) {
    if (attribute === 'enabled' || attribute === 'anchor' || targetField.includes('.')) continue;
    body[targetField] = attribute === 'userName' ? '{{correlationKey}}' : `{{attr.${attribute}}}`;
  }
  return body;
}

/** Whether a body can be edited as flat rows of text, or needs the JSON box. */
export function isFlatBody(body: unknown): body is Record<string, string | number | boolean> {
  return (
    isRecord(body) &&
    Object.values(body).every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  );
}
