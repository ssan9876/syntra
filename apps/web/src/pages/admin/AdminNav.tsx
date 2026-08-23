import { NavLink } from 'react-router-dom';
import { useSession } from '../../session/SessionProvider.js';

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
 * The console's navigation, in six groups.
 *
 * It was twenty-three links in one flat list — every one the same weight, the
 * same colour, in source order. That is a list of routes, not a navigation.
 * An administrator working a joiner ticket has to read all of it to find
 * "People", and the length alone made the console look like scaffolding.
 *
 * The groups are the product's own modules, in the order somebody meets them:
 * the directory first because that is where a ticket starts, governance last
 * because it is periodic rather than daily. Naming them after the modules
 * rather than inventing task-based headings keeps the navigation and the
 * documentation using the same nouns.
 */
const GROUPS: NavGroup[] = [
  {
    label: 'Directory',
    items: [
      { to: '/admin/users', label: 'Users', permission: 'directory.read' },
      { to: '/admin/groups', label: 'Groups', permission: 'directory.read' },
      { to: '/admin/org-units', label: 'Org units', permission: 'directory.read' },
      { to: '/admin/people', label: 'People', permission: 'identity.read' },
      { to: '/admin/import', label: 'Import', permission: 'identity.write' },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/admin/applications', label: 'Applications', permission: 'access.read' },
      { to: '/admin/policy', label: 'Authentication policy', permission: 'policy.read' },
    ],
  },
  {
    label: 'Connected systems',
    items: [
      { to: '/admin/sources', label: 'Directory sources', permission: 'sync.read' },
      { to: '/admin/sync-runs', label: 'Sync runs', permission: 'sync.read' },
      { to: '/admin/targets', label: 'Target systems', permission: 'provision.read' },
    ],
  },
  {
    label: 'Requests',
    items: [
      { to: '/admin/automate/products', label: 'Catalog', permission: 'automate.read' },
      { to: '/admin/automate/workflows', label: 'Approval workflows', permission: 'automate.read' },
      { to: '/admin/automate/requests', label: 'Request queue', permission: 'automate.read' },
      { to: '/admin/automate/sweeps', label: 'Expiry sweeps', permission: 'automate.read' },
    ],
  },
  {
    label: 'Governance',
    items: [
      // Findings first: the module leads with what is wrong, not with a
      // certification rate.
      { to: '/admin/govern/findings', label: 'Findings', permission: 'govern.read' },
      { to: '/admin/govern/campaigns', label: 'Access reviews', permission: 'govern.read' },
      { to: '/admin/govern/reports', label: 'Access reports', permission: 'govern.read' },
      { to: '/admin/govern/snapshots', label: 'Snapshots', permission: 'govern.read' },
      { to: '/admin/govern/sod', label: 'Segregation of duties', permission: 'govern.read' },
      { to: '/admin/govern/orphans', label: 'Orphan accounts', permission: 'govern.read' },
      { to: '/admin/govern/integrity', label: 'Audit integrity', permission: 'govern.read' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/audit', label: 'Audit log', permission: 'audit.read' },
      { to: '/admin/settings', label: 'Tenant settings', permission: 'tenant.manage' },
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
 * Sticky under the header rather than scrolling with the page: twenty-three
 * links is more than one screen on a laptop, and an administrator two thirds
 * of the way down a table of people should not have to scroll back up to
 * move between sections.
 */
export function AdminNav() {
  const { can } = useSession();

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
