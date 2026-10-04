import { useState } from 'react';
import { Alert, Button, Field, StateBadge, useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useCan } from '../../session/SessionProvider.js';

export interface PersonExclusion {
  targetSystemId: string;
  targetName: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  message: string;
}

/**
 * Whether this person is left out of one target, and the control that
 * changes it. Left out wins over every business rule: no account is created
 * for them there and the one they have is no longer managed. Both directions
 * take a reason.
 */
export function LeaveOut({
  personId,
  targetSystemId,
  targetName,
  exclusion,
  onChanged,
}: {
  personId: string;
  targetSystemId: string;
  targetName: string;
  exclusion: PersonExclusion | null;
  onChanged(): void;
}) {
  const can = useCan();
  const canManage = can('provision.manage');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();

  if (exclusion === null && !canManage) return null;

  const base = `/api/admin/targets/${targetSystemId}/exclusions`;

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      if (exclusion === null) {
        await api(base, { method: 'POST', body: JSON.stringify({ personId, reason }) });
        toast({ tone: 'success', title: `Left out of ${targetName}` });
      } else {
        await api(`${base}/${personId}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
        toast({ tone: 'success', title: `Included in ${targetName} again` });
      }
      setOpen(false);
      setReason('');
      onChanged();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Not saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border-subtle p-4">
      {exclusion === null ? (
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          Leave out of {targetName}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <StateBadge state="inactive">Left out</StateBadge>
          <span className="text-sm text-muted">{exclusion.message}</span>
          {canManage && (
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
              Include again
            </Button>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <Field
            label="Why"
            value={reason}
            onChange={setReason}
            required
            placeholder={exclusion === null ? 'Bootstrap administrator of this application' : undefined}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={busy || reason.trim() === ''}
              onClick={submit}
            >
              {exclusion === null ? 'Leave out' : 'Include again'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
