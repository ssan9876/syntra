import { scrubText } from '@syntra/connectors';
import type { Config, MailConfig } from '../config.js';
import { renderMessage, type Transport } from './notification-service.js';

/**
 * Where mail goes, as an operator would name it: `smtp://mail.contoso.com:587`
 * or `Microsoft Graph as syntra@contoso.com`.
 *
 * Scheme, host and port only. SMTP_URL carries its credential in the userinfo
 * and options in the query, and this string is shown in the console, written
 * into audit rows and logged.
 */
export function describeMailServer(mail: MailConfig): string {
  if (mail.transport === 'graph') return `Microsoft Graph as ${mail.sender}`;
  const url = parseUrl(mail.smtpUrl);
  if (url === null) return 'SMTP_URL';
  return `${url.protocol}//${url.host}`;
}

/** Ports the common local mail catchers listen on: MailDev, MailHog, Mailpit. */
const SINK_PORTS = new Set(['1025']);
/** The service names those catchers run under in a compose file. */
const SINK_HOSTS = new Set(['maildev', 'mailhog', 'mailpit', 'smtp4dev']);

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * The warning for an installation whose mail evidently reaches nobody: SMTP to
 * a local mail catcher (loopback, port 1025, or a catcher's compose service
 * name) while PUBLIC_URL is a real address. Null when that is not the case,
 * including every Graph deployment and every install whose own PUBLIC_URL is
 * loopback, where a catcher is the expected setup.
 *
 * MailDev accepts every message and delivers none, so the mail server check on
 * the status page passes. This is what says otherwise.
 */
export function mailSinkWarning(config: Pick<Config, 'mail' | 'publicUrl'>): MailSinkWarning | null {
  if (config.mail.transport !== 'smtp') return null;
  const smtp = parseUrl(config.mail.smtpUrl);
  const site = parseUrl(config.publicUrl);
  if (smtp === null || site === null) return null;
  if (isLoopback(site.hostname)) return null;
  const sink =
    isLoopback(smtp.hostname) || SINK_PORTS.has(smtp.port) || SINK_HOSTS.has(smtp.hostname.toLowerCase());
  if (!sink) return null;
  const server = describeMailServer(config.mail);
  return {
    server,
    message: `Mail goes to ${server}, a local test server. Set SMTP_URL to a real mail server.`,
  };
}

export interface MailSinkWarning {
  /** `smtp://localhost:1025`: scheme, host and port, never the credential. */
  server: string;
  /** One sentence for the console and the log. */
  message: string;
}

/** How long a test send may take before it is reported as failed. */
export const TEST_EMAIL_TIMEOUT_MS = 30_000;

export type TestEmailResult = { ok: true } | { ok: false; error: string };

/**
 * Sends the test message through the transport the deployment uses, and says
 * what happened. Never rejects.
 *
 * Bounded: nodemailer's own connection timeout is two minutes, and the person
 * who pressed the button is waiting on this answer. The error is the
 * transport's first line, scrubbed of credentials.
 */
export async function sendTestEmail(
  transport: Transport,
  input: { tenantName: string; to: string; displayName: string; server: string; now?: Date },
  timeoutMs = TEST_EMAIL_TIMEOUT_MS,
): Promise<TestEmailResult> {
  const message = renderMessage(input.tenantName, 'mail-test', input.to, {
    displayName: input.displayName,
    server: input.server,
    sentAt: (input.now ?? new Date()).toISOString(),
  });
  let timer: NodeJS.Timeout | undefined;
  const sending = transport.send(message);
  // A send that fails after the deadline has already been reported; its late
  // rejection must not surface as an unhandled one.
  sending.catch(() => undefined);
  try {
    await Promise.race([
      sending,
      new Promise<never>((_, reject) => {
        const limit = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
        timer = setTimeout(() => reject(new Error(`no answer within ${limit}`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { ok: true };
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    const firstLine = text.split('\n')[0]!.trim() || 'unknown error';
    return { ok: false, error: scrubText(firstLine, 500) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
