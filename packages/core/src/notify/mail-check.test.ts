import { describe, expect, it } from 'vitest';
import type { MailConfig } from '../config.js';
import { describeMailServer, mailSinkWarning, sendTestEmail } from './mail-check.js';
import { memoryTransport } from './notification-service.js';

const smtp = (smtpUrl: string): MailConfig => ({ transport: 'smtp', smtpUrl, from: 'Syntra <no-reply@acme.test>' });
const graph: MailConfig = {
  transport: 'graph',
  tenantId: 'contoso.onmicrosoft.com',
  clientId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  clientSecret: 'client-secret-value',
  sender: 'syntra@contoso.com',
  from: null,
};

describe('describeMailServer', () => {
  it('names scheme, host and port, never the credential or the options', () => {
    expect(describeMailServer(smtp('smtp://localhost:1025'))).toBe('smtp://localhost:1025');
    expect(describeMailServer(smtp('smtps://relay:p%40ss@mail.contoso.com:465?tls.rejectUnauthorized=false'))).toBe(
      'smtps://mail.contoso.com:465',
    );
    expect(describeMailServer(smtp('smtp://mail.contoso.com'))).toBe('smtp://mail.contoso.com');
    expect(describeMailServer(graph)).toBe('Microsoft Graph as syntra@contoso.com');
  });
});

describe('mailSinkWarning', () => {
  const site = 'https://syntra.ssander.xyz';

  it('warns when SMTP goes to a local test server on an install with a real address', () => {
    expect(mailSinkWarning({ mail: smtp('smtp://localhost:1025'), publicUrl: site })).toEqual({
      server: 'smtp://localhost:1025',
      message: 'Mail goes to smtp://localhost:1025, a local test server. Set SMTP_URL to a real mail server.',
    });
    for (const url of [
      'smtp://127.0.0.1:25',
      'smtp://[::1]:587',
      'smtp://mail.localhost:25',
      'smtp://maildev:1025',
      'smtp://mailpit:25',
      'smtp://mail.internal:1025',
    ]) {
      expect(mailSinkWarning({ mail: smtp(url), publicUrl: site }), url).not.toBeNull();
    }
    // A plain-http install on a real host is still one people use.
    expect(mailSinkWarning({ mail: smtp('smtp://localhost:1025'), publicUrl: 'http://syntra.lan' })).not.toBeNull();
  });

  it('says nothing for a real mail server, a local install or Microsoft Graph', () => {
    expect(mailSinkWarning({ mail: smtp('smtp://smtp.contoso.com:587'), publicUrl: site })).toBeNull();
    expect(mailSinkWarning({ mail: smtp('smtps://user:pw@smtp.office365.com:465'), publicUrl: site })).toBeNull();
    expect(mailSinkWarning({ mail: smtp('smtp://localhost:1025'), publicUrl: 'http://localhost:3000' })).toBeNull();
    expect(mailSinkWarning({ mail: smtp('smtp://localhost:1025'), publicUrl: 'https://127.0.0.1:8443' })).toBeNull();
    expect(mailSinkWarning({ mail: graph, publicUrl: site })).toBeNull();
  });

  it('never repeats the SMTP credential', () => {
    const warning = mailSinkWarning({ mail: smtp('smtp://dev:hunter2@localhost:1025'), publicUrl: site });
    expect(JSON.stringify(warning)).not.toContain('hunter2');
  });
});

describe('sendTestEmail', () => {
  const input = { tenantName: 'Acme', to: 'anna@contoso.com', displayName: 'Anna', server: 'smtp://mail.contoso.com:587' };

  it('sends the test template to the address given, naming the server', async () => {
    const mail = memoryTransport();
    expect(await sendTestEmail(mail, { ...input, now: new Date('2026-10-03T09:00:00.000Z') })).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: 'anna@contoso.com', subject: 'Test email from Acme' });
    expect(mail.sent[0]!.text).toContain('smtp://mail.contoso.com:587');
    expect(mail.sent[0]!.text).toContain('2026-10-03T09:00:00.000Z');
  });

  it("reports the transport's error, first line only and scrubbed", async () => {
    const result = await sendTestEmail(
      {
        send: async () => {
          throw new Error('Invalid login: 535 5.7.8 password=hunter2 rejected\n    at SMTPConnection._formatError');
        },
      },
      input,
    );
    expect(result.ok).toBe(false);
    const error = result.ok ? '' : result.error;
    expect(error).toMatch(/^Invalid login: 535 5\.7\.8/);
    expect(error).not.toContain('hunter2');
    expect(error).not.toContain('SMTPConnection');
  });

  it('gives up on a server that does not answer', async () => {
    const result = await sendTestEmail({ send: () => new Promise(() => undefined) }, input, 20);
    expect(result).toEqual({ ok: false, error: 'no answer within 20 ms' });
  });
});
