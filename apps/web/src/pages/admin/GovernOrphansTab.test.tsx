import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GovernOrphansTab } from './GovernOrphansTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'prop-1',
  systemId: 'sys-1',
  accountRef: 'CN=mokafor',
  personId: 'p-1',
  proposedName: 'Maya Okafor',
  confidence: 0.82,
  because: 'the login matches the business email',
  ...over,
});

function mockOrphans(proposals: unknown[]) {
  const sent: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (init?.method === 'POST') {
      sent.push({
        url: String(input),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return Promise.resolve(json({}));
    }
    return Promise.resolve(json({ proposals }));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <GovernOrphansTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('an orphan proposal', () => {
  /**
   * The Confirm button called a route whose injected `link` function throws
   * 501 unconditionally -- and the confirmation dialogue in front of it
   * promised that "Provision's next run will evaluate that person's desired
   * state against this account", which is a consequence that cannot happen. An
   * administrator who pressed it learned that the drift screens are broken.
   */
  it('offers no Confirm control', async () => {
    mockOrphans([proposal()]);
    renderPage();
    await screen.findByText(/Maya Okafor/);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  /** And says why, rather than leaving a guess with no verb on the screen. */
  it('says that confirming an owner is not available yet', async () => {
    mockOrphans([proposal()]);
    renderPage();
    expect(await screen.findByText(/cannot be confirmed from here yet/i)).toBeInTheDocument();
  });

  /** Denying still works: it is Govern's own write and it always was. */
  it('still records a denial', async () => {
    const sent = mockOrphans([proposal()]);
    renderPage();
    await screen.findByText(/Maya Okafor/);

    await userEvent.click(screen.getByRole('button', { name: 'Not them' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'different person');
    await userEvent.click(screen.getByRole('button', { name: 'Record it' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.url).toContain('/orphans/prop-1/deny');
    expect(sent[0]!.body).toEqual({ reason: 'different person' });
  });

  /**
   * The reason is asked for IN THE PAGE. `window.prompt` returns null for ever
   * once a browser has been told to block dialogs, so the control silently
   * stops working -- which is what StatusToggle documents and why it moved.
   */
  it('asks for the reason in the page, not through a dialog', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    mockOrphans([proposal()]);
    renderPage();
    await screen.findByText(/Maya Okafor/);

    await userEvent.click(screen.getByRole('button', { name: 'Not them' }));
    expect(await screen.findByLabelText('Reason')).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
  });
});
