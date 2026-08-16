import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  installRecoveryCodeVerifier,
  installTotpVerifier,
  installWebAuthnVerifier,
  localMasterKeyProvider,
  smtpTransport,
  type Config,
  type Scheduler,
  type Transport,
} from '@syntra/core';
import { registerProblemJson } from './plugins/problem-json.js';
import { tenantAndIpKey } from './plugins/rate-limit.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerEnrolRoutes } from './routes/enrol.js';
import { registerPasswordResetRoutes } from './routes/password-reset.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminTenantRoutes } from './routes/admin/tenant.js';
import { registerAdminUserRoutes } from './routes/admin/users.js';
import { registerAdminGroupRoutes } from './routes/admin/groups.js';
import { registerAdminOrgUnitRoutes } from './routes/admin/org-units.js';
import { registerAdminPersonRoutes } from './routes/admin/persons.js';
import { registerAdminAuditRoutes } from './routes/admin/audit.js';
import { registerAdminSourceRoutes } from './routes/admin/sources.js';
import { registerAdminSyncRunRoutes } from './routes/admin/sync-runs.js';
import { registerAdminApplicationRoutes } from './routes/admin/applications.js';
import { registerAdminPolicyRoutes } from './routes/admin/policies.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerSamlIdpRoutes } from './routes/saml-idp.js';
import { registerOidcRoutes } from './routes/oidc-op.js';
import { registerOidcInteractionRoutes } from './routes/oidc-interaction.js';
import { registerOidcTokenRoutes } from './routes/oidc-token.js';
import { registerOidcLogoutRoutes } from './routes/oidc-logout.js';

export interface AppOptions {
  logger?: boolean;
  /**
   * How the source routes reach the job scheduler, so a source created,
   * changed or deleted is rescheduled there and then rather than at the next
   * restart.
   *
   * A function, not a `Scheduler`, because the scheduler is started after the
   * app is built — it needs the app's logger, and it is allowed to fail to
   * start without keeping the API down. Omitted, source mutations simply do
   * not touch any scheduler, which is what the tests that do not care want.
   */
  scheduler?: () => Scheduler | null;
  /**
   * How outbound mail leaves the process. Defaults to SMTP from `SMTP_URL`.
   *
   * A seam rather than a hard-wired `smtpTransport` call so the test suite can
   * hand in `memoryTransport()` — no test run may put mail on the wire, and a
   * transport that is a parameter is the only way to guarantee that without
   * relying on MailDev happening to be the thing listening on port 1025.
   */
  transport?: Transport;
}

export async function buildApp(
  config: Config,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // Which proxies may be believed about a request's source address. Off
    // unless TRUST_PROXY says otherwise, and never a bare `true` — see the
    // variable's own documentation in config.ts. request.ip feeds both the
    // policy engine's source-address condition and every rate-limit key, so
    // getting this wrong makes the first match everyone or nobody and
    // collapses the second into one global bucket.
    trustProxy: config.trustProxy,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  // Off by default; applied per route, since a blanket limit would throttle
  // ordinary reads as hard as password attempts.
  //
  // Keyed on tenant and address together rather than address alone: one
  // deployment serves many tenants, and a shared bucket lets one tenant's
  // traffic — or one tenant's attacker — spend everybody else's allowance.
  // The per-tenant ceiling that has to hold across many addresses is a second
  // limit, applied alongside this one at each credential-presenting route.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: tenantAndIpKey,
  });

  registerProblemJson(app);
  registerTenantContext(app);

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(registerAuthRoutes, {
    prefix: '/api/auth',
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    publicUrl: config.publicUrl,
  });

  // Factor verifiers are installed once per process, before any route can ask
  // the chokepoint what is enrolled or what could be enrolled. A verifier that
  // is not installed is not a factor: authorize() would report the user as
  // having none AND nothing to enrol, and refuse rather than offer.
  //
  // None of them takes a relying party. It arrives per request on
  // AuthorizeRequest, which is why there is no ambient store here and why a
  // background job that has no relying party cannot compile.
  installTotpVerifier(localMasterKeyProvider(config.masterKey));
  installWebAuthnVerifier();
  installRecoveryCodeVerifier();

  // One transport instance, shared by both routers below: the "a factor was
  // added" mail is the same control whether the enrolment happened from a
  // live session or under a forced-enrolment attempt.
  const transport = options.transport ?? smtpTransport(config.smtpUrl);

  await app.register(registerMfaRoutes, {
    prefix: '/api/auth/mfa',
    masterKey: config.masterKey,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    // The factor-added mail. The same transport the password routes will get.
    transport,
  });

  await app.register(registerEnrolRoutes, {
    prefix: '/api/auth/enrol',
    masterKey: config.masterKey,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    transport,
  });

  // Self-service password reset. Unauthenticated by nature — the caller has
  // forgotten the one credential they had — and it shares the transport so a
  // completed reset mails the account owner from the same seam as everything
  // else.
  await app.register(registerPasswordResetRoutes, {
    prefix: '/api/auth/password-reset',
    transport,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  });

  // Every route below requires an administrative session; the guard is
  // applied inside each plugin so a new admin route cannot forget it.
  await app.register(registerAdminTenantRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminUserRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminGroupRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminOrgUnitRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminPersonRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminAuditRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminSourceRoutes, {
    prefix: '/api/admin',
    masterKey: config.masterKey,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminSyncRunRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminApplicationRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminPolicyRoutes, {
    prefix: '/api/admin',
    authRateLimitMax: config.authRateLimitMax,
  });

  await app.register(registerPortalRoutes, {
    prefix: '/api/portal',
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    publicUrl: config.publicUrl,
  });

  await app.register(registerSamlIdpRoutes, {
    prefix: '/saml',
    publicUrl: config.publicUrl,
    masterKey: config.masterKey,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  });

  const oidcOptions = {
    publicUrl: config.publicUrl,
    masterKey: config.masterKey,
    sessionSecret: config.sessionSecret,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  };
  await app.register(registerOidcInteractionRoutes, { prefix: '/oidc', ...oidcOptions });
  await app.register(registerOidcLogoutRoutes, { prefix: '/oidc', ...oidcOptions });
  // Its own encapsulated scope, so the body parser it registers to authenticate
  // the client cannot escape into the catch-all's.
  await app.register(registerOidcTokenRoutes, { prefix: '/oidc', ...oidcOptions });
  // The catch-all last: every specific route above must be matched first, and
  // this is the only one that hands oidc-provider an unparsed body.
  await app.register(registerOidcRoutes, { prefix: '/oidc', ...oidcOptions });

  return app;
}
