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
              actions={
                <Status tone={account.status === 'active' ? 'active' : 'inactive'}>
                  {account.status}
                </Status>
              }
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
