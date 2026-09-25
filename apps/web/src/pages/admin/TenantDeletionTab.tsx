import { useState } from 'react';
import { Alert, Button, Field, Identifier, Panel, SkeletonRows, StateBadge, type State } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

/**
 * Offboarding: the evidence, and the four-eyes path to erasing this tenant.
 *
 * Laid out in the order the server insists on, so the page cannot be used out
 * of order: an assessment, then an export taken after it, then a request that
 * names both by digest, then a second administrator's approval, then -- after
 * the cooling-off period -- execution. Each later step is only offered once
 * the one before it exists, and every refusal the server gives is shown in
 * its own words, because "stale" and "legal hold" need different responses.
 */

export interface DeletionRequest {
  id: string;
  status: 'pending_approval' | 'approved' | 'executing' | 'completed' | 'cancelled' | 'expired' | 'invalidated';
  assessmentDigest: string;
  exportDigest: string;
  reason: string | null;
  requestedByUserId: string;
  requestedAt: string;
  approvalExpiresAt: string;
  approvedByUserId: string | null;
  approvedAt: string | null;
  executeNotBefore: string | null;
  executeBefore: string | null;
  cancelledAt: string | null;
  closedReason: string | null;
}

export interface DeletionState {
  request: DeletionRequest | null;
  viewerUserId: string;
  policy: { approvalWindowHours: number; coolingOffHours: number; executionWindowHours: number; stepUpMaxAgeMinutes: number; reasonMinLength: number };
}

interface Assessment {
  deletionReady: boolean;
  digest: string;
  blockers: { activeLegalHolds: number; unresolvedLifecycleOperations: number };
  inventory: Record<string, number>;
}

const OPEN = new Set(['pending_approval', 'approved']);

/**
 * The request's state in the console's shared status language. `label` is the
 * lower-case form used inside a sentence ("Last request cancelled: …"); the
 * badge capitalises it.
 */
const STATUS: Record<DeletionRequest['status'], { label: string; state: State }> = {
  pending_approval: { label: 'awaiting approval', state: 'pending' },
  // Approved is the one that should make a reader stop: the tenant is now a
  // cooling-off period away from being erased.
  approved: { label: 'approved', state: 'attention' },
  executing: { label: 'executing', state: 'running' },
  completed: { label: 'completed', state: 'inactive' },
  cancelled: { label: 'cancelled', state: 'inactive' },
  expired: { label: 'expired', state: 'inactive' },
  invalidated: { label: 'invalidated', state: 'inactive' },
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function message(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : 'The request failed.';
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** Hands the browser a JSON file; a no-op where there is no object-URL support. */
function download(name: string, value: unknown) {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function TenantDeletionTab() {
  const { data, error, loading, reload } = useApiResource<DeletionState>('/api/admin/tenant/deletion');
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [exportDigest, setExportDigest] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warning' | 'success'; text: string } | null>(null);
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await action(); } catch (cause) { setNotice({ tone: 'warning', text: message(cause) }); }
    finally { setBusy(null); }
  };

  if (receipt) {
    return <Panel title="Tenant deleted">
      <div className="space-y-4 p-4">
        <Alert tone="success" title="The tenant has been erased">
          This console no longer serves it. Keep the receipt: it is the proof, and restoring an older backup would bring the tenant back.
        </Alert>
        <Button onClick={() => download(`syntra-deletion-receipt-${String(receipt.tenantId)}.json`, receipt)}>Download receipt</Button>
      </div>
    </Panel>;
  }
  if (loading && !data) return <SkeletonRows rows={3} cols={2} />;
  if (error || !data) return <Alert tone="danger">{error ?? 'Offboarding could not be loaded.'}</Alert>;

  const { request, viewerUserId, policy } = data;
  const open = request !== null && OPEN.has(request.status);
  const ownRequest = request?.requestedByUserId === viewerUserId;
  const coolingOff = request?.executeNotBefore ? new Date(request.executeNotBefore) > new Date() : false;

  const assess = () => run('assess', async () => {
    const result = await api<Assessment>('/api/admin/tenant/offboarding/assess', { method: 'POST' });
    setAssessment(result);
    setExportDigest(null);
  });
  const exportData = () => run('export', async () => {
    const artifact = await api<{ digest: string; tenant: { id: string } }>('/api/admin/tenant/offboarding/export', { method: 'POST' });
    setExportDigest(artifact.digest);
    download(`syntra-tenant-${artifact.tenant.id}.json`, artifact);
  });
  const submit = () => run('request', async () => {
    await api('/api/admin/tenant/deletion/requests', {
      method: 'POST',
      body: JSON.stringify({ assessmentDigest: assessment!.digest, exportDigest, reason }),
    });
    setReason('');
    setNotice({ tone: 'success', text: 'Deletion requested. A different administrator must approve it.' });
    reload();
  });
  const act = (verb: 'approve' | 'cancel') => run(verb, async () => {
    await api(`/api/admin/tenant/deletion/requests/${request!.id}/${verb}`, { method: 'POST' });
    setNotice({ tone: 'success', text: verb === 'approve' ? 'Approved. Execution opens after the cooling-off period.' : 'Deletion request cancelled.' });
    reload();
  });
  const execute = () => run('execute', async () => {
    setReceipt(await api<Record<string, unknown>>(`/api/admin/tenant/deletion/requests/${request!.id}/execute`, { method: 'POST' }));
  });

  return <div className="space-y-6">
    <div role="status" aria-live="polite">
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
    </div>

    <Panel title="Offboarding evidence" actions={assessment ? (assessment.deletionReady ? <StateBadge state="healthy">Ready</StateBadge> : <StateBadge state="blocked" />) : null}>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-3">
          <Button loading={busy === 'assess'} onClick={() => void assess()}>Assess tenant</Button>
          <Button variant="secondary" loading={busy === 'export'} disabled={!assessment} onClick={() => void exportData()}>Download export</Button>
        </div>
        {assessment ? <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">Assessment</dt><dd><Identifier value={assessment.digest} truncate /></dd>
          <dt className="text-muted">Legal holds</dt><dd>{assessment.blockers.activeLegalHolds}</dd>
          <dt className="text-muted">Unresolved lifecycle work</dt><dd>{assessment.blockers.unresolvedLifecycleOperations}</dd>
          <dt className="text-muted">Export</dt><dd>{exportDigest ? <Identifier value={exportDigest} truncate /> : '—'}</dd>
        </dl> : null}
      </div>
    </Panel>

    <Panel title="Delete tenant" actions={request ? <StateBadge state={STATUS[request.status].state}>{capital(STATUS[request.status].label)}</StateBadge> : null}>
      <div className="space-y-4 p-4">
        {request && open ? <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">Requested</dt><dd>{when(request.requestedAt)}{ownRequest ? ' (by you)' : ''}</dd>
          {request.reason ? <><dt className="text-muted">Reason</dt><dd>{request.reason}</dd></> : null}
          <dt className="text-muted">Assessment / export</dt><dd className="flex flex-wrap items-center gap-x-2"><Identifier value={request.assessmentDigest} truncate /> / <Identifier value={request.exportDigest} truncate /></dd>
          {request.status === 'pending_approval'
            ? <><dt className="text-muted">Approve by</dt><dd>{when(request.approvalExpiresAt)}</dd></>
            : <><dt className="text-muted">Executable</dt><dd>{when(request.executeNotBefore)} – {when(request.executeBefore)}</dd></>}
        </dl> : null}
        {request && !open && request.closedReason ? <p className="text-sm text-muted">Last request {STATUS[request.status].label}: {request.closedReason}</p> : null}

        {/* The step that starts the erasure, bounded in the danger colour so
            it reads as a different kind of act from the evidence above it.
            Not a modal: the assessment and export it names by digest are the
            evidence being signed off, and a dialog would cover them. */}
        {!open ? <div role="group" aria-label="Request deletion" className="max-w-2xl space-y-3 rounded-panel border border-danger/40 p-3">
          <Field
            name="reason"
            label="Reason for deleting this tenant"
            value={reason}
            onChange={setReason}
            warning={reason.trim().length > 0 && reason.trim().length < policy.reasonMinLength ? `At least ${policy.reasonMinLength} characters` : undefined}
          />
          <div className="border-t border-border-subtle pt-3">
            <Button
              variant="danger"
              loading={busy === 'request'}
              disabled={!assessment?.deletionReady || !exportDigest || reason.trim().length < policy.reasonMinLength}
              onClick={() => void submit()}
            >Request deletion</Button>
          </div>
        </div> : null}

        {request?.status === 'pending_approval' ? <div className="flex flex-wrap gap-3">
          {ownRequest
            ? <p className="text-sm text-muted">A different administrator must approve, within {policy.approvalWindowHours} hours.</p>
            : <Button variant="danger" loading={busy === 'approve'} onClick={() => void act('approve')}>Approve deletion</Button>}
          <Button variant="secondary" loading={busy === 'cancel'} onClick={() => void act('cancel')}>Cancel request</Button>
        </div> : null}

        {request?.status === 'approved' ? <div className="space-y-3">
          {coolingOff ? <p className="text-sm text-muted">Cooling off until {when(request.executeNotBefore)}. Anyone with this access can still cancel.</p> : null}
          <div role="group" aria-label="Delete tenant now" className="max-w-2xl space-y-3 rounded-panel border border-danger/40 p-3">
            <Field
              name="confirm"
              label="Type DELETE to confirm"
              value={confirm}
              onChange={setConfirm}
              disabled={coolingOff}
              autoComplete="off"
              spellCheck={false}
              warning={!coolingOff ? `Erases every person, account and secret in this tenant. Needs a sign-in from the last ${policy.stepUpMaxAgeMinutes} minutes.` : undefined}
            />
            <div className="flex flex-wrap gap-3 border-t border-border-subtle pt-3">
              <Button variant="danger" loading={busy === 'execute'} disabled={coolingOff || confirm !== 'DELETE'} onClick={() => void execute()}>Delete tenant now</Button>
              <Button variant="secondary" loading={busy === 'cancel'} onClick={() => void act('cancel')}>Cancel request</Button>
            </div>
          </div>
        </div> : null}
      </div>
    </Panel>
  </div>;
}
