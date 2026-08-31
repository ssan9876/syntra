import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListControls } from '@syntra/ui';

describe('ListControls', () => {
  it('reports the search once typing settles, not once per keystroke', async () => {
    // `shouldAdvanceTime`, as SyncRunDetailPage.polling and UpdatesPage both
    // do: without it userEvent's own internal timers never fire and `type`
    // hangs until vitest kills the test.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn();
    render(<ListControls search="" onSearch={onSearch} searchLabel="Search people" />);

    await user.type(screen.getByLabelText('Search people'), 'arch');
    expect(onSearch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('arch');
    vi.useRealTimers();
  });

  it('shows the value it was given, so a URL with ?q= arrives populated', () => {
    render(<ListControls search="arch" onSearch={() => {}} searchLabel="Search people" />);
    expect(screen.getByLabelText('Search people')).toHaveValue('arch');
  });

  it('follows the search changing underneath it, which is what back does', () => {
    const { rerender } = render(
      <ListControls search="arch" onSearch={() => {}} searchLabel="Search people" />,
    );
    rerender(
      <ListControls search="" onSearch={() => {}} searchLabel="Search people" />,
    );
    expect(screen.getByLabelText('Search people')).toHaveValue('');
  });

  it('offers a status filter only when it is given one', () => {
    const { rerender } = render(
      <ListControls search="" onSearch={() => {}} searchLabel="Search" />,
    );
    expect(screen.queryByLabelText('Status')).toBeNull();

    rerender(
      <ListControls
        search=""
        onSearch={() => {}}
        searchLabel="Search"
        status={{
          value: '',
          onChange: () => {},
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
          ],
        }}
      />,
    );
    expect(screen.getByLabelText('Status')).toBeVisible();
  });
});
