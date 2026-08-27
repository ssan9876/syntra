import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BrandingPage } from './BrandingPage.js';

const brand = { name: null, logo: null, primary: null, accent: null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const renderPage = () =>
  render(
    <MemoryRouter>
      <BrandingPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('BrandingPage', () => {
  it('shows Syntra in the preview until a name is chosen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(brand)));
    renderPage();
    // The default is not an empty header. A tenant that has not thought about
    // branding still has to see something on their sign-in page.
    expect(await screen.findByText('Syntra')).toBeInTheDocument();
  });

  it('shows the name in the preview as it is typed, before it is saved', async () => {
    // The preview is the whole point: a colour picker beside a paragraph
    // explaining where the colour appears is a page that has to be read.
    vi.stubGlobal('fetch', vi.fn(async () => json(brand)));
    renderPage();

    await userEvent.type(await screen.findByLabelText('Name'), 'Acme');
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('takes a hex pasted from brand guidelines as well as one picked', async () => {
    // Two controls for one value, because they answer different questions.
    // Offering only the swatch makes somebody who already knows their exact
    // colour eyeball it.
    vi.stubGlobal('fetch', vi.fn(async () => json(brand)));
    renderPage();

    const hex = await screen.findByLabelText('Primary colour');
    await userEvent.type(hex, '#2563eb');
    expect(screen.getByLabelText('Primary colour swatch')).toHaveValue('#2563eb');
  });

  it('does not offer SVG in the file dialog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(brand)));
    renderPage();
    const input = await screen.findByLabelText('Logo file');
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
  });

  it('refuses an SVG that arrives anyway, without a round trip', async () => {
    // `accept` is a filter on a dialog, not a guard: a drag-and-drop, or a
    // browser where somebody picked "All files", hands the input whatever they
    // chose. An SVG is a document — script, foreignObject, external references
    // — and it would render on the unauthenticated sign-in page. The server
    // refuses it too; this is so the refusal is instant and says why.
    //
    // fireEvent rather than userEvent.upload, which itself honours `accept`
    // and so would test the line above a second time instead of this one.
    vi.stubGlobal('fetch', vi.fn(async () => json(brand)));
    renderPage();

    const input = await screen.findByLabelText('Logo file');
    const file = new File(['<svg />'], 'logo.svg', { type: 'image/svg+xml' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/SVG is not accepted/i)).toBeInTheDocument();
  });

  it('refuses a logo too large for a sign-in page on a bad connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(brand)));
    renderPage();

    const input = await screen.findByLabelText('Logo file');
    const big = new File([new Uint8Array(300 * 1024)], 'logo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [big] } });

    expect(await screen.findByText(/300 KB. The limit is 256 KB/)).toBeInTheDocument();
  });

  it('repeats the server refusal verbatim, ratio and all', async () => {
    const detail =
      '#fffbe6 sits at 1.06:1 against the light page, below the 3:1 a control needs. Pick a darker shade of the same colour.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) =>
        init?.method === 'PUT'
          ? json({ status: 400, title: 'That branding cannot be used', detail }, 400)
          : json(brand),
      ),
    );
    renderPage();

    await userEvent.type(await screen.findByLabelText('Primary colour'), '#fffbe6');
    await userEvent.click(screen.getByRole('button', { name: /save branding/i }));

    // The measured number and the direction to move in. "That colour is not
    // allowed" would send somebody back to guessing.
    expect(await screen.findByText(detail)).toBeInTheDocument();
  });

  it('sends a cleared field as null rather than an empty string', async () => {
    // Null is what resets a tenant to Syntra's own identity. An empty string
    // would be stored as a name, and the header would render blank.
    const spy = vi.fn(async (url: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? json(brand) : json({ ...brand, name: 'Acme' }),
    );
    vi.stubGlobal('fetch', spy);
    renderPage();

    await userEvent.clear(await screen.findByLabelText('Name'));
    await userEvent.click(screen.getByRole('button', { name: /save branding/i }));

    await waitFor(() => {
      const call = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PUT');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: null });
    });
  });
});
