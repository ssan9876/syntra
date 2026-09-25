import { Link } from 'react-router-dom';
import {
  Alert,
  buttonClasses,
  Empty,
  Meter,
  Panel,
  SkeletonRows,
  StateBadge,
  Table,
  type State,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';

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

/**
 * A campaign's status in the console's state language. `open` is waiting on
 * its reviewers, so it is pending rather than something for this reader to
 * act on; a campaign that closed with items undecided needs a look.
 */
const CAMPAIGN_STATE: Record<string, { state: State; label: string }> = {
  draft: { state: 'setup', label: 'Draft' },
  open: { state: 'pending', label: 'Open for review' },
  executing: { state: 'running', label: 'Executing' },
  closed_complete: { state: 'healthy', label: 'Closed, complete' },
  closed_incomplete: { state: 'attention', label: 'Closed, incomplete' },
};

export function CampaignState({ status }: { status: string }) {
  const known = CAMPAIGN_STATE[status];
  return (
    <StateBadge state={known?.state ?? 'setup'}>
      {known?.label ?? status.replace(/_/g, ' ')}
    </StateBadge>
  );
}

/**
 * THE ONE RULE OF THIS SCREEN: the headline number never appears alone.
 *
 * "94% covered" is the sentence a governance product exists to make somebody
 * say out loud, and it is worthless without its denominator and the four counts
 * that add up to it. A closed campaign whose coverage is 94% because 300 of its
 * items were mooted is a different fact from one where 300 people decided, and
 * a percentage on its own cannot tell them apart.
 */
/**
 * One campaign's coverage, in a table cell.
 *
 * This was a single running sentence — "62% covered of 240 items: 130
 * certified, 8 revoked, 2 require a change, 4 moot, 96 undecided" — set in one
 * `td`. In a column beside three narrow ones it wrapped to four lines, so
 * every row was four rows tall and a page of campaigns could not be compared
 * by eye at all, which is the only thing this list is for.
 *
 * The bar carries the comparison, the figure carries the value, and the
 * breakdown stays available underneath at caption weight. Nothing is removed:
 * an auditor still gets every number without opening the campaign.
 */
function Coverage({ campaign }: { campaign: CampaignRow }) {
  if (campaign.coveragePercent === null) {
    return <span className="text-muted">not yet closed</span>;
  }
  return (
    <div className="min-w-[11rem] space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <strong className="tabular-nums text-ink">{campaign.coveragePercent}%</strong>
        <span className="text-sm text-muted tabular-nums">
          of {campaign.totalItems}
        </span>
      </div>
      <Meter
        percent={campaign.coveragePercent}
        label={`covered of ${campaign.totalItems} items`}
      />
      <p className="text-sm text-muted text-pretty">
        {campaign.certifiedItems} certified · {campaign.revokedItems} revoked ·{' '}
        {campaign.requiresChangeItems} require a change · {campaign.mootItems} moot ·{' '}
        {campaign.undecidedItems} undecided
      </p>
    </div>
  );
}

export function GovernCampaignsTab() {
  const { data, error, loading } = useApiResource<{ campaigns: CampaignRow[] }>(
    '/api/admin/govern/campaigns',
  );
  const campaigns = data?.campaigns ?? [];

  return (
    <>
      {/* The action sits with the table it acts on. One header above
          several tabs would need a word saying which tab its button
          applied to. */}
      <div className="mb-4 flex justify-end">
        <Link to="/admin/govern/campaigns/new" className={buttonClasses('primary', 'sm')}>
          New campaign
        </Link>
      </div>

      {error !== null && <Alert tone="danger">{error}</Alert>}
      {!data && loading && <SkeletonRows rows={5} cols={4} />}

      {data && campaigns.length === 0 && (
        <Empty
          title="No campaigns yet"
          action={
            // The empty state TOLD the reader to scope a review and offered no
            // way to. Every endpoint behind this link already existed.
            <Link to="/admin/govern/campaigns/new" className={buttonClasses('primary', 'sm')}>
              New campaign
            </Link>
          }
        >
          A campaign is built against a snapshot. Take one first, then scope the review to the
          systems and people it should cover.
        </Empty>
      )}

      {campaigns.length > 0 && (
        <Panel title="Campaigns">
          <Table>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                <th scope="col">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>
                    <Link className="link" to={`/admin/govern/campaigns/${campaign.id}`}>
                      {campaign.name}
                    </Link>
                    {campaign.blockedItems > 0 && (
                      <span className="ml-2 text-muted">
                        {campaign.blockedItems} item(s) resolved to nobody
                      </span>
                    )}
                  </td>
                  <td>
                    <CampaignState status={campaign.status} />
                  </td>
                  <td>
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
                  <td>
                    <Coverage campaign={campaign} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </>
  );
}
