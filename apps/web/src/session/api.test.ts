import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, onSessionExpired } from './api.js';

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const headersOf = (call: unknown[]) =>
  ((call[1] as RequestInit).headers ?? {}) as Record<string, string>;

beforeEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('declares a JSON content type only when there is a body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await api('/api/auth/logout', { method: 'POST' });

    // A POST with no body must not claim to carry JSON: the server rejects
    // that outright, which once made sign-out fail while looking like it
    // had worked.
    expect(headersOf(fetchMock.mock.calls[0]!)).not.toHaveProperty(
      'content-type',
    );
  });

  it('declares a JSON content type when a body is present', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login: 'a', password: 'b' }),
    });

    expect(headersOf(fetchMock.mock.calls[0]!)['content-type']).toBe(
      'application/json',
    );
  });

  it('always sends credentials so the session cookie travels', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await api('/api/auth/session');

    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe(
      'include',
    );
  });

  it('throws an ApiError carrying the problem type', async () => {
    // A Response body can only be read once, so each call needs a fresh one.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            type: 'https://syntra.dev/problems/forbidden',
            title: 'Forbidden',
            status: 403,
          }),
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );

    const error = await api('/api/admin/users').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('forbidden');
    expect((error as ApiError).problem.status).toBe(403);
  });

  it('still throws when the error body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>gateway timeout</html>', { status: 504 }) as never,
    );

    await expect(api('/api/admin/users')).rejects.toMatchObject({
      problem: { status: 504 },
    });
  });

  it('returns undefined for a 204 rather than failing to parse', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }) as never,
    );

    await expect(api('/api/admin/groups/x/members/y')).resolves.toBeUndefined();
  });
});

describe('a 401 that means the session died', () => {
  const unauthorized = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
    );

  /**
   * Nothing handled a 401 mid-session. `GENERIC` mapped 403 and 404 and
   * nothing cleared the session or navigated anywhere, so an expired admin
   * session -- the deliberately short one, fifteen minutes idle -- turned
   * every panel into "Something went wrong" with no route back but typing a
   * URL.
   */
  it('notifies when an admin route answers 401', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    unauthorized();

    await expect(api('/api/admin/users')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    off();
  });

  /**
   * AND NOT for the credential-presenting endpoints. `/api/auth/elevate`
   * answers 401 for a wrong password while the caller holds a perfectly good
   * portal session; treating that as expiry would sign somebody out for
   * mistyping.
   */
  it('does not notify for an auth endpoint refusing a credential', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    unauthorized();

    await expect(
      api('/api/auth/elevate', { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      api('/api/auth/login', { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(api('/api/auth/session')).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    off();
  });

  it('does not notify for a 403, which is about permissions and not the session', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    await expect(api('/api/admin/users')).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    off();
  });
});
