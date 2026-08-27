import type { FastifyInstance } from 'fastify';
import {
  assignApplicationRequest,
  assignmentParams,
  catalogCreateRequest,
  catalogCreateResponse,
  createApplicationRequest,
  idParam,
  updateApplicationRequest,
} from '@syntra/contracts';
import {
  CatalogVariableMissingError,
  EntityIdTakenError,
  PERMISSIONS,
  UnknownCatalogEntryError,
  assignApplication,
  catalogEntry,
  createApplication,
  createFromCatalog,
  ensureActiveKey,
  findApplication,
  localMasterKeyProvider,
  listCatalog,
  listApplications,
  listAssignments,
  recordEvent,
  unassignApplication,
  updateApplication,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';
import { tenantProtocolIdentity } from '../protocol-identity.js';

/**
 * Drops explicit `undefined` values from a parsed partial request body.
 *
 * `updateApplicationRequest` is `createApplicationRequest.partial()`, so zod
 * infers `name` as `string | undefined` even though the service's
 * `Partial<CreateApplicationInput>` declares it as an omittable `string` —
 * `exactOptionalPropertyTypes` treats "present and undefined" as a different
 * thing from "absent", and only the latter satisfies the service's type. The
 * omission is also the right runtime behaviour: an update body that did not
 * mention a field must leave it alone, not overwrite it with undefined.
 */
function withoutUndefined<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export interface AdminApplicationRouteOptions {
  /** Unseals the tenant's SAML signing key. See the catalog route below. */
  masterKey: Buffer;
  publicUrl: string;
}

export async function registerAdminApplicationRoutes(
  app: FastifyInstance,
  options: AdminApplicationRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);

  app.get(
    '/applications',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => ({
      applications: await request.db((tx) => listApplications(tx)),
    }),
  );

  /**
   * The catalog: which applications Syntra knows how to configure.
   *
   * `ACCESS_READ`, and a constant — identical for every tenant, carrying no
   * credential and no tenant data. It is served rather than bundled into the
   * console so that the list the form offers and the list the service accepts
   * are the same list.
   *
   * The console offers SP metadata import FIRST, where the service provider
   * publishes any: that is exact, carries the certificates and cannot go
   * stale. This is for the many SaaS applications that publish none.
   */
  app.get(
    '/catalog',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async () => ({ entries: listCatalog() }),
  );

  app.post(
    '/applications/from-catalog',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const body = catalogCreateRequest.parse(request.body);

      // The SIGNING KEY, before the transaction, exactly as
      // `registerAdminProtocolRoutes` does for `PUT /applications/:id/saml`.
      //
      // Writing a `SamlConfig` is the moment a tenant commits to being an
      // identity provider. `createFromCatalog` calls the bare
      // `upsertSamlConfig` because it runs inside one transaction and RSA-2048
      // generation has no business in Prisma's 5000 ms budget — so the seam
      // `saveSamlConfig` provides has to be honoured here instead. Without it a
      // tenant whose FIRST SAML application comes from the catalog has no key,
      // and every sign-in dead-ends at 409 `saml-no-key` with nothing
      // self-healing it. `ensureActiveKey` is idempotent, so every call after
      // the first is a single read.
      //
      // Only for a SAML entry: a tenant that registers only OIDC clients has
      // no business holding a SAML key, and the OIDC provider establishes its
      // own at request time (`oidc-op.ts`).
      // Resolved HERE, with its own refusal, because this lookup now happens
      // BEFORE `createFromCatalog` and therefore before the `.catch` below
      // that maps its errors. Left unmapped, an unknown key threw out of the
      // route as a 500 — the 404 the service raises by name never reached the
      // handler that turns it into one.
      const entry = (() => {
        try {
          return catalogEntry(body.key);
        } catch (cause) {
          if (cause instanceof UnknownCatalogEntryError) {
            throw new ProblemError(
              404,
              'unknown-catalog-entry',
              'No such application',
              cause.message,
            );
          }
          throw cause;
        }
      })();

      if (entry.saml) {
        const tenant = await request.db((tx) =>
          tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
        );
        const identity = tenantProtocolIdentity(
          { primaryDomain: tenant.primaryDomain },
          options.publicUrl,
        );
        await ensureActiveKey(request.tenantId, provider, 'saml', {
          commonName: identity.acsHost,
        });
      }

      const created = await request
        .db((tx) => createFromCatalog(tx, body))
        .catch((cause: unknown) => {
          // Three named refusals, each of which the form can act on. Anything
          // else is a fault and goes up to the problem-json handler as a 500 —
          // catching everything is how a lost connection comes to read as a
          // duplicate entity ID.
          if (cause instanceof UnknownCatalogEntryError) {
            throw new ProblemError(404, 'unknown-catalog-entry', 'No such application', cause.message);
          }
          if (cause instanceof CatalogVariableMissingError) {
            throw new ProblemError(
              400,
              'missing-value',
              'That application needs another value',
              cause.message,
            );
          }
          if (cause instanceof EntityIdTakenError) {
            // 409, and the message names the application already holding it
            // and what to do about it.
            throw new ProblemError(409, 'entity-id-taken', 'Already registered', cause.message);
          }
          throw cause;
        });

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'access.application_created',
          targetType: 'Application',
          targetId: created.applicationId,
          outcome: 'success',
          sourceIp: request.ip,
          // The entry it came from, so the trail says this was a catalog
          // registration rather than a hand-built one. Never the secret.
          payload: { catalogKey: body.key, slug: created.slug, protocol: created.protocol },
        }),
      );

      return reply.status(201).send(catalogCreateResponse.parse(created));
    },
  );

  app.post(
    '/applications',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const body = createApplicationRequest.parse(request.body);

      const created = await request.db(async (tx) => {
        let application;
        try {
          application = await createApplication(tx, body);
        } catch (error) {
          // Only the conflict the service raises by name. Catching everything
          // told an administrator that a lost connection or a constraint they
          // have never heard of was their own duplicate slug — and echoed the
          // driver's message into `detail` to prove it. A fault is a fault:
          // it goes up, and the problem-json handler answers 500.
          if (error instanceof Error && /slug already exists/i.test(error.message)) {
            throw new ProblemError(
              409,
              'slug-taken',
              'That slug is already used',
              error.message,
            );
          }
          throw error;
        }
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.create',
          targetType: 'Application',
          targetId: application.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: application.slug, name: application.name },
        });
        return application;
      });

      return reply.status(201).send(created);
    },
  );

  app.put(
    '/applications/:id',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = updateApplicationRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await findApplication(tx, id);
        if (!existing) throw new ProblemError(404, 'not-found', 'Application not found');

        const updated = await updateApplication(tx, id, withoutUndefined(body));
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.update',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: updated.slug, status: updated.status },
        });
        return updated;
      });
    },
  );

  app.get(
    '/applications/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return { assignments: await request.db((tx) => listAssignments(tx, id)) };
    },
  );

  app.post(
    '/applications/:id/assignments',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const subject = assignApplicationRequest.parse(request.body);

      await request.db(async (tx) => {
        const application = await findApplication(tx, id);
        if (!application) throw new ProblemError(404, 'not-found', 'Application not found');

        await assignApplication(tx, id, subject);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.assign',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { subjectType: subject.type, subjectId: subject.id },
        });
      });

      return reply.status(201).send({ ok: true });
    },
  );

  app.delete(
    '/applications/:id/assignments/:assignmentId',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const { id, assignmentId } = assignmentParams.parse(request.params);

      await request.db(async (tx) => {
        await unassignApplication(tx, assignmentId);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'application.unassign',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { assignmentId },
        });
      });

      return reply.status(204).send();
    },
  );
}
