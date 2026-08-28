import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Candidate {
  personId: string;
  givenName: string;
  familyName: string;
  rule: 'businessEmail' | 'personalEmail' | 'displayName';
  hasActiveAccount: boolean;
}

interface Row {
  id: string;
  login: string;
  displayName: string;
  email: string;
  topCandidate: Candidate | null;
}

const REASON: Record<Candidate['rule'], string> = {
  businessEmail: 'same work email',
  personalEmail: 'same personal email',
  displayName: 'same name',
};

/**
 * Strong enough to link without reading the row.
 *
 * The same bar the create form applies unasked: a unique match on an address
 * the organization issued, to somebody who does not already sign in. Anything
 * weaker is a row somebody looks at.
 */
const confident = (row: Row) =>
  row.topCandidate?.rule === 'businessEmail' && !row.topCandidate.hasActiveAccount;

/**
 * The accounts with nobody behind them.
 *
 * A backlog the console created itself: the Accounts create form had no person
 * field at all, so every account made there orphaned itself, and the only way
 * to fix one was to open the person it should have belonged to and search for
 * it. Nothing listed them.
 *
 * Its own screen rather than a fourth tab of Users, reached from a stat card
 * that hides itself at zero. The backlog is transient — a tab would be a
 * permanently visible destination that is usually empty, which is how a
 * console accumulates places nobody goes.
 */
export function UnlinkedAccountsPage() {
  const { data, error, loading, reload } = useApiResource<{ accounts: Row[] }>(
    '/api/admin/users/unlinked',
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const rows = data?.accounts ?? [];
  const confidentRows = rows.filter(confident);

  const link = (userId: string, personId: string) =>
    api(`/api/admin/persons/${personId}/link-user`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That account could not be linked.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Accounts with no person" />

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}

      {!error && confidentRows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            loading={busy}
            onClick={() =>
              void run(async () => {
                // Sequentially, not Promise.all. These are writes against one
                // table, the list is short, and a partial failure halfway
                // through a parallel batch leaves the screen unable to say
                // which ones landed.
                for (const row of confidentRows) {
                  await link(row.id, row.topCandidate!.personId);
                }
              })
            }
          >
            Link all {confidentRows.length} confident
          </Button>
          <span className="text-sm text-muted">
            {/* What "confident" means, beside the button that acts on it. */}
            Accounts whose address matches exactly one person's work email,
            where that person has no account yet.
          </span>
        </div>
      )}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={5} cols={4} />}

          {!loading && rows.length === 0 && (
            <div className="p-6">
              <Empty title="Every account has a person">
                Accounts appear here when they are created without one. A
                service account belongs in this state and can be left alone.
              </Empty>
            </div>
          )}

          {!loading && rows.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col" className="max-sm:hidden">
                    Email
                  </th>
                  <th scope="col">Might be</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        to={`/admin/users/${row.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {row.login}
                      </Link>
                    </td>
                    <td className="max-sm:hidden">{row.email}</td>
                    <td>
                      {row.topCandidate ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Link
                            to={`/admin/people/${row.topCandidate.personId}`}
                            className="text-ink underline-offset-2 hover:text-primary hover:underline"
                          >
                            {row.topCandidate.givenName}{' '}
                            {row.topCandidate.familyName}
                          </Link>
                          <span className="text-sm text-muted">
                            {REASON[row.topCandidate.rule]}
                            {row.topCandidate.hasActiveAccount &&
                              ' — already has an account'}
                          </span>
                        </span>
                      ) : (
                        // Listed with no suggestion rather than hidden. Hiding
                        // them would make the count irreconcilable with the
                        // accounts table, and a genuine service account is a
                        // row somebody reads once and never thinks about again.
                        <span className="text-muted">Nobody obvious</span>
                      )}
                    </td>
                    <td>
                      {row.topCandidate && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy}
                          onClick={() =>
                            void run(() =>
                              link(row.id, row.topCandidate!.personId).then(
                                () => undefined,
                              ),
                            )
                          }
                        >
                          {/* Names BOTH sides. A table of identical "Link"
                              buttons is announced one after another with no
                              way to tell the rows apart. */}
                          Link {row.login} to {row.topCandidate.givenName}{' '}
                          {row.topCandidate.familyName}
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

      <Link
        to="/admin/users?tab=accounts"
        className="mt-4 inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Back to accounts
      </Link>
    </>
  );
}
