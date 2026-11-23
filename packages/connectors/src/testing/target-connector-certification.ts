import { runLifecycleCertification } from '@syntra/connector-sdk';
import {
  readBackTarget,
  type TargetConnector,
  type TargetReadBack,
  type WriteOperation,
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

/**
 * Run the minimum lifecycle contract every supported target adapter must obey.
 *
 * This deliberately performs real adapter calls against the caller's
 * disposable fixture. It is not a mock of connector behavior. A connector is
 * certified only for the optional operations included by its scenario; an
 * omitted operation is unsupported, not silently passed.
 *
 * The checks themselves are `runLifecycleCertification` in
 * `@syntra/connector-sdk`, which a connector service's author runs against
 * their own service. One list of checks, so a service that passes there
 * passes what every built-in adapter passes here.
 */
export async function certifyTargetConnector<C>(
  scenario: TargetConnectorCertificationScenario<C>,
): Promise<TargetConnectorCertificationReport> {
  const { connector, config } = scenario;
  return runLifecycleCertification<TargetReadBack>(
    {
      test: () => connector.test(config),
      placesAccountsInContainers: () => connector.placesAccountsInContainers(config),
      listContainers: () => connector.listContainers(config),
      write: (operation) => connector.write(config, operation),
      readBack: (anchor) => readBackTarget(connector, config, anchor),
    },
    scenario,
  );
}
