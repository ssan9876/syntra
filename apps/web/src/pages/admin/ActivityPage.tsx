import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { IncidentsTab } from './IncidentsTab.js';
import { AuditTab } from './AuditTab.js';
import { ExportsTab } from './ExportsTab.js';
import { ATTENTION_URL, type AttentionSummary } from './attention.js';

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
  // Work waiting for a decision is counted with what is broken: both are
  // listed on the Attention tab, and a badge that left one out would say
  // "nothing" over a list that has something in it.
  const attention = useApiResource<AttentionSummary>(ATTENTION_URL);
  const rows = incidents.data?.incidents ?? [];
  const needs = rows.length + (typeof attention.data?.total === 'number' ? attention.data.total : 0);

  return (
    <>
      <PageHeader title="Activity" />

      {incidents.error && <Alert tone="danger">{incidents.error}</Alert>}

      <StatGrid>
        <StatCard
          label="Needs attention"
          value={needs}
          tone="danger"
          quietWhenZero
          to="/admin/activity?tab=attention"
        />
      </StatGrid>

      <Tabs
        label="Activity"
        tabs={[
          { id: 'attention', label: 'Attention', badge: needs || undefined, content: <IncidentsTab /> },
          { id: 'all', label: 'All events', content: <AuditTab /> },
          // Beside the log it most often copies. Every export -- the log's,
          // a Governance report's -- is followed, downloaded and revoked here.
          { id: 'exports', label: 'Exports', content: <ExportsTab /> },
        ]}
      />
    </>
  );
}
