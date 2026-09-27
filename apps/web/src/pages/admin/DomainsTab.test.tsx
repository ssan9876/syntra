import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DomainsTab, type EmailDomain } from './DomainsTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

const pending: EmailDomain = {
  id: '6b1f1a52-3d0e-4c38-9a53-4c1b1c0f0a01',
  domain: 'contoso.com',
  record: 'syntra-domain-verification=abc',
  verifiedAt: null,
  lastCheckedAt: null,
  lastCheckError: null,
  createdAt: '2026-09-27T10:00:00.000Z',
};

beforeEach(() => vi.restoreAllMocks());

describe('DomainsTab', () => {
  it('shows each domain with its record, and warns while none is verified', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([pending]));
    render(<DomainsTab />);
    expect(await screen.findByText('contoso.com')).toBeVisible();
    expect(screen.getByText('syntra-domain-verification=abc')).toBeVisible();
    expect(screen.getByText('Not verified')).toBeVisible();
    expect(screen.getByText(/No domain is verified/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeVisible();
  });

  it('adds a domain', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json(pending, 201))
      .mockResolvedValueOnce(json([pending]));
    render(<DomainsTab />);
    await userEvent.type(await screen.findByLabelText('Domain'), 'contoso.com');
    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe('/api/admin/email-domains');
    expect(JSON.parse(String(init?.body))).toEqual({ domain: 'contoso.com' });
    expect(await screen.findByText('contoso.com')).toBeVisible();
  });

  it('says why a domain did not verify', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json([pending]))
      .mockResolvedValueOnce(json({ ...pending, lastCheckError: 'contoso.com has no TXT records yet' }))
      .mockResolvedValueOnce(json([pending]));
    render(<DomainsTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('contoso.com has no TXT records yet')).toBeVisible();
  });

  it('shows a verified domain without the verify controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([{ ...pending, verifiedAt: '2026-09-27T11:00:00.000Z' }]));
    render(<DomainsTab />);
    expect(await screen.findByText('Verified')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.queryByText(/No domain is verified/)).toBeNull();
  });
});
