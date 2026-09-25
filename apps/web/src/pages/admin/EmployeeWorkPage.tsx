import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  BulkActionBar,
  Checkbox,
  DensityToggle,
  Empty,
  FilterBar,
  FilterChips,
  ListControls,
  Pager,
  Panel,
  RefreshStatus,
  Segmented,
  SkeletonRows,
  StateBadge,
  Table,
  TableToolbar,
  buttonClasses,
  relativeTime,
  useDensity,
  useToast,
  type ActiveFilter,
  type State,
} from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { api, ApiError } from '../../session/api.js';
import { useOptionalSession } from '../../session/SessionProvider.js';
import { PageHeader } from './PageHeader.js';

type Lane = 'action' | 'waiting' | 'blocked' | 'overdue';
type Kind = 'onboarding' | 'offboarding' | 'failed';

interface WorkItem {
  id: string;
  kind: Kind;
  personId: string | null;
  personName: string;
  status: string;
  summary: string;
  updatedAt: string;
  lifecycleKind?: string | null;
  priority?: string | null;
  overdue?: boolean;
  overdueReason?: string | null;
  approvalRequired?: boolean;
  targetName?: string | null;
  ownerName?: string | null;
  lane?: Lane;
}

interface Work {
  counts: { onboarding: number; offboarding: number; failed: number; total: number };
  /** Absent from an older server; the lanes then fall back to kind alone. */
  lanes?: Record<Lane, number>;
  items: WorkItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface BulkResult {
  approvalRequired: boolean;
  succeeded?: number;
  failed?: number;
  results: { operationId: string; ok: boolean; message?: string }[];
}

/**
 * The four lanes, in the order an operator should work them.
 *
 * The queue used to be a count of onboarding, offboarding and failed work —
 * what each item is ABOUT. That is the wrong first question at 8:40 in the
 * morning. The first question is what each item needs from ME: something
 * breached its deadline, something cannot proceed without a person, something
 * is waiting on me to approve or finish it, or something is waiting on a
 * target and must be left alone. The server assigns every item exactly one
 * lane, by that precedence, so the four counts add up to the queue.
 */
const LANES: { id: Lane; label: string; badge: string; state: State }[] = [
  { id: 'overdue', label: 'Overdue', badge: 'Overdue', state: 'blocked' },
  { id: 'blocked', label: 'Blocked', badge: 'Blocked', state: 'blocked' },
  { id: 'action', label: 'Needs action', badge: 'Act now', state: 'attention' },
  // The card's own label says it in full; the badge only has to carry the
  // state, and "Waiting for verification" twice did not fit a phone.
  { id: 'waiting', label: 'Waiting for verification', badge: 'Pending', state: 'pending' },
];

const LANE_BY_ID = Object.fromEntries(LANES.map((lane) => [lane.id, lane])) as Record<Lane, (typeof LANES)[number]>;

const KIND_LABELS: Record<Kind, string> = {
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
  failed: 'Failed',
};

/**
 * Views an HR operations team opens every day, one click away.
 *
 * Each is only a query string — the URL stays the single source of the
 * filter, so a view pasted into a ticket opens the same list. The built-in
 * ones are the four the usability review named; a reader can add their own,
 * kept in this browser, because what one team calls "my morning list" is not
 * something the product can decide for everybody.
 */
const BUILT_IN_VIEWS: { name: string; query: string }[] = [
  { name: 'All unresolved', query: '' },
  { name: 'New starters', query: 'kind=onboarding' },
  { name: 'Departures', query: 'kind=offboarding' },
  { name: 'Failed provisioning', query: 'kind=failed' },
  { name: 'Overdue verification', query: 'lane=overdue' },
];

/** The params that make up a view. Paging is where you are, not what you asked for. */
const VIEW_PARAMS = ['lane', 'kind', 'q'] as const;

function viewQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of VIEW_PARAMS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  out.sort();
  return out.toString();
}

function normalise(query: string) {
  const params = new URLSearchParams(query);
  params.sort();
  return params.toString();
}

function useSavedViews(userId: string | undefined) {
  const key = `syntra.employee-work.views.${userId ?? 'anonymous'}`;
  const [views, setViews] = useState<{ name: string; query: string }[]>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored ? (JSON.parse(stored) as { name: string; query: string }[]) : [];
    } catch {
      return [];
    }
  });
  const persist = useCallback(
    (next: { name: string; query: string }[]) => {
      setViews(next);
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(next));
      } catch {
        /* storage refused: the view lasts this visit */
      }
    },
    [key],
  );
  return [views, persist] as const;
}

/** Where an item is worked, and what that link should say. */
function nextStep(item: WorkItem): { to: string; label: string } | null {
  if (item.id.startsWith('lifecycle:')) {
    return {
      to: `/admin/lifecycle-operations/${item.id.slice('lifecycle:'.length)}`,
      label: item.approvalRequired ? 'Review approval' : 'Open operation',
    };
  }
  if (!item.personId) return null;
  if (item.id.startsWith('departure:')) {
    return { to: `/admin/people/${item.personId}`, label: 'Finish departure' };
  }
  return {
    to: `/admin/people/${item.personId}`,
    label: item.kind === 'failed' ? 'Review failure' : 'View receipts',
  };
}

/** Old servers return no lane; derive the obvious one so the badge still reads. */
function laneOf(item: WorkItem): Lane {
  if (item.lane) return item.lane;
  if (item.overdue) return 'overdue';
  if (item.kind === 'failed') return 'blocked';
  if (item.status === 'incomplete' || item.approvalRequired) return 'action';
  return 'waiting';
}

/**
 * The operational home for joiners, movers and leavers.
 *
 * It was a row of six figures above a table: the right data, composed as a
 * report. An operator could not tell from it which three rows to do first,
 * whether a count was already filtered, or whether the retry they just ran
 * had taken. What is here now answers those in the order they are asked —
 * which lane, which view, which rows, and what happened.
 */
export function EmployeeWorkPage() {
  const [params, setParams] = useSearchParams();
  const session = useOptionalSession();
  const toast = useToast();
  const lane = (params.get('lane') as Lane | null) ?? null;
  const kind = (params.get('kind') as Kind | null) ?? null;
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (kind) query.set('kind', kind);
  if (lane) query.set('lane', lane);
  if (q) query.set('q', q);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();
  const { data, error, loading, reload, updatedAt } = useApiResource<Work>(
    `/api/admin/employee-work${qs ? `?${qs}` : ''}`,
  );

  const [density, setDensity] = useDensity('employee-work');
  const [savedViews, setSavedViews] = useSavedViews(session?.userId);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'acknowledge' | 'retry' | null>(null);
  const [bulkOutcome, setBulkOutcome] = useState<ReactNode>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const update = useCallback(
    (next: Record<string, string>, replaceHistory = false) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      setParams(merged, { replace: replaceHistory });
      // A selection belongs to the rows it was made on. Carrying it into a
      // different filter would let "Retry selected" act on rows nobody can
      // see.
      setSelected(new Set());
      setBulkOutcome(null);
    },
    [params, setParams],
  );
  const onSearch = useCallback((value: string) => update({ q: value, page: '' }, true), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);

  const bulk = useCallback(
    async (action: 'acknowledge' | 'retry') => {
      if (selected.size === 0) return;
      setBusy(action);
      setActionError(null);
      setBulkOutcome(null);
      try {
        const result = await api<BulkResult | undefined>('/api/admin/lifecycle-operations/bulk', {
          method: 'POST',
          body: JSON.stringify({ action, operationIds: [...selected] }),
        });
        const verb = action === 'acknowledge' ? 'acknowledged' : 'queued for retry';
        if (result?.approvalRequired) {
          setBulkOutcome('Nothing was retried yet: policy requires a second person to approve this bulk retry.');
          toast({ tone: 'info', title: 'Bulk retry sent for approval' });
        } else {
          const succeeded = result?.succeeded ?? selected.size;
          const failed = result?.failed ?? 0;
          const refusals = (result?.results ?? []).filter((r) => !r.ok);
          setBulkOutcome(
            <>
              {succeeded} {verb}
              {failed > 0 && (
                <>
                  {', '}
                  <span className="font-medium text-danger">{failed} could not be</span>
                  {refusals[0]?.message ? `: ${refusals[0].message}` : ''}
                </>
              )}
            </>,
          );
          if (succeeded > 0) {
            toast({ tone: failed > 0 ? 'warning' : 'success', title: `${succeeded} operation${succeeded === 1 ? '' : 's'} ${verb}` });
          }
        }
        setSelected(new Set());
        reload();
      } catch (cause) {
        setActionError(
          cause instanceof ApiError
            ? cause.problem.detail ?? cause.problem.title
            : 'The selected operations could not be updated.',
        );
      } finally {
        setBusy(null);
      }
    },
    [reload, selected, toast],
  );

  const currentView = viewQuery(params);
  const activeFilters: ActiveFilter[] = useMemo(() => {
    const filters: ActiveFilter[] = [];
    if (lane && LANE_BY_ID[lane]) {
      filters.push({ key: 'lane', label: `Lane: ${LANE_BY_ID[lane].label}`, onRemove: () => update({ lane: '', page: '' }) });
    }
    if (kind && KIND_LABELS[kind]) {
      filters.push({ key: 'kind', label: `Work: ${KIND_LABELS[kind]}`, onRemove: () => update({ kind: '', page: '' }) });
    }
    if (q) {
      filters.push({ key: 'q', label: `Search: “${q}”`, onRemove: () => update({ q: '', page: '' }) });
    }
    return filters;
  }, [lane, kind, q, update]);

  if (error && !data) return <Alert tone="danger">{error}</Alert>;

  const header = (
    <PageHeader
      title="Employee work"
      actions={
        <Link className={buttonClasses('secondary')} to="/admin/lifecycle-simulation">
          Run lifecycle simulation
        </Link>
      }
    />
  );

  if (!data) {
    return (
      <>
        {header}
        <Panel>
          <SkeletonRows rows={6} cols={5} />
        </Panel>
      </>
    );
  }

  const items = data.items;
  const lifecycleIds = items.flatMap((item) =>
    item.id.startsWith('lifecycle:') ? [item.id.slice('lifecycle:'.length)] : [],
  );
  const selectedOnPage = lifecycleIds.filter((id) => selected.has(id)).length;
  const allSelected = lifecycleIds.length > 0 && selectedOnPage === lifecycleIds.length;
  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const allViews = [...BUILT_IN_VIEWS, ...savedViews];
  const isSaved = allViews.some((view) => normalise(view.query) === currentView);

  function applyView(query: string) {
    setParams(new URLSearchParams(query));
    setSelected(new Set());
    setBulkOutcome(null);
  }

  function saveView() {
    const name = viewName.trim();
    if (!name) return;
    setSavedViews([...savedViews.filter((view) => view.name !== name), { name, query: currentView }]);
    setNaming(false);
    setViewName('');
    toast({ title: `View “${name}” saved` });
  }

  return (
    <>
      {header}

      {/* The lanes. Each is a link to its own filtered list and says how many
          items it holds before anything is clicked; the selected one is
          marked by more than colour. */}
      <nav aria-label="Work lanes" className="mb-5 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))]">
        {LANES.map((option) => {
          const count = data.lanes?.[option.id];
          const active = lane === option.id;
          const next = new URLSearchParams(params);
          next.delete('page');
          if (active) next.delete('lane');
          else next.set('lane', option.id);
          return (
            <Link
              key={option.id}
              to={`?${next.toString()}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => {
                setSelected(new Set());
                setBulkOutcome(null);
              }}
              className={[
                'block rounded-panel border px-4 py-3 transition-colors duration-150 ease-out-quart',
                active
                  ? 'border-primary bg-primary-soft/60 ring-1 ring-primary'
                  : 'border-border-subtle bg-surface hover:border-border-control hover:bg-surface-2',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={[
                    'figure text-2xl font-semibold',
                    count ? (option.state === 'blocked' ? 'text-danger' : option.state === 'attention' ? 'text-warning' : 'text-accent') : 'text-muted',
                  ].join(' ')}
                >
                  {count === undefined ? '—' : count.toLocaleString()}
                </span>
                <StateBadge state={count ? option.state : 'healthy'}>
                  {count ? option.badge : 'Clear'}
                </StateBadge>
              </div>
              <div className="mt-1 text-sm font-medium text-ink">
                {option.label}
                <span className="sr-only">{active ? ' (selected, select again to clear)' : ''}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      <Panel
        title={lane ? LANE_BY_ID[lane]?.label ?? 'Unresolved employee work' : 'Unresolved employee work'}
        actions={<RefreshStatus updatedAt={updatedAt} onRefresh={reload} refreshing={loading} />}
        bodyClassName="p-4"
      >
        {/* Views: the built-in ones, then this reader's own. A view is a
            link-shaped button because it replaces the filters wholesale. */}
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Saved views">
          {allViews.map((view) => {
            const active = normalise(view.query) === currentView;
            const custom = !BUILT_IN_VIEWS.includes(view);
            return (
              <span key={`${view.name}:${view.query}`} className="inline-flex items-center">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyView(view.query)}
                  className={[
                    'rounded-full border px-3 py-1 text-sm font-medium transition-colors duration-150 ease-out-quart',
                    custom ? 'rounded-r-none border-r-0' : '',
                    active
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border-control bg-bg text-ink hover:bg-surface',
                  ].join(' ')}
                >
                  {view.name}
                </button>
                {custom && (
                  <button
                    type="button"
                    aria-label={`Delete view ${view.name}`}
                    onClick={() => setSavedViews(savedViews.filter((saved) => saved !== view))}
                    className={[
                      'rounded-r-full border px-2 py-1 text-sm text-muted hover:text-danger',
                      active ? 'border-primary bg-primary-soft' : 'border-border-control bg-bg hover:bg-surface',
                    ].join(' ')}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {!isSaved && !naming && (
            <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
              Save this view
            </Button>
          )}
          {naming && (
            <form
              className="inline-flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                saveView();
              }}
            >
              <label className="sr-only" htmlFor="employee-work-view-name">View name</label>
              <input
                id="employee-work-view-name"
                autoFocus
                value={viewName}
                onChange={(event) => setViewName(event.target.value)}
                placeholder="View name"
                maxLength={40}
                className="h-8 w-40 rounded-control border border-border-control bg-bg px-2 text-sm text-ink placeholder:text-muted"
              />
              <Button size="sm" variant="secondary" type="submit" disabled={!viewName.trim()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(false)}>
                Cancel
              </Button>
            </form>
          )}
        </div>

        <FilterBar>
          <ListControls
            search={q}
            onSearch={onSearch}
            searchLabel="Search employee work"
            searchPlaceholder="Employee, status or target"
          />
        </FilterBar>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Work type"
            value={kind ?? 'all'}
            onChange={(value) => update({ kind: value === 'all' ? '' : value, page: '' })}
            options={[
              { value: 'all', label: 'All', count: data.counts.total },
              { value: 'onboarding', label: 'Onboarding', count: data.counts.onboarding },
              { value: 'offboarding', label: 'Offboarding', count: data.counts.offboarding },
              { value: 'failed', label: 'Failed', count: data.counts.failed, tone: 'danger' },
            ]}
          />
          <TableToolbar>
            <DensityToggle value={density} onChange={setDensity} />
          </TableToolbar>
        </div>
        <FilterChips filters={activeFilters} onReset={() => applyView('')} />

        {actionError && (
          <div className="mb-3">
            <Alert tone="danger" title="Bulk action failed">{actionError}</Alert>
          </div>
        )}
        {error && (
          <div className="mb-3">
            <Alert tone="warning" title="Could not refresh">{error}</Alert>
          </div>
        )}

        {lifecycleIds.length > 0 && (
          <BulkActionBar
            count={selected.size}
            noun="lifecycle operation"
            onClear={() => setSelected(new Set())}
            result={bulkOutcome}
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={selected.size === 0 || busy !== null}
              loading={busy === 'acknowledge'}
              onClick={() => void bulk('acknowledge')}
            >
              Acknowledge selected
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={selected.size === 0 || busy !== null}
              loading={busy === 'retry'}
              onClick={() => void bulk('retry')}
            >
              Retry selected
            </Button>
          </BulkActionBar>
        )}

        {items.length === 0 ? (
          activeFilters.length > 0 ? (
            <Empty
              title="Nothing matches these filters"
              action={
                <Button variant="secondary" onClick={() => applyView('')}>
                  Show all unresolved work
                </Button>
              }
            />
          ) : (
            <Empty
              title="Every hire and departure is complete"
              action={
                <Link className={buttonClasses('secondary')} to="/admin/people/new">
                  Add a person
                </Link>
              }
            />
          )
        ) : (
          <Table stickyHeader label="Employee work results" density={density}>
            <thead>
              <tr>
                <th scope="col" className="w-10">
                  {lifecycleIds.length > 0 ? (
                    <Checkbox
                      label="Select all lifecycle operations on this page"
                      checked={allSelected}
                      indeterminate={selectedOnPage > 0}
                      onChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const id of lifecycleIds) {
                            if (checked) next.add(id);
                            else next.delete(id);
                          }
                          return next;
                        })
                      }
                    />
                  ) : (
                    <span className="sr-only">Selection</span>
                  )}
                </th>
                <th scope="col">Employee</th>
                <th scope="col">State</th>
                <th scope="col">Work</th>
                <th scope="col">Target or owner</th>
                <th scope="col">What remains</th>
                <th scope="col">Updated</th>
                <th scope="col"><span className="sr-only">Next step</span></th>
              </tr>
            </thead>
            <tbody aria-live="polite" aria-label="Employee work results">
              {items.map((item) => {
                const operationId = item.id.startsWith('lifecycle:') ? item.id.slice('lifecycle:'.length) : null;
                const itemLane = LANE_BY_ID[laneOf(item)];
                const step = nextStep(item);
                const isSelected = operationId !== null && selected.has(operationId);
                return (
                  <tr key={item.id} aria-selected={operationId ? isSelected : undefined}>
                    <td>
                      {operationId && (
                        <Checkbox
                          label={`Select ${item.personName} lifecycle operation`}
                          checked={isSelected}
                          onChange={(checked) => toggle(operationId, checked)}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {item.personId ? (
                        <Link className="font-medium text-ink underline decoration-border-control underline-offset-2 hover:decoration-current" to={`/admin/people/${item.personId}`}>
                          {item.personName}
                        </Link>
                      ) : (
                        <span className="text-muted">{item.personName}</span>
                      )}
                      {item.priority && item.priority !== 'normal' && (
                        <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-warning">{item.priority}</span>
                      )}
                    </td>
                    <td>
                      <StateBadge state={itemLane.state}>{itemLane.label}</StateBadge>
                    </td>
                    <td className="whitespace-nowrap">
                      {KIND_LABELS[item.kind]}
                      {/* Only where it adds something: "Offboarding · offboard"
                          said the same word twice. A move or a verification
                          filed under onboarding is worth naming. */}
                      {item.lifecycleKind && !['onboard', 'offboard'].includes(item.lifecycleKind) && (
                        <span className="text-muted"> · {item.lifecycleKind}</span>
                      )}
                    </td>
                    <td>{item.targetName ?? item.ownerName ?? <span className="text-muted">—</span>}</td>
                    <td className="min-w-[12rem]">
                      {item.summary}
                      {item.overdueReason && (
                        <span className="mt-0.5 block text-sm font-medium text-danger">{item.overdueReason}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-muted">
                      <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString()}>
                        {relativeTime(new Date(item.updatedAt))}
                      </time>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {step && (
                        <Link className="link text-sm font-medium" to={step.to}>
                          {step.label}
                          <span className="sr-only"> for {item.personName}</span>
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pager
          page={data.page ?? 1}
          pageSize={data.pageSize ?? 50}
          total={data.total ?? items.length}
          onPage={onPage}
        />
      </Panel>
    </>
  );
}
