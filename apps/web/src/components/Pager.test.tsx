import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pager } from '@syntra/ui';

describe('Pager', () => {
  it('says which rows are on screen and how many there are', () => {
    render(<Pager page={2} pageSize={50} total={4312} onPage={() => {}} />);
    expect(screen.getByText('51–100 of 4,312')).toBeVisible();
  });

  it('disables previous on the first page and next on the last', () => {
    const { rerender } = render(
      <Pager page={1} pageSize={10} total={30} onPage={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    rerender(<Pager page={3} pageSize={10} total={30} onPage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('disables both when everything fits on one page, and still shows the count', () => {
    // Hiding the control here would take the count with it, and the count is
    // one of the answers the screen exists to give.
    render(<Pager page={1} pageSize={50} total={12} onPage={() => {}} />);
    expect(screen.getByText('1–12 of 12')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
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
