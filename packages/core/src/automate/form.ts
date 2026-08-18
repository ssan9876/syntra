import { z } from 'zod';

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'number'
  | 'checkbox'
  /** Choose among the product's own ProductGrant rows. */
  | 'resourcePicker';

/**
 * `| undefined` on every optional property is load-bearing, not noise.
 * `exactOptionalPropertyTypes` is on repo-wide, and zod infers
 * `help?: string | undefined` for `z.string().optional()`; without it this
 * interface and `z.infer<typeof fieldSchema>` are not mutually assignable and
 * the guard below cannot be written -- which is why the first draft reached
 * for `as z.ZodType<FormSchema>` instead.
 */
export interface FormField {
  key: string;
  type: FormFieldType;
  label: string;
  help?: string | undefined;
  required: boolean;
  options?: { value: string; label: string }[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
  maxLength?: number | undefined;
}

export type FormSchema = FormField[];

/**
 * Two keys are implicit on every form and are not part of the schema:
 * `justification` (required whenever the workflow has at least one stage) and
 * `duration` (shown only under requesterChoice). A schema field of either
 * name would either shadow the real one or be silently overwritten by it.
 */
const RESERVED_KEYS = ['justification', 'duration'];

const fieldSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and underscores'),
    type: z.enum([
      'text',
      'textarea',
      'select',
      'multiselect',
      'date',
      'number',
      'checkbox',
      'resourcePicker',
    ]),
    label: z.string().min(1).max(200),
    help: z.string().max(500).optional(),
    required: z.boolean(),
    options: z
      .array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(200) }))
      .optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLength: z.number().int().positive().max(10000).optional(),
  })
  .superRefine((field, ctx) => {
    if (RESERVED_KEYS.includes(field.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key'],
        message: `${field.key} is added to every form automatically`,
      });
    }
    const needsOptions = field.type === 'select' || field.type === 'multiselect';
    if (needsOptions && (field.options === undefined || field.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A select needs at least one option',
      });
    }
  });

/**
 * The schema and the type, checked against each other at compile time.
 *
 * `formSchemaSchema` is **not** recursive -- it is
 * `z.array(fieldSchema).max(40).superRefine(...)` -- so unlike Provision's
 * `conditionSchema` its type is fully inferrable, and the
 * `as z.ZodType<FormSchema>` an earlier draft carried threw away a check that
 * happens for free. Ruling P21's lesson generalises: treat `z.ZodType<T>` on a
 * schema as decoration until proven otherwise, and never add a cast on top of
 * it. The line below is the proof. If `fieldSchema` and `FormField` drift --
 * a field type added to the enum and not the union, a bound made required --
 * it fails here rather than at the far end of a product form that renders a
 * control nothing validates.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _fieldSchemaMatchesFormField: MutuallyAssignable<
  z.infer<typeof fieldSchema>,
  FormField
> = true;
void _fieldSchemaMatchesFormField;

export const formSchemaSchema: z.ZodType<FormSchema> = z
  .array(fieldSchema)
  .max(40)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['key'],
          message: `Two fields both named ${field.key}`,
        });
      }
      seen.add(field.key);
    }
  });

export type FormValidation =
  | { ok: true; values: Record<string, string | number | boolean | string[]> }
  | { ok: false; errors: { path: string; message: string }[] };

const absent = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/**
 * Validates a submission against the schema the product published.
 *
 * Run at save time on the schema and again here on the values. A field the
 * schema does not declare is DROPPED rather than rejected -- a stale browser
 * tab is ordinary -- but it never reaches the stored `formValues`, or the
 * request records an answer to a question nobody asked.
 *
 * `selectableResourceIds` is the product's own ProductGrant ids. It is the one
 * option list that does not live on the schema, and it is the one an attacker
 * would try to widen: a `resourcePicker` naming a resource the product does
 * not grant would make the request grant it.
 */
export function validateFormValues(
  schema: FormSchema,
  values: unknown,
  selectableResourceIds: readonly string[],
): FormValidation {
  const input: Record<string, unknown> =
    typeof values === 'object' && values !== null && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : {};

  const errors: { path: string; message: string }[] = [];
  const out: Record<string, string | number | boolean | string[]> = {};
  const fail = (path: string, message: string) => errors.push({ path, message });

  for (const field of schema) {
    const raw = input[field.key];

    if (absent(raw)) {
      if (field.required) fail(field.key, 'This is required');
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof raw !== 'string') {
          fail(field.key, 'Expected text');
          break;
        }
        const trimmed = raw.trim();
        if (trimmed.length > (field.maxLength ?? 2000)) {
          fail(field.key, `Keep this under ${field.maxLength ?? 2000} characters`);
          break;
        }
        out[field.key] = trimmed;
        break;
      }
      case 'date': {
        if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
          fail(field.key, 'Expected a date');
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          fail(field.key, 'Expected a number');
          break;
        }
        if (field.min !== undefined && raw < field.min) {
          fail(field.key, `Must be at least ${field.min}`);
          break;
        }
        if (field.max !== undefined && raw > field.max) {
          fail(field.key, `Must be at most ${field.max}`);
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'checkbox': {
        if (typeof raw !== 'boolean') {
          fail(field.key, 'Expected yes or no');
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'select': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (typeof raw !== 'string' || !allowed.includes(raw)) {
          fail(field.key, 'Choose one of the offered options');
          break;
        }
        out[field.key] = raw;
        break;
      }
      case 'multiselect': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !allowed.includes(v))) {
          fail(field.key, 'Choose from the offered options');
          break;
        }
        out[field.key] = raw as string[];
        break;
      }
      case 'resourcePicker': {
        if (typeof raw !== 'string' || !selectableResourceIds.includes(raw)) {
          fail(field.key, 'Choose one of the resources this product grants');
          break;
        }
        out[field.key] = raw;
        break;
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: out };
}
