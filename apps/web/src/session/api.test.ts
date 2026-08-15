import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api.js';

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
