import { Alert, StateBadge, Status, Table } from '@syntra/ui';
import { StaleBadge } from './DraftState.js';

export interface ConnectorRight {
  right: 'createUser' | 'modifyUser' | 'moveUser' | 'modifyMembership';
  status: 'granted' | 'denied' | 'unverified';
  detail: string;
}

export interface AccountPreview {
  accounts: {
    anchor: string;
    name: string;
    enabled: boolean | null;
    attributes: Record<string, string[]>;
  }[];
  skipped: number;
  unreadFields: string[];
}

export interface TestResult {
  ok: boolean;
  message: string;
  rights?: ConnectorRight[];
  /** REST API targets: the first page's accounts as Syntra reads them. */
  preview?: AccountPreview;
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
    <ul className="space-y-2" aria-label="What the bind account may do">
      {rights.map((r) => (
        <li key={r.right} className="flex flex-wrap items-center gap-2">
          <Status
            tone={rightTone(r.status)}
            glyph={r.status === 'granted' ? 'check' : r.status === 'denied' ? 'blocked' : 'alert'}
          >
            {r.status === 'unverified' ? 'Could not check' : r.status}
          </Status>
          <span className="text-ink">{RIGHT_LABELS[r.right]}</span>
          <span className="text-muted">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The first accounts of a REST API target, mapped by its connector document.
 *
 * What a document author checks before saving: that `anchorAt` finds an id,
 * that the fields land on the right attribute names, that enabled state reads
 * as it should, and which of the target's fields nothing reads yet.
 */
export function AccountPreviewReport({ preview }: { preview: AccountPreview }) {
  return (
    <div className="space-y-2">
      <h5 className="font-medium text-ink">First accounts read</h5>
      {preview.accounts.length === 0 ? (
        <p className="text-muted">No accounts on the first page.</p>
      ) : (
        <Table tight label="First accounts read">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Id</th>
              <th scope="col">Enabled</th>
              <th scope="col">Attributes</th>
            </tr>
          </thead>
          <tbody>
            {preview.accounts.map((account) => (
              <tr key={account.anchor}>
                <th scope="row">{account.name}</th>
                <td className="font-mono">{account.anchor}</td>
                <td>
                  {account.enabled === null ? (
                    <Status tone="warning" glyph="alert">Not read</Status>
                  ) : account.enabled ? (
                    'Yes'
                  ) : (
                    'No'
                  )}
                </td>
                <td className="font-mono text-xs">
                  {Object.entries(account.attributes)
                    .map(([name, values]) => `${name}: ${values.join(', ')}`)
                    .join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {preview.skipped > 0 && (
        <p className="text-muted">
          {preview.skipped} skipped: excluded, or no id at <code>anchorAt</code>.
        </p>
      )}
      {preview.unreadFields.length > 0 && (
        <p className="text-muted">
          Not read: <span className="font-mono">{preview.unreadFields.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The result of the last connection test, shown in the connection stage it
 * belongs to.
 *
 * `stale` is set by the editor the moment the connection it was run against
 * changes. The rights below describe the bind account and URL that were
 * TESTED, and a report that went on looking current after the bind DN was
 * retyped would be answering a question nobody is asking any more.
 */
export function TestReport({ result, stale = false }: { result: TestResult; stale?: boolean }) {
  return (
    <div className="space-y-3 sm:col-span-2" aria-label="Connection test result" role="group">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium text-ink">Connection test</h4>
        {stale && <StaleBadge />}
      </div>
      {!result.ok ? (
        <Alert tone="danger" title="Could not connect">
          {result.message}
        </Alert>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <StateBadge state="healthy">Connected</StateBadge>
            <span className="text-muted">{result.message}</span>
          </p>
          {result.rights && result.rights.length > 0 && <RightsReport rights={result.rights} />}
          {result.preview && <AccountPreviewReport preview={result.preview} />}
        </>
      )}
    </div>
  );
}
