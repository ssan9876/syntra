import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { GROUPS } from './AdminNav.js';
import { useConsoleT, type ConsoleKey, type ConsoleT } from '../../i18n/console/index.js';

/**
 * Titles of the records this tab has shown, by path.
 *
 * The trail above a run needs the NAME of the target it belongs to, and only
 * the target's own page knows it. Rather than every deep page fetching its
 * ancestors to label a breadcrumb, each `PageHeader` records the title it
 * rendered under its own path, and a later page deeper down reads it back. A
 * reader who arrived straight from a pasted link gets the generic noun —
 * "Target" — which is correct, just less specific.
 *
 * Module state rather than storage: it is a cache of what is already on
 * screen, and nothing in it should outlive the tab.
 */
const titles = new Map<string, string>();

export function useRememberTitle(title: string) {
  const { pathname } = useLocation();
  useEffect(() => {
    titles.set(pathname, title);
  }, [pathname, title]);
}

/**
 * Paths that are not in the rail but belong to a section that is. A person
 * record lives under Users; a lifecycle operation is an item of Employee work.
 */
const ALIASES: Record<string, { label: ConsoleKey; to: string }> = {
  people: { label: 'console.nav.users', to: '/admin/users?tab=people' },
  'person-sources': { label: 'console.nav.sources', to: '/admin/sources' },
  'person-import-runs': { label: 'console.nav.sources', to: '/admin/sources' },
  'sync-runs': { label: 'console.nav.sources', to: '/admin/sources?tab=runs' },
  'lifecycle-operations': { label: 'console.nav.employee_work', to: '/admin/employee-work' },
  'lifecycle-simulation': { label: 'console.nav.employee_work', to: '/admin/employee-work' },
  automate: { label: 'console.nav.requests', to: '/admin/requests' },
};

/** The noun for a record under a given collection, when its name is unknown. */
const NOUNS: Record<string, ConsoleKey> = {
  users: 'console.noun.account',
  people: 'console.noun.person',
  groups: 'console.noun.group',
  'org-units': 'console.noun.org_unit',
  applications: 'console.noun.application',
  sources: 'console.noun.source',
  'person-sources': 'console.noun.hr_source',
  'person-import-runs': 'console.noun.import_run',
  'sync-runs': 'console.noun.sync_run',
  targets: 'console.noun.target',
  runs: 'console.noun.run',
  'lifecycle-operations': 'console.noun.operation',
  requests: 'console.noun.request',
  products: 'console.noun.product',
  sweeps: 'console.noun.sweep',
  snapshots: 'console.noun.snapshot',
  campaigns: 'console.noun.review',
  batches: 'console.noun.batch',
};

/** Named sub-pages of a record: `/targets/:id/rules` is the target's rules. */
const SUBPAGES: Record<string, ConsoleKey> = {
  access: 'console.sub.access',
  profile: 'console.sub.profile',
  rules: 'console.sub.rules',
  runs: 'console.sub.runs',
  new: 'console.sub.new',
  manual: 'console.sub.manual',
  unlinked: 'console.sub.unlinked',
};

interface Crumb {
  label: string;
  to: string;
}

function trail(pathname: string, t: ConsoleT): Crumb[] {
  const segments = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  if (segments.length < 2) return [];

  const head = segments[0]!;
  const navItem = GROUPS.flatMap((group) => group.items).find(
    (item) => item.to === `/admin/${head}`,
  );
  const section = navItem ?? ALIASES[head];
  if (!section) return [];

  const crumbs: Crumb[] = [{ label: t(section.label), to: section.to }];
  // Every ancestor between the section and the page itself. The page's own
  // segment is left off: its title is the heading directly underneath.
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const path = `/admin/${segments.slice(0, i + 1).join('/')}`;
    const key = SUBPAGES[segment] ?? NOUNS[segments[i - 1]!];
    const label = titles.get(path) ?? (key ? t(key) : segment);
    // `automate/products` is a redirect to a tab; linking to it would bounce.
    // The section crumb already goes there.
    if (head === 'automate' && i === 1) continue;
    crumbs.push({ label, to: path });
  }
  return crumbs;
}

/**
 * Where a deep page sits, as links back up.
 *
 * Only on pages two or more levels down. A list page is one click from the
 * rail, and a trail reading "Users" above a heading reading "Users" is the
 * same word twice. Ancestors only: the current page is the heading.
 */
export function Breadcrumbs() {
  const { pathname } = useLocation();
  const t = useConsoleT();
  const crumbs = trail(pathname, t);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={t('console.breadcrumb')} className="mb-1.5">
      <ol className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
        {crumbs.map((crumb, index) => (
          <li key={crumb.to} className="flex items-center gap-1.5">
            {index > 0 && (
              <svg viewBox="0 0 12 12" className="size-3 text-border-control" aria-hidden="true">
                <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
            <Link
              to={crumb.to}
              className="max-w-[24ch] truncate rounded-sm font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {crumb.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
