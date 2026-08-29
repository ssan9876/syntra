import { Link, useParams } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { Adoption } from './PersonAccessAdoption.js';
import { Placement } from './PersonAccessPlacement.js';
import {
  HeldByNow,
  ORIGINS,
  RecordedAtGrant,
  accountStatus,
  type Access,
} from './PersonAccessEntitlements.js';

export function PersonAccessPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useApiResource<Access>(
    `/api/admin/persons/${id}/access`,
  );

  return (
    <>
      <PageHeader
        title="Why does this person hold this?"
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
              actions={(() => {
                const state = accountStatus(account.status);
                return (
                  <span title={state.title}>
                    <Status tone={state.tone}>{state.label}</Status>
                  </span>
                );
              })()}
            >
              {/*
                The account's own name at the target. It rode in on the
                panel's `description`, which made an identifier look like a
                sentence about the panel — the third place in this console
                where that prop was carrying data rather than prose, and the
                reason it was removed rather than merely emptied.

                Monospaced and selectable, like every other identifier here:
                somebody reading this screen is usually about to paste it
                into a directory tool.
              */}
              <div className="border-b border-border-subtle px-4 py-2.5">
                <span className="text-sm font-medium text-muted">Account</span>{' '}
                <code className="font-mono text-sm text-ink">
                  {account.correlationKey}
                </code>
              </div>
              {/*
                Where the account SITS, above what it holds. They are different
                questions and the placement is the one somebody arriving from
                a reorg came here for.
              */}
              <Placement
                personId={id!}
                targetSystemId={account.targetSystemId}
                targetName={account.targetName}
              />
              {/*
                The way out of a conflict, and only then. `conflict` is the one
                account status no run clears, so without this the screen shows a
                dead end and no way past it.
              */}
              {account.status === 'conflict' && (
                <Adoption
                  personId={id!}
                  targetSystemId={account.targetSystemId}
                  correlationKey={account.correlationKey}
                />
              )}
              {account.entitlements.length === 0 ? (
                <div className="p-4 text-muted">
                  This account holds nothing Syntra can see.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">
                        Entitlement
                      </th>
                      <th scope="col">
                        Where it came from
                      </th>
                      {/* Two columns and not one, because they answer two
                          different questions and the whole defect was
                          answering the first with the second. The contract
                          lives with the rule it satisfies: one holding can
                          have several current rules, each satisfied by a
                          different contract of this person, and a single
                          contract column could only ever show one of them. */}
                      <th scope="col">
                        Why it is held now
                      </th>
                      <th scope="col">
                        Recorded at the grant
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.entitlements.map((holding) => (
                      <tr key={holding.entitlementId}>
                        <td className="text-ink">
                          {holding.displayName}
                        </td>
                        <td>
                          {ORIGINS[holding.origin] ?? holding.origin}
                        </td>
                        <td className="text-ink">
                          <HeldByNow holding={holding} />
                        </td>
                        <td className="text-ink">
                          <RecordedAtGrant holding={holding} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
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
