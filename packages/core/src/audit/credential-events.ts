import type { TenantClient } from '@syntra/db';
import { recordEvent } from './audit-service.js';

/**
 * `credential.changed`: a stored connector or federation credential was
 * replaced in place, outside the rotation workflow.
 *
 * One helper so the four places that replace one -- a target, a directory
 * source, an HR feed, an upstream identity provider -- say it the same way.
 * The payload names WHAT changed and never carries the value, the vault name,
 * or a digest of either.
 */
export async function recordConnectorCredentialChanged(
  tx: TenantClient,
  actorUserId: string | null,
  targetType: 'TargetSystem' | 'DirectorySource' | 'PersonSource' | 'UpstreamIdp',
  targetId: string,
  sourceIp: string | null = null,
): Promise<void> {
  await recordEvent(tx, {
    actorUserId,
    action: 'credential.changed',
    targetType,
    targetId,
    outcome: 'success',
    sourceIp,
    payload: { via: 'replace' },
  });
}
