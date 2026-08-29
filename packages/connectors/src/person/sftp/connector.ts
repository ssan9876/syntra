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
 * The credential, removed from anything a third party wrote.
 *
 * `ssh2`'s diagnostics are passed to an operator and stored on the run row,
 * and this connector holds a password or a private key while it calls it.
 * `SourceWriteback` states the principle for the LDAP side -- a directory's
 * own text for a rejected password can quote detail, so it is classified
 * before it goes anywhere -- and the same reasoning applies to a library whose
 * error text this code does not control.
 *
 * A private key is also matched by its PEM body rather than only in full, so a
 * message quoting one line of it is caught too.
 */
export function redactCredential(message: string, config: Config): string {
  const secrets: string[] = [];
  if ('password' in config && config.password) secrets.push(config.password);
  if ('privateKey' in config && config.privateKey) {
    secrets.push(config.privateKey);
    for (const line of config.privateKey.split(/\r?\n/)) {
      // Skip the banners and anything too short to be key material: matching
      // on a short line would redact ordinary words out of the message.
      if (line.length >= 16 && !line.startsWith('---')) secrets.push(line);
    }
  }
  if ('passphrase' in config && config.passphrase) secrets.push(config.passphrase);

  return secrets.reduce(
    (text, secret) => text.split(secret).join('[redacted]'),
    message,
  );
}

/**
 * How many bytes `test` reads.
 *
 * Enough to report the columns and prove the file parses; never the whole
 * file, which on a real export is minutes of transfer for a question the
 * operator asked about the connection.
 */
const SAMPLE_BYTES = 64 * 1024;

/** Everything up to the last complete line. See `test`. */
function dropPartialLastLine(text: string): string {
  const cut = text.lastIndexOf('\n');
  return cut < 0 ? text : text.slice(0, cut + 1);
}

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
        // Sample, not a ceiling. Passing this as `maxBytes` made `test`
        // REFUSE every export bigger than the sample -- which is every real
        // one -- and report it as a failed connection.
        sampleBytes: SAMPLE_BYTES,
      });
      // A sample almost always stops mid-row, so the last line is a fragment.
      // Dropping it keeps `test` from reporting a truncated final record as a
      // real one -- and the columns, which is what `test` is for, come from
      // the header either way.
      const table = parse(config, dropPartialLastLine(text));
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
        message: redactCredential(
          cause instanceof Error ? cause.message : String(cause),
          config,
        ),
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
    // The run stores this message on the row and shows it in the console, so
    // it gets the same scrubbing `test` gives its own.
    const fetched = await fetchFile(config, {
      allowPrivate: allowPrivate(),
      requirePinned: true,
    }).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.message = redactCredential(error.message, config);
      throw error;
    });
    const { text } = fetched;
    const table = parse(config, text);
    for (const [index, row] of table.rows.entries()) {
      yield toRecord(row, index);
    }
  },
};
