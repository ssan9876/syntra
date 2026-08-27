import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DelegatedTasksTab } from './DelegatedTasksTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const unlockAction = {
  key: 'unlock_account',
  label: 'Unlock an account',
  description: 'Clears a lockout so somebody can sign in again.',
  inputs: [{ key: 'user', type: 'lookup', label: 'Account', dataSource: 'user' }],
};

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task-1',
  name: 'Unlock an account',
  description: 'For the service desk.',
  actionKey: 'unlock_account',
  actionLabel: 'Unlock an account',
  audienceCondition: { all: [] },
  enabled: true,
  ...over,
});

function mockApi(options: { tasks?: unknown[]; post?: () => Response } = {}) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Promise.resolve(options.post ? options.post() : json({}, 201));
    }
    if (url.includes('/tasks/actions')) {
      return Promise.resolve(json({ actions: [unlockAction] }));
    }
    if (url.includes('/runs')) {
      return Promise.resolve(
        json({
          runs: [
            {
              id: 'r1',
              runByUserId: 'u1',
              subjectUserId: 'u2',
              outcome: 'refused',
              message: 'it holds a permission you do not',
              createdAt: '2026-08-26T12:00:00.000Z',
            },
          ],
        }),
      );
    }
    if (url.includes('/api/admin/groups')) {
      return Promise.resolve(
        json({ groups: [{ id: 'g1', name: 'Service desk' }, { id: 'g2', name: 'Finance' }] }),
      );
    }
    return Promise.resolve(json({ tasks: options.tasks ?? [] }));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <DelegatedTasksTab />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('DelegatedTasksTab', () => {
  it('says what a task is for when there are none', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText(/nothing is delegated yet/i)).toBeInTheDocument();
  });

  it('warns when a task admits nobody', async () => {
    // The state somebody left half-configured, and worth saying loudly rather
    // than showing an empty cell.
    mockApi({ tasks: [task({ audienceCondition: null })] });
    renderPage();
    expect(await screen.findByText('Nobody')).toBeInTheDocument();
  });

  it('offers no form builder — the action decides the form', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new task/i }));
    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));

    // Choosing the action is the whole form design. A builder here is a screen
    // whose commonest outcome is a task that saves and does nothing.
    expect(screen.queryByText(/add a field/i)).toBeNull();
    expect(screen.queryByLabelText(/field key/i)).toBeNull();
  });

  it('names the task after the action that was picked', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new task/i }));
    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Unlock an account');
  });

  it('will not save until somebody can run it', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new task/i }));
    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));

    // A task nobody can run is not a task.
    expect(screen.getByRole('button', { name: /create task/i })).toBeDisabled();
    await user.click(screen.getByLabelText(/anyone with an active contract/i));
    expect(screen.getByRole('button', { name: /create task/i })).not.toBeDisabled();
  });

  it('sends the generated form and the chosen audience', async () => {
    const user = userEvent.setup();
    const sent = mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new task/i }));
    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    await user.click(screen.getByLabelText(/members of service desk/i));
    await user.click(screen.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(sent[0]!.body).toMatchObject({
        actionKey: 'unlock_account',
        // Generated from what the action declares it reads.
        formSchema: [
          { key: 'user', type: 'lookup', label: 'Account', required: true, dataSource: 'user' },
        ],
        audienceCondition: { field: 'user.memberOfGroup', op: 'in', value: ['g1'] },
      }),
    );
  });

  it('offers groups by name, not by id', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new task/i }));
    await user.click(await screen.findByRole('button', { name: /unlock an account/i }));
    // Not a JSON box with a paragraph explaining what to type in it.
    expect(screen.getByLabelText(/members of service desk/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/audience condition/i)).toBeNull();
  });

  it('pauses a task without changing anything else about it', async () => {
    const user = userEvent.setup();
    const sent = mockApi({ tasks: [task()] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /pause/i }));
    await waitFor(() =>
      expect(sent[0]!.body).toMatchObject({
        name: 'Unlock an account',
        enabled: false,
        audienceCondition: { all: [] },
      }),
    );
  });

  it('shows what a task has done, refusals included', async () => {
    // A delegated task is the one place somebody exercises authority they do
    // not hold. The refused attempts are exactly what somebody comes here
    // looking for, so a list that only showed successes would be the wrong
    // list — and this endpoint had no console surface at all.
    const user = userEvent.setup();
    mockApi({ tasks: [task()] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /activity/i }));
    expect(await screen.findByText('Refused')).toBeInTheDocument();
    expect(screen.getByText(/permission you do not/i)).toBeInTheDocument();
  });
});
