import { Link, useParams } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Holding {
  entitlementId: string;
  displayName: string;
  origin: string;
  ruleId: string | null;
  ruleName: string | null;
  contractId: string | null;
  contractDescription: string | null;
}

interface Access {
  personId: string;
  accounts: {
    targetSystemId: string;
    targetName: string;
    correlationKey: string;
    status: string;
    anchor: string | null;
    entitlements: Holding[];
  }[];
}

const ORIGINS: Record<string, string> = {
  rule: 'A business rule',
  discovered: 'Found at the target, not granted here',
  manual: 'Granted by hand',
};

/**
 * The six `TargetAccount.status` values, read as three different kinds of
 * thing rather than as "active" and "not active".
 *
 * `active`, `disabled` and `archived` are states somebody decided on: the
 * deprovisioning ladder walks an account down them on purpose, and `inactive`
 * is the right tone — deliberately legible rather than faded, because hiding a
 * deactivation makes the directory unauditable.
 *
 * The other three are not decisions:
 *
 * - `pending` is a reservation. `run-service.ts` writes the row to hold the
 *   correlation key under the unique index before anything is written to the
 *   target, with a null anchor; nothing exists at the target yet.
 * - `missing_at_target` is `reconcile.ts` finding that the target no longer
 *   returns an anchor Syntra records. `plan.ts` proposes recreating it and
 *   marks that action `requiresConfirmation: true`, because it usually
 *   vanished because somebody deleted it deliberately.
 * - `conflict` is a write the target refused; `apply.ts` writes it with a
 *   `statusReason`, and reconciliation then proposes nothing for that person.
 *
 * Rendering all three in the same quiet badge as a deliberately disabled
 * leaver is three faults dressed as an intended state.
 */
const ACCOUNT_STATUS: Record<
  string,
  { tone: 'active' | 'inactive' | 'warning' | 'danger'; label: string; title: string }
> = {
  active: {
    tone: 'active',
    label: 'active',
    title: 'The account exists at the target and is enabled.',
  },
  disabled: {
    tone: 'inactive',
    label: 'disabled',
    title:
      'Disabled on purpose — a step on this target’s deprovisioning ladder.',
  },
  archived: {
    tone: 'inactive',
    label: 'archived',
    title:
      'Moved to the archive container with its managed entitlements stripped. Provision never deletes.',
  },
  pending: {
    tone: 'warning',
    label: 'pending — nothing at the target yet',
    title:
      'A reserved login. The row holds the correlation key so two runs cannot generate the same one; no account has been created at the target.',
  },
  missing_at_target: {
    tone: 'danger',
    label: 'missing at the target',
    title:
      'Syntra records this account and the target no longer returns its anchor. Recreating it is never automatic: it usually vanished because somebody deleted it deliberately.',
  },
  conflict: {
    tone: 'danger',
    label: 'conflict',
    title:
      'The target refused the last write to this account. Nothing further is proposed for this person here until it is resolved.',
  },
};

const accountStatus = (status: string) =>
  ACCOUNT_STATUS[status] ?? {
    tone: 'neutral' as const,
    label: status,
    title: 'A status this screen does not have a reading for.',
  };

export function PersonAccessPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useApiResource<Access>(
    `/api/admin/persons/${id}/access`,
  );

  return (
    <>
      <PageHeader
        title="Why does this person hold this?"
        description="Every target-system account and every entitlement on it, with the rule and the contract behind it."
      />

      <div className="space-y-6">
        {error && <Alert tone="danger">{error}</Alert>}

        {!error && loading && (
          <Panel>
            <SkeletonRows rows={6} cols={4} />
          </Panel>
        )}

        {!error && !loading && data && data.accounts.length === 0 && (
          <Panel>
            <div className="p-6">
              {/* Not the same statement as "no such person", which the API
                  answers with a 404 for exactly this reason. */}
              <Empty title="This person holds no target-system accounts">
                Either no rule matches them, or no target has been run since one
                started to.
              </Empty>
            </div>
          </Panel>
        )}

        {!error &&
          !loading &&
          data?.accounts.map((account) => (
            <Panel
              key={account.targetSystemId}
              title={account.targetName}
              description={account.correlationKey}
              actions={(() => {
                const state = accountStatus(account.status);
                return (
                  <span title={state.title}>
                    <Status tone={state.tone}>{state.label}</Status>
                  </span>
                );
              })()}
            >
              {account.entitlements.length === 0 ? (
                <div className="p-4 text-muted">
                  This account holds nothing Syntra can see.
                </div>
              ) : (
                <table className="w-full text-left">
                  <thead className="border-b border-border-subtle bg-surface-2">
                    <tr className="text-sm text-muted">
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Entitlement
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Where it came from
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Rule
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Contract
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.entitlements.map((holding) => (
                      <tr
                        key={holding.entitlementId}
                        className="border-b border-border-subtle last:border-0"
                      >
                        <td className="px-4 py-2.5 text-ink">
                          {holding.displayName}
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {ORIGINS[holding.origin] ?? holding.origin}
                        </td>
                        <td className="px-4 py-2.5 text-ink">
                          {holding.ruleName ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {holding.contractDescription ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          ))}

        <Link
          to={`/admin/people/${id}`}
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to this person
        </Link>
      </div>
    </>
  );
}
