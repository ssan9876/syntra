import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { RequestQueueTab } from './RequestQueueTab.js';
import { CatalogTab } from './CatalogTab.js';
import { WorkflowsTab } from './WorkflowsTab.js';
import { SweepsTab } from './SweepsTab.js';
import { DelegatedTasksTab } from './DelegatedTasksTab.js';

interface QueueRow {
  id: string;
  status: string;
}

interface ProductRow {
  id: string;
}

/**
 * Requests: what people may ask for, how it gets approved, and what is stuck.
 *
 * Five links, all under one heading, all gated on `automate.read`, and all
 * describing one pipeline: a catalog defines what can be asked for, a workflow
 * decides who approves it, the queue is what has been asked, sweeps take it
 * away again, and delegated tasks are the small things that skip the whole
 * mechanism. Presenting the stages of one pipeline as five destinations made
 * the reader assemble the pipeline themselves from five labels.
 *
 * The queue goes first because it is the only tab with anything time-critical
 * in it. The other four are configuration somebody visits when changing how
 * the pipeline works, not when working it.
 */
export function RequestsPage() {
  const queue = useApiResource<{ requests: QueueRow[] }>('/api/admin/automate/requests');
  const products = useApiResource<{ products: ProductRow[] }>('/api/admin/automate/products');

  const requests = queue.data?.requests ?? [];
  const productRows = products.data?.products ?? [];

  // "Stuck" is the word the old queue page used in its own description. It
  // is a real state — awaiting a decision nobody is coming to make — and it
  // is the reason anybody opens this screen unprompted.
  const pending = requests.filter((r) => r.status === 'pending').length;
  const failed = requests.filter((r) => r.status === 'failed').length;

  const error = queue.error ?? products.error;

  return (
    <>
      <PageHeader title="Requests" />

      {error && <Alert tone="danger">{error}</Alert>}

      <StatGrid>
        <StatCard label="Awaiting a decision" value={pending} tone="warning" quietWhenZero to="/admin/requests?tab=queue" />
        <StatCard label="Failed" value={failed} tone="danger" quietWhenZero to="/admin/requests?tab=queue" />
        <StatCard label="Requests" value={requests.length} to="/admin/requests?tab=queue" />
        <StatCard label="Catalog items" value={productRows.length} to="/admin/requests?tab=catalog" />
      </StatGrid>

      <Tabs
        label="Requests"
        tabs={[
          { id: 'queue', label: 'Queue', badge: pending || undefined, content: <RequestQueueTab /> },
          { id: 'catalog', label: 'Catalog', badge: productRows.length || undefined, content: <CatalogTab /> },
          { id: 'workflows', label: 'Workflows', content: <WorkflowsTab /> },
          { id: 'sweeps', label: 'Expiry sweeps', content: <SweepsTab /> },
          { id: 'tasks', label: 'Delegated tasks', content: <DelegatedTasksTab /> },
        ]}
      />
    </>
  );
}
