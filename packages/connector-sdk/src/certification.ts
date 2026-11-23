import { randomUUID } from 'node:crypto';
import { ConnectorClient, ConnectorServiceError, type FetchLike, type ReadBack } from './client.js';
import { HEADERS, PROTOCOL_VERSION, type WriteOperationOf, type WriteResultBody } from './protocol.js';
import { signRequest } from './signing.js';

/**
 * The lifecycle contract every target obeys, written once.
 *
 * Syntra certifies its built-in adapters with this (through
 * `certifyTargetConnector` in `@syntra/connectors`), and a connector author
 * certifies a running service with `certifyConnectorService` below, which adds
 * the protocol checks. Same checks, same names, so a service that passes here
 * passes what Syntra's own adapters pass.
 */

/** The parts of a target the lifecycle checks call. */
export interface CertificationSubject<R extends ReadBackShape> {
  test(): Promise<{ ok: boolean; message: string }>;
  placesAccountsInContainers(): boolean;
  listContainers(): AsyncIterable<{ dn: string }>;
  write(operation: WriteOperationOf<'create_account'> | LifecycleOperation): Promise<WriteResultShape>;
  readBack(anchor: string): Promise<R>;
}

export interface ReadBackShape {
  account: unknown;
  entitlementIds: string[];
  enabled: boolean | null;
  complete: boolean;
}

export interface WriteResultShape {
  ok: boolean;
  message: string;
  anchor?: string;
  failure?: string;
}

type LifecycleOperation =
  | WriteOperationOf<'update_account'>
  | WriteOperationOf<'disable_account'>
  | WriteOperationOf<'grant_entitlement'>
  | WriteOperationOf<'revoke_entitlement'>;

export interface LifecycleScenario<R extends ReadBackShape> {
  name: string;
  create: WriteOperationOf<'create_account'>;
  update?: (anchor: string) => WriteOperationOf<'update_account'>;
  disable?: (anchor: string) => WriteOperationOf<'disable_account'>;
  entitlement?: {
    id: string;
    grant: (anchor: string) => WriteOperationOf<'grant_entitlement'>;
    revoke: (anchor: string) => WriteOperationOf<'revoke_entitlement'>;
  };
  missingAnchor: string;
  assertCreated?: (observed: R) => void;
  assertUpdated?: (observed: R) => void;
}

export interface CertificationReport {
  name: string;
  anchor: string;
  checks: string[];
}

const requireSuccess = (result: WriteResultShape, operation: string): string | undefined => {
  if (!result.ok) {
    throw new Error(`${operation} failed certification: ${result.failure ?? 'unclassified'}: ${result.message}`);
  }
  return result.anchor;
};

/**
 * Real calls against the caller's disposable fixture, never a mock. A target
 * is certified only for the optional operations its scenario includes; an
 * omitted one is unsupported, not silently passed.
 */
export async function runLifecycleCertification<R extends ReadBackShape>(
  subject: CertificationSubject<R>,
  scenario: LifecycleScenario<R>,
): Promise<CertificationReport> {
  const checks: string[] = [];

  const observeComplete = async (anchor: string, operation: string): Promise<R> => {
    const observed = await subject.readBack(anchor);
    if (!observed.complete) throw new Error(`${operation} produced an incomplete read-back`);
    if (!observed.account) throw new Error(`${operation} did not read the account back`);
    return observed;
  };

  const connection = await subject.test();
  if (!connection.ok) throw new Error(`connection test failed certification: ${connection.message}`);
  checks.push('connection');

  // Placement is a declaration, and a run relies on it: a target that says it
  // places accounts in containers but lists none would drop every person as
  // `container_missing`.
  const places = subject.placesAccountsInContainers();
  if (typeof places !== 'boolean') {
    throw new Error('placesAccountsInContainers must answer true or false');
  }
  if (places) {
    let listed = 0;
    for await (const container of subject.listContainers()) {
      void container;
      listed += 1;
    }
    if (listed === 0) {
      throw new Error(
        'the connector places accounts in containers but listed none, so a run could never create an account',
      );
    }
  }
  checks.push('container-placement');

  const created = await subject.write(scenario.create);
  const anchor = requireSuccess(created, 'create');
  if (!anchor) throw new Error('create succeeded without returning an anchor');
  checks.push('create');

  const retried = await subject.write(scenario.create);
  const retryAnchor = requireSuccess(retried, 'idempotent create retry');
  if (retryAnchor !== anchor) {
    throw new Error(`idempotent create retry returned ${retryAnchor ?? 'no anchor'} instead of ${anchor}`);
  }
  checks.push('idempotent-create');

  let observed = await observeComplete(anchor, 'create');
  if (observed.enabled !== scenario.create.enabled) {
    throw new Error(`create read-back reported enabled=${String(observed.enabled)}`);
  }
  scenario.assertCreated?.(observed);
  checks.push('create-read-back');

  if (scenario.update) {
    const operation = scenario.update(anchor);
    requireSuccess(await subject.write(operation), 'update');
    requireSuccess(await subject.write(operation), 'idempotent update retry');
    observed = await observeComplete(anchor, 'update');
    scenario.assertUpdated?.(observed);
    checks.push('update', 'idempotent-update', 'update-read-back');
  }

  if (scenario.entitlement) {
    requireSuccess(await subject.write(scenario.entitlement.grant(anchor)), 'entitlement grant');
    observed = await observeComplete(anchor, 'entitlement grant');
    if (!observed.entitlementIds.includes(scenario.entitlement.id)) {
      throw new Error('granted entitlement was absent from read-back');
    }
    requireSuccess(await subject.write(scenario.entitlement.revoke(anchor)), 'entitlement revoke');
    observed = await observeComplete(anchor, 'entitlement revoke');
    if (observed.entitlementIds.includes(scenario.entitlement.id)) {
      throw new Error('revoked entitlement remained in read-back');
    }
    checks.push('grant-read-back', 'revoke-read-back');
  }

  if (scenario.disable) {
    const operation = scenario.disable(anchor);
    requireSuccess(await subject.write(operation), 'disable');
    requireSuccess(await subject.write(operation), 'idempotent disable retry');
    observed = await observeComplete(anchor, 'disable');
    if (observed.enabled !== false) throw new Error('disabled account read back as enabled');
    checks.push('disable', 'idempotent-disable', 'disable-read-back');
  }

  const missing = await subject.write({
    op: 'disable_account',
    actionId: `${scenario.create.actionId}-missing`,
    anchor: scenario.missingAnchor,
    reason: 'connector certification missing-object probe',
  });
  if (missing.ok || missing.failure !== 'not_found') {
    throw new Error(
      `missing object was classified as ${missing.ok ? 'success' : (missing.failure ?? 'unclassified')}`,
    );
  }
  checks.push('missing-object');

  return { name: scenario.name, anchor, checks };
}

// ----------------------------------------------------- a running service

export interface ServiceCertificationOptions extends Omit<LifecycleScenario<ReadBack>, 'name'> {
  /** The running service, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** The shared secret it was started with. */
  secret: string;
  name?: string;
  timeoutMs?: number;
  pageSize?: number;
  fetch?: FetchLike;
}

/**
 * Certifies a running connector service: the protocol checks first (a wrong
 * signature, a stale timestamp, a replayed nonce and a foreign protocol
 * version are all refused), then the lifecycle above through the same client
 * Syntra uses.
 *
 * Point it at a disposable target. It creates, changes and disables an
 * account.
 */
export async function certifyConnectorService(options: ServiceCertificationOptions): Promise<CertificationReport> {
  const client = new ConnectorClient({
    baseUrl: options.baseUrl,
    secret: options.secret,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const fetcher: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.baseUrl.replace(/\/+$/, '');
  const pageSize = options.pageSize ?? 100;
  const protocolChecks: string[] = [];

  const described = await client.describe();
  const incompatible = ConnectorClient.incompatibility(described);
  if (incompatible) throw new Error(incompatible);
  protocolChecks.push('handshake');

  const raw = async (
    method: string,
    headers: Record<string, string>,
    body = '{}',
  ): Promise<number> => {
    const response = await fetcher(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    await response.text();
    return response.status;
  };
  const signedHeaders = (method: string, body: string, overrides: { now?: number; nonce?: string; secret?: string } = {}) => {
    const signed = signRequest(overrides.secret ?? options.secret, method, body, {
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
      nonce: overrides.nonce ?? randomUUID(),
    });
    return {
      [HEADERS.version]: String(PROTOCOL_VERSION),
      [HEADERS.timestamp]: signed.timestamp,
      [HEADERS.nonce]: signed.nonce,
      [HEADERS.signature]: signed.signature,
    };
  };
  const expect = (status: number, wanted: number, what: string) => {
    if (status !== wanted) throw new Error(`${what}: the service answered HTTP ${status}, expected ${wanted}`);
  };

  expect(await raw('test', {}), 401, 'an unsigned request was not refused');
  expect(
    await raw('test', signedHeaders('test', '{}', { secret: `${options.secret}-wrong` })),
    401,
    'a request signed with the wrong secret was not refused',
  );
  expect(
    await raw('test', signedHeaders('test', '{}', { now: Date.now() - 3_600_000 })),
    401,
    'a request signed an hour ago was not refused',
  );
  const replayed = signedHeaders('test', '{}');
  expect(await raw('test', replayed), 200, 'a correctly signed request was refused');
  expect(await raw('test', replayed), 401, 'a replayed request was not refused');
  // The signature covers the body: the same headers with another body fail.
  expect(
    await raw('accounts.list', signedHeaders('accounts.list', '{"cursor":null,"pageSize":1}'), '{"cursor":null,"pageSize":2}'),
    401,
    'a request whose body was changed after signing was not refused',
  );
  protocolChecks.push('signature');

  expect(
    await raw('test', { ...signedHeaders('test', '{}'), [HEADERS.version]: '999' }),
    400,
    'a request in protocol version 999 was not refused',
  );
  protocolChecks.push('version');

  try {
    await client.call('accounts.list', { cursor: null, pageSize });
  } catch (cause) {
    throw new Error(`accounts.list failed certification: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
  protocolChecks.push('accounts-list');

  const places = described.capabilities.placesAccountsInContainers;
  const lifecycle = await runLifecycleCertification<ReadBack>(
    {
      test: async () => {
        try {
          return await client.test();
        } catch (cause) {
          return { ok: false, message: cause instanceof ConnectorServiceError ? cause.message : String(cause) };
        }
      },
      placesAccountsInContainers: () => places,
      listContainers: () => client.containers(pageSize),
      write: (operation): Promise<WriteResultBody> => client.write(operation),
      readBack: (anchor) => client.readBack(anchor),
    },
    { ...options, name: options.name ?? described.connector.name },
  );
  return { ...lifecycle, checks: [...protocolChecks, ...lifecycle.checks] };
}
