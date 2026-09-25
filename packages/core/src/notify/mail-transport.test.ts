import { describe, expect, it, vi } from 'vitest';
import { graphTransport, mailTransport } from './mail-transport.js';
import { loadConfig } from '../config.js';

const SECRET = 'client-secret-value-that-must-never-leak';
const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const message = {
  to: 'anna@home.test',
  subject: 'Hello',
  text: 'plain',
  html: '<p>html</p>',
};

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a queue, recording every request it was given. */
function fakeFetch(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request: ${String(url)}`);
    return next();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const tokenResponse = (token = 'access-token-1', expiresIn = 3600) => () =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const accepted = () => () => new Response(null, { status: 202 });

const transport = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  graphTransport({
    tenantId: TENANT,
    clientId: CLIENT,
    clientSecret: SECRET,
    sender: 'syntra@acme.test',
    fetch,
    sleep: async () => undefined,
    ...extra,
  });

describe('graphTransport', () => {
  it('gets a client-credentials token, then sends HTML through sendMail as the sender', async () => {
    const { fetch, calls } = fakeFetch([tokenResponse(), accepted()]);
    await transport(fetch).send(message);

    expect(calls).toHaveLength(2);
    const [token, send] = calls;
    expect(token!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const form = new URLSearchParams(String(token!.init.body));
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(form.get('client_id')).toBe(CLIENT);
    expect(form.get('client_secret')).toBe(SECRET);

    expect(send!.url).toBe('https://graph.microsoft.com/v1.0/users/syntra%40acme.test/sendMail');
    expect((send!.init.headers as Record<string, string>).authorization).toBe('Bearer access-token-1');
    expect(JSON.parse(String(send!.init.body))).toEqual({
      message: {
        subject: 'Hello',
        body: { contentType: 'HTML', content: '<p>html</p>' },
        toRecipients: [{ emailAddress: { address: 'anna@home.test' } }],
      },
      saveToSentItems: false,
    });
    // Every request carries a timeout.
    expect(token!.init.signal).toBeInstanceOf(AbortSignal);
    expect(send!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sets the From named by MAIL_FROM', async () => {
    const { fetch, calls } = fakeFetch([tokenResponse(), accepted()]);
    await transport(fetch, { from: 'IT Service Desk <it@acme.test>' }).send(message);
    expect(JSON.parse(String(calls[1]!.init.body)).message.from).toEqual({
      emailAddress: { address: 'it@acme.test', name: 'IT Service Desk' },
    });
  });

  it('reuses the token until shortly before it expires', async () => {
    let clock = 0;
    const { fetch, calls } = fakeFetch([
      tokenResponse('first', 3600),
      accepted(),
      accepted(),
      tokenResponse('second', 3600),
      accepted(),
    ]);
    const graph = transport(fetch, { now: () => clock });

    await graph.send(message);
    clock = 30 * 60 * 1000;
    await graph.send(message);
    // Inside the five-minute margin before the hour is up.
    clock = 56 * 60 * 1000;
    await graph.send(message);

    const tokenRequests = calls.filter((c) => new URL(c.url).host === 'login.microsoftonline.com');
    expect(tokenRequests).toHaveLength(2);
    expect((calls[4]!.init.headers as Record<string, string>).authorization).toBe('Bearer second');
  });

  it('waits out one 429 as Retry-After says, then retries once', async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetch, calls } = fakeFetch([
      tokenResponse(),
      () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
      accepted(),
    ]);
    await transport(fetch, { sleep }).send(message);
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(calls.filter((c) => c.url.endsWith('/sendMail'))).toHaveLength(2);
  });

  it('gives up after the second 429 rather than retrying forever', async () => {
    const throttled = () =>
      new Response(JSON.stringify({ error: { code: 'ApplicationThrottled', message: 'slow down' } }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    const { fetch } = fakeFetch([tokenResponse(), throttled, throttled]);
    await expect(transport(fetch).send(message)).rejects.toThrow(/HTTP 429, ApplicationThrottled/);
  });

  it('explains a 403 as the RBAC scope, and never leaks the secret or the token', async () => {
    const { fetch } = fakeFetch([
      tokenResponse('the-access-token'),
      () =>
        new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }), {
          status: 403,
        }),
    ]);
    const failure = (await transport(fetch).send(message).catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/ErrorAccessDenied/);
    expect(failure.message).toMatch(/management scope/);
    expect(failure.message).not.toContain(SECRET);
    expect(failure.message).not.toContain('the-access-token');
  });

  it('reports a refused token request by its code, without the secret', async () => {
    const { fetch } = fakeFetch([
      () =>
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: `AADSTS7000215: Invalid client secret provided. ${SECRET}`,
            error_codes: [7000215],
          }),
          { status: 401 },
        ),
    ]);
    const failure = (await transport(fetch).send(message).catch((e: unknown) => e)) as Error;
    expect(failure.message).toMatch(/invalid_client \(AADSTS7000215\)/);
    expect(failure.message).not.toContain(SECRET);
  });

  it('verifies by acquiring a token, and sends nothing', async () => {
    const { fetch, calls } = fakeFetch([tokenResponse()]);
    await transport(fetch).verify!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/oauth2/v2.0/token');
  });
});

describe('mailTransport', () => {
  const base = {
    DATABASE_URL: 'postgresql://syntra:syntra@localhost:5432/syntra',
    PUBLIC_URL: 'http://localhost:3000',
    SESSION_SECRET: 'x'.repeat(32),
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  };

  it('builds the Graph transport when the configuration says graph', async () => {
    const config = loadConfig({
      ...base,
      MAIL_TRANSPORT: 'graph',
      MAIL_GRAPH_TENANT_ID: TENANT,
      MAIL_GRAPH_CLIENT_ID: CLIENT,
      MAIL_GRAPH_CLIENT_SECRET: SECRET,
      MAIL_GRAPH_SENDER: 'syntra@acme.test',
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse()());
    try {
      await mailTransport(config).verify!();
      expect(new URL(String(fetch.mock.calls[0]![0])).host).toBe('login.microsoftonline.com');
    } finally {
      fetch.mockRestore();
    }
  });

  it('builds an SMTP transport by default', () => {
    const graphFetch = vi.spyOn(globalThis, 'fetch');
    try {
      const smtp = mailTransport(loadConfig({ ...base, SMTP_URL: 'smtp://localhost:1025' }));
      expect(typeof smtp.send).toBe('function');
      expect(graphFetch).not.toHaveBeenCalled();
    } finally {
      graphFetch.mockRestore();
    }
  });
});
