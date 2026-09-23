import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetMigrationPanel } from './TargetMigrationPanel.js';

const response = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));

afterEach(() => vi.restoreAllMocks());

describe('TargetMigrationPanel', () => {
  it('shows preserved state and requires inline confirmation before applying the exact revision', async () => {
    const applied = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') return response({ targetId: 'target-1' });
      return response({
        revision: 'a'.repeat(64),
        from: { adapter: 'Document-driven HTTP' },
        to: { adapter: 'Microsoft Entra ID' },
        preserved: {
          targetId: true,
          credential: true,
          schedule: true,
          accountProfile: true,
          accounts: 12,
          entitlements: 4,
          rules: 3,
          runs: 27,
        },
        warnings: ['Run a native Entra connection test before enabling writes.'],
      });
    });
    render(<TargetMigrationPanel targetId="target-1" onApplied={applied} />);

    expect(await screen.findByText('Document-driven HTTP')).toBeVisible();
    expect(screen.getByText('12')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Apply adapter migration' })).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review migration' }));
    await user.click(screen.getByRole('button', { name: 'Apply adapter migration' }));

    await waitFor(() => expect(applied).toHaveBeenCalledOnce());
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/admin/targets/target-1/migrations/native-entra/apply');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ revision: 'a'.repeat(64) });
  });

  it('stays absent when the target is not eligible for migration', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      response({ title: 'Migration is not available' }, 409),
    );
    const { container } = render(<TargetMigrationPanel targetId="target-1" onApplied={() => undefined} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
