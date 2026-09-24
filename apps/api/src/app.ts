import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  buildInfo,
  installRecoveryCodeVerifier,
  installEmailOtpVerifier,
  installTotpVerifier,
  installWebAuthnVerifier,
  masterKeyProviderFor,
  onSigningKeysChanged,
  readiness,
  redactReport,
  smtpTransport,
  type Config,
  type Scheduler,
  type Transport,
} from '@syntra/core';
import { registerProblemJson } from './plugins/problem-json.js';
import { registerWebApp } from './plugins/web-app.js';
import { registerSecurityHeaders } from './plugins/security-headers.js';
import { tenantAndIpKey } from './plugins/rate-limit.js';
import {
  postgresRateLimitCounter,
  sharedRateLimitStore,
  startRateLimitSweeper,
} from './plugins/rate-limit-store.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerEnrolRoutes } from './routes/enrol.js';
import { registerPasswordResetRoutes } from './routes/password-reset.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBrandingRoutes } from './routes/branding.js';
import { registerAdminRoleRoutes } from './routes/admin/roles.js';
import { registerAdminTenantRoutes } from './routes/admin/tenant.js';
import { registerAdminWebhookRoutes } from './routes/admin/webhooks.js';
import { registerAdminUserRoutes } from './routes/admin/users.js';
import { registerAdminSessionRoutes } from './routes/admin/sessions.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerAdminTokenRoutes } from './routes/admin/tokens.js';
import { registerScimRoutes } from './routes/scim/index.js';
import { registerAdminGroupRoutes } from './routes/admin/groups.js';
import { registerAdminOrgUnitRoutes } from './routes/admin/org-units.js';
import { registerAdminPersonRoutes } from './routes/admin/persons.js';
import { registerEmployeeLifecycleRoutes } from './routes/admin/employee-lifecycle.js';
import { registerAdminPersonReceiptRoutes } from './routes/admin/person-receipts.js';
import { registerAdminLifecycleOperationRoutes } from './routes/admin/lifecycle-operations.js';
import { registerAdminAuditRoutes } from './routes/admin/audit.js';
import { registerAdminIncidentRoutes } from './routes/admin/incidents.js';
import { registerAdminUpdateRoutes } from './routes/admin/update.js';
import { registerAdminPersonSourceRoutes } from './routes/admin/person-sources.js';
import { registerAdminSourceRoutes } from './routes/admin/sources.js';
import { registerAdminSyncRunRoutes } from './routes/admin/sync-runs.js';
import { registerAdminApplicationRoutes } from './routes/admin/applications.js';
import { registerAdminPolicyRoutes } from './routes/admin/policies.js';
import { registerAdminProtocolRoutes } from './routes/admin/protocol-apps.js';
import { registerAdminUpstreamRoutes } from './routes/admin/upstreams.js';
import { registerAdminAutomateRoutes } from './routes/admin/automate.js';
import { registerAdminTargetRoutes } from './routes/admin/targets.js';
import { registerAdminProfileRoutes } from './routes/admin/profiles.js';
import { registerAdminRuleRoutes } from './routes/admin/rules.js';
import { registerAdminProvisionRunRoutes } from './routes/admin/provision-runs.js';
import { registerAdminGovernRoutes } from './routes/admin/govern.js';
import { configuredCheckpointSigner } from './govern-signer.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerAutomatePortalRoutes } from './routes/automate-portal.js';
import { registerGovernPortalRoutes } from './routes/govern-portal.js';
import { registerSamlIdpRoutes } from './routes/saml-idp.js';
import { registerOidcRoutes } from './routes/oidc-op.js';
import { registerOidcInteractionRoutes } from './routes/oidc-interaction.js';
import { registerOidcTokenRoutes } from './routes/oidc-token.js';
import { registerOidcLogoutRoutes } from './routes/oidc-logout.js';
import { registerFederationRoutes } from './routes/federation.js';
import { invalidateProvider } from '@syntra/protocols';
import { captureRouteCatalog, type CatalogRoute } from './openapi/route-catalog.js';
import { registerOpenApiRoute } from './openapi/route.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route this app registered. See openapi/route-catalog.ts. */
    routeCatalog: CatalogRoute[];
  }
}

import { loggerOptions, type LogStream } from './logging.js';
import { registerTracing } from './plugins/tracing.js';

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
  /**
   * Where log lines are written. Defaults to stdout; the redaction tests pass
   * a collector so they assert on what the REAL application logger emits.
   */
  logStream?: LogStream;
}

/**
 * Named, and at module scope, so registering it twice registers it once: the
 * listener registry is a `Set`, and a fresh arrow per `buildApp` would
 * accumulate one entry per app the test suite builds.
 */
const invalidateProviderOnKeyChange = (tenantId: string) => invalidateProvider(tenantId);

export async function buildApp(
  config: Config,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    // One logger configuration for the process -- redaction, the error
    // serializer and the correlation mixin all live in `logging.ts`.
    logger: options.logger === false ? false : loggerOptions({ stream: options.logStream }),
    // Which proxies may be believed about a request's source address. Off
    // unless TRUST_PROXY says otherwise, and never a bare `true` — see the
    // variable's own documentation in config.ts. request.ip feeds both the
    // policy engine's source-address condition and every rate-limit key, so
    // getting this wrong makes the first match everyone or nobody and
    // collapses the second into one global bucket.
    trustProxy: config.trustProxy,
    // /health and /health/ready are polled every few seconds by a container
    // orchestrator and, during an update, by the updater's own readiness
    // poll (see the route below) -- logging each of those at info would
    // drown one real request in a page of liveness noise. Everything else
    // still logs; only these two paths are silenced.
    //
    // A `logController` instance, not the top-level `disableRequestLogging`
    // option: that top-level option is deprecated (FSTDEP023) in this
    // Fastify version in favour of exactly this.
    logController: new LogController({
      // `/metrics` joins them: a scrape every fifteen seconds is the same
      // kind of noise, and it is polled by a machine that never reads the log.
      disableRequestLogging: (req) =>
        req.url != null &&
        (req.url.startsWith('/health') || req.url.startsWith('/metrics')),
    }),
  });

  // THE ROUTE TABLE, recorded as it is built. First, before any plugin can
  // register a route, because an `onRoute` hook only sees routes declared
  // after it. It is what the published OpenAPI description is derived from
  // (see openapi/document.ts) and what the coverage test asserts over, so a
  // route cannot exist without the document at least knowing it does.
  const routeCatalog = captureRouteCatalog(app);
  app.decorate('routeCatalog', routeCatalog);

  // First, so every later hook and handler runs with a correlation id and,
  // when tracing is on, inside the request's span.
  registerTracing(app);

  // Read once, from configuration, and available wherever a cookie is written.
  app.decorate('cookieSecure', config.cookieSecure);

  // THE master-key provider, built once and handed to every route that seals
  // or unseals: one unwrap cache and one Vault token per process rather than
  // one per route, and one place that decides which provider wraps
  // (MASTER_KEY_PROVIDER, see `vault/key-management.ts`). The scheduler asks
  // for the same config and gets this same instance.
  const keyProvider = masterKeyProviderFor(config);

  await app.register(cookie, { secret: config.sessionSecret });
  // Off by default; applied per route, since a blanket limit would throttle
  // ordinary reads as hard as password attempts.
  //
  // Keyed on tenant and address together rather than address alone: one
  // deployment serves many tenants, and a shared bucket lets one tenant's
  // traffic — or one tenant's attacker — spend everybody else's allowance.
  // The per-tenant ceiling that has to hold across many addresses is a second
  // limit, applied alongside this one at each credential-presenting route.
  //
  // Counted in Postgres by default (RATE_LIMIT_STORE), so every replica spends
  // the same allowance: the in-memory store granted each replica the whole of
  // it, which made every limit here N times too generous at N replicas. See
  // `plugins/rate-limit-store.ts`. A store error fails the request rather
  // than waving it through -- a limiter that cannot count grants nothing --
  // except where a route opts out (`/health/ready`, below).
  await app.register(rateLimit, {
    global: false,
    keyGenerator: tenantAndIpKey,
    ...(config.rateLimitStore === 'postgres'
      ? { store: sharedRateLimitStore(postgresRateLimitCounter) }
      : {}),
  });
  if (config.rateLimitStore === 'postgres') {
    const stopSweeper = startRateLimitSweeper(postgresRateLimitCounter, (error) =>
      app.log.warn({ err: error }, 'rate-limit sweep failed'),
    );
    app.addHook('onClose', async () => stopSweeper());
  }

  // The built application, where one is configured. Registered FIRST, because
  // both of the plugins below take a piece of it: the not-found handler that
  // serves a deep link, and the page shown when no tenant claims the hostname.
  // Fastify permits one not-found handler per context, so it has to be known
  // before `registerProblemJson` sets it — not bolted on afterwards.
  // Before the routes, so every response carries them -- including the ones
  // an error handler produces, which are the responses a header is most often
  // missing from. `cookieSecure` is the same question as "is this deployment
  // reached over HTTPS", so HSTS is derived from it rather than asked again.
  registerSecurityHeaders(app, { https: config.cookieSecure });

  const web = config.webRoot ? await registerWebApp(app, config.webRoot) : null;

  registerProblemJson(app, web ? { notFound: web.notFound } : {});
  registerTenantContext(app, web ? { unknownHostPage: web.unknownHostPage } : {});

  // LIVENESS. Deliberately a constant, and deliberately cheap: it answers "is
  // a process listening", which is the question the tunnel and `deploy.sh`
  // ask. It is not, and must not become, a check that touches the database --
  // a liveness probe that fails when Postgres blips restarts a healthy API.
  app.get('/health', async () => ({ status: 'ok' }));

  // Registers nothing at all when METRICS_TOKEN is unset, so an installation
  // that never opted in answers 404 rather than a 403 that confirms the route
  // exists. See the plugin's own docstring.
  await registerMetricsRoutes(app, {
    token: config.metricsToken,
    ...(options.scheduler ? { schedulerRunning: () => options.scheduler!() !== null } : {}),
    // The same call `/health/ready` makes below, so there is one readiness
    // definition rather than two that can disagree.
    isReady: async () =>
      (
        await readiness({
          provider: keyProvider,
          webRoot: config.webRoot ?? undefined,
          version: buildInfo().version,
        })
      ).ready,
  });

  // READINESS. A different question -- "can this process do its job" -- and
  // the only one of the two that can answer no.
  //
  // 503 rather than 200-with-a-flag, so anything that speaks HTTP can gate on
  // it without parsing a body: the updater's automatic rollback hangs on this
  // status code. Unauthenticated for the same reason the updater needs it --
  // it holds no session and cannot obtain one while the thing it is checking
  // is broken.
  app.get(
    '/health/ready',
    {
      // A RATE LIMIT, because this one is not free: several queries, two
      // withTenant transactions and an AES unseal per request, unauthenticated,
      // as fast as anybody cares to ask. `rateLimit` is registered
      // `global: false`, so a route that sets no config has none at all.
      //
      // Sixty a minute, not thirty: the updater's readiness poll (3s interval,
      // 90s deadline) issues exactly 30 requests on its own -- not "double"
      // anything -- and a FAILED update polls this twice, once for the new
      // release and again for the rollback, which can land inside the same
      // one-minute window. Keyed per address, so the updater on loopback and
      // a container orchestrator's probe do not share a bucket with anybody.
      //
      // `skipOnError`: the limiter's counters live in Postgres, and this is
      // the route whose job is to REPORT that Postgres is unreachable -- with
      // a 503 and the failing probe named. Failing closed here would turn that
      // into a bare 500 from the limiter and hide the diagnosis.
      config: { rateLimit: { max: 60, timeWindow: '1 minute', skipOnError: true } },
    },
    async (request, reply) => {
      const report = await readiness({
        provider: keyProvider,
        webRoot: config.webRoot ?? undefined,
        version: buildInfo().version,
      });

      // The CAUSE goes to the journal and the NAME goes on the wire. This
      // answer is unauthenticated, and Prisma's message names the host and
      // port it could not reach -- which is not something a sign-in attempt
      // tells anybody, whatever the old comment here claimed.
      if (!report.ready) {
        request.log.warn(
          { probes: report.probes.filter((probe) => probe.status === 'fail') },
          'readiness check failed',
        );
      }

      return reply.status(report.ready ? 200 : 503).send(redactReport(report));
    },
  );

  // The OpenAPI description of the administration API. Unauthenticated and
  // outside tenant resolution (see UNSCOPED_PATHS): it describes the product,
  // not any tenant, and an integrator generating a client has no session yet.
  registerOpenApiRoute(app, routeCatalog);

  // Before the auth routes and outside every session guard: this is what the
  // sign-in page reads in order to render itself.
  await app.register(registerBrandingRoutes, { prefix: '/api/branding' });

  await app.register(registerAuthRoutes, {
    prefix: '/api/auth',
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    publicUrl: config.publicUrl,
    keyProvider,
  });

  // Factor verifiers are installed once per process, before any route can ask
  // the chokepoint what is enrolled or what could be enrolled. A verifier that
  // is not installed is not a factor: authorize() would report the user as
  // having none AND nothing to enrol, and refuse rather than offer.
  //
  // None of them takes a relying party. It arrives per request on
  // AuthorizeRequest, which is why there is no ambient store here and why a
  // background job that has no relying party cannot compile.
  installTotpVerifier(keyProvider);
  // No master key: an email code has no secret to seal. Whether a tenant may
  // offer it at all is `Tenant.emailOtpEnabled`, checked where a tenant is in
  // scope — registering the verifier only says this deployment can.
  installEmailOtpVerifier();
  installWebAuthnVerifier();
  installRecoveryCodeVerifier();

  // The OIDC Provider resolves its JWKS once, at construction, and is cached
  // per tenant. Rotating a signing key would leave it signing with the old
  // private key -- harmless during the overlap, and a total outage the moment
  // the old key is retired and unpublished, until somebody restarts the
  // process. `@syntra/core` cannot call `invalidateProvider` itself (the
  // package dependency runs the other way), so it announces and this listens.
  //
  // That listener only reaches THIS process, and a rotation usually runs in
  // the worker. What keeps every replica correct is the tenant's
  // `oidcConfigGeneration`, bumped by a trigger in the rotation's own
  // transaction and compared on every request (`provider-factory.ts`). The
  // listener stays as a free local fast path.
  onSigningKeysChanged(invalidateProviderOnKeyChange);

  // One transport instance, shared by both routers below: the "a factor was
  // added" mail is the same control whether the enrolment happened from a
  // live session or under a forced-enrolment attempt.
  const transport = options.transport ?? smtpTransport(config.smtpUrl);

  await app.register(registerMfaRoutes, {
    prefix: '/api/auth/mfa',
    keyProvider,
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    // The factor-added mail. The same transport the password routes will get.
    transport,
  });

  await app.register(registerEnrolRoutes, {
    prefix: '/api/auth/enrol',
    keyProvider,
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
  await app.register(registerAdminWebhookRoutes, {
    prefix: '/api/admin',
    keyProvider,
    outboundAllowPrivate: config.outboundAllowPrivate,
  });
  await app.register(registerAdminRoleRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminIncidentRoutes, {
    prefix: '/api/admin',
    ...(options.scheduler ? { schedulerRunning: () => options.scheduler!() !== null } : {}),
  });
  await app.register(registerAdminUserRoutes, {
    prefix: '/api/admin',
    keyProvider,
    publicUrl: config.publicUrl,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminSessionRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminTokenRoutes, { prefix: '/api/admin' });
  // Not under /api: SCIM clients are configured with a base URL and expect
  // /scim/v2 to be it, and putting it elsewhere is a support conversation on
  // every single setup.
  await app.register(registerScimRoutes, {
    prefix: '/scim/v2',
    // `meta.location` is built from this rather than from the request's own
    // Host, so a client cannot make the directory hand out links to a host it
    // chose. The rate limits are the password ones scaled up: a provisioning
    // sync is the load here, not a person signing in.
    publicUrl: config.publicUrl,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  });
  await app.register(registerAdminGroupRoutes, { prefix: '/api/admin' });
  // `keyProvider`, because deleting a source-owned unit unseals that source's
  // bind credential to remove the container from the directory first.
  await app.register(registerAdminOrgUnitRoutes, {
    prefix: '/api/admin',
    keyProvider,
  });
  await app.register(registerAdminPersonRoutes, { prefix: '/api/admin' });
  await app.register(registerEmployeeLifecycleRoutes, { prefix: '/api/admin', keyProvider, publicUrl: config.publicUrl, ...(options.scheduler ? { scheduler: options.scheduler } : {}) });
  await app.register(registerAdminPersonReceiptRoutes, {
    prefix: '/api/admin',
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminLifecycleOperationRoutes, {
    prefix: '/api/admin',
    publicUrl: config.publicUrl,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminAuditRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminUpdateRoutes, {
    prefix: '/api/admin',
    releaseRepo: config.releaseRepo,
    releaseToken: config.releaseToken,
    releaseRoot: config.releaseRoot,
    readyUrl: `http://127.0.0.1:${config.port}/health/ready`,
  });
  await app.register(registerAdminSourceRoutes, {
    prefix: '/api/admin',
    keyProvider,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminPersonSourceRoutes, {
    prefix: '/api/admin',
    keyProvider,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminSyncRunRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminApplicationRoutes, {
    prefix: '/api/admin',
    // Both needed by the catalog route, which has to establish the tenant's
    // SAML signing key before it writes a `SamlConfig` — see the comment
    // there.
    keyProvider,
    publicUrl: config.publicUrl,
  });
  await app.register(registerAdminPolicyRoutes, {
    prefix: '/api/admin',
    authRateLimitMax: config.authRateLimitMax,
  });
  // Protocol configuration for an application, and the upstream providers a
  // tenant federates to. Both are ACCESS_MANAGE behind an administrative
  // session, and both are registered after the application routes so
  // `/applications/:id/saml` cannot shadow `/applications/:id`.
  await app.register(registerAdminProtocolRoutes, {
    prefix: '/api/admin',
    outboundAllowPrivate: config.outboundAllowPrivate,
    keyProvider,
    publicUrl: config.publicUrl,
  });
  await app.register(registerAdminUpstreamRoutes, {
    prefix: '/api/admin',
    keyProvider,
  });

  // Provisioning. Registered AFTER `registerAdminPersonRoutes` so
  // `/persons/:id` cannot shadow `/persons/:id/access` — the access view lives
  // in the person plugin for that reason, and the ordering here is what keeps
  // the four plugins below from being read as owning it.
  //
  // `transport` is the same value the password-reset routes are given, so a
  // delivered initial password goes through the memory transport in tests and
  // SMTP in production.
  await app.register(registerAdminTargetRoutes, {
    prefix: '/api/admin',
    keyProvider,
    authRateLimitMax: config.authRateLimitMax,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminProfileRoutes, { prefix: '/api/admin' });
  // Govern. Registered after the Provision plugins so nothing under
  // `/govern/...` can be shadowed by a broader `:id` route above it, and given
  // the scheduler factory because `Refresh now` enqueues Directory Sync's and
  // Provision's OWN jobs rather than reading a source itself.
  await app.register(registerAdminGovernRoutes, {
    prefix: '/api/admin',
    // §12: starting a campaign emails every resolved reviewer a link. Without
    // this the link is relative and nobody can click it from a mail client.
    publicUrl: config.publicUrl,
    // The SAME signer the scheduler uses. See govern-signer.ts for what
    // happened when these two were constructed separately.
    checkpointSigner: () => configuredCheckpointSigner(config),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminRuleRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminProvisionRunRoutes, {
    prefix: '/api/admin',
    keyProvider,
    transport,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });

  await app.register(registerAdminAutomateRoutes, {
    prefix: '/api/admin',
    publicUrl: config.publicUrl,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });

  await app.register(registerPortalRoutes, {
    prefix: '/api/portal',
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    publicUrl: config.publicUrl,
  });

  // Its own plugin rather than added to `portal.ts`, so the `preHandler` hook
  // and the rate limits of the launch routes stay where they are: Fastify
  // encapsulates hooks per plugin, and `registerPortalRoutes` already adds a
  // `preHandler` of its own.
  await app.register(registerAutomatePortalRoutes, {
    prefix: '/api/portal',
    publicUrl: config.publicUrl,
    // The same transport every other mailing path uses. Not optional on the
    // route options: a `send_password_reset` task registered without one
    // reports success and mails nobody.
    transport,
    // Spec section 5: an approval that produces target grants enqueues a run
    // of the affected target system. Without this the portal's own decisions
    // wait for the tick job, up to five minutes.
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });

  // Its own plugin for the same reason Automate's is: Fastify encapsulates
  // hooks per plugin, and this one needs `requireSession('portal')` and NO
  // permission at all — review authority comes from resolution, not from a
  // right anybody holds.
  await app.register(registerGovernPortalRoutes, { prefix: '/api/portal' });

  await app.register(registerSamlIdpRoutes, {
    prefix: '/saml',
    publicUrl: config.publicUrl,
    keyProvider,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
  });

  // Syntra as a relying party. Registered before the OIDC provider routes so
  // its own prefix is unambiguous: this is the consuming direction, and
  // everything under /oidc is the issuing one.
  await app.register(registerFederationRoutes, {
    prefix: '/federation',
    publicUrl: config.publicUrl,
    keyProvider,
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitTenantMax: config.authRateLimitTenantMax,
    outboundAllowPrivate: config.outboundAllowPrivate,
  });

  const oidcOptions = {
    publicUrl: config.publicUrl,
    keyProvider,
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
