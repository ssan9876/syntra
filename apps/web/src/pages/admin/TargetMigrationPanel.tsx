import { useState } from 'react';
import { Alert, Button, Panel, SkeletonRows, StateBadge, useToast } from '@syntra/ui';
import { api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface Preview {
  revision: string;
  from: { adapter: string };
  to: { adapter: string };
  preserved: {
    targetId: true;
    credential: true;
    schedule: true;
    accountProfile: boolean;
    accounts: number;
    entitlements: number;
    rules: number;
    runs: number;
  };
  warnings: string[];
}

export function TargetMigrationPanel({
  targetId,
  onApplied,
}: {
  targetId: string;
  onApplied: () => void;
}) {
  const { data, error, loading } = useApiResource<Preview>(
    `/api/admin/targets/${targetId}/migrations/native-entra/preview`,
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();

  // A document-driven target that is not Microsoft Entra has no migration.
  // The API's refusal is expected there, so it does not become a broken panel.
  if (error) return null;
  if (loading) {
    return (
      <Panel title="Connector migration">
        <SkeletonRows rows={2} cols={4} />
      </Panel>
    );
  }
  if (!data || !data.preserved || !Array.isArray(data.warnings)) return null;

  async function apply() {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/targets/${targetId}/migrations/native-entra/apply`, {
        method: 'POST',
        body: JSON.stringify({ revision: data!.revision }),
      });
      toast({ tone: 'success', title: 'Adapter migration applied' });
      onApplied();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The migration could not be applied.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Connector migration"
      actions={<StateBadge state="attention">Preview required</StateBadge>}
    >
      <div className="space-y-4 p-4">
        {problem && <Alert tone="danger">{problem}</Alert>}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-ink">{data.from.adapter}</span>
          <span className="text-muted">to</span>
          <span className="font-medium text-ink">{data.to.adapter}</span>
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-muted">Accounts</dt><dd className="font-medium tabular-nums">{data.preserved.accounts}</dd></div>
          <div><dt className="text-muted">Entitlements</dt><dd className="font-medium tabular-nums">{data.preserved.entitlements}</dd></div>
          <div><dt className="text-muted">Rules</dt><dd className="font-medium tabular-nums">{data.preserved.rules}</dd></div>
          <div><dt className="text-muted">Run history</dt><dd className="font-medium tabular-nums">{data.preserved.runs}</dd></div>
        </dl>
        <Alert tone="warning" title="Before applying">
          <ul className="list-disc space-y-1 pl-5">
            {data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </Alert>
        {confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => void apply()}>
              Apply adapter migration
            </Button>
            <Button disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button onClick={() => setConfirming(true)}>Review migration</Button>
        )}
      </div>
    </Panel>
  );
}
