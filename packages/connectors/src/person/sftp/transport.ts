import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Client, type ConnectConfig } from 'ssh2';
import { classifyAddress } from '../../net/outbound.js';
import type { SftpDelimitedConfig, SftpDelimitedCredential } from './config.js';

/** As OpenSSH prints it: `SHA256:` then base64 with the padding stripped. */
export function fingerprintOf(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Three-valued, never a boolean.
 *
 * `unknown` is the ordinary first-test path and the only one the console
 * offers an accept action for. `mismatch` is a failure. A boolean would make
 * accepting a changed key the same gesture as accepting a first one.
 */
export function compareHostKey(
  presented: string,
  stored: string | undefined,
): 'matched' | 'unknown' | 'mismatch' {
  if (stored === undefined || stored === '') return 'unknown';
  return presented === stored ? 'matched' : 'mismatch';
}

/**
 * Resolves a hostname, refuses an address in a blocked range, and returns the
 * literal address to connect to.
 *
 * Returning the address rather than approving the name is the whole point.
 * `ssh2` takes a `host`, so resolving, checking, and then handing it the
 * hostname leaves the DNS-rebinding window `fetchExternalDocument` documents:
 * a name that answered publicly for the check can answer `169.254.169.254`
 * for the connection microseconds later. Connecting to the address that was
 * checked closes it.
 */
export async function assertAddressAllowed(
  host: string,
  allowPrivate: boolean,
): Promise<string> {
  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0) {
    throw new Error(`"${host}" resolves to no address`);
  }
  for (const entry of resolved) {
    if (!allowPrivate && classifyAddress(entry.address) === 'blocked') {
      throw new Error(
        `"${host}" resolves to an address this deployment refuses to connect ` +
          `to (${entry.address}); set OUTBOUND_ALLOW_PRIVATE to permit it`,
      );
    }
  }
  return (resolved[0] as { address: string }).address;
}

export class HostKeyMismatchError extends Error {
  constructor(
    readonly presented: string,
    readonly stored: string,
  ) {
    super(
      `the server presented host key ${presented}, but this source is pinned ` +
        `to ${stored}; a changed key is a rebuilt server or an interception`,
    );
    this.name = 'HostKeyMismatchError';
  }
}

export class HostKeyUnknownError extends Error {
  constructor(readonly presented: string) {
    super(
      `this source has no host key pinned; test the connection and accept ` +
        `${presented} before it can run`,
    );
    this.name = 'HostKeyUnknownError';
  }
}

export class ByteCeilingExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the file is larger than ${maxBytes} bytes, which is this source's limit`);
    this.name = 'ByteCeilingExceededError';
  }
}

export class MultipleFilesMatchedError extends Error {
  constructor(
    readonly pattern: string,
    readonly matches: string[],
  ) {
    super(
      `"${pattern}" matches ${matches.length} files (${matches.join(', ')}); ` +
        `a source must name exactly one, because picking the first would ` +
        `import last week's export the week somebody left a copy behind`,
    );
    this.name = 'MultipleFilesMatchedError';
  }
}

export interface FetchResult {
  text: string;
  hostKey: { fingerprint: string; status: 'matched' | 'unknown' | 'mismatch' };
}

/** Whether a remote path is a glob rather than a literal file name. */
export function isGlob(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

/**
 * Turns one glob segment into an anchored regular expression.
 *
 * Only `*` and `?`, which is what an HR export's file name ever needs
 * (`people-*.csv`). Everything else is escaped, so a dot in the pattern means
 * a dot.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}

function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return { dir: '.', base: path };
  return { dir: path.slice(0, cut) || '/', base: path.slice(cut + 1) };
}

/**
 * Connects, verifies the host key, and reads one file in full.
 *
 * `requirePinned` is the difference between `test` and `read`. `test` connects
 * with an unknown key on purpose -- that is how a fingerprint is obtained --
 * and reports it. `read` refuses, because an unpinned key at run time means
 * the schedule would accept any server that answered.
 */
export async function fetchFile(
  config: SftpDelimitedConfig & SftpDelimitedCredential,
  opts: {
    allowPrivate: boolean;
    requirePinned: boolean;
    /**
     * Stop cleanly after this many bytes and return what arrived.
     *
     * For `test` only, which wants the first rows to report the columns from.
     * DISTINCT from the ceiling: sampling is a deliberate partial read that
     * the caller asked for and does not diff against anything, whereas the
     * ceiling is a refusal, because a partial read a caller could mistake for
     * a complete one is what departs a workforce. `read` never passes this.
     */
    sampleBytes?: number;
  },
): Promise<FetchResult> {
  const address = await assertAddressAllowed(config.host, opts.allowPrivate);
  const maxBytes = config.maxBytes;
  const sampleBytes = opts.sampleBytes;

  return new Promise<FetchResult>((resolve, reject) => {
    const client = new Client();
    let hostKey: FetchResult['hostKey'] | undefined;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      client.end();
      fn();
    };

    const fail = (error: Error) => {
      // A rejected key surfaces from ssh2 as a generic handshake error, so the
      // specific reason is restored here from what the verifier recorded.
      //
      // Captured into a local first: `hostKey` is a `let` closed over by the
      // deferred callback below, so narrowing it in this scope does not carry
      // into the callback.
      const seen = hostKey;
      if (seen?.status === 'mismatch') {
        finish(() =>
          reject(new HostKeyMismatchError(seen.fingerprint, config.hostKeyFingerprint ?? '')),
        );
        return;
      }
      if (seen?.status === 'unknown' && opts.requirePinned) {
        finish(() => reject(new HostKeyUnknownError(seen.fingerprint)));
        return;
      }
      finish(() => reject(error));
    };

    const connectConfig: ConnectConfig = {
      // The literal address that was checked, never the name.
      host: address,
      port: config.port,
      username: config.username,
      // `passphrase` is spread only when it exists. Under
      // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
      // as an absent key, and ssh2's type refuses the first.
      ...('privateKey' in config
        ? {
            privateKey: config.privateKey,
            ...(config.passphrase === undefined ? {} : { passphrase: config.passphrase }),
          }
        : { password: config.password }),
      // Never `() => true`. There is no trust-on-first-use here: an unknown
      // key is reported and, on `read`, refused.
      hostVerifier: (key: Buffer) => {
        const fingerprint = fingerprintOf(key);
        const status = compareHostKey(fingerprint, config.hostKeyFingerprint);
        hostKey = { fingerprint, status };
        if (status === 'mismatch') return false;
        if (status === 'unknown' && opts.requirePinned) return false;
        return true;
      },
    };

    client.on('error', fail);

    client.on('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) return fail(sftpError);

        const readOne = (path: string) => {
          const stream = sftp.createReadStream(path);
          const chunks: Buffer[] = [];
          let bytes = 0;

          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            chunks.push(chunk);

            // Sampling: enough is enough, and what arrived is the answer.
            if (sampleBytes !== undefined && bytes >= sampleBytes) {
              stream.destroy();
              finish(() =>
                resolve({
                  text: Buffer.concat(chunks).toString(config.encoding),
                  hostKey: hostKey ?? { fingerprint: '', status: 'unknown' },
                }),
              );
              return;
            }

            if (bytes > maxBytes) {
              // Destroy and reject. Never resolve with what arrived: a short
              // read that looked successful is the input that departs a
              // workforce.
              stream.destroy();
              finish(() => reject(new ByteCeilingExceededError(maxBytes)));
              return;
            }
          });
          stream.on('error', fail);
          stream.on('close', () => {
            if (settled) return;
            finish(() =>
              resolve({
                text: Buffer.concat(chunks).toString(config.encoding),
                hostKey: hostKey ?? { fingerprint: '', status: 'unknown' },
              }),
            );
          });
        };

        if (!isGlob(config.remotePath)) return readOne(config.remotePath);

        // A glob has to resolve to exactly one file. More than one match is an
        // error rather than a choice.
        const { dir, base } = splitPath(config.remotePath);
        const matcher = globToRegExp(base);
        sftp.readdir(dir, (listError, entries) => {
          if (listError) return fail(listError);
          const matches = entries
            .map((entry) => entry.filename)
            .filter((name) => matcher.test(name))
            .sort();
          if (matches.length === 0) {
            return finish(() =>
              reject(new Error(`"${config.remotePath}" matches no file`)),
            );
          }
          if (matches.length > 1) {
            return finish(() =>
              reject(new MultipleFilesMatchedError(config.remotePath, matches)),
            );
          }
          readOne(`${dir === '/' ? '' : dir}/${matches[0] as string}`);
        });
      });
    });

    client.connect(connectConfig);
  });
}
