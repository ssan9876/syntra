import nodemailer from 'nodemailer';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
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

export async function notify(
  tx: TenantClient,
  transport: Transport,
  template: TemplateName,
  to: string,
  vars: Record<string, string>,
): Promise<void> {
  const definition = TEMPLATES[template];
  if (!definition) {
    throw new Error(`unknown template: ${template}`);
  }

  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  const all = { ...vars, tenantName: tenant?.name ?? 'Syntra' };

  await transport.send({
    to,
    subject: render(definition.subject, all, false),
    text: render(definition.text, all, false),
    // Only the HTML part is escaped; escaping the text part would show the
    // reader a literal &amp; instead of an ampersand.
    html: render(definition.html, all, true),
  });
}
