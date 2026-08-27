import { Tabs } from '../../components/Tabs.js';
import { PageHeader } from './PageHeader.js';
import { SettingsSignInTab } from './SettingsSignInTab.js';
import { BrandingTab } from './BrandingTab.js';
import { WebhooksTab } from './WebhooksTab.js';

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
          { id: 'branding', label: 'Branding', content: <BrandingTab /> },
          { id: 'webhooks', label: 'Webhooks', content: <WebhooksTab /> },
        ]}
      />
    </>
  );
}
