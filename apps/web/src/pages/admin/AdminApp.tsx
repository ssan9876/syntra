import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../../components/AppShell.js';
import { AdminNav } from './AdminNav.js';
import { UsersPage } from './UsersPage.js';
import { GroupsPage } from './GroupsPage.js';
import { OrgUnitsPage } from './OrgUnitsPage.js';
import { PersonsPage } from './PersonsPage.js';
import { PersonDetailPage } from './PersonDetailPage.js';
import { ImportPage } from './ImportPage.js';
import { AuditPage } from './AuditPage.js';
import { UpdatesPage } from './UpdatesPage.js';
import { SourcesPage } from './SourcesPage.js';
import { SourceDetailPage } from './SourceDetailPage.js';
import { SyncRunsPage } from './SyncRunsPage.js';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';
import { ApplicationsPage } from './ApplicationsPage.js';
import { ApplicationDetailPage } from './ApplicationDetailPage.js';
import { PoliciesPage } from './PoliciesPage.js';
import { RolesPage } from './RolesPage.js';
import { TenantSettingsPage } from './TenantSettingsPage.js';
import { TargetsPage } from './TargetsPage.js';
import { TargetDetailPage } from './TargetDetailPage.js';
import { AccountProfilePage } from './AccountProfilePage.js';
import { BusinessRulesPage } from './BusinessRulesPage.js';
import { ProvisionRunsPage } from './ProvisionRunsPage.js';
import { ProvisionRunDetailPage } from './ProvisionRunDetailPage.js';
import { PersonAccessPage } from './PersonAccessPage.js';
import { ProductsPage } from './ProductsPage.js';
import { ProductEditorPage } from './ProductEditorPage.js';
import { WorkflowEditorPage } from './WorkflowEditorPage.js';
import { RequestQueuePage } from './RequestQueuePage.js';
import { RequestDetailAdminPage } from './RequestDetailAdminPage.js';
import { SweepsPage } from './SweepsPage.js';
import { SweepDetailPage } from './SweepDetailPage.js';
import { GovernSnapshotsPage } from './GovernSnapshotsPage.js';
import { GovernSnapshotDetailPage } from './GovernSnapshotDetailPage.js';
import { GovernReportsPage } from './GovernReportsPage.js';
import { GovernFindingsPage } from './GovernFindingsPage.js';
import { GovernOrphansPage } from './GovernOrphansPage.js';
import { GovernIntegrityPage } from './GovernIntegrityPage.js';
import { GovernCampaignsPage } from './GovernCampaignsPage.js';
import { GovernCampaignDetailPage } from './GovernCampaignDetailPage.js';
import { GovernBatchPage } from './GovernBatchPage.js';
import { GovernSodPage } from './GovernSodPage.js';

export function AdminApp() {
  return (
    <AppShell sidebar={<AdminNav />}>
      {/* Capped, and LEFT-ALIGNED against the rail rather than centred in what
          is left. Centring opened a gap between the navigation and the content
          that grew with the monitor, so on a wide screen the page looked like
          it had come loose. A console reads left to right from its rail. */}
      <div className="w-full max-w-6xl">
          <Routes>
            <Route path="users" element={<UsersPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="org-units" element={<OrgUnitsPage />} />
            <Route path="people" element={<PersonsPage />} />
            <Route path="people/:id" element={<PersonDetailPage />} />
            {/* After the person, so the more specific path is reached rather
                than shadowed by the less specific one. */}
            <Route path="people/:id/access" element={<PersonAccessPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="sources" element={<SourcesPage />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the editor. */}
            <Route path="sources/new" element={<SourceDetailPage />} />
            <Route path="sources/:id" element={<SourceDetailPage />} />
            <Route path="sync-runs" element={<SyncRunsPage />} />
            <Route path="sync-runs/:id" element={<SyncRunDetailPage />} />
            <Route path="targets" element={<TargetsPage />} />
            {/* React Router ranks a static segment above a dynamic one however
                they are ordered, so "new" is never captured as an id. Listed
                first for readability, exactly as sources/new is. */}
            <Route path="targets/new" element={<TargetDetailPage />} />
            <Route path="targets/:id" element={<TargetDetailPage />} />
            <Route path="targets/:id/profile" element={<AccountProfilePage />} />
            <Route path="targets/:id/rules" element={<BusinessRulesPage />} />
            <Route path="targets/:id/runs" element={<ProvisionRunsPage />} />
            <Route
              path="targets/:id/runs/:runId"
              element={<ProvisionRunDetailPage />}
            />
            <Route path="automate/products" element={<ProductsPage />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the editor. */}
            <Route path="automate/products/new" element={<ProductEditorPage />} />
            <Route path="automate/products/:id" element={<ProductEditorPage />} />
            <Route path="automate/workflows" element={<WorkflowEditorPage />} />
            <Route path="automate/requests" element={<RequestQueuePage />} />
            <Route path="automate/requests/:id" element={<RequestDetailAdminPage />} />
            <Route path="automate/sweeps" element={<SweepsPage />} />
            <Route path="automate/sweeps/:id" element={<SweepDetailPage />} />
            {/* Relative paths, and the literal segment before the parametric one. */}
            <Route path="govern/findings" element={<GovernFindingsPage />} />
            <Route path="govern/snapshots" element={<GovernSnapshotsPage />} />
            <Route path="govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
            <Route path="govern/reports" element={<GovernReportsPage />} />
            <Route path="govern/campaigns" element={<GovernCampaignsPage />} />
            <Route path="govern/campaigns/:id" element={<GovernCampaignDetailPage />} />
            <Route path="govern/batches/:id" element={<GovernBatchPage />} />
            <Route path="govern/sod" element={<GovernSodPage />} />
            <Route path="govern/orphans" element={<GovernOrphansPage />} />
            <Route path="govern/integrity" element={<GovernIntegrityPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="applications/:id" element={<ApplicationDetailPage />} />
            <Route path="policy" element={<PoliciesPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="settings" element={<TenantSettingsPage />} />
            <Route path="updates" element={<UpdatesPage />} />
            <Route path="*" element={<Navigate to="/admin/users" replace />} />
          </Routes>
      </div>
    </AppShell>
  );
}
