import { describe, expect, it } from 'vitest';
import { bodyFromFields, getAt, isFlatBody, numbersOf, setAt, setNumber, setText } from './doc-path.js';

describe('setAt', () => {
  it('sets a nested value without touching anything else', () => {
    const doc = { name: 'Acme', account: { list: { path: '/users' }, custom: 1 } };
    const next = setAt(doc, 'account.list.itemsAt', 'data');
    expect(next).toEqual({ name: 'Acme', account: { list: { path: '/users', itemsAt: 'data' }, custom: 1 } });
    expect(doc.account.list).toEqual({ path: '/users' });
  });

  it('removes an object left empty by a removal', () => {
    const doc = { account: { read: { path: '/users/{{anchor}}' } } };
    expect(setAt(doc, 'account.read.path', undefined)).toEqual({});
  });

  it('creates the objects on the way', () => {
    expect(setAt({}, 'failures.body.at', 'status')).toEqual({ failures: { body: { at: 'status' } } });
  });
});

describe('setText and setNumber', () => {
  it('leaves a blank field out of the document', () => {
    expect(setText({ baseUrl: 'x' }, 'baseUrl', '  ')).toEqual({});
  });

  it('stores a number as a number and keeps nonsense as text for the schema to name', () => {
    expect(setNumber({}, 'timeoutMs', '5000')).toEqual({ timeoutMs: 5000 });
    expect(setNumber({}, 'timeoutMs', 'soon')).toEqual({ timeoutMs: 'soon' });
  });
});

describe('getAt', () => {
  it('reads through objects and stops at anything else', () => {
    expect(getAt({ a: { b: 'c' } }, 'a.b')).toBe('c');
    expect(getAt({ a: 'text' }, 'a.b')).toBeUndefined();
  });
});

describe('numbersOf', () => {
  it('reads a status list', () => {
    expect(numbersOf('401, 403,x, 0')).toEqual([401, 403]);
  });
});

describe('bodyFromFields', () => {
  it('sends each mapped field with its attribute, the account name as the correlation key', () => {
    expect(
      bodyFromFields({ username: 'userName', first_name: 'givenName', active: 'enabled', id: 'anchor', 'name.last': 'familyName' }),
    ).toEqual({ username: '{{correlationKey}}', first_name: '{{attr.givenName}}' });
  });
});

describe('isFlatBody', () => {
  it('accepts an object of scalars only', () => {
    expect(isFlatBody({ a: 'x', b: true, c: 1 })).toBe(true);
    expect(isFlatBody({ a: { b: 'x' } })).toBe(false);
    expect(isFlatBody(['x'])).toBe(false);
  });
});
