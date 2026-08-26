import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface ReviewItem {
  id: string;
  subjectKey: string;
  subjectName: string;
  resourceKind: string;
  resourceName: string;
  systemName: string;
  provenance: string;
  observedAt: string;
  observedVia: string;
  lastCertifiedAt: string | null;
  lastCertifiedBy: string | null;
  coverageStatus: string;
  sourceAgeHours: number | null;
  sourceSlaHours: number;
  riskFlags: string[];
  campaign: { id: string; name: string; dueAt: string; allowBulkCertify: boolean };
}

const HIGH_RISK: Record<string, string> = {
  unattributable: 'nothing in Syntra explains this access',
  privileged: 'this is privileged access',
  sod_violation: 'this holding is part of an open segregation-of-duties violation',
  stale: 'the system this came from has not been read recently enough',
  needs_review: 'the person’s job changed and this access stopped matching it',
};

const carveOut = (item: ReviewItem): string | null => {
  const flag = item.riskFlags.find((f) => f in HIGH_RISK);
  if (flag !== undefined) return HIGH_RISK[flag]!;
  if (item.coverageStatus !== 'complete') return 'the system this came from was not read in full';
  return null;
};

export function MyReviewsPage() {
  const { data, error, loading, reload } = useApiResource<{ items: ReviewItem[] }>(
    '/api/portal/govern/reviews',
  );
  const [groupBy, setGroupBy] = useState<'subject' | 'resource'>('subject');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // WHICH ITEM IS IN FLIGHT, not a single boolean. The queue is a page of
  // rows and disabling all of them while one is being decided would make a
  // twenty-item review a twenty-round-trip queue.
  const [deciding, setDeciding] = useState<string | null>(null);

  const items = data?.items ?? [];
  // Grouped by subject AND by resource at the reviewer's choice; the decisions
  // underneath are always per pair, which is what makes a partial answer
  // representable.
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const key = groupBy === 'subject' ? item.subjectName : item.resourceName;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const decide = (item: ReviewItem, decision: 'certify' | 'revoke') => {
    // A revoke is a removal, and a double-click sent two: two decisions in the
    // audit trail for one item, and under `quorum: 'any'` a second decision
    // the state machine then has to reconcile against the first.
    if (deciding !== null) return;
    const needsComment = decision === 'revoke' || item.riskFlags.includes('unattributable');
    const comment = needsComment
      ? window.prompt(
          decision === 'revoke'
            ? 'Why are you removing this? A revoke decision needs a comment.'
            : 'Nothing in Syntra explains this access. Say who confirmed it is fine, and why.',
        )
      : null;
    if (needsComment && (comment === null || comment.trim() === '')) return;

    setDeciding(item.id);
    void api(`/api/portal/govern/reviews/${item.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    })
      .then(() => {
        setActionError(null);
        reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'Could not record that decision.',
        ),
      )
      .finally(() => setDeciding(null));
  };

  /**
   * ONE REQUEST PER CAMPAIGN, because the queue spans campaigns and the
   * endpoint does not.
   *
   * The list shows every open campaign's items together -- which is right; a
   * reviewer has one queue, not one per campaign -- and any bulk-enabled item
   * gets a checkbox. The request carried `items[0].campaign.id`, and
   * `bulkCertify` filters on it, so ids belonging to any other campaign were
   * neither certified nor listed in `refused`. They vanished: the selection
   * cleared, the page reloaded, and nothing anywhere said that half of what
   * was ticked had not happened. A reviewer who believed they had certified
   * twelve items had certified five.
   *
   * Grouping here rather than reorganising the page by campaign, because the
   * page is right and the endpoint's scope is a server-side detail the
   * reviewer should not have to work around.
   */
  const certifySelected = async () => {
    const byCampaign = new Map<string, string[]>();
    for (const item of items) {
      if (!selected.has(item.id)) continue;
      byCampaign.set(item.campaign.id, [
        ...(byCampaign.get(item.campaign.id) ?? []),
        item.id,
      ]);
    }

    setBulkBusy(true);
    setActionError(null);
    try {
      const results = await Promise.all(
        [...byCampaign].map(([campaignId, itemIds]) =>
          api<{ certified: number; refused: { reason: string }[] }>(
            '/api/portal/govern/reviews/bulk-certify',
            { method: 'POST', body: JSON.stringify({ campaignId, itemIds }) },
          ),
        ),
      );
      // EVERY refusal from EVERY request. Reporting one campaign's and
      // dropping the rest would be the same silence in a smaller shape.
      const refused = results.flatMap((r) => r.refused);
      setActionError(
        refused.length === 0
          ? null
          : `${refused.length} item(s) were not certified: ${refused
              .map((r) => r.reason)
              .join('; ')}`,
      );
      setSelected(new Set());
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Could not certify those items.',
      );
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-ink">My reviews</h1>
        <p className="mt-1 text-muted">
          Certifying an item records that you decided to keep it, against the facts shown, at the
          time you clicked. It does not say the access is appropriate — only that you looked.
        </p>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {loading && <SkeletonRows rows={6} cols={4} />}

      {!loading && items.length === 0 && (
        <Empty title="Nothing is waiting for you">
          When a review names you, it arrives here and in your inbox.
        </Empty>
      )}

      {items.length > 0 && (
        <>
          <div className="mb-4 flex gap-2">
            <Button
              size="sm"
              variant={groupBy === 'subject' ? 'primary' : 'secondary'}
              onClick={() => setGroupBy('subject')}
            >
              Group by person
            </Button>
            <Button
              size="sm"
              variant={groupBy === 'resource' ? 'primary' : 'secondary'}
              onClick={() => setGroupBy('resource')}
            >
              Group by resource
            </Button>
            {items.some((item) => item.campaign.allowBulkCertify) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={selected.size === 0 || bulkBusy}
                loading={bulkBusy}
                onClick={() => void certifySelected()}
              >
                Certify selected ({selected.size})
              </Button>
            )}
          </div>

          {[...groups].map(([name, groupItems]) => (
            <Panel key={name} title={name} bodyClassName="divide-y divide-border-subtle">
              {groupItems.map((item) => {
                const reason = carveOut(item);
                return (
                  <div key={item.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-ink">
                          {groupBy === 'subject' ? item.resourceName : item.subjectName}
                          <span className="ml-2 text-muted">in {item.systemName}</span>
                        </p>
                        {/* How the person got it, in a sentence. */}
                        <p className="text-muted">{item.provenance}</p>
                        <p className="text-muted">
                          Last confirmed by {item.observedVia} on{' '}
                          {new Date(item.observedAt).toLocaleDateString()}.{' '}
                          {item.lastCertifiedAt === null
                            ? 'Never certified.'
                            : `Last certified by ${item.lastCertifiedBy} on ${new Date(item.lastCertifiedAt).toLocaleDateString()}.`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.riskFlags.map((flag) => (
                          <Status key={flag} tone="warning">
                            {flag.replace(/_/g, ' ')}
                          </Status>
                        ))}
                      </div>
                    </div>

                    {/* Section 8 rule 5: the reviewer is told BEFORE they decide,
                        on the item, and the decision records the age. */}
                    {item.coverageStatus !== 'complete' && (
                      <Alert tone="warning" title="You are deciding against data of a stated age">
                        {item.systemName} was last read {Math.round(item.sourceAgeHours ?? 0)} hours
                        ago, against a {item.sourceSlaHours}-hour SLA. You may well know the answer;
                        your decision will record that it was made against data of that age, and the
                        evidence bundle will say so too.
                      </Alert>
                    )}

                    {/* The carve-out, in words rather than as a disabled button
                        with no explanation. */}
                    {reason !== null && (
                      <p className="text-muted">
                        This one has to be decided on its own, with a comment, because {reason}.
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      {reason === null && item.campaign.allowBulkCertify && (
                        <label className="flex items-center gap-1.5 text-muted">
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(item.id);
                              else next.delete(item.id);
                              setSelected(next);
                            }}
                          />
                          include in bulk
                        </label>
                      )}
                      <Button
                        size="sm"
                        disabled={deciding !== null}
                        loading={deciding === item.id}
                        onClick={() => decide(item, 'certify')}
                      >
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deciding !== null}
                        loading={deciding === item.id}
                        onClick={() => decide(item, 'revoke')}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}
