import { Alert, Panel, Status } from '@syntra/ui';

export interface ConnectorRight {
  right: 'createUser' | 'modifyUser' | 'moveUser' | 'modifyMembership';
  status: 'granted' | 'denied' | 'unverified';
  detail: string;
}

export interface TestResult {
  ok: boolean;
  message: string;
  rights?: ConnectorRight[];
}

const RIGHT_LABELS: Record<ConnectorRight['right'], string> = {
  createUser: 'Create accounts',
  modifyUser: 'Modify accounts',
  moveUser: 'Move accounts between containers',
  modifyMembership: 'Change group membership',
};

/**
 * `unverified` renders as its own tone, never as a quiet `granted`.
 *
 * A directory that does not publish effective rights cannot be read as having
 * granted them. Collapsing the two turns "we could not tell" into "yes", which
 * is the one reading an administrator must not be given by a screen whose
 * whole job is to answer whether this bind account can do the work — a bind
 * that can read the directory but cannot create users passes an `ok: true`
 * connection test, and this list is the only thing that says so before a run
 * fails against a live directory.
 *
 * `warning` rather than a neutral grey, which is where the plan's `muted`
 * would have landed: a quiet badge beside two green ones reads as agreement.
 * Amber is the only tone in the system that says "look at this" without
 * claiming a refusal happened.
 */
function rightTone(
  status: ConnectorRight['status'],
): 'active' | 'danger' | 'warning' {
  if (status === 'granted') return 'active';
  if (status === 'denied') return 'danger';
  return 'warning';
}

export function RightsReport({ rights }: { rights: ConnectorRight[] }) {
  return (
    <ul className="space-y-2">
      {rights.map((r) => (
        <li key={r.right} className="flex flex-wrap items-center gap-2">
          <Status tone={rightTone(r.status)}>
            {r.status === 'unverified' ? 'Could not check' : r.status}
          </Status>
          <span className="text-ink">{RIGHT_LABELS[r.right]}</span>
          <span className="text-muted">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function TestReport({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Could not connect">
        {result.message}
      </Alert>
    );
  }

  return (
    <Panel title="Connection test">
      <div className="space-y-4 p-4">
        <p className="flex flex-wrap items-center gap-2">
          <Status tone="active">Connected</Status>
          <span className="text-muted">{result.message}</span>
        </p>
        {result.rights && result.rights.length > 0 && (
          <>
            <p className="text-muted">
              What this bind account is allowed to do. A right it could not
              confirm is not a right it has.
            </p>
            <RightsReport rights={result.rights} />
          </>
        )}
      </div>
    </Panel>
  );
}
