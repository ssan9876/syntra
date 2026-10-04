import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Setup, slugFrom, validate } from './Setup.js';
import { goToSignIn } from './setup-redirect.js';

vi.mock('./setup-redirect.js', () => ({ goToSignIn: vi.fn() }));

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789';

const renderAt = (url = `/setup?token=${TOKEN}`) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
      </Routes>
    </MemoryRouter>,
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const STATUS = { primaryDomain: 'idm.contoso.com', passwordMinLength: 12, expiresAt: '2026-10-03T13:00:00.000Z' };

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Organization name'), 'Contoso Ltd');
  await user.type(screen.getByLabelText('Admin email'), 'anna@contoso.com');
  await user.type(screen.getByLabelText('Display name'), 'Anna Novak');
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  await user.type(screen.getByLabelText('Confirm password'), 'correct-horse-battery');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(goToSignIn).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('Setup', () => {
  it('checks the link with its token and prefills the primary domain', async () => {
    const fetch = vi.fn(async () => json(STATUS));
    vi.stubGlobal('fetch', fetch);
    renderAt();

    expect(await screen.findByLabelText('Primary domain')).toHaveValue('idm.contoso.com');
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe(`/api/setup?token=${TOKEN}`);
  });

  it('suggests a slug from the organization name until one is typed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(STATUS)));
    const user = userEvent.setup();
    renderAt();

    await user.type(await screen.findByLabelText('Organization name'), 'Café Nord');
    expect(screen.getByLabelText('Slug')).toHaveValue('cafe-nord');

    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'nord');
    await user.type(screen.getByLabelText('Organization name'), ' AB');
    expect(screen.getByLabelText('Slug')).toHaveValue('nord');
  });

  it('names what is wrong with each field and sends nothing', async () => {
    const fetch = vi.fn(async () => json(STATUS));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderAt();

    await user.type(await screen.findByLabelText('Admin email'), 'not-an-address');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'shorter');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(screen.getAllByText('Required')).toHaveLength(3); // name, slug, display name
    expect(screen.getByText('Not an email address')).toBeInTheDocument();
    expect(screen.getByText('At least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates the organization and sends the administrator to sign in', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? json({ login: 'anna@contoso.com', signInUrl: 'https://idm.contoso.com/login' }, 201)
        : json(STATUS),
    );
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderAt();

    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('Organization created')).toBeInTheDocument();
    expect(goToSignIn).toHaveBeenCalledWith('https://idm.contoso.com/login');
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/setup');
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      token: TOKEN,
      organizationName: 'Contoso Ltd',
      slug: 'contoso-ltd',
      primaryDomain: 'idm.contoso.com',
      adminEmail: 'anna@contoso.com',
      adminDisplayName: 'Anna Novak',
      password: 'correct-horse-battery',
    });
  });

  it('shows a field the server refused under that field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? json(
              {
                type: 'https://syntra.dev/problems/weak-password',
                title: 'That password does not meet the policy',
                status: 400,
                detail: 'Choose something less predictable than your own name or login.',
                errors: [{ path: 'password', message: 'Choose something less predictable than your own name or login.' }],
              },
              400,
            )
          : json(STATUS),
      ),
    );
    const user = userEvent.setup();
    renderAt();

    await fillValid(user);
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('Choose something less predictable than your own name or login.')).toBeInTheDocument();
    expect(goToSignIn).not.toHaveBeenCalled();
  });

  it('says why a link does not work', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            type: 'https://syntra.dev/problems/setup-link-expired',
            title: 'Setup link expired',
            status: 410,
            detail: 'Restart the API to print a new link.',
          },
          410,
        ),
      ),
    );
    renderAt();

    expect(await screen.findByText('Setup link expired')).toBeInTheDocument();
    expect(screen.getByText('Restart the API to print a new link.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Organization name')).not.toBeInTheDocument();
  });

  it('says nothing more than "not available" on an install that is set up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ type: 'https://syntra.dev/problems/not-found', title: 'Not Found', status: 404 }, 404)));
    renderAt('/setup');

    expect(await screen.findByText('Setup is not available.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});

describe('slugFrom and validate', () => {
  it('makes a DNS label of a name', () => {
    expect(slugFrom('  Contoso -- Ltd. ')).toBe('contoso-ltd');
    expect(slugFrom('x'.repeat(80))).toHaveLength(63);
  });

  it('accepts a complete form', () => {
    expect(
      validate(
        {
          organizationName: 'Contoso',
          slug: 'contoso',
          primaryDomain: 'IDM.contoso.com',
          adminEmail: 'anna@contoso.com',
          adminDisplayName: 'Anna',
          password: 'correct-horse-battery',
          confirmPassword: 'correct-horse-battery',
        },
        12,
      ),
    ).toEqual({});
  });

  it('refuses a domain with a scheme or port', () => {
    const base = {
      organizationName: 'Contoso',
      slug: 'contoso',
      adminEmail: 'anna@contoso.com',
      adminDisplayName: 'Anna',
      password: 'correct-horse-battery',
      confirmPassword: 'correct-horse-battery',
    };
    expect(validate({ ...base, primaryDomain: 'https://idm.contoso.com' }, 12).primaryDomain).toBeDefined();
    expect(validate({ ...base, primaryDomain: 'idm.contoso.com:8443' }, 12).primaryDomain).toBeDefined();
  });
});
