import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api.js';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/**
 * Reads a resource and turns a failure into a sentence a person can act on.
 * A 403 is not an error state to apologise for - it is a fact about the
 * caller's permissions, and saying so is more useful than "something failed".
 *
 * THE SERVER'S OWN SENTENCE WINS. Where the API wrote a `detail`, it knows
 * something this hook cannot: the portal's 403 for an account with no linked
 * person says so in as many words — "this account is not linked to a person
 * record, so it cannot ask for anything or hold anything" — and flattening
 * that to "you do not have permission to view this" sends the reader to an
 * administrator to be given a permission that was never the problem. The
 * per-status sentences below are the floor for the refusals that carry no
 * detail, not a replacement for the ones that do.
 *
 * This is what every other caller in the console already does
 * (`cause.problem.detail ?? cause.problem.title`); this hook was the one
 * place that threw the detail away.
 *
 * A `null` path means there is nothing to read yet - the source editor on its
 * "new source" route has no id to fetch - and settles as loaded with no data
 * rather than as an error. Hooks cannot be called conditionally, so the
 * condition has to live here.
 */
/** What a refusal says when the server did not say anything more specific. */
const GENERIC: Record<number, string> = {
  403: 'You do not have permission to view this.',
  404: 'That record no longer exists.',
};

export function useApiResource<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    if (path === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    api<T>(path)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (!(cause instanceof ApiError)) {
          setError('Something went wrong loading this page.');
          return;
        }
        // A 500 deliberately carries no detail — the server logs it and tells
        // the client nothing — so it falls through to the generic sentence
        // rather than reporting an empty one.
        setError(cause.problem.detail ?? GENERIC[cause.problem.status] ??
          'Something went wrong loading this page.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
