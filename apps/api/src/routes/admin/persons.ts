import type { FastifyInstance } from 'fastify';
import {
  contractParams,
  createContractRequest,
  createPersonRequest,
  deactivatePersonRequest,
  idParam,
  importRequest,
  linkUserRequest,
  patchContractRequest,
  patchPersonRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  createContract,
  createPerson,
  deactivatePerson,
  explainPersonAccess,
  importPersons,
  linkUserToPerson,
  listContracts,
  listPersons,
  parsePersonCsv,
  reactivatePerson,
  recordEvent,
  updateContract,
  usersForPerson,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export async function registerAdminPersonRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  /**
   * Deactivates the PERSON and nothing else.
   *
   * Their logins are left alone on purpose. A person and an account are
   * different things — the distinction this product is built on — and
   * cascading would make one button do two jobs while naming only one of them.
   * The accounts are deactivated per account, by whoever owns them.
   *
   * `Person` has no `statusReason` column, so the reason lives on the audit
   * event. That is where "why, and who decided" is looked for anyway.
   */
  app.post(
    '/persons/:id/deactivate',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = deactivatePersonRequest.parse(request.body);
      return request.db(async (tx) => {
        const existing = await tx.person.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Person not found');
        const updated = await deactivatePerson(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.deactivate',
          targetType: 'Person',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            name: `${existing.givenName} ${existing.familyName}`,
            reason,
          },
        });
        return updated;
      });
    },
  );

  app.post(
    '/persons/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const existing = await tx.person.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Person not found');
        const updated = await reactivatePerson(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.reactivate',
          targetType: 'Person',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: `${existing.givenName} ${existing.familyName}` },
        });
        return updated;
      });
    },
  );

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

  /**
   * Why this person holds what they hold, in every target system.
   *
   * `PROVISION_READ` and not `IDENTITY_READ`: somebody who may read the person
   * register is not thereby entitled to see every entitlement that person
   * holds in every target system. It lives here, beside `/persons/:id`,
   * because the person routes are already a plugin under `/api/admin` and
   * there is no `/api/persons` in this application.
   */
  app.get(
    '/persons/:id/access',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const person = await request.db((tx) =>
        tx.person.findUnique({ where: { id }, select: { id: true } }),
      );
      // Otherwise a person who does not exist answers 200 with an empty list,
      // which reads as "this person holds nothing" rather than "no such
      // person" — and those are opposite answers to an auditor.
      if (!person) throw new ProblemError(404, 'not-found', 'Person not found');
      return explainPersonAccess(request.tenantId, id);
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

  /**
   * Correcting a person's record.
   *
   * No source-owned check here, unlike users, groups and org units: a Person
   * has no `sourceId`. People arrive by CSV import, which matches on
   * `externalId` and updates in place, so a later import overwrites an edit
   * to a field the file carries — the import is the authority, not a sync run,
   * and it only runs when somebody uploads one.
   */
  app.patch(
    '/persons/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchPersonRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await tx.person.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'Person not found');

        if (
          body.externalId !== undefined &&
          body.externalId !== null &&
          body.externalId !== existing.externalId
        ) {
          // Unique per tenant, and the key a CSV import matches on: two people
          // sharing one would make the next import update whichever it found
          // first.
          const clash = await tx.person.findFirst({
            where: { externalId: body.externalId },
          });
          if (clash) {
            throw new ProblemError(409, 'conflict', 'Conflict', undefined, {
              errors: [
                {
                  path: 'externalId',
                  message: `another person already has the id ${body.externalId}`,
                },
              ],
            });
          }
        }

        const updated = await tx.person.update({
          where: { id },
          data: {
            ...(body.givenName === undefined ? {} : { givenName: body.givenName }),
            ...(body.familyName === undefined ? {} : { familyName: body.familyName }),
            ...(body.businessEmail === undefined ? {} : { businessEmail: body.businessEmail }),
            ...(body.personalEmail === undefined ? {} : { personalEmail: body.personalEmail }),
            ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
            // `null` clears the assignment and sends this person back to the
            // template; omitted leaves it alone. The two are different
            // requests and Zod keeps them apart.
            ...(body.orgUnitId === undefined ? {} : { orgUnitId: body.orgUnitId }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.update',
          targetType: 'Person',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            from: { givenName: existing.givenName, familyName: existing.familyName },
            to: { givenName: updated.givenName, familyName: updated.familyName },
          },
        });
        return updated;
      });
    },
  );

  /**
   * Correcting a contract, addressed by the sequence its person holds it at.
   *
   * By sequence rather than by contract id because that is how the console
   * reads them: `GET /persons/:id` returns contracts nested under the person,
   * and a row on that screen knows its sequence and never sees a uuid.
   *
   * Promoting to primary DEMOTES the incumbent here, where the create path
   * refuses instead. The two are not inconsistent: adding a contract and
   * declaring it primary while another already is is a caller who has not
   * looked, whereas promoting an existing contract can only mean demoting the
   * one it replaces — refusing would make promotion take two calls and leave
   * the person with no primary contract in between.
   */
  app.patch(
    '/persons/:id/contracts/:sequence',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request) => {
      const { id, sequence } = contractParams.parse(request.params);
      const body = patchContractRequest.parse(request.body);

      return request.db(async (tx) => {
        const person = await tx.person.findUnique({ where: { id } });
        if (!person) throw new ProblemError(404, 'not-found', 'Person not found');

        const before = await tx.contract.findFirst({
          where: { personId: id, sequence },
        });
        const updated = await updateContract(tx, id, sequence, body);
        if (!updated) throw new ProblemError(404, 'not-found', 'Contract not found');

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.updateContract',
          targetType: 'Person',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            sequence,
            from: {
              jobTitle: before?.jobTitle ?? null,
              department: before?.department ?? null,
              isPrimary: before?.isPrimary ?? null,
            },
            to: {
              jobTitle: updated.jobTitle,
              department: updated.department,
              isPrimary: updated.isPrimary,
            },
          },
        });
        return updated;
      });
    },
  );
}
