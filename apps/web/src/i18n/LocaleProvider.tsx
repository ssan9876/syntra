import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  UiLocaleProvider,
  createFormat,
  createTranslate,
  type Format,
  type Translate,
} from '@syntra/ui';
import { CATALOGS, LOCALES, en, isLocale, type Locale, type MessageKey } from './catalog.js';

/**
 * Which language the screens are in.
 *
 * Chosen from the browser, overridable by the reader, and remembered. Nothing
 * asks: a language picker presented as a question on first load is a question
 * most people answer wrong for themselves, because the answer is already in
 * their browser settings and they have not thought about it since.
 */

const STORAGE_KEY = 'syntra.locale';

export interface LocaleValue {
  locale: Locale;
  setLocale(next: Locale): void;
  /**
   * A message, with `{name}`-style placeholders filled in; `t.plural` picks
   * the plural form for a count.
   *
   * Placeholders rather than string concatenation at the call site, because
   * word order is exactly what a translation changes: "Good day, Jo" and
   * "Guten Tag, Jo" happen to agree, and plenty of other sentences do not.
   * A caller that built the sentence from parts would have pinned English
   * grammar into every language.
   */
  t: Translate<MessageKey>;
  /** Numbers and dates in the reader's language, and region where known. */
  format: Format;
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
 * than one more translation.
 */
export function preferredLocale(languages: readonly string[] = browserLanguages()): Locale {
  for (const tag of languages) {
    const base = baseLanguage(tag);
    if (isLocale(base)) return base;
  }
  return 'en';
}

/**
 * The tag to format dates and numbers with: the browser's own tag when it is
 * in the active language, so `en-GB` keeps day-first dates and `pt-PT` keeps
 * its own, and the bare language otherwise.
 */
export function formatLocale(
  locale: Locale,
  languages: readonly string[] = browserLanguages(),
): string {
  return languages.find((tag) => baseLanguage(tag) === locale) ?? locale;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages ?? [navigator.language];
}

function baseLanguage(tag: string): string {
  return tag.split('-')[0]?.toLowerCase() ?? '';
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

/** A translator over the base catalog for `locale`, falling back to English. */
export function baseValue(locale: Locale): Pick<LocaleValue, 't' | 'format'> {
  const catalog = CATALOGS[locale];
  const format = createFormat(formatLocale(locale));
  return {
    format,
    // English when a key is missing, never the key itself. A screen reading
    // `login.submit` is a screen nobody can use, and an untranslated string
    // is a gap in a catalogue rather than a reason to break a sign-in.
    t: createTranslate<MessageKey>(
      locale,
      (key) => catalog[key as MessageKey] ?? en[key as MessageKey],
      format,
    ),
  };
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
    // A transition, so a console page waiting for its catalog in the new
    // language keeps showing the old one rather than a loading screen.
    startTransition(() => setLocaleState(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // As above. The choice still applies to this visit.
    }
  }, []);

  // On the first render too, not only on a change: a screen reader picks its
  // voice from `lang`, and French typography depends on it.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleValue>(
    () => ({ locale, setLocale, ...baseValue(locale) }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <UiLocaleProvider value={value}>{children}</UiLocaleProvider>
    </LocaleContext.Provider>
  );
}

const fallback: LocaleValue = { locale: 'en', setLocale: () => {}, ...baseValue('en') };

export function useLocale(): LocaleValue {
  // A default rather than a throw. Every one of these screens has to render;
  // a component used outside the provider — in a test, or in a tree somebody
  // reorganised — should be in English, not blank.
  return useContext(LocaleContext) ?? fallback;
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
    // The caller's display class must win over the default: under Tailwind 4
    // `hidden` and `inline-flex` both set `display`, and whichever the
    // stylesheet emits later wins regardless of the order written here, so a
    // header that asked for `hidden sm:inline-flex` was still rendered at 320
    // pixels and pushed the whole header row off the right edge.
    <label className={`${/(^|\s)(hidden|flex|inline-flex|block)(\s|$)/.test(className) ? '' : 'inline-flex'} items-center gap-2 text-sm text-muted ${className}`}>
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="h-8 rounded-control border border-border-control bg-bg px-2 text-ink"
      >
        {LOCALES.map((option) => (
          <option key={option.code} value={option.code} lang={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
