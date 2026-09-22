import { Panel, SkeletonRows, Status } from '@syntra/ui';
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
  note: string;
}

interface CapabilitiesResponse {
  type: string;
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

const STATUS_TONE = {
  available: 'active',
  unsupported: 'warning',
  never: 'danger',
} as const;

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
        {!data.capabilities.available && (
          <p className="text-sm text-danger">
            This connector type is not available. Nothing here will be applied.
          </p>
        )}
        <ul className="grid gap-2 sm:grid-cols-2">
          {SUMMARY_LABELS.map(([key, label]) => (
            <li key={key} className="flex items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <Status tone={data.capabilities[key] ? 'active' : 'inactive'}>
                {data.capabilities[key] ? 'yes' : 'no'}
              </Status>
            </li>
          ))}
        </ul>

        {data.matrix && (
          <>
            <p className="text-sm text-ink-muted">
              {needsEvidence > 0
                ? `${needsEvidence} of these are verified against the fake Graph only and still require evidence from a disposable tenant (pnpm entra:validate --write) before they count as proven.`
                : 'Every advertised capability has recorded tenant evidence.'}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 pr-3 font-medium">Capability</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Validation</th>
                    <th className="py-1 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.matrix.entries).map(([name, entry]) => (
                    <tr key={name} className="border-t border-border align-top">
                      <td className="py-2 pr-3 font-mono">{name}</td>
                      <td className="py-2 pr-3">
                        <Status tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Status>
                      </td>
                      <td className="py-2 pr-3">
                        {entry.validation === 'automated+tenant-evidence-required' ? (
                          <Status tone="warning">tenant evidence required</Status>
                        ) : (
                          <Status tone="neutral">automated</Status>
                        )}
                      </td>
                      <td className="py-2 text-ink-muted">{entry.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
