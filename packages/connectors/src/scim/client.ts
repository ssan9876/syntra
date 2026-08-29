import { guardedFetch } from '../net/guarded-fetch.js';
import type { ResolvedScim2TargetConfig } from './config.js';

export interface ScimResponse {
  status: number;
  json: unknown;
}

/**
 * Thrown by `scimRequest` when the body was not JSON — an HTML error page
 * from a proxy or load balancer in front of the real endpoint is the usual
 * source, and it arrives with a 2xx as often as with an error status.
 *
 * Carries `status` so a caller can classify it exactly the way it classifies
 * any other SCIM failure: `connector.ts`'s `classifyFailure(status)` is the
 * same function a 4xx/5xx JSON error response goes through, matching the
 * split the AD connector makes in `classifyLdapError` between "what
 * happened" and "what to do about it".
 */
export class ScimMalformedBodyError extends Error {
  readonly status: number;

  constructor(status: number, rawBody: string) {
    super(
      `the server's response body was not JSON (HTTP ${status}): ${rawBody.slice(0, 200)}`,
    );
    this.name = 'ScimMalformedBodyError';
    this.status = status;
  }
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
  if (text === '') return { status: response.status, json: null };
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    throw new ScimMalformedBodyError(response.status, text);
  }
}
