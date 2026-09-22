import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Empty, ListControls, Pager, Panel, SkeletonRows, Status, Table, buttonClasses } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { api, ApiError } from '../../session/api.js';
import { PageFacts, PageHeader } from './PageHeader.js';

interface WorkItem { id: string; kind: 'onboarding' | 'offboarding' | 'failed'; personId: string | null; personName: string; status: string; summary: string; updatedAt: string; lifecycleKind?: string; priority?: string; overdue?: boolean }
interface Work { counts: { onboarding: number; offboarding: number; failed: number; total: number }; items: WorkItem[]; total: number; page: number; pageSize: number }
interface LifecycleMetrics { waiting: number; failed: number; overdue: number; oldestUnresolvedAt: string | null }
export function EmployeeWorkPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('kind') ?? 'all';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const query = new URLSearchParams();
  if (filter !== 'all') query.set('kind', filter);
  if (q) query.set('q', q);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();
  const { data, error, loading, reload } = useApiResource<Work>(`/api/admin/employee-work${qs ? `?${qs}` : ''}`);
  const metrics = useApiResource<LifecycleMetrics>('/api/admin/lifecycle-operations/metrics');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const update = useCallback((next: Record<string, string>, replaceHistory = false) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged, { replace: replaceHistory });
  }, [params, setParams]);
  const onSearch = useCallback((value: string) => update({ q: value, page: '' }, true), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
  const bulk = useCallback(async (action: 'acknowledge' | 'retry') => {
    if (selected.size === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await api('/api/admin/lifecycle-operations/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, operationIds: [...selected] }),
      });
      setSelected(new Set());
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.problem.detail ?? cause.problem.title : 'The selected operations could not be updated.');
    } finally {
      setBusy(false);
    }
  }, [reload, selected]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading || !data) return <Panel><SkeletonRows rows={5} cols={4} /></Panel>;
  const items = data.items;
  const resultPage = data.page ?? 1;
  const resultPageSize = data.pageSize ?? 50;
  const resultTotal = data.total ?? items.length;
  const lifecycleIds = items.flatMap((item) => item.id.startsWith('lifecycle:') ? [item.id.slice('lifecycle:'.length)] : []);
  const allSelected = lifecycleIds.length > 0 && lifecycleIds.every((id) => selected.has(id));
  const toggle = (id: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });
  return <><PageHeader title="Employee work" actions={<Link className="underline" to="/admin/lifecycle-simulation">Run lifecycle simulation</Link>} /><PageFacts facts={[
    { label: 'All unresolved', value: <button aria-label="Show all unresolved work" onClick={() => setParams({})}>{data.counts.total}</button> },
    { label: 'Onboarding', value: <button aria-label="Show onboarding work" onClick={() => setParams({ kind: 'onboarding' })}>{data.counts.onboarding}</button> },
    { label: 'Offboarding', value: <button aria-label="Show offboarding work" onClick={() => setParams({ kind: 'offboarding' })}>{data.counts.offboarding}</button> },
    { label: 'Failed', value: <button aria-label="Show failed work" onClick={() => setParams({ kind: 'failed' })}>{data.counts.failed}</button> },
    { label: 'Waiting verification', value: metrics.data?.waiting ?? '—' },
    { label: 'Overdue unacknowledged', value: metrics.data?.overdue ?? '—' },
  ]} />
  <Panel title={filter === 'all' ? 'Unresolved employee work' : `${filter[0]!.toUpperCase()}${filter.slice(1)}`}>
    <ListControls search={q} onSearch={onSearch} searchLabel="Search employee work" searchPlaceholder="Employee, status or target" />
    {actionError ? <Alert tone="danger">{actionError}</Alert> : null}
    {lifecycleIds.length > 0 ? <div className="mb-3 flex flex-wrap items-center gap-2" aria-live="polite"><span>{selected.size} lifecycle operation{selected.size === 1 ? '' : 's'} selected</span><button className={buttonClasses('secondary')} disabled={selected.size === 0 || busy} onClick={() => void bulk('acknowledge')}>Acknowledge selected</button><button className={buttonClasses('secondary')} disabled={selected.size === 0 || busy} onClick={() => void bulk('retry')}>Retry selected</button></div> : null}
    {items.length === 0 ? <div className="p-6"><Empty title="Nothing needs attention">No employee lifecycle work matches this filter.</Empty></div> : <Table><thead><tr><th scope="col"><input aria-label="Select all lifecycle operations on this page" type="checkbox" checked={allSelected} disabled={lifecycleIds.length === 0} onChange={(event) => setSelected(event.target.checked ? new Set(lifecycleIds) : new Set())} /></th><th scope="col">Employee</th><th scope="col">Work</th><th scope="col">Status</th><th scope="col">What remains</th></tr></thead><tbody aria-live="polite" aria-label="Employee work results">
      {items.map((item) => { const operationId = item.id.startsWith('lifecycle:') ? item.id.slice('lifecycle:'.length) : null; return <tr key={item.id}><td>{operationId ? <input aria-label={`Select ${item.personName} lifecycle operation`} type="checkbox" checked={selected.has(operationId)} onChange={(event) => toggle(operationId, event.target.checked)} /> : null}</td><td>{item.personId ? <Link className="font-medium text-ink underline" to={`/admin/people/${item.personId}`}>{item.personName}</Link> : item.personName}</td><td>{item.lifecycleKind ?? item.kind}</td><td><Status tone={item.kind === 'failed' ? 'danger' : item.overdue ? 'danger' : 'warning'}>{item.status}</Status></td><td>{item.summary}</td></tr>; })}
    </tbody></Table>}
    <Pager page={resultPage} pageSize={resultPageSize} total={resultTotal} onPage={onPage} />
  </Panel></>;
}
