import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  ensureActiveKey,
  findApplication,
  localMasterKeyProvider,
  publishedKeys,
} from '@syntra/core';
import { buildIdpMetadata } from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { assertProtocolHost, tenantProtocolIdentity } from './protocol-identity.js';

export interface SamlRouteOptions {
  publicUrl: string;
  masterKey: Buffer;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
}

/** Reads the tenant row every SAML route needs, once. */
export async function samlContext(
  request: FastifyRequest,
  options: { publicUrl: string },
) {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const identity = tenantProtocolIdentity(tenant, options.publicUrl);
  assertProtocolHost(request, identity);
  return { tenant, identity };
}

export async function registerSamlIdpRoutes(
  app: FastifyInstance,
  options: SamlRouteOptions,
): Promise<void> {
  /**
   * The tenant's IdP metadata.
   *
   * Also served at `/metadata/:applicationId`, because spec section 7 asks for
   * a per-application endpoint: the document is identical for every
   * application in a tenant — one entity ID, one key set — but an
   * administrator wiring up one service provider wants a URL they can copy
   * from that application's page and hand to its vendor, and a shared URL
   * invites the question of whether it is really shared. The path parameter is
   * validated so a mistyped id is a 404 rather than a document naming an
   * application that does not exist.
   */
  const metadata = async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenant, identity } = await samlContext(request, options);
    const applicationId = (request.params as { applicationId?: string }).applicationId;
    if (applicationId !== undefined) {
      const application = await request.db((tx) => findApplication(tx, applicationId));
      if (!application || application.type !== 'saml') {
        throw new ProblemError(404, 'not-found', 'No such SAML application');
      }
    }

    // Generation is expensive and must not sit inside a transaction; the
    // service opens its own. Fetching metadata is the first thing an
    // administrator does when wiring an SP, so this is where the tenant's
    // SAML key comes into existence.
    await ensureActiveKey(request.tenantId, localMasterKeyProvider(options.masterKey), 'saml', {
      commonName: identity.acsHost,
    });
    const keys = await publishedKeys(request.tenantId, 'saml');

    const xml = buildIdpMetadata({
      entityId: identity.entityId,
      ssoUrl: identity.ssoUrl,
      sloUrl: identity.sloUrl,
      nameIdFormats: [
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
      ],
      certificates: keys.flatMap((k) => (k.certificate ? [k.certificate] : [])),
    });

    void tenant;
    return reply
      .type('application/samlmetadata+xml')
      .header('cache-control', 'public, max-age=300')
      .send(xml);
  };

  app.get('/metadata', metadata);
  app.get('/metadata/:applicationId', metadata);
}
