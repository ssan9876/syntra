import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonSourceDetailPage } from './PersonSourceDetailPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const savedSource = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'HR nightly',
  feedMode: 'snapshot',
  schedule: '0 2 * * *',
  autoApply: false,
  enabled: true,
  config: {
    host: 'hr.example.test',
    port: 22,
    username: 'syntra',
    remotePath: '/export/people.csv',
  },
  ...over,
});

interface Routes {
  source?: Record<string, unknown>;
  test?: unknown;
  rules?: unknown[];
}

function mockFetch(routes: Routes = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const request = (init ?? {}) as RequestInit;
    calls.push({ url, init: request });

    if (request.method === 'POST' && url.includes('/test')) {
      return Promise.resolve(json(routes.test ?? { ok: true, message: 'read 2 rows' }));
    }
    if (request.method === 'POST' && url.includes('/host-key')) {
      return Promise.resolve(json(savedSource()));
    }
    if (request.method === 'POST') return Promise.resolve(json({ id: 's1' }));
    if (request.method === 'PATCH') return Promise.resolve(json(savedSource()));
    if (request.method === 'PUT') return Promise.resolve(json({ rules: [] }));

    if (url.includes('/mappings')) {
      return Promise.resolve(json({ rules: routes.rules ?? [] }));
    }
    if (url.includes('/person-sources/')) {
      return Promise.resolve(json(routes.source ?? savedSource()));
    }
    return Promise.resolve(json({}));
  });
  return calls;
}

const renderNew = () =>
  render(
    <MemoryRouter initialEntries={['/admin/person-sources/new']}>
      <Routes>
        <Route path="/admin/person-sources/new" element={<PersonSourceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/person-sources/s1']}>
      <Routes>
        <Route path="/admin/person-sources/:id" element={<PersonSourceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const bodyOf = (call: { init: RequestInit }) =>
  JSON.parse(String(call.init.body)) as Record<string, never>;

beforeEach(() => vi.restoreAllMocks());

describe('choosing what the file contains', () => {
  /**
   * The most dangerous field in the product. Reading a delta file as a
   * snapshot departs everyone who did not change yesterday, and a preselected
   * default is how that happens without anybody choosing it.
   */
  it('preselects neither mode', () => {
    mockFetch();
    renderNew();
    expect(screen.getByRole('radio', { name: /everyone currently employed/i })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /only what changed/i })).not.toBeChecked();
  });

  it('will not save until one is chosen', async () => {
    mockFetch();
    renderNew();
    expect(screen.getByRole('button', { name: /create source/i })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /everyone currently employed/i }));
    expect(screen.getByRole('button', { name: /create source/i })).toBeEnabled();
  });

  /**
   * The label says what the file IS, because that is what the administrator
   * knows. The line beneath says what Syntra will do about it, which is what
   * they have to decide.
   */
  it('states the consequence of the mode chosen', async () => {
    mockFetch();
    renderNew();

    await userEvent.click(screen.getByRole('radio', { name: /everyone currently employed/i }));
    expect(screen.getByText(/missing from the file are treated as leavers/i)).toBeVisible();

    await userEvent.click(screen.getByRole('radio', { name: /only what changed/i }));
    expect(screen.getByText(/missing from the file are left alone/i)).toBeVisible();
  });

  it('sends the chosen mode when creating', async () => {
    const calls = mockFetch();
    renderNew();

    await userEvent.type(screen.getByLabelText('Name'), 'HR nightly');
    await userEvent.type(screen.getByLabelText('Host'), 'hr.example.test');
    await userEvent.type(screen.getByLabelText('Username'), 'syntra');
    await userEvent.type(screen.getByLabelText('Remote path'), '/export/people.csv');
    await userEvent.type(screen.getByLabelText(/password or private key/i), 'hunter2');
    await userEvent.click(screen.getByRole('radio', { name: /only what changed/i }));
    await userEvent.click(screen.getByRole('button', { name: /create source/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.init.method === 'POST');
      expect(post).toBeDefined();
      expect(bodyOf(post!).feedMode).toBe('delta');
    });
  });
});

describe('saving a source that already exists', () => {
  /**
   * `sftpDelimitedConfigSchema` is a whole object with defaults, so a save
   * that sends only the fields this form shows resets every field it does
   * not: delimiter, quote character, encoding, header row, and both ceilings.
   * A tab-separated feed would silently become comma-separated and every row
   * after that would fail to map.
   */
  it('keeps config the form never showed', async () => {
    const calls = mockFetch({
      source: savedSource({
        config: {
          host: 'hr.example.test',
          port: 22,
          username: 'syntra',
          remotePath: '/export/people.tsv',
          delimiter: '\t',
          hasHeaderRow: false,
          maxRows: 5000,
        },
      }),
    });
    renderEdit();
    await screen.findByDisplayValue('HR nightly');

    await userEvent.click(screen.getByRole('button', { name: /save source/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init.method === 'PATCH');
      expect(patch).toBeDefined();
      const sent = bodyOf(patch!) as unknown as { config: Record<string, unknown> };
      expect(sent.config.delimiter).toBe('\t');
      expect(sent.config.hasHeaderRow).toBe(false);
      expect(sent.config.maxRows).toBe(5000);
    });
  });

  it('still sends the fields the form does show', async () => {
    const calls = mockFetch();
    renderEdit();
    await screen.findByDisplayValue('HR nightly');

    await userEvent.clear(screen.getByLabelText('Host'));
    await userEvent.type(screen.getByLabelText('Host'), 'hr2.example.test');
    await userEvent.click(screen.getByRole('button', { name: /save source/i }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init.method === 'PATCH');
      const sent = bodyOf(patch!) as unknown as { config: Record<string, unknown> };
      expect(sent.config.host).toBe('hr2.example.test');
    });
  });
});

describe('the host key', () => {
  /**
   * There is no field to type a fingerprint into. Nobody has one to hand, and
   * a field that can be typed into is a field the wrong thing can be pasted
   * into: testing is how a key is obtained.
   */
  it('offers no fingerprint field', async () => {
    mockFetch();
    renderEdit();
    await screen.findByDisplayValue('HR nightly');
    expect(screen.queryByLabelText(/fingerprint/i)).toBeNull();
  });

  it('accepts the key the test showed', async () => {
    const calls = mockFetch({
      test: {
        ok: false,
        message: 'connected, but this server’s host key is not pinned yet',
        columns: ['employeeId'],
        hostKey: { fingerprint: 'SHA256:abc', status: 'unknown' },
      },
    });
    renderEdit();
    await screen.findByDisplayValue('HR nightly');

    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(await screen.findByText('SHA256:abc')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /accept this key/i }));
    await waitFor(() => {
      const accept = calls.find((c) => c.url.includes('/host-key'));
      expect(accept).toBeDefined();
      expect(bodyOf(accept!).fingerprint).toBe('SHA256:abc');
    });
  });

  /**
   * A changed key gets no accept action at all. It is a rebuilt server or an
   * interception, and only one of those is safe to click through.
   */
  it('offers no accept action when the key mismatches', async () => {
    mockFetch({
      test: {
        ok: false,
        message: 'the server presented a different host key',
        hostKey: { fingerprint: 'SHA256:zzz', status: 'mismatch' },
      },
    });
    renderEdit();
    await screen.findByDisplayValue('HR nightly');

    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(await screen.findByText(/being intercepted/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /accept this key/i })).toBeNull();
  });
});

describe('mapping', () => {
  /**
   * Mapping is choosing from columns that exist, not typing names that might.
   */
  it('offers the columns the test read, and nothing else', async () => {
    mockFetch({
      test: {
        ok: true,
        message: 'read 2 rows',
        columns: ['employeeId', 'firstName'],
        hostKey: { fingerprint: 'SHA256:abc', status: 'matched' },
      },
    });
    renderEdit();
    await screen.findByDisplayValue('HR nightly');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    const select = await screen.findByLabelText(/column for given name/i);
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '—',
      'employeeId',
      'firstName',
    ]);
  });

  /**
   * Matching contracts by position rewrites two of them into each other when
   * the file's order changes, so the warning names that consequence.
   */
  it('warns when no contract id column is mapped', async () => {
    mockFetch({
      test: {
        ok: true,
        message: 'read 2 rows',
        columns: ['employeeId'],
        hostKey: { fingerprint: 'SHA256:abc', status: 'matched' },
      },
    });
    renderEdit();
    await screen.findByDisplayValue('HR nightly');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    expect(
      await screen.findByText(/contracts are matched by position/i),
    ).toBeVisible();
  });
});
