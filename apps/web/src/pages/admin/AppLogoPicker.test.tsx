import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@syntra/ui';
import { AppLogoPicker } from './AppLogoPicker.js';
import type { ApplicationIconView } from '@syntra/contracts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

function renderPicker(icon: ApplicationIconView = null, onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <AppLogoPicker applicationId="app-1" name="Payroll Hub" icon={icon} onSaved={onSaved} />
    </ToastProvider>,
  );
  return onSaved;
}

const preview = () => screen.getByRole('img', { name: 'Portal preview' });

beforeEach(() => vi.restoreAllMocks());

describe('AppLogoPicker', () => {
  it('previews a built-in mark as the portal tile, and saves only on Save', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ icon: { kind: 'builtin', key: 'finance', url: '/app-icons/finance.svg' } }) as never,
    );
    const onSaved = renderPicker();
    expect(within(preview()).getByText('PH')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save logo' })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: 'Finance' }));
    expect(preview().querySelector('img')).toHaveAttribute('src', '/app-icons/finance.svg');
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save logo' }));
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/applications/app-1/icon',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ icon: { kind: 'builtin', key: 'finance' } }) }),
    );
    expect(onSaved).toHaveBeenCalledWith({ kind: 'builtin', key: 'finance', url: '/app-icons/finance.svg' });
    expect(await screen.findByText('Logo saved')).toBeVisible();
  });

  it('offers every built-in mark and the monogram as one keyboard group', () => {
    renderPicker({ kind: 'builtin', key: 'mail', url: '/app-icons/mail.svg' });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(21);
    expect(screen.getByRole('radio', { name: 'Mail' })).toBeChecked();
    expect(new Set(radios.map((r) => r.getAttribute('name'))).size).toBe(1);
  });

  it('removes the logo by choosing the monogram', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ icon: null }) as never);
    renderPicker({ kind: 'builtin', key: 'mail', url: '/app-icons/mail.svg' });
    await userEvent.click(screen.getByRole('radio', { name: 'Monogram' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save logo' }));
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/applications/app-1/icon',
      expect.objectContaining({ body: JSON.stringify({ icon: null }) }),
    );
    expect(await screen.findByText('Logo removed')).toBeVisible();
  });

  it('refuses an SVG or an oversized upload before sending anything', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    renderPicker();
    const input = screen.getByLabelText('Upload a logo image');
    await userEvent.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), { applyAccept: false });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PNG, JPEG or WebP image');
    await userEvent.upload(input, new File([new Uint8Array(70 * 1024)], 'big.png', { type: 'image/png' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The limit is 64 KB');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('previews an uploaded image, and shows the server refusal against it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ title: 'Invalid logo', status: 400, errors: [{ path: 'icon', message: 'That file is not a PNG image.' }] }, 400) as never,
    );
    renderPicker();
    await userEvent.upload(
      screen.getByLabelText('Upload a logo image'),
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'payroll.png', { type: 'image/png' }),
    );
    expect(await screen.findByText(/payroll\.png · 1 KB/)).toBeVisible();
    expect(preview().querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await userEvent.click(screen.getByRole('button', { name: 'Save logo' }));
    expect(fetch).toHaveBeenCalled();
    expect(await screen.findByText('That file is not a PNG image.')).toBeVisible();
  });

  it('discards an unsaved choice', async () => {
    renderPicker({ kind: 'builtin', key: 'mail', url: '/app-icons/mail.svg' });
    await userEvent.click(screen.getByRole('radio', { name: 'Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('radio', { name: 'Mail' })).toBeChecked();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});
