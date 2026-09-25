import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PersonProvisionReceipts } from './PersonProvisionReceipts.js';
import type { PersonProvisionReceipt } from './provision-on-create.js';
import type { PersonReceipts } from './use-person-receipts.js';

function row(target: string, status: string, message: string | null, minute = 0, runId: string | null = `run-${target}`): PersonProvisionReceipt {
  return {
    id: `${target}-${minute}`,
    targetSystemId: `t-${target}`,
    targetName: target,
    status,
    runId,
    runIds: runId ? [runId] : [],
    message,
    createdAt: new Date(Date.UTC(2026, 8, 1, 9, minute)).toISOString(),
  };
}

function state(receipts: PersonProvisionReceipt[], extra: Partial<PersonReceipts> = {}): PersonReceipts {
  return {
    receipts,
    problem: null,
    forbidden: false,
    updatedAt: new Date(),
    refreshing: false,
    busy: null,
    reload: vi.fn(),
    retry: vi.fn(async () => {}),
    ...extra,
  };
}

const renderWith = (value: PersonReceipts) =>
  render(<MemoryRouter><PersonProvisionReceipts state={value} /></MemoryRouter>);

describe('PersonProvisionReceipts', () => {
  it('shows applied-but-unobserved work as waiting for read-back, never as done', () => {
    renderWith(state([row('Active Directory', 'verification_pending', 'Awaiting the next read-back.')]));
    const target = screen.getByRole('row', { name: /Active Directory/ });
    expect(within(target).getByText('Applied')).toBeInTheDocument();
    expect(within(target).getByText('Waiting for directory read-back')).toBeInTheDocument();
    expect(within(target).queryByText('Observed')).not.toBeInTheDocument();
    // Nothing to retry while the read-back is still coming.
    expect(within(target).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says observed only after read-back matched', () => {
    renderWith(state([row('Active Directory', 'applied', 'Confirmed by read-back after 1 observation.')]));
    expect(within(screen.getByRole('row', { name: /Active Directory/ })).getByText('Observed')).toBeInTheDocument();
  });

  it('marks a read-back that gave up as needing a person', () => {
    renderWith(state([row('Mail', 'verification_pending', 'Target read-back remained incomplete after 3 observations. Manual verification is required.')]));
    const target = screen.getByRole('row', { name: /Mail/ });
    expect(within(target).getByText('Manual verification required')).toBeInTheDocument();
    expect(within(target).queryByText('Waiting for directory read-back')).not.toBeInTheDocument();
  });

  it('keeps a failure on its target with the exact run and a retry', async () => {
    const value = state([row('Mail', 'failed', 'Some actions failed. Review the run and retry unfinished work.')]);
    renderWith(value);
    const target = screen.getByRole('row', { name: /Mail/ });
    expect(within(target).getByText('Failed')).toBeInTheDocument();
    expect(within(target).getByRole('link', { name: 'Review exact run for Mail' })).toHaveAttribute('href', '/admin/targets/t-Mail/runs/run-Mail');
    await userEvent.click(within(target).getByRole('button', { name: 'Retry unfinished work for Mail' }));
    expect(value.retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'Mail-0' }));
  });

  it('shows only the latest receipt per target', () => {
    renderWith(state([
      row('Mail', 'applied', 'Confirmed.', 30),
      row('Mail', 'failed', 'Old failure.', 10),
    ]));
    expect(screen.getAllByRole('row', { name: /Mail/ })).toHaveLength(1);
    expect(screen.queryByText('Old failure.')).not.toBeInTheDocument();
  });

  it('renders nothing for an operator who may not read provisioning', () => {
    const { container } = renderWith(state([], { receipts: null, forbidden: true }));
    expect(container).toBeEmptyDOMElement();
  });
});
