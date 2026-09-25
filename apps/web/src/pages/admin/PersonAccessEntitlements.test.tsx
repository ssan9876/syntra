import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FILTER_FROM, HoldingsTable, type Holding } from './PersonAccessEntitlements.js';

const holding = (n: number, extra: Partial<Holding> = {}): Holding => ({
  entitlementId: `e${n}`,
  displayName: `Group ${n}`,
  origin: 'rule',
  ruleId: 'r1',
  ruleName: 'Finance staff',
  contractId: null,
  contractDescription: null,
  grantedByRuleId: null,
  grantedByRuleName: null,
  attributionStale: false,
  currentRules: [{ ruleId: 'r1', ruleName: 'Finance staff', contractId: null, contractDescription: null }],
  grantId: null,
  requestId: null,
  grantEndsAt: null,
  ...extra,
});

const many = [
  ...Array.from({ length: FILTER_FROM }, (_, i) => holding(i)),
  holding(90, { displayName: 'Payroll-Admin', origin: 'manual', ruleId: null, ruleName: null, currentRules: [] }),
  holding(91, { displayName: 'Old share', attributionStale: true, ruleName: null, currentRules: [] }),
];

const show = (holdings: Holding[]) => render(<MemoryRouter><HoldingsTable holdings={holdings} /></MemoryRouter>);

describe('HoldingsTable', () => {
  it('adds no controls to a short list', () => {
    show(many.slice(0, 3));
    expect(screen.queryByLabelText('Find entitlement')).toBeNull();
    expect(screen.getByText('Group 1')).toBeInTheDocument();
  });

  it('finds one entitlement and shows the active search as a removable chip', async () => {
    const user = userEvent.setup();
    show(many);
    await user.type(screen.getByLabelText('Find entitlement'), 'payroll');
    expect(screen.getByText('Payroll-Admin')).toBeInTheDocument();
    expect(screen.queryByText('Group 1')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(`1 of ${many.length}`);
    const chips = screen.getByRole('group', { name: 'Active filters' });
    await user.click(within(chips).getByRole('button', { name: /Remove filter Search/ }));
    expect(screen.getByText('Group 1')).toBeInTheDocument();
  });

  it('filters to the holdings nothing asks for any more', async () => {
    const user = userEvent.setup();
    show(many);
    await user.click(within(screen.getByRole('group', { name: 'Origin' })).getByRole('button', { name: /Nothing asks for it/ }));
    expect(screen.getByText('Old share')).toBeInTheDocument();
    expect(screen.queryByText('Payroll-Admin')).toBeNull();
    expect(screen.queryByText('Group 1')).toBeNull();
  });
});
