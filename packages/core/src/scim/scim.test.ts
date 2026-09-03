import { describe, expect, it } from 'vitest';
import {
  ScimError,
  SCIM_USER_SCHEMA,
  parseScimUser,
  toScimList,
  toScimUser,
} from './resource.js';
import { parsePagination, parseScimFilter } from './filter.js';
import { interpretPatch } from './patch.js';

const BASE = 'https://acme.test/scim/v2';

describe('parseScimUser', () => {
  it('takes the primary address when several are given', () => {
    // Entra sends several with one flagged.
    expect(
      parseScimUser({
        userName: 'ada',
        emails: [{ value: 'alt@x.test' }, { value: 'main@x.test', primary: true }],
      }).email,
    ).toBe('main@x.test');
  });

  it('falls back to the first when none is flagged primary', () => {
    // Okta sends a single address with no `primary`. Requiring the flag would
    // take no address at all, and an account with no email is one nothing can
    // reach.
    expect(
      parseScimUser({ userName: 'ada', emails: [{ value: 'only@x.test' }] }).email,
    ).toBe('only@x.test');
  });

  it('builds a display name from the name object when none is given', () => {
    expect(
      parseScimUser({
        userName: 'ada',
        name: { givenName: 'Ada', familyName: 'Lovelace' },
      }).displayName,
    ).toBe('Ada Lovelace');
  });

  it('falls back to the userName rather than an empty name', () => {
    // An account with no readable name cannot be picked out of a list.
    expect(parseScimUser({ userName: 'ada' }).displayName).toBe('ada');
  });

  it('defaults active to true', () => {
    // A POST saying nothing about `active` is creating an active user.
    // Defaulting to false would provision accounts nobody can use, and the IdP
    // would report success.
    expect(parseScimUser({ userName: 'ada' }).active).toBe(true);
  });

  it('reads active:false', () => {
    expect(parseScimUser({ userName: 'ada', active: false }).active).toBe(false);
  });

  it('IGNORES a password, completely', () => {
    // Syntra's password rules live in authorize() and the password services. A
    // provisioning protocol is not the place to route around them, and
    // dropping it in the PARSER means no route can forget to.
    const parsed = parseScimUser({ userName: 'ada', password: 'hunter2' });

    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(parsed).not.toHaveProperty('password');
  });

  it('refuses a body with no userName', () => {
    expect(() => parseScimUser({})).toThrow(ScimError);
  });

  it('refuses a body that is not an object', () => {
    expect(() => parseScimUser('nope')).toThrow(ScimError);
  });
});

describe('toScimUser', () => {
  const row = {
    id: 'u-1',
    login: 'ada',
    email: 'ada@acme.test',
    displayName: 'Ada Lovelace',
    status: 'active',
    sourceAnchor: 'e-1',
    createdAt: new Date('2026-08-30T00:00:00Z'),
  };

  it('carries the schema urn, the id and a location', () => {
    const resource = toScimUser(row, BASE);

    expect(resource.schemas).toEqual([SCIM_USER_SCHEMA]);
    expect(resource.id).toBe('u-1');
    expect((resource.meta as Record<string, unknown>).location).toBe(`${BASE}/Users/u-1`);
  });

  it('reports the anchor as externalId, which is what an IdP correlates on', () => {
    expect(toScimUser(row, BASE).externalId).toBe('e-1');
  });

  it('omits externalId entirely when there is none', () => {
    // Rather than null: a client reading `externalId: null` may store it.
    expect(toScimUser({ ...row, sourceAnchor: null }, BASE)).not.toHaveProperty('externalId');
  });

  it('reports an inactive account as active:false', () => {
    expect(toScimUser({ ...row, status: 'inactive' }, BASE).active).toBe(false);
  });

  it('never carries a password', () => {
    expect(JSON.stringify(toScimUser(row, BASE))).not.toContain('password');
  });
});

describe('toScimList', () => {
  it('is 1-based, as the RFC says and everybody gets wrong once', () => {
    expect(toScimList([], 0, 1).startIndex).toBe(1);
  });

  it('reports the whole matching set, not the page', () => {
    // How a client knows to ask for another page.
    const list = toScimList([{}, {}], 57, 1);

    expect(list.totalResults).toBe(57);
    expect(list.itemsPerPage).toBe(2);
  });
});

describe('parseScimFilter', () => {
  const allowed = ['userName', 'externalId'];

  it('parses the two filters an IdP actually sends', () => {
    expect(parseScimFilter('userName eq "ada"', allowed)).toEqual({
      attribute: 'userName',
      value: 'ada',
    });
    expect(parseScimFilter('externalId eq "abc-123"', allowed)).toEqual({
      attribute: 'externalId',
      value: 'abc-123',
    });
  });

  it('is case-insensitive about the operator and the attribute', () => {
    // SCIM attribute names are case-insensitive; a client sending `username`
    // is not making a mistake.
    expect(parseScimFilter('userName EQ "ada"', allowed)).not.toBeNull();
    expect(parseScimFilter('username eq "ada"', allowed)?.attribute).toBe('userName');
  });

  it('returns null for no filter, which means everything', () => {
    expect(parseScimFilter(undefined, allowed)).toBeNull();
    expect(parseScimFilter('  ', allowed)).toBeNull();
  });

  it('refuses an attribute that is not on the list, naming what is', () => {
    expect(() => parseScimFilter('title eq "x"', allowed)).toThrow(/userName/);
  });

  it('refuses an operator it does not implement rather than guessing', () => {
    // A filter half-understood and applied wrongly returns the wrong users,
    // and the client believes it: an unmatched eq becomes a POST, and a
    // dropped clause returns somebody else's account and becomes a PATCH of
    // it.
    expect(() => parseScimFilter('userName co "ad"', allowed)).toThrow(ScimError);
    expect(() => parseScimFilter('userName pr', allowed)).toThrow(ScimError);
    expect(() => parseScimFilter('userName eq "a" and active eq true', allowed)).toThrow(
      ScimError,
    );
  });

  it('unescapes a quote inside the value', () => {
    expect(parseScimFilter('userName eq "a\\"b"', allowed)?.value).toBe('a"b');
  });
});

describe('parsePagination', () => {
  it('defaults to the first page and the cap', () => {
    expect(parsePagination(undefined, undefined, 100)).toEqual({ startIndex: 1, count: 100 });
  });

  it('refuses startIndex=0 rather than reading it as 1', () => {
    // A client off by one is a client whose next page skips a resource, and
    // silently correcting it hides that until somebody notices a missing user.
    expect(() => parsePagination('0', undefined, 100)).toThrow(ScimError);
  });

  it('caps count rather than refusing it', () => {
    // Asking for more than the server will give is not an error, and
    // ServiceProviderConfig publishes the cap so a client can know first.
    expect(parsePagination('1', '5000', 100).count).toBe(100);
  });

  it('refuses a count that is not a number', () => {
    expect(() => parsePagination('1', 'lots', 100)).toThrow(ScimError);
  });
});

describe('interpretPatch', () => {
  it('reads the RFC form, which names a path', () => {
    expect(
      interpretPatch({ Operations: [{ op: 'replace', path: 'active', value: false }] }),
    ).toEqual([{ kind: 'setActive', value: false }]);
  });

  it("reads Entra's pathless form, which is what actually arrives", () => {
    // A server implementing only the pathed form finds no path it recognises
    // and, if careless, answers 200 having changed nothing -- the IdP records
    // a successful deprovision and the account stays live.
    expect(
      interpretPatch({ Operations: [{ op: 'replace', value: { active: false } }] }),
    ).toEqual([{ kind: 'setActive', value: false }]);
  });

  it('reads the string "False" some clients send', () => {
    // Treating a non-empty string as truthy would reactivate an account
    // somebody was deprovisioning.
    expect(
      interpretPatch({ Operations: [{ op: 'replace', path: 'active', value: 'False' }] }),
    ).toEqual([{ kind: 'setActive', value: false }]);
  });

  it('refuses a remove of active rather than reading the absent value as true', () => {
    // `remove` carries no value. Read through the same comparison as a
    // replace, `undefined !== false` is true, and a client that meant "take
    // this attribute away" has reactivated the account it was deprovisioning.
    expect(() =>
      interpretPatch({ Operations: [{ op: 'remove', path: 'active' }] }),
    ).toThrow(expect.objectContaining({ status: 400, scimType: 'invalidPath' }));
  });

  it('accepts only a boolean or the strings true and false for active', () => {
    // Anything else is a client bug, and guessing what it meant means either
    // deactivating somebody by accident or leaving somebody live by accident.
    for (const value of [0, null, {}, 'yes', '']) {
      expect(() =>
        interpretPatch({ Operations: [{ op: 'replace', path: 'active', value }] }),
      ).toThrow(expect.objectContaining({ status: 400, scimType: 'invalidValue' }));
    }
    expect(
      interpretPatch({ Operations: [{ op: 'replace', path: 'active', value: 'TRUE' }] }),
    ).toEqual([{ kind: 'setActive', value: true }]);
  });

  it('reads add and remove of members', () => {
    expect(
      interpretPatch({
        Operations: [{ op: 'add', path: 'members', value: [{ value: 'u-1' }] }],
      }),
    ).toEqual([{ kind: 'addMembers', ids: ['u-1'] }]);

    expect(
      interpretPatch({
        Operations: [{ op: 'remove', path: 'members', value: [{ value: 'u-1' }] }],
      }),
    ).toEqual([{ kind: 'removeMembers', ids: ['u-1'] }]);
  });

  it('reads a bare remove of members as clearing them', () => {
    expect(interpretPatch({ Operations: [{ op: 'remove', path: 'members' }] })).toEqual([
      { kind: 'clearMembers' },
    ]);
  });

  it('refuses replace of members rather than half-performing it', () => {
    // A whole-set assignment treated as an add leaves the members being taken
    // away in place.
    expect(() =>
      interpretPatch({ Operations: [{ op: 'replace', path: 'members', value: [] }] }),
    ).toThrow(ScimError);
  });

  it('refuses a path it does not implement rather than reporting success', () => {
    // THE case. A patch answering 200 without changing anything is the failure
    // that takes days to find, because the IdP believes it landed and stops
    // retrying.
    expect(() =>
      interpretPatch({ Operations: [{ op: 'replace', path: 'title', value: 'x' }] }),
    ).toThrow(ScimError);
  });

  it('refuses an op it does not implement', () => {
    expect(() =>
      interpretPatch({ Operations: [{ op: 'move', path: 'active', value: false }] }),
    ).toThrow(ScimError);
  });

  it('refuses an empty or absent Operations array', () => {
    expect(() => interpretPatch({ Operations: [] })).toThrow(ScimError);
    expect(() => interpretPatch({})).toThrow(ScimError);
  });

  it('reads several operations in one request', () => {
    expect(
      interpretPatch({
        Operations: [
          { op: 'replace', path: 'displayName', value: 'Ada L' },
          { op: 'replace', path: 'active', value: true },
        ],
      }),
    ).toEqual([
      { kind: 'setDisplayName', value: 'Ada L' },
      { kind: 'setActive', value: true },
    ]);
  });
});
