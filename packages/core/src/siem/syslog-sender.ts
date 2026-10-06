import { lookup } from 'node:dns/promises';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { classifyAddress } from '../net/outbound.js';

/**
 * Sends syslog messages over TCP, with TLS (RFC 5425) unless told otherwise.
 *
 * The host is resolved once and its address checked the way an outbound
 * webhook's is: a private address is refused unless OUTBOUND_ALLOW_PRIVATE
 * is set, and the connection goes to the address that was checked -- not to
 * a fresh lookup that could answer differently. TLS still verifies the
 * certificate against the host NAME. A private CA is trusted through
 * NODE_EXTRA_CA_CERTS, as for every other outbound connection.
 *
 * TCP syslog has no acknowledgement: "sent" means every byte was written and
 * the connection closed without an error. That is as far as the protocol goes.
 */
export interface SyslogTarget {
  host: string;
  port: number;
  tls: boolean;
}

export type SyslogSender = (target: SyslogTarget, frames: string[]) => Promise<void>;

export function syslogSender(options: { allowPrivateAddresses: boolean; timeoutMs?: number }): SyslogSender {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (target, frames) => {
    const address = await resolve(target.host, options.allowPrivateAddresses);
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolvePromise();
        }
      };
      const onConnect = () => {
        socket.end(frames.join(''), 'utf8');
      };
      const socket: Socket = target.tls
        ? tlsConnect(
            {
              host: address,
              port: target.port,
              // Node checks the certificate against `servername` when it is
              // set: the name configured, not the address it resolved to.
              ...(isIP(target.host) ? {} : { servername: target.host }),
            },
            onConnect,
          )
        : tcpConnect({ host: address, port: target.port }, onConnect);
      const timer = setTimeout(() => done(new Error(`no answer from ${target.host}:${target.port} in ${timeoutMs / 1000}s`)), timeoutMs);
      socket.once('error', (err) => done(err));
      socket.once('close', (hadError) => {
        if (!hadError) done();
      });
    });
  };
}

async function resolve(host: string, allowPrivate: boolean): Promise<string> {
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new Error(`${host} resolves to no address`);
  if (!allowPrivate) {
    const blocked = addresses.find((address) => classifyAddress(address) === 'blocked');
    if (blocked) {
      throw new Error(`${host} resolves to a private network address. Set OUTBOUND_ALLOW_PRIVATE=true to allow it.`);
    }
  }
  return addresses[0]!;
}
