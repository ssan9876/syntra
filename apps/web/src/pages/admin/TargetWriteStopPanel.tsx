import type { Target } from './target-form.js';
import { ExternalWriteStopPanel } from './ExternalWriteStopPanel.js';

export function TargetWriteStopPanel({ target, onChanged }: { target: Target; onChanged(): void }) {
  return <ExternalWriteStopPanel
    title="External writes"
    stoppedTitle="Provisioning writes are stopped"
    state={{
      pausedAt: target.externalWritesPausedAt,
      pauseReason: target.externalWritesPauseReason,
      pauseExpiresAt: target.externalWritesPauseExpiresAt,
    }}
    basePath={`/api/admin/targets/${target.id}`}
    onChanged={onChanged}
  />;
}
