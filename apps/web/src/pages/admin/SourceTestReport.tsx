import { Alert, Panel, Status } from '@syntra/ui';

export interface TestResult {
  ok: boolean;
  message: string;
  sampleCounts?: Record<'user' | 'group' | 'orgUnit', number>;
  schema: { objectClasses: string[]; attributes: string[] } | null;
}

function Discovered({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div>
      <h3 className="font-medium text-ink">{title}</h3>
      <p className="mt-1 text-muted">{values.join(', ')}</p>
    </div>
  );
}

/**
 * What the directory answered, before anything is saved.
 *
 * The counts say the connection works and the search bases are pointed
 * somewhere real; the object classes and attributes are what the spec's first
 * success criterion asks for, and are what an administrator needs in front of
 * them while filling in the mapping table below.
 */
export function TestReport({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Could not connect">
        {result.message}
      </Alert>
    );
  }

  const counts = result.sampleCounts;
  return (
    <Panel title="Connection test">
      <div className="space-y-4 p-4">
        <p className="flex flex-wrap items-center gap-2">
          <Status tone="active">Connected</Status>
          <span className="text-muted">{result.message}</span>
        </p>

        {counts && (
          <p className="text-ink">
            Found{' '}
            <strong className="font-semibold tabular-nums">{counts.user}</strong>{' '}
            users,{' '}
            <strong className="font-semibold tabular-nums">
              {counts.group}
            </strong>{' '}
            groups and{' '}
            <strong className="font-semibold tabular-nums">
              {counts.orgUnit}
            </strong>{' '}
            organizational units in the configured search bases.
          </p>
        )}

        {result.schema && (
          <>
            <Discovered
              title="Object classes it returned"
              values={result.schema.objectClasses}
            />
            <Discovered
              title="Attributes it returned"
              values={result.schema.attributes}
            />
          </>
        )}
      </div>
    </Panel>
  );
}
