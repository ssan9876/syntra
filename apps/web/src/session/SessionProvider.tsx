import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SessionResponse } from '@syntra/contracts';
import { api } from './api.js';

export type FactorKind = 'totp' | 'webauthn';

/**
 * What /api/auth/login and /api/auth/elevate can both answer. Two of the three
 * are not a session: the password was right and the policy wants a second
 * factor first, either one the user already holds or one they must enrol.
 * Returning the whole outcome rather than assigning it into the session is
 * what lets the caller tell the difference.
 *
 * Elevation reaches these two arms far more readily than sign-in does. It
 * always re-authenticates from scratch, with no factor carried over, so a
 * tenant holding any require_mfa rule answers `challenge` on every elevation —
 * including for a user who satisfied that same rule at sign-in minutes
 * earlier.
 */
export type AuthOutcome =
  | ({ status: 'authenticated' } & SessionResponse)
  | {
      /** Present a factor you already hold. */
      status: 'challenge';
      attemptToken: string;
      expiresAt: string;
      acceptableFactors: FactorKind[];
    }
  | {
      /** Enrol a factor of the required kind. Still no session. */
      status: 'enrol';
      attemptToken: string;
      expiresAt: string;
      enrollableFactors: FactorKind[];
    };

interface SessionContextValue {
  session: SessionResponse | null;
  loading: boolean;
  login(login: string, password: string): Promise<AuthOutcome>;
  elevate(password: string): Promise<AuthOutcome>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  can(permission: string): boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<SessionResponse>('/api/auth/session')
      .then((value) => {
        if (!cancelled) setSession(value);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (loginName: string, password: string): Promise<AuthOutcome> => {
      const result = await api<AuthOutcome>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: loginName, password }),
      });
      if (result.status === 'authenticated') setSession(result);
      return result;
    },
    [],
  );

  const elevate = useCallback(async (password: string): Promise<AuthOutcome> => {
    const result = await api<AuthOutcome>('/api/auth/elevate', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    // Only the authenticated arm carries a session, and only it comes with a
    // cookie. Storing either of the other two would leave `scope`,
    // `permissions` and `mayElevate` undefined — the guard would bounce the
    // user straight back out of the console, and the portal identity would
    // disappear from the header until the page was reloaded.
    if (result.status === 'authenticated') setSession(result);
    return result;
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setSession(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSession(await api<SessionResponse>('/api/auth/session'));
    } catch {
      setSession(null);
    }
  }, []);

  /**
   * Presentation only. The server decides every request independently; this
   * exists to avoid showing a control that would be refused, never to grant
   * anything.
   */
  const can = useCallback(
    (permission: string) => session?.permissions.includes(permission) ?? false,
    [session],
  );

  const value = useMemo(
    () => ({ session, loading, login, elevate, logout, refresh, can }),
    [session, loading, login, elevate, logout, refresh, can],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
