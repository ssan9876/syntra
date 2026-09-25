import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@syntra/ui';
import { LifecyclePolicyPage } from './LifecyclePolicyPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const policy = {
  requireApprovalForAccountCreation: false,
  requireApprovalForPrivilegedGroups: true,
  privilegedGroupPatterns: ['Domain Admins'],
  requireApprovalForUrgentDeparture: false,
  requireApprovalForBulkRequeue: true,
  bulkRequeueThreshold: 25,
  maxConcurrentTargetOperations: 8,
  urgentLeaverSloMinutes: 60,
  onboardSloHours: 24,
  moveSloHours: 24,
  offboardSloHours: 24,
  escalationOwnerUserId: null,
  notifyOnFailure: true,
  notifyOnOverdue: true,
  notifyOnAccessBlocked: true,
  receiptRetentionDays: 365,
  observationRetentionDays: 90,
  notificationRetentionDays: 90,
  simulationRetentionDays: 30,
  lifecycleOperationRetentionDays: 365,
  auditRetentionDays: null,
};

function mockApi(patch: (body: Record<string, unknown>) => Response = (body) => json({ ...policy, ...body })) {
  const writes: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      return patch(body);
    }
    if (String(input).includes('/users')) return json({ users: [] });
    return json(policy);
  });
  return writes;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <LifecyclePolicyPage />
      </ToastProvider>
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('LifecyclePolicyPage', () => {
  it('lists every out-of-range number at once, by label, and sends nothing', async () => {
    // It used to report the first bad number only, by its API key — "Check the
    // number for bulkRequeueThreshold" — which names no box on the screen.
    const writes = mockApi();
    renderPage();

    const threshold = await screen.findByLabelText('Operations in one requeue that need approval');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '0');
    const audit = screen.getByLabelText('Audit events: days');
    await userEvent.type(audit, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Operations in one requeue that need approval: A whole number between 1 and 10000');
    expect(summary).toHaveTextContent('Audit events: days: A whole number between 90 and 3650');
    expect(writes).toHaveLength(0);

    await userEvent.click(
      screen.getByRole('button', { name: /Operations in one requeue that need approval:/ }),
    );
    expect(threshold).toHaveFocus();
  });

  it('says the form has unsaved changes, and confirms the save', async () => {
    const writes = mockApi();
    renderPage();

    const box = await screen.findByRole('checkbox', { name: 'Creating a target account' });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await userEvent.click(box);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ requireApprovalForAccountCreation: true, auditRetentionDays: null });
    expect(await screen.findByText('Policy saved')).toBeInTheDocument();
    // Saved is what the server now holds, so the flag clears.
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });

  it('puts a server refusal against the field it names', async () => {
    mockApi(() =>
      json(
        {
          title: 'Validation failed',
          status: 400,
          errors: [{ path: 'onboardSloHours', message: 'must not exceed the standard departure' }],
        },
        400,
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Save policy' }));
    expect(
      await screen.findByRole('button', {
        name: 'Hire: hours to verified access: must not exceed the standard departure',
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Hire: hours to verified access')).toHaveAttribute('aria-invalid', 'true');
  });
});
