import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Finding {
  id: string;
  kind: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  subjectRefType: string;
  subjectRefId: string;
  detail: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  ownerPersonId: string | null;
  dueAt: string | null;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';

const SEVERITY_TONE: Record<Finding['severity'], Tone> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

/**
 * Plain language, not enum values. A finding queue is worked by a person who
 * has not read the schema, and `access_without_contract` is a column name.
 */
const HEADLINE: Record<string, string> = {
  unattributable_holding: 'Nothing in Syntra explains this access',
  unexplained_gain: 'Access appeared and Syntra did not cause it',
  access_without_contract: 'Holds access with no active contract',
  orphan_account: 'An account that belongs to nobody Syntra knows',
  privileged_uncertified: 'Privileged access that nobody has reviewed',
  stale_source: 'A source nobody has read recently enough to trust',
  coverage_gap: 'A region of the world this snapshot could not describe',
  campaign_low_coverage: 'A review closed with too many items undecided',
  dispatch_not_applied: 'A revocation was sent and never confirmed',
  sod_violation: 'One person holds both sides of a duty separation',
  sod_laundering: 'Two people approved each other into opposite sides of a rule',
  approval_reciprocity: 'Two people repeatedly decide for each other',
  // No `lapsed_exception` row: a lapse ages the violation's OWN `sod_violation`
  // finding, so there is no second row to headline. A map entry for a kind
  // nothing raises is a queue column that is always empty and always looks
  // like a bug.
  audit_chain_broken: 'The audit log cannot be shown to be intact',
  no_human_decision: 'Access granted by a workflow with no approver',
  unmergeable_actor: 'An account with no linked person is making decisions',
};

/**
 * The order the queue is worked in. NOT alphabetical, and not by date:
 * uncomfortable first, because the point of this screen is the things nobody
 * has an explanation for.
 */
const KIND_ORDER = [
  // First, and above `unattributable_holding`, because it is the only finding
  // that says the record itself may not be trustworthy. Everything below it is
  // a question about access; this one is a question about the evidence.
  'audit_chain_broken',
  'unattributable_holding',
  'unexplained_gain',
  'access_without_contract',
  'stale_source',
  'dispatch_not_applied',
  'orphan_account',
  'sod_laundering',
  'sod_violation',
  'privileged_uncertified',
  'no_human_decision',
  'coverage_gap',
  'unmergeable_actor',
  'campaign_low_coverage',
  'approval_reciprocity',
];

const describeFinding = (finding: Finding): string => {
  const detail = finding.detail;
  if (typeof detail['resourceName'] === 'string') {
    return `${detail['resourceName']}${
      typeof detail['systemName'] === 'string' ? ` in ${detail['systemName']}` : ''
    }`;
  }
  if (typeof detail['holdingCount'] === 'number') {
    return `${detail['holdingCount']} holding(s)`;
  }
  if (typeof detail['sourceName'] === 'string') return String(detail['sourceName']);
  return finding.subjectRefId;
};

export function GovernFindingsPage() {
  const [status, setStatus] = useState<'open' | 'accepted' | 'resolved'>('open');
  const { data, error, loading, reload } = useApiResource<{ findings: Finding[] }>(
    `/api/admin/govern/findings?status=${status}`,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const sorted = [...(data?.findings ?? [])].sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    return a.firstSeenAt.localeCompare(b.firstSeenAt);
  });

  return (
    <>
      <PageHeader
        title="Findings"
        description="What Govern found and nobody has explained yet, uncomfortable first."
        actions={
          <div className="flex gap-2">
            {(['open', 'accepted', 'resolved'] as const).map((s) => (
              <Button
                key={s}
                variant={status === s ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setStatus(s)}
              >
                {s === 'open' ? 'Open' : s === 'accepted' ? 'Accepted' : 'Resolved'}
              </Button>
            ))}
          </div>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={8} cols={5} />}

          {!loading && sorted.length === 0 && (
            <div className="p-6">
              <Empty title="Nothing to look at here yet">
                Build a snapshot and the standing findings appear on their own — access nobody
                can explain, access held by people with no contract, orphan accounts, and
                sources nobody has read.
              </Empty>
            </div>
          )}

          {!loading && sorted.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Which</th>
                  <th>Severity</th>
                  <th>First seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((finding) => (
                  <tr key={finding.id}>
                    <td className="text-ink">
                      {HEADLINE[finding.kind] ?? finding.kind}
                    </td>
                    <td>{describeFinding(finding)}</td>
                    <td>
                      <Status tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Status>
                    </td>
                    <td>
                      {new Date(finding.firstSeenAt).toLocaleDateString()}
                    </td>
                    <td className="text-right">
                      {finding.status === 'open' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const reason = window.prompt(
                              'Why is this acceptable? An acceptance needs a reason and an expiry.',
                            );
                            if (reason === null || reason.trim() === '') return;
                            const until = window.prompt('Accept until (YYYY-MM-DD)?');
                            if (until === null || until.trim() === '') return;
                            void api(`/api/admin/govern/findings/${finding.id}/accept`, {
                              method: 'POST',
                              body: JSON.stringify({ reason, until }),
                            })
                              .then(() => {
                                setActionError(null);
                                reload();
                              })
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof ApiError
                                    ? (cause.problem.detail ?? cause.problem.title)
                                    : 'Could not accept this finding.',
                                ),
                              );
                          }}
                        >
                          Accept with an expiry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
