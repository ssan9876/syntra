import type {
  PersonSnapshotRecord,
  SourceConnectionResult,
  SourceConnector,
} from '../person/types.js';

export interface FakePersonSourceConfig {
  sourceId: string;
}

/**
 * A person source that reads from an array.
 *
 * Reachable only through `@syntra/connectors/testing`, for the reason that
 * entry point's header gives: a fake reachable from production code is a fake
 * that will eventually be reached.
 *
 * `failWith` exists to express the one case the absence rule turns on -- a
 * read that gives out partway. The records before the failure are yielded and
 * then the error propagates, which is exactly what a dropped SFTP connection
 * does, and what the run must treat as a failure rather than as a snapshot in
 * which everyone unread is absent.
 */
export class FakePersonSource implements SourceConnector<FakePersonSourceConfig> {
  reads = 0;

  constructor(
    private readonly records: PersonSnapshotRecord[],
    private readonly opts: { failWith?: Error; columns?: string[] } = {},
  ) {}

  async test(_config?: FakePersonSourceConfig): Promise<SourceConnectionResult> {
    return {
      ok: true,
      message: `read ${this.records.length} records`,
      columns: this.opts.columns ?? [],
      recordsSampled: this.records.length,
    };
  }

  async *read(_config?: FakePersonSourceConfig): AsyncIterable<PersonSnapshotRecord> {
    this.reads += 1;
    for (const record of this.records) yield record;
    if (this.opts.failWith) throw this.opts.failWith;
  }
}
