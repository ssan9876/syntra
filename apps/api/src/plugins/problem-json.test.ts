import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support.js';
import { loginRequest } from '@syntra/contracts';
import { ProblemError } from './problem-json.js';

describe('problem+json', () => {
  it('renders a thrown ProblemError as RFC 9457', async () => {
    const { app, host } = await buildTestApp();
    app.get('/boom', async () => {
      throw new ProblemError(409, 'conflict', 'Conflict', 'login already exists');
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom', headers: { host } });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: 'https://syntra.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'login already exists',
    });
  });

  it('renders an unexpected error as a 500 without leaking its message', async () => {
    const { app, host } = await buildTestApp();
    app.get('/kaboom', async () => {
      throw new Error('connection string is postgres://user:hunter2@db');
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/kaboom',
      headers: { host },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().type).toBe('https://syntra.dev/problems/internal-error');
  });

  it('renders an unknown route as a 404 problem document', async () => {
    const { app, host } = await buildTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/nowhere',
      headers: { host },
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().type).toBe('https://syntra.dev/problems/not-found');
  });

  it('renders a validation failure as a 400 problem document', async () => {
    const { app, host } = await buildTestApp();
    // Defined here rather than reusing a real route, so the error handler is
    // tested on its own rather than through whatever a route happens to do.
    app.post('/validate', async (request) => {
      loginRequest.parse(request.body);
      return { ok: true };
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      headers: { host },
      payload: { login: 'x' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().type).toBe(
      'https://syntra.dev/problems/validation-failed',
    );
    expect(res.json().errors).toContainEqual(
      expect.objectContaining({ path: 'password' }),
    );
  });
});

describe('health', () => {
  it('answers without a tenant, since it runs before tenant resolution', async () => {
    const { app } = await buildTestApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'unknown.syntra.test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
