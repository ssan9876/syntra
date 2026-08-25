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

/** Fast, so the bounded-wait case does not cost thirty seconds of suite. */
const FAST = { attempts: 3, intervalMs: 1 };

beforeEach(() => vi.restoreAllMocks());

describe('provisionForPerson', () => {
  it('applies only the actions carrying this person id', async () => {
    let applied: unknown = null;
    let listed = 0;
    mockRoutes({
      '/api/admin/targets/t1/runs': (init) => {
        if (init?.method === 'POST') return json({ jobId: 'j1' }, 202);
        listed += 1;
        return listed === 1
          ? json({ runs: [{ id: 'r0', status: 'previewed' }] })
          : json({ runs: [{ id: 'r1', status: 'previewed' }] });
      },
      '/api/admin/targets/t1/runs/r1': () =>
        json({
          actions: [
            { id: 'a1', personId: 'p1' },
            { id: 'a2', personId: 'p9' },
            { id: 'a3', personId: 'p1' },
          ],
        }),
      '/api/admin/targets/t1/runs/r1/apply': (init) => {
        applied = JSON.parse(String(init?.body));
        return json({ ok: true });
      },
    });

    const count = await provisionForPerson('t1', 'p1', FAST);

    // a2 belongs to somebody else and stays pending. Applying the run
    // wholesale would have committed it on the strength of p1 being hired.
    expect(applied).toEqual({ only: ['a1', 'a3'] });
    expect(count).toBe(2);
  });

  it('never applies the run that was already there before the enqueue', async () => {
    let touchedDetail = false;
    mockRoutes({
      // The newest run never changes: the enqueued one never starts.
      '/api/admin/targets/t1/runs': (init) =>
        init?.method === 'POST'
          ? json({ jobId: 'j1' }, 202)
          : json({ runs: [{ id: 'r0', status: 'previewed' }] }),
      '/api/admin/targets/t1/runs/r0': () => {
        touchedDetail = true;
        return json({ actions: [] });
      },
    });

    const count = await provisionForPerson('t1', 'p1', FAST);

    // r0 is a previewed plan full of somebody else's pending actions. Reading
    // it at all would be the bug; applying it would be the incident.
    expect(touchedDetail).toBe(false);
    expect(count).toBe(0);
  });

  it('waits past a run that is still planning', async () => {
    let listed = 0;
    mockRoutes({
      '/api/admin/targets/t1/runs': (init) => {
        if (init?.method === 'POST') return json({ jobId: 'j1' }, 202);
        listed += 1;
        if (listed === 1) return json({ runs: [] });
        return listed === 2
          ? json({ runs: [{ id: 'r1', status: 'running' }] })
          : json({ runs: [{ id: 'r1', status: 'previewed' }] });
      },
      '/api/admin/targets/t1/runs/r1': () =>
        json({ actions: [{ id: 'a1', personId: 'p1' }] }),
      '/api/admin/targets/t1/runs/r1/apply': () => json({ ok: true }),
    });

    expect(await provisionForPerson('t1', 'p1', FAST)).toBe(1);
  });

  it('applies nothing when no rule matched their contract', async () => {
    let listed = 0;
    mockRoutes({
      '/api/admin/targets/t1/runs': (init) => {
        if (init?.method === 'POST') return json({ jobId: 'j1' }, 202);
        listed += 1;
        return listed === 1
          ? json({ runs: [] })
          : json({ runs: [{ id: 'r1', status: 'previewed' }] });
      },
      '/api/admin/targets/t1/runs/r1': () =>
        json({ actions: [{ id: 'a2', personId: 'p9' }] }),
      // No apply handler: calling it rejects and fails this test.
    });

    expect(await provisionForPerson('t1', 'p1', FAST)).toBe(0);
  });
});
