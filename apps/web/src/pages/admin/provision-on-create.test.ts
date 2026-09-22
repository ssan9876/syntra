import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionForPerson } from './provision-on-create.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as never;

function mockRoutes(
  handlers: Record<string, (init: RequestInit | undefined) => Response>,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const handler = handlers[url];
    if (!handler) return Promise.reject(new Error(`unmocked fetch: ${url}`));
    return Promise.resolve(handler(init));
  }) as never);
}

beforeEach(() => vi.restoreAllMocks());

describe('provisionForPerson', () => {
  it('asks the server for a durable receipt scoped to this person and target', async () => {
    let body: unknown;
    const receipt = { id: 'receipt-1', targetSystemId: 't1', targetName: 'AD', status: 'pending' };
    mockRoutes({
      '/api/admin/persons/p1/provision-receipts': (init) => {
        body = JSON.parse(String(init?.body));
        expect(init?.method).toBe('POST');
        return json({ receipts: [receipt] }, 202);
      },
    });

    expect(await provisionForPerson('t1', 'p1')).toEqual([receipt]);
    expect(body).toMatchObject({ targetIds: ['t1'] });
    expect((body as { requestKey: string }).requestKey).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('does not poll or infer a result from the newest target run', async () => {
    const urls: string[] = [];
    mockRoutes({
      '/api/admin/persons/p1/provision-receipts': () => {
        urls.push('/api/admin/persons/p1/provision-receipts');
        return json({ receipts: [{ id: 'saved', status: 'planning' }] }, 202);
      },
    });
    await provisionForPerson('t1', 'p1');
    expect(urls).toEqual(['/api/admin/persons/p1/provision-receipts']);
  });

  it('propagates refusal so onboarding can link to the records already saved', async () => {
    mockRoutes({
      '/api/admin/persons/p1/provision-receipts': () => json({ title: 'Background jobs are not running', status: 503 }, 503),
    });
    await expect(provisionForPerson('t1', 'p1')).rejects.toThrow();
  });
});
