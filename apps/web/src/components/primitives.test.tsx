import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  AsyncCombobox,
  BulkActionBar,
  Checkbox,
  ErrorSummary,
  FilterChips,
  Segmented,
  StateBadge,
  Textarea,
  ToastProvider,
  relativeTime,
  useToast,
  type ComboOption,
} from '@syntra/ui';

describe('Checkbox', () => {
  it('shows a partial selection as indeterminate, not as unchecked', () => {
    render(<Checkbox label="Select all" checked={false} indeterminate onChange={() => {}} />);
    expect((screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement).indeterminate).toBe(true);
  });
});

describe('BulkActionBar', () => {
  it('names the selection in words and offers to clear it only when there is one', async () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <BulkActionBar count={0} noun="operation" onClear={onClear}>
        <button type="button">Retry</button>
      </BulkActionBar>,
    );
    expect(screen.getByText('No operations selected')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
    rerender(
      <BulkActionBar count={3} noun="operation" onClear={onClear} result="3 retried">
        <button type="button">Retry</button>
      </BulkActionBar>,
    );
    expect(screen.getByText('3 operations selected')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('3 retried');
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('Segmented and FilterChips', () => {
  it('marks the chosen option as pressed and shows each count', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Work type"
        value="all"
        onChange={onChange}
        options={[
          { value: 'all', label: 'All', count: 4 },
          { value: 'failed', label: 'Failed', count: 1, tone: 'danger' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'All 4' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Failed 1' }));
    expect(onChange).toHaveBeenCalledWith('failed');
  });

  it('renders nothing without filters, and each chip removes its own', async () => {
    const { container, rerender } = render(<FilterChips filters={[]} onReset={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    const remove = vi.fn();
    const reset = vi.fn();
    rerender(<FilterChips filters={[{ key: 'lane', label: 'Lane: Blocked', onRemove: remove }]} onReset={reset} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Lane: Blocked' }));
    expect(remove).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(reset).toHaveBeenCalled();
  });
});

describe('StateBadge', () => {
  it('always carries a word, defaulting to the state name', () => {
    render(
      <>
        <StateBadge state="pending" />
        <StateBadge state="blocked">Failed</StateBadge>
      </>,
    );
    expect(screen.getByText('Pending verification')).toBeVisible();
    expect(screen.getByText('Failed')).toBeVisible();
  });
});

describe('Textarea', () => {
  it('describes itself by its error, which wins over a warning', () => {
    render(<Textarea label="Certificate" value="" onChange={() => {}} warning="Expires soon" error="Not a PEM block" />);
    const box = screen.getByLabelText('Certificate');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription('Not a PEM block');
    expect(screen.queryByText('Expires soon')).not.toBeInTheDocument();
  });
});

describe('ErrorSummary', () => {
  it('takes focus and moves it to the named field', async () => {
    render(
      <form>
        <ErrorSummary errors={[{ field: 'url', message: 'Enter an ldaps:// URL' }, { message: 'The target is disabled' }]} />
        <input name="url" aria-label="URL" />
      </form>,
    );
    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Enter an ldaps:// URL' }));
    expect(screen.getByLabelText('URL')).toHaveFocus();
    expect(screen.getByText('The target is disabled')).toBeVisible();
  });
});

describe('AsyncCombobox', () => {
  function Harness({ load }: { load: (q: string, s: AbortSignal) => Promise<ComboOption[]> }) {
    const [value, setValue] = useState<ComboOption | null>(null);
    return (
      <>
        <AsyncCombobox label="Person" value={value} onChange={setValue} load={load} />
        <output>{value?.value ?? 'none'}</output>
      </>
    );
  }

  it('asks the server for what was typed and picks with the keyboard', async () => {
    const load = vi.fn(async (q: string) =>
      [
        { value: 'p1', label: 'Ana Ruiz', detail: 'ana@acme.test' },
        { value: 'p2', label: 'Ana Ito', detail: 'ito@acme.test' },
      ].filter((o) => o.label.toLowerCase().includes(q.toLowerCase())),
    );
    const user = userEvent.setup();
    render(<Harness load={load} />);
    const input = screen.getByRole('combobox', { name: 'Person' });
    await user.type(input, 'ito');
    expect(await screen.findByRole('option', { name: /Ana Ito/ })).toBeVisible();
    expect(load).toHaveBeenLastCalledWith('ito', expect.any(AbortSignal));
    await user.keyboard('{Enter}');
    expect(screen.getByText('p2')).toBeInTheDocument();
    expect(input).toHaveValue('Ana Ito');
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness load={async () => []} />);
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'zz');
    expect(await screen.findByText('No matches', { selector: 'li' })).toBeVisible();
  });
});

describe('Toast', () => {
  function Trigger({ tone }: { tone: 'success' | 'danger' }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast({ tone, title: tone === 'danger' ? 'Could not save' : 'Saved' })}>
        Go
      </button>
    );
  }

  it('confirms and then leaves, but an error stays until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(
      <ToastProvider>
        <Trigger tone="success" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByText('Saved')).toBeVisible();
    act(() => void vi.advanceTimersByTime(6000));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();

    rerender(
      <ToastProvider>
        <Trigger tone="danger" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Go' }));
    act(() => void vi.advanceTimersByTime(20000));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Could not save')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('is a no-op outside a provider rather than a crash', async () => {
    render(<Trigger tone="success" />);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
  });
});

describe('relativeTime', () => {
  it('is coarse on purpose', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(relativeTime(new Date('2026-09-24T11:59:40Z'), now)).toBe('just now');
    expect(relativeTime(new Date('2026-09-24T11:56:00Z'), now)).toBe('4 min ago');
    expect(relativeTime(new Date('2026-09-24T09:00:00Z'), now)).toBe('3 h ago');
  });
});
