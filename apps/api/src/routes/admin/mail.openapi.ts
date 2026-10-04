import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `mail.ts`. See openapi/describe.ts. */
export const mailOpenApi = describeAdminRoutes('Mail', {
  'GET /mail': {
    summary: 'Read how outgoing mail is sent',
    description:
      "The installation's mail transport (`smtp` or `graph`), the `server` it reaches (`smtp://host:port` or `Microsoft Graph as <mailbox>`, never a credential), the From address, the caller's own address as `recipient`, and `warning` when SMTP_URL points at a local test server such as MailDev while PUBLIC_URL is a real address.",
  },
  'POST /mail/test': {
    summary: "Send a test email to the caller's own address",
    description:
      "Sends one message through the configured transport and answers `ok`, the `server` it went through and a one-line `message`; a failure carries the transport's own error. Always the caller's address: nothing in the request names a recipient. Waits up to 30 seconds for the server. Audited as `notify.test_email`, `success` or `failure`.",
  },
});
