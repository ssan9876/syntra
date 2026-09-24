/**
 * The support bundle's time window, kept apart from the bundle builder so the
 * export service can validate a request without importing the builder (which
 * reads job health, which names the export job: a cycle).
 */

export const SUPPORT_BUNDLE_MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const SUPPORT_BUNDLE_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
export class SupportBundleWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupportBundleWindowError';
  }
}

/**
 * The window a request asked for, defaulted and checked. `to` defaults to
 * now, `from` to a day before `to`; the window must be positive, at most
 * seven days, and not in the future.
 */
export function supportBundleWindow(params: Record<string, unknown>, now: Date = new Date()): { from: Date; to: Date } {
  const parse = (value: unknown, name: string): Date | undefined => {
    if (value === undefined || value === null) return undefined;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new SupportBundleWindowError(`${name} is not a date`);
    return date;
  };
  const to = parse(params.to, 'to') ?? now;
  const from = parse(params.from, 'from') ?? new Date(to.getTime() - SUPPORT_BUNDLE_DEFAULT_WINDOW_MS);
  if (from >= to) throw new SupportBundleWindowError('the window must start before it ends');
  if (to.getTime() - from.getTime() > SUPPORT_BUNDLE_MAX_WINDOW_MS) {
    throw new SupportBundleWindowError('a support bundle covers at most seven days');
  }
  if (to.getTime() > now.getTime() + 60_000) throw new SupportBundleWindowError('the window cannot end in the future');
  return { from, to };
}
