import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

interface Progress {
  step: string;
  detail: string;
  at: string | null;
  running: boolean;
}

interface Availability {
  current: string;
  updatable: boolean;
  reason: string | null;
  updateAvailable: boolean;
  latest: {
    version: string;
    released: string | null;
    notes: string;
    migrations: string[];
  } | null;
  progress: Progress | null;
}

/** Steps after which the updater is not coming back. */
const TERMINAL = new Set(['succeeded', 'rolled_back', 'failed']);

/** How the updater's step names read to somebody who did not write them. */
const STEP_TEXT: Record<string, string> = {
  downloading: 'Downloading the release',
  verifying: 'Checking it is intact',
  unpacking: 'Unpacking',
  installing: 'Installing dependencies',
  generating: 'Preparing the database client',
  'backing-up': 'Backing up the database',
  migrating: 'Applying database changes',
  switching: 'Restarting on the new version',
  checking: 'Checking the new version works',
  'rolling-back': 'Putting the previous version back',
  pruning: 'Tidying up',
  succeeded: 'Update complete',
  rolled_back: 'Rolled back',
  failed: 'Update failed',
};

/**
 * Updating the deployment.
 *
 * The page is written around one fact that most update screens get to ignore:
 * **it is updating the thing serving it.** Between the restart and the new
 * version becoming ready this page cannot reach the API at all, so a failed
 * poll here is the expected middle of a successful update rather than an
 * error. Anything that treated a dropped request as a failure would show a
 * red banner every single time.
 */
export function UpdatesPage() {
  const [data, setData] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** True once the API has stopped answering — i.e. the restart has begun. */
  const [restarting, setRestarting] = useState(false);
  /**
   * True from the moment this page launched an update until it has seen the
   * updater stop. Not derived from `progress`: for the first few seconds there
   * IS no progress -- the status file is written by a detached unit that has
   * not started yet -- and a page that trusted the absence of one concluded
   * nothing was happening and stopped looking.
   */
  const [launched, setLaunched] = useState(false);

  const load = useCallback(async (quiet = false) => {
    try {
      // The QUIET path asks the cheap route. `/api/admin/update` re-queries
      // the forge every time; at one poll every three seconds that is a
      // GitHub round trip per tick, to re-learn a release list that cannot
      // have changed during an update. `/update/status` reads the status file
      // and nothing else.
      if (quiet) {
        const { progress } = await api<{ progress: Progress | null }>(
          '/api/admin/update/status',
        );
        setData((previous) => (previous ? { ...previous, progress } : previous));
        setRestarting(false);
        if (progress && TERMINAL.has(progress.step)) {
          setLaunched(false);
          // One full read, now that it is over: the running version has
          // changed and the availability with it.
          void load();
        }
        return;
      }

      const next = await api<Availability>('/api/admin/update');
      setData(next);
      setRestarting(false);
      setError(null);
      if (next.progress && TERMINAL.has(next.progress.step)) setLaunched(false);
    } catch (cause) {
      // While the service is restarting this WILL fail, and that is the
      // update working. Only a foreground load reports a problem.
      if (quiet) {
        setRestarting(true);
        return;
      }
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The update status could not be read.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is happening. A page that polls forever keeps a
  // request every three seconds against a system nobody is updating.
  //
  // `launched` is in the condition and it is load-bearing. The updater is a
  // detached systemd unit: for the first seconds after a 202 there is no
  // status file at all, and a condition built only on `running` read that
  // absence as "finished" and stopped -- leaving the page static, with the
  // button live, while the server restarted underneath it.
  const running = data?.progress?.running ?? false;
  useEffect(() => {
    if (!running && !restarting && !launched) return;
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [running, restarting, launched, load]);

  async function start(version: string) {
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/update', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      setConfirming(false);
      setLaunched(true);
      setRestarting(true);
      // Deliberately NOT loading here. That request succeeds -- the API is
      // still up, the restart has not happened yet -- and its success used to
      // clear `restarting` before the first tick, which with no status file
      // yet written cleared the interval for good. The first poll is three
      // seconds away and knows more than this one would.
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'The update could not be started.',
      );
    } finally {
      setBusy(false);
    }
  }

  const latest = data?.latest ?? null;
  const progress = data?.progress ?? null;

  return (
    <>
      <PageHeader
        title="Updates"
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {restarting && (
        <div className="mb-4">
          <Alert tone="warning" title="Syntra is restarting">
            This page cannot reach the server while the new version starts. It
            will reconnect on its own — do not reload or navigate away.
          </Alert>
        </div>
      )}

      {loading && (
        <Panel>
          <SkeletonRows rows={3} cols={2} />
        </Panel>
      )}

      {!loading && data && (
        <div className="space-y-4">
          <Panel title="This deployment">
            <div className="space-y-3 p-4">
              <p className="text-ink">
                Running{' '}
                <strong className="font-semibold">{data.current}</strong>
                {data.current === 'dev' && (
                  <span className="text-muted">
                    {' '}
                    — a working tree rather than a release
                  </span>
                )}
              </p>
              {!data.updatable && data.reason && (
                // Not an error tone. A developer checkout being un-updatable
                // is the correct state for a developer checkout, and colouring
                // it red teaches people to ignore red.
                <Alert tone="info" title="Not updatable from here">
                  {data.reason}
                </Alert>
              )}
            </div>
          </Panel>

          {progress && (
            <Panel title="Last update">
              <div className="space-y-2 p-4">
                <p className="text-ink">
                  {STEP_TEXT[progress.step] ?? progress.step}
                  {progress.running && <span className="text-muted"> — in progress</span>}
                </p>
                {progress.detail && <p className="text-muted">{progress.detail}</p>}
                {progress.step === 'rolled_back' && (
                  <Alert tone="warning" title="The update was undone">
                    The new version did not come up, so the previous one was put
                    back automatically, along with the database as it was
                    immediately before the update — schema and data both.
                    Anything that happened in the minutes between the backup and
                    the rollback is not in it: a sign-in, a sync run, a
                    provisioning action.
                  </Alert>
                )}
                {progress.step === 'failed' && (
                  <Alert tone="danger" title="The update failed">
                    {progress.detail}
                  </Alert>
                )}
              </div>
            </Panel>
          )}

          {data.updatable && (
            <Panel title="Available">
              {/* A FAILED LOOKUP IS NOT AN EMPTY ONE. This read "Nothing to
                  show" for both, with the reason as body text under it, so a
                  revoked token and a healthy deployment on the newest release
                  presented the same heading -- and the heading is what a
                  reader takes away. The reason was always here; what was
                  missing was saying it had gone wrong. */}
              {latest === null && (
                <div className="p-4">
                  <Alert tone="warning" title="Could not check for updates">
                    {data.reason ??
                      'No releases were found for this deployment.'}
                  </Alert>
                </div>
              )}

              {latest !== null && !data.updateAvailable && (
                <div className="p-4 text-ink">
                  This is the newest release ({latest.version}).
                </div>
              )}

              {latest !== null && data.updateAvailable && (
                <div className="space-y-4 p-4">
                  <p className="text-ink">
                    <strong className="font-semibold">{latest.version}</strong>
                    {latest.released && (
                      <span className="text-muted">
                        {' '}
                        · released {latest.released.slice(0, 10)}
                      </span>
                    )}
                  </p>

                  {latest.notes && (
                    <div className="whitespace-pre-wrap rounded-panel border border-border-subtle bg-surface-2 p-3 text-ink">
                      {latest.notes}
                    </div>
                  )}

                  {/* Not merely `disabled`: `disabled` still leaves an
                      element for `getByRole` to find, so a page that had
                      launched an update and only disabled this button was
                      still, technically, "offering" it. While this page has
                      launched something and has not yet seen it stop, there
                      is nothing to offer. */}
                  {!confirming && !launched && (
                    <div className="flex justify-end">
                      <Button
                        disabled={busy || (progress?.running ?? false)}
                        onClick={() => setConfirming(true)}
                      >
                        Update to {latest.version}
                      </Button>
                    </div>
                  )}

                  {confirming && (
                    <div className="space-y-3">
                      {/* Says what happens, in order, before it happens. A
                          confirmation that asks "are you sure?" without saying
                          what follows is one people click through. */}
                      <Alert tone="warning" title="What this will do">
                        <ul className="ml-4 list-disc space-y-1">
                          <li>Back up the database, and stop if that fails.</li>
                          <li>Apply any database changes this release brings.</li>
                          <li>
                            Restart Syntra.{' '}
                            <strong className="font-semibold">
                              Signing in will stop working for about a minute
                            </strong>
                            , and everyone signed in now stays signed in.
                          </li>
                          <li>
                            Check the new version actually works — and if it does
                            not, put {data.current} back automatically, database
                            included, without needing anyone to be here.
                          </li>
                        </ul>
                      </Alert>
                      <div className="flex justify-end gap-2">
                        <Button
                          loading={busy}
                          disabled={busy}
                          onClick={() => void start(latest.version)}
                        >
                          Update now
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setConfirming(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
