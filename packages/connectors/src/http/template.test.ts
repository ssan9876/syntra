import { describe, expect, it } from 'vitest';
import { MISSING, renderBody, renderPath, renderValue, type TemplateVars } from './template.js';

const vars: TemplateVars = {
  anchor: 'abc-123',
  correlationKey: 'a.lovelace',
  actionId: 'act-9',
  enabled: true,
  attributes: {
    givenName: ['Ada'],
    familyName: ['Lovelace'],
    mail: ['ada@example.com'],
    proxyAddresses: ['smtp:ada@example.com', 'smtp:a.lovelace@example.com'],
  },
};

describe('renderValue', () => {
  it('substitutes a placeholder inside a sentence', () => {
    expect(renderValue('Hello {{attr.givenName}}, welcome', vars)).toBe(
      'Hello Ada, welcome',
    );
  });

  it('keeps the type when the string is nothing but one placeholder', () => {
    // `"active": "{{enabled}}"` has to produce a boolean, not the string
    // "true" — a target that type-checks its own API would reject the latter.
    expect(renderValue('{{enabled}}', vars)).toBe(true);
  });

  it('gives every value of a multi-valued attribute when asked as a list', () => {
    expect(renderValue('{{attr.proxyAddresses[]}}', vars)).toEqual([
      'smtp:ada@example.com',
      'smtp:a.lovelace@example.com',
    ]);
  });

  it('gives the first value when asked as a scalar', () => {
    expect(renderValue('{{attr.proxyAddresses}}', vars)).toBe('smtp:ada@example.com');
  });

  it('reports an unset attribute as missing rather than as an empty string', () => {
    expect(renderValue('{{attr.department}}', vars)).toBe(MISSING);
  });

  it('reports the whole string missing when one placeholder in it is', () => {
    // Half a sentence with a hole in it is not a value anybody meant to send.
    expect(renderValue('{{attr.givenName}} {{attr.department}}', vars)).toBe(MISSING);
  });

  it('leaves a string with no placeholder exactly as it is', () => {
    expect(renderValue('urn:ietf:params:scim:schemas:core:2.0:User', vars)).toBe(
      'urn:ietf:params:scim:schemas:core:2.0:User',
    );
  });

  it('does not evaluate anything', () => {
    // The whole point of a declarative connector rather than a script host:
    // there is no expression language here, so a document is data and can
    // never become execution.
    expect(renderValue('{{1 + 1}}', vars)).toBe(MISSING);
    expect(renderValue('{{constructor}}', vars)).toBe(MISSING);
    expect(renderValue('{{__proto__}}', vars)).toBe(MISSING);
  });

  it('does not read an inherited property as an attribute', () => {
    expect(renderValue('{{attr.constructor}}', vars)).toBe(MISSING);
    expect(renderValue('{{attr.__proto__}}', vars)).toBe(MISSING);
    expect(renderValue('{{attr.toString}}', vars)).toBe(MISSING);
  });
});

describe('renderBody', () => {
  it('drops a key whose value is missing', () => {
    // Sending `"department": null` is a WRITE — it clears the field at the
    // target. A body that mapped an attribute nobody set must not do that.
    expect(
      renderBody(
        { givenName: '{{attr.givenName}}', department: '{{attr.department}}' },
        vars,
      ),
    ).toEqual({ givenName: 'Ada' });
  });

  it('drops a missing entry from a list rather than leaving a hole', () => {
    expect(
      renderBody(['{{attr.givenName}}', '{{attr.department}}'], vars),
    ).toEqual(['Ada']);
  });

  it('renders nested objects', () => {
    expect(
      renderBody(
        {
          name: { givenName: '{{attr.givenName}}', familyName: '{{attr.familyName}}' },
          emails: [{ value: '{{attr.mail}}', primary: true }],
        },
        vars,
      ),
    ).toEqual({
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      emails: [{ value: 'ada@example.com', primary: true }],
    });
  });

  it('drops a sub-object none of whose keys survived', () => {
    // `PATCH {"name": {}}` RESETS the name at most targets. An object nobody
    // supplied a part of has to disappear, not arrive empty.
    expect(
      renderBody(
        { displayName: '{{attr.givenName}}', name: { givenName: '{{attr.nope}}' } },
        vars,
      ),
    ).toEqual({ displayName: 'Ada' });
  });

  it('reports a body with nothing left in it as missing', () => {
    // Which the connector turns into a request with no body at all, rather
    // than one carrying `{}`.
    expect(renderBody({ name: { givenName: '{{attr.nope}}' } }, vars)).toBe(MISSING);
  });

  it('leaves numbers and booleans alone', () => {
    expect(renderBody({ page: 1, primary: true, nothing: null }, vars)).toEqual({
      page: 1,
      primary: true,
      nothing: null,
    });
  });
});

describe('renderPath', () => {
  it('substitutes into a path', () => {
    expect(renderPath('/users/{{anchor}}', vars)).toBe('/users/abc-123');
  });

  it('escapes what it substitutes', () => {
    // An anchor is the target's own identifier and can be anything. Without
    // this, one containing `/` or `?` rewrites the request to a different
    // endpoint than the document describes.
    expect(
      renderPath('/users/{{anchor}}', { ...vars, anchor: 'a/../../admin?x=1' }),
    ).toBe('/users/a%2F..%2F..%2Fadmin%3Fx%3D1');
  });

  it('refuses a path with a hole in it', () => {
    // A body may drop a key. A path may not: a URL missing a segment is a
    // request to a different resource, not a smaller one.
    expect(() => renderPath('/users/{{anchor}}/manager', { ...vars, anchor: undefined }))
      .toThrow(/anchor/);
  });
});
