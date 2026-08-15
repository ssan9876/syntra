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
 * What /api/auth/login can now answer. Two of the three are not a session: the
 * password was right and the policy wants a second factor first, either one
 * the user already holds or one they must enrol. Returning the whole outcome
 * rather than assigning it into the session is what lets the caller tell the
 * difference.
 */
export type LoginOutcome =
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
  login(login: string, password: string): Promise<LoginOutcome>;
  elevate(password: string): Promise<void>;
  logout(): Promise<void>;
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
    async (loginName: string, password: string): Promise<LoginOutcome> => {
      const result = await api<LoginOutcome>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: loginName, password }),
      });
      if (result.status === 'authenticated') setSession(result);
      return result;
    },
    [],
  );

  const elevate = useCallback(async (password: string) => {
    setSession(
      await api<SessionResponse>('/api/auth/elevate', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    );
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setSession(null);
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
    () => ({ session, loading, login, elevate, logout, can }),
    [session, loading, login, elevate, logout, can],
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
