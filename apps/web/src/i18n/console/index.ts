import { use } from 'react';
import { createTranslate, type Format, type Translate } from '@syntra/ui';
import { CATALOGS, en, type Locale, type MessageKey } from '../catalog.js';
import { useLocale } from '../LocaleProvider.js';
import { consoleEn, type ConsoleCatalog, type ConsoleKey } from './en.js';

export { consoleEn, type ConsoleCatalog, type ConsoleKey };

/**
 * One chunk per language. Vite splits each `import()` into its own file, so a
 * French administrator downloads the French console strings and no others.
 */
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<{ catalog: ConsoleCatalog }>> = {
  nl: () => import('./nl.js'),
  de: () => import('./de.js'),
  fr: () => import('./fr.js'),
  es: () => import('./es.js'),
  pt: () => import('./pt.js'),
};

/**
 * A promise React's `use` can read without suspending once it has settled:
 * `status` and `value` are the fields React itself sets on a thenable it has
 * seen, set here as well so a catalog that is already in memory never costs a
 * render.
 */
type Tracked = Promise<ConsoleCatalog>;

function settled(catalog: ConsoleCatalog): Tracked {
  return Object.assign(Promise.resolve(catalog), { status: 'fulfilled' as const, value: catalog });
}

const promises = new Map<Locale, Tracked>([['en', settled({})]]);

/**
 * The console catalog for `locale`, fetched once per page load.
 *
 * A chunk that fails to arrive resolves to an empty catalog, which renders
 * the console in English for this visit. A console that cannot fetch its
 * French strings is still a console; one that throws is not.
 */
export function loadConsoleCatalog(locale: Locale): Tracked {
  let promise = promises.get(locale);
  if (!promise) {
    const loading: Tracked = LOADERS[locale as Exclude<Locale, 'en'>]()
      .then((module) => module.catalog)
      .catch((): ConsoleCatalog => ({}))
      .then((catalog) => {
        void Object.assign(loading, { status: 'fulfilled', value: catalog });
        return catalog;
      });
    promise = loading;
    promises.set(locale, promise);
  }
  return promise;
}

/** Console keys and base keys: a console page also says "Cancel". */
export type ConsoleT = Translate<ConsoleKey | MessageKey>;

/** One translator per provider value and catalog, so its identity is stable. */
const translators = new WeakMap<Format, WeakMap<ConsoleCatalog, ConsoleT>>();

function translator(locale: Locale, format: Format, catalog: ConsoleCatalog): ConsoleT {
  let byCatalog = translators.get(format);
  if (!byCatalog) translators.set(format, (byCatalog = new WeakMap()));
  let t = byCatalog.get(catalog);
  if (!t) {
    const base = CATALOGS[locale];
    t = createTranslate<ConsoleKey | MessageKey>(
      locale,
      (key) =>
        catalog[key as ConsoleKey] ??
        consoleEn[key as ConsoleKey] ??
        base[key as MessageKey] ??
        en[key as MessageKey],
      format,
    );
    byCatalog.set(catalog, t);
  }
  return t;
}

/**
 * The console's translator.
 *
 * Suspends, through `use`, the first time a console component renders in a
 * language whose catalog has not arrived; the console's `Suspense` boundary
 * shows its loading state meanwhile, and a language switch is a transition, so
 * a page already on screen stays there until the new strings are in. English
 * never suspends.
 */
export function useConsoleT(): ConsoleT {
  const { locale, format } = useLocale();
  return translator(locale, format, use(loadConsoleCatalog(locale)));
}
