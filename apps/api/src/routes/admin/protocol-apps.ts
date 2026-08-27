import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  claimMappingRequest,
  claimMappingSetRequest,
  idParam,
  oidcClientRequest,
  samlConfigRequest,
  spMetadataImportRequest,
} from '@syntra/contracts';
import {
  ClaimMappingSetProtocolMismatchError,
  PERMISSIONS,
  REQUIRE_SIGNED_AUTHN_REQUESTS_BY_DEFAULT,
  applyClaimMappingSet,
  createClaimMapping,
  createClaimMappingSet,
  deleteClaimMapping,
  deleteClaimMappingSet,
  listClaimMappingSets,
  ensureActiveKey,
  fetchExternalDocument,
  findApplication,
  findSamlConfigByEntityId,
  findSamlConfigForApplication,
  listClaimMappings,
  localMasterKeyProvider,
  recordEvent,
  upsertOidcClient,
  upsertSamlConfig,
  type SamlConfigInput,
} from '@syntra/core';
import { invalidateProvider, parseSpMetadata } from '@syntra/protocols';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';
import { tenantProtocolIdentity } from '../protocol-identity.js';

export interface AdminProtocolRouteOptions {
  /** From `OUTBOUND_ALLOW_PRIVATE`. See Task 2. */
  outboundAllowPrivate: boolean;
  /** Wraps the SAML signing key established when a configuration is written. */
  masterKey: Buffer;
  /** Where this deployment answers. Never the Host header. */
  publicUrl: string;
}

export async function registerAdminProtocolRoutes(
  app: FastifyInstance,
  options: AdminProtocolRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const manage = { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) };
  const read = { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) };

  const provider = localMasterKeyProvider(options.masterKey);

  /**
   * Makes sure this tenant has a SAML signing key, before the transaction.
   *
   * Writing a `SamlConfig` is the moment a tenant commits to being an identity
   * provider, and `saveSamlConfig` exists in `packages/core` for exactly this
   * seam — the plan had this route call the bare `upsertSamlConfig`, which
   * would have put the key back where it was before commit 5b67bb9: created
   * only by whoever first fetched `/saml/metadata` on the tenant's own host,
   * so an administrator who configured a service provider and never did that
   * had every sign-in dead-end at 409 `saml-no-key` with nothing self-healing
   * it.
   *
   * Called with the transaction closed. RSA-2048 generation plus a self-signed
   * certificate is well over a second — a large bite out of the 5000 ms
   * `withTenant` budget spent on work that touches no row — and Global
   * Constraint 1 keeps that kind of work outside a transaction anyway. It is
   * idempotent, so every write after the first is a single read.
   */
  const ensureSamlKey = async (tenantId: string, primaryDomain: string | null) => {
    const identity = tenantProtocolIdentity({ primaryDomain }, options.publicUrl);
    await ensureActiveKey(tenantId, provider, 'saml', { commonName: identity.acsHost });
  };

  const claimParams = z.object({ id: z.string().uuid(), claimId: z.string().uuid() });

  const requireApplication = async (
    request: FastifyRequest,
    id: string,
    type: 'saml' | 'oidc',
  ) => {
    const application = await request.db((tx) => findApplication(tx, id));
    if (!application) throw new ProblemError(404, 'not-found', 'No such application');
    if (application.type !== type) {
      throw new ProblemError(
        409,
        'wrong-application-type',
        `That application is not ${type === 'saml' ? 'a SAML' : 'an OIDC'} application`,
      );
    }
    return application;
  };

  /**
   * Refuses an entity ID another application in this tenant already holds.
   *
   * `(tenantId, spEntityId)` is unique in the database, which is what actually
   * guarantees `findSamlConfigByEntityId` resolves one row. This is the
   * readable half: without it the administrator gets whatever a unique
   * violation looks like from three layers down, and the thing they need to
   * know -- which application already has it -- is nowhere in it.
   */
  const refuseTakenEntityId = async (
    request: FastifyRequest,
    applicationId: string,
    spEntityId: string,
  ) => {
    const clash = await request.db((tx) => findSamlConfigByEntityId(tx, spEntityId));
    if (!clash || clash.applicationId === applicationId) return;
    const owner = await request.db((tx) => findApplication(tx, clash.applicationId));
    throw new ProblemError(
      409,
      'saml-entity-id-taken',
      'That service provider entity ID is already registered',
      `The application "${owner?.name ?? clash.applicationId}" is registered for ` +
        `${spEntityId}. An entity ID identifies one service provider, and an ` +
        `AuthnRequest carrying it has to resolve to exactly one configuration.`,
      {
        spEntityId,
        applicationId: clash.applicationId,
        application: owner?.name ?? null,
      },
    );
  };

  app.put('/applications/:id/saml', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = samlConfigRequest.parse(request.body);

    await requireApplication(request, id, 'saml');
    await refuseTakenEntityId(request, id, body.spEntityId);

    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    await ensureSamlKey(request.tenantId, tenant.primaryDomain);

    return request.db(async (tx) => {
      const saved = await upsertSamlConfig(tx, id, body);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.saml_configured',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        // The allowlist is the security-relevant field, so it goes in the
        // log: a widened ACS list is the change a reviewer needs to see, and
        // so is a service provider that stopped having to sign its requests.
        payload: {
          spEntityId: body.spEntityId,
          acsUrls: body.acsUrls,
          wantAuthnRequestsSigned: body.wantAuthnRequestsSigned,
          allowIdpInitiated: body.allowIdpInitiated,
          wsFedEnabled: body.wsFedEnabled,
        },
      });
      return saved;
    });
  });

  app.get('/applications/:id/saml', read, async (request) => {
    const { id } = idParam.parse(request.params);
    const record = await request.db((tx) => findSamlConfigForApplication(tx, id));
    if (!record) throw new ProblemError(404, 'not-found', 'Not configured');
    return record;
  });

  app.post('/applications/:id/saml/import', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = spMetadataImportRequest.parse(request.body);

    await requireApplication(request, id, 'saml');

    // A fetch, so it happens before any transaction opens, and it goes
    // through the outbound guard: the URL came from whoever is holding an
    // administrative session, and this endpoint hands the response back.
    // `fetchExternalDocument` checks every resolved address and then pins the
    // connection to the one it checked, so the name cannot answer differently
    // for the connection than it did for the check.
    const xml =
      'xml' in body
        ? body.xml
        : await fetchExternalDocument(body.url, {
            allowPrivateAddresses: options.outboundAllowPrivate,
          }).catch((cause: unknown) => {
            throw new ProblemError(
              502,
              'metadata-fetch-failed',
              'That metadata address could not be read',
              cause instanceof Error ? cause.message : undefined,
            );
          });

    let parsed;
    try {
      parsed = parseSpMetadata(xml);
    } catch (cause) {
      throw new ProblemError(
        400,
        'metadata-unreadable',
        'That is not a service provider metadata document this can read',
        cause instanceof Error ? cause.message : undefined,
      );
    }

    // Read the row first. An import is a partial update — a metadata document
    // describes what the service provider *is*, and says nothing about the
    // decisions a tenant made about it — and `upsertSamlConfig` writes every
    // column. Without this read, re-importing metadata would silently turn
    // identity-provider-initiated sign-in back off, reset the assertion
    // lifetime, drop the NameID claim and undo a deliberate signing posture.
    const existing = await request.db((tx) => findSamlConfigForApplication(tx, id));

    const wantSigned =
      body.wantAuthnRequestsSigned ??
      existing?.wantAuthnRequestsSigned ??
      REQUIRE_SIGNED_AUTHN_REQUESTS_BY_DEFAULT;

    if (wantSigned && parsed.certificates.length === 0) {
      // Ruling A2-10, at the one place the fix is actionable. The alternative
      // — writing `false` because the document happened to carry no signing
      // certificate — is a tenant inheriting a weaker posture from a file
      // somebody was talked into uploading, which is what that ruling exists
      // to prevent.
      throw new ProblemError(
        409,
        'metadata-has-no-signing-certificate',
        'That metadata publishes no signing certificate',
        'This application requires signed authentication requests, and there is nothing to check a signature against. Send wantAuthnRequestsSigned: false with the import if this service provider does not sign its requests.',
      );
    }

    const input: SamlConfigInput = {
      spEntityId: parsed.entityId,
      acsUrls: parsed.acsUrls,
      defaultAcsUrl: parsed.defaultAcsUrl,
      acsBinding: existing?.acsBinding ?? 'HTTP-POST',
      nameIdFormat:
        parsed.nameIdFormats[0] ??
        existing?.nameIdFormat ??
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      nameIdClaim: existing?.nameIdClaim ?? null,
      spCertificates: parsed.certificates,
      wantAuthnRequestsSigned: wantSigned,
      // The SP's own encryption certificate is published in the same
      // document, so an import may start encrypting for a tenant that asked
      // for it — but it never starts encrypting for one that did not.
      encryptAssertions: existing?.encryptAssertions ?? false,
      encryptionCertificate:
        parsed.encryptionCertificates[0] ?? existing?.encryptionCertificate ?? null,
      sloUrl: parsed.sloUrl,
      sloBinding: existing?.sloBinding ?? 'HTTP-POST',
      allowIdpInitiated: existing?.allowIdpInitiated ?? false,
      wsFedEnabled: existing?.wsFedEnabled ?? false,
      assertionLifetimeMs: existing?.assertionLifetimeMs ?? 300_000,
    };

    if (input.encryptAssertions && input.encryptionCertificate === null) {
      throw new ProblemError(
        409,
        'metadata-has-no-encryption-certificate',
        'That metadata publishes no encryption certificate',
        'This application encrypts its assertions and the imported document leaves nothing to encrypt to.',
      );
    }

    await refuseTakenEntityId(request, id, input.spEntityId);

    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    await ensureSamlKey(request.tenantId, tenant.primaryDomain);

    return request.db(async (tx) => {
      const saved = await upsertSamlConfig(tx, id, input);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.saml_metadata_imported',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          spEntityId: parsed.entityId,
          acsUrls: parsed.acsUrls,
          source: 'xml' in body ? 'upload' : body.url,
          wantAuthnRequestsSigned: wantSigned,
        },
      });
      return saved;
    });
  });

  app.put('/applications/:id/oidc', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = oidcClientRequest.parse(request.body);

    await requireApplication(request, id, 'oidc');

    const result = await request.db(async (tx) => {
      const saved = await upsertOidcClient(tx, id, body);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.oidc_configured',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          clientId: body.clientId,
          redirectUris: body.redirectUris,
          secretRotated: saved.clientSecret !== null,
          // The one grant with no `authorize()` decision behind it. Turning
          // it on is the line in this log a reviewer is looking for.
          clientCredentialsEnabled: body.clientCredentialsEnabled,
          scopes: body.scopes,
        },
      });
      return saved;
    });

    // The Provider loaded this tenant's clients once, at construction. Without
    // this the new redirect URI is invisible until the process restarts.
    invalidateProvider(request.tenantId);

    // The secret is in this response and in no other, ever.
    return { ...result.record, clientSecret: result.clientSecret };
  });

  app.get('/applications/:id/oidc', read, async (request) => {
    const { id } = idParam.parse(request.params);
    const row = await request.db((tx) =>
      tx.oidcClient.findUnique({ where: { applicationId: id } }),
    );
    if (!row) throw new ProblemError(404, 'not-found', 'Not configured');
    // The hash never leaves the server either. It is not a secret, but it is
    // one offline guess away from being one for a client that chose its own.
    const { clientSecretHash: _hidden, ...rest } = row;
    return rest;
  });

  /**
   * Reusable claim mapping sets.
   *
   * A tenant-level template rather than something hanging off an application:
   * the whole point is that many applications receive the same four claims,
   * and a set owned by one of them would be a set the others could not see.
   */
  app.get('/claim-sets', read, async (request) => ({
    sets: await request.db((tx) => listClaimMappingSets(tx)),
  }));

  app.post('/claim-sets', manage, async (request, reply) => {
    const body = claimMappingSetRequest.parse(request.body);
    const created = await request.db((tx) => createClaimMappingSet(tx, body as never));
    return reply.status(201).send(created);
  });

  app.delete('/claim-sets/:id', manage, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    // The applications keep what was stamped onto them. Deleting a template is
    // not a decision about the integrations built from it.
    await request.db((tx) => deleteClaimMappingSet(tx, id));
    return reply.status(204).send();
  });

  /**
   * Stamps a set onto one application.
   *
   * Answers with what it ADDED and what was already there. "Applied" with no
   * numbers is indistinguishable from "did nothing", and doing nothing is the
   * ordinary outcome of applying a set twice.
   */
  app.post('/applications/:id/claims/apply-set', manage, async (request) => {
    const { id } = idParam.parse(request.params);
    const { setId } = z.object({ setId: z.string().uuid() }).parse(request.body);

    return request
      .db((tx) => applyClaimMappingSet(tx, id, setId))
      .catch((cause: unknown) => {
        if (cause instanceof ClaimMappingSetProtocolMismatchError) {
          // 409, and the message names both protocols. A SAML set on an OIDC
          // application would write rows that protocol's builder never reads.
          throw new ProblemError(
            409,
            'protocol-mismatch',
            'That set is for a different protocol',
            cause.message,
          );
        }
        throw cause;
      });
  });

  app.get('/applications/:id/claims', read, async (request) => {
    const { id } = idParam.parse(request.params);
    return request.db(async (tx) => ({
      saml: await listClaimMappings(tx, id, 'saml'),
      oidc: await listClaimMappings(tx, id, 'oidc'),
    }));
  });

  app.post('/applications/:id/claims', manage, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = claimMappingRequest.parse(request.body);

    const application = await request.db((tx) => findApplication(tx, id));
    if (!application) throw new ProblemError(404, 'not-found', 'No such application');

    const created = await request.db(async (tx) => {
      const mapping = await createClaimMapping(tx, id, body);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.claim_mapping_changed',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          change: 'added',
          protocol: body.protocol,
          claimName: body.claimName,
          sourceKind: body.sourceKind,
        },
      });
      return mapping;
    });
    return reply.status(201).send(created);
  });

  app.delete('/applications/:id/claims/:claimId', manage, async (request, reply) => {
    const { id, claimId } = claimParams.parse(request.params);

    await request.db(async (tx) => {
      await deleteClaimMapping(tx, claimId);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'access.claim_mapping_changed',
        targetType: 'Application',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { change: 'removed', claimMappingId: claimId },
      });
    });
    return reply.status(204).send();
  });
}
