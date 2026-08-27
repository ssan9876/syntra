import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CATALOGS, LOCALES, en, isLocale, type Locale, type MessageKey } from './catalog.js';

/**
 * Which language the screens before sign-in are in.
 *
 * Chosen from the browser, overridable by the reader, and remembered. Nothing
 * asks: a language picker presented as a question on first load is a question
 * most people answer wrong for themselves, because the answer is already in
 * their browser settings and they have not thought about it since.
 */

const STORAGE_KEY = 'syntra.locale';

interface LocaleValue {
  locale: Locale;
  setLocale(next: Locale): void;
  /**
   * A message, with `{name}`-style placeholders filled in.
   *
   * Placeholders rather than string concatenation at the call site, because
   * word order is exactly what a translation changes: "Good day, Jo" and
   * "Guten Tag, Jo" happen to agree, and plenty of other sentences do not.
   * A caller that built the sentence from parts would have pinned English
   * grammar into every language.
   */
  t(key: MessageKey, vars?: Record<string, string | number>): string;
}

/**
 * Fills `{name}` from `vars`.
 *
 * A placeholder with nothing to fill it is left ALONE rather than blanked. A
 * sentence reading "Good day, {name}" is visibly broken and gets reported; one
 * reading "Good day," looks deliberate and never does.
 */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

const LocaleContext = createContext<LocaleValue | null>(null);

/**
 * The best match for what the browser asked for.
 *
 * Language-only, so `nl-BE` gets Dutch and `de-AT` gets German. Region-exact
 * matching would leave a Flemish speaker reading English because nobody wrote
 * a Belgian catalogue, which is a worse answer than the one that is 95% right.
 *
 * `navigator.languages` in order, then `navigator.language`. Anything not
 * translated falls through to English, which is the source language rather
 * than a fourth translation.
 */
export function preferredLocale(
  languages: readonly string[] = typeof navigator === 'undefined'
    ? []
    : (navigator.languages ?? [navigator.language]),
): Locale {
  for (const tag of languages) {
    const base = tag.split('-')[0]?.toLowerCase() ?? '';
    if (isLocale(base)) return base;
  }
  return 'en';
}

function stored(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value !== null && isLocale(value) ? value : null;
  } catch {
    // A private window, or storage switched off. The browser's own preference
    // is still a good answer, and a sign-in page must not fail over a
    // remembered convenience.
    return null;
  }
}

export function LocaleProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** For tests, and for a server-rendered page that already decided. */
  initial?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => initial ?? stored() ?? preferredLocale(),
  );

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // As above. The choice still applies to this visit.
    }
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<LocaleValue>(() => {
    const catalog = CATALOGS[locale];
    return {
      locale,
      setLocale,
      // English when a key is missing, never the key itself. A screen reading
      // `login.submit` is a screen nobody can use, and an untranslated string
      // is a gap in a catalogue rather than a reason to break a sign-in.
      t: (key, vars) => interpolate(catalog[key] ?? en[key], vars),
    };
  }, [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  if (value === null) {
    // A default rather than a throw. Every one of these screens has to render;
    // a component used outside the provider — in a test, or in a tree somebody
    // reorganised — should be in English, not blank.
    return {
      locale: 'en',
      setLocale: () => {},
      t: (key, vars) => interpolate(en[key], vars),
    };
  }
  return value;
}

/** Shorthand, because the alternative is `useLocale().t` in every component. */
export const useT = () => useLocale().t;

/**
 * The picker.
 *
 * A plain select naming each language in itself. Not flags — a flag is a
 * country and a language is not, and every product that has tried it has had
 * the argument about which flag means Spanish.
 */
export function LanguagePicker({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-muted ${className}`}>
      <span>{t('common.language')}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-8 rounded-control border border-border-control bg-bg px-2 text-ink"
      >
        {LOCALES.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
