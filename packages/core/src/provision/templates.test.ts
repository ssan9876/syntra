import { describe, expect, it } from 'vitest';
import {
  escapeDnValue,
  renderTemplate,
  resolveReference,
  templateReferences,
  type TemplateContext,
} from './templates.js';

const context = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  person: {
    givenName: 'Anna Maria',
    familyName: "O'Brien",
    // `Person` has businessEmail and personalEmail. It has no `email` column
    // and no `displayName` column, and spec section 15 forbids adding one --
    // so no template anywhere in this plan may name `%person.email%`.
    businessEmail: 'anna@acme.test',
    personalEmail: null,
    nameConvention: 'familyName',
    displayName: "Anna Maria O'Brien",
    status: 'active',
  },
  contract: {
    department: 'Finance',
    jobTitle: 'Analyst',
    costCentre: 'CC-100',
    employer: 'Acme Care',
    location: 'Utrecht',
  },
  baseDn: 'DC=acme,DC=test',
  ...over,
});

describe('renderTemplate', () => {
  it('substitutes person and contract fields', () => {
    const result = renderTemplate('%person.givenName% %person.familyName%', context());
    expect(result).toEqual({ ok: true, value: "Anna Maria O'Brien" });
  });

  it('substitutes baseDn, which has no prefix', () => {
    const result = renderTemplate(
      'OU=%contract.department%,OU=Users,%baseDn%',
      context(),
    );
    expect(result).toEqual({
      ok: true,
      value: 'OU=Finance,OU=Users,DC=acme,DC=test',
    });
  });

  it('supports the .first modifier for a first name part', () => {
    // "%person.givenName.first%.%person.familyName%" is the spec's own
    // example, and a person with two given names must yield one initial part
    // rather than a login with a space in it.
    const result = renderTemplate(
      '%person.givenName.first%.%person.familyName%',
      context(),
    );
    expect(result).toEqual({ ok: true, value: "Anna.O'Brien" });
  });

  it('supports the .initial modifier', () => {
    const result = renderTemplate(
      '%person.givenName.initial%%person.familyName%',
      context(),
    );
    expect(result).toEqual({ ok: true, value: "AO'Brien" });
  });

  it('reports every unresolvable placeholder rather than rendering an empty string', () => {
    // An empty value rendered into a DN produces "OU=,OU=Users,..." which is
    // not a container, and rendered into a login produces a login somebody
    // else may already hold. Both must be a refusal, and the refusal has to
    // name what was missing so somebody can fix it.
    const result = renderTemplate(
      'OU=%contract.department%,OU=%contract.costCentre%,%baseDn%',
      context({ contract: { department: null, costCentre: '  ' } }),
    );
    expect(result).toEqual({
      ok: false,
      missing: ['contract.department', 'contract.costCentre'],
    });
  });

  it('reports an unknown placeholder as missing rather than leaving it literal', () => {
    const result = renderTemplate('%person.nickname%', context());
    expect(result).toEqual({ ok: false, missing: ['person.nickname'] });
  });

  it('leaves text with no placeholders alone', () => {
    expect(renderTemplate('OU=Archive,DC=acme,DC=test', context())).toEqual({
      ok: true,
      value: 'OU=Archive,DC=acme,DC=test',
    });
  });

  it('lists a repeated missing placeholder once', () => {
    const result = renderTemplate(
      '%contract.location%/%contract.location%',
      context({ contract: { location: null } }),
    );
    expect(result).toEqual({ ok: false, missing: ['contract.location'] });
  });

  // --- Additions: every one of these is a template an administrator can type.

  describe('a placeholder it cannot parse is refused, never passed through', () => {
    it('refuses a misspelled modifier instead of emitting it literally', () => {
      // The brief's regex does not match this token at all, so `replace` never
      // sees it and it survives into the output: a DN containing a literal
      // percent sign, or a login of "personGivenNameupper" once the sanitiser
      // has had it. A typo must stop the person, not invent a name.
      const result = renderTemplate('%person.givenName.upper%', context());
      expect(result).toEqual({ ok: false, missing: ['%person.givenName.upper%'] });
    });

    it('refuses a field name the grammar does not allow', () => {
      const result = renderTemplate(
        'OU=%contract.cost_centre%,%baseDn%',
        context(),
      );
      expect(result).toEqual({ ok: false, missing: ['%contract.cost_centre%'] });
    });

    it('refuses an unterminated placeholder', () => {
      const result = renderTemplate('OU=%contract.department', context());
      expect(result).toEqual({ ok: false, missing: ['%contract.department'] });
    });

    it('refuses a stray percent sign', () => {
      // A lone `%` puts every later delimiter out of phase, so the refusal
      // names two tokens rather than one. That is the honest report: with no
      // escape for a literal percent there is no way to tell which `%` the
      // author meant, and the template as a whole is unusable.
      const result = renderTemplate('100% %person.familyName%', context());
      expect(result).toEqual({ ok: false, missing: ['% %', '%'] });
    });

    it('refuses an empty placeholder', () => {
      expect(renderTemplate('%%', context())).toEqual({ ok: false, missing: ['%%'] });
    });

    it('refuses a scope with no field', () => {
      expect(renderTemplate('%person%', context())).toEqual({
        ok: false,
        missing: ['person'],
      });
    });

    it('refuses a field under baseDn, which has none', () => {
      expect(renderTemplate('%baseDn.department%', context())).toEqual({
        ok: false,
        missing: ['baseDn.department'],
      });
    });

    it('refuses an unknown scope', () => {
      expect(renderTemplate('%manager.givenName%', context())).toEqual({
        ok: false,
        missing: ['manager.givenName'],
      });
    });
  });

  describe('the map is read as data, never as an object', () => {
    it('treats an inherited property as an unknown field instead of throwing', () => {
      // `context.person.constructor` is a function, not undefined. A lookup
      // that only checks for undefined and null then calls `.trim()` on it and
      // the run dies with "raw.trim is not a function" -- from a template
      // somebody typed into a form.
      expect(() => renderTemplate('%person.constructor%', context())).not.toThrow();
      expect(renderTemplate('%person.constructor%', context())).toEqual({
        ok: false,
        missing: ['person.constructor'],
      });
      expect(renderTemplate('%contract.toString%', context())).toEqual({
        ok: false,
        missing: ['contract.toString'],
      });
    });

    it('does not see a polluted prototype', () => {
      // The `typeof` check alone catches `constructor` and `toString`, because
      // both are functions. It does not catch a *string* planted on
      // Object.prototype, which is what prototype pollution actually looks
      // like: `%person.nickname%` would then resolve for every person in the
      // tenant, to the same value, and every login would collide.
      const polluted = Object.prototype as unknown as Record<string, string>;
      try {
        polluted.nickname = 'planted';
        expect(renderTemplate('%person.nickname%', context())).toEqual({
          ok: false,
          missing: ['person.nickname'],
        });
      } finally {
        delete polluted.nickname;
      }
    });

    it('treats a non-string value as an unknown field', () => {
      // `attributeTemplates` and the CSV loader both hand over parsed JSON.
      // `Record<string, string | null>` is a claim about that data, not a
      // guarantee, and `42` must not become the login "42".
      const withNumber = context();
      (withNumber.person as Record<string, unknown>).fte = 1;
      expect(renderTemplate('%person.fte%', withNumber)).toEqual({
        ok: false,
        missing: ['person.fte'],
      });
    });
  });

  describe('the empty case', () => {
    it('refuses an empty baseDn', () => {
      // `baseDn` is a non-nullable string, so nothing in the type system stops
      // an unconfigured target from handing over "". "OU=Users," is not a DN.
      expect(renderTemplate('OU=Users,%baseDn%', context({ baseDn: '' }))).toEqual({
        ok: false,
        missing: ['baseDn'],
      });
      expect(renderTemplate('OU=Users,%baseDn%', context({ baseDn: '   ' }))).toEqual({
        ok: false,
        missing: ['baseDn'],
      });
    });

    it('refuses a value made only of control characters', () => {
      const control = String.fromCharCode(9, 10, 13, 0);
      expect(
        renderTemplate('%contract.department%', context({ contract: { department: control } })),
      ).toEqual({ ok: false, missing: ['contract.department'] });
    });

    it('refuses an empty template only when it has to', () => {
      // An empty template resolves to an empty string with nothing missing.
      // That is the honest answer for this function; the caller decides whether
      // an empty rendering is usable, and generateCorrelationKey refuses it.
      expect(renderTemplate('', context())).toEqual({ ok: true, value: '' });
    });
  });

  describe('value normalisation', () => {
    it('collapses internal whitespace and strips control characters', () => {
      const messy = `Anna${String.fromCharCode(9)}  Maria`;
      expect(
        renderTemplate('%person.givenName%', context({ person: { givenName: messy } })),
      ).toEqual({ ok: true, value: 'Anna Maria' });
    });

    it('takes the first name part after collapsing, not before', () => {
      const messy = '  Anna   Maria ';
      expect(
        renderTemplate(
          '%person.givenName.first%',
          context({ person: { givenName: messy } }),
        ),
      ).toEqual({ ok: true, value: 'Anna' });
    });

    it('takes a whole code point for .initial, not half a surrogate pair', () => {
      // `value.slice(0, 1)` on an astral first character returns a lone
      // surrogate: invalid UTF-16 in a display name and in a DN.
      const astral = '\u{1D49C}nna';
      const result = renderTemplate(
        '%person.givenName.initial%',
        context({ person: { givenName: astral } }),
      );
      expect(result).toEqual({ ok: true, value: '\u{1D49C}' });
      expect((result as { value: string }).value).not.toBe(astral.slice(0, 1));
    });
  });

  describe('DN escaping', () => {
    const injected = context({
      contract: { department: 'Finance,OU=Domain Controllers' },
    });

    it('escapes substituted values when an escaper is supplied', () => {
      expect(
        renderTemplate('OU=%contract.department%,OU=Users,%baseDn%', injected, {
          escapeValue: escapeDnValue,
        }),
      ).toEqual({
        ok: true,
        value:
          'OU=Finance\\,OU\\=Domain Controllers,OU=Users,DC=acme,DC=test',
      });
    });

    it('places the account where the comma says when the escaper is omitted', () => {
      // Not an aspiration -- this is what happens today wherever a container
      // template is rendered without one, and it is a container chosen by
      // whoever can edit an HR record.
      expect(
        renderTemplate('OU=%contract.department%,OU=Users,%baseDn%', injected),
      ).toEqual({
        ok: true,
        value: 'OU=Finance,OU=Domain Controllers,OU=Users,DC=acme,DC=test',
      });
    });

    it('does not escape baseDn, which is already a DN', () => {
      expect(
        renderTemplate('OU=Users,%baseDn%', context(), { escapeValue: escapeDnValue }),
      ).toEqual({ ok: true, value: 'OU=Users,DC=acme,DC=test' });
    });

    it('leaves literal template text alone', () => {
      expect(
        renderTemplate('OU=%contract.department%,OU=Users,%baseDn%', context(), {
          escapeValue: escapeDnValue,
        }),
      ).toEqual({ ok: true, value: 'OU=Finance,OU=Users,DC=acme,DC=test' });
    });
  });
});

describe('escapeDnValue', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeDnValue('Finance')).toBe('Finance');
    expect(escapeDnValue('Acme Care')).toBe('Acme Care');
  });

  it('escapes every RFC 4514 special character', () => {
    expect(escapeDnValue('a,b')).toBe('a\\,b');
    expect(escapeDnValue('a+b')).toBe('a\\+b');
    expect(escapeDnValue('a=b')).toBe('a\\=b');
    expect(escapeDnValue('a"b')).toBe('a\\"b');
    expect(escapeDnValue('a<b>c')).toBe('a\\<b\\>c');
    expect(escapeDnValue('a;b')).toBe('a\\;b');
    expect(escapeDnValue('a\\b')).toBe('a\\\\b');
  });

  it('escapes a leading hash, which would otherwise mean hex-encoded BER', () => {
    expect(escapeDnValue('#1F')).toBe('\\#1F');
    expect(escapeDnValue('a#b')).toBe('a#b');
  });

  it('escapes a leading and a trailing space, which a parser would otherwise strip', () => {
    expect(escapeDnValue(' pad ')).toBe('\\ pad\\ ');
    expect(escapeDnValue('no pad')).toBe('no pad');
  });

  it('escapes NUL as a hex pair', () => {
    expect(escapeDnValue(`a${String.fromCharCode(0)}b`)).toBe('a\\00b');
  });
});

describe('templateReferences', () => {
  it('lists placeholders in order, without duplicates and without modifiers', () => {
    expect(
      templateReferences(
        '%person.givenName.first%.%person.familyName% <%person.givenName%> %baseDn%',
      ),
    ).toEqual(['person.givenName', 'person.familyName', 'baseDn']);
  });

  it('omits malformed placeholders, which name no field', () => {
    expect(templateReferences('%person.given_name%/%contract.department%')).toEqual([
      'contract.department',
    ]);
  });

  it('returns nothing for a template with no placeholders', () => {
    expect(templateReferences('OU=Archive,DC=acme,DC=test')).toEqual([]);
  });
});

describe('resolveReference', () => {
  it('resolves each scope', () => {
    expect(resolveReference(context(), 'person.givenName')).toBe('Anna Maria');
    expect(resolveReference(context(), 'contract.department')).toBe('Finance');
    expect(resolveReference(context(), 'baseDn')).toBe('DC=acme,DC=test');
  });

  it('separates an empty field from an unknown one', () => {
    expect(resolveReference(context(), 'person.personalEmail')).toBeNull();
    expect(resolveReference(context(), 'person.nickname')).toBeUndefined();
    expect(resolveReference(context(), 'person.constructor')).toBeUndefined();
    expect(resolveReference(context(), 'not a reference')).toBeUndefined();
  });
});
