import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonAccessPage } from './PersonAccessPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

const holding = (overrides: Record<string, unknown> = {}) => ({
  entitlementId: 'e1',
  displayName: 'Finance',
  origin: 'rule',
  ruleId: 'r1',
  ruleName: 'Finance staff',
  contractId: 'c1',
  contractDescription: 'Accountant, Finance, from 2026-01-01',
  ...overrides,
});

const account = (overrides: Record<string, unknown> = {}) => ({
  targetSystemId: 't1',
  targetName: 'Samba AD',
  correlationKey: 'anna.novak',
  status: 'active',
  anchor: 'S-1-5-21-1',
  entitlements: [holding()],
  ...overrides,
});

const mockFetch = (body: unknown, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(json(body, status)));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/people/p1/access']}>
      <Routes>
        <Route path="/admin/people/:id/access" element={<PersonAccessPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('PersonAccessPage', () => {
  it('names the rule and the contract behind a holding', async () => {
    // The whole point of the screen: "why does this person hold this" is not
    // answered by listing what they hold.
    mockFetch({ personId: 'p1', accounts: [account()] });
    renderPage();

    expect(await screen.findByText('Finance')).toBeVisible();
    expect(screen.getByText('Finance staff')).toBeVisible();
    expect(
      screen.getByText('Accountant, Finance, from 2026-01-01'),
    ).toBeVisible();
    expect(screen.getByText('A business rule')).toBeVisible();
  });

  it('does not render an account in conflict as quietly as a disabled leaver', async () => {
    // `apply.ts` writes `conflict` when the target refused the write, and
    // reconciliation then proposes nothing at all for that person here. A
    // disabled account is somebody walking the deprovisioning ladder on
    // purpose. One colour for both is the fault reading as the intention.
    mockFetch({
      personId: 'p1',
      accounts: [
        account({ targetSystemId: 't1', targetName: 'Broken', status: 'conflict' }),
        account({ targetSystemId: 't2', targetName: 'Leaver', status: 'disabled' }),
      ],
    });
    renderPage();

    const conflict = await screen.findByText('conflict');
    const disabled = screen.getByText('disabled');
    expect(conflict.className).not.toBe(disabled.className);
  });

  it('says an account missing at the target is missing, not merely inactive', async () => {
    // `reconcile.ts` sets this when the target stopped returning an anchor
    // Syntra records, and `plan.ts` marks the recreate `requiresConfirmation`
    // because it usually vanished because somebody deleted it deliberately.
    mockFetch({
      personId: 'p1',
      accounts: [account({ status: 'missing_at_target' })],
    });
    renderPage();

    expect(await screen.findByText('missing at the target')).toBeVisible();
  });

  it('says a pending account is a reserved login and nothing at the target', async () => {
    // `run-service.ts` writes the row with a null anchor to hold the
    // correlation key under the unique index. Nothing has been created.
    mockFetch({ personId: 'p1', accounts: [account({ status: 'pending' })] });
    renderPage();

    expect(
      await screen.findByText('pending — nothing at the target yet'),
    ).toBeVisible();
  });

  it('leaves an archived account reading as a decision somebody made', async () => {
    // The other half: a screen that shouts at everything is a screen nobody
    // reads. Archived is the last rung of the ladder, not a fault.
    mockFetch({
      personId: 'p1',
      accounts: [
        account({ targetSystemId: 't1', targetName: 'Archived', status: 'archived' }),
        account({ targetSystemId: 't2', targetName: 'Leaver', status: 'disabled' }),
      ],
    });
    renderPage();

    const archived = await screen.findByText('archived');
    expect(archived.className).toBe(screen.getByText('disabled').className);
  });

  it('distinguishes holding nothing from there being no such person', async () => {
    // The API answers 404 for a person who does not exist for exactly this
    // reason: "holds nothing" and "no such person" are opposite answers to an
    // auditor.
    mockFetch({ personId: 'p1', accounts: [] });
    renderPage();

    expect(
      await screen.findByText('This person holds no target-system accounts'),
    ).toBeVisible();
  });

  it('says a person who is not there is not there', async () => {
    mockFetch({ title: 'Person not found', status: 404 }, 404);
    renderPage();

    expect(await screen.findByText('That record no longer exists.')).toBeVisible();
    expect(
      screen.queryByText('This person holds no target-system accounts'),
    ).toBeNull();
  });

  it('says an account holds nothing rather than rendering an empty table', async () => {
    mockFetch({ personId: 'p1', accounts: [account({ entitlements: [] })] });
    renderPage();

    expect(
      await screen.findByText('This account holds nothing Syntra can see.'),
    ).toBeVisible();
  });

  it('names a holding the target has and no rule asked for', async () => {
    // `discovered` is drift with a name. Rendering the raw token would leave
    // the one holding on the screen that nothing in Syntra asked for looking
    // like every other one.
    mockFetch({
      personId: 'p1',
      accounts: [
        account({
          entitlements: [
            holding({ origin: 'discovered', ruleId: null, ruleName: null, contractDescription: null }),
          ],
        }),
      ],
    });
    renderPage();

    expect(
      await screen.findByText('Found at the target, not granted here'),
    ).toBeVisible();
  });
});
