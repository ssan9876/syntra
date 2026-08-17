import { describe, expect, it } from 'vitest';
import {
  attributeOf,
  classifyLdapError,
  encodeUnicodePwd,
  escapeDnValue,
  escapeFilterValue,
  guidBytes,
  isAlreadyInRequestedState,
  primaryGroupVerdict,
  splitDn,
} from './connector.js';
import { objectSidRid } from './sid.js';
import {
  provenanceActionId,
  provenanceValue,
  readProvenanceActionId,
  withProvenanceMarker,
  withProvenanceNote,
} from './provenance.js';
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

describe('guidBytes', () => {
  it('is the exact inverse of normaliseAnchor', () => {
    // Every byte value distinct, so a transposed pair cannot survive.
    const bytes = Buffer.from([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f, 0x10,
    ]);
    expect(guidBytes(normaliseAnchor('objectGUID', bytes))).toEqual(bytes);
  });

  it('little-endian reverses only the first three groups', () => {
    const bytes = Buffer.from([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f, 0x10,
    ]);
    expect(normaliseAnchor('objectGUID', bytes)).toBe(
      '04030201-0605-0807-090a-0b0c0d0e0f10',
    );
    expect(guidBytes('04030201-0605-0807-090a-0b0c0d0e0f10')!.toString('hex')).toBe(
      '0102030405060708090a0b0c0d0e0f10',
    );
  });

  it('is sixteen bytes, whatever the values are', () => {
    // A Buffer and not an escaped string: measured against the container, a
    // filter of `\8a\74…` built from an object's own bytes returns zero
    // hits, because ldapts decodes those escapes as text rather than octets.
    expect(guidBytes('00000000-0000-0000-0000-000000000000')).toEqual(
      Buffer.alloc(16, 0),
    );
    expect(guidBytes('ffffffff-ffff-ffff-ffff-ffffffffffff')).toEqual(
      Buffer.alloc(16, 0xff),
    );
  });

  it('declines anything that is not a 32-hex-digit GUID, so the caller scans', () => {
    // An OpenLDAP `entryUUID` is text, and a fixture anchor is whatever the
    // fixture chose. Returning bytes for those would search for a value the
    // directory does not hold and report every account missing; returning
    // undefined falls back to the scan, which cannot be wrong.
    expect(guidBytes('not-a-guid')).toBeUndefined();
    expect(guidBytes('')).toBeUndefined();
    expect(guidBytes('0102030405060708090a0b0c0d0e0f')).toBeUndefined();
    expect(guidBytes('0102030405060708090a0b0c0d0e0f1011')).toBeUndefined();
    expect(guidBytes('0102030405060708090a0b0c0d0e0fzz')).toBeUndefined();
  });

  it('accepts an upper-case GUID, because that is a rendering and not a value', () => {
    expect(guidBytes('04030201-0605-0807-090A-0B0C0D0E0F10')!.toString('hex')).toBe(
      '0102030405060708090a0b0c0d0e0f10',
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

  it('refuses to write an id it could not read back', () => {
    // `provenanceActionId` stops at the first space, so a marker built from
    // an id containing one reads back as a DIFFERENT id -- silently, and only
    // once an interrupted create has to be resolved. The round trip is the
    // whole guarantee of this pair, so the format refuses rather than
    // producing a marker that breaks it.
    expect(() => provenanceValue('act 9')).toThrow(/whitespace/);
    expect(() => provenanceValue('')).toThrow();
  });
});

describe('objectSidRid', () => {
  // revision 1, 5 sub-authorities, authority 5, then 21-1-2-3-513 little-endian.
  const sid = Buffer.concat([
    Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05]),
    (() => {
      const tail = Buffer.alloc(20);
      for (const [index, value] of [21, 1, 2, 3, 513].entries()) {
        tail.writeUInt32LE(value, index * 4);
      }
      return tail;
    })(),
  ]);

  it('reads the last sub-authority out of the raw bytes', () => {
    // Only the RID. A user's `primaryGroupID` holds that number and nothing
    // else, so it is the only part of the SID that can be compared with it.
    expect(objectSidRid(sid)).toBe(513);
  });

  it('takes the first value when the attribute arrives as an array', () => {
    expect(objectSidRid([sid])).toBe(513);
  });

  it('reads the text form as well, for a directory that renders it', () => {
    expect(objectSidRid('S-1-5-21-1004336348-1177238915-682003330-513')).toBe(513);
  });

  it('answers undefined rather than a wrong number for anything else', () => {
    // "Not established" has to be its own answer: the caller treats it as
    // "cannot tell", and a zero or a NaN here would be read as "not the
    // primary group", which is the assumption that costs something.
    expect(objectSidRid(undefined)).toBeUndefined();
    expect(objectSidRid('')).toBeUndefined();
    expect(objectSidRid(Buffer.from([0x01, 0x05]))).toBeUndefined();
    // A count claiming more sub-authorities than the buffer holds.
    expect(
      objectSidRid(Buffer.from([0x01, 0x09, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0])),
    ).toBeUndefined();
  });
});

describe('primaryGroupVerdict', () => {
  it('says primary when the account\'s primaryGroupID is the group\'s RID', () => {
    expect(primaryGroupVerdict({ primaryGroupID: '9768' }, 9768)).toBe('primary');
  });

  it('says not-primary for any other group', () => {
    expect(primaryGroupVerdict({ primaryGroupID: '9768' }, 513)).toBe('not-primary');
  });

  it('says not-primary when the account has no primary group at all', () => {
    // Not "unknown". An object with no primaryGroupID has no primary group,
    // so no group can be it -- which is the honest answer for a directory
    // with no such concept rather than a guess about one.
    expect(primaryGroupVerdict({ cn: ['Anna'] }, 513)).toBe('not-primary');
  });

  it('says unknown when the group returned no usable objectSid', () => {
    // The account HAS a primary group and the group's RID could not be read,
    // so the question is open. The caller must refuse rather than assume,
    // because the assumption that costs something is "no": it is the one that
    // reports a revoke that did not happen as one that did.
    expect(primaryGroupVerdict({ primaryGroupID: '9768' }, undefined)).toBe('unknown');
  });

  it('does not read a non-numeric primaryGroupID as a group', () => {
    expect(primaryGroupVerdict({ primaryGroupID: 'not a number' }, 513)).toBe(
      'not-primary',
    );
  });
});

describe('readProvenanceActionId', () => {
  it('reads the configured attribute, not the literal info', () => {
    const attributes = {
      info: ['syntra-provision action=wrong'],
      extensionAttribute7: ['syntra-provision action=right'],
    };
    expect(readProvenanceActionId(attributes, 'extensionAttribute7')).toBe('right');
  });

  it('folds the case of the attribute name, because LDAP does', () => {
    // The server chooses the spelling it returns. A deployment nominating
    // `extensionAttribute7` and a server answering `extensionattribute7`
    // must not read as an account Syntra never created.
    expect(readProvenanceActionId({ INFO: 'syntra-provision action=a1' }, 'info')).toBe(
      'a1',
    );
  });

  it('looks past a value that carries no marker', () => {
    expect(
      readProvenanceActionId(
        { info: ['left by an administrator', 'syntra-provision action=a2'] },
        'info',
      ),
    ).toBe('a2');
  });

  it('answers undefined for an attribute the object does not hold', () => {
    expect(readProvenanceActionId({ cn: ['Anna'] }, 'info')).toBeUndefined();
    expect(readProvenanceActionId({ info: [] }, 'info')).toBeUndefined();
  });
});

describe('composing the provenance attribute', () => {
  it('keeps what a template asked for and still carries the marker', () => {
    // `op.attributes` used to be spread LAST into `client.add`, so a target
    // whose attribute template writes `info` overwrote the marker outright.
    // One failed password write afterwards then made the create a permanent
    // conflict, because nothing could recognise the object as ours.
    const value = withProvenanceMarker('Contractor, ends 2027-01-01', 'act-4');
    expect(provenanceActionId(value)).toBe('act-4');
    expect(value).toContain('Contractor, ends 2027-01-01');
  });

  it('never names two actions, however many times it is composed', () => {
    const once = withProvenanceMarker('notes', 'act-4');
    const twice = withProvenanceMarker(once, 'act-4');
    expect(twice.match(/syntra-provision action=/g)).toHaveLength(1);
    expect(provenanceActionId(twice)).toBe('act-4');
    expect(twice).toContain('notes');
  });

  it('keeps the marker and the administrator note when a disable writes a reason', () => {
    // The `replace` on the literal `info` destroyed both. An account the
    // ladder disabled is exactly one a later run may still need to recognise.
    const created = withProvenanceMarker('Desk 4B, key returned', 'act-4');
    const disabled = withProvenanceNote(created, 'leaver: contract ended');

    expect(provenanceActionId(disabled)).toBe('act-4');
    expect(disabled).toContain('Desk 4B, key returned');
    expect(disabled).toContain('[syntra] leaver: contract ended');
  });

  it('replaces a previous reason rather than accumulating them', () => {
    const first = withProvenanceNote(withProvenanceMarker(undefined, 'act-4'), 'first');
    const second = withProvenanceNote(first, 'second');

    expect(second.match(/\[syntra\]/g)).toHaveLength(1);
    expect(second).toContain('[syntra] second');
    expect(second).not.toContain('first');
    expect(provenanceActionId(second)).toBe('act-4');
  });

  it('writes the marker alone when there is nothing to keep', () => {
    expect(withProvenanceMarker(undefined, 'act-4')).toBe(
      'syntra-provision action=act-4',
    );
    expect(withProvenanceMarker('', 'act-4')).toBe('syntra-provision action=act-4');
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
      'bindDn',
      'baseDn',
      'entitlementSearchBase',
      'archiveContainer',
    ] as const) {
      expect(adTargetConfigSchema.safeParse({ ...base, [field]: '' }).success).toBe(false);
    }
  });

  it('requires a URL, and refuses it for being empty rather than for the mode', () => {
    // Split out of the loop above, which asserted this for the wrong reason: an
    // empty url is not an `ldaps://` url, so with the fixture's `tlsMode:
    // 'ldaps'` the superRefine refuses it whether or not `url` has a `min(1)`
    // at all. The mutation pass caught it -- removing `min(1)` from `url` left
    // the suite green. A test that passes for a reason other than the one it
    // names is the same defect as a missing test.
    expect(
      adTargetConfigSchema.safeParse({
        ...base,
        url: '',
        tlsMode: 'starttls' as const,
      }).success,
    ).toBe(false);
  });
});

describe('attributeOf', () => {
  it('matches the attribute name case-insensitively', () => {
    // RFC 4512: attribute NAMES are case-insensitive, and directories disagree
    // about how they spell them back. `samaccountname` and `sAMAccountName`
    // are one attribute, and reading the provenance marker or the
    // userAccountControl through an exact match would silently find nothing --
    // which reads as "no marker", so an adoptable account becomes a conflict,
    // and as "no userAccountControl", so a disable resets every other flag.
    const entry = { SAMACCOUNTNAME: ['anna.novak'], Info: 'syntra-provision action=a' };
    expect(attributeOf(entry, 'sAMAccountName')).toBe('anna.novak');
    expect(attributeOf(entry, 'info')).toBe('syntra-provision action=a');
  });

  it('takes the first value of a multi-valued attribute', () => {
    expect(attributeOf({ cn: ['first', 'second'] }, 'cn')).toBe('first');
  });

  it('reads a scalar the server did not wrap in an array', () => {
    expect(attributeOf({ cn: 'plain' }, 'cn')).toBe('plain');
  });

  it('reports undefined for an absent attribute and for an empty one', () => {
    // Not the empty string: `''` would compare equal to a real empty value and
    // silence the `?? UAC_NORMAL_ENABLED` fallbacks that depend on this.
    expect(attributeOf({}, 'cn')).toBeUndefined();
    expect(attributeOf({ cn: [] }, 'cn')).toBeUndefined();
    expect(attributeOf({ cn: null }, 'cn')).toBeUndefined();
  });
});

describe('isAlreadyInRequestedState', () => {
  it('reads the ldapts error CLASS, with no help from the message', () => {
    // The message is deliberately empty here. Samba puts the phrase in its
    // diagnostic as well, so an implementation reading only the message passes
    // every integration test in this package and then turns both of these into
    // permanent, non-retryable failures against a directory that words its
    // errors differently.
    expect(isAlreadyInRequestedState('grant_entitlement', named('AttributeOrValueExistsError'))).toBe(true);
    expect(isAlreadyInRequestedState('revoke_entitlement', named('NoSuchAttributeError'))).toBe(true);
  });

  it('reads the server diagnostic too, when that is where the phrase is', () => {
    expect(
      isAlreadyInRequestedState('grant_entitlement', named('Error', 'value already exists')),
    ).toBe(true);
    expect(
      isAlreadyInRequestedState('revoke_entitlement', named('Error', 'no such attribute')),
    ).toBe(true);
  });

  it('does not read one operation as the other', () => {
    // A revoke that failed because the VALUE already exists is not a revoke
    // that succeeded, and a grant that failed with `NoSuchAttribute` means the
    // group is gone rather than that the person is already in it. Crossing
    // them reports success over a write that did not happen.
    expect(isAlreadyInRequestedState('revoke_entitlement', named('AttributeOrValueExistsError'))).toBe(false);
    expect(isAlreadyInRequestedState('grant_entitlement', named('NoSuchAttributeError'))).toBe(false);
  });

  it('says no to every other failure', () => {
    expect(isAlreadyInRequestedState('grant_entitlement', named('NoSuchObjectError'))).toBe(false);
    expect(isAlreadyInRequestedState('revoke_entitlement', named('InsufficientAccessError'))).toBe(false);
    expect(isAlreadyInRequestedState('grant_entitlement', 'a bare string')).toBe(false);
    expect(isAlreadyInRequestedState('revoke_entitlement', undefined)).toBe(false);
  });
});
