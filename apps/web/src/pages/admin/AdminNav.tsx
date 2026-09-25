import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useCan } from '../../session/SessionProvider.js';
import { api } from '../../session/api.js';
import { Icon, type IconName } from '../../components/icons.js';

export interface NavItem {
  to: string;
  label: string;
  permission: string;
  icon: IconName;
  /**
   * A live count worth seeing from anywhere in the console. Only for a
   * destination whose whole job is a queue of things somebody has to act on:
   * a count beside "Groups" would be a figure, not a signal, and a rail of
   * figures is a rail nobody reads.
   */
  signal?: 'employeeWork';
}

export interface NavGroup {
  /** Shown above the group. Omitted for the first, which needs no label. */
  label: string;
  items: NavItem[];
}

/**
 * The console's navigation, in four groups and thirteen links.
 *
 * It was twenty-nine links in six groups, and before that twenty-three in one
 * flat list. Grouping them fixed the flatness but not the length: an
 * administrator still met a wall of labels and had to read most of it to find
 * the one destination they wanted, and several of those labels existed only to
 * distinguish themselves from a neighbour — "Users" against "People", "Sync
 * runs" against "Directory sources", "What needs attention" against "Audit
 * log".
 *
 * Sixteen of them are gone, into tabs. The rule applied was that two links
 * belong together when they are two VIEWS of one subject rather than two
 * subjects: a run is a source's history, attention is the audit log filtered,
 * branding is part of configuring a tenant. Where they are genuinely different
 * subjects they stayed apart — Groups is not a view of Users, and Targets is
 * not a view of Sources.
 *
 * Nothing here is a group of one. "Requests" inside a group labelled
 * "Requests" is a heading that repeats its only child, which is the same
 * failure as a paragraph explaining a control: structure spent saying nothing.
 * The four groups that remain each hold real siblings.
 */
export const GROUPS: NavGroup[] = [
  {
    label: 'Directory',
    items: [
      // People, accounts and import are one destination. They were three
      // links in this group, and every one of them carried a paragraph
      // pointing at the other two.
      { to: '/admin/users', label: 'Users', permission: 'directory.read', icon: 'users' },
      { to: '/admin/groups', label: 'Groups', permission: 'directory.read', icon: 'groups' },
      { to: '/admin/org-units', label: 'Org units', permission: 'directory.read', icon: 'orgUnits' },
      // Data-subject requests: about people, so beside them. Its own
      // permission, because a privacy officer is routinely not a directory
      // administrator.
      { to: '/admin/privacy', label: 'Privacy requests', permission: 'privacy.manage', icon: 'privacy' },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/admin/applications', label: 'Applications', permission: 'access.read', icon: 'applications' },
      { to: '/admin/policy', label: 'Authentication policy', permission: 'policy.read', icon: 'policy' },
      // The five stages of one request pipeline, and the seven objects of one
      // governance module. Both sit under Access because that is what they are
      // about: asking for it, and checking who has it.
      { to: '/admin/requests', label: 'Requests', permission: 'automate.read', icon: 'requests' },
      { to: '/admin/govern', label: 'Governance', permission: 'govern.read', icon: 'governance' },
    ],
  },
  {
    label: 'Connected systems',
    items: [
      // Runs are a tab of Sources: a run is a source's history, not its peer.
      //
      // "Sources", not "Directory sources", because there are two families
      // behind it now -- directories and HR exports. "Directory sources"
      // beside "People sources" would be two labels existing only to
      // distinguish themselves from each other, which is the failure this
      // file's header records sixteen links being removed for.
      { to: '/admin/sources', label: 'Sources', permission: 'sync.read', icon: 'sources' },
      { to: '/admin/targets', label: 'Target systems', permission: 'provision.read', icon: 'targets' },
      { to: '/admin/provisioning-setup', label: 'Provisioning setup', permission: 'provision.read', icon: 'setup' },
      { to: '/admin/employee-work', label: 'Employee work', permission: 'provision.read', icon: 'work', signal: 'employeeWork' },
      { to: '/admin/lifecycle-policy', label: 'Lifecycle policy', permission: 'provision.read', icon: 'lifecycle' },
    ],
  },
  {
    label: 'System',
    items: [
      // `rbac.manage`, which until the role API existed gated nothing at all.
      { to: '/admin/roles', label: 'Roles', permission: 'rbac.manage', icon: 'roles' },
      // Its label used to be a sentence — "What needs attention" — because
      // "Incidents" would not have explained itself. As a pair of tabs,
      // Attention beside All events, the filter shows what it is.
      { to: '/admin/activity', label: 'Activity', permission: 'audit.read', icon: 'activity' },
      // Service status, stuck background work and the support bundle. The
      // same permission as Activity: it gathers what is visible elsewhere.
      { to: '/admin/operations', label: 'Operations', permission: 'audit.read', icon: 'operations' },
      // Sign-in, branding and webhooks: three links all gated on
      // `tenant.manage`, all configuring the same tenant.
      { to: '/admin/settings', label: 'Settings', permission: 'tenant.manage', icon: 'settings' },
      // `deployment.manage`, not `tenant.manage`: this updates the
      // installation every tenant shares, not one tenant's configuration.
      { to: '/admin/updates', label: 'Updates', permission: 'deployment.manage', icon: 'updates' },
    ],
  },
];

interface WorkLanes {
  action: number;
  waiting: number;
  blocked: number;
  overdue: number;
}

/**
 * The employee-work lanes, for the badge on the rail.
 *
 * Polled once a minute and again on each navigation, so the count a reader
 * sees after clearing a lane is the new one. Silent on failure: a badge that
 * cannot load is a badge that is absent, never an error on every page of the
 * console.
 */
function useWorkSignal(enabled: boolean): WorkLanes | null {
  const [lanes, setLanes] = useState<WorkLanes | null>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      api<{ lanes?: WorkLanes }>('/api/admin/employee-work?pageSize=1')
        .then((body) => {
          if (live && body.lanes) setLanes(body.lanes);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, pathname]);
  return enabled ? lanes : null;
}

/**
 * The rail.
 *
 * `--surface-2` is what DESIGN.md assigns to "Sidebar, toolbars, table head",
 * and the tables have always used it. The sidebar did not, so it sat on the
 * page background with nothing separating it from the content — the tokens
 * were right and the markup had drifted from them.
 *
 * Sticky under the header rather than scrolling with the page. Thirteen links
 * now fit a laptop screen where twenty-nine did not, but an administrator two
 * thirds of the way down a table of people should still not have to scroll
 * back up to move between sections.
 *
 * Each link carries an icon BESIDE its label. The icon is for the reader who
 * already knows the rail and is scanning for a shape; the label stays for
 * everybody else, and an icon-only rail would ask a nurse-turned-HR-admin to
 * learn sixteen pictures.
 */
export function AdminNav() {
  // `useCan`, not `useSession`. This component only decides whether to OFFER
  // a link, which is the case `useCan` documents itself for: it answers false
  // where there is no provider instead of throwing, so a rail rendered out of
  // context hides links rather than taking the page down with it.
  const can = useCan();

  // Hiding a link the caller cannot use is courtesy, not enforcement: the
  // server refuses the request either way. A group whose every item is hidden
  // takes its heading with it — a lone "Governance" label above nothing reads
  // as a broken page rather than as a permission boundary.
  const groups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.permission)),
  })).filter((group) => group.items.length > 0);

  // The queue endpoint asks for all three; offering a badge the server will
  // refuse would be a request per minute that can only fail.
  const lanes = useWorkSignal(can('provision.read') && can('directory.read') && can('identity.read'));

  /**
   * Below the `lg` breakpoint the rail is a menu, closed by default.
   *
   * It stacks above the content there, and sixteen links in four groups is a
   * whole phone screen: every console page opened with a scroll past the
   * navigation before its title. Closed, it is one row that names where you
   * are; it closes again on every navigation so the page you chose is what
   * you see. At `lg` and up it is the rail, always open.
   */
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const current = groups.flatMap((group) => group.items).find((item) => pathname.startsWith(item.to));

  return (
    <nav
      aria-label="Administration"
      className="shrink-0 border-border-subtle bg-surface-2 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:w-60 lg:overflow-y-auto lg:border-r max-lg:border-b"
    >
      <button
        type="button"
        aria-expanded={menuOpen}
        aria-controls="admin-nav-groups"
        onClick={() => setMenuOpen((open) => !open)}
        className="flex w-full items-center gap-2.5 px-6 py-3 text-sm font-semibold text-ink lg:hidden"
      >
        {current ? <Icon name={current.icon} className="size-4 text-primary" /> : null}
        <span className="flex-1 text-left">{current?.label ?? 'Menu'}</span>
        {lanes && !menuOpen && <WorkBadge lanes={lanes} />}
        <span className="text-muted">{menuOpen ? 'Close' : 'Menu'}</span>
        <svg viewBox="0 0 12 12" className={`size-3 text-muted transition-transform duration-150 ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div
        id="admin-nav-groups"
        className={`px-3 py-5 max-lg:px-6 max-lg:pt-0 max-lg:pb-4 ${menuOpen ? '' : 'max-lg:hidden'}`}
      >
        {groups.map((group, index) => (
          <div key={group.label} className={index === 0 ? '' : 'mt-6'}>
            {/* Sentence case, muted, small. A section label is a signpost and
                should not compete with the destinations under it. */}
            <h2 className="px-3 pb-1.5 text-xs font-semibold tracking-wide text-muted">
              {group.label}
            </h2>
            <ul className="space-y-px">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    className={({ isActive }) =>
                      [
                        'group flex items-center gap-2.5 rounded-control px-3 py-1.5 text-sm',
                        'transition-colors duration-150 ease-out-quart',
                        isActive
                          ? // The selected item is the only place weight and
                            // colour are spent. Everything else stays quiet so
                            // that "where am I" is answerable at a glance —
                            // and it gets an edge as well as a tint, because
                            // `primary-soft` on `surface-2` is a difference of
                            // hue that a washed-out ward monitor flattens.
                            'bg-bg font-semibold text-primary shadow-raised ring-1 ring-border-subtle'
                          : 'font-medium text-ink/80 hover:bg-bg hover:text-ink',
                      ].join(' ')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          name={item.icon}
                          className={`size-4 ${isActive ? 'text-primary' : 'text-muted group-hover:text-ink'}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.signal === 'employeeWork' && lanes && <WorkBadge lanes={lanes} />}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/**
 * How many items somebody must act on: overdue, blocked and needs-action.
 * Waiting work is left out on purpose — it is waiting on a target, and a
 * badge that counts it is a badge that is never zero.
 */
function WorkBadge({ lanes }: { lanes: WorkLanes }) {
  const urgent = lanes.overdue + lanes.blocked;
  const count = urgent + lanes.action;
  if (count === 0) return null;
  return (
    <span
      className={[
        'rounded-full px-1.5 text-xs font-semibold tabular-nums',
        urgent > 0 ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning',
      ].join(' ')}
    >
      <span aria-hidden="true">{count.toLocaleString()}</span>
      <span className="sr-only">, {count.toLocaleString()} need action</span>
    </span>
  );
}
