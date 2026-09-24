import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../../components/AppShell.js';
import { AdminNav } from './AdminNav.js';
import { BreakGlassBanner } from './BreakGlassBanner.js';
import { HeldChangePrompt } from './HeldChangePrompt.js';

/**
 * Every console page is its own chunk.
 *
 * The console used to be one lazy chunk holding all forty-odd pages, which
 * reached 589 kB minified: opening the users list downloaded the governance
 * campaign editor, the rule editor and everything else with it. Each page now
 * loads when its route is first visited. The shell and navigation stay in the
 * console chunk, so the frame is on screen while a page arrives.
 */
function page<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
) {
  return lazy(() => load().then((module) => ({ default: module[name] })));
}

const UsersPage = page(() => import('./UsersPage.js'), 'UsersPage');
const GroupsPage = page(() => import('./GroupsPage.js'), 'GroupsPage');
const OrgUnitsPage = page(() => import('./OrgUnitsPage.js'), 'OrgUnitsPage');
const OrgUnitDetailPage = page(() => import('./OrgUnitDetailPage.js'), 'OrgUnitDetailPage');
const GroupDetailPage = page(() => import('./GroupDetailPage.js'), 'GroupDetailPage');
const OnboardPersonPage = page(() => import('./OnboardPersonPage.js'), 'OnboardPersonPage');
const PersonDetailPage = page(() => import('./PersonDetailPage.js'), 'PersonDetailPage');
const ActivityPage = page(() => import('./ActivityPage.js'), 'ActivityPage');
const OperationsPage = page(() => import('./OperationsPage.js'), 'OperationsPage');
const UpdatesPage = page(() => import('./UpdatesPage.js'), 'UpdatesPage');
const SourcesPage = page(() => import('./SourcesPage.js'), 'SourcesPage');
const PersonSourceDetailPage = page(() => import('./PersonSourceDetailPage.js'), 'PersonSourceDetailPage');
const PersonImportRunDetailPage = page(() => import('./PersonImportRunDetailPage.js'), 'PersonImportRunDetailPage');
const SourceDetailPage = page(() => import('./SourceDetailPage.js'), 'SourceDetailPage');
const SyncRunDetailPage = page(() => import('./SyncRunDetailPage.js'), 'SyncRunDetailPage');
const ApplicationsPage = page(() => import('./ApplicationsPage.js'), 'ApplicationsPage');
const ApplicationDetailPage = page(() => import('./ApplicationDetailPage.js'), 'ApplicationDetailPage');
const PoliciesPage = page(() => import('./PoliciesPage.js'), 'PoliciesPage');
const RolesPage = page(() => import('./RolesPage.js'), 'RolesPage');
const TenantSettingsPage = page(() => import('./TenantSettingsPage.js'), 'TenantSettingsPage');
const TargetsPage = page(() => import('./TargetsPage.js'), 'TargetsPage');
const TargetDetailPage = page(() => import('./TargetDetailPage.js'), 'TargetDetailPage');
const AccountProfilePage = page(() => import('./AccountProfilePage.js'), 'AccountProfilePage');
const AccountDetailPage = page(() => import('./AccountDetailPage.js'), 'AccountDetailPage');
const UnlinkedAccountsPage = page(() => import('./UnlinkedAccountsPage.js'), 'UnlinkedAccountsPage');
const BusinessRulesPage = page(() => import('./BusinessRulesPage.js'), 'BusinessRulesPage');
const ProvisionRunsPage = page(() => import('./ProvisionRunsPage.js'), 'ProvisionRunsPage');
const ProvisionRunDetailPage = page(() => import('./ProvisionRunDetailPage.js'), 'ProvisionRunDetailPage');
const PersonAccessPage = page(() => import('./PersonAccessPage.js'), 'PersonAccessPage');
const RequestsPage = page(() => import('./RequestsPage.js'), 'RequestsPage');
const ProductEditorPage = page(() => import('./ProductEditorPage.js'), 'ProductEditorPage');
const RequestDetailAdminPage = page(() => import('./RequestDetailAdminPage.js'), 'RequestDetailAdminPage');
const SweepDetailPage = page(() => import('./SweepDetailPage.js'), 'SweepDetailPage');
const GovernPage = page(() => import('./GovernPage.js'), 'GovernPage');
const GovernSnapshotDetailPage = page(() => import('./GovernSnapshotDetailPage.js'), 'GovernSnapshotDetailPage');
const GovernCampaignNewPage = page(() => import('./GovernCampaignNewPage.js'), 'GovernCampaignNewPage');
const GovernCampaignDetailPage = page(() => import('./GovernCampaignDetailPage.js'), 'GovernCampaignDetailPage');
const GovernBatchPage = page(() => import('./GovernBatchPage.js'), 'GovernBatchPage');
const ProvisioningSetupPage = page(() => import('./ProvisioningSetupPage.js'), 'ProvisioningSetupPage');
const EmployeeWorkPage = page(() => import('./EmployeeWorkPage.js'), 'EmployeeWorkPage');
const GuidedOnboardingPage = page(() => import('./GuidedOnboardingPage.js'), 'GuidedOnboardingPage');
const LifecycleOperationPage = page(() => import('./LifecycleOperationPage.js'), 'LifecycleOperationPage');
const LifecycleSimulationPage = page(() => import('./LifecycleSimulationPage.js'), 'LifecycleSimulationPage');
const LifecyclePolicyPage = page(() => import('./LifecyclePolicyPage.js'), 'LifecyclePolicyPage');
const PrivacyPage = page(() => import('./PrivacyPage.js'), 'PrivacyPage');
const PrivacyCasePage = page(() => import('./PrivacyCasePage.js'), 'PrivacyCasePage');

/** Quiet, like the boot screen: most pages arrive before it is noticed. */
function PageLoading() {
  return (
    <div className="py-8" role="status">
      <span className="sr-only">Loading page</span>
      <div className="skeleton h-2 w-32 rounded-full" />
    </div>
  );
}

export function AdminApp() {
  return (
    <AppShell sidebar={<AdminNav />}>
      {/* No cap here. The shell caps and centres the rail and the content
          together at `--shell-max`; a second cap on this container would win
          over the outer one and silently undo it, which is how the console
          ended up narrow and hugging its rail on a wide monitor. */}
      <div className="w-full">
          {/* Above every page: emergency access nobody can miss, and the
              reason prompt every held privileged change goes through. */}
          <BreakGlassBanner />
          <HeldChangePrompt />
          <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="users" element={<UsersPage />} />
            {/* Declared before `users/:id` so a reader meets the static path
                first. React Router ranks static segments above dynamic ones on
                its own, but a file that relies on that being remembered is one
                that breaks the day somebody reorders it. */}
            <Route path="users/unlinked" element={<UnlinkedAccountsPage />} />
            {/* One account, on its own screen. Every control that used to sit
                on a row of the accounts table lives here now, along with that
                account's own slice of the audit log. */}
            <Route path="users/:id" element={<AccountDetailPage />} />
            <Route path="groups" element={<GroupsPage />} />
            {/* One group, with its membership. The list is a list again. */}
            <Route path="groups/:id" element={<GroupDetailPage />} />
            <Route path="org-units" element={<OrgUnitsPage />} />
            {/* A node in a tree is a row, and a row opens a record: the unit,
                who is sitting in it, and what is beneath it. */}
            <Route path="org-units/:id" element={<OrgUnitDetailPage />} />
            {/* People, accounts and import are tabs of Users now. The old
                paths are kept as redirects rather than deleted: they are in
                bookmarks, in tickets, and in the `to=` of links on pages that
                have not been touched yet, and a 404 for each of those is a
                worse answer than the screen they meant. */}
            <Route path="people" element={<Navigate to="/admin/users?tab=people" replace />} />
            <Route path="import" element={<Navigate to="/admin/users?tab=import" replace />} />
            {/* Listed before the parametric route for readability, as
                sources/new is. React Router ranks the static segment above the
                dynamic one regardless, so "new" is never read as an id. */}
            <Route path="people/new" element={<GuidedOnboardingPage />} />
            <Route path="people/new/manual" element={<OnboardPersonPage />} />
            <Route path="people/:id" element={<PersonDetailPage />} />
            {/* After the person, so the more specific path is reached rather
                than shadowed by the less specific one. */}
            <Route path="people/:id/access" element={<PersonAccessPage />} />
            <Route path="employee-work" element={<EmployeeWorkPage />} />
            <Route path="lifecycle-operations/:id" element={<LifecycleOperationPage />} />
            <Route path="lifecycle-simulation" element={<LifecycleSimulationPage />} />
            <Route path="lifecycle-policy" element={<LifecyclePolicyPage />} />
            <Route path="provisioning-setup" element={<ProvisioningSetupPage />} />
            <Route path="sources" element={<SourcesPage />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the editor. */}
            <Route path="sources/new" element={<SourceDetailPage />} />
            <Route path="person-sources/new" element={<PersonSourceDetailPage />} />
            <Route path="person-sources/:id" element={<PersonSourceDetailPage />} />
            <Route
              path="person-import-runs/:id"
              element={<PersonImportRunDetailPage />}
            />
            <Route path="sources/:id" element={<SourceDetailPage />} />
            {/* Runs are a tab of Sources now — a run is a source's history,
                not a peer of it. Redirected rather than dropped: the path is
                in bookmarks and in links from run detail pages. */}
            <Route path="sync-runs" element={<Navigate to="/admin/sources?tab=runs" replace />} />
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
            {/* One destination for the whole request pipeline. The five old
                paths redirect: they are linked from approval emails, which
                outlive any navigation change. */}
            <Route path="requests" element={<RequestsPage />} />
            <Route path="automate/products" element={<Navigate to="/admin/requests?tab=catalog" replace />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the editor. */}
            <Route path="automate/products/new" element={<ProductEditorPage />} />
            <Route path="automate/products/:id" element={<ProductEditorPage />} />
            <Route path="automate/workflows" element={<Navigate to="/admin/requests?tab=workflows" replace />} />
            <Route path="automate/requests" element={<Navigate to="/admin/requests?tab=queue" replace />} />
            <Route path="automate/requests/:id" element={<RequestDetailAdminPage />} />
            <Route path="automate/sweeps" element={<Navigate to="/admin/requests?tab=sweeps" replace />} />
            <Route path="automate/tasks" element={<Navigate to="/admin/requests?tab=tasks" replace />} />
            <Route path="automate/sweeps/:id" element={<SweepDetailPage />} />
            {/* Relative paths, and the literal segment before the parametric one. */}
            {/* One governance destination. The seven old paths redirect —
                they appear in exported reports and in audit tickets. */}
            <Route path="govern" element={<GovernPage />} />
            <Route path="govern/findings" element={<Navigate to="/admin/govern?tab=findings" replace />} />
            <Route path="govern/snapshots" element={<Navigate to="/admin/govern?tab=snapshots" replace />} />
            <Route path="govern/snapshots/:id" element={<GovernSnapshotDetailPage />} />
            <Route path="govern/reports" element={<Navigate to="/admin/govern?tab=reports" replace />} />
            <Route path="govern/campaigns" element={<Navigate to="/admin/govern?tab=reviews" replace />} />
            {/* Before the parametric route, so "new" is a page rather than an
                id that will 404 on its way to the detail screen. */}
            <Route path="govern/campaigns/new" element={<GovernCampaignNewPage />} />
            <Route path="govern/campaigns/:id" element={<GovernCampaignDetailPage />} />
            <Route path="govern/batches/:id" element={<GovernBatchPage />} />
            <Route path="govern/sod" element={<Navigate to="/admin/govern?tab=sod" replace />} />
            <Route path="govern/orphans" element={<Navigate to="/admin/govern?tab=orphans" replace />} />
            <Route path="govern/integrity" element={<Navigate to="/admin/govern?tab=integrity" replace />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="applications/:id" element={<ApplicationDetailPage />} />
            <Route path="policy" element={<PoliciesPage />} />
            {/* Attention is the audit log filtered, not a second place. */}
            <Route path="activity" element={<ActivityPage />} />
            <Route path="operations" element={<OperationsPage />} />
            <Route path="privacy" element={<PrivacyPage />} />
            <Route path="privacy/:id" element={<PrivacyCasePage />} />
            <Route path="audit" element={<Navigate to="/admin/activity?tab=all" replace />} />
            <Route path="exports" element={<Navigate to="/admin/activity?tab=exports" replace />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="settings" element={<TenantSettingsPage />} />
            {/* Branding and webhooks are tabs of Settings. Redirected, not
                dropped: both paths are linked from the tenant docs. */}
            <Route path="branding" element={<Navigate to="/admin/settings?tab=branding" replace />} />
            <Route path="webhooks" element={<Navigate to="/admin/settings?tab=webhooks" replace />} />
            <Route path="incidents" element={<Navigate to="/admin/activity?tab=attention" replace />} />
            <Route path="updates" element={<UpdatesPage />} />
            <Route path="*" element={<Navigate to="/admin/users" replace />} />
          </Routes>
          </Suspense>
      </div>
    </AppShell>
  );
}
