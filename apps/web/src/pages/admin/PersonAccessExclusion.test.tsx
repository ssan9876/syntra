import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LeaveOut } from './PersonAccessExclusion.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const exclusion = {
  targetSystemId: 't-1',
  targetName: 'fmx.ssander.xyz',
  reason: 'Bootstrap administrator',
  createdByName: 'Jane Doe',
  createdAt: '2026-10-03T10:00:00.000Z',
  message: 'Left out of this target by Jane Doe on 3 Oct 2026: Bootstrap administrator.',
};

afterEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('LeaveOut', () => {
  it('renders nothing for a reader when the person is not left out', () => {
    const { container } = render(
      <LeaveOut personId="p1" targetSystemId="t-1" targetName="fmx.ssander.xyz" exclusion={null} onChanged={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves the person out of the target with a reason', async () => {
    granted.add('provision.manage');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(exclusion), { status: 201, headers: { 'content-type': 'application/json' } }));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <LeaveOut personId="p1" targetSystemId="t-1" targetName="fmx.ssander.xyz" exclusion={null} onChanged={onChanged} />,
    );
    await user.click(screen.getByRole('button', { name: 'Leave out of fmx.ssander.xyz' }));
    const submit = screen.getByRole('button', { name: 'Leave out' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Why/), 'Bootstrap administrator');
    await user.click(submit);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/targets/t-1/exclusions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ personId: 'p1', reason: 'Bootstrap administrator' });
  });

  it('shows who left them out and includes them again with a reason', async () => {
    granted.add('provision.manage');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <LeaveOut personId="p1" targetSystemId="t-1" targetName="fmx.ssander.xyz" exclusion={exclusion} onChanged={onChanged} />,
    );
    expect(screen.getByText('Left out')).toBeVisible();
    expect(screen.getByText(exclusion.message)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Include again' }));
    await user.type(screen.getByLabelText(/Why/), 'FMX retired');
    const buttons = screen.getAllByRole('button', { name: 'Include again' });
    await user.click(buttons[buttons.length - 1]!);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('/api/admin/targets/t-1/exclusions/p1');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'FMX retired' });
  });
});
