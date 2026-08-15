import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../session/api.js';

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
 */
export function useApiResource<T>(path: string): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api<T>(path)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.problem.status === 403) {
          setError('You do not have permission to view this.');
        } else if (cause instanceof ApiError && cause.problem.status === 404) {
          setError('That record no longer exists.');
        } else {
          setError('Something went wrong loading this page.');
        }
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
