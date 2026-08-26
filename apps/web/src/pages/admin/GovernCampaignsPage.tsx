import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  dueAt: string;
  originalDueAt: string;
  coveragePercent: number | null;
  totalItems: number;
  certifiedItems: number;
  revokedItems: number;
  requiresChangeItems: number;
  mootItems: number;
  undecidedItems: number;
  blockedItems: number;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';
const TONE: Record<string, Tone> = {
  draft: 'neutral',
  open: 'primary',
  executing: 'warning',
  closed_complete: 'active',
  closed_incomplete: 'warning',
};

/**
 * THE ONE RULE OF THIS SCREEN: the headline number never appears alone.
 *
 * "94% covered" is the sentence a governance product exists to make somebody
 * say out loud, and it is worthless without its denominator and the four counts
 * that add up to it. A closed campaign whose coverage is 94% because 300 of its
 * items were mooted is a different fact from one where 300 people decided, and
 * a percentage on its own cannot tell them apart.
 */
function Coverage({ campaign }: { campaign: CampaignRow }) {
  if (campaign.coveragePercent === null) {
    return <span className="text-muted">not yet closed</span>;
  }
  return (
    <>
      <strong className="text-ink">{campaign.coveragePercent}% covered</strong>
      <span className="ml-2 text-muted">
        of {campaign.totalItems} items: {campaign.certifiedItems} certified,{' '}
        {campaign.revokedItems} revoked, {campaign.requiresChangeItems} require a change,{' '}
        {campaign.mootItems} moot, {campaign.undecidedItems} undecided
      </span>
    </>
  );
}

export function GovernCampaignsPage() {
  const { data, error, loading } = useApiResource<{ campaigns: CampaignRow[] }>(
    '/api/admin/govern/campaigns',
  );
  const campaigns = data?.campaigns ?? [];

  return (
    <>
      <PageHeader
        title="Access reviews"
        description="A campaign is a scope, a set of reviewers and a due date, frozen against one snapshot. Nothing in it removes anything until somebody confirms a revocation batch."
        actions={
          <Link to="/admin/govern/campaigns/new">
            <Button variant="primary" size="sm">
              New campaign
            </Button>
          </Link>
        }
      />

      {error !== null && <Alert tone="danger">{error}</Alert>}
      {loading && <SkeletonRows rows={5} cols={4} />}

      {!loading && campaigns.length === 0 && (
        <Empty
          title="No campaigns yet"
          action={
            // The empty state TOLD the reader to scope a review and offered no
            // way to. Every endpoint behind this link already existed.
            <Link to="/admin/govern/campaigns/new">
              <Button variant="primary" size="sm">
                New campaign
              </Button>
            </Link>
          }
        >
          A campaign is built against a snapshot. Take one first, then scope the review to the
          systems and people it should cover.
        </Empty>
      )}

      {campaigns.length > 0 && (
        <Panel title="Campaigns">
          <table className="w-full text-left">
            <thead className="border-b border-border-subtle text-sm text-muted">
              <tr>
                <th className="px-4 py-2">Campaign</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Due</th>
                <th className="px-4 py-2">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-2">
                    <Link className="text-ink underline" to={`/admin/govern/campaigns/${campaign.id}`}>
                      {campaign.name}
                    </Link>
                    {campaign.blockedItems > 0 && (
                      <span className="ml-2 text-muted">
                        {campaign.blockedItems} item(s) resolved to nobody
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Status tone={TONE[campaign.status] ?? 'neutral'}>
                      {campaign.status.replace(/_/g, ' ')}
                    </Status>
                  </td>
                  <td className="px-4 py-2">
                    {new Date(campaign.dueAt).toLocaleDateString()}
                    {/* An extension is a recorded fact, not a silent edit of the
                        date: a campaign that closes on time because its due date
                        moved four times is not a campaign that closed on time. */}
                    {campaign.dueAt !== campaign.originalDueAt && (
                      <span className="ml-2 text-muted">
                        extended from {new Date(campaign.originalDueAt).toLocaleDateString()}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Coverage campaign={campaign} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
