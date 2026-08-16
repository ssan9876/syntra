import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ACTION_TYPES,
  SYNTRA_ONLY_ACTION_TYPES,
  first,
  isRetryable,
  type ProvisionActionType,
  type SourceRecord,
  type WriteOperation,
} from './types.js';

const record: SourceRecord = {
  anchor: 'a1',
  objectType: 'user',
  dn: 'cn=Jo,ou=Care,dc=acme,dc=test',
  attributes: {
    cn: ['Jo Doe'],
    mail: ['jo@acme.test'],
    memberOf: ['cn=Nurses,dc=acme,dc=test', 'cn=Staff,dc=acme,dc=test'],
    empty: [],
  },
};

describe('first', () => {
  it('returns the first value of a multi-valued attribute', () => {
    // LDAP attributes are always multi-valued on the wire, even when the
    // schema says otherwise, so callers must not index blindly.
    expect(first(record, 'memberOf')).toBe('cn=Nurses,dc=acme,dc=test');
  });

  it('returns a single value', () => {
    expect(first(record, 'mail')).toBe('jo@acme.test');
  });

  it('returns undefined for an attribute that is present but empty', () => {
    expect(first(record, 'empty')).toBeUndefined();
  });

  it('returns undefined for an absent attribute', () => {
    expect(first(record, 'telephoneNumber')).toBeUndefined();
  });

  it('is case-insensitive, because LDAP attribute names are', () => {
    expect(first(record, 'MAIL')).toBe('jo@acme.test');
  });
});

/**
 * Spec section 9: Provision never deletes. Not after any grace period, not
 * under any configuration, not on any code path.
 *
 * This test exists so that adding a destructive member to the action union
 * fails a test rather than passing review. It is deliberately written as an
 * exhaustive enumeration rather than a regex over the type, because a type is
 * erased at run time and cannot be asserted on -- so the enumeration is the
 * value the rest of the system iterates, and this is what pins it.
 */
describe('the action-type union', () => {
  const EXPECTED: ProvisionActionType[] = [
    'create_account',
    'update_account',
    'enable_account',
    'disable_account',
    'archive_account',
    'rename_account',
    'grant_entitlement',
    'revoke_entitlement',
    'deactivate_syntra_user',
    'reactivate_syntra_user',
  ];

  it('contains exactly the ten action types the spec names', () => {
    expect([...CONNECTOR_ACTION_TYPES, ...SYNTRA_ONLY_ACTION_TYPES].sort()).toEqual(
      [...EXPECTED].sort(),
    );
  });

  it('contains no member whose name suggests destruction', () => {
    // A member called delete_account, purge_account, remove_account or
    // destroy_entitlement would pass every other test in this repository.
    const forbidden = /delete|destroy|purge|erase|wipe|remove_account|drop/i;
    for (const type of [...CONNECTOR_ACTION_TYPES, ...SYNTRA_ONLY_ACTION_TYPES]) {
      expect(type).not.toMatch(forbidden);
    }
  });

  it('routes exactly two action types away from any connector', () => {
    // deactivate_syntra_user and reactivate_syntra_user are writes to Syntra's
    // own directory (spec section 4). They call no connector at all, which is
    // why they are the only two that apply inside a single transaction with
    // their audit event and need no in-flight resolution.
    expect([...SYNTRA_ONLY_ACTION_TYPES].sort()).toEqual([
      'deactivate_syntra_user',
      'reactivate_syntra_user',
    ]);
  });

  it('maps every connector action type onto exactly one write operation', () => {
    // Every WriteOperation `op` is a connector action type and vice versa. A
    // connector action with no operation could never be applied; an operation
    // with no action type could never be proposed.
    const ops: WriteOperation['op'][] = [
      'create_account',
      'update_account',
      'enable_account',
      'disable_account',
      'archive_account',
      'rename_account',
      'grant_entitlement',
      'revoke_entitlement',
    ];
    expect([...CONNECTOR_ACTION_TYPES].sort()).toEqual([...ops].sort());
  });
});

describe('isRetryable', () => {
  it('retries transient and throttled, and nothing else', () => {
    // A duplicate name, a schema violation, a refused password complexity, a
    // revoked service credential and a deleted entitlement do not become true
    // on the fourth attempt.
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('throttled')).toBe(true);
    expect(isRetryable('conflict')).toBe(false);
    expect(isRetryable('rejected')).toBe(false);
    expect(isRetryable('unauthorized')).toBe(false);
    expect(isRetryable('not_found')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
