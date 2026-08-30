import type { FastifyInstance } from 'fastify';
import { SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA } from '@syntra/core';
import { SCIM_MAX_RESULTS, scimBaseUrl } from './index.js';

/**
 * What this server supports, and what it deliberately does not.
 *
 * NOT optional politeness. Entra reads `ServiceProviderConfig` before it will
 * provision at all, and a target that 404s here fails setup with a message
 * naming nothing useful — an integrator then spends an afternoon on a
 * credential that was never the problem.
 *
 * Every `supported: false` here is a decision recorded in the design document
 * rather than something unfinished, and `documentationUri` is where a client's
 * administrator can read why.
 */
export async function registerScimDiscovery(app: FastifyInstance): Promise<void> {
  app.get('/ServiceProviderConfig', async (request, reply) => {
    const base = scimBaseUrl(request);
    return reply.type('application/scim+json').send({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://github.com/ssan9876/syntra/blob/main/docs/configure.md',
      patch: { supported: true },
      // No mainstream provisioning flow uses bulk, and it is a second
      // request-shaping surface with its own failure modes.
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
      /**
       * FALSE, and this is the one a client most needs to read.
       *
       * A `password` in a payload is accepted and ignored. Syntra's password
       * rules -- the tenant floor, ageing, renewal, upstream write-back -- live
       * in `authorize()` and the password services, and a provisioning
       * protocol is not the place to route around them.
       */
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description:
            'A Syntra machine token, issued against a service account holding directory.write. Note that DELETE deactivates an account rather than removing it: this directory keeps the record of who had what and why it changed.',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
    });
  });

  app.get('/ResourceTypes', async (request, reply) => {
    const base = scimBaseUrl(request);
    const types = [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        description: 'An account. Owned by the SCIM source that pushed it.',
        schema: SCIM_USER_SCHEMA,
        meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        description: 'A group and its members.',
        schema: SCIM_GROUP_SCHEMA,
        meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
      },
    ];
    return reply.type('application/scim+json').send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: types.length,
      itemsPerPage: types.length,
      startIndex: 1,
      Resources: types,
    });
  });

  /**
   * The attributes actually honoured, and no more.
   *
   * Publishing the full core schema would advertise `title`, `addresses`,
   * `phoneNumbers` and a dozen others this server drops on the floor, and a
   * client mapping to them would believe it had provisioned data that went
   * nowhere.
   */
  app.get('/Schemas', async (request, reply) => {
    const base = scimBaseUrl(request);
    const attribute = (
      name: string,
      type: string,
      description: string,
      extra: Record<string, unknown> = {},
    ) => ({
      name,
      type,
      multiValued: false,
      description,
      required: false,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'none',
      ...extra,
    });

    const schemas = [
      {
        id: SCIM_USER_SCHEMA,
        name: 'User',
        description: 'An account in Syntra.',
        attributes: [
          attribute('userName', 'string', 'The login.', {
            required: true,
            uniqueness: 'server',
          }),
          attribute('externalId', 'string', 'Stored as the source anchor, and correlated on.'),
          attribute('displayName', 'string', 'Shown in the console.'),
          attribute('active', 'boolean', 'False deactivates the account.'),
          attribute('emails', 'complex', 'The primary address is kept.', {
            multiValued: true,
          }),
          attribute('name', 'complex', 'A Person is linked when both names are present.'),
        ],
        meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM_USER_SCHEMA}` },
      },
      {
        id: SCIM_GROUP_SCHEMA,
        name: 'Group',
        description: 'A group in Syntra.',
        attributes: [
          attribute('displayName', 'string', 'The group name.', { required: true }),
          attribute('externalId', 'string', 'Stored as the source anchor.'),
          attribute('members', 'complex', 'User ids.', { multiValued: true }),
        ],
        meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCIM_GROUP_SCHEMA}` },
      },
    ];

    return reply.type('application/scim+json').send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: schemas.length,
      itemsPerPage: schemas.length,
      startIndex: 1,
      Resources: schemas,
    });
  });
}
