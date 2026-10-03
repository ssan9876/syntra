import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MailTab } from './MailTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const settings = {
  transport: 'smtp',
  server: 'smtp://mail.contoso.com:587',
  from: 'Syntra <no-reply@contoso.com>',
  recipient: 'anna@contoso.com',
  warning: null,
};

beforeEach(() => vi.restoreAllMocks());

describe('MailTab', () => {
  it('shows how mail is sent and who the test goes to', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(settings));
    render(<MailTab />);
    expect(await screen.findByText('smtp://mail.contoso.com:587')).toBeVisible();
    expect(screen.getByText('SMTP')).toBeVisible();
    expect(screen.getByText('Syntra <no-reply@contoso.com>')).toBeVisible();
    expect(screen.getByText('To anna@contoso.com')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns while mail goes to a local test server', async () => {
    const warning = 'Mail goes to smtp://localhost:1025, a local test server. Set SMTP_URL to a real mail server.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ...settings, server: 'smtp://localhost:1025', warning }));
    render(<MailTab />);
    expect(await screen.findByText(warning)).toBeVisible();
  });

  it('sends a test email and says where it went', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(
        json({
          ok: true,
          to: 'anna@contoso.com',
          server: 'smtp://mail.contoso.com:587',
          message: 'Test email sent to anna@contoso.com through smtp://mail.contoso.com:587.',
          warning: null,
        }),
      );
    render(<MailTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('Test email sent to anna@contoso.com through smtp://mail.contoso.com:587.')).toBeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(String(fetch.mock.calls[1]![0])).toBe('/api/admin/mail/test');
    expect(fetch.mock.calls[1]![1]!.method).toBe('POST');
  });

  it("shows the server's refusal", async () => {
    const message =
      'Email to anna@contoso.com was not sent through smtp://mail.contoso.com:587: Invalid login: 535 5.7.8 Authentication failed';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(json({ ok: false, to: 'anna@contoso.com', server: 'smtp://mail.contoso.com:587', message, warning: null }));
    render(<MailTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText(message)).toBeVisible();
  });

  it('says when the limit is reached', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(
        json(
          { type: 'https://syntra.dev/problems/rate-limited', title: 'Too many requests', status: 429, detail: 'Try again in 1 minute.' },
          429,
        ),
      );
    render(<MailTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test email' }));
    expect(await screen.findByText('Try again in 1 minute.')).toBeVisible();
  });
});
