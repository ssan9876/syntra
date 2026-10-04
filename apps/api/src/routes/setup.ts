import type { FastifyInstance } from 'fastify';
import { setupRequest, setupResponse, setupStatusQuery, setupStatusResponse } from '@syntra/contracts';
import { validateNewPassword, type KeyManagementConfig, type MasterKeyProvider } from '@syntra/core';
import { BOOTSTRAP_PASSWORD_MIN_LENGTH, bootstrapTenant } from '@syntra/db/src/bootstrap-core.js';
import type { FirstRunSetup, SetupTokenCheck } from '../first-run-setup.js';
import { ProblemError } from '../plugins/problem-json.js';
import { passwordRejectionMessage } from './password-rejection.js';

export interface SetupRouteOptions {
  setup: FirstRunSetup;
  publicUrl: string;
  keyProvider: MasterKeyProvider;
  keyManagement: KeyManagementConfig;
  /** Requests per minute, per address. */
  authRateLimitMax: number;
}

/**
 * First-run setup: the form that creates the first tenant and its Owner,
 * reached from the one-time link the API prints at startup when the database
 * has no tenant at all.
 *
 * OUTSIDE TENANT RESOLUTION (`UNSCOPED_PATHS` in `plugins/tenant-context.ts`),
 * because there is no tenant to resolve yet. In its place:
 *
 *  - Every call carries the token. Without it, or with the wrong one, the
 *    answer is 403; past its hour, 410.
 *  - Once any tenant exists, both routes answer 404, whatever the token,
 *    exactly as a path with no route does. A configured install says nothing
 *    about whether it was ever set up this way.
 *
 * The tenant is made by `bootstrapTenant`, the function the bootstrap script
 * runs, so the two paths cannot drift apart.
 */
export async function registerSetupRoutes(app: FastifyInstance, options: SetupRouteOptions): Promise<void> {
  const LIMIT = { config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } } };
  const { setup } = options;

  const notFound = () => new ProblemError(404, 'not-found', 'Not Found');

  function refuse(status: SetupTokenCheck | 'busy' | 'closed'): ProblemError {
    switch (status) {
      case 'closed':
        return notFound();
      case 'expired':
        return new ProblemError(410, 'setup-link-expired', 'Setup link expired', 'Restart the API to print a new link.');
      case 'busy':
        return new ProblemError(409, 'setup-in-progress', 'Setup is already running', 'Wait a moment, then sign in.');
      default:
        return new ProblemError(403, 'setup-link-invalid', 'Setup link not valid', 'Open the link the API printed to its log at startup.');
    }
  }

  app.get('/api/setup', { ...LIMIT }, async (request, reply) => {
    if (!(await setup.pending())) throw notFound();
    reply.header('cache-control', 'no-store');
    const token = (request.query as { token?: unknown } | undefined)?.token;
    const checked = setup.check(typeof token === 'string' ? token : undefined);
    if (checked !== 'ok') throw refuse(checked);
    setupStatusQuery.parse(request.query);
    return setupStatusResponse.parse({
      primaryDomain: new URL(options.publicUrl).hostname.toLowerCase(),
      passwordMinLength: BOOTSTRAP_PASSWORD_MIN_LENGTH,
      expiresAt: setup.expiresAt()!.toISOString(),
    });
  });

  app.post('/api/setup', { ...LIMIT }, async (request, reply) => {
    if (!(await setup.pending())) throw notFound();
    reply.header('cache-control', 'no-store');
    // The token before the body: a caller without it learns nothing, not even
    // which fields the form has.
    const token = (request.body as { token?: unknown } | undefined)?.token;
    const checked = setup.check(typeof token === 'string' ? token : undefined);
    if (checked !== 'ok') throw refuse(checked);

    const body = setupRequest.parse(request.body);
    const policy = validateNewPassword(body.password, {
      minLength: BOOTSTRAP_PASSWORD_MIN_LENGTH,
      login: body.adminEmail,
      email: body.adminEmail,
    });
    if (!policy.ok) {
      const message = passwordRejectionMessage(policy.reason);
      throw new ProblemError(400, 'weak-password', 'That password does not meet the policy', message, {
        errors: [{ path: 'password', message }],
      });
    }

    const outcome = await setup.complete(body.token, () =>
      bootstrapTenant(
        {
          tenantName: body.organizationName,
          tenantSlug: body.slug,
          tenantDomain: body.primaryDomain,
          adminLogin: body.adminEmail,
          adminEmail: body.adminEmail,
          adminDisplayName: body.adminDisplayName,
          adminPassword: body.password,
          keyManagement: options.keyManagement,
        },
        { via: 'setup', sourceIp: request.ip, keyProvider: options.keyProvider },
      ),
    );
    if (outcome.status !== 'done') throw refuse(outcome.status);

    request.log.info(
      { tenantId: outcome.value.tenantId },
      `first-run setup completed: tenant "${outcome.value.tenantSlug}" created`,
    );
    return reply.status(201).send(
      setupResponse.parse({
        login: outcome.value.adminLogin,
        signInUrl: signInUrl(options.publicUrl, body.primaryDomain),
      }),
    );
  });
}

/**
 * Where the new Owner signs in. PUBLIC_URL itself when the primary domain is
 * its hostname, which is the form's suggestion; otherwise the primary domain
 * on PUBLIC_URL's scheme, because that is the name the tenant answers on.
 */
export function signInUrl(publicUrl: string, primaryDomain: string): string {
  const site = new URL(publicUrl);
  if (site.hostname.toLowerCase() === primaryDomain) return new URL('/login', site).toString();
  return `${site.protocol}//${primaryDomain}/login`;
}
