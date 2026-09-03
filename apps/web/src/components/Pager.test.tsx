import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pager } from '@syntra/ui';

describe('Pager', () => {
  it('says which rows are on screen and how many there are', () => {
    render(<Pager page={2} pageSize={50} total={4312} onPage={() => {}} />);
    expect(screen.getByText('51–100 of 4,312')).toBeVisible();
  });

  it('refuses previous on the first page and next on the last', () => {
    // `aria-disabled`, not `disabled`. A button that becomes `disabled` under
    // the cursor loses focus to <body>, so a keyboard user who pages to the
    // last page restarts tabbing from the top of the document. Kept focusable,
    // announced as unavailable, and inert when pressed.
    const { rerender } = render(
      <Pager page={1} pageSize={10} total={30} onPage={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Absent rather than "false" when it is usable: an attribute that is only
    // present when it applies is what React renders and what AT expects.
    expect(screen.getByRole('button', { name: 'Next' })).not.toHaveAttribute(
      'aria-disabled',
    );

    rerender(<Pager page={3} pageSize={10} total={30} onPage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('does not move when a refused control is pressed', () => {
    const onPage = vi.fn();
    render(<Pager page={1} pageSize={10} total={30} onPage={onPage} />);

    screen.getByRole('button', { name: 'Previous' }).click();

    expect(onPage).not.toHaveBeenCalled();
  });

  it('refuses both when everything fits on one page, and still shows the count', () => {
    // Hiding the control here would take the count with it, and the count is
    // one of the answers the screen exists to give.
    render(<Pager page={1} pageSize={50} total={12} onPage={() => {}} />);
    expect(screen.getByText('1–12 of 12')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('names itself, so two bare arrows are not the only clue', () => {
    render(<Pager page={1} pageSize={10} total={30} onPage={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeVisible();
  });

  it('asks for the next page by number', async () => {
    const onPage = vi.fn();
    render(<Pager page={2} pageSize={10} total={100} onPage={onPage} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(3);
  });

  it('says so when there is nothing to page through', () => {
    render(<Pager page={1} pageSize={50} total={0} onPage={() => {}} />);
    expect(screen.getByText('No results')).toBeVisible();
  });
});
