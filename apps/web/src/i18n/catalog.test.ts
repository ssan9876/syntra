import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, en } from './catalog.js';
import { consoleEn } from './console/en.js';
import { catalog as nl } from './console/nl.js';
import { catalog as de } from './console/de.js';
import { catalog as fr } from './console/fr.js';
import { catalog as es } from './console/es.js';
import { catalog as pt } from './console/pt.js';

/**
 * The catalogs agree with English.
 *
 * Not a completeness check: a translation is deliberately partial, so that
 * adding an English string does not break the build for every language at
 * once and get filled in with English text pretending to be translated.
 *
 * What IS checked is what a translator or a rename gets wrong without anybody
 * noticing: a key English no longer has (the old key sits in five files,
 * translated, and never renders again), and a placeholder that was dropped or
 * misspelt (`{nmae}` renders literally, and a dropped `{count}` makes a
 * sentence that is wrong for every number but one).
 */

const CONSOLE = { nl, de, fr, es, pt };

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function problems(source: Record<string, string>, translations: Record<string, Record<string, string | undefined>>) {
  const found: string[] = [];
  for (const [code, catalog] of Object.entries(translations)) {
    for (const [key, text] of Object.entries(catalog)) {
      const english = source[key];
      if (english === undefined) {
        found.push(`${code}: ${key} is not an English key`);
        continue;
      }
      if (text === undefined) continue;
      if (placeholders(text).join() !== placeholders(english).join()) {
        found.push(`${code}: ${key} has {${placeholders(text).join('}, {')}}, English has {${placeholders(english).join('}, {')}}`);
      }
      if (text.trim() === '') found.push(`${code}: ${key} is empty`);
    }
  }
  return found;
}

describe('the base catalogs', () => {
  it('name no key English does not have, and keep its placeholders', () => {
    const translations = Object.fromEntries(
      Object.entries(CATALOGS).filter(([code]) => code !== 'en'),
    );
    expect(problems(en, translations)).toEqual([]);
  });
});

describe('the console catalogs', () => {
  it('name no key English does not have, and keep its placeholders', () => {
    expect(problems(consoleEn, CONSOLE)).toEqual([]);
  });

  it('exist for every language the picker offers', () => {
    const offered = LOCALES.map((l) => l.code).filter((code) => code !== 'en');
    expect(Object.keys(CONSOLE).sort()).toEqual([...offered].sort());
  });

  it('share no key with the base catalog', () => {
    // A console lookup tries the console catalog first, so a key in both
    // would silently shadow the base string on console pages only.
    const shared = Object.keys(consoleEn).filter((key) => key in en);
    expect(shared).toEqual([]);
  });
});

describe('plural keys', () => {
  it('always have an `_other` form in English', () => {
    // `t.plural` falls back to `_other` for any category a language has and
    // English does not, so `_other` is the one form that must exist.
    const keys = [...Object.keys(en), ...Object.keys(consoleEn)];
    const bases = new Set(
      keys.filter((k) => /_(zero|one|two|few|many)$/.test(k)).map((k) => k.replace(/_[a-z]+$/, '')),
    );
    const missing = [...bases].filter((base) => !keys.includes(`${base}_other`));
    expect(missing).toEqual([]);
  });
});

describe('security wording', () => {
  it('never promises a reset link was sent', () => {
    // The server answers the same whether or not the account exists. Every
    // language keeps the condition: "if", "als", "falls", "si", "se".
    const conditional = { nl: /^Als /, de: /^Falls /, fr: /^Si /, es: /^Si /, pt: /^Se / };
    for (const [code, pattern] of Object.entries(conditional)) {
      const catalog = CATALOGS[code as keyof typeof conditional];
      expect(catalog['forgot.sent'], code).toMatch(pattern);
      expect(catalog['mfa.email_sent'], code).toMatch(pattern);
    }
  });
});
