import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Empty,
  ListControls,
  Pager,
  Panel,
  SkeletonRows,
  Status,
  Table,
  buttonClasses,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';

interface PersonRow {
  id: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
  externalId: string | null;
  status: string;
}

/**
 * The people, as a list and nothing else.
 *
 * Editing and deactivation moved to the person's own screen, for the same
 * reason they moved off the accounts list: the record page was showing
 * everything about somebody while being the one place nothing about them could
 * be changed, and correcting a misspelt name meant coming back here and
 * finding the row again.
 *
 * The two tabs also have to behave alike. A tab strip says "same subject,
 * different view", so People editing inline while Accounts sent you to a
 * screen would be two conventions presented as one thing — and the reader
 * would learn which was which by clicking the wrong one.
 */
export function PeopleTab() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  // Carried through rather than fixed here: the route caps it at 200, so
  // this is a knob for a reader who wants a longer page and for the
  // end-to-end test that needs a short one -- not a way to ask for
  // everything.
  const pageSize = params.get('pageSize');
  if (pageSize) query.set('pageSize', pageSize);
  const qs = query.toString();

  const { data, error, loading } = useApiResource<{
    persons: PersonRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/persons${qs ? `?${qs}` : ''}`);

  /**
   * Every control writes through the URL rather than through state.
   *
   * A search worth doing is worth sending to somebody, the back button should
   * undo a filter rather than leave the screen, and a page reloaded mid-triage
   * should come back where it was.
   */
  const update = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      setParams(merged, { replace: true });
    },
    [params, setParams],
  );

  // Page 1 on every narrowing: page 7 of a three-page result is an empty table
  // that reads as broken.
  const onSearch = useCallback((value: string) => update({ q: value, page: '' }), [update]);
  const onStatus = useCallback((value: string) => update({ status: value, page: '' }), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
  // Narrowed once, here, rather than `data?.persons.length` at each use.
  // The optional chain guards `data` and then walks straight into `.persons`,
  // so a 200 that arrives without its collection throws inside render and
  // takes the whole console to a blank page instead of showing an empty
  // table. Found when the merged Users screen was asked what it does with a
  // truncated response.
  const persons = data?.persons ?? [];
  const total = data?.total ?? persons.length;
  const shownPageSize = data?.pageSize ?? 50;
  const filtered = q !== '' || status !== '';

  return (
    <>
      {/* The action lives with the table it acts on, not in the page header.
          One header above three tabs would need a word saying which tab its
          button applied to, and that word is the thing this redesign is
          removing. */}
      <div className="mb-4 flex justify-end">
        <Link to="/admin/people/new" className={buttonClasses('primary')}>
          Add someone
        </Link>
      </div>

      <ListControls
        search={q}
        onSearch={onSearch}
        searchLabel="Search people"
        status={{
          value: status,
          onChange: onStatus,
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        }}
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {/* The create form has moved to /admin/people/new.
          A four-field panel here recorded WHO somebody is and stopped, which
          read as the whole job and was not: the contract that makes them
          provisionable, and the login that lets them sign in, had no form
          anywhere. Sending the primary action to a page that asks for all
          three is what closes that, and it is why this page keeps a list and
          nothing else. */}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={6} cols={4} />}

          {/* Two empty states, because they need different actions. "Nothing
              here yet" wants the create button; "nothing matched" wants the
              search cleared, and saying what was searched makes a typo
              visible. */}
          {!loading && persons.length === 0 && !filtered && (
            <div className="p-6">
              {/* An action, not a sentence. The old copy said "Add someone
                  directly, or import a file from your HR system on the Import
                  page" — a sentence whose second half was navigation
                  instructions to a screen that is now a tab beside this one.
                  A button does the first half and the tab strip does the
                  second. */}
              <Empty
                title="No people yet"
                action={
                  <Link to="/admin/people/new" className={buttonClasses('primary')}>
                    Add someone
                  </Link>
                }
              />
            </div>
          )}

          {!loading && persons.length === 0 && filtered && (
            <div className="p-6">
              <Empty
                title={`Nobody matches ${q || status}`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('secondary')}
                    onClick={() => update({ q: '', status: '', page: '' })}
                  >
                    Clear the search
                  </button>
                }
              >
                Names, employee references and work email addresses are
                searched.
              </Empty>
            </div>
          )}

          {!loading && persons.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Name
                  </th>
                  <th
                    scope="col"
                    className="max-sm:hidden"
                  >
                    Email
                  </th>
                  <th scope="col">
                    Reference
                  </th>
                  <th scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {persons.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <Link
                        to={`/admin/people/${person.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {person.givenName} {person.familyName}
                      </Link>
                    </td>
                    <td className="max-sm:hidden">
                      {person.businessEmail ?? '—'}
                    </td>
                    <td>
                      {person.externalId ?? '—'}
                    </td>
                    <td>
                      {/*
                        Inactive people stay listed and labelled, as inactive
                        accounts do. Hiding a leaver to keep the table tidy
                        would make the register unauditable.
                      */}
                      <Status
                        tone={person.status === 'active' ? 'active' : 'inactive'}
                      >
                        {person.status === 'active' ? 'Active' : 'Inactive'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}

      {!error && !loading && persons.length > 0 && (
        <Pager page={page} pageSize={shownPageSize} total={total} onPage={onPage} />
      )}
    </>
  );
}
