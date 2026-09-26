import { useState, type FormEvent } from 'react';
import { Alert, Button, Panel, Textarea } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';

interface ImportResult {
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
}

const SAMPLE =
  'externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department';

export function ImportTab() {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [rejected, setRejected] = useState<
    { line: number; message: string }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    setRejected(null);
    setError(null);

    try {
      setResult(
        await api<ImportResult>('/api/admin/persons/import', {
          method: 'POST',
          body: JSON.stringify({ csv }),
        }),
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'csv-invalid') {
        setError('Nothing in this file could be imported.');
        setRejected(
          (cause.problem.errors ?? []).map((e) => ({
            line: e.line ?? 0,
            message: e.message,
          })),
        );
      } else if (cause instanceof ApiError && cause.problem.status === 403) {
        setError('You do not have permission to import people.');
      } else {
        setError('The import could not be completed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>

      <div className="space-y-6">
        <Panel
          title="CSV"
          bodyClassName="p-4"
        >
          <form onSubmit={onSubmit}>
            <Textarea
              label="Rows"
              mono
              value={csv}
              onChange={setCsv}
              rows={10}
              spellCheck={false}
              placeholder={SAMPLE}
            />
            <div className="mt-3 flex items-center gap-3">
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={csv.trim() === ''}
              >
                Import
              </Button>
              <dl className="flex flex-wrap gap-x-2 text-sm">
                <dt className="text-muted">Required columns</dt>
                <dd className="font-mono text-ink">
                  externalId, givenName, familyName, sequence, startDate
                </dd>
              </dl>
            </div>
          </form>
        </Panel>

        {error && (
          <Alert tone="danger" title={error}>
            {rejected && rejected.length > 0 ? (
              <RejectedLines lines={rejected} />
            ) : (
              <span>Check the required columns and try again.</span>
            )}
          </Alert>
        )}

        {result && result.errors.length > 0 && (
          <Alert
            tone="warning"
            title={`${result.created} created, ${result.updated} updated, ${result.errors.length} rejected`}
          >
            {/* A partial import that quietly drops rows is the worst outcome
                here: the operator would believe people were provisioned who
                were not. Every rejected line is named. */}
            <RejectedLines lines={result.errors} />
          </Alert>
        )}
        {result && result.errors.length === 0 && (
          <Alert tone="success">
            {`${result.created} created, ${result.updated} updated`}
          </Alert>
        )}
      </div>
    </>
  );
}

function RejectedLines({
  lines,
}: {
  lines: { line: number; message: string }[];
}) {
  return (
    <>
      <ul className="mt-2 space-y-1">
        {lines.map((entry) => (
          <li key={`${entry.line}-${entry.message}`} className="text-ink">
            <span className="font-medium tabular-nums">Line {entry.line}</span>
            <span className="text-muted"> — {entry.message}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
