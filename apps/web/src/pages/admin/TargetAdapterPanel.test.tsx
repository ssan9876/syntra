import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetAdapterPanel, type AdapterReport } from './TargetAdapterPanel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const release = (adapterVersion: string, over: Record<string, unknown> = {}) => ({
  adapterVersion,
  channel: 'stable' as const,
  supportState: 'supported',
  rollout: 'general',
  deprecationDate: null,
  certification: { status: 'passed', evidence: 'Shared contract', verifiedAt: '2026-09-23', capabilities: [] },
  ...over,
});

const report = (over: Partial<AdapterReport> = {}): AdapterReport => ({
  type: 'scim2',
  selection: { channel: 'canary', pinnedVersion: null, rollbackVersion: '1.0.0', changedAt: null, reason: null },
  effective: { source: 'canary', release: release('1.1.0', { channel: 'canary' }) },
  resolutionError: null,
  releases: [release('1.0.0'), release('1.1.0', { channel: 'canary' })],
  capabilities: [
    { capability: 'create_account', certified: true, refusal: null },
    { capability: 'grant_entitlement', certified: true, refusal: "refused: this target's configuration does not advertise the ability to grant entitlements" },
    { capability: 'create_container', certified: false, refusal: 'refused: scim2 adapter 1.1.0 is not certified to create containers' },
  ],
  warnings: [],
  writesBlockedReason: null,
  deprecationOverride: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('TargetAdapterPanel', () => {
  it('shows the effective release and which writes are refused', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(report()));
    render(<TargetAdapterPanel targetId="t1" />);
    expect(await screen.findByText('v1.1.0 · canary channel')).toBeVisible();
    const list = screen.getByRole('list', { name: 'Certified writes' });
    const grant = within(list).getByText('Grant entitlements').closest('li')!;
    expect(within(grant).getByText('refused')).toBeVisible();
    expect(within(grant).getByText('not advertised by this configuration')).toBeVisible();
    expect(within(within(list).getByText('Create accounts').closest('li')!).getByText('allowed')).toBeVisible();
  });

  it('rolls back only with a reason, and posts it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      Promise.resolve(json(init?.method === 'POST' ? report({ selection: { channel: 'stable', pinnedVersion: '1.0.0', rollbackVersion: null, changedAt: null, reason: null } }) : report())),
    );
    render(<TargetAdapterPanel targetId="t1" />);
    const button = await screen.findByRole('button', { name: 'Roll back to 1.0.0' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason for the rollback'), 'Canary misread groups');
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByText('Rolled back.')).toBeVisible());
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(post[0])).toBe('/api/admin/targets/t1/adapter/rollback');
    expect(JSON.parse(String(post[1]?.body))).toEqual({ reason: 'Canary misread groups' });
  });

  it('saves a pin to an exact release', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json(report())));
    render(<TargetAdapterPanel targetId="t1" />);
    await userEvent.selectOptions(await screen.findByLabelText('Pinned release'), '1.0.0');
    await userEvent.type(screen.getByLabelText('Reason for the rollout change'), 'Hold the pilot on 1.0.0');
    await userEvent.click(screen.getByRole('button', { name: 'Save rollout' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({ channel: 'canary', version: '1.0.0', reason: 'Hold the pilot on 1.0.0' });
  });

  it('says writes are blocked past the deprecation date and offers a bounded override', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(report({
      effective: { source: 'stable', release: release('1.0.0', { supportState: 'deprecated', deprecationDate: '2026-09-01' }) },
      writesBlockedReason: 'scim2 adapter 1.0.0 passed its deprecation date (2026-09-01); new writes are blocked',
      warnings: ['scim2 adapter 1.0.0 passed its deprecation date'],
    })));
    render(<TargetAdapterPanel targetId="t1" />);
    expect(await screen.findByText('New writes are blocked')).toBeVisible();
    expect(screen.getByLabelText('Override expires (maximum 30 days)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Record override' })).toBeDisabled();
  });

  it('renders nothing when the API cannot answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ title: 'Not Found', status: 404 }, 404));
    const { container } = render(<TargetAdapterPanel targetId="t1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
