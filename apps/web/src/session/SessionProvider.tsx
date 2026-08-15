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

interface SessionContextValue {
  session: SessionResponse | null;
  loading: boolean;
  login(login: string, password: string): Promise<void>;
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

  const login = useCallback(async (loginName: string, password: string) => {
    setSession(
      await api<SessionResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: loginName, password }),
      }),
    );
  }, []);

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
