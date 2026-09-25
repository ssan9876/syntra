import { Alert, StateBadge } from '@syntra/ui';
import { StaleBadge } from './DraftState.js';

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
      <h5 className="font-medium text-ink">{title}</h5>
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
 *
 * `stale` is the editor saying the connection or search bases have changed
 * since: the counts were read from somewhere else, and must not look current.
 */
export function TestReport({ result, stale = false }: { result: TestResult; stale?: boolean }) {
  const counts = result.sampleCounts;
  return (
    <div className="space-y-3 sm:col-span-2" aria-label="Connection test result" role="group">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium text-ink">Connection test</h4>
        {stale && <StaleBadge />}
      </div>
      {!result.ok ? (
        <Alert tone="danger" title="Could not connect">
          {result.message}
        </Alert>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <StateBadge state="healthy">Connected</StateBadge>
            <span className="text-muted">{result.message}</span>
          </p>

          {counts && (
            <p className="text-ink">
              Found{' '}
              <strong className="font-semibold tabular-nums">{counts.user}</strong>{' '}
              users,{' '}
              <strong className="font-semibold tabular-nums">{counts.group}</strong>{' '}
              groups and{' '}
              <strong className="font-semibold tabular-nums">{counts.orgUnit}</strong>{' '}
              organizational units in the configured search bases.
            </p>
          )}

          {result.schema && (
            <>
              <Discovered title="Object classes it returned" values={result.schema.objectClasses} />
              <Discovered title="Attributes it returned" values={result.schema.attributes} />
            </>
          )}
        </>
      )}
    </div>
  );
}
