import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Panel } from '@syntra/ui';
import { api } from '../../session/api.js';
import type { PersonProvisionReceipt } from './provision-on-create.js';

export function PersonProvisionReceipts({ personId }: { personId: string }) {
  const [receipts, setReceipts] = useState<PersonProvisionReceipt[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const data = await api<{ receipts: PersonProvisionReceipt[] }>(`/api/admin/persons/${personId}/provision-receipts`);
        if (current) { setReceipts(Array.isArray(data.receipts) ? data.receipts : []); setProblem(null); }
      } catch { if (current) setProblem('Could not load saved provisioning receipts.'); }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 3000);
    return () => { current = false; clearInterval(timer); };
  }, [personId, version]);
  async function retry(id: string) {
    setBusy(id);
    try {
      await api(`/api/admin/persons/${personId}/provision-receipts/${id}/retry`, { method: 'POST', body: '{}' });
      setVersion(v => v + 1);
    } catch { setProblem('Could not retry. Your saved records have been kept.'); }
    finally { setBusy(null); }
  }
  if (!receipts.length && !problem) return null;
  return <Panel title="Provisioning receipts">
    {problem && <Alert tone="warning" title="Receipts unavailable">{problem}</Alert>}
    <p className="text-sm text-muted">Saved results for this person. Pending or blocked work does not mean access is ready.</p>
    <ul className="divide-y divide-border" aria-live="polite">
      {receipts.map(receipt => <li key={receipt.id} className="py-3 space-y-2">
        <p><strong>{receipt.targetName}</strong> — {receipt.status === 'no_match' ? 'No matching account requirement' : receipt.status}</p>
        {receipt.message && <p className="text-sm">{receipt.message}</p>}
        <div className="flex flex-wrap items-center gap-3">
          {receipt.runId && <Link className="underline" to={`/admin/targets/${receipt.targetSystemId}/runs/${receipt.runId}`}>Review exact run</Link>}
          {!['applied', 'verification_pending', 'pending', 'planning'].includes(receipt.status) && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void retry(receipt.id); }}>{busy === receipt.id ? 'Queuing…' : 'Retry unfinished work'}</Button>}
        </div>
      </li>)}
    </ul>
  </Panel>;
}
