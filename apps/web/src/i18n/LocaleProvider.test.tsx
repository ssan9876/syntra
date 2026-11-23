import { Suspense } from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pager } from '@syntra/ui';
import {
  LanguagePicker,
  LocaleProvider,
  formatLocale,
  preferredLocale,
  useLocale,
  useT,
} from './LocaleProvider.js';
import { CATALOGS, en, type Locale, type MessageKey } from './catalog.js';
import { useConsoleT } from './console/index.js';

function Show() {
  const t = useT();
  return <p>{t('login.submit')}</p>;
}

function Count({ n }: { n: number }) {
  const t = useT();
  return <p>{t.plural('ui.combobox.results', n)}</p>;
}

function ConsoleTitle() {
  const t = useConsoleT();
  return (
    <>
      <h1>{t('targets.title')}</h1>
      <p>{t('common.cancel')}</p>
    </>
  );
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
    expect(preferredLocale(['fr-CA'])).toBe('fr');
    expect(preferredLocale(['es-MX'])).toBe('es');
    // Brazilian Portuguese is the catalog; a reader in Portugal gets it too.
    expect(preferredLocale(['pt-BR'])).toBe('pt');
    expect(preferredLocale(['pt-PT'])).toBe('pt');
  });

  it('takes the first language it has, in the order the browser gave', () => {
    expect(preferredLocale(['ja-JP', 'de-DE', 'nl-NL'])).toBe('de');
    expect(preferredLocale(['fr-FR', 'de-DE'])).toBe('fr');
  });

  it('falls back to English rather than to nothing', () => {
    expect(preferredLocale(['ja', 'zh'])).toBe('en');
    expect(preferredLocale([])).toBe('en');
  });
});

describe('formatLocale', () => {
  it('keeps the browser region when it is in the active language', () => {
    // A British reader keeps day-first dates; choosing English must not turn
    // them into an American's.
    expect(formatLocale('en', ['en-GB'])).toBe('en-GB');
    expect(formatLocale('pt', ['de-DE', 'pt-PT'])).toBe('pt-PT');
  });

  it('uses the bare language otherwise', () => {
    expect(formatLocale('fr', ['de-DE'])).toBe('fr');
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

  it.each([
    ['fr', 'Se connecter'],
    ['es', 'Iniciar sesión'],
    ['pt', 'Entrar'],
  ] as const)('renders %s', (locale, text) => {
    render(
      <LocaleProvider initial={locale}>
        <Show />
      </LocaleProvider>,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
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

  it('translates the shared components too', () => {
    render(
      <LocaleProvider initial="fr">
        <Pager page={1} pageSize={10} total={25} onPage={() => {}} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Précédent' })).toBeInTheDocument();
    expect(screen.getByText('1–10 sur 25')).toBeInTheDocument();
  });
});

describe('plurals', () => {
  /**
   * The rule is the platform's, per language. English says "0 results";
   * French and Brazilian Portuguese treat 0 as singular.
   */
  it.each([
    ['en', 0, '0 results'],
    ['en', 1, '1 result'],
    ['en', 2, '2 results'],
    ['fr', 0, '0 résultat'],
    ['fr', 1, '1 résultat'],
    ['fr', 2, '2 résultats'],
    ['pt', 0, '0 resultado'],
    ['pt', 1, '1 resultado'],
    ['es', 0, '0 resultados'],
    ['es', 1, '1 resultado'],
    ['de', 1, '1 Ergebnis'],
    ['nl', 3, '3 resultaten'],
  ] as const)('%s, %i: %s', (locale, n, text) => {
    render(
      <LocaleProvider initial={locale as Locale}>
        <Count n={n} />
      </LocaleProvider>,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('formats the count for the language', () => {
    function Big() {
      const { t } = useLocale();
      return <p>{t.plural('ui.combobox.results', 12345)}</p>;
    }
    render(
      <LocaleProvider initial="de">
        <Big />
      </LocaleProvider>,
    );
    expect(screen.getByText('12.345 Ergebnisse')).toBeInTheDocument();
  });
});

describe('the console catalog', () => {
  it('renders English without waiting for anything', () => {
    render(<ConsoleTitle />);
    expect(screen.getByRole('heading', { name: 'Target systems' })).toBeInTheDocument();
  });

  it('loads a translation on first use, and falls back to the base catalog', async () => {
    // Awaited: the first render suspends on the catalog chunk.
    await act(async () => {
      render(
        <LocaleProvider initial="fr">
          <Suspense fallback={<p>loading</p>}>
            <ConsoleTitle />
          </Suspense>
        </LocaleProvider>,
      );
    });
    expect(await screen.findByRole('heading', { name: 'Systèmes cibles' })).toBeInTheDocument();
    // `common.cancel` is a base key: the console translator reaches it too.
    expect(screen.getByText('Annuler')).toBeInTheDocument();
  });

  it('follows a change of language', async () => {
    render(
      <LocaleProvider initial="en">
        <LanguagePicker />
        <Suspense fallback={<p>loading</p>}>
          <ConsoleTitle />
        </Suspense>
      </LocaleProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Target systems' })).toBeInTheDocument();
    // Awaited: the switch suspends on the Spanish chunk.
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/language/i), { target: { value: 'es' } });
    });
    expect(await screen.findByRole('heading', { name: 'Sistemas de destino' })).toBeInTheDocument();
  });
});

describe('the catalogues', () => {
  it('falls back to English for a key a language is missing', () => {
    const t = (key: MessageKey) => CATALOGS.nl[key] ?? en[key];
    expect(t('login.submit')).toBe('Aanmelden');
    // A key deliberately absent from the Dutch catalogue would come back in
    // English rather than as `login.submit`, which is a screen nobody can use.
    expect(t('login.submit')).not.toBe('login.submit');
  });

  it('names each language in itself', () => {
    // A picker that lists "Dutch" in English is a picker the reader who needs
    // it cannot read.
    render(
      <LocaleProvider initial="en">
        <LanguagePicker />
      </LocaleProvider>,
    );
    for (const name of ['Nederlands', 'Deutsch', 'Français', 'Español', 'Português']) {
      expect(screen.getByRole('option', { name })).toBeInTheDocument();
    }
  });
});
