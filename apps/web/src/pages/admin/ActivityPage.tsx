import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { IncidentsTab } from './IncidentsTab.js';
import { AuditTab } from './AuditTab.js';

interface Incident {
  id: string;
}

/**
 * Activity: what went wrong, and everything that happened.
 *
 * The same events, filtered two ways. "What needs attention" is the audit log
 * narrowed to the entries that represent a failure, and it existed as a
 * separate destination because the audit log is unusable as a place to notice
 * something — it is ordered, complete, and therefore enormous.
 *
 * That is a filter, not a location. Keeping it as one meant the System group
 * opened with a link whose label was a whole sentence ("What needs
 * attention"), because "Incidents" would not have explained itself. A tab
 * named "Attention" beside a tab named "All" needs no sentence: the pair
 * shows what the filter is.
 */
export function ActivityPage() {
  const incidents = useApiResource<{ incidents: Incident[] }>('/api/admin/incidents');
  const rows = incidents.data?.incidents ?? [];

  return (
    <>
      <PageHeader title="Activity" />

      {incidents.error && <Alert tone="danger">{incidents.error}</Alert>}

      <StatGrid>
        <StatCard
          label="Needs attention"
          value={rows.length}
          tone="danger"
          quietWhenZero
          to="/admin/activity?tab=attention"
        />
      </StatGrid>

      <Tabs
        label="Activity"
        tabs={[
          { id: 'attention', label: 'Attention', badge: rows.length || undefined, content: <IncidentsTab /> },
          { id: 'all', label: 'All events', content: <AuditTab /> },
        ]}
      />
    </>
  );
}
