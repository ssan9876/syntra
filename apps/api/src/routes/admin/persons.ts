import type { FastifyInstance } from 'fastify';
import {
  createContractRequest,
  createPersonRequest,
  idParam,
  importRequest,
  linkUserRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createContract,
  createPerson,
  importPersons,
  linkUserToPerson,
  listContracts,
  listPersons,
  parsePersonCsv,
  recordEvent,
  usersForPerson,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export async function registerAdminPersonRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/persons',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      const persons = await request.db((tx) => listPersons(tx));
      return { persons };
    },
  );

  app.get(
    '/persons/:id',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const person = await tx.person.findUnique({ where: { id } });
        if (!person) {
          throw new ProblemError(404, 'not-found', 'Person not found');
        }
        return {
          ...person,
          contracts: await listContracts(tx, id),
          users: await usersForPerson(tx, id),
        };
      });
    },
  );

  app.post(
    '/persons',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request, reply) => {
      const body = createPersonRequest.parse(request.body);

      const person = await request.db(async (tx) => {
        if (body.externalId) {
          const clash = await tx.person.findFirst({
            where: { externalId: body.externalId },
          });
          if (clash) {
            throw new ProblemError(
              409,
              'conflict',
              'Conflict',
              `external id already exists: ${body.externalId}`,
            );
          }
        }

        const created = await createPerson(tx, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.create',
          targetType: 'Person',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { externalId: created.externalId },
        });
        return created;
      });

      return reply.status(201).send(person);
    },
  );

  app.post(
    '/persons/:id/contracts',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = createContractRequest.parse(request.body);

      const contract = await request.db(async (tx) => {
        const person = await tx.person.findUnique({ where: { id } });
        if (!person) {
          throw new ProblemError(404, 'not-found', 'Person not found');
        }

        const clash = await tx.contract.findFirst({
          where: { personId: id, sequence: body.sequence },
        });
        if (clash) {
          throw new ProblemError(
            409,
            'conflict',
            'Conflict',
            `contract sequence ${body.sequence} already exists for this person`,
          );
        }

        // Surfaced as a conflict rather than a 500: the partial unique index
        // is the authority on "one primary per person", and violating it is a
        // caller mistake, not a server fault.
        if (body.isPrimary) {
          const primary = await tx.contract.findFirst({
            where: { personId: id, isPrimary: true },
          });
          if (primary) {
            throw new ProblemError(
              409,
              'conflict',
              'Conflict',
              'this person already has a primary contract',
            );
          }
        }

        const created = await createContract(tx, id, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'contract.create',
          targetType: 'Contract',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { personId: id, sequence: created.sequence },
        });
        return created;
      });

      return reply.status(201).send(contract);
    },
  );

  app.post(
    '/persons/:id/link-user',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { userId } = linkUserRequest.parse(request.body);

      await request.db(async (tx) => {
        const person = await tx.person.findUnique({ where: { id } });
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!person || !user) {
          throw new ProblemError(404, 'not-found', 'Person or user not found');
        }

        await linkUserToPerson(tx, userId, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.linkUser',
          targetType: 'Person',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { login: user.login },
        });
      });

      return reply.status(204).send();
    },
  );

  app.post(
    '/persons/import',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request, reply) => {
      const { csv } = importRequest.parse(request.body);
      const { rows, errors } = parsePersonCsv(csv);

      // Nothing usable: refuse outright rather than reporting a hollow success.
      if (rows.length === 0) {
        return reply.status(400).type('application/problem+json').send({
          type: 'https://syntra.dev/problems/csv-invalid',
          title: 'CSV could not be imported',
          status: 400,
          errors,
        });
      }

      const result = await request.db(async (tx) => {
        const imported = await importPersons(tx, rows);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.import',
          targetType: 'Person',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { ...imported, rejected: errors.length },
        });
        return imported;
      });

      // Partial success is reported, never hidden: the caller sees both what
      // landed and every line that did not.
      return { ...result, errors };
    },
  );
}
