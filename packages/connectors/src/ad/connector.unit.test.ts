import { describe, expect, it } from 'vitest';
import {
  classifyLdapError,
  encodeUnicodePwd,
  escapeDnValue,
  escapeFilterValue,
  guidFilterValue,
  provenanceActionId,
  provenanceValue,
  splitDn,
} from './connector.js';
import { adTargetConfigSchema } from './config.js';
import { normaliseAnchor } from '../ldap/anchor.js';

/**
 * The parts of the connector that need no directory.
 *
 * They live in their own file so that a checkout with no Samba container can
 * still run them: `connector.integration.test.ts` needs a live domain
 * controller for every one of its cases, and these need none.
 */

const named = (name: string, message = '') => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe('classifyLdapError', () => {
  it('reads the discriminating signal out of the error class name', () => {
    // ldapts puts it in `cause.name` and NOT in the server's diagnostic
    // message. A classifier matching the message alone returns `rejected` for
    // every one of these, which makes each of them permanent.
    expect(classifyLdapError(named('EntryAlreadyExistsError'))).toBe('conflict');
    expect(classifyLdapError(named('AttributeOrValueExistsError'))).toBe('conflict');
    expect(classifyLdapError(named('NoSuchAttributeError'))).toBe('not_found');
    expect(classifyLdapError(named('NoSuchObjectError'))).toBe('not_found');
    expect(classifyLdapError(named('InvalidCredentialsError'))).toBe('unauthorized');
    expect(classifyLdapError(named('InsufficientAccessError'))).toBe('unauthorized');
    expect(classifyLdapError(named('StrongAuthRequiredError'))).toBe('unauthorized');
    expect(classifyLdapError(named('BusyError'))).toBe('transient');
    expect(classifyLdapError(named('UnavailableError'))).toBe('transient');
    expect(classifyLdapError(named('AdminLimitExceededError'))).toBe('throttled');
  });

  it("reads Samba's own duplicate-name diagnostic as a conflict", () => {
    // 00002071: samldb: samAccountName 'dee.olsen' already in use! Code: 0x44
    expect(
      classifyLdapError(
        named('Error', "00002071: samldb: samAccountName 'dee.olsen' already in use!"),
      ),
    ).toBe('conflict');
  });

  it('classifies a dropped socket as transient and a schema violation as rejected', () => {
    expect(classifyLdapError(named('Error', 'read ECONNRESET'))).toBe('transient');
    expect(classifyLdapError(named('Error', 'connect ECONNREFUSED'))).toBe('transient');
    expect(classifyLdapError(named('Error', 'connect ETIMEDOUT'))).toBe('transient');
    // A refused password complexity does not become acceptable on the fourth
    // attempt, so it must never land in a retryable bucket.
    expect(
      classifyLdapError(named('ConstraintViolationError', 'password does not meet policy')),
    ).toBe('rejected');
    expect(classifyLdapError(named('ObjectClassViolationError'))).toBe('rejected');
  });

  it('classifies something that is not an Error at all rather than throwing', () => {
    expect(classifyLdapError('a bare string')).toBe('rejected');
    expect(classifyLdapError(undefined)).toBe('rejected');
    expect(classifyLdapError({ name: 'NoSuchObjectError' })).toBe('rejected');
  });

  it('prefers conflict over not_found when a message carries both signals', () => {
    // Order matters: `AttributeOrValueExists` on a grant is a success the
    // caller detects by class, and misreading it as `not_found` would send the
    // run looking for an object that is right there.
    expect(
      classifyLdapError(named('AttributeOrValueExistsError', 'no such attribute member')),
    ).toBe('conflict');
  });
});

describe('encodeUnicodePwd', () => {
  it('wraps the password in literal double quotes and encodes it UTF-16LE', () => {
    const encoded = encodeUnicodePwd('ab');
    expect([...encoded]).toEqual([0x22, 0x00, 0x61, 0x00, 0x62, 0x00, 0x22, 0x00]);
  });

  it('round-trips a password containing non-ASCII characters', () => {
    // A Dutch or Czech password is ordinary, and UTF-16LE is what makes it
    // survive: latin1 would mangle it and the account would refuse the
    // password its owner was handed.
    const password = 'Wachtwoord!Ĳsbrand0';
    expect(encodeUnicodePwd(password).toString('utf16le')).toBe(`"${password}"`);
  });

  it('does not escape a quote inside the password', () => {
    // AD's wire format is quote-wrapped UTF-16LE with no escaping of its own;
    // the length is on the attribute, not on the quotes. Inventing an escape
    // would set a password different from the one the caller sealed and
    // delivered.
    expect(encodeUnicodePwd('a"b').toString('utf16le')).toBe('"a"b"');
  });
});

describe('escapeFilterValue', () => {
  it('escapes every character RFC 4515 names', () => {
    expect(escapeFilterValue('a\\b')).toBe('a\\5cb');
    expect(escapeFilterValue('a*b')).toBe('a\\2ab');
    expect(escapeFilterValue('a(b')).toBe('a\\28b');
    expect(escapeFilterValue('a)b')).toBe('a\\29b');
    expect(escapeFilterValue('a\0b')).toBe('a\\00b');
  });

  it('closes the filter injection an unescaped value opens', () => {
    // `(sAMAccountName=*)(objectClass=*` closes the equality clause and opens
    // a second one, which returns every object in the base rather than one.
    const escaped = escapeFilterValue('*)(objectClass=*');
    expect(escaped).toBe('\\2a\\29\\28objectClass=\\2a');
    expect(escaped).not.toContain('(');
    expect(escaped).not.toContain(')');
  });

  it('escapes the backslash before anything else, not after', () => {
    // Escaping `*` first and `\` second turns `*` into `\2a` and then into
    // `\5c2a`, which is a literal backslash followed by "2a" and matches
    // nothing. A single pass over the characters is what makes that
    // impossible.
    expect(escapeFilterValue('\\*')).toBe('\\5c\\2a');
  });

  it('leaves an ordinary correlation key untouched', () => {
    expect(escapeFilterValue('anna.novak')).toBe('anna.novak');
    expect(escapeFilterValue('jan-kovac2')).toBe('jan-kovac2');
  });
});

describe('escapeDnValue', () => {
  it('escapes every character RFC 4514 makes special', () => {
    expect(escapeDnValue('a,b')).toBe('a\\,b');
    expect(escapeDnValue('a+b')).toBe('a\\+b');
    expect(escapeDnValue('a"b')).toBe('a\\"b');
    expect(escapeDnValue('a\\b')).toBe('a\\\\b');
    expect(escapeDnValue('a<b')).toBe('a\\<b');
    expect(escapeDnValue('a>b')).toBe('a\\>b');
    expect(escapeDnValue('a;b')).toBe('a\\;b');
    expect(escapeDnValue('a=b')).toBe('a\\=b');
    expect(escapeDnValue('a\0b')).toBe('a\\00b');
  });

  it('closes the DN injection of Ruling P22', () => {
    // Unescaped, `CN=${key},${baseDn}` with this key renders a VALID DN naming
    // the domain controllers container: directory placement chosen by whoever
    // can edit the value.
    const escaped = escapeDnValue('x,OU=Domain Controllers');
    expect(escaped).toBe('x\\,OU\\=Domain Controllers');
    expect(`CN=${escaped},DC=syntra,DC=test`.split(/(?<!\\),/)).toHaveLength(3);
  });

  it('escapes a leading hash or space and a trailing space', () => {
    expect(escapeDnValue('#hash')).toBe('\\#hash');
    expect(escapeDnValue(' lead')).toBe('\\ lead');
    expect(escapeDnValue('trail ')).toBe('trail\\ ');
  });

  it('leaves an ordinary correlation key untouched', () => {
    expect(escapeDnValue('anna.novak')).toBe('anna.novak');
  });
});

describe('splitDn', () => {
  it('splits an ordinary DN at its first comma', () => {
    expect(splitDn('CN=anna.novak,OU=People,DC=syntra,DC=test')).toEqual({
      rdn: 'CN=anna.novak',
      parent: 'OU=People,DC=syntra,DC=test',
    });
  });

  it('does not split at an escaped comma inside the RDN', () => {
    // `dn.indexOf(',')` yields `CN=Novak\` here, and archiving that person
    // then calls modifyDN with `CN=Novak\,OU=Archive,DC=...` -- a different
    // object in a different place, with nothing that fails loudly.
    expect(splitDn('CN=Novak\\, Anna,OU=People,DC=syntra,DC=test')).toEqual({
      rdn: 'CN=Novak\\, Anna',
      parent: 'OU=People,DC=syntra,DC=test',
    });
  });

  it('does not treat an escaped backslash as escaping the comma after it', () => {
    // `CN=back\\` is a CN ending in one literal backslash; the comma after it
    // is a real separator.
    expect(splitDn('CN=back\\\\,OU=People')).toEqual({
      rdn: 'CN=back\\\\',
      parent: 'OU=People',
    });
  });

  it('reports an empty parent for a DN with a single component', () => {
    expect(splitDn('DC=test')).toEqual({ rdn: 'DC=test', parent: '' });
  });
});

describe('guidFilterValue', () => {
  it('is the exact inverse of normaliseAnchor', () => {
    // Every byte value distinct, so a transposed pair cannot survive.
    const bytes = Buffer.from([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f, 0x10,
    ]);
    const anchor = normaliseAnchor('objectGUID', bytes);
    const filter = guidFilterValue(anchor)!;
    const roundTripped = Buffer.from(
      filter
        .split('\\')
        .filter((part) => part !== '')
        .map((part) => Number.parseInt(part, 16)),
    );
    expect(roundTripped).toEqual(bytes);
  });

  it('little-endian reverses only the first three groups', () => {
    const bytes = Buffer.from([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f, 0x10,
    ]);
    expect(normaliseAnchor('objectGUID', bytes)).toBe(
      '04030201-0605-0807-090a-0b0c0d0e0f10',
    );
    expect(guidFilterValue('04030201-0605-0807-090a-0b0c0d0e0f10')).toBe(
      '\\01\\02\\03\\04\\05\\06\\07\\08\\09\\0a\\0b\\0c\\0d\\0e\\0f\\10',
    );
  });

  it('pads a byte below 16 to two hex digits', () => {
    // `\0` rather than `\00` shifts every byte after it and the filter matches
    // a different object, or none.
    const filter = guidFilterValue('00000000-0000-0000-0000-000000000000')!;
    expect(filter).toBe('\\00'.repeat(16));
  });

  it('declines anything that is not a 32-hex-digit GUID, so the caller scans', () => {
    // An OpenLDAP `entryUUID` is text, and a fixture anchor is whatever the
    // fixture chose. Returning a filter for those would search for bytes the
    // directory does not hold and report every account missing; returning
    // undefined falls back to the scan, which cannot be wrong.
    expect(guidFilterValue('not-a-guid')).toBeUndefined();
    expect(guidFilterValue('')).toBeUndefined();
    expect(guidFilterValue('0102030405060708090a0b0c0d0e0f')).toBeUndefined();
    expect(guidFilterValue('0102030405060708090a0b0c0d0e0f1011')).toBeUndefined();
    expect(guidFilterValue('0102030405060708090a0b0c0d0e0fzz')).toBeUndefined();
  });

  it('accepts an upper-case GUID, because that is a rendering and not a value', () => {
    expect(guidFilterValue('04030201-0605-0807-090A-0B0C0D0E0F10')).toBe(
      '\\01\\02\\03\\04\\05\\06\\07\\08\\09\\0a\\0b\\0c\\0d\\0e\\0f\\10',
    );
  });
});

describe('the provenance marker', () => {
  it('round-trips the action id it was written with', () => {
    expect(provenanceActionId(provenanceValue('action-3'))).toBe('action-3');
  });

  it('does not match an action id that is only a prefix of the recorded one', () => {
    // `marker.includes(op.actionId)` adopts the account action `abc-10`
    // created while replaying action `abc-1`, which is precisely the outcome
    // the marker exists to prevent: handing one person's account to another.
    expect(provenanceActionId(provenanceValue('abc-10'))).not.toBe('abc-1');
    expect(provenanceActionId(provenanceValue('abc-1'))).toBe('abc-1');
  });

  it('finds the marker when an administrator has written a note in front of it', () => {
    expect(provenanceActionId('managed by IT. syntra-provision action=act-9')).toBe(
      'act-9',
    );
  });

  it('reads nothing out of a note that merely mentions the action id', () => {
    expect(provenanceActionId('created for action-3 by hand')).toBeUndefined();
    expect(provenanceActionId('')).toBeUndefined();
  });

  it('does not accept the prefix glued to the end of another word', () => {
    expect(provenanceActionId('notsyntra-provision action=act-9')).toBeUndefined();
  });
});

describe('adTargetConfigSchema', () => {
  const base = {
    url: 'ldaps://dc.example.test:636',
    tlsMode: 'ldaps' as const,
    bindDn: 'CN=svc,DC=example,DC=test',
    baseDn: 'OU=People,DC=example,DC=test',
    entitlementSearchBase: 'OU=Groups,DC=example,DC=test',
    archiveContainer: 'OU=Archive,DC=example,DC=test',
  };

  it('has no plaintext transport at all', () => {
    // Not a default to be overridden: absent from the enum. Active Directory
    // refuses a password write over an unencrypted connection, and a target
    // that COULD be configured to write in the clear is a target that
    // eventually does.
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldap://dc.example.test:389',
        tlsMode: 'plain',
      }).success,
    ).toBe(false);
    expect(adTargetConfigSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a URL scheme and a TLS mode that contradict each other', () => {
    // Either silent resolution is a trap: honour the mode and a plaintext
    // client connects to a TLS port and hangs; honour the scheme and the mode
    // an administrator chose is ignored.
    expect(
      adTargetConfigSchema.safeParse({ ...base, tlsMode: 'starttls' }).success,
    ).toBe(false);
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldap://dc.example.test:389',
        tlsMode: 'ldaps',
      }).success,
    ).toBe(false);
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: 'ldap://dc.example.test:389',
        tlsMode: 'starttls',
      }).success,
    ).toBe(true);
  });

  it('defaults certificate verification ON', () => {
    // Turning it off is a deliberate per-target decision. A default of `false`
    // would make every target in the product accept any certificate, silently.
    expect(adTargetConfigSchema.parse(base).rejectUnauthorized).toBe(true);
  });

  it('supplies the defaults the connector reads', () => {
    const parsed = adTargetConfigSchema.parse(base);
    expect(parsed.provenanceAttribute).toBe('info');
    expect(parsed.anchorAttribute).toBe('objectGUID');
    expect(parsed.accountFilter).toBe('(&(objectCategory=person)(objectClass=user))');
    expect(parsed.groupFilter).toBe('(objectClass=group)');
    expect(parsed.primaryGroupExternalIds).toEqual([]);
    expect(parsed.pageSize).toBe(1000);
    expect(parsed.connectTimeoutMs).toBe(10_000);
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it('refuses a timeout of zero, which ldapts reads as "wait forever"', () => {
    expect(
      adTargetConfigSchema.safeParse({ ...base, connectTimeoutMs: 0 }).success,
    ).toBe(false);
    expect(adTargetConfigSchema.safeParse({ ...base, timeoutMs: 0 }).success).toBe(false);
    expect(adTargetConfigSchema.safeParse({ ...base, pageSize: 0 }).success).toBe(false);
  });

  it('requires every search base rather than falling back to the domain root', () => {
    // An empty archiveContainer would move archived accounts to the RDN alone,
    // and an empty baseDn would search -- and write into -- the whole domain.
    for (const field of [
      'url',
      'bindDn',
      'baseDn',
      'entitlementSearchBase',
      'archiveContainer',
    ] as const) {
      expect(adTargetConfigSchema.safeParse({ ...base, [field]: '' }).success).toBe(false);
    }
  });
});
