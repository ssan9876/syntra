import { readDelimited } from '../delimited.js';
import type {
  PersonSnapshotRecord,
  SourceConnectionResult,
  SourceConnector,
} from '../types.js';
import type { SftpDelimitedConfig, SftpDelimitedCredential } from './config.js';
import { HostKeyMismatchError, HostKeyUnknownError, fetchFile } from './transport.js';

type Config = SftpDelimitedConfig & SftpDelimitedCredential;

const allowPrivate = (): boolean => process.env.OUTBOUND_ALLOW_PRIVATE === 'true';

/**
 * How many bytes `test` reads.
 *
 * Enough to report the columns and prove the file parses; never the whole
 * file, which on a real export is minutes of transfer for a question the
 * operator asked about the connection.
 */
const SAMPLE_BYTES = 64 * 1024;

/**
 * One row, keyed by column name, with every cell available to a mapping.
 *
 * The connector does not decide which column is the anchor and does not build
 * one person from several rows: one row is one person with one contract, and a
 * source whose file holds several rows per person is a second connector rather
 * than a flag on this one. `externalId` here is a placeholder the run reports
 * mapping failures against -- `mapPersonRecord` in core replaces it with the
 * mapped correlation value.
 */
function toRecord(row: Record<string, string>, index: number): PersonSnapshotRecord {
  return {
    externalId: `row-${index + 1}`,
    fields: row,
    // The contract is built by the mapping layer, from the same row. Nothing
    // here can know which columns are contract columns.
    contracts: [],
  };
}

function parse(config: Config, text: string) {
  return readDelimited(text, {
    delimiter: config.delimiter,
    quoteChar: config.quoteChar,
    hasHeaderRow: config.hasHeaderRow,
    maxRows: config.maxRows,
  });
}

export const sftpDelimitedConnector: SourceConnector<Config> = {
  async test(config): Promise<SourceConnectionResult> {
    try {
      const { text, hostKey } = await fetchFile(config, {
        allowPrivate: allowPrivate(),
        requirePinned: false,
        maxBytes: SAMPLE_BYTES,
      });
      const table = parse(config, text);
      return {
        ok: hostKey.status === 'matched',
        message:
          hostKey.status === 'unknown'
            ? 'connected, but this server’s host key is not pinned yet'
            : `read ${table.rows.length} rows and ${table.columns.length} columns`,
        columns: table.columns,
        recordsSampled: table.rows.length,
        hostKey,
      };
    } catch (cause) {
      // An unknown key is not a failure of `test` -- it is what `test` is for.
      // The console's accept action acts on exactly this result.
      if (cause instanceof HostKeyUnknownError) {
        return {
          ok: false,
          message: cause.message,
          hostKey: { fingerprint: cause.presented, status: 'unknown' },
        };
      }
      if (cause instanceof HostKeyMismatchError) {
        return {
          ok: false,
          message: cause.message,
          hostKey: { fingerprint: cause.presented, status: 'mismatch' },
        };
      }
      // A byte ceiling hit while sampling is not a failure either: `test` reads
      // only the first SAMPLE_BYTES on purpose, and a file larger than that is
      // the ordinary case.
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  },

  /**
   * Every record or a throw.
   *
   * `requirePinned: true`, so an unpinned key refuses here even though `test`
   * reports it: a schedule that accepted any server that answered is not a
   * pinned connection.
   */
  async *read(config): AsyncIterable<PersonSnapshotRecord> {
    const { text } = await fetchFile(config, {
      allowPrivate: allowPrivate(),
      requirePinned: true,
    });
    const table = parse(config, text);
    for (const [index, row] of table.rows.entries()) {
      yield toRecord(row, index);
    }
  },
};
