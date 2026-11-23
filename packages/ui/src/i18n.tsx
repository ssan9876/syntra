import { createContext, useContext, type ReactNode } from 'react';

/**
 * The strings this package renders itself, in English, and the small runtime
 * every catalog in the app uses.
 *
 * The package ships English only. An app translates these keys in its own
 * catalogs and hands a translator down through `UiLocaleProvider`; without a
 * provider every component renders in English, so a component test or a tree
 * rendered out of context never shows a bare key.
 */
export const uiMessages = {
  'ui.combobox.searching': 'Searching…',
  'ui.combobox.failed': 'Search failed. Keep typing to try again.',
  'ui.combobox.no_matches': 'No matches',
  'ui.combobox.results_one': '{count} result',
  'ui.combobox.results_other': '{count} results',
  'ui.combobox.clear': 'Clear {label}',
  'ui.combobox.prompt': 'Type to search',
  'ui.filters.active': 'Active filters',
  'ui.filters.remove': 'Remove filter {label}',
  'ui.filters.reset': 'Reset filters',
  'ui.form.fix_before_saving': 'Fix these before saving',
  'ui.time.just_now': 'just now',
  'ui.time.minutes_ago': '{count} min ago',
  'ui.time.hours_ago': '{count} h ago',
  'ui.refresh.updated': 'Updated {time}',
  'ui.refresh.refresh': 'Refresh',
  'ui.copy.copied': 'Copied',
  'ui.copy.copy': 'Copy {value}',
  'ui.list.status': 'Status',
  'ui.meter.label': '{percent}% {label}',
  'ui.pager.label': 'Pages',
  'ui.pager.no_results': 'No results',
  'ui.pager.range': '{first}–{last} of {total}',
  'ui.pager.previous': 'Previous',
  'ui.pager.next': 'Next',
  'ui.selection.label': 'Bulk actions',
  'ui.selection.none': 'Nothing selected',
  'ui.selection.count_one': '{count} selected',
  'ui.selection.count_other': '{count} selected',
  'ui.selection.clear': 'Clear selection',
  'ui.state.healthy': 'Healthy',
  'ui.state.attention': 'Needs attention',
  'ui.state.blocked': 'Blocked',
  'ui.state.pending': 'Pending verification',
  'ui.state.running': 'In progress',
  'ui.state.setup': 'Needs setup',
  'ui.state.inactive': 'Inactive',
  'ui.table.label': 'Table',
  'ui.table.density': 'Row density',
  'ui.table.comfortable': 'Comfortable',
  'ui.table.compact': 'Compact',
  'ui.table.columns': 'Columns',
  'ui.table.visible_columns': 'Visible columns',
  'ui.toast.dismiss': 'Dismiss',
} as const;

export type UiKey = keyof typeof uiMessages;

export type Vars = Record<string, string | number>;

/** The base of every plural key: `ui.combobox.results` for `ui.combobox.results_other`. */
export type PluralBase<K extends string> = K extends `${infer B}_other` ? B : never;

export interface Translate<K extends string> {
  (key: K, vars?: Vars): string;
  /**
   * `<key>_<category>`, with the category from `Intl.PluralRules` for the
   * active locale, falling back to `<key>_other`. `{count}` is filled with the
   * count formatted for the locale.
   *
   * The rule comes from the platform, not from `count === 1`: French and
   * Brazilian Portuguese treat 0 as singular, and a language with more forms
   * only needs more keys, not new code.
   */
  plural(key: PluralBase<K>, count: number, vars?: Vars): string;
}

export interface Format {
  number(value: number): string;
  /** Date and time, as `Date#toLocaleString` writes them. */
  dateTime(value: Date | string): string;
  date(value: Date | string, options?: Intl.DateTimeFormatOptions): string;
}

export interface UiLocale<K extends string = UiKey> {
  /** The language the catalog is in: `en`, `fr`. */
  locale: string;
  t: Translate<K>;
  format: Format;
}

/**
 * Fills `{name}` from `vars`.
 *
 * A placeholder with nothing to fill it is left alone rather than blanked: a
 * sentence reading "Good day, {name}" gets reported, one reading "Good day,"
 * does not.
 */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

const rules = new Map<string, Intl.PluralRules>();

export function pluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  let rule = rules.get(locale);
  if (!rule) {
    rule = new Intl.PluralRules(locale);
    rules.set(locale, rule);
  }
  return rule.select(count);
}

/**
 * A translator over `lookup`, which answers a key in the active language or
 * falls back to English itself. A key nobody has is returned as the key, which
 * only happens for a key the types did not check.
 */
export function createTranslate<K extends string>(
  locale: string,
  lookup: (key: string) => string | undefined,
  format: Format = createFormat(locale),
): Translate<K> {
  const t = ((key: K, vars?: Vars) => interpolate(lookup(key) ?? key, vars)) as Translate<K>;
  t.plural = (key, count, vars) => {
    const text =
      lookup(`${key}_${pluralCategory(locale, count)}`) ?? lookup(`${key}_other`) ?? key;
    return interpolate(text, { count: format.number(count), ...vars });
  };
  return t;
}

/**
 * Numbers and dates for `locale`, which may carry a region (`en-GB`, `pt-PT`)
 * when the browser asked for one in the active language.
 */
export function createFormat(locale: string): Format {
  const numbers = new Intl.NumberFormat(locale);
  const toDate = (value: Date | string) => (typeof value === 'string' ? new Date(value) : value);
  return {
    number: (value) => numbers.format(value),
    dateTime: (value) => toDate(value).toLocaleString(locale),
    date: (value, options) => toDate(value).toLocaleDateString(locale, options),
  };
}

const english: UiLocale = {
  locale: 'en',
  t: createTranslate<UiKey>('en', (key) => uiMessages[key as UiKey]),
  format: createFormat('en'),
};

const UiLocaleContext = createContext<UiLocale | null>(null);

export function UiLocaleProvider({ value, children }: { value: UiLocale; children: ReactNode }) {
  return <UiLocaleContext.Provider value={value}>{children}</UiLocaleContext.Provider>;
}

/** The active translator for this package's strings; English outside a provider. */
export function useUiLocale(): UiLocale {
  return useContext(UiLocaleContext) ?? english;
}

/** English, for code that formats outside React. */
export const englishUi: UiLocale = english;
