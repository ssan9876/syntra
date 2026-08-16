import { describe, expect, it } from 'vitest';
import {
  SAM_ACCOUNT_NAME_MAX_LENGTH,
  foldToAscii,
  generateCorrelationKey,
} from './names.js';
import type { TemplateContext } from './templates.js';

const context = (givenName: string, familyName: string): TemplateContext => ({
  person: { givenName, familyName },
  contract: { department: 'Finance' },
  baseDn: 'DC=acme,DC=test',
});

const generate = (
  ctx: TemplateContext,
  taken: string[] = [],
  over: { maxAttempts?: number; template?: string; maxLength?: number } = {},
) =>
  generateCorrelationKey({
    template: over.template ?? '%person.givenName.first%.%person.familyName%',
    context: ctx,
    taken: new Set(taken),
    maxLength: over.maxLength ?? SAM_ACCOUNT_NAME_MAX_LENGTH,
    maxAttempts: over.maxAttempts ?? 20,
  });

const key = (result: unknown): string => (result as { correlationKey: string }).correlationKey;

describe('foldToAscii', () => {
  it('folds accents to their base letters', () => {
    expect(foldToAscii('Zoë Müller-Ångström')).toBe('Zoe Muller-Angstrom');
  });

  it('folds the ligatures that decompose to two letters', () => {
    expect(foldToAscii('Æsa Øystein Straße')).toBe('AEsa Oystein Strasse');
  });

  it('drops characters with no ASCII equivalent rather than emitting a question mark', () => {
    expect(foldToAscii('李Anna')).toBe('Anna');
  });

  // --- Additions.

  it('folds the Dutch ij digraph, which canonical decomposition leaves alone', () => {
    // NFD leaves U+0133 intact, so an NFD-based fold turns "IJsbrand" into
    // "sbrand" -- a shorter name that is somebody else's login, produced
    // silently. NFKD is the reason this passes; if the fold ever moves back to
    // NFD this test is the one that says so.
    expect(foldToAscii('Ĳsbrand ĳssel')).toBe('IJsbrand ijssel');
  });

  it('folds a letter carrying both a stroke and an accent', () => {
    // U+01FF decomposes to U+00F8 plus an acute. Folding the ligature table
    // before decomposing would leave the precomposed character untouched and
    // then drop it entirely.
    expect(foldToAscii('ǿ Ǽ')).toBe('o AE');
  });

  it('folds the letters that are not a base letter plus an accent', () => {
    expect(foldToAscii('Cœur Œuvre')).toBe('Coeur OEuvre');
    expect(foldToAscii('Ðurić Đorđe')).toBe('Duric Dorde');
    expect(foldToAscii('Łukasz Þór')).toBe('Lukasz THor');
    expect(foldToAscii('Işık')).toBe('Isik');
  });

  it('folds every letter the table exists for', () => {
    // One case per entry. A name folding to a shorter one is not a visible
    // failure anywhere downstream -- it is a valid login belonging to somebody
    // else -- so each entry needs a case that fails when it is removed.
    const cases: [string, string][] = [
      ['æ', 'ae'],
      ['Æ', 'AE'],
      ['ø', 'o'],
      ['Ø', 'O'],
      ['ß', 'ss'],
      ['ẞ', 'SS'],
      ['đ', 'd'],
      ['Đ', 'D'],
      ['ð', 'd'],
      ['Ð', 'D'],
      ['ł', 'l'],
      ['Ł', 'L'],
      ['þ', 'th'],
      ['Þ', 'TH'],
      ['œ', 'oe'],
      ['Œ', 'OE'],
      ['ħ', 'h'],
      ['Ħ', 'H'],
      ['ŧ', 't'],
      ['Ŧ', 'T'],
      ['ı', 'i'],
      ['ĸ', 'k'],
      ['ə', 'e'],
      ['Ə', 'E'],
    ];
    for (const [from, to] of cases) expect(foldToAscii(from)).toBe(to);
  });

  it('folds a non-breaking space to a real one instead of joining two words', () => {
    // Spreadsheet exports carry these. It is not ASCII, so an implementation
    // that only strips is left with the single token "AnnaMaria" -- which
    // changes what the .first modifier selects.
    const nbsp = String.fromCharCode(0x00a0);
    expect(foldToAscii(`Anna${nbsp}Maria`)).toBe('Anna Maria');
  });

  it('drops control characters rather than emitting them', () => {
    expect(foldToAscii(`a${String.fromCharCode(0, 27)}b`)).toBe('ab');
  });

  it('leaves plain ASCII exactly as it is', () => {
    expect(foldToAscii("Anna-Maria O'Brien 42")).toBe("Anna-Maria O'Brien 42");
  });
});

describe('generateCorrelationKey', () => {
  it('produces a clean lowercased key', () => {
    expect(generate(context('Anna', 'Novak'))).toEqual({
      ok: true,
      correlationKey: 'anna.novak',
    });
  });

  it('strips apostrophes and spaces and folds non-ASCII', () => {
    // sAMAccountName is not a display name. An apostrophe in it breaks
    // downstream systems that never quoted it.
    expect(generate(context('Anna Maria', "O'Brien"))).toEqual({
      ok: true,
      correlationKey: 'anna.obrien',
    });
    expect(generate(context('Zoë', 'Müller'))).toEqual({
      ok: true,
      correlationKey: 'zoe.muller',
    });
  });

  it('appends an incrementing suffix on a collision', () => {
    expect(generate(context('Anna', 'Novak'), ['anna.novak'])).toEqual({
      ok: true,
      correlationKey: 'anna.novak2',
    });
  });

  it('walks a collision chain', () => {
    expect(
      generate(context('Anna', 'Novak'), [
        'anna.novak',
        'anna.novak2',
        'anna.novak3',
      ]),
    ).toEqual({ ok: true, correlationKey: 'anna.novak4' });
  });

  it('truncates from the right to stay within 20 characters', () => {
    const result = generate(context('Bartholomew', 'Vandenberghe-Smit'));
    expect(result).toEqual({
      ok: true,
      correlationKey: 'bartholomew.vandenbe',
    });
    expect(key(result)).toHaveLength(20);
  });

  it('preserves the suffix when truncating, cutting the base instead', () => {
    // The suffix is what makes the name unique. Truncating it away produces a
    // name that collides with the one it was invented to avoid.
    const result = generate(context('Bartholomew', 'Vandenberghe-Smit'), [
      'bartholomew.vandenbe',
    ]);
    expect(result).toEqual({ ok: true, correlationKey: 'bartholomew.vandenb2' });
    expect(key(result)).toHaveLength(20);
  });

  it('preserves a multi-digit suffix when truncating', () => {
    // Attempts 1..9 are taken: the base truncated to 20, then the base
    // truncated to 19 with a single digit. Attempt 10 has a two-character
    // suffix, so the base is cut to 18 and the result is
    // "bartholomew.vanden" + "10" -- a different string from
    // "bartholomew.vandenb1", which is what naive truncation would produce and
    // what would collide with attempt 1's neighbourhood.
    const taken = ['bartholomew.vandenbe'];
    for (let n = 2; n <= 9; n += 1) taken.push(`bartholomew.vandenb${n}`);
    const result = generate(context('Bartholomew', 'Vandenberghe-Smit'), taken);
    expect(result).toEqual({ ok: true, correlationKey: 'bartholomew.vanden10' });
    expect(key(result)).toHaveLength(20);
  });

  it('refuses when the template cannot resolve, naming the field', () => {
    expect(generate(context('Anna', ''))).toEqual({
      ok: false,
      reason: 'template_unresolvable',
      missing: ['person.familyName'],
    });
  });

  it('refuses when a name of only non-ASCII characters folds away to nothing', () => {
    // Folding "李" to "" would otherwise produce the key ".", or "", and a
    // login of "" is a login somebody else effectively owns.
    expect(generate(context('李', '王'))).toEqual({
      ok: false,
      reason: 'template_unresolvable',
      missing: ['person.givenName', 'person.familyName'],
    });
  });

  it('gives up at the attempt limit rather than picking something arbitrary', () => {
    const taken = ['anna.novak'];
    for (let n = 2; n <= 5; n += 1) taken.push(`anna.novak${n}`);
    expect(generate(context('Anna', 'Novak'), taken, { maxAttempts: 5 })).toEqual({
      ok: false,
      reason: 'exhausted',
      attempts: 5,
    });
  });

  it('never returns a key longer than the cap', () => {
    const result = generate(context('Maximiliana', 'Featherstonehaugh'));
    expect(key(result).length).toBeLessThanOrEqual(SAM_ACCOUNT_NAME_MAX_LENGTH);
  });

  // --- Additions.

  describe('the taken set is the target’s answer, not a Syntra-shaped one', () => {
    it('treats a differently-cased reserved key as taken', () => {
      // sAMAccountName is case-insensitive in Active Directory, and the
      // inventory half of `taken` comes back in whatever case the directory
      // stores. A case-sensitive `has` hands out "anna.novak" while
      // "Anna.Novak" exists, and the write fails at the target with
      // entryAlreadyExists after the row has already been reserved here.
      expect(generate(context('Anna', 'Novak'), ['Anna.Novak'])).toEqual({
        ok: true,
        correlationKey: 'anna.novak2',
      });
      expect(generate(context('Anna', 'Novak'), ['ANNA.NOVAK', 'anna.novak2'])).toEqual({
        ok: true,
        correlationKey: 'anna.novak3',
      });
    });

    it('treats a padded reserved key as taken', () => {
      expect(generate(context('Anna', 'Novak'), [' anna.novak '])).toEqual({
        ok: true,
        correlationKey: 'anna.novak2',
      });
    });

    it('hands out the base when nothing is reserved', () => {
      // The mirror of the two above: they must fail when the normalisation is
      // removed, not pass because everything is treated as taken.
      expect(generate(context('Anna', 'Novak'), ['anna.novakova'])).toEqual({
        ok: true,
        correlationKey: 'anna.novak',
      });
    });
  });

  describe('the key is always a legal sAMAccountName', () => {
    it('does not end in a separator when the truncation lands on one', () => {
      // "alexandrapetronella" is 19 characters, so the 20th character of the
      // base is the dot and a plain slice yields "alexandrapetronella.".
      // Active Directory refuses a sAMAccountName ending in a period outright:
      // the account is never created, and the run reports a directory error
      // instead of a name it could have fixed here.
      const result = generate(context('Alexandrapetronella', 'Vandenberg'), [], {
        template: '%person.givenName%.%person.familyName%',
      });
      expect(result).toEqual({ ok: true, correlationKey: 'alexandrapetronella' });
      expect(key(result).endsWith('.')).toBe(false);
    });

    it('does not end in a hyphen when the truncation lands on one', () => {
      const result = generate(context('Alexandrapetronella', 'Vandenberg'), [], {
        template: '%person.givenName%-%person.familyName%',
      });
      expect(result).toEqual({ ok: true, correlationKey: 'alexandrapetronella' });
    });

    it('strips leading and trailing separators from the base', () => {
      expect(generate(context('.Anna', 'Novak.'))).toEqual({
        ok: true,
        correlationKey: 'anna.novak',
      });
    });

    it('contains only the characters a login may contain', () => {
      const result = generate(context('Ånn a', "O'Br/ien\\Smit"));
      expect(key(result)).toBe('ann.obriensmit');
      expect(key(result)).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    });
  });

  describe('the empty and the degenerate case', () => {
    it('refuses a whitespace-only name', () => {
      expect(generate(context('Anna', '   '))).toEqual({
        ok: false,
        reason: 'template_unresolvable',
        missing: ['person.familyName'],
      });
    });

    it('refuses a name made only of punctuation the sanitiser strips', () => {
      // renderTemplate is happy: "!!!" is not empty. The sanitiser then takes
      // every character of it away, and what is left is the separator the
      // template put between them.
      expect(generate(context('!!!', '???'))).toEqual({
        ok: false,
        reason: 'template_unresolvable',
        missing: ['person.givenName', 'person.familyName'],
      });
    });

    it('names the contract field a contract-only template folded away', () => {
      // Deriving the missing list from `context.person` reports the wrong
      // fields here, or none at all, and the exception a human reads points at
      // a record with nothing wrong with it.
      // `personalEmail` is empty and no template mentions it. A scan of
      // `context.person` reports that field and stays silent about the one
      // that actually produced the empty key, so the exception a human reads
      // points at a record with nothing wrong with it.
      const ctx: TemplateContext = {
        person: { givenName: 'Anna', familyName: 'Novak', personalEmail: null },
        contract: { department: 'финансы' },
        baseDn: 'DC=acme,DC=test',
      };
      expect(generate(ctx, [], { template: '%contract.department%' })).toEqual({
        ok: false,
        reason: 'template_unresolvable',
        missing: ['contract.department'],
      });
    });

    it('names every referenced field when a modifier is what folded away', () => {
      // "李Anna" sanitises to "anna", so no single field is empty -- but
      // `.initial` selected the one character that is not ASCII.
      expect(
        generate(context('李Anna', 'Novak'), [], {
          template: '%person.givenName.initial%',
        }),
      ).toEqual({
        ok: false,
        reason: 'template_unresolvable',
        missing: ['person.givenName'],
      });
    });

    it('refuses a constant template that sanitises to nothing', () => {
      expect(generate(context('Anna', 'Novak'), [], { template: '---' })).toEqual({
        ok: false,
        reason: 'template_unresolvable',
        missing: ['template'],
      });
    });

    it('reports a malformed template as unresolvable rather than inventing a login', () => {
      expect(
        generate(context('Anna', 'Novak'), [], { template: '%person.given_name%' }),
      ).toEqual({
        ok: false,
        reason: 'template_unresolvable',
        missing: ['%person.given_name%'],
      });
    });

    it('never yields an empty key, whatever the cap', () => {
      // maxLength 1 leaves room for the base only on the first attempt; every
      // suffixed attempt would be over the cap.
      expect(generate(context('Anna', 'Novak'), [], { maxLength: 1 })).toEqual({
        ok: true,
        correlationKey: 'a',
      });
      expect(generate(context('Anna', 'Novak'), ['a'], { maxLength: 1 })).toEqual({
        ok: false,
        reason: 'exhausted',
        attempts: 1,
      });
    });

    it('honours the cap when the suffix eats into it', () => {
      const taken = ['ann', 'an2', 'an3'];
      const result = generate(context('Anna', 'Novak'), taken, { maxLength: 3 });
      expect(result).toEqual({ ok: true, correlationKey: 'an4' });
      expect(key(result).length).toBeLessThanOrEqual(3);
    });

    it('refuses an attempt budget of zero rather than returning a key nobody checked', () => {
      expect(generate(context('Anna', 'Novak'), [], { maxAttempts: 0 })).toEqual({
        ok: false,
        reason: 'exhausted',
        attempts: 0,
      });
    });

    it('throws on a cap that is not a positive integer', () => {
      // `maxLength: 0` returns the empty login and a negative one makes
      // `slice(0, room)` count backwards from the end, returning a key longer
      // than the cap. Neither is a value any data path can supply, so it is a
      // programming error and it says so loudly.
      for (const maxLength of [0, -1, 1.5, Number.NaN]) {
        expect(() => generate(context('Anna', 'Novak'), [], { maxLength })).toThrow(
          RangeError,
        );
      }
    });
  });
});
