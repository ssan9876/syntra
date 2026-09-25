import { setTimeout as delay } from 'node:timers/promises';
import { parseMailbox, type Config, type MailConfig } from '../config.js';
import { smtpTransport, type OutboundMessage, type Transport } from './notification-service.js';

/**
 * The one mail transport a deployment runs, built from its configuration.
 *
 * Every place that used to call `smtpTransport(config.smtpUrl)` calls this
 * instead -- the API's routes and the scheduler's jobs -- so a deployment that
 * set MAIL_TRANSPORT=graph cannot have one path quietly still trying an SMTP
 * relay that does not exist. Tests hand in `memoryTransport()` at the same
 * seams and never reach here.
 */
export function mailTransport(config: Pick<Config, 'mail'>): Transport {
  return transportFor(config.mail);
}

function transportFor(mail: MailConfig): Transport {
  if (mail.transport === 'smtp') return smtpTransport(mail.smtpUrl, mail.from);
  return graphTransport({
    tenantId: mail.tenantId,
    clientId: mail.clientId,
    clientSecret: mail.clientSecret,
    sender: mail.sender,
    from: mail.from,
  });
}

export interface GraphTransportOptions {
  tenantId: string;
  clientId: string;
  /** Sent to the token endpoint and nowhere else. Never logged. */
  clientSecret: string;
  /** The mailbox `sendMail` is called on: a UPN or primary SMTP address. */
  sender: string;
  /**
   * MAIL_FROM, when it names something other than the sender. Graph refuses a
   * From the sending mailbox has no Send As right on, which is the answer an
   * operator needs to see rather than one to work around here.
   */
  from?: string | null;
  /** Injected by tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per request. A mail server that never answers must not hold a send forever. */
  timeoutMs?: number;
  /** Injected by tests, so a Retry-After does not cost the suite real seconds. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'https://graph.microsoft.com/.default';
/**
 * How long before its stated expiry a token is treated as expired. A token
 * that is valid when read and expired when Graph checks it is a failed send
 * for no reason, and the clocks involved are not ours.
 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/**
 * The longest a Retry-After is honoured for. The send is queued off the
 * request path (`queueMessage`), so waiting costs no caller anything -- but a
 * throttled mailbox that asks for ten minutes is better reported as a failure,
 * which lands in the audit trail, than held open in memory.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Mail through Microsoft 365, by Microsoft Graph's `sendMail`, authenticated as
 * an application with the client-credentials grant.
 *
 * Why Graph rather than SMTP AUTH to smtp.office365.com: Microsoft is retiring
 * basic authentication for SMTP client submission, and SMTP with OAuth needs a
 * token this process would have to acquire anyway. Graph's `sendMail` is the
 * supported unattended path, and it is scoped to ONE mailbox by Exchange Online
 * RBAC for Applications rather than by a tenant-wide grant (docs/configure.md,
 * "Sending through Microsoft 365").
 *
 * The client secret goes to the token endpoint and nowhere else, and neither it
 * nor the access token is ever put into an error message: `deliverMessage`
 * writes a failure's message into the audit trail, which is the last place a
 * credential should end up.
 */
export function graphTransport(options: GraphTransportOptions): Transport & {
  /** Drops the cached token. For tests, and after a 401. */
  resetToken(): void;
} {
  const http = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const from = options.from ? parseMailbox(options.from) : null;

  let cached: { token: string; expiresAt: number } | null = null;
  // One request in flight at a time. A burst of queued sends on a cold cache
  // would otherwise ask for a token each, and the identity platform throttles
  // exactly that.
  let pending: Promise<string> | null = null;

  async function acquire(): Promise<string> {
    const response = await http(
      `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          scope: SCOPE,
          grant_type: 'client_credentials',
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_codes?: unknown;
    };
    if (!response.ok || typeof body.access_token !== 'string') {
      // The error CODE and the AADSTS number, never `error_description` in
      // full: it is Microsoft's prose, it is long, and it is not what an
      // operator greps for. `invalid_client` / AADSTS7000215 is "the secret is
      // wrong", which is the common one.
      const code = typeof body.error === 'string' ? body.error : 'no error code';
      const aadsts = Array.isArray(body.error_codes) && body.error_codes.length > 0
        ? ` (AADSTS${String(body.error_codes[0])})`
        : '';
      throw new Error(
        `Microsoft identity platform refused the mail token request: HTTP ${response.status}, ${code}${aadsts}. Check MAIL_GRAPH_TENANT_ID, MAIL_GRAPH_CLIENT_ID and MAIL_GRAPH_CLIENT_SECRET.`,
      );
    }
    const lifetimeS = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in ?? 0);
    cached = {
      token: body.access_token,
      expiresAt: now() + Math.max(0, lifetimeS * 1000 - EXPIRY_MARGIN_MS),
    };
    return body.access_token;
  }

  async function token(): Promise<string> {
    if (cached !== null && now() < cached.expiresAt) return cached.token;
    pending ??= acquire().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function post(message: OutboundMessage): Promise<Response> {
    const bearer = await token();
    return http(`${GRAPH}/users/${encodeURIComponent(options.sender)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          // HTML only. Graph takes one body; every template renders an HTML
          // part, and its escaping is what `renderMessage` already did.
          body: { contentType: 'HTML', content: message.html },
          toRecipients: [{ emailAddress: { address: message.to } }],
          ...(from === null
            ? {}
            : { from: { emailAddress: { address: from.address, ...(from.name ? { name: from.name } : {}) } } }),
        },
        // Nothing Syntra sends needs a second copy, and some of what it sends
        // is a one-time link: a Sent Items folder is one more mailbox that
        // holds it.
        saveToSentItems: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async send(message) {
      let response = await post(message);
      if (response.status === 429) {
        // Once. Graph's throttling says how long to wait; a second 429 after
        // waiting is a mailbox under sustained pressure, and that is reported
        // rather than retried into.
        await sleep(retryAfterMs(response.headers.get('retry-after')));
        response = await post(message);
      }
      if (response.status === 401) cached = null;
      if (!response.ok) throw await graphError(response);
    },
    async verify() {
      // A token is what a send needs first and what a misconfiguration fails.
      // Sending a message to prove sending works would put mail in somebody's
      // inbox from a status page.
      await token();
    },
    resetToken() {
      cached = null;
    },
  };
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 5_000;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Graph's own error code and message; never the request, never a header. */
async function graphError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: unknown; message?: unknown };
  };
  const code = typeof body.error?.code === 'string' ? body.error.code : 'no error code';
  const detail = typeof body.error?.message === 'string' ? `: ${body.error.message.slice(0, 300)}` : '';
  // The one refusal with a known, non-obvious cause. The application's RBAC
  // management scope does not include this mailbox -- or the assignment has
  // not propagated yet, which takes up to two hours.
  const hint =
    response.status === 403
      ? ' The application is not allowed to send as MAIL_GRAPH_SENDER: check that its Exchange Online management scope covers that mailbox (Test-ServicePrincipalAuthorization), and allow up to two hours after changing it.'
      : '';
  return new Error(`Microsoft Graph refused sendMail: HTTP ${response.status}, ${code}${detail}.${hint}`);
}
