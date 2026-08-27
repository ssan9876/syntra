import { describe, expect, it } from 'vitest';
import { formSchemaSchema, validateFormValues, type FormSchema } from './form.js';

const schema: FormSchema = [
  { key: 'reason', type: 'text', label: 'What is it for', required: true, maxLength: 200 },
  { key: 'seats', type: 'number', label: 'Seats', required: false, min: 1, max: 10 },
  {
    key: 'tier',
    type: 'select',
    label: 'Tier',
    required: true,
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'premium', label: 'Premium' },
    ],
  },
  { key: 'mailbox', type: 'resourcePicker', label: 'Which mailbox', required: true },
];

const RESOURCES = ['res-a', 'res-b'];

describe('validateFormValues', () => {
  it('accepts a complete, well-typed submission and returns the coerced values', () => {
    const result = validateFormValues(
      schema,
      { reason: 'Q3 audit', seats: 3, tier: 'standard', mailbox: 'res-b' },
      RESOURCES,
    );
    expect(result).toEqual({
      ok: true,
      values: { reason: 'Q3 audit', seats: 3, tier: 'standard', mailbox: 'res-b' },
    });
  });

  it('names the field that is missing rather than saying the form is invalid', () => {
    const result = validateFormValues(schema, { tier: 'standard', mailbox: 'res-a' }, RESOURCES);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual({ path: 'reason', message: 'This is required' });
  });

  it('refuses a select value that is not one of the declared options', () => {
    // The options are a closed list on the schema. A value outside it means
    // the submission did not come from the form the product published.
    const result = validateFormValues(
      schema,
      { reason: 'x', tier: 'enterprise', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.map((e) => e.path)).toContain('tier');
  });

  it('refuses a resourcePicker value that is not one of the product own grants', () => {
    // This is the one field whose options come from the product rather than
    // the schema, and it is the one an attacker would try to widen: naming a
    // resource the product does not grant would make the request grant it.
    const result = validateFormValues(
      schema,
      { reason: 'x', tier: 'standard', mailbox: 'res-somebody-elses' },
      RESOURCES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual({
      path: 'mailbox',
      message: 'Choose one of the resources this product grants',
    });
  });

  it('enforces numeric bounds and string length', () => {
    const tooMany = validateFormValues(
      schema,
      { reason: 'x', seats: 40, tier: 'standard', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(tooMany.ok).toBe(false);
    const tooLong = validateFormValues(
      schema,
      { reason: 'x'.repeat(201), tier: 'standard', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(tooLong.ok).toBe(false);
  });

  it('drops a value for a key the schema does not declare', () => {
    // Not an error -- a stale browser tab holding a previous version of the
    // form is ordinary -- but it must not reach the stored formValues, or the
    // request records an answer to a question nobody asked.
    const result = validateFormValues(
      schema,
      { reason: 'x', tier: 'standard', mailbox: 'res-a', smuggled: 'admin' },
      RESOURCES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.values).not.toHaveProperty('smuggled');
  });

  it('treats an empty string as absent for a required field', () => {
    const result = validateFormValues(
      schema,
      { reason: '   ', tier: 'standard', mailbox: 'res-a' },
      RESOURCES,
    );
    expect(result.ok).toBe(false);
  });
});

describe('formSchemaSchema', () => {
  it('accepts the eight field types and refuses a ninth', () => {
    for (const type of [
      'text',
      'textarea',
      'select',
      'multiselect',
      'date',
      'number',
      'checkbox',
      'resourcePicker',
    ]) {
      const field = {
        key: 'k',
        type,
        label: 'L',
        required: false,
        ...(type === 'select' || type === 'multiselect'
          ? { options: [{ value: 'a', label: 'A' }] }
          : {}),
      };
      expect(formSchemaSchema.safeParse([field]).success).toBe(true);
    }
    expect(
      formSchemaSchema.safeParse([{ key: 'k', type: 'script', label: 'L', required: false }])
        .success,
    ).toBe(false);
  });

  it('refuses a select with no options', () => {
    // A select nobody can answer makes a required field unsatisfiable, which
    // is a product that cannot be requested at all.
    expect(
      formSchemaSchema.safeParse([
        { key: 'k', type: 'select', label: 'L', required: true, options: [] },
      ]).success,
    ).toBe(false);
  });

  it('refuses two fields with the same key', () => {
    expect(
      formSchemaSchema.safeParse([
        { key: 'k', type: 'text', label: 'One', required: false },
        { key: 'k', type: 'text', label: 'Two', required: false },
      ]).success,
    ).toBe(false);
  });

  it('refuses a key that is one of the two implicit fields', () => {
    // `justification` and `duration` are implicit on every form and are NOT
    // part of the schema. A schema field of the same name would either shadow
    // the real one or be silently overwritten by it.
    for (const key of ['justification', 'duration']) {
      expect(
        formSchemaSchema.safeParse([{ key, type: 'text', label: 'L', required: false }])
          .success,
      ).toBe(false);
    }
  });
});

const conditional: FormSchema = [
  { key: 'escalated', type: 'checkbox', label: 'Escalated to me', required: false },
  {
    key: 'note',
    type: 'text',
    label: 'Who escalated it',
    required: true,
    visibleWhen: { field: 'escalated', equals: true },
  },
];

describe('a conditional field', () => {
  it('is not required while its condition does not hold', () => {
    // An unticked checkbox is `false`, not "unknown". Reading absence as
    // unknown made every conditional field appear before its condition could
    // possibly hold, which is the whole feature not working.
    const result = validateFormValues(conditional, { escalated: false }, []);
    expect(result).toEqual({ ok: true, values: { escalated: false } });
  });

  it('is not required when its trigger was never answered at all', () => {
    expect(validateFormValues(conditional, {}, [])).toEqual({ ok: true, values: {} });
  });

  it('is required once its condition holds', () => {
    const result = validateFormValues(conditional, { escalated: true }, []);
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'note', message: 'This is required' }],
    });
  });

  it('is not stored when it was not shown', () => {
    // A hidden field's value is not an answer anybody gave. Storing it
    // records an answer to a question that was never asked.
    const result = validateFormValues(
      conditional,
      { escalated: false, note: 'left over from before the box was unticked' },
      [],
    );
    expect(result).toEqual({ ok: true, values: { escalated: false } });
  });

  it('shows a field whose rule names something not on the form', () => {
    // The typo protection. Silently deleting a question because a rule
    // misspelt its trigger is the quieter and worse of the two failures.
    const typo: FormSchema = [
      {
        key: 'note',
        type: 'text',
        label: 'Note',
        required: true,
        visibleWhen: { field: 'escalted', equals: true },
      },
    ];
    expect(validateFormValues(typo, {}, [])).toEqual({
      ok: false,
      errors: [{ path: 'note', message: 'This is required' }],
    });
  });
});

const withLookup: FormSchema = [
  { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user', required: true },
];

describe('a lookup field', () => {
  it('accepts a value the caller offered', () => {
    expect(validateFormValues(withLookup, { user: 'u1' }, [], { user: ['u1', 'u2'] })).toEqual({
      ok: true,
      values: { user: 'u1' },
    });
  });

  it('refuses a value the caller did not offer', () => {
    // The submitted value is an id from a picker, and a picker's contents are
    // a suggestion. The check against the caller's own set is the control.
    expect(validateFormValues(withLookup, { user: 'u9' }, [], { user: ['u1'] })).toMatchObject({
      ok: false,
    });
  });

  it('refuses everything when the caller offered nothing for that source', () => {
    // A missing set is a caller that has not decided, and the safe reading of
    // "has not decided" is no.
    expect(validateFormValues(withLookup, { user: 'u1' }, [], {})).toMatchObject({ ok: false });
  });
});

describe('the schema guard', () => {
  it('refuses a lookup that does not say what it looks up', () => {
    expect(
      formSchemaSchema.safeParse([
        { key: 'user', type: 'lookup', label: 'Account', required: true },
      ]).success,
    ).toBe(false);
  });

  it('refuses a data source on something that is not a lookup', () => {
    // A `dataSource` on a text box is somebody who believes they built a
    // picker, and a form that silently accepts it lets them keep believing it.
    expect(
      formSchemaSchema.safeParse([
        { key: 'note', type: 'text', label: 'Note', required: true, dataSource: 'user' },
      ]).success,
    ).toBe(false);
  });

  it('accepts a well-formed lookup', () => {
    expect(
      formSchemaSchema.safeParse([
        { key: 'user', type: 'lookup', label: 'Account', required: true, dataSource: 'user' },
      ]).success,
    ).toBe(true);
  });
});
