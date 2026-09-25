import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProvisioningSetupPage } from './ProvisioningSetupPage.js';

const source = { id: 's1', name: 'Payroll', enabled: true, schedule: null };
const target = { id: 't1', name: 'Directory', enabled: true, schedule: null, autoApply: false };
const fixtures: Record<string, unknown> = {
  '/api/admin/person-sources': { sources: [source] },
  '/api/admin/targets': { targets: [target] },
  '/api/admin/person-sources/s1/mappings': { rules: [] },
  '/api/admin/person-import-runs?sourceId=s1': { runs: [] },
  '/api/admin/targets/t1/profile': { correlationKeyTemplate: '%person.externalId%', updatedAt: '2026-09-18T00:00:00Z' },
  '/api/admin/targets/t1/rules': { rules: [] },
  '/api/admin/targets/t1/runs': { runs: [] },
  '/api/admin/targets/t1/readiness': { current: false, status: 'untested', adapterWarnings: [] },
};
function serve(overrides: Record<string, unknown> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    const value = { ...fixtures, ...overrides }[path];
    if (value instanceof Response) return value.clone();
    if (value === undefined) throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
}
const show = () => render(<MemoryRouter><ProvisioningSetupPage /></MemoryRouter>);
const checklist = async () => screen.findByRole('list', { name: 'Setup checklist' });
/** The list item of one step, found by its heading. */
async function step(title: string) {
  const list = await checklist();
  return within(list).getByRole('heading', { name: title }).closest('li') as HTMLElement;
}
beforeEach(() => vi.restoreAllMocks());

it('keeps saved configuration distinct from tested readiness and never writes', async () => {
  const fetch = serve();
  show();
  // A saved profile is not a verified one until a preview has exercised it.
  const naming = await step('Configure naming and placement');
  expect(within(naming).getByText('Saved, not previewed')).toBeVisible();
  expect(within(naming).getByRole('link', { name: 'Configure naming and placement' })).toHaveAttribute('href', '/admin/targets/t1/profile');
  // A saved target with no connection test is waiting on one.
  expect(within(await step('Connect target')).getByText('Not tested')).toBeVisible();
  expect(within(await step('Map fields')).getByText('Not started')).toBeVisible();
  expect(screen.getByText('of 8 verified')).toBeVisible();
  expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('uses the latest run failure rather than an older successful run', async () => {
  serve({ '/api/admin/targets/t1/runs': { runs: [
    { id: 'failed', status: 'failed', startedAt: '2026-09-20T00:00:00Z', error: 'Directory unreachable' },
    { id: 'old', status: 'applied', startedAt: '2026-09-19T00:00:00Z' },
  ] } });
  show();
  const preview = await step('Preview lifecycle');
  expect(within(preview).getByText('Run failed')).toBeVisible();
  expect(within(preview).getByText('Directory unreachable')).toBeVisible();
  expect(within(preview).getByRole('link', { name: 'Review lifecycle run' })).toHaveAttribute('href', '/admin/targets/t1/runs/failed');
});

it('does not treat forbidden profile reads as a missing profile', async () => {
  serve({ '/api/admin/targets/t1/profile': new Response(JSON.stringify({ title: 'Profile access denied', status: 403 }), { status: 403, headers: { 'content-type': 'application/problem+json' } }) });
  show();
  const naming = await step('Configure naming and placement');
  expect(within(naming).getByText('Profile access denied')).toBeVisible();
  expect(within(naming).getByText('Evidence unavailable')).toBeVisible();
  expect(within(naming).queryByText('None saved')).not.toBeInTheDocument();
});

it('shows direct creation paths for an empty tenant', async () => {
  serve({ '/api/admin/person-sources': { sources: [] }, '/api/admin/targets': { targets: [] } });
  show();
  expect(within(await step('Connect HR')).getByRole('link', { name: 'Connect HR source' })).toHaveAttribute('href', '/admin/person-sources/new');
  expect(within(await step('Connect target')).getByRole('link', { name: 'Connect target' })).toHaveAttribute('href', '/admin/targets/new');
});

it('shows a configured schedule as a setting, not proof, while earlier steps are unverified', async () => {
  serve({ '/api/admin/targets': { targets: [{ ...target, schedule: '0 3 * * *', autoApply: true }] } });
  show();
  const schedule = await step('Enable schedule');
  expect(within(schedule).getByText('Applying before verification')).toBeVisible();
  expect(within(schedule).getByText('0 3 * * *')).toBeVisible();
  expect(within(await step('Preview lifecycle')).getByText('Not started')).toBeVisible();
});

it('shows connector readiness for every target', async () => {
  serve({
    '/api/admin/targets': { targets: [target, { ...target, id: 't2', name: 'Payroll app' }] },
    '/api/admin/targets/t2/readiness': { current: true, status: 'passed', checkedAt: '2026-09-20T00:00:00Z', adapterWarnings: [] },
  });
  show();
  const table = await screen.findByRole('table', { name: 'Connector readiness per target' });
  const row = within(table).getByRole('link', { name: 'Payroll app' }).closest('tr') as HTMLElement;
  expect(await within(row).findByText('Verified')).toBeVisible();
});

it('marks the sample step inspected once a searched employee’s contracts are read', async () => {
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    requested.push(path);
    const extra: Record<string, unknown> = {
      '/api/admin/persons/p1': { id: 'p1', givenName: 'Maya', familyName: 'Okafor', contracts: [{ id: 'c1', startDate: '2026-10-01T00:00:00Z', endDate: null, department: 'Nursing', isPrimary: true }] },
    };
    const value = path.startsWith('/api/admin/persons?')
      ? { persons: [{ id: 'p1', givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' }], total: 1 }
      : { ...fixtures, ...extra }[path];
    if (value === undefined) throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
  const user = userEvent.setup();
  show();
  await user.type(await screen.findByRole('combobox', { name: 'Employee' }), 'oka');
  await user.click(await screen.findByRole('option', { name: /Maya Okafor/ }));
  // Server-backed: the typed text went to the list endpoint's `q`.
  expect(requested).toContain('/api/admin/persons?q=oka&pageSize=20');
  expect(await screen.findByRole('table', { name: 'Contracts of Maya Okafor' })).toBeVisible();
  await waitFor(async () => expect(within(await step('Inspect a sample employee')).getByText('Inspected')).toBeVisible());
});
