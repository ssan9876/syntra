import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../../components/AppShell.js';
import { useSession } from '../../session/SessionProvider.js';
import { UsersPage } from './UsersPage.js';
import { GroupsPage } from './GroupsPage.js';
import { OrgUnitsPage } from './OrgUnitsPage.js';
import { PersonsPage } from './PersonsPage.js';
import { PersonDetailPage } from './PersonDetailPage.js';
import { ImportPage } from './ImportPage.js';
import { AuditPage } from './AuditPage.js';
import { SourcesPage } from './SourcesPage.js';
import { SourceDetailPage } from './SourceDetailPage.js';
import { SyncRunsPage } from './SyncRunsPage.js';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';
import { ApplicationsPage } from './ApplicationsPage.js';
import { ApplicationDetailPage } from './ApplicationDetailPage.js';
import { PoliciesPage } from './PoliciesPage.js';
import { TenantSettingsPage } from './TenantSettingsPage.js';

interface NavItem {
  to: string;
  label: string;
  permission: string;
}

const NAV: NavItem[] = [
  { to: '/admin/users', label: 'Users', permission: 'directory.read' },
  { to: '/admin/groups', label: 'Groups', permission: 'directory.read' },
  { to: '/admin/org-units', label: 'Org units', permission: 'directory.read' },
  { to: '/admin/applications', label: 'Applications', permission: 'access.read' },
  { to: '/admin/policy', label: 'Authentication policy', permission: 'policy.read' },
  { to: '/admin/people', label: 'People', permission: 'identity.read' },
  { to: '/admin/import', label: 'Import', permission: 'identity.write' },
  { to: '/admin/sources', label: 'Directory sources', permission: 'sync.read' },
  { to: '/admin/sync-runs', label: 'Sync runs', permission: 'sync.read' },
  { to: '/admin/audit', label: 'Audit log', permission: 'audit.read' },
  { to: '/admin/settings', label: 'Tenant settings', permission: 'tenant.manage' },
];

export function AdminApp() {
  const { can } = useSession();
  // Hiding a link the caller cannot use is courtesy, not enforcement: the
  // server refuses the request either way.
  const visible = NAV.filter((item) => can(item.permission));

  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-7xl gap-8 px-6 py-8 max-lg:flex-col">
        <nav aria-label="Administration" className="w-48 shrink-0 max-lg:w-full">
          <ul className="space-y-0.5 max-lg:flex max-lg:flex-wrap max-lg:gap-1 max-lg:space-y-0">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    [
                      'block rounded-control px-3 py-1.5 font-medium',
                      'transition-colors duration-150',
                      isActive
                        ? 'bg-primary-soft text-primary'
                        : 'text-muted hover:bg-surface-2 hover:text-ink',
                    ].join(' ')
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <Routes>
            <Route path="users" element={<UsersPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="org-units" element={<OrgUnitsPage />} />
            <Route path="people" element={<PersonsPage />} />
            <Route path="people/:id" element={<PersonDetailPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="sources" element={<SourcesPage />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the editor. */}
            <Route path="sources/new" element={<SourceDetailPage />} />
            <Route path="sources/:id" element={<SourceDetailPage />} />
            <Route path="sync-runs" element={<SyncRunsPage />} />
            <Route path="sync-runs/:id" element={<SyncRunDetailPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="applications/:id" element={<ApplicationDetailPage />} />
            <Route path="policy" element={<PoliciesPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="settings" element={<TenantSettingsPage />} />
            <Route path="*" element={<Navigate to="/admin/users" replace />} />
          </Routes>
        </div>
      </div>
    </AppShell>
  );
}
