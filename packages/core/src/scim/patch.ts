import { ScimError } from './resource.js';

export type ScimPatchOperation =
  | { kind: 'setActive'; value: boolean }
  | { kind: 'setUserName'; value: string }
  | { kind: 'setDisplayName'; value: string }
  | { kind: 'setEmail'; value: string }
  | { kind: 'addMembers'; ids: string[] }
  | { kind: 'removeMembers'; ids: string[] }
  /** `remove` with no ids: every member goes. */
  | { kind: 'clearMembers' };

interface RawOperation {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** `members` values are `{ value: id }`, sometimes with a `$ref` beside them. */
function memberIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      ids.push(entry);
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const id = asString((entry as Record<string, unknown>).value);
      if (id !== null) ids.push(id);
    }
  }
  return ids;
}

/**
 * Reads a `PatchOp` body into operations this server can carry out.
 *
 * TWO SHAPES, and the second one is why this function exists rather than a
 * switch inside a route.
 *
 * The RFC's form names a path:
 *
 *     { op: "replace", path: "active", value: false }
 *
 * Entra sends the pathless form, with an object value:
 *
 *     { op: "replace", value: { active: false } }
 *
 * A server that implements only the first accepts the second, finds no path it
 * recognises, and — if it is careless — answers 200 having changed nothing.
 * The IdP records a successful deprovision and the account stays live. Both
 * shapes are read here, and an operation this server cannot carry out is a
 * refusal rather than a quiet success.
 */
export function interpretPatch(body: unknown): ScimPatchOperation[] {
  if (typeof body !== 'object' || body === null) {
    throw new ScimError(400, 'invalidValue', 'The request body is not an object');
  }

  const operations = (body as Record<string, unknown>).Operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ScimError(400, 'invalidValue', 'Operations must be a non-empty array');
  }

  const result: ScimPatchOperation[] = [];
  for (const raw of operations as RawOperation[]) {
    const op = (asString(raw.op) ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw new ScimError(400, 'invalidSyntax', `Unsupported op: ${String(raw.op)}`);
    }

    const path = asString(raw.path);

    if (path === null) {
      // The pathless form. The value is an object naming the attributes.
      if (typeof raw.value !== 'object' || raw.value === null || Array.isArray(raw.value)) {
        throw new ScimError(400, 'invalidSyntax', 'A patch without a path needs an object value');
      }
      for (const [attribute, value] of Object.entries(raw.value as Record<string, unknown>)) {
        result.push(operationFor(attribute, value, op));
      }
      continue;
    }

    result.push(operationFor(path, raw.value, op));
  }

  return result;
}

function operationFor(
  path: string,
  value: unknown,
  op: 'add' | 'replace' | 'remove',
): ScimPatchOperation {
  // Case-insensitive: SCIM attribute names are, and a client sending
  // `Active` is not making a mistake.
  switch (path.toLowerCase()) {
    case 'active':
      // `"False"` is what some clients send. Treating a non-empty string as
      // truthy would reactivate an account somebody was deprovisioning.
      return {
        kind: 'setActive',
        value: typeof value === 'string' ? value.toLowerCase() !== 'false' : value !== false,
      };
    case 'username': {
      const next = asString(value);
      if (next === null) throw new ScimError(400, 'invalidValue', 'userName cannot be empty');
      return { kind: 'setUserName', value: next };
    }
    case 'displayname': {
      const next = asString(value);
      if (next === null) throw new ScimError(400, 'invalidValue', 'displayName cannot be empty');
      return { kind: 'setDisplayName', value: next };
    }
    case 'emails':
    case 'emails[type eq "work"].value': {
      const next =
        asString(value) ??
        asString(
          Array.isArray(value) && typeof value[0] === 'object' && value[0] !== null
            ? (value[0] as Record<string, unknown>).value
            : null,
        );
      if (next === null) throw new ScimError(400, 'invalidValue', 'No email address in the patch');
      return { kind: 'setEmail', value: next };
    }
    case 'members': {
      if (op === 'remove') {
        const ids = memberIds(value);
        // `remove` with no value at all means every member, per the RFC.
        return ids.length === 0 ? { kind: 'clearMembers' } : { kind: 'removeMembers', ids };
      }
      // `replace` on members is a whole-set assignment. Treated as an add of
      // the named members would leave the ones being taken away in place, so
      // it is refused rather than half-performed.
      if (op === 'replace') {
        throw new ScimError(
          400,
          'invalidSyntax',
          "replace of 'members' is not supported; use add and remove",
        );
      }
      return { kind: 'addMembers', ids: memberIds(value) };
    }
    default:
      // NOT a silent success. A patch that reports 200 and changes nothing is
      // the failure that takes days to find, because the IdP believes it
      // landed and stops retrying.
      throw new ScimError(400, 'invalidPath', `Cannot patch '${path}'`);
  }
}
