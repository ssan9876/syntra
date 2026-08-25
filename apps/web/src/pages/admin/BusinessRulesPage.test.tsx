import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BusinessRulesPage } from './BusinessRulesPage.js';

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const RULE = {
  id: 'r1',
  name: 'Finance staff',
  description: null,
  condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
  grantsAccount: true,
  enabled: true,
  entitlements: [{ entitlementId: 'e1' }],
};

const ENTITLEMENT = {
  id: 'e1',
  displayName: 'Finance',
  status: 'present',
  holderCount: 12,
};

const IMPACT = {
  matchedPersons: 3,
  totalPersons: 40,
  wouldGrant: 3,
  wouldRevoke: 0,
  sample: [{ personId: 'p1', displayName: 'Anna Novak' }],
};

function mockFetch(options: {
  rules?: unknown[];
  entitlements?: unknown[];
  impact?: unknown;
  impactFails?: boolean;
  enforcementMode?: 'additive' | 'authoritative';
}) {
  const rules = options.rules ?? [];
  const entitlements = options.entitlements ?? [ENTITLEMENT];
  const impact = options.impact ?? IMPACT;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    if (path.endsWith('/rules/impact'))
      return Promise.resolve(
        options.impactFails
          ? json({ title: 'Internal Server Error', status: 500 }, 500)
          : json(impact),
      );
    if (path.endsWith('/entitlements'))
      return Promise.resolve(json({ entitlements }));
    if (path.endsWith('/rules')) return Promise.resolve(json({ rules }));
    // The target itself. This screen's standing reassurance is only true under
    // one of the two enforcement modes, so it has to read which one this is.
    if (/\/targets\/[^/]+$/.test(path))
      return Promise.resolve(
        json({ enforcementMode: options.enforcementMode ?? 'additive' }),
      );
    return Promise.resolve(json({}));
  });
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/t1/rules']}>
      <Routes>
        <Route path="/admin/targets/:id/rules" element={<BusinessRulesPage />} />
      </Routes>
    </MemoryRouter>,
  );

const bodyOfLastPost = (mock: ReturnType<typeof mockFetch>, suffix: string) => {
  const call = mock.mock.calls
    .filter(([input]) => String(input).endsWith(suffix))
    .at(-1);
  return JSON.parse(String((call![1] as RequestInit).body));
};

beforeEach(() => vi.restoreAllMocks());

describe('BusinessRulesPage', () => {
  it('sends a bare leaf for an operator that takes no value', async () => {
    // `isEmpty` and `isNotEmpty` are the only two leaves with no `value`, and
    // sending one anyway is refused by the closed schema.
    const fetchMock = mockFetch({});
    renderPage();

    await screen.findByText('Finance');
    await userEvent.type(screen.getByLabelText('Name'), 'No department');
    await userEvent.selectOptions(screen.getByLabelText('Test'), 'isEmpty');
    // The value box is gone with it: a box that cannot be sent is a box that
    // gets filled in and silently dropped.
    expect(screen.queryByLabelText('Value')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(bodyOfLastPost(fetchMock, '/rules/impact').condition).toEqual({
      field: 'contract.department',
      op: 'isEmpty',
    });
  });

  it('sends a list for a list operator and a number for a numeric one', async () => {
    const fetchMock = mockFetch({});
    renderPage();

    await screen.findByText('Finance');
    await userEvent.selectOptions(screen.getByLabelText('Test'), 'in');
    await userEvent.type(screen.getByLabelText('Value'), 'Care, Learning');
    await userEvent.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(bodyOfLastPost(fetchMock, '/rules/impact').condition).toEqual({
      field: 'contract.department',
      op: 'in',
      value: ['Care', 'Learning'],
    });

    await userEvent.selectOptions(screen.getByLabelText('Field'), 'contract.fte');
    await userEvent.selectOptions(screen.getByLabelText('Test'), 'greaterThan');
    await userEvent.clear(screen.getByLabelText('Value'));
    await userEvent.type(screen.getByLabelText('Value'), '0.5');
    await userEvent.click(screen.getByRole('button', { name: 'Preview impact' }));
    // A number, not the string the box holds: the numeric leaf is typed, and
    // `"0.5" > 0.5` is a comparison the evaluator declines.
    expect(bodyOfLastPost(fetchMock, '/rules/impact').condition).toEqual({
      field: 'contract.fte',
      op: 'greaterThan',
      value: 0.5,
    });
  });

  it('leads with the revocations when an edit would take access away', async () => {
    // The fifth appearance of the empty-set defect on this slice was
    // `previewRuleImpact` reporting "revokes 0" for emptying a rule's
    // entitlement list — the single edit that revokes everything. The number
    // is right now; this is the screen refusing to render it quietly.
    mockFetch({ impact: { ...IMPACT, wouldGrant: 0, wouldRevoke: 12 } });
    renderPage();

    await screen.findByText('Finance');
    await userEvent.click(screen.getByRole('button', { name: 'Preview impact' }));

    expect(
      await screen.findByText('12 holdings would be taken away'),
    ).toBeVisible();
  });

  it('says nothing alarming when an edit revokes nothing', async () => {
    mockFetch({});
    renderPage();

    await screen.findByText('Finance');
    await userEvent.click(screen.getByRole('button', { name: 'Preview impact' }));

    expect(await screen.findByText(/This rule matches/)).toBeVisible();
    expect(screen.queryByText(/would be taken away/)).toBeNull();
  });

  it('marks an entitlement the catalog can no longer see', async () => {
    // A rule naming a missing entitlement makes every person it is evaluated
    // against unprocessable, and that is not something to discover from a run.
    mockFetch({
      entitlements: [{ ...ENTITLEMENT, status: 'missing' }],
    });
    renderPage();

    expect(await screen.findByText(/missing —/)).toBeVisible();
  });

  it('says what to do about an empty catalog, and offers the control that does it', async () => {
    // The empty case again: a target created a minute ago has no catalog, and
    // until this page grew a refresh button it told people to do something the
    // console could not do.
    mockFetch({ entitlements: [] });
    renderPage();

    expect(
      await screen.findByText(/entitlement catalog is empty/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Refresh entitlement catalog' }),
    ).toBeVisible();
  });

  it('does not promise that adding a rule never removes access on an authoritative target', async () => {
    // `remitFor` is every entitlement named by an enabled rule for this target,
    // and under `authoritative` `reconcile.ts` proposes revoking an in-remit
    // entitlement from every holder Provision did not grant it to. So naming a
    // group in a new rule is exactly what takes it away from everybody holding
    // it for another reason.
    mockFetch({ enforcementMode: 'authoritative' });
    renderPage();

    expect(
      await screen.findByText(/adding a rule can also remove access/),
    ).toBeVisible();
    expect(screen.queryByText(/never removes access/)).toBeNull();
  });

  it('still says a rule only adds on an additive target', async () => {
    mockFetch({ enforcementMode: 'additive' });
    renderPage();

    expect(
      await screen.findByText(/adding a rule never removes access/),
    ).toBeVisible();
  });

  it('will not delete a rule without saying what the delete revokes', async () => {
    // The next run revokes every entitlement this rule ever granted:
    // `reconcile.ts` keeps a holding Provision granted inside `heldWithinRemit`
    // even once the rule that asked for it is gone. This screen already had the
    // warning and showed it on the *edit* path, which is the less destructive
    // of the two.
    const fetchMock = mockFetch({
      rules: [RULE],
      impact: { ...IMPACT, wouldGrant: 0, wouldRevoke: 12 },
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/12 holdings would be/)).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete this rule' }),
    );
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('asks the impact endpoint what this rule alone granted', async () => {
    // Modelled as "this rule grants nothing": `previewRuleImpact` counts a
    // holding it granted as revoked once the rule stops naming its entitlement,
    // so an empty `entitlementIds` is exactly the set the delete gives up.
    const fetchMock = mockFetch({ rules: [RULE] });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await screen.findByText(/holdings would be taken away|holding would be taken away/);

    const body = bodyOfLastPost(fetchMock, '/rules/impact');
    expect(body.id).toBe('r1');
    expect(body.entitlementIds).toEqual([]);
    expect(body.condition).toEqual(RULE.condition);
  });

  it('still asks before deleting when the impact could not be worked out', async () => {
    // Not knowing the number is a reason to be more careful, not a reason to
    // skip the question.
    const fetchMock = mockFetch({ rules: [RULE], impactFails: true });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText(/without a number behind it/),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('claims nothing about this target before the server has answered', async () => {
    // The first paint used to assert that the target had no rules and an empty
    // entitlement catalog, and invite an LDAP refresh nobody needed.
    mockFetch({ rules: [RULE] });
    renderPage();

    expect(screen.queryByText('No rules yet')).toBeNull();
    expect(screen.queryByText(/entitlement catalog is empty/)).toBeNull();

    expect(await screen.findByText('Finance staff')).toBeVisible();
  });

  it('shows a compound condition in full, not the opaque placeholder', async () => {
    mockFetch({
      rules: [
        {
          ...RULE,
          condition: {
            all: [
              { field: 'contract.department', op: 'equals', value: 'Finance' },
              { field: 'contract.fte', op: 'greaterThan', value: 0.5 },
            ],
          },
        },
      ],
    });
    renderPage();

    await screen.findByText('Finance staff');
    // The description sits in a `<p>` alongside " — grants an account, N
    // entitlements", all as sibling text within the same element, so it is
    // never the WHOLE text of any one node and a `getByText` exact or
    // regex match against a single element is the wrong tool here.
    expect(document.body.textContent).toContain(
      '(contract.department is Finance) AND (contract.fte is greater than 0.5)',
    );
    expect(document.body.textContent).not.toContain('a compound condition');
  });

  it('builds a 2-level AND rule entirely through the editor and saves the correct JSON', async () => {
    const fetchMock = mockFetch({});
    renderPage();

    await screen.findByText('Finance');
    await userEvent.type(screen.getByLabelText('Name'), 'Finance and part-time');
    await userEvent.click(screen.getByRole('button', { name: 'Group with AND' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add condition' }));

    const values = screen.getAllByLabelText('Value');
    await userEvent.type(values[0]!, 'Finance');
    await userEvent.type(values[1]!, 'Sales');

    await userEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    // Not `bodyOfLastPost`: a successful save calls `reload()`, which issues
    // its own GET to this same `/rules` suffix immediately afterwards, so the
    // last call ending in `/rules` is that GET, not the PUT this test means to
    // inspect. Filtered on method instead.
    const put = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith('/rules') &&
          (init as RequestInit | undefined)?.method === 'PUT',
      );
      if (!call) throw new Error('no PUT to /rules yet');
      return call;
    });
    const body = JSON.parse(String((put[1] as RequestInit).body));
    expect(body.condition).toEqual({
      all: [
        { field: 'contract.department', op: 'equals', value: 'Finance' },
        { field: 'contract.department', op: 'equals', value: 'Sales' },
      ],
    });
  });

  it('loads a stored rule back into the editor, entitlements and all', async () => {
    mockFetch({
      rules: [
        {
          id: 'r1',
          name: 'Finance staff',
          description: null,
          condition: {
            field: 'contract.department',
            op: 'in',
            value: ['Care', 'Learning'],
          },
          grantsAccount: true,
          enabled: false,
          entitlements: [{ entitlementId: 'e1' }],
        },
      ],
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Finance staff');
    expect(screen.getByLabelText('Test')).toHaveValue('in');
    // The list comes back as the comma-separated text it was typed as, not as
    // `Care,Learning` run together or as `[object Object]`.
    expect(screen.getByLabelText('Value')).toHaveValue('Care, Learning');
    expect(screen.getByLabelText(/Finance/)).toBeChecked();
    expect(screen.getByLabelText(/^Enabled/)).not.toBeChecked();
  });
});
