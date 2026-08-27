import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanguagePicker, LocaleProvider, preferredLocale, useT } from './LocaleProvider.js';
import { CATALOGS, en, type MessageKey } from './catalog.js';

function Show() {
  const t = useT();
  return <p>{t('login.submit')}</p>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preferredLocale', () => {
  it('matches on the language, not the region', () => {
    // Region-exact matching leaves a Flemish speaker reading English because
    // nobody wrote a Belgian catalogue — a worse answer than the one that is
    // 95% right.
    expect(preferredLocale(['nl-BE'])).toBe('nl');
    expect(preferredLocale(['de-AT', 'en'])).toBe('de');
  });

  it('takes the first language it has, in the order the browser gave', () => {
    expect(preferredLocale(['fr-FR', 'de-DE', 'nl-NL'])).toBe('de');
  });

  it('falls back to English rather than to nothing', () => {
    expect(preferredLocale(['fr', 'es'])).toBe('en');
    expect(preferredLocale([])).toBe('en');
  });
});

describe('LocaleProvider', () => {
  it('renders in the chosen language', () => {
    render(
      <LocaleProvider initial="nl">
        <Show />
      </LocaleProvider>,
    );
    expect(screen.getByText('Aanmelden')).toBeInTheDocument();
  });

  it('remembers a choice across a reload', async () => {
    const { unmount } = render(
      <LocaleProvider initial="en">
        <LanguagePicker />
        <Show />
      </LocaleProvider>,
    );
    await userEvent.selectOptions(screen.getByLabelText(/language/i), 'de');
    expect(screen.getByText('Anmelden')).toBeInTheDocument();
    unmount();

    // No `initial` this time: the same thing a reload does.
    render(
      <LocaleProvider>
        <Show />
      </LocaleProvider>,
    );
    expect(screen.getByText('Anmelden')).toBeInTheDocument();
  });

  it('renders in English rather than blank outside a provider', () => {
    // Every one of these screens has to render. A component used outside the
    // provider — in a test, or in a tree somebody reorganised — should be in
    // English, not missing.
    render(<Show />);
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('survives storage being switched off', () => {
    // A private window, or a browser set to block site data. A sign-in page
    // must not fail over a remembered convenience.
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    });
    render(
      <LocaleProvider initial="nl">
        <Show />
      </LocaleProvider>,
    );
    expect(screen.getByText('Aanmelden')).toBeInTheDocument();
  });
});

describe('the catalogues', () => {
  /**
   * Not a completeness check — `Catalog` is deliberately partial, so that
   * adding an English string does not break the build for every language at
   * once and get filled in with English text pretending to be translated.
   *
   * What IS checked is that no translation names a key English does not have,
   * which is the shape a rename leaves behind: the old key sits in three
   * files, translated, and never renders again.
   */
  it('has no translation for a key that no longer exists', () => {
    const known = new Set(Object.keys(en));
    for (const [code, catalog] of Object.entries(CATALOGS)) {
      for (const key of Object.keys(catalog)) {
        expect(`${code}:${key}`).toBe(known.has(key) ? `${code}:${key}` : `${code}:UNKNOWN`);
      }
    }
  });

  it('falls back to English for a key a language is missing', () => {
    const t = (key: MessageKey) => CATALOGS.nl[key] ?? en[key];
    expect(t('login.submit')).toBe('Aanmelden');
    // A key deliberately absent from the Dutch catalogue would come back in
    // English rather than as `login.submit`, which is a screen nobody can use.
    expect(t('login.submit')).not.toBe('login.submit');
  });

  it('names each language in itself', async () => {
    // A picker that lists "Dutch" in English is a picker the reader who needs
    // it cannot read.
    render(
      <LocaleProvider initial="en">
        <LanguagePicker />
      </LocaleProvider>,
    );
    expect(screen.getByRole('option', { name: 'Nederlands' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Deutsch' })).toBeInTheDocument();
  });
});
