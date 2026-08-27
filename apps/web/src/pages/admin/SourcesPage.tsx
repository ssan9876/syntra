import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { SourcesTab } from './SourcesTab.js';
import { SyncRunsTab } from './SyncRunsTab.js';

interface SourceRow {
  id: string;
  enabled?: boolean;
}

interface RunRow {
  id: string;
  status: string;
}

/**
 * Directory sources, and what their runs did.
 *
 * A run is not a peer of a source — it is a source's history. Listing them as
 * two destinations meant the sources page had to end by mentioning runs ("…
 * before a sync run proposes changes") and the runs page had to open by
 * mentioning sources ("what each run against a directory source read"), while
 * the runs table separately re-fetched `/api/admin/sources` purely to turn an
 * id back into a name it should never have lost.
 *
 * The cards lead with the only question anybody opens this screen to ask,
 * which is whether the last run worked.
 */
export function SourcesPage() {
  const sources = useApiResource<{ sources: SourceRow[] }>('/api/admin/sources');
  const runs = useApiResource<{ runs: RunRow[] }>('/api/admin/sync-runs');

  const sourceRows = sources.data?.sources ?? [];
  const runRows = runs.data?.runs ?? [];
  const failed = runRows.filter((run) => run.status === 'failed').length;

  const error = sources.error ?? runs.error;

  return (
    <>
      <PageHeader title="Directory sources" />

      {error && <Alert tone="danger">{error}</Alert>}

      <StatGrid>
        <StatCard label="Sources" value={sourceRows.length} to="/admin/sources?tab=sources" />
        <StatCard label="Runs" value={runRows.length} to="/admin/sources?tab=runs" />
        <StatCard
          label="Failed runs"
          value={failed}
          tone="danger"
          quietWhenZero
          to="/admin/sources?tab=runs"
        />
      </StatGrid>

      <Tabs
        label="Directory sources"
        tabs={[
          { id: 'sources', label: 'Sources', badge: sourceRows.length || undefined, content: <SourcesTab /> },
          { id: 'runs', label: 'Runs', badge: runRows.length || undefined, content: <SyncRunsTab /> },
        ]}
      />
    </>
  );
}
