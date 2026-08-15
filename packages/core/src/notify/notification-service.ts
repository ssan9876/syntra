import nodemailer from 'nodemailer';
import { TEMPLATES, type TemplateName } from './templates/index.js';

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Transport {
  send(message: OutboundMessage): Promise<void>;
}

export function smtpTransport(smtpUrl: string): Transport {
  const mailer = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await mailer.sendMail({
        from: 'Syntra <no-reply@syntra.local>',
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

/**
 * Collects messages instead of sending them. Every test in the codebase uses
 * this, so no test run can put mail on the wire.
 */
export function memoryTransport(): Transport & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );

/**
 * Substitutes {{name}}. An unknown placeholder is left in place rather than
 * replaced with "undefined", so a missing variable is obvious in the message
 * instead of looking like a broken sentence.
 */
function render(
  template: string,
  vars: Record<string, string>,
  escape: boolean,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) return match;
    return escape ? escapeHtml(value) : value;
  });
}

/**
 * Renders a message. Pure: no database, no transport, no clock.
 *
 * The tenant name is a parameter rather than something read from a
 * transaction, which is what makes this safe to call anywhere — and what stops
 * the send being dragged inside a transaction along with the read.
 */
export function renderMessage(
  tenantName: string,
  template: TemplateName,
  to: string,
  vars: Record<string, string>,
): OutboundMessage {
  const definition = TEMPLATES[template];
  if (!definition) {
    throw new Error(`unknown template: ${template}`);
  }

  const all = { ...vars, tenantName };
  return {
    to,
    subject: render(definition.subject, all, false),
    text: render(definition.text, all, false),
    // Only the HTML part is escaped; escaping the text part would show the
    // reader a literal &amp; instead of an ampersand.
    html: render(definition.html, all, true),
  };
}

/**
 * Sends a rendered message.
 *
 * Takes no transaction, and therefore cannot be given one. That is the whole
 * design: the previous signature accepted a `TenantClient`, which made
 * `withTenant(tx => notify(tx, …))` look like the obvious way to call it, and
 * put an SMTP round trip inside `prisma.$transaction` under its 5000 ms
 * timeout. The split is not a convention anyone has to remember — the old
 * shape no longer type-checks.
 */
export async function sendMessage(
  transport: Transport,
  message: OutboundMessage,
): Promise<void> {
  await transport.send(message);
}
