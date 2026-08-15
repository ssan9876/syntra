import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SourcesPage } from './SourcesPage.js';

const source = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Corporate LDAP',
  type: 'ldap',
  schedule: '0 * * * *',
  autoApply: false,
  enabled: true,
  lastRunAt: null,
  config: { tlsMode: 'ldaps', rejectUnauthorized: true },
  ...overrides,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockFetch(sources: Record<string, unknown>[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(json({ sources })),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <SourcesPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('SourcesPage transport column', () => {
  it('names LDAPS and StartTLS as themselves', async () => {
    mockFetch([
      source(),
      source({ id: 's2', name: 'Branch', config: { tlsMode: 'starttls' } }),
    ]);
    renderPage();

    expect(await screen.findByText('LDAPS')).toBeInTheDocument();
    expect(screen.getByText('StartTLS')).toBeInTheDocument();
  });

  it('says plainly when a source binds in the clear', async () => {
    // The bind password crosses the wire on this connection. An administrator
    // should learn that from the page they already look at.
    mockFetch([source({ config: { tlsMode: 'plain' } })]);
    renderPage();

    expect(await screen.findByText(/not encrypted/i)).toBeInTheDocument();
  });

  it('treats a source saved before the mode existed by its URL scheme', async () => {
    mockFetch([source({ config: {} })]);
    renderPage();

    expect(await screen.findByText(/not encrypted/i)).toBeInTheDocument();
  });

  it('flags a source that has certificate verification turned off', async () => {
    mockFetch([
      source({ config: { tlsMode: 'ldaps', rejectUnauthorized: false } }),
    ]);
    renderPage();

    expect(await screen.findByText(/certificate not verified/i)).toBeInTheDocument();
  });

  it('says nothing about certificates when verification is on', async () => {
    mockFetch([source()]);
    renderPage();

    await screen.findByText('LDAPS');
    expect(screen.queryByText(/certificate not verified/i)).not.toBeInTheDocument();
  });
});
