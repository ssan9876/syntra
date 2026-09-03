import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteButton } from './DeleteButton.js';

const noContent = () => new Response(null, { status: 204 }) as never;

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: 'Refused', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  }) as never;

function renderButton(onDeleted = () => {}) {
  return render(
    <DeleteButton
      path="/api/admin/users/u1"
      label="user"
      confirmWord="mokafor"
      warning="The account is removed from the directory and from Syntra."
      onDeleted={onDeleted}
    />,
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('DeleteButton', () => {
  it('will not delete until the name is typed exactly', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(noContent());

    renderButton();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Delete user' });
    expect(confirm).toBeDisabled();

    // A near miss is still a miss. Typing the name is meant to be a second
    // DECISION, not a second click, and a prefix match would make it neither.
    await user.type(screen.getByLabelText(/type mokafor/i), 'mokafo');
    expect(confirm).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/type mokafor/i), 'r');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/u1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('says what will happen before it happens', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      screen.getByText(/removed from the directory and from Syntra/i),
    ).toBeInTheDocument();
  });

  it('reports the server refusal rather than a generic failure', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      problem(409, 'Head office AD is not configured to let Syntra delete objects in it'),
    );

    renderButton();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.type(screen.getByLabelText(/type mokafor/i), 'mokafor');
    await user.click(screen.getByRole('button', { name: 'Delete user' }));

    // The server knows why and said so; flattening that to "could not be
    // deleted" sends the reader to look for a permission that is not the
    // problem.
    expect(
      await screen.findByText(/not configured to let Syntra delete/i),
    ).toBeInTheDocument();
  });

  it('forgets what was typed when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.type(screen.getByLabelText(/type mokafor/i), 'mokafor');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // Reopening must not find the box already filled in: that would leave one
    // click between a stray reopen and a destroyed account.
    expect(screen.getByRole('button', { name: 'Delete user' })).toBeDisabled();
  });

  it('puts focus in the confirmation box, not on the body', async () => {
    // Pressing Delete unmounts the button that was pressed, and a browser
    // drops focus from a removed element to <body>. For a destructive action
    // that left a keyboard reader tabbing the length of the page to reach the
    // field confirming the thing they had just asked to delete.
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByLabelText(/type mokafor/i)).toHaveFocus();
  });

  it('puts focus back on the row control when the delete is called off', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('tells the page when the delete succeeded', async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(noContent());

    renderButton(onDeleted);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.type(screen.getByLabelText(/type mokafor/i), 'mokafor');
    await user.click(screen.getByRole('button', { name: 'Delete user' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  });
});
