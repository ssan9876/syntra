import { useState } from 'react';
import { Alert, Button, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface MailSettings {
  transport: 'smtp' | 'graph';
  server: string;
  from: string;
  recipient: string;
  warning: string | null;
}

interface TestResult {
  ok: boolean;
  to: string;
  server: string;
  message: string;
}

const TRANSPORT_LABEL: Record<MailSettings['transport'], string> = {
  smtp: 'SMTP',
  graph: 'Microsoft 365',
};

/**
 * Outgoing mail: how the installation sends it, and a test send to the
 * signed-in administrator. Read-only: the transport is set in the
 * environment (docs/configure.md, "Outgoing mail").
 *
 * The warning is the server's, shown while it applies: SMTP_URL points at a
 * local test server on an install with a real address.
 */
export function MailTab() {
  const { data, error, loading } = useApiResource<MailSettings>('/api/admin/mail');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  async function sendTest() {
    setBusy(true);
    setResult(null);
    try {
      const sent = await api<TestResult>('/api/admin/mail/test', { method: 'POST' });
      setResult({ tone: sent.ok ? 'success' : 'danger', text: sent.message });
    } catch (cause) {
      setResult({
        tone: 'danger',
        text: cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Test email not sent. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;

  return (
    <div className="space-y-4">
      {data?.warning && <Alert tone="warning">{data.warning}</Alert>}
      <Panel title="Outgoing mail">
        {loading && !data && <SkeletonRows rows={3} cols={2} />}
        {data && (
          <div className="space-y-4 p-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="font-medium text-ink">Transport</dt>
              <dd>{TRANSPORT_LABEL[data.transport]}</dd>
              <dt className="font-medium text-ink">Server</dt>
              <dd className="font-mono">{data.server}</dd>
              <dt className="font-medium text-ink">From</dt>
              <dd>{data.from}</dd>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" loading={busy} onClick={() => void sendTest()}>
                Send test email
              </Button>
              <span className="text-sm text-muted">To {data.recipient}</span>
            </div>
            <div aria-live="polite">{result ? <Alert tone={result.tone}>{result.text}</Alert> : null}</div>
          </div>
        )}
      </Panel>
    </div>
  );
}
