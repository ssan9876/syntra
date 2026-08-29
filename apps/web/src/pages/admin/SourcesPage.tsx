import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { SourcesTab } from './SourcesTab.js';
import { PersonSourcesTab } from './PersonSourcesTab.js';
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
  const personSources = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/person-sources',
  );
  const runs = useApiResource<{ runs: RunRow[] }>('/api/admin/sync-runs');
  const importRuns = useApiResource<{ runs: RunRow[] }>('/api/admin/person-import-runs');

  const sourceRows = sources.data?.sources ?? [];
  const personSourceRows = personSources.data?.sources ?? [];
  const runRows = [...(runs.data?.runs ?? []), ...(importRuns.data?.runs ?? [])];
  const failed = runRows.filter((run) => run.status === 'failed').length;
  // A blocked run is the one state that needs somebody to act, and it is
  // invisible if it is only ever a row in a list.
  const blocked = runRows.filter((run) => run.status === 'blocked').length;

  const error = sources.error ?? personSources.error ?? runs.error ?? importRuns.error;

  return (
    <>
      <PageHeader title="Sources" />

      {error && <Alert tone="danger">{error}</Alert>}

      <StatGrid>
        <StatCard
          label="Sources"
          value={sourceRows.length + personSourceRows.length}
          to="/admin/sources?tab=sources"
        />
        <StatCard label="Runs" value={runRows.length} to="/admin/sources?tab=runs" />
        <StatCard
          label="Failed runs"
          value={failed}
          tone="danger"
          quietWhenZero
          to="/admin/sources?tab=runs"
        />
        <StatCard
          label="Blocked runs"
          value={blocked}
          tone="warning"
          quietWhenZero
          to="/admin/sources?tab=runs"
        />
      </StatGrid>

      {/*
        * One Runs tab, not two.
        *
        * "What ran last night and what did it do" is one question an
        * administrator asks each morning, and two tabs means checking both
        * every time. A run is still a source's history rather than its peer:
        * it is reachable from the source, and it is not a destination in the
        * navigation.
        */}
      <Tabs
        label="Sources"
        tabs={[
          {
            id: 'sources',
            label: 'Directory',
            badge: sourceRows.length || undefined,
            content: <SourcesTab />,
          },
          {
            id: 'people',
            label: 'People',
            badge: personSourceRows.length || undefined,
            content: <PersonSourcesTab />,
          },
          {
            id: 'runs',
            label: 'Runs',
            badge: runRows.length || undefined,
            content: <SyncRunsTab />,
          },
        ]}
      />
    </>
  );
}
