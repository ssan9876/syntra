import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@syntra/ui';
import { useSession } from '../session/SessionProvider.js';
import { PortalNav } from './PortalNav.js';
import { Wordmark } from './Wordmark.js';
import { LanguagePicker, useT } from '../i18n/LocaleProvider.js';

/**
 * The chrome shared by the portal and the console: identity, then exit.
 *
 * Two shapes, one header. The PORTAL is a page — a few tiles, read for four
 * seconds a day — and stays centred and narrow. The CONSOLE is a workspace,
 * and gets a rail anchored to the edge of the viewport with the content
 * filling what is left. Centring the console inside a fixed container left the
 * navigation floating in from nowhere with dead space either side of it, which
 * is the single thing that made this read as unfinished.
 */
export function AppShell({
  children,
  sidebar,
}: {
  children: ReactNode;
  /** Present for the console. Absent for the portal, which is a page. */
  sidebar?: ReactNode;
}) {
  const { session, logout } = useSession();
  const t = useT();
  const navigate = useNavigate();

  async function onSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-border-subtle bg-bg/95 backdrop-blur-sm">
        {/* Full-bleed for the console so the header rule meets the rail, and
            the rail meets the edge. The portal keeps its container. */}
        <div
          className={[
            'flex h-14 w-full items-center justify-between gap-4 px-6',
            sidebar ? '' : 'mx-auto max-w-7xl',
          ].join(' ')}
        >
          <Link to="/" className="rounded-sm">
            <Wordmark />
          </Link>

          <div className="flex items-center gap-1">
            {session?.mayElevate && (
              <Link
                to={session.scope === 'admin' ? '/admin/users' : '/elevate'}
                className="rounded-control px-2.5 py-1.5 text-sm font-medium text-muted transition-colors duration-150 ease-out-quart hover:bg-surface-2 hover:text-ink"
              >
                {t('shell.administration')}
              </Link>
            )}
            <Link
              to="/security"
              className="rounded-control px-2.5 py-1.5 text-sm font-medium text-muted transition-colors duration-150 ease-out-quart hover:bg-surface-2 hover:text-ink"
            >
              {t('shell.security')}
            </Link>
            {/* A rule, not a gap. Who you are is a different kind of thing
                from where you can go, and the separation says so without a
                label. */}
            <span
              aria-hidden="true"
              className="mx-2 hidden h-5 w-px bg-border-subtle sm:block"
            />
            <span className="hidden text-sm text-muted sm:inline">
              {session?.displayName}
            </span>
            {/* In the header rather than buried in a settings page: the
                reader who needs it is, by definition, the one who cannot read
                the settings page's name. */}
            <LanguagePicker className="hidden sm:inline-flex" />
            <Button size="sm" variant="ghost" onClick={onSignOut}>
              {t('portal.sign_out')}
            </Button>
          </div>
        </div>
      </header>

      {sidebar ? (
        <div className="flex flex-1 items-stretch max-lg:flex-col">
          {sidebar}
          <main className="min-w-0 flex-1 px-6 py-7 lg:px-8">{children}</main>
        </div>
      ) : (
        <>
          {/* Only for a signed-in reader. The login, enrolment and reset
              screens use this shell too, and offering "My requests" to
              somebody who has not authenticated is an invitation to a
              redirect. */}
          {session && <PortalNav />}
          <div className="flex-1">{children}</div>
        </>
      )}
    </div>
  );
}
