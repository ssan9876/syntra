import { render, screen, within } from '@testing-library/react';
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
  '/api/admin/targets/t1/profile': { correlationKeyTemplate: '%person.externalId%' },
  '/api/admin/targets/t1/rules': { rules: [] },
  '/api/admin/targets/t1/runs': { runs: [] },
};
function serve(overrides: Record<string, unknown> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    const value = { ...fixtures, ...overrides }[path];
    if (value instanceof Response) return value;
    if (value === undefined) throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  });
}
const show = () => render(<MemoryRouter><ProvisioningSetupPage /></MemoryRouter>);
beforeEach(() => vi.restoreAllMocks());
it('keeps saved connections distinct from tested lifecycle readiness and never writes', async () => {
  const fetch = serve();
  show();
  expect(await screen.findByText('Save a person correlation mapping before importing.')).toBeVisible();
  expect(await screen.findByText('No lifecycle run recorded.')).toBeVisible();
  expect(screen.getByText(/Saved-target connection tests create fingerprinted readiness evidence/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Configure naming and placement' })).toHaveAttribute('href', '/admin/targets/t1/profile');
  expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('uses the latest run failure rather than an older successful run', async () => {
  serve({ '/api/admin/targets/t1/runs': { runs: [
    { id: 'failed', status: 'failed', startedAt: '2026-09-20T00:00:00Z', error: 'Directory unreachable' },
    { id: 'old', status: 'applied', startedAt: '2026-09-19T00:00:00Z' },
  ] } });
  show();
  expect(await screen.findByText(/Directory unreachable/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review lifecycle run' })).toHaveAttribute('href', '/admin/targets/t1/runs/failed');
});
it('does not treat forbidden profile reads as a missing profile', async () => {
  serve({ '/api/admin/targets/t1/profile': new Response(JSON.stringify({ title: 'Profile access denied', status: 403 }), { status: 403, headers: { 'content-type': 'application/problem+json' } }) });
  show();
  expect(await screen.findByText(/Profile access denied/)).toBeVisible();
  expect(screen.queryByText('No account profile saved.')).not.toBeInTheDocument();
});
it('shows direct creation paths for an empty tenant', async () => {
  serve({ '/api/admin/person-sources': { sources: [] }, '/api/admin/targets': { targets: [] } });
  show();
  expect(await screen.findByRole('link', { name: 'Connect HR source' })).toHaveAttribute('href', '/admin/person-sources/new');
  expect(screen.getByRole('link', { name: 'Connect target' })).toHaveAttribute('href', '/admin/targets/new');
});
it('shows configured schedules as settings, not proof of successful writes', async () => {
  serve({ '/api/admin/targets': { targets: [{ ...target, schedule: '0 3 * * *', autoApply: true }] } });
  show();
  const section = await screen.findByRole('region', { name: 'Target setup' });
  expect(await within(section).findByText(/Automatic apply is enabled/)).toBeVisible();
  expect(within(section).getByText('No lifecycle run recorded.')).toBeVisible();
});
