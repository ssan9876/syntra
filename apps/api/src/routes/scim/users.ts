import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantClient } from '@syntra/db';
import { Prisma } from '@syntra/db';
import {
  PERMISSIONS,
  ScimError,
  createPerson,
  matchPersonForAccount,
  createUser,
  deactivateUser,
  interpretPatch,
  parsePagination,
  parseScimFilter,
  parseScimUser,
  recordEvent,
  toScimList,
  toScimUser,
  type ScimUserInput,
} from '@syntra/core';
import { requirePermission } from '../../plugins/require-permission.js';
import { SCIM_MAX_RESULTS, scimBaseUrl } from './index.js';

/**
 * The source that owns what this client pushes.
 *
 * Looked up rather than carried on the token, because ownership is a property
 * of the DIRECTORY and not of the credential — two tokens for the same
 * integration must write the same ownership, and a token reissued after a
 * rotation must not orphan what the previous one created.
 *
 * Several SCIM sources is a REFUSAL rather than a guess. Guessing writes an
 * ownership somebody then has to unpick, one account at a time, and the person
 * doing the unpicking will not be the person who guessed.
 */
async function scimSourceId(tx: TenantClient): Promise<string> {
  const sources = await tx.directorySource.findMany({
    where: { type: 'scim', enabled: true },
    select: { id: true, name: true },
  });

  if (sources.length === 0) {
    throw new ScimError(
      409,
      null,
      'No SCIM source is configured. Create one in the console before provisioning.',
    );
  }
  if (sources.length > 1) {
    throw new ScimError(
      409,
      null,
      `More than one SCIM source is configured (${sources
        .map((source) => source.name)
        .join(', ')}), so the owner of this write is ambiguous.`,
    );
  }
  return sources[0]!.id;
}

const scimUserSelect = {
  id: true,
  login: true,
  email: true,
  displayName: true,
  status: true,
  sourceAnchor: true,
  createdAt: true,
} as const;

/** The account, or a SCIM 404. Scoped to what this source owns for writes. */
async function readUser(tx: TenantClient, id: string) {
  const user = await tx.user.findUnique({ where: { id }, select: scimUserSelect });
  if (!user) throw new ScimError(404, null, `No user with id ${id}`);
  return user;
}

/**
 * Refuses a write to an account this source does not own.
 *
 * A SCIM client must not take over an account LDAP anchored, and must not edit
 * one an administrator created by hand. The account belongs to the system that
 * anchored it, and a takeover is how two writers begin overwriting each other
 * nightly with neither being wrong.
 */
async function assertOwned(tx: TenantClient, id: string, sourceId: string) {
  const row = await tx.user.findUnique({ where: { id }, select: { sourceId: true } });
  if (!row) throw new ScimError(404, null, `No user with id ${id}`);
  if (row.sourceId !== sourceId) {
    throw new ScimError(
      409,
      'mutability',
      'This account is owned by another source and cannot be changed through SCIM.',
    );
  }
}

/** Case-insensitively, matching the index and `createUser`'s own check. */
async function findByLogin(tx: TenantClient, login: string) {
  return tx.user.findFirst({
    where: { login: { equals: login, mode: 'insensitive' } },
    select: { id: true, sourceId: true },
  });
}

async function audit(
  request: FastifyRequest,
  tx: TenantClient,
  action: string,
  targetId: string,
  payload: Record<string, unknown>,
) {
  await recordEvent(tx, {
    // The service account the token acts as. A SCIM write is an act by a
    // machine somebody configured, and the audit log should name it.
    actorUserId: request.session.userId,
    action,
    targetType: 'User',
    targetId,
    outcome: 'success',
    sourceIp: request.ip,
    payload,
  });
}

export async function registerScimUserRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/Users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const filter = parseScimFilter(query.filter, ['userName', 'externalId']);
      const page = parsePagination(query.startIndex, query.count, SCIM_MAX_RESULTS);

      const where =
        filter === null
          ? {}
          : filter.attribute === 'userName'
            ? { login: { equals: filter.value, mode: 'insensitive' as const } }
            : { sourceAnchor: filter.value };

      const [total, rows] = await request.db((tx) =>
        Promise.all([
          tx.user.count({ where }),
          tx.user.findMany({
            where,
            select: scimUserSelect,
            // A total order. `createdAt` alone is not unique -- accounts
            // bulk-imported in one transaction share a timestamp -- and rows
            // that tie straddle a page boundary in whichever order the plan
            // happened to produce, so a client walking the pages sees one
            // twice and never sees another.
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            skip: page.startIndex - 1,
            take: page.count,
          }),
        ]),
      );

      const base = scimBaseUrl(request);
      return reply
        .type('application/scim+json')
        .send(toScimList(rows.map((row) => toScimUser(row, base)), total, page.startIndex));
    },
  );

  app.get(
    '/Users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = await request.db((tx) => readUser(tx, id));
      return reply.type('application/scim+json').send(toScimUser(user, scimBaseUrl(request)));
    },
  );

  app.post(
    '/Users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const input = parseScimUser(request.body);

      const created = await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);

        // Against ANY source, not just this one. A userName that already
        // belongs to an LDAP-anchored account is a uniqueness conflict, not an
        // opportunity to take it over.
        const existing = await findByLogin(tx, input.userName);
        if (existing) {
          throw new ScimError(
            409,
            'uniqueness',
            `A user with userName '${input.userName}' already exists.`,
          );
        }

        // The anchor is unique per source, so a second push of one externalId
        // under a different login is a duplicate the database would refuse
        // with a P2002 -- an error carrying no status, which the SCIM error
        // handler can only report as 500. A client retries a 500 forever and
        // stops on a 409, so the check is made here, in the same idiom as the
        // userName clash above, rather than left to the index.
        if (input.externalId !== null) {
          const anchored = await tx.user.findFirst({
            where: { sourceId, sourceAnchor: input.externalId },
            select: { id: true },
          });
          if (anchored) {
            throw new ScimError(
              409,
              'uniqueness',
              `A user with externalId '${input.externalId}' already exists.`,
            );
          }
        }

        const personId = await linkedPersonId(tx, input);

        const user = await createUser(tx, {
          login: input.userName,
          email: input.email ?? '',
          displayName: input.displayName,
        });

        // Ownership, the anchor and the person link in one update.
        // `createUser` takes none of them -- it is the directory's own
        // constructor and knows nothing about sources -- so they are applied
        // here rather than by widening its input for one caller.
        const owned = await tx.user.update({
          where: { id: user.id },
          data: {
            sourceId,
            sourceAnchor: input.externalId,
            ...(personId === null ? {} : { personId }),
            ...(input.active ? {} : { status: 'inactive', statusReason: 'created inactive' }),
          },
          select: scimUserSelect,
        });

        await audit(request, tx, 'scim.user_created', user.id, {
          userName: input.userName,
          externalId: input.externalId,
          personLinked: personId !== null,
        });

        return owned;
      });

      const base = scimBaseUrl(request);
      return reply
        .code(201)
        .header('location', `${base}/Users/${created.id}`)
        .type('application/scim+json')
        .send(toScimUser(created, base));
    },
  );

  app.put(
    '/Users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = parseScimUser(request.body);

      const updated = await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);
        await assertOwned(tx, id, sourceId);

        const clash = await findByLogin(tx, input.userName);
        if (clash && clash.id !== id) {
          throw new ScimError(
            409,
            'uniqueness',
            `A user with userName '${input.userName}' already exists.`,
          );
        }

        // Deactivation goes through the directory's own path, never a status
        // column written here: that path revokes sessions and refresh tokens
        // and tells the relying parties, which is what makes an offboarding
        // take effect rather than merely be recorded.
        const before = await readUser(tx, id);
        if (before.status === 'active' && !input.active) {
          await deactivateUser(tx, id, 'deactivated over SCIM');
        }

        const row = await tx.user.update({
          where: { id },
          data: {
            login: input.userName,
            email: input.email ?? '',
            displayName: input.displayName,
            // Only when the payload carries one. A full replace that omits
            // externalId -- which some Okta profile mappings do -- would
            // otherwise null the anchor the IdP finds this account by again,
            // silently: NULLs are distinct to the unique index, so nothing
            // errors, the next filter finds nothing, and the IdP concludes the
            // account is gone and POSTs a replacement.
            ...(input.externalId === null ? {} : { sourceAnchor: input.externalId }),
            ...(input.active && before.status !== 'active'
              ? { status: 'active', statusReason: null }
              : {}),
          },
          select: scimUserSelect,
        });

        await audit(request, tx, 'scim.user_updated', id, { userName: input.userName });
        return row;
      });

      return reply.type('application/scim+json').send(toScimUser(updated, scimBaseUrl(request)));
    },
  );

  app.patch(
    '/Users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const operations = interpretPatch(request.body);

      const updated = await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);
        await assertOwned(tx, id, sourceId);

        for (const operation of operations) {
          switch (operation.kind) {
            case 'setActive': {
              const before = await readUser(tx, id);
              if (!operation.value && before.status === 'active') {
                // The directory's own deactivation, for the reason above.
                await deactivateUser(tx, id, 'deactivated over SCIM');
                await audit(request, tx, 'scim.user_deactivated', id, {});
              } else if (operation.value && before.status !== 'active') {
                await tx.user.update({
                  where: { id },
                  data: { status: 'active', statusReason: null },
                });
                await audit(request, tx, 'scim.user_updated', id, { active: true });
              }
              break;
            }
            case 'setUserName': {
              const clash = await findByLogin(tx, operation.value);
              if (clash && clash.id !== id) {
                throw new ScimError(
                  409,
                  'uniqueness',
                  `A user with userName '${operation.value}' already exists.`,
                );
              }
              await tx.user.update({ where: { id }, data: { login: operation.value } });
              await audit(request, tx, 'scim.user_updated', id, { userName: operation.value });
              break;
            }
            case 'setDisplayName':
              await tx.user.update({ where: { id }, data: { displayName: operation.value } });
              await audit(request, tx, 'scim.user_updated', id, { displayName: true });
              break;
            case 'setEmail':
              await tx.user.update({ where: { id }, data: { email: operation.value } });
              await audit(request, tx, 'scim.user_updated', id, { email: true });
              break;
            default:
              // Member operations belong to Groups. Reaching here means the
              // interpreter accepted something this route cannot perform, and
              // a silent success is the failure mode the interpreter exists to
              // prevent.
              throw new ScimError(400, 'invalidPath', 'That operation is not valid on a User');
          }
        }

        return readUser(tx, id);
      });

      return reply.type('application/scim+json').send(toScimUser(updated, scimBaseUrl(request)));
    },
  );

  /**
   * DELETE DEACTIVATES.
   *
   * SCIM says remove; this directory has no Delete anywhere, because
   * deactivation "revokes real access, grants nothing, and keeps the trail of
   * who had what and why it changed". Implementing a real delete for SCIM only
   * would hand an integration a capability deliberately denied to
   * administrators, reachable by whoever holds a machine token.
   *
   * The client gets its 204 and the account stops working immediately, which
   * is what it asked for in every way that matters to it.
   * `ServiceProviderConfig` says so, so a client can learn this before it
   * matters rather than during an audit.
   */
  app.delete(
    '/Users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);
        await assertOwned(tx, id, sourceId);
        await deactivateUser(tx, id, 'removed over SCIM');
        await audit(request, tx, 'scim.user_deactivated', id, { via: 'DELETE' });
      });

      return reply.code(204).send();
    },
  );
}

/**
 * A Person, but only when the payload carries enough to be one.
 *
 * An IdP frequently knows a login and an address and nothing else. Inventing a
 * Person from that fills the register with half-records that no HR feed will
 * ever reconcile against — and the register is what Provision, Govern and the
 * whole joiner-mover-leaver story read. An account with no Person behind it is
 * already a thing this product represents deliberately.
 */
async function linkedPersonId(
  tx: TenantClient,
  input: ScimUserInput,
): Promise<string | null> {
  if (input.givenName === null || input.familyName === null) return null;

  // FIND BEFORE CREATING, and by the strongest key first. The normal
  // deployment has an HR feed that already registered this human under the
  // employee id the IdP is now sending as externalId; creating regardless
  // either collides on `@@unique([tenantId, externalId])` -- a P2002 the SCIM
  // error handler can only report as 500, which a client retries forever --
  // or, where the ids differ, quietly forks the register into two records for
  // one person, which is the half-record this function's docstring exists to
  // prevent, arriving by another door.
  if (input.externalId !== null) {
    const byExternalId = await tx.person.findFirst({
      where: { externalId: input.externalId },
      select: { id: true },
    });
    if (byExternalId) return byExternalId.id;
  }

  // Then the same matcher the console's link-an-account screen uses, under
  // the same two rules the admin create path applies (see the
  // `hasActiveAccount` branch in routes/admin/users.ts). Only a CONFIDENT
  // verdict is acted on: a candidate list is something a person chooses from,
  // and there is nobody at the other end of a SCIM push. And a confident
  // match who already signs in somewhere is demoted, because linking there
  // silently produces the second account the console warns about, without the
  // warning.
  if (input.email !== null) {
    const match = await matchPersonForAccount(tx, {
      email: input.email,
      displayName: `${input.givenName} ${input.familyName}`,
    });
    if (match.confident && !match.confident.hasActiveAccount) {
      return match.confident.personId;
    }
  }

  return createdPersonId(tx, input);
}

/**
 * The create, with the unique index turned into the answer it deserves.
 *
 * Two pushes racing on one externalId is a client's duplicate, not a server
 * fault, and 409 is the code a provisioning client knows how to stop on.
 */
async function createdPersonId(
  tx: TenantClient,
  input: ScimUserInput,
): Promise<string> {
  try {
    const person = await createPerson(tx, {
      givenName: input.givenName!,
      familyName: input.familyName!,
      ...(input.email === null ? {} : { businessEmail: input.email }),
      ...(input.externalId === null ? {} : { externalId: input.externalId }),
    });
    return person.id;
  } catch (cause) {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === 'P2002'
    ) {
      throw new ScimError(
        409,
        'uniqueness',
        `A person with externalId '${input.externalId}' already exists.`,
      );
    }
    throw cause;
  }
}
