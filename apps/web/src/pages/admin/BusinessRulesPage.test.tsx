import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BusinessRulesPage } from './BusinessRulesPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

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
}) {
  const rules = options.rules ?? [];
  const entitlements = options.entitlements ?? [ENTITLEMENT];
  const impact = options.impact ?? IMPACT;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    if (path.endsWith('/rules/impact')) return Promise.resolve(json(impact));
    if (path.endsWith('/entitlements'))
      return Promise.resolve(json({ entitlements }));
    if (path.endsWith('/rules')) return Promise.resolve(json({ rules }));
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
