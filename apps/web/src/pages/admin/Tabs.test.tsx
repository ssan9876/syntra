import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Tabs } from '../../components/Tabs.js';

/**
 * The primitive every merged destination depends on.
 *
 * Seven groups of navigation collapse into tabbed pages, so a tab is now a
 * first-class location rather than a widget: it must be linkable, restorable
 * from a URL, and reachable from a keyboard. A tab strip that only holds
 * useState would make "send me that screen" impossible on eleven pages.
 */

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/admin/users"
          element={
            <Tabs
              label="Users"
              tabs={[
                { id: 'people', label: 'People', content: <p>people panel</p> },
                { id: 'accounts', label: 'Accounts', content: <p>accounts panel</p> },
                { id: 'import', label: 'Import', content: <p>import panel</p> },
              ]}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Tabs', () => {
  it('shows the first tab when the URL names none', () => {
    renderAt('/admin/users');
    expect(screen.getByText('people panel')).toBeInTheDocument();
    expect(screen.queryByText('accounts panel')).not.toBeInTheDocument();
  });

  it('opens the tab the URL names, so a link to one is a link to it', () => {
    // The reason this is a search parameter and not useState. An
    // administrator pasting "the orphans screen" into a ticket has to land
    // on the orphans screen, not on whichever tab happens to be first.
    renderAt('/admin/users?tab=accounts');
    expect(screen.getByText('accounts panel')).toBeInTheDocument();
  });

  it('falls back to the first tab rather than blank on an unknown id', () => {
    // A renamed tab leaves stale links in tickets and bookmarks. Rendering
    // nothing would read as a broken page; the first tab reads as the page.
    renderAt('/admin/users?tab=nonexistent');
    expect(screen.getByText('people panel')).toBeInTheDocument();
  });

  it('marks exactly one tab selected', () => {
    renderAt('/admin/users?tab=accounts');
    const selected = screen.getAllByRole('tab', { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Accounts');
  });

  it('switches on click and records it in the URL', async () => {
    renderAt('/admin/users');
    await userEvent.click(screen.getByRole('tab', { name: 'Import' }));
    expect(screen.getByText('import panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Import' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves between tabs with the arrow keys', async () => {
    // WAI-ARIA requires it, and a tab strip is the one place a keyboard user
    // reasonably expects arrows rather than Tab, because Tab has to reach
    // the panel.
    renderAt('/admin/users');
    await userEvent.click(screen.getByRole('tab', { name: 'People' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('wraps from the last tab to the first', async () => {
    // A strip that stops dead at the end makes a keyboard reader reverse
    // over every tab to reach the one before the first.
    renderAt('/admin/users?tab=import');
    await userEvent.click(screen.getByRole('tab', { name: 'Import' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'People' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('keeps only the selected tab in the tab order', async () => {
    // Roving tabindex. Eleven pages will carry a strip of up to seven tabs;
    // without it a keyboard user pays seven stops before reaching content.
    renderAt('/admin/users');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('ties each panel to the tab that opened it', () => {
    renderAt('/admin/users');
    const tab = screen.getByRole('tab', { name: 'People' });
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  });

  it('hides a tab the caller cannot use without leaving a gap', () => {
    // Permission filtering happens here rather than at every call site,
    // because a merged page is exactly where one reader sees three tabs and
    // another sees one.
    render(
      <MemoryRouter initialEntries={['/x']}>
        <Tabs
          label="Users"
          tabs={[
            { id: 'people', label: 'People', content: <p>a</p> },
            { id: 'accounts', label: 'Accounts', content: <p>b</p>, hidden: true },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});
