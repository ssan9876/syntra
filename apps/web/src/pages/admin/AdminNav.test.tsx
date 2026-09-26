import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminNav } from './AdminNav.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

beforeEach(() => {
  granted.clear();
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has storage; the guard mirrors the component's.
  }
});

/**
 * The navigation stays short, and stays honest.
 *
 * Twenty-nine links became thirteen by moving sixteen of them into tabs. The
 * pressure that produced twenty-nine has not gone away — every new screen
 * wants a link — so the properties that make this navigation readable are
 * asserted rather than left to review.
 */

const source = readFileSync('src/pages/admin/AdminNav.tsx', 'utf8');

const groups = () => {
  // Read the labels straight out of the table rather than rendering, so the
  // assertion holds regardless of what the current reader may see.
  const blocks = source.split("label: '").slice(1);
  return blocks.map((b) => b.slice(0, b.indexOf("'")));
};

describe('the console navigation', () => {
  it('has no group that repeats its only child', () => {
    // "Requests" inside a group labelled "Requests" is a heading that says
    // nothing — the same failure as a paragraph explaining a control.
    const groupLabels = ['Directory', 'Access', 'Connected systems', 'System'];
    for (const label of groupLabels) {
      const after = source.slice(source.indexOf(`label: '${label}'`));
      const items = after.slice(0, after.indexOf(']')).match(/to: '/g) ?? [];
      if (items.length === 1) {
        expect(after.slice(0, after.indexOf(']'))).not.toContain(`label: '${label}',\n`);
      }
    }
  });

  it('stays under twenty links', () => {
    // Not a style preference: past roughly this many, a reader stops reading
    // the rail and starts searching it, and the console goes back to looking
    // like a list of routes.
    const links = source.match(/to: '\/admin/g) ?? [];
    expect(links.length).toBeLessThanOrEqual(20);
  });

  it('sends no two links to the same destination', () => {
    const tos = [...source.matchAll(/to: '(\/admin[^']*)'/g)].map((m) => m[1]);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it('points at no path that was merged away', () => {
    // Every one of these is now a tab. A link left behind here would land on
    // a redirect, which works but flickers and loses the tab the reader was
    // actually sent to.
    const retired = [
      '/admin/people',
      '/admin/import',
      '/admin/sync-runs',
      '/admin/branding',
      '/admin/webhooks',
      '/admin/incidents',
      '/admin/audit',
      '/admin/automate/',
      '/admin/govern/',
    ];
    for (const path of retired) {
      expect(source).not.toContain(`to: '${path}`);
    }
  });

  it('carries no label that is a sentence', () => {
    // "What needs attention" was four words doing the work of a tab strip.
    // A destination whose name needs a verb is a destination that has not
    // been named.
    for (const label of groups()) {
      expect(label.split(' ').length).toBeLessThanOrEqual(2);
    }
  });

  it('renders nothing for a reader with no permissions at all', () => {
    // Hiding is courtesy, not enforcement — but a rail of empty headings
    // reads as a broken page rather than as a permission boundary.
    render(
      <MemoryRouter>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Directory')).not.toBeInTheDocument();
  });

  it('folds a group away and remembers it, but never the one you are in', async () => {
    for (const p of ['directory.read', 'access.read', 'audit.read']) granted.add(p);
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter initialEntries={['/admin/applications']}>
        <AdminNav />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    const directory = screen.getByRole('button', { name: 'Directory' });
    expect(directory).toHaveAttribute('aria-expanded', 'true');
    await user.click(directory);
    expect(directory).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Groups' })).not.toBeInTheDocument();

    // The group holding the current page cannot be folded.
    expect(screen.getByRole('button', { name: 'Access' })).toBeDisabled();
    unmount();

    render(
      <MemoryRouter initialEntries={['/admin/applications']}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Directory' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a folded group when you navigate into it', () => {
    granted.add('directory.read');
    window.localStorage.setItem('syntra.nav.collapsed', JSON.stringify(['Directory']));
    render(
      <MemoryRouter initialEntries={['/admin/groups']}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Groups' })).toBeInTheDocument();
  });
});
