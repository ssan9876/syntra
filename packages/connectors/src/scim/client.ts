import { guardedFetch } from '../net/guarded-fetch.js';
import type { ResolvedScim2TargetConfig } from './config.js';

export interface ScimResponse {
  status: number;
  json: unknown;
}

/**
 * One authenticated SCIM request. Wire format only — no knowledge here of
 * what a User or a Group means to Provision, matching the split
 * `ldap/connection.ts` makes between "talk to the wire protocol" and
 * "connector.ts decides what to do with it".
 */
export async function scimRequest(
  config: ResolvedScim2TargetConfig & { bearerToken: string },
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<ScimResponse> {
  const fetcher = guardedFetch({
    allowPrivateAddresses: config.allowPrivateAddresses,
    timeoutMs: config.timeoutMs,
  });
  const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetcher(url, {
    method,
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      accept: 'application/scim+json',
      ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : JSON.parse(text) };
}
