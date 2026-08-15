import { useEffect, useState } from 'react';
import { Alert, Empty, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { useSession } from '../session/SessionProvider.js';
import { ApiError, api } from '../session/api.js';
import { useApiResource } from '../session/use-api-resource.js';
import { routeFor, storeChallenge } from '../mfa/challenge-store.js';

interface Tile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  iconUrl: string | null;
}

type LaunchResponse =
  | { status: 'launch'; url: string }
  | {
      status: 'challenge';
      attemptToken: string;
      expiresAt: string;
      acceptableFactors: string[];
    }
  | {
      status: 'enrol';
      attemptToken: string;
      expiresAt: string;
      enrollableFactors: string[];
    };

/** Two letters from the name: no icon service, no network call, no CDN. */
function Monogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-soft font-semibold text-primary"
    >
      {initials}
    </span>
  );
}

export function Portal() {
  const { session } = useSession();
  const firstName = session?.displayName.split(' ')[0] ?? 'there';
  const { data, error, loading } = useApiResource<{ applications: Tile[] }>(
    '/api/portal/applications',
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  /**
   * Finishes a launch that was interrupted by a step-up.
   *
   * The tile the user clicked is carried through the challenge in the query
   * string, and retried once the new session exists. Guarded so a reload does
   * not open the application again.
   */
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('launch');
    if (!wanted || !data) return;
    const tile = data.applications.find((row) => row.id === wanted);
    window.history.replaceState({}, '', '/');
    if (tile) void launch(tile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function launch(tile: Tile) {
    setBusy(tile.id);
    setLaunchError(null);
    try {
      const result = await api<LaunchResponse>(
        `/api/portal/applications/${tile.id}/launch`,
        { method: 'POST' },
      );
      if (result.status === 'launch') {
        // noopener so the opened application cannot reach back into this tab.
        window.open(result.url, '_blank', 'noopener,noreferrer');
      } else {
        const kind = result.status === 'enrol' ? 'enrol' : 'verify';
        storeChallenge({
          kind,
          attemptToken: result.attemptToken,
          expiresAt: result.expiresAt,
          factors:
            result.status === 'enrol'
              ? result.enrollableFactors
              : result.acceptableFactors,
          // Come back and finish what the user was doing. Landing them on an
          // empty portal after a step-up they only entered because they
          // clicked a tile leaves them to guess that they should click it
          // again.
          returnTo: `/?launch=${tile.id}`,
        });
        window.location.assign(routeFor(kind));
      }
    } catch (cause) {
      setLaunchError(
        cause instanceof ApiError && cause.problem.status === 403
          ? `${tile.name} is not available to you right now.`
          : `${tile.name} could not be opened. Try again.`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold text-ink">Good day, {firstName}</h1>
          <p className="mt-1 text-muted">
            Applications your organization has assigned to you.
          </p>
        </header>

        <div className="mt-8 space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {launchError && <Alert tone="danger">{launchError}</Alert>}

          {loading && <SkeletonRows rows={3} cols={2} />}

          {!loading && data?.applications.length === 0 && (
            <Empty title="No applications assigned yet">
              When your administrator assigns applications to you, they appear here
              and open with a single click.
            </Empty>
          )}

          {!loading && data && data.applications.length > 0 && (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.applications.map((tile) => (
                <li key={tile.id}>
                  <button
                    type="button"
                    onClick={() => launch(tile)}
                    disabled={busy === tile.id}
                    aria-busy={busy === tile.id || undefined}
                    className="flex h-full w-full items-start gap-3 rounded-panel border border-border-subtle bg-bg p-4 text-left transition-colors duration-150 ease-out-quart hover:bg-surface disabled:opacity-55"
                  >
                    <Monogram name={tile.name} />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{tile.name}</span>
                      {tile.description && (
                        <span className="mt-0.5 block text-sm text-muted">
                          {tile.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
