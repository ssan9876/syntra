import { NavLink } from 'react-router-dom';
import { useCan } from '../../session/SessionProvider.js';

export interface NavItem {
  to: string;
  label: string;
  permission: string;
}

interface NavGroup {
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
const GROUPS: NavGroup[] = [
  {
    label: 'Directory',
    items: [
      // People, accounts and import are one destination. They were three
      // links in this group, and every one of them carried a paragraph
      // pointing at the other two.
      { to: '/admin/users', label: 'Users', permission: 'directory.read' },
      { to: '/admin/groups', label: 'Groups', permission: 'directory.read' },
      { to: '/admin/org-units', label: 'Org units', permission: 'directory.read' },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/admin/applications', label: 'Applications', permission: 'access.read' },
      { to: '/admin/policy', label: 'Authentication policy', permission: 'policy.read' },
      // The five stages of one request pipeline, and the seven objects of one
      // governance module. Both sit under Access because that is what they are
      // about: asking for it, and checking who has it.
      { to: '/admin/requests', label: 'Requests', permission: 'automate.read' },
      { to: '/admin/govern', label: 'Governance', permission: 'govern.read' },
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
      { to: '/admin/sources', label: 'Sources', permission: 'sync.read' },
      { to: '/admin/targets', label: 'Target systems', permission: 'provision.read' },
    ],
  },
  {
    label: 'System',
    items: [
      // `rbac.manage`, which until the role API existed gated nothing at all.
      { to: '/admin/roles', label: 'Roles', permission: 'rbac.manage' },
      // Its label used to be a sentence — "What needs attention" — because
      // "Incidents" would not have explained itself. As a pair of tabs,
      // Attention beside All events, the filter shows what it is.
      { to: '/admin/activity', label: 'Activity', permission: 'audit.read' },
      // Sign-in, branding and webhooks: three links all gated on
      // `tenant.manage`, all configuring the same tenant.
      { to: '/admin/settings', label: 'Settings', permission: 'tenant.manage' },
      // `deployment.manage`, not `tenant.manage`: this updates the
      // installation every tenant shares, not one tenant's configuration.
      { to: '/admin/updates', label: 'Updates', permission: 'deployment.manage' },
    ],
  },
];

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

  return (
    <nav
      aria-label="Administration"
      className="shrink-0 border-border-subtle bg-surface-2 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:w-60 lg:overflow-y-auto lg:border-r max-lg:border-b"
    >
      <div className="px-3 py-5 max-lg:px-6 max-lg:py-4">
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
                        'block rounded-control px-3 py-1.5 text-sm',
                        'transition-colors duration-150 ease-out-quart',
                        isActive
                          ? // The selected item is the only place weight and
                            // colour are spent. Everything else stays quiet so
                            // that "where am I" is answerable at a glance.
                            'bg-primary-soft font-semibold text-primary'
                          : 'font-medium text-ink/80 hover:bg-bg hover:text-ink',
                      ].join(' ')
                    }
                  >
                    {item.label}
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
