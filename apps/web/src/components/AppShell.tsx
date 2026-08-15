import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@syntra/ui';
import { useSession } from '../session/SessionProvider.js';
import { Wordmark } from './Wordmark.js';

/** The chrome shared by the portal and the console: identity, then exit. */
export function AppShell({ children }: { children: ReactNode }) {
  const { session, logout } = useSession();
  const navigate = useNavigate();

  async function onSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-border-subtle bg-bg/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-6">
          <Link to="/" className="rounded-sm">
            <Wordmark />
          </Link>

          <div className="flex items-center gap-3">
            {session?.mayElevate && (
              <Link
                to={session.scope === 'admin' ? '/admin/users' : '/elevate'}
                className="rounded-control px-2.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Administration
              </Link>
            )}
            <Link
              to="/security"
              className="rounded-control px-2.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Security
            </Link>
            <span className="hidden text-sm text-muted sm:inline">
              {session?.displayName}
            </span>
            <Button size="sm" variant="ghost" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1">{children}</div>
    </div>
  );
}
