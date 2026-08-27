import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WebhooksPage } from './WebhooksPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const endpoint = (over: Record<string, unknown> = {}) => ({
  id: 'ep-1',
  name: 'Ticketing',
  url: 'https://hooks.example.com/syntra',
  enabled: true,
  events: ['approvals'],
  pending: 0,
  failing: 0,
  lastFailureAt: null,
  ...over,
});

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'del-1',
  event: 'automate-stage-opened',
  attempts: 6,
  maxAttempts: 6,
  nextAttemptAt: '2026-08-26T12:00:00.000Z',
  deliveredAt: null,
  lastStatus: 500,
  lastError: 'the receiver answered 500',
  createdAt: '2026-08-26T11:00:00.000Z',
  state: 'failed',
  ...over,
});

/** Answers the list, the deliveries and any write, recording the writes. */
function mockApi(options: {
  endpoints?: unknown[];
  deliveries?: unknown[];
  post?: (body: unknown) => Response;
}) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, method, body });
      return Promise.resolve(options.post ? options.post(body) : json({}));
    }
    if (url.includes('/deliveries')) {
      return Promise.resolve(json({ deliveries: options.deliveries ?? [] }));
    }
    return Promise.resolve(json({ endpoints: options.endpoints ?? [] }));
  });
  return sent;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <WebhooksPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('WebhooksPage', () => {
  it('says what an endpoint is for when there are none', async () => {
    mockApi({});
    renderPage();
    expect(await screen.findByText(/nothing is subscribed/i)).toBeInTheDocument();
  });

  it('names the events by what happened, not by their template', async () => {
    mockApi({ endpoints: [endpoint()] });
    renderPage();
    // 'approvals' is what is stored; 'Approvals waiting' is what is shown.
    expect(await screen.findByText('Approvals waiting')).toBeInTheDocument();
    expect(screen.queryByText('approvals')).toBeNull();
  });

  it('says an endpoint with no filter sends everything', async () => {
    mockApi({ endpoints: [endpoint({ events: [] })] });
    renderPage();
    expect(await screen.findByText('Everything')).toBeInTheDocument();
  });

  it('shows a failing endpoint as failing rather than as an average', async () => {
    mockApi({ endpoints: [endpoint({ pending: 4, failing: 1 })] });
    renderPage();
    // The one that did not arrive is the one worth reading.
    expect(await screen.findByText(/1 not delivered/i)).toBeInTheDocument();
    expect(screen.queryByText(/queued/i)).toBeNull();
  });

  it('shows a paused endpoint as paused', async () => {
    mockApi({ endpoints: [endpoint({ enabled: false, pending: 3 })] });
    renderPage();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
  });

  it('sends the ticked groups when creating an endpoint', async () => {
    const user = userEvent.setup();
    const sent = mockApi({
      post: () => json({ endpoint: endpoint(), secret: 'whsec_abc' }, 201),
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new endpoint/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'Ticketing');
    await user.type(screen.getByLabelText(/address/i), 'https://hooks.example.com/x');
    await user.click(screen.getByLabelText(/approvals waiting/i));
    await user.click(screen.getByRole('button', { name: /create and show secret/i }));

    await waitFor(() =>
      expect(sent[0]!.body).toEqual({
        name: 'Ticketing',
        url: 'https://hooks.example.com/x',
        enabled: true,
        events: ['approvals'],
      }),
    );
  });

  it('shows the secret once, after creating', async () => {
    const user = userEvent.setup();
    mockApi({ post: () => json({ endpoint: endpoint(), secret: 'whsec_abc' }, 201) });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new endpoint/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'Ticketing');
    await user.type(screen.getByLabelText(/address/i), 'https://hooks.example.com/x');
    await user.click(screen.getByRole('button', { name: /create and show secret/i }));

    expect(await screen.findByText('whsec_abc')).toBeInTheDocument();

    // Dismissed, it is gone from the page. There is no route that reads it
    // back, so a screen that could redisplay it would be lying.
    await user.click(screen.getByRole('button', { name: /^done$/i }));
    expect(screen.queryByText('whsec_abc')).toBeNull();
  });

  it('puts a rejected address against the field that caused it', async () => {
    const user = userEvent.setup();
    mockApi({
      post: () =>
        json(
          {
            title: 'That address cannot be used',
            detail: 'only http and https addresses may be used, not ftp',
            status: 400,
          },
          400,
        ),
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /new endpoint/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'Files');
    await user.type(screen.getByLabelText(/address/i), 'ftp://files.example.com/x');
    await user.click(screen.getByRole('button', { name: /create and show secret/i }));

    expect(await screen.findByText(/not ftp/i)).toBeInTheDocument();
    // Still on the form, with what was typed intact.
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Files');
  });

  it('pauses an endpoint without asking it to resend anything', async () => {
    const user = userEvent.setup();
    const sent = mockApi({ endpoints: [endpoint()] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /pause/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.body).toEqual({ enabled: false });
  });

  it('offers Send again only on a delivery that has stopped trying', async () => {
    const user = userEvent.setup();
    mockApi({
      endpoints: [endpoint()],
      deliveries: [delivery(), delivery({ id: 'del-2', state: 'delivered', deliveredAt: '2026-08-26T11:05:00.000Z' })],
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /activity/i }));

    // The LAST match, not the first: the activity table is nested inside a
    // row of the endpoint table, so that outer row contains every delivery
    // row and matches anything they match.
    const rows = await screen.findAllByRole('row');
    const innermost = (pattern: RegExp) =>
      rows.filter((row) => within(row).queryByText(pattern)).at(-1)!;

    expect(
      within(innermost(/refused with 500/i)).getByRole('button', { name: /send again/i }),
    ).toBeInTheDocument();
    expect(
      within(innermost(/^delivered$/i)).queryByRole('button', { name: /send again/i }),
    ).toBeNull();
  });

  it('never shows a response body from the receiver', async () => {
    const user = userEvent.setup();
    mockApi({
      endpoints: [endpoint()],
      // The API does not put a body in `lastError`, and the screen must not
      // invent a place for one either: it would be a way to read whatever the
      // server can reach.
      deliveries: [delivery({ lastError: 'the receiver answered 500' })],
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /activity/i }));
    expect(await screen.findByText(/refused with 500/i)).toBeInTheDocument();
  });
});
