import {
  readBackTarget,
  type TargetConnector,
  type TargetReadBack,
  type WriteOperation,
  type WriteResult,
} from '../types.js';

export interface TargetConnectorCertificationScenario<C> {
  name: string;
  connector: TargetConnector<C>;
  config: C;
  create: Extract<WriteOperation, { op: 'create_account' }>;
  update?: (anchor: string) => Extract<WriteOperation, { op: 'update_account' }>;
  disable?: (anchor: string) => Extract<WriteOperation, { op: 'disable_account' }>;
  entitlement?: {
    id: string;
    grant: (anchor: string) => Extract<WriteOperation, { op: 'grant_entitlement' }>;
    revoke: (anchor: string) => Extract<WriteOperation, { op: 'revoke_entitlement' }>;
  };
  missingAnchor: string;
  assertCreated?: (observed: TargetReadBack) => void;
  assertUpdated?: (observed: TargetReadBack) => void;
}

export interface TargetConnectorCertificationReport {
  name: string;
  anchor: string;
  checks: string[];
}

const requireSuccess = (result: WriteResult, operation: string): string | undefined => {
  if (!result.ok) {
    throw new Error(`${operation} failed certification: ${result.failure ?? 'unclassified'}: ${result.message}`);
  }
  return result.anchor;
};

const observeComplete = async <C>(
  scenario: TargetConnectorCertificationScenario<C>,
  anchor: string,
  operation: string,
): Promise<TargetReadBack> => {
  const observed = await readBackTarget(scenario.connector, scenario.config, anchor);
  if (!observed.complete) throw new Error(`${operation} produced an incomplete read-back`);
  if (!observed.account) throw new Error(`${operation} did not read the account back`);
  return observed;
};

/**
 * Run the minimum lifecycle contract every supported target adapter must obey.
 *
 * This deliberately performs real adapter calls against the caller's
 * disposable fixture. It is not a mock of connector behavior. A connector is
 * certified only for the optional operations included by its scenario; an
 * omitted operation is unsupported, not silently passed.
 */
export async function certifyTargetConnector<C>(
  scenario: TargetConnectorCertificationScenario<C>,
): Promise<TargetConnectorCertificationReport> {
  const checks: string[] = [];

  const connection = await scenario.connector.test(scenario.config);
  if (!connection.ok) throw new Error(`connection test failed certification: ${connection.message}`);
  checks.push('connection');

  // Placement is a declaration, and a run relies on it: a target that says it
  // places accounts in containers but lists none would drop every person as
  // `container_missing`, which is what flat targets did before they could say
  // they were flat. Checked here because nothing else calls both.
  const places = scenario.connector.placesAccountsInContainers(scenario.config);
  if (typeof places !== 'boolean') {
    throw new Error('placesAccountsInContainers must answer true or false');
  }
  if (places) {
    let listed = 0;
    for await (const container of scenario.connector.listContainers(scenario.config)) {
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

  const created = await scenario.connector.write(scenario.config, scenario.create);
  const anchor = requireSuccess(created, 'create');
  if (!anchor) throw new Error('create succeeded without returning an anchor');
  checks.push('create');

  const retried = await scenario.connector.write(scenario.config, scenario.create);
  const retryAnchor = requireSuccess(retried, 'idempotent create retry');
  if (retryAnchor !== anchor) {
    throw new Error(`idempotent create retry returned ${retryAnchor ?? 'no anchor'} instead of ${anchor}`);
  }
  checks.push('idempotent-create');

  let observed = await observeComplete(scenario, anchor, 'create');
  if (observed.enabled !== scenario.create.enabled) {
    throw new Error(`create read-back reported enabled=${String(observed.enabled)}`);
  }
  scenario.assertCreated?.(observed);
  checks.push('create-read-back');

  if (scenario.update) {
    const operation = scenario.update(anchor);
    requireSuccess(await scenario.connector.write(scenario.config, operation), 'update');
    requireSuccess(await scenario.connector.write(scenario.config, operation), 'idempotent update retry');
    observed = await observeComplete(scenario, anchor, 'update');
    scenario.assertUpdated?.(observed);
    checks.push('update', 'idempotent-update', 'update-read-back');
  }

  if (scenario.entitlement) {
    requireSuccess(
      await scenario.connector.write(scenario.config, scenario.entitlement.grant(anchor)),
      'entitlement grant',
    );
    observed = await observeComplete(scenario, anchor, 'entitlement grant');
    if (!observed.entitlementIds.includes(scenario.entitlement.id)) {
      throw new Error('granted entitlement was absent from read-back');
    }
    requireSuccess(
      await scenario.connector.write(scenario.config, scenario.entitlement.revoke(anchor)),
      'entitlement revoke',
    );
    observed = await observeComplete(scenario, anchor, 'entitlement revoke');
    if (observed.entitlementIds.includes(scenario.entitlement.id)) {
      throw new Error('revoked entitlement remained in read-back');
    }
    checks.push('grant-read-back', 'revoke-read-back');
  }

  if (scenario.disable) {
    const operation = scenario.disable(anchor);
    requireSuccess(await scenario.connector.write(scenario.config, operation), 'disable');
    requireSuccess(await scenario.connector.write(scenario.config, operation), 'idempotent disable retry');
    observed = await observeComplete(scenario, anchor, 'disable');
    if (observed.enabled !== false) throw new Error('disabled account read back as enabled');
    checks.push('disable', 'idempotent-disable', 'disable-read-back');
  }

  const missing = await scenario.connector.write(scenario.config, {
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
