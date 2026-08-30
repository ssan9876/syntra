import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantClient } from '@syntra/db';
import {
  PERMISSIONS,
  ScimError,
  addMember,
  createGroup,
  deactivateGroup,
  interpretPatch,
  parsePagination,
  parseScimFilter,
  recordEvent,
  removeMember,
  toScimGroup,
  toScimList,
} from '@syntra/core';
import { requirePermission } from '../../plugins/require-permission.js';
import { SCIM_MAX_RESULTS, scimBaseUrl } from './index.js';

const groupSelect = {
  id: true,
  name: true,
  status: true,
  sourceAnchor: true,
} as const;

async function scimSourceId(tx: TenantClient): Promise<string> {
  const sources = await tx.directorySource.findMany({
    where: { type: 'scim', enabled: true },
    select: { id: true, name: true },
  });
  if (sources.length === 0) {
    throw new ScimError(409, null, 'No SCIM source is configured.');
  }
  if (sources.length > 1) {
    throw new ScimError(409, null, 'More than one SCIM source is configured.');
  }
  return sources[0]!.id;
}

async function readGroup(tx: TenantClient, id: string) {
  const group = await tx.group.findUnique({ where: { id }, select: groupSelect });
  if (!group) throw new ScimError(404, null, `No group with id ${id}`);
  return group;
}

/** The same ownership rule Users get, for the same reason. */
async function assertOwned(tx: TenantClient, id: string, sourceId: string) {
  const row = await tx.group.findUnique({ where: { id }, select: { sourceId: true } });
  if (!row) throw new ScimError(404, null, `No group with id ${id}`);
  if (row.sourceId !== sourceId) {
    throw new ScimError(
      409,
      'mutability',
      'This group is owned by another source and cannot be changed through SCIM.',
    );
  }
}

async function membersOf(tx: TenantClient, groupId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { groupId },
    select: { user: { select: { id: true, displayName: true } } },
  });
  return rows.map((row) => ({ id: row.user.id, displayName: row.user.displayName }));
}

/**
 * Every id must be a user in this tenant.
 *
 * Checked before any of them is added, so a payload naming one bad id changes
 * nothing rather than half of what it asked for — a partially applied group
 * membership is a state neither side knows it is in.
 */
async function assertUsersExist(tx: TenantClient, ids: string[]) {
  if (ids.length === 0) return;
  const found = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
  if (found.length !== ids.length) {
    const known = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !known.has(id));
    throw new ScimError(400, 'invalidValue', `Not users in this tenant: ${missing.join(', ')}`);
  }
}

async function audit(
  request: FastifyRequest,
  tx: TenantClient,
  action: string,
  targetId: string,
  payload: Record<string, unknown>,
) {
  await recordEvent(tx, {
    actorUserId: request.session.userId,
    action,
    targetType: 'Group',
    targetId,
    outcome: 'success',
    sourceIp: request.ip,
    payload,
  });
}

export async function registerScimGroupRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/Groups',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const filter = parseScimFilter(query.filter, ['displayName', 'externalId']);
      const page = parsePagination(query.startIndex, query.count, SCIM_MAX_RESULTS);

      const where =
        filter === null
          ? {}
          : filter.attribute === 'displayName'
            ? { name: filter.value }
            : { sourceAnchor: filter.value };

      const [total, rows] = await request.db((tx) =>
        Promise.all([
          tx.group.count({ where }),
          tx.group.findMany({ where, select: groupSelect, skip: page.startIndex - 1, take: page.count }),
        ]),
      );

      const base = scimBaseUrl(request);
      const resources = await request.db(async (tx) =>
        Promise.all(rows.map(async (row) => toScimGroup(row, await membersOf(tx, row.id), base))),
      );

      return reply
        .type('application/scim+json')
        .send(toScimList(resources, total, page.startIndex));
    },
  );

  app.get(
    '/Groups/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const base = scimBaseUrl(request);
      const resource = await request.db(async (tx) => {
        const group = await readGroup(tx, id);
        return toScimGroup(group, await membersOf(tx, id), base);
      });
      return reply.type('application/scim+json').send(resource);
    },
  );

  app.post(
    '/Groups',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const displayName =
        typeof body.displayName === 'string' && body.displayName.trim() !== ''
          ? body.displayName.trim()
          : null;
      if (displayName === null) {
        throw new ScimError(400, 'invalidValue', 'displayName is required');
      }
      const externalId = typeof body.externalId === 'string' ? body.externalId : null;
      const memberIds = Array.isArray(body.members)
        ? (body.members as Record<string, unknown>[])
            .map((member) => member?.value)
            .filter((value): value is string => typeof value === 'string')
        : [];

      const base = scimBaseUrl(request);
      const resource = await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);

        const clash = await tx.group.findFirst({ where: { name: displayName } });
        if (clash) {
          throw new ScimError(
            409,
            'uniqueness',
            `A group named '${displayName}' already exists.`,
          );
        }

        await assertUsersExist(tx, memberIds);

        const group = await createGroup(tx, displayName);
        await tx.group.update({
          where: { id: group.id },
          data: { sourceId, sourceAnchor: externalId },
        });
        for (const userId of memberIds) await addMember(tx, group.id, userId);

        await audit(request, tx, 'scim.group_created', group.id, {
          displayName,
          members: memberIds.length,
        });

        const row = await readGroup(tx, group.id);
        return toScimGroup(row, await membersOf(tx, group.id), base);
      });

      return reply
        .code(201)
        .header('location', `${base}/Groups/${(resource as { id: string }).id}`)
        .type('application/scim+json')
        .send(resource);
    },
  );

  app.patch(
    '/Groups/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const operations = interpretPatch(request.body);
      const base = scimBaseUrl(request);

      const resource = await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);
        await assertOwned(tx, id, sourceId);

        for (const operation of operations) {
          switch (operation.kind) {
            case 'addMembers':
              await assertUsersExist(tx, operation.ids);
              for (const userId of operation.ids) await addMember(tx, id, userId);
              await audit(request, tx, 'scim.member_added', id, { count: operation.ids.length });
              break;
            case 'removeMembers':
              for (const userId of operation.ids) await removeMember(tx, id, userId);
              await audit(request, tx, 'scim.member_removed', id, {
                count: operation.ids.length,
              });
              break;
            case 'clearMembers': {
              const current = await membersOf(tx, id);
              for (const member of current) await removeMember(tx, id, member.id);
              await audit(request, tx, 'scim.member_removed', id, { count: current.length });
              break;
            }
            case 'setDisplayName':
              await tx.group.update({ where: { id }, data: { name: operation.value } });
              await audit(request, tx, 'scim.group_updated', id, { displayName: true });
              break;
            default:
              throw new ScimError(400, 'invalidPath', 'That operation is not valid on a Group');
          }
        }

        const group = await readGroup(tx, id);
        return toScimGroup(group, await membersOf(tx, id), base);
      });

      return reply.type('application/scim+json').send(resource);
    },
  );

  /**
   * Deactivates, exactly as the User route does.
   *
   * Deactivating a group revokes the access it granted and keeps the record of
   * who was in it, which is what makes reactivation put back exactly what was
   * there. A delete would take the membership history with it.
   */
  app.delete(
    '/Groups/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      await request.db(async (tx) => {
        const sourceId = await scimSourceId(tx);
        await assertOwned(tx, id, sourceId);
        await deactivateGroup(tx, id, 'removed over SCIM');
        await audit(request, tx, 'scim.group_updated', id, { deactivated: true });
      });

      return reply.code(204).send();
    },
  );
}
