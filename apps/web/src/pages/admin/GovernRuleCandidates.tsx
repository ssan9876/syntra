import { useState } from 'react';
import { Alert, Button, Empty, Meter, Panel, SkeletonRows, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

/**
 * The rules a snapshot's data already implies.
 *
 * Nothing here creates anything. A rule mined from current state encodes the
 * accidents along with the policy — including the ones the campaign on the
 * next page is about to revoke — so every row is a suggestion with its numbers
 * attached, and the decision stays with the reader.
 *
 * Loaded on a button rather than with the page: mining reads every holding in
 * the snapshot, and nobody opening a snapshot to check its freshness should
 * pay for that.
 */

interface Candidate {
  field: string;
  value: string;
  resourceKey: string;
  resourceName: string;
  holders: number;
  population: number;
  confidence: number;
  outsideHolders: number;
}

const FIELD_LABEL: Record<string, string> = {
  department: 'department',
  jobTitle: 'job title',
  location: 'location',
  employer: 'employer',
};

export function GovernRuleCandidates({ snapshotId }: { snapshotId: string }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function look() {
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ candidates: Candidate[] }>(
        `/api/admin/govern/snapshots/${snapshotId}/rule-candidates`,
      );
      setCandidates(result.candidates);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Those could not be worked out.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel
      title="Rules this data already follows"
      actions={
        <Button size="sm" variant="secondary" loading={loading} onClick={look}>
          {candidates === null ? 'Look for rules' : 'Look again'}
        </Button>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {loading && <SkeletonRows rows={4} cols={4} />}

      {candidates !== null && candidates.length === 0 && !loading && (
        <Empty title="No pattern strong enough to suggest">
          Nothing in this snapshot is held by enough of one department, job title,
          location or employer to be worth calling a rule.
        </Empty>
      )}

      {candidates !== null && candidates.length > 0 && !loading && (
        <Table>
          <thead>
            <tr>
              <th>Suggested rule</th>
              <th>How true it already is</th>
              <th>Held elsewhere</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={`${c.field}:${c.value}:${c.resourceKey}`}>
                <td className="text-ink">
                  Everyone whose {FIELD_LABEL[c.field] ?? c.field} is{' '}
                  <strong className="font-medium">{c.value}</strong> gets{' '}
                  <strong className="font-medium">{c.resourceName}</strong>
                </td>
                <td>
                  {/* The bar and the fraction together. The percentage alone
                      hides the denominator, and 100% of five people is not the
                      same claim as 96% of four hundred. */}
                  <Meter
                    percent={c.confidence * 100}
                    label={`of ${c.value} already hold it`}
                    tone={c.confidence >= 0.95 ? 'success' : 'warning'}
                  />
                  <span className="mt-1 block tabular-nums text-muted">
                    {c.holders} of {c.population}
                  </span>
                </td>
                <td className="tabular-nums">
                  {/* The half a confidence figure hides: a rule at 100% over
                      six people, where forty others hold the same thing, is a
                      description of six people and not of the resource. */}
                  {c.outsideHolders === 0
                    ? 'nobody else'
                    : `${c.outsideHolders} others, for other reasons`}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
