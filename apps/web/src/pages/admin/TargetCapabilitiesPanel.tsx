import { Panel, SkeletonRows, StateBadge, Status, Table, type State } from '@syntra/ui';
import { useApiResource } from './hooks.js';

/**
 * What the API says this target can do -- see `GET /targets/:id/capabilities`.
 *
 * For an Entra target the versioned matrix is rendered entry by entry with
 * the status Syntra is prepared to claim for it, and whether that claim
 * rests on the fake-Graph tests alone or also needs evidence recorded from a
 * disposable tenant. An entry that needs evidence is not hidden and not
 * promoted: it is shown with the requirement next to it, because the
 * roadmap's exit criterion is that nothing is advertised without both.
 */
interface MatrixEntry {
  status: 'available' | 'unsupported' | 'never';
  validation: 'automated' | 'automated+tenant-evidence-required';
  requiredPermissions: string[];
  note: string;
}

interface CapabilitiesResponse {
  type: string;
  metadata: {
    displayName: string;
    adapterVersion: string;
    connectorApiVersion: number;
    supportState: 'supported' | 'preview' | 'deprecated' | 'unavailable';
    rollout: 'general' | 'controlled' | 'disabled';
    deprecationDate: string | null;
    certification: {
      contractVersion: number;
      status: 'passed' | 'partial' | 'failed' | 'not-run';
      verifiedAt: string | null;
      evidence: string;
    };
  };
  matrix: { version: number; entries: Record<string, MatrixEntry> } | null;
  capabilities: {
    available: boolean;
    readBack: boolean;
    createAccount: boolean;
    updateAccount: boolean;
    disableAccount: boolean;
    manageEntitlements: boolean;
  };
}

// The console's agreed states rather than a tone chosen here: "never" is a
// refusal nobody can lift, "not supported" is a gap somebody should know about.
const STATUS_STATE: Record<MatrixEntry['status'], State> = {
  available: 'healthy',
  unsupported: 'attention',
  never: 'blocked',
};

const SUPPORT_STATE: Record<CapabilitiesResponse['metadata']['supportState'], State> = {
  supported: 'healthy',
  preview: 'attention',
  deprecated: 'attention',
  unavailable: 'blocked',
};

const ROLLOUT_STATE: Record<CapabilitiesResponse['metadata']['rollout'], State> = {
  general: 'healthy',
  controlled: 'attention',
  disabled: 'blocked',
};

const CERTIFICATION_STATE: Record<CapabilitiesResponse['metadata']['certification']['status'], State> = {
  passed: 'healthy',
  partial: 'attention',
  'not-run': 'setup',
  failed: 'blocked',
};

const STATUS_LABEL = {
  available: 'available',
  unsupported: 'not supported',
  never: 'never',
} as const;

const SUMMARY_LABELS: [keyof CapabilitiesResponse['capabilities'], string][] = [
  ['createAccount', 'Create accounts'],
  ['updateAccount', 'Update accounts'],
  ['disableAccount', 'Disable and enable accounts'],
  ['manageEntitlements', 'Grant and revoke entitlements'],
  ['readBack', 'Read back after a write'],
];

export function CapabilitiesPanel({ targetId }: { targetId: string }) {
  const { data, error, loading } = useApiResource<CapabilitiesResponse>(
    `/api/admin/targets/${targetId}/capabilities`,
  );

  // Nothing rather than a broken panel: this is a read-only supplement to
  // the editor, and an answer it cannot render must not take the editor down.
  if (error || (data && !data.capabilities)) return null;
  if (loading || !data) {
    return (
      <Panel title="Capabilities">
        <SkeletonRows rows={3} cols={2} />
      </Panel>
    );
  }

  const needsEvidence = data.matrix
    ? Object.values(data.matrix.entries).filter(
        (entry) =>
          entry.status === 'available' &&
          entry.validation === 'automated+tenant-evidence-required',
      ).length
    : 0;

  return (
    <Panel
      title="Capabilities"
      actions={
        data.matrix ? (
          <Status tone="neutral">matrix v{data.matrix.version}</Status>
        ) : undefined
      }
    >
      <div className="space-y-4 p-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">Adapter</dt>
            <dd className="font-medium text-ink">
              {data.metadata.displayName} v{data.metadata.adapterVersion}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Support</dt>
            <dd className="mt-1">
              <StateBadge state={SUPPORT_STATE[data.metadata.supportState] ?? 'attention'}>
                {data.metadata.supportState}
              </StateBadge>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Rollout</dt>
            <dd className="mt-1">
              <StateBadge state={ROLLOUT_STATE[data.metadata.rollout] ?? 'attention'}>
                {data.metadata.rollout}
              </StateBadge>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Certification</dt>
            <dd className="mt-1">
              <StateBadge state={CERTIFICATION_STATE[data.metadata.certification.status] ?? 'attention'}>
                {data.metadata.certification.status}
              </StateBadge>
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted">
          {data.metadata.certification.evidence}
          {data.metadata.certification.verifiedAt
            ? ` · verified ${data.metadata.certification.verifiedAt}`
            : ''}
          {data.metadata.deprecationDate
            ? ` · deprecated after ${data.metadata.deprecationDate}`
            : ''}
        </p>
        {!data.capabilities.available && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-danger">
            <StateBadge state="blocked">Unavailable</StateBadge>
            Nothing here will be applied.
          </p>
        )}
        <ul className="grid gap-2 sm:grid-cols-2">
          {SUMMARY_LABELS.map(([key, label]) => (
            <li key={key} className="flex items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <StateBadge state={data.capabilities[key] ? 'healthy' : 'inactive'}>
                {data.capabilities[key] ? 'yes' : 'no'}
              </StateBadge>
            </li>
          ))}
        </ul>

        {data.matrix && (
          <>
            <p className="text-sm text-muted">
              {needsEvidence > 0
                ? `${needsEvidence} of these are verified against the fake Graph only and still require evidence from a disposable tenant (pnpm entra:validate --write) before they count as proven.`
                : 'Every advertised capability has recorded tenant evidence.'}
            </p>
            <Table tight label="Capability matrix">
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Status</th>
                  <th scope="col">Validation</th>
                  <th scope="col">Graph application permissions</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.matrix.entries).map(([name, entry]) => (
                  <tr key={name} className="align-top">
                    <td className="font-mono">{name}</td>
                    <td>
                      <StateBadge state={STATUS_STATE[entry.status] ?? 'attention'}>
                        {STATUS_LABEL[entry.status]}
                      </StateBadge>
                    </td>
                    <td>
                      {entry.validation === 'automated+tenant-evidence-required' ? (
                        <StateBadge state="attention">tenant evidence required</StateBadge>
                      ) : (
                        <Status tone="neutral">automated</Status>
                      )}
                    </td>
                    <td className="font-mono text-xs text-muted">
                      {entry.requiredPermissions.length > 0
                        ? entry.requiredPermissions.join(', ')
                        : 'none'}
                    </td>
                    <td className="text-muted">{entry.note}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </div>
    </Panel>
  );
}
