import { Alert } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { ExternalWriteStopPanel, type WriteStopState } from './ExternalWriteStopPanel.js';

interface TenantWriteStop extends WriteStopState {
  active: boolean;
  pausedByUserId: string | null;
  resumedAt: string | null;
  resumedByUserId: string | null;
}

/**
 * The tenant-wide emergency stop, on the target list: the screen every
 * provisioning operator passes through, so a stop that halts every target is
 * hard to miss and the control to place one is where an incident would look
 * for it.
 *
 * Renders nothing until the state has loaded. A control that briefly shows
 * "allowed" and then flips to "paused" would be read, in an incident, as the
 * stop having just been placed.
 */
export function TenantWriteStopPanel() {
  const { data, error, reload } = useApiResource<TenantWriteStop>('/api/admin/provision/external-write-stop');
  if (error) return <Alert tone="warning">The tenant-wide external-write stop could not be read: {error}</Alert>;
  if (!data) return null;
  return <ExternalWriteStopPanel
    title="Tenant-wide external writes"
    stoppedTitle="All provisioning writes are stopped for every target in this tenant"
    state={{ pausedAt: data.pausedAt ?? null, pauseReason: data.pauseReason ?? null, pauseExpiresAt: data.pauseExpiresAt ?? null }}
    basePath="/api/admin/provision"
    onChanged={reload}
  />;
}
