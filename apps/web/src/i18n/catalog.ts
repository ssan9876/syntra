/**
 * The languages Syntra speaks, and where each string lives.
 *
 * **Scope.** Everything a person reads in the browser is translated: the
 * sign-in screens, the portal, and the administrative console. The console is
 * converted page by page; a page not yet converted is still English, and
 * `i18n/converted.test.ts` lists the files that are done.
 *
 * **Two kinds of catalog, split by who loads them.**
 *
 * - `base/` is what the sign-in page and the portal render: every language,
 *   in the entry chunk, so the first paint is already in the reader's
 *   language. It stays small.
 * - `console/` is what only the console renders. English ships in the
 *   console chunk; each translation is its own chunk, fetched when a console
 *   route first renders in that language. The sign-in page never downloads a
 *   console string.
 *
 * No library. The requirement is a lookup, `{name}` placeholders and plural
 * forms from `Intl.PluralRules`; `react-intl` is 40 KB on the one page that
 * must load on a bad connection, and ICU message syntax buys nothing where
 * nothing needs a gendered ordinal.
 */
import { en, type Catalog, type MessageKey } from './base/en.js';
import { nl } from './base/nl.js';
import { de } from './base/de.js';
import { fr } from './base/fr.js';
import { es } from './base/es.js';
import { pt } from './base/pt.js';

export { en, nl, de, fr, es, pt, type Catalog, type MessageKey };

export const CATALOGS = { en, nl, de, fr, es, pt } as const;

export type Locale = keyof typeof CATALOGS;

export const LOCALES: { code: Locale; name: string }[] = [
  // Each language named IN ITSELF. A picker that lists "Dutch" in English is a
  // picker the reader who needs it cannot read.
  { code: 'en', name: 'English' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
];

export const isLocale = (value: string): value is Locale =>
  Object.prototype.hasOwnProperty.call(CATALOGS, value);
