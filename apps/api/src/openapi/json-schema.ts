import { z, type ZodTypeAny } from 'zod';

/**
 * A JSON Schema (2020-12, the dialect OpenAPI 3.1 uses) for the INPUT side of
 * a contracts Zod schema — what a client must send, not what a handler sees
 * after `.transform()` and `.default()` have run.
 *
 * WHY A WALKER AND NOT `z.toJSONSchema`. Zod 4 ships a native converter, and
 * this function uses it the moment it exists (the first branch below). The
 * workspace is still on Zod 3.25 — the Zod 4 upgrade is an open dependency
 * update — and Zod 3's schemas cannot be handed to the `zod/v4` converter,
 * whose internals are different. A converter package would be a new
 * dependency for a problem that ends with that upgrade, so this walks Zod 3's
 * `_def` tree directly, covering the constructs `packages/contracts` actually
 * uses. When the upgrade lands, the first branch takes over, the walker
 * becomes dead code to delete, and `docs/api/openapi.json` will differ in
 * small ways (Zod 4 spells some keywords differently) — the CI freshness check
 * says so, and regenerating is the whole fix.
 *
 * Typed loosely on purpose (`any` over `_def`): the walker reads Zod 3
 * internals, and typing them against Zod 3's declarations would stop this file
 * compiling under Zod 4 — which is exactly when it needs to keep compiling
 * long enough to be deleted.
 *
 * Anything it does not recognise becomes `{}` ("any value") rather than an
 * exception: an under-described field in a published document is a gap, but a
 * generator that throws on the first unusual schema publishes nothing at all.
 */
export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const native = (z as unknown as { toJSONSchema?: (s: unknown, o: unknown) => JsonSchema })
    .toJSONSchema;
  if (typeof native === 'function') {
    const converted = native(schema, { io: 'input', unrepresentable: 'any' });
    delete converted.$schema;
    return converted;
  }
  return walk(schema, new Set());
}

/**
 * Whether a field may be left out of an object the client sends.
 *
 * Input-side, so `.default()` counts as optional — the server fills it in —
 * and so does anything wrapped in an effect around an optional.
 */
function isOptional(schema: ZodTypeAny): boolean {
  const def = (schema as any)._def;
  switch (def?.typeName) {
    case 'ZodOptional':
    case 'ZodDefault':
      return true;
    case 'ZodNullable':
    case 'ZodBranded':
    case 'ZodReadonly':
    case 'ZodCatch':
      return isOptional(def.innerType ?? def.type);
    case 'ZodEffects':
      return isOptional(def.schema);
    case 'ZodPipeline':
      return isOptional(def.in);
    default:
      return false;
  }
}

function walk(schema: any, seen: Set<unknown>): JsonSchema {
  const def = schema?._def;
  if (!def) return {};
  const described = (out: JsonSchema): JsonSchema =>
    def.description ? { ...out, description: def.description } : out;

  switch (def.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const check of def.checks ?? []) {
        switch (check.kind) {
          case 'min': out.minLength = check.value; break;
          case 'max': out.maxLength = check.value; break;
          case 'length': out.minLength = check.value; out.maxLength = check.value; break;
          case 'email': out.format = 'email'; break;
          case 'url': out.format = 'uri'; break;
          case 'uuid': out.format = 'uuid'; break;
          case 'datetime': out.format = 'date-time'; break;
          case 'date': out.format = 'date'; break;
          case 'regex': out.pattern = check.regex.source; break;
          case 'startsWith': out.pattern = `^${escapeRegex(check.value)}`; break;
          case 'endsWith': out.pattern = `${escapeRegex(check.value)}$`; break;
          default: break;
        }
      }
      return described(out);
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'int') out.type = 'integer';
        if (check.kind === 'min') out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        if (check.kind === 'max') out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
        if (check.kind === 'multipleOf') out.multipleOf = check.value;
      }
      return described(out);
    }
    case 'ZodBigInt':
      return described({ type: 'integer' });
    case 'ZodBoolean':
      return described({ type: 'boolean' });
    case 'ZodDate':
      // On the wire a date is an ISO-8601 string; `z.date()` in a contract is
      // always reached through `z.coerce`.
      return described({ type: 'string', format: 'date-time' });
    case 'ZodNull':
      return described({ type: 'null' });
    case 'ZodLiteral':
      return described({ const: def.value });
    case 'ZodEnum':
      return described({ type: 'string', enum: [...def.values] });
    case 'ZodNativeEnum': {
      // A numeric TypeScript enum carries a reverse mapping (`{ A: 0, 0: 'A' }`);
      // the reverse entries are names, not values a client may send.
      const record = def.values as Record<string, unknown>;
      const values = Object.values(record).filter(
        (value) => typeof value === 'number' || typeof record[value as string] !== 'number',
      );
      return described({ enum: [...new Set(values)] });
    }
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: walk(def.type, seen) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      if (def.exactLength) {
        out.minItems = def.exactLength.value;
        out.maxItems = def.exactLength.value;
      }
      return described(out);
    }
    case 'ZodSet':
      return described({ type: 'array', uniqueItems: true, items: walk(def.valueType, seen) });
    case 'ZodTuple':
      return described({
        type: 'array',
        prefixItems: def.items.map((item: unknown) => walk(item, seen)),
        ...(def.rest ? { items: walk(def.rest, seen) } : { items: false }),
      });
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape as Record<string, ZodTypeAny>)) {
        properties[key] = walk(value, seen);
        if (!isOptional(value)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      // `.strict()` is how the contracts say "an unknown field is a 400", and
      // a client generator should know that before it sends one.
      const catchall = def.catchall?._def?.typeName;
      if (catchall && catchall !== 'ZodNever') {
        out.additionalProperties = walk(def.catchall, seen);
      } else if (def.unknownKeys === 'strict') {
        out.additionalProperties = false;
      }
      return described(out);
    }
    case 'ZodRecord':
      return described({ type: 'object', additionalProperties: walk(def.valueType, seen) });
    case 'ZodMap':
      return described({ type: 'object', additionalProperties: walk(def.valueType, seen) });
    case 'ZodUnion':
      return described({ anyOf: def.options.map((option: unknown) => walk(option, seen)) });
    case 'ZodDiscriminatedUnion':
      return described({
        oneOf: [...def.options.values?.() ?? def.options].map((option: unknown) => walk(option, seen)),
      });
    case 'ZodIntersection':
      return described({ allOf: [walk(def.left, seen), walk(def.right, seen)] });
    case 'ZodOptional':
      return described(walk(def.innerType, seen));
    case 'ZodNullable':
      return described({ anyOf: [walk(def.innerType, seen), { type: 'null' }] });
    case 'ZodDefault': {
      const inner = walk(def.innerType, seen);
      const value = def.defaultValue();
      return described(value === undefined ? inner : { ...inner, default: jsonSafe(value) });
    }
    case 'ZodCatch':
    case 'ZodBranded':
    case 'ZodReadonly':
      return described(walk(def.innerType ?? def.type, seen));
    case 'ZodEffects':
      // refine / transform / preprocess: the INPUT is the inner schema's.
      return described(walk(def.schema, seen));
    case 'ZodPipeline':
      return described(walk(def.in, seen));
    case 'ZodLazy': {
      // A recursive schema. Unrolled once and then left open, which keeps the
      // document finite without inventing `$ref` names for anonymous shapes.
      if (seen.has(schema)) return {};
      const next = new Set(seen);
      next.add(schema);
      return described(walk(def.getter(), next));
    }
    case 'ZodAny':
    case 'ZodUnknown':
    default:
      return described({});
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A default value as JSON would carry it — a Date as its ISO string. */
function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
