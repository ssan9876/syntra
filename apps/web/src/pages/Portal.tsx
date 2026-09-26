import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { AppLogo } from '../components/AppLogo.js';
import { SupportLink } from '../branding/SupportLink.js';
import { useT } from '../i18n/LocaleProvider.js';
import { useSession } from '../session/SessionProvider.js';
import { ApiError, api } from '../session/api.js';
import { useApiResource } from '../session/use-api-resource.js';
import { routeFor, storeChallenge } from '../mfa/challenge-store.js';
import { usePortalPrefs, RECENT_LIMIT } from './portal-prefs.js';
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

/**
 * A filter box earns its place past about a dozen tiles. Below that the whole
 * set is on one screen, and a text field above it is one more thing to read
 * on a page PRODUCT.md says people look at for four seconds.
 */
const FILTER_THRESHOLD = 12;

/**
 * The tile's logo: a built-in mark or an uploaded image the API hosts, or the
 * monogram. `AppLogo` is shared with the console's logo picker, so the
 * preview an administrator approves is the tile an employee sees.
 */
function TileIcon({ tile }: { tile: ApplicationTile }) {
  return <AppLogo name={tile.name} src={tile.iconUrl} />;
}

/** Pin glyph: outlined when off, filled when on, so state is never colour alone. */
function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 2h5l-.75 4.25L12 8.5H4l2.25-2.25zM8 8.5V14" />
    </svg>
  );
}

/**
 * One tile: the launch button and the pin toggle, as SIBLINGS.
 *
 * Not a pin button inside the launch button — interactive content nested in a
 * button is invalid, screen readers flatten it into one control, and a tap
 * meant for the pin opens the application. The pin sits in the tile's corner
 * on top of the launch button, and the launch button leaves room for it.
 *
 * The pin has words as well as a glyph ("Pin", "Unpin"): the design system has
 * no icon-only controls, and on a shared PC the person tapping it may never
 * have seen a pin icon mean anything.
 */
function Tile({
  tile,
  busy,
  pinned,
  onLaunch,
  onTogglePin,
}: {
  tile: ApplicationTile;
  busy: boolean;
  pinned: boolean;
  onLaunch(): void;
  onTogglePin(): void;
}) {
  const t = useT();
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onLaunch}
        disabled={busy}
        aria-busy={busy || undefined}
        /* `border-control`, not `border-subtle`: the whole tile IS the
           button, so its edge is the boundary of a control and 1.4.11 asks
           3:1 of it. At 1.44:1 the tiles read as floating text on a white
           page rather than as things to press — which is the entire portal
           for the person who only ever sees this screen. */
        className="flex h-full w-full items-start gap-3 rounded-panel border border-border-control bg-bg p-4 pr-20 text-left transition-[background-color,border-color,box-shadow] duration-150 ease-out-quart hover:border-primary hover:bg-surface hover:shadow-raised disabled:opacity-55"
      >
        <TileIcon tile={tile} />
        <span className="min-w-0">
          <span className="block font-semibold text-ink">{tile.name}</span>
          {tile.description && (
            <span className="mt-0.5 block text-sm text-muted">{tile.description}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={t(pinned ? 'portal.unpin_label' : 'portal.pin_label', { name: tile.name })}
        className={[
          'absolute top-2 right-2 inline-flex items-center gap-1 rounded-control px-1.5 py-1 text-xs font-medium',
          'transition-colors duration-150 ease-out-quart',
          pinned ? 'text-primary hover:bg-primary-soft' : 'text-muted hover:bg-surface-2 hover:text-ink',
        ].join(' ')}
      >
        <PinGlyph filled={pinned} />
        {t(pinned ? 'portal.unpin' : 'portal.pin')}
      </button>
    </li>
  );
}

/**
 * A heading and its count, then the tiles.
 *
 * The count is a sibling of the heading and not inside it, so the heading
 * still reads as the category's name to a screen reader's heading list; the
 * figure is tabular so "9" and "12" line up down the page.
 */
function TileSection({
  title,
  tiles,
  children,
}: {
  title: string | null;
  tiles: number;
  children: ReactNode;
}) {
  return (
    <section>
      {title !== null && (
        <div className="mb-3 flex items-baseline gap-2 border-b border-border-subtle pb-1.5">
          <h2 className="text-md font-semibold tracking-tight text-ink">{title}</h2>
          <span className="text-sm font-medium tabular-nums text-muted">{tiles}</span>
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>
    </section>
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
  const [query, setQuery] = useState('');
  const { pinned, recent, togglePin, recordLaunch } = usePortalPrefs(session?.userId);

  const tiles = useMemo(() => data?.applications ?? [], [data]);
  const byId = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles]);

  // Resolved against what is assigned NOW. An id remembered from last week for
  // an application since withdrawn is skipped, never drawn as a dead tile.
  const pinnedTiles = pinned.flatMap((id) => byId.get(id) ?? []);
  // Pinned tiles are left out of "Recently used": the same tile twice in the
  // first two rows is a row spent saying nothing new.
  const recentTiles = recent
    .filter((id) => !pinned.includes(id))
    .flatMap((id) => byId.get(id) ?? [])
    .slice(0, RECENT_LIMIT);

  const showFilter = tiles.length > FILTER_THRESHOLD;
  const needle = showFilter ? query.trim().toLocaleLowerCase() : '';
  const filtered = needle
    ? tiles.filter((tile) =>
        [tile.name, tile.description, tile.category].some((field) =>
          field?.toLocaleLowerCase().includes(needle),
        ),
      )
    : tiles;
  const groups = groupTiles(filtered);
  // The shortcut rows step aside while somebody is filtering: the result is
  // the answer, and a pinned row above it that ignores the query reads as
  // results that do not match.
  const shortcuts = !needle && (pinnedTiles.length > 0 || recentTiles.length > 0);

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
    if (tile) void launch(tile).then((opened) => opened && recordLaunch(tile.id));
  }, [data, recordLaunch]);

  /**
   * Resolves true when the application was opened, so the caller can record it
   * under "Recently used". Recorded by the caller rather than in here to keep
   * this function free of anything the step-up effect above would then have
   * to list as a dependency.
   */
  async function launch(tile: ApplicationTile): Promise<boolean> {
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
        return true;
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
    return false;
  }

  const renderTile = (tile: ApplicationTile) => (
    <Tile
      key={tile.id}
      tile={tile}
      busy={busy === tile.id}
      pinned={pinned.includes(tile.id)}
      onLaunch={() => void launch(tile).then((opened) => opened && recordLaunch(tile.id))}
      onTogglePin={() => togglePin(tile.id)}
    />
  );

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        {/* The greeting, and nothing under it. The lead said "Applications
            your organization has assigned to you", above a grid of the
            applications the organization has assigned to you — a sentence
            describing the thing directly beneath it, on the one screen
            PRODUCT.md says people look at for four seconds. The tenant's
            "Get help" sits opposite it, when the tenant has set one: the
            person who cannot find their application is on this page. */}
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            {t('portal.greeting', { name: firstName })}
          </h1>
          <SupportLink className="text-sm" />
        </header>

        {showFilter && (
          <div className="mt-6 max-w-sm">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('portal.filter')}
              placeholder={t('portal.filter')}
              className="h-9 w-full rounded-control border border-border-control bg-bg px-3 text-ink transition-colors duration-150 placeholder:text-muted hover:border-border-strong"
            />
          </div>
        )}

        <div className="mt-8 space-y-8">
          {error && <Alert tone="danger">{error}</Alert>}
          {launchError && <Alert tone="danger">{launchError}</Alert>}

          {!data && loading && <SkeletonRows rows={3} cols={2} />}

          {data && tiles.length === 0 && (
            <Empty title={t('portal.empty_title')} />
          )}

          {data && tiles.length > 0 && needle && filtered.length === 0 && (
            <Empty
              title={t('portal.no_match', { query: query.trim() })}
              action={
                <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
                  {t('portal.clear_filter')}
                </Button>
              }
            />
          )}

          {shortcuts && pinnedTiles.length > 0 && (
            <TileSection title={t('portal.pinned')} tiles={pinnedTiles.length}>
              {pinnedTiles.map(renderTile)}
            </TileSection>
          )}

          {shortcuts && recentTiles.length > 0 && (
            <TileSection title={t('portal.recent')} tiles={recentTiles.length}>
              {recentTiles.map(renderTile)}
            </TileSection>
          )}

          {groups.map((group) => (
            /*
              A single group carries no heading — "General" above every tile a
              small organisation has says nothing. The one exception is when a
              Pinned or Recently used row sits above it: then the heading is
              what separates the shortcuts from the full set, and without it
              the two grids run together into one list with duplicates.
            */
            <TileSection
              key={group.name ?? 'uncategorised'}
              title={
                group.showHeading
                  ? (group.name ?? t('portal.other_group'))
                  : shortcuts
                    ? t('portal.all_group')
                    : null
              }
              tiles={group.tiles.length}
            >
              {group.tiles.map(renderTile)}
            </TileSection>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
