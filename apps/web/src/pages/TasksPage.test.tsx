import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from './TasksPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const unlock = {
  id: 'task-1',
  name: 'Unlock an account',
  description: 'For the service desk.',
  actionLabel: 'Unlock an account',
  formSchema: [
    { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user', required: true },
  ],
};

const withReason = {
  ...unlock,
  id: 'task-2',
  name: 'Unlock, with a note',
  formSchema: [
    { key: 'user', type: 'lookup', label: 'Account', dataSource: 'user', required: true },
    {
      key: 'escalated',
      type: 'checkbox',
      label: 'Escalated to me',
      required: false,
    },
    {
      key: 'note',
      type: 'text',
      label: 'Who escalated it',
      required: true,
      visibleWhen: { field: 'escalated', equals: true },
    },
  ],
};

function mockApi(options: { tasks?: unknown[]; run?: () => Response } = {}) {
  const sent: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(
        options.run ? options.run() : json({ ok: true, message: 'That account can sign in again.' }),
      );
    }
    if (url.includes('/options')) {
      return Promise.resolve(
        json({
          options: {
            user: [
              { value: 'u1', label: 'Ada Lovelace (ada)' },
              { value: 'u2', label: 'Grace Hopper (grace)' },
            ],
          },
        }),
      );
    }
    return Promise.resolve(json({ tasks: options.tasks ?? [unlock] }));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <TasksPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TasksPage', () => {
  it('says what the page is for when nothing has been delegated', async () => {
    mockApi({ tasks: [] });
    renderPage();
    expect(await screen.findByText(/nothing has been delegated to you/i)).toBeInTheDocument();
  });

  it('offers a picker of names, not of ids', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    // A picker of UUIDs is not a picker.
    expect(
      await screen.findByRole('option', { name: 'Ada Lovelace (ada)' }),
    ).toBeInTheDocument();
  });

  it('will not run until the required field is filled in', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    const run = await screen.findByRole('button', { name: /^unlock an account$/i });
    expect(run).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/account/i), 'u1');
    expect(run).not.toBeDisabled();
  });

  it('sends what was chosen', async () => {
    const user = userEvent.setup();
    const sent = mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    await user.selectOptions(await screen.findByLabelText(/account/i), 'u1');
    await user.click(screen.getByRole('button', { name: /^unlock an account$/i }));

    await waitFor(() =>
      expect(sent[0]).toMatchObject({
        url: expect.stringContaining('/api/portal/tasks/task-1/run'),
        body: { values: { user: 'u1' } },
      }),
    );
  });

  it('shows a hidden field only once its condition holds', async () => {
    const user = userEvent.setup();
    mockApi({ tasks: [withReason] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock, with a note/i }));
    expect(screen.queryByLabelText(/who escalated it/i)).toBeNull();

    await user.click(screen.getByLabelText(/escalated to me/i));
    expect(screen.getByLabelText(/who escalated it/i)).toBeInTheDocument();
  });

  it('does not send a field it never showed', async () => {
    // A hidden field's value is not an answer anybody gave, and the server
    // drops it too — sending it would make the two disagree about what was
    // submitted.
    const user = userEvent.setup();
    const sent = mockApi({ tasks: [withReason] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock, with a note/i }));
    await user.selectOptions(await screen.findByLabelText(/account/i), 'u1');
    await user.click(screen.getByRole('button', { name: /^unlock an account$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ values: { user: 'u1' } });
  });

  it('shows the refusal when the account is out of reach', async () => {
    const user = userEvent.setup();
    mockApi({
      run: () =>
        json(
          {
            title: 'That account is out of reach',
            detail:
              'this task cannot act on that account: it holds a permission you do not',
            status: 403,
          },
          403,
        ),
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    await user.selectOptions(await screen.findByLabelText(/account/i), 'u1');
    await user.click(screen.getByRole('button', { name: /^unlock an account$/i }));

    // The rule, stated. Somebody who has hit it has hit a rule, not a bug.
    expect(
      await screen.findByText(/holds a permission you do not/i),
    ).toBeInTheDocument();
  });

  it('reports what happened, in the action’s own words', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    await user.selectOptions(await screen.findByLabelText(/account/i), 'u1');
    await user.click(screen.getByRole('button', { name: /^unlock an account$/i }));

    expect(await screen.findByText(/can sign in again/i)).toBeInTheDocument();
  });
});
