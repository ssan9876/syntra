import { useState, type FormEvent } from 'react';
import { Alert, Button, Panel } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

interface ImportResult {
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
}

const SAMPLE =
  'externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department';

export function ImportPage() {
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
      <PageHeader
        title="Import people"
        description="Paste a CSV export from your HR system. Re-importing the same file changes nothing, so it is safe to run twice."
      />

      <div className="space-y-6">
        <Panel
          title="CSV"
          description="One row per contract. A person with two concurrent contracts has two rows sharing an externalId."
          bodyClassName="p-4"
        >
          <form onSubmit={onSubmit}>
            <label htmlFor="csv" className="mb-1.5 block font-medium text-ink">
              Rows
            </label>
            <textarea
              id="csv"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={SAMPLE}
              className="w-full rounded-control border border-border-subtle bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-muted hover:border-border-strong"
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
              <span className="text-sm text-muted">
                Required columns: externalId, givenName, familyName, sequence,
                startDate
              </span>
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

        {result && (
          <Alert
            tone={result.errors.length > 0 ? 'warning' : 'info'}
            title={
              result.errors.length > 0
                ? `${result.created} created, ${result.updated} updated, ${result.errors.length} rejected`
                : `${result.created} created, ${result.updated} updated`
            }
          >
            {result.errors.length > 0 ? (
              // A partial import that quietly drops rows is the worst outcome
              // here: the operator would believe people were provisioned who
              // were not. Every rejected line is named.
              <RejectedLines lines={result.errors} />
            ) : (
              <span>Every row in the file was imported.</span>
            )}
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
      <p className="text-ink">
        These rows were not imported and need correcting:
      </p>
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
