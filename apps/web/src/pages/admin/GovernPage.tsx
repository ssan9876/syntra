import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { GovernFindingsTab } from './GovernFindingsTab.js';
import { GovernOrphansTab } from './GovernOrphansTab.js';
import { GovernCampaignsTab } from './GovernCampaignsTab.js';
import { GovernReportsTab } from './GovernReportsTab.js';
import { GovernSnapshotsTab } from './GovernSnapshotsTab.js';
import { GovernSodTab } from './GovernSodTab.js';
import { GovernIntegrityTab } from './GovernIntegrityTab.js';

interface Finding {
  id: string;
  status?: string;
}

interface Proposal {
  id: string;
}

interface CampaignRow {
  id: string;
  status: string;
}

/**
 * Governance: what is wrong, who is reviewing it, and what the evidence is.
 *
 * Seven links, all gated on `govern.read`, all reading the same module. The
 * length alone was the problem: an administrator opening "Governance" to find
 * out whether anything needed doing had to read seven labels and guess which
 * of them held the answer — and the answer was spread across three of them.
 *
 * All seven survive as tabs rather than being folded into three, because they
 * are genuinely seven different objects: a finding is not an orphan proposal,
 * and a snapshot is not a report built from one. Compressing them would have
 * required a nested level, which is a worse version of the same problem. What
 * fixes the scanning cost is not fewer tabs — it is that the cards above them
 * answer "does anything need doing" before the strip is read at all, so the
 * seven are only ever reached deliberately.
 *
 * Ordered by urgency rather than by module: findings and orphans are things
 * that are wrong now, reviews and reports are periodic, and integrity is
 * something you check rather than work.
 */
export function GovernPage() {
  const findings = useApiResource<{ findings: Finding[] }>('/api/admin/govern/findings');
  const orphans = useApiResource<{ proposals: Proposal[] }>('/api/admin/govern/orphans');
  const campaigns = useApiResource<{ campaigns: CampaignRow[] }>('/api/admin/govern/campaigns');

  const findingRows = findings.data?.findings ?? [];
  const orphanRows = orphans.data?.proposals ?? [];
  const campaignRows = campaigns.data?.campaigns ?? [];

  const open = findingRows.filter((f) => f.status !== 'resolved' && f.status !== 'accepted').length;
  const running = campaignRows.filter((c) => c.status === 'active' || c.status === 'open').length;

  const error = findings.error ?? orphans.error ?? campaigns.error;

  return (
    <>
      <PageHeader title="Governance" />

      {error && <Alert tone="danger">{error}</Alert>}

      <StatGrid>
        <StatCard label="Open findings" value={open} tone="danger" quietWhenZero to="/admin/govern?tab=findings" />
        <StatCard label="Orphan accounts" value={orphanRows.length} tone="warning" quietWhenZero to="/admin/govern?tab=orphans" />
        <StatCard label="Reviews running" value={running} to="/admin/govern?tab=reviews" />
      </StatGrid>

      <Tabs
        label="Governance"
        tabs={[
          { id: 'findings', label: 'Findings', badge: open || undefined, content: <GovernFindingsTab /> },
          { id: 'orphans', label: 'Orphans', badge: orphanRows.length || undefined, content: <GovernOrphansTab /> },
          { id: 'reviews', label: 'Access reviews', badge: running || undefined, content: <GovernCampaignsTab /> },
          { id: 'reports', label: 'Reports', content: <GovernReportsTab /> },
          { id: 'snapshots', label: 'Snapshots', content: <GovernSnapshotsTab /> },
          { id: 'sod', label: 'Segregation of duties', content: <GovernSodTab /> },
          { id: 'integrity', label: 'Audit integrity', content: <GovernIntegrityTab /> },
        ]}
      />
    </>
  );
}
