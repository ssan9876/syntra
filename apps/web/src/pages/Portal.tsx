import { useEffect, useState } from 'react';
import { Alert, Empty, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { useT } from '../i18n/LocaleProvider.js';
import { useSession } from '../session/SessionProvider.js';
import { ApiError, api } from '../session/api.js';
import { useApiResource } from '../session/use-api-resource.js';
import { routeFor, storeChallenge } from '../mfa/challenge-store.js';
// The CONTRACT, not a local restatement. The API builds this response by hand
// and this file described it independently, so the two could drift with
// nothing anywhere to notice -- which is the whole reason the schema exists.
// Type-only: a runtime parse in the browser would strip a field the server had
// legitimately started sending.
import type { ApplicationTile } from '@syntra/contracts';


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


/**
 * The tiles, grouped under their headings.
 *
 * Uncategorised tiles go LAST, under a heading of their own, rather than
 * first or scattered: somebody who has categorised most of their applications
 * has said what the important groups are, and the remainder is the leftover.
 *
 * A single group carries no heading at all. "General" above every tile a small
 * organisation has is a word that says nothing and one more thing to read on a
 * screen PRODUCT.md says people look at for four seconds.
 *
 * Categories are ordered by name, not by tile count. A page whose headings
 * move when somebody is assigned an application is a page nobody can learn.
 */
function groupTiles(tiles: ApplicationTile[]) {
  const byCategory = new Map<string | null, ApplicationTile[]>();
  for (const tile of tiles) {
    const key = tile.category?.trim() || null;
    byCategory.set(key, [...(byCategory.get(key) ?? []), tile]);
  }

  const named = [...byCategory.entries()]
    .filter(([name]) => name !== null)
    .sort(([a], [b]) => a!.localeCompare(b!));
  const rest = byCategory.get(null);

  const groups = [
    ...named.map(([name, group]) => ({ name, tiles: group })),
    ...(rest ? [{ name: null as string | null, tiles: rest }] : []),
  ];

  const showHeading = groups.length > 1;
  return groups.map((group) => ({ ...group, showHeading }));
}

export function Portal() {
  const t = useT();
  const { session } = useSession();
  const firstName = session?.displayName.split(' ')[0] ?? 'there';
  const { data, error, loading } = useApiResource<{ applications: ApplicationTile[] }>(
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

  async function launch(tile: ApplicationTile) {
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
        {/* The greeting, and nothing under it. The lead said "Applications
            your organization has assigned to you", above a grid of the
            applications the organization has assigned to you — a sentence
            describing the thing directly beneath it, on the one screen
            PRODUCT.md says people look at for four seconds. */}
        <header>
          <h1 className="text-2xl font-semibold text-ink">
            {t('portal.greeting', { name: firstName })}
          </h1>
        </header>

        <div className="mt-8 space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {launchError && <Alert tone="danger">{launchError}</Alert>}

          {loading && <SkeletonRows rows={3} cols={2} />}

          {!loading && data?.applications.length === 0 && (
            <Empty title={t('portal.empty_title')}>{t('portal.empty_body')}</Empty>
          )}

          {!loading &&
            data &&
            data.applications.length > 0 &&
            groupTiles(data.applications).map((group) => (
              <section key={group.name ?? 'uncategorised'}>
                {/*
                  The heading is shown only when there is more than one group.
                  A single "General" above every tile a small organisation has
                  is a word that carries no information and one more thing to
                  read on a screen PRODUCT.md says people see for four seconds.
                */}
                {group.showHeading && (
                  <h2 className="mb-2 text-md font-semibold text-ink">
                    {group.name ?? t('portal.other_group')}
                  </h2>
                )}
                <ul className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.tiles.map((tile) => (
                <li key={tile.id}>
                  <button
                    type="button"
                    onClick={() => launch(tile)}
                    disabled={busy === tile.id}
                    aria-busy={busy === tile.id || undefined}
                    /* `border-control`, not `border-subtle`: the whole tile
                       IS the button, so its edge is the boundary of a control
                       and 1.4.11 asks 3:1 of it. At 1.44:1 the tiles read as
                       floating text on a white page rather than as things to
                       press — which is the entire portal for the person who
                       only ever sees this screen. */
                    className="flex h-full w-full items-start gap-3 rounded-panel border border-border-control bg-bg p-4 text-left transition-[background-color,border-color,box-shadow] duration-150 ease-out-quart hover:border-primary hover:bg-surface hover:shadow-raised disabled:opacity-55"
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
              </section>
            ))}
        </div>
      </div>
    </AppShell>
  );
}
