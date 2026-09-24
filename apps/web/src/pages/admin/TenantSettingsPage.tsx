import { Tabs } from '../../components/Tabs.js';
import { PageHeader } from './PageHeader.js';
import { SettingsSignInTab } from './SettingsSignInTab.js';
import { SettingsSessionsTab } from './SettingsSessionsTab.js';
import { BrandingTab } from './BrandingTab.js';
import { WebhooksTab } from './WebhooksTab.js';
import { TenantDeletionTab } from './TenantDeletionTab.js';
import { ChangeControlTab } from './ChangeControlTab.js';
import { BreakGlassTab } from './BreakGlassTab.js';

/**
 * Settings: how this organization signs in, what it looks like, and where it
 * sends what happens.
 *
 * Three links in the System group, all gated on `tenant.manage`, all
 * configuring the same tenant. Nobody arrives at "Branding" without already
 * being in settings; they arrived at the console's System group and read three
 * labels to work out which one held the thing they wanted. That is a menu
 * doing the job of a page.
 *
 * No summary cards here, deliberately. The other merged destinations lead
 * with figures because they report on a population that changes underneath
 * you. This one reports on a configuration that changes only when somebody
 * changes it, and a card counting "3 webhooks" would be decoration.
 */
export function TenantSettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs
        label="Settings"
        tabs={[
          { id: 'sign-in', label: 'Sign-in', content: <SettingsSignInTab /> },
          // The tenant-wide revoke lives here rather than on the Accounts
          // page: it acts on the organization, is gated on the same
          // `tenant.manage` as everything else on this page, and a button that
          // signs everyone out does not belong beside a list of individuals.
          { id: 'sessions', label: 'Sessions', content: <SettingsSessionsTab /> },
          { id: 'branding', label: 'Branding', content: <BrandingTab /> },
          { id: 'webhooks', label: 'Webhooks', content: <WebhooksTab /> },
          // Separation of duties for privileged changes, and emergency access.
          { id: 'change-control', label: 'Change control', content: <ChangeControlTab /> },
          { id: 'break-glass', label: 'Break-glass', content: <BreakGlassTab /> },
          { id: 'offboarding', label: 'Offboarding', content: <TenantDeletionTab /> },
        ]}
      />
    </>
  );
}
