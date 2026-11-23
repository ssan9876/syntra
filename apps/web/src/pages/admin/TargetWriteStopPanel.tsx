import type { Target } from './target-form.js';
import { ExternalWriteStopPanel } from './ExternalWriteStopPanel.js';
import { useConsoleT } from '../../i18n/console/index.js';

export function TargetWriteStopPanel({ target, onChanged }: { target: Target; onChanged(): void }) {
  const t = useConsoleT();
  return <ExternalWriteStopPanel
    title={t('writeStop.target_title')}
    stoppedTitle={t('writeStop.target_stopped')}
    state={{
      pausedAt: target.externalWritesPausedAt,
      pauseReason: target.externalWritesPauseReason,
      pauseExpiresAt: target.externalWritesPauseExpiresAt,
    }}
    basePath={`/api/admin/targets/${target.id}`}
    onChanged={onChanged}
  />;
}
