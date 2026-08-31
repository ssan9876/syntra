import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Tabs } from './Tabs.js';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}

const strip = (resetParams?: readonly string[]) => (
  <MemoryRouter initialEntries={['/admin/users?tab=people&q=arch&page=3']}>
    <Tabs
      label="Directory"
      {...(resetParams ? { resetParams } : {})}
      tabs={[
        { id: 'people', label: 'People', content: <p>people</p> },
        { id: 'accounts', label: 'Accounts', content: <p>accounts</p> },
      ]}
    />
    <LocationProbe />
  </MemoryRouter>
);

describe('Tabs', () => {
  it("drops a panel's own params when the tab changes", async () => {
    // Two tabs share one query string. Without this, a search and a page number
    // set on People arrive in Accounts and silently apply to a different list.
    render(strip(['q', 'status', 'page']));

    await userEvent.click(screen.getByRole('tab', { name: 'Accounts' }));

    expect(screen.getByTestId('search')).toHaveTextContent('tab=accounts');
    expect(screen.getByTestId('search')).not.toHaveTextContent('q=arch');
    expect(screen.getByTestId('search')).not.toHaveTextContent('page=3');
  });

  it('leaves every param alone when no panel claims any', async () => {
    render(strip());

    await userEvent.click(screen.getByRole('tab', { name: 'Accounts' }));

    expect(screen.getByTestId('search')).toHaveTextContent('q=arch');
  });
});
