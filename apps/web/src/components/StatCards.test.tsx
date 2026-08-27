import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatCard, StatGrid } from './StatCards.js';

/**
 * The card language the redesigned console leads with.
 *
 * Every merged destination now opens with a row of figures answering "is
 * anything wrong here" before the reader reaches a table. The cards therefore
 * have to be scannable in a glance and honest when the answer is "nothing" —
 * a grid of red zeroes trains people to ignore red.
 */
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('StatCard', () => {
  it('shows the figure and what it counts', () => {
    wrap(<StatCard label="People" value={128} />);
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('People')).toBeInTheDocument();
  });

  it('stays quiet at zero even when given an alarming tone', () => {
    // An outcome that did not happen is not a warning about it. Without this
    // a healthy console is a wall of coloured noughts.
    wrap(<StatCard label="Blocked" value={0} tone="danger" quietWhenZero />);
    expect(screen.getByText('0').className).toMatch(/text-muted/);
  });

  it('keeps the tone when the figure is not zero', () => {
    wrap(<StatCard label="Blocked" value={3} tone="danger" quietWhenZero />);
    expect(screen.getByText('3').className).toMatch(/text-danger/);
  });

  it('becomes a link when the figure has somewhere to go', () => {
    // A count of blocked runs that cannot be clicked is a dead end: the
    // reader has been told there is a problem and given no route to it.
    wrap(<StatCard label="Blocked" value={3} to="/admin/targets?tab=runs" />);
    expect(screen.getByRole('link', { name: /Blocked/ })).toHaveAttribute(
      'href',
      '/admin/targets?tab=runs',
    );
  });

  it('is not a link when there is nowhere to go', () => {
    wrap(<StatCard label="People" value={128} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders digits with tabular figures so a row of cards lines up', () => {
    wrap(<StatCard label="People" value={128} />);
    expect(screen.getByText('128').className).toMatch(/tabular-nums/);
  });
});

describe('StatGrid', () => {
  it('lays cards out without forcing a fixed column count', () => {
    // These grids carry two figures on one screen and six on another. A
    // fixed four-up becomes four slivers on a narrow console.
    const { container } = wrap(
      <StatGrid>
        <StatCard label="A" value={1} />
        <StatCard label="B" value={2} />
      </StatGrid>,
    );
    expect(container.firstElementChild?.className).toMatch(/auto-fit/);
  });
});
