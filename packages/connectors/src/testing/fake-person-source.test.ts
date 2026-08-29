import { describe, expect, it } from 'vitest';
import { FakePersonSource } from './fake-person-source.js';

const config = { sourceId: 'src-1' };

function record(externalId: string) {
  return { externalId, fields: { givenName: 'Ada' }, contracts: [] };
}

describe('FakePersonSource', () => {
  it('yields the records it was given, in order', async () => {
    const fake = new FakePersonSource([record('1'), record('2')]);
    const seen: string[] = [];
    for await (const r of fake.read(config)) seen.push(r.externalId);
    expect(seen).toEqual(['1', '2']);
  });

  it('counts reads, so a test can assert a run read once', async () => {
    const fake = new FakePersonSource([record('1')]);
    for await (const _ of fake.read(config)) void _;
    for await (const _ of fake.read(config)) void _;
    expect(fake.reads).toBe(2);
  });

  /**
   * The incomplete read has to be expressible, because it is the case the
   * whole absence rule turns on: a throw mid-stream must fail the run, never
   * produce a short snapshot the diff treats as complete.
   */
  it('throws mid-stream when told to, after yielding what came before', async () => {
    const fake = new FakePersonSource([record('1')], {
      failWith: new Error('connection reset'),
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const r of fake.read(config)) seen.push(r.externalId);
    }).rejects.toThrow('connection reset');
    expect(seen).toEqual(['1']);
  });

  it('reports ok from test, with the columns it was given', async () => {
    const fake = new FakePersonSource([], { columns: ['id', 'name'] });
    const result = await fake.test(config);
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(['id', 'name']);
  });
});
