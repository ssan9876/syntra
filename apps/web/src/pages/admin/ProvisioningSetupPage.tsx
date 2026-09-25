import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  FilterBar,
  Meter,
  Panel,
  RefreshStatus,
  Select,
  SkeletonRows,
  StateBadge,
  Table,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { ProvisioningSetupSample } from './ProvisioningSetupSample.js';
import { PageHeader } from './PageHeader.js';
import {
  deriveSetupSteps,
  overallState,
  readinessState,
  unknown,
  type ImportRunLike,
  type MappingLike,
  type ProfileLike,
  type ReadinessLike,
  type RuleLike,
  type RunLike,
  type SampleLike,
  type SetupEvidence,
  type SetupStep,
  type SourceLike,
  type TargetLike,
  type Unknown,
} from './provisioning-readiness.js';

interface Source extends SourceLike { name: string }
interface Target extends TargetLike { name: string }

/** A resource's answer as evidence: its data, or the reason there is none. */
function known<T, V>(resource: { data: T | null; error: string | null }, pick: (data: T) => V, fallback: V): V | Unknown {
  if (resource.error) return unknown(resource.error);
  return resource.data ? pick(resource.data) : fallback;
}

/**
 * The account profile is the one read where 404 is an ANSWER — no profile
 * saved — rather than a failure, and a 403 must not be mistaken for it.
 */
function useProfile(targetId: string | null, nonce: number) {
  const [profile, setProfile] = useState<ProfileLike | null | Unknown | undefined>(undefined);
  useEffect(() => {
    if (!targetId) { setProfile(null); return; }
    let cancelled = false;
    setProfile(undefined);
    api<ProfileLike>(`/api/admin/targets/${targetId}/profile`).then((value) => {
      if (!cancelled) setProfile(value);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      if (cause instanceof ApiError && cause.problem.status === 404) setProfile(null);
      else setProfile(unknown(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Could not read account profile.'));
    });
    return () => { cancelled = true; };
  }, [targetId, nonce]);
  return profile;
}

function Step({ step }: { step: SetupStep }) {
  const anchor = step.href.startsWith('#');
  const actionClass = 'link shrink-0 text-sm font-medium';
  return <li className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-border-subtle px-4 py-4 last:border-0">
    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted tabular-nums">{step.number}</span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-ink">{step.title}</h3>
        <StateBadge state={step.state}>{step.label}</StateBadge>
      </div>
      {step.facts.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
          {step.facts.map((fact) => <div key={fact.label} className="min-w-0">
            <dt className="text-muted">{fact.label}</dt>
            <dd className="break-words text-ink tabular-nums">{fact.value}</dd>
          </div>)}
        </dl>
      )}
    </div>
    {anchor
      ? <a className={actionClass} href={step.href} onClick={() => document.querySelector<HTMLElement>(step.href)?.focus()}>{step.action}</a>
      : <Link className={actionClass} to={step.href}>{step.action}</Link>}
  </li>;
}

function TargetReadinessRow({ target, selected, onSelect }: { target: Target; selected: boolean; onSelect(): void }) {
  const readiness = useApiResource<ReadinessLike>(`/api/admin/targets/${target.id}/readiness`);
  const reading = readiness.data ? readinessState(readiness.data) : null;
  return <tr aria-current={selected || undefined}>
    <td><Link className="link" to={`/admin/targets/${target.id}`}>{target.name}</Link></td>
    <td>{target.enabled ? 'Yes' : 'No'}</td>
    <td>{readiness.error ? <StateBadge state="attention">Evidence unavailable</StateBadge> : reading ? <StateBadge state={reading.state}>{reading.label}</StateBadge> : '…'}</td>
    <td className="tabular-nums">{readiness.data?.checkedAt ? new Date(readiness.data.checkedAt).toLocaleString() : '—'}</td>
    <td>{target.schedule ? <code className="font-mono text-sm">{target.schedule}</code> : 'None'}</td>
    <td className="text-right">{selected ? <span className="text-sm text-muted">In checklist</span> : <button type="button" className="link text-sm" onClick={onSelect}>Check setup</button>}</td>
  </tr>;
}

/**
 * Provisioning setup as a checklist whose every tick is earned.
 *
 * Eight steps, in the order a first deployment has to take them, each with
 * the evidence it was read from set out as labelled values and a link to the
 * editor that changes it. The states come from `deriveSetupSteps`, which is
 * where the rule lives that a saved configuration is never shown as a
 * verified one. Nothing here writes: the page reads what the editors saved
 * and what tests and previews recorded, and it enables nothing.
 */
export function ProvisioningSetupPage() {
  const [params, setParams] = useSearchParams();
  const sources = useApiResource<{ sources: Source[] }>('/api/admin/person-sources');
  const targets = useApiResource<{ targets: Target[] }>('/api/admin/targets');
  const source = sources.data?.sources.find((item) => item.id === params.get('source')) ?? sources.data?.sources[0] ?? null;
  const target = targets.data?.targets.find((item) => item.id === params.get('target')) ?? targets.data?.targets[0] ?? null;
  const [sample, setSample] = useState<SampleLike | null>(null);
  const [nonce, setNonce] = useState(0);

  const mappings = useApiResource<{ rules: MappingLike[] }>(source ? `/api/admin/person-sources/${source.id}/mappings` : null);
  const importRuns = useApiResource<{ runs: ImportRunLike[] }>(source ? `/api/admin/person-import-runs?sourceId=${encodeURIComponent(source.id)}` : null);
  const rules = useApiResource<{ rules: RuleLike[] }>(target ? `/api/admin/targets/${target.id}/rules` : null);
  const runs = useApiResource<{ runs: RunLike[] }>(target ? `/api/admin/targets/${target.id}/runs` : null);
  const readiness = useApiResource<ReadinessLike>(target ? `/api/admin/targets/${target.id}/readiness` : null);
  const profile = useProfile(target?.id ?? null, nonce);

  const select = (key: string, value: string) => { const next = new URLSearchParams(params); next.set(key, value); setParams(next); };
  const refresh = () => {
    sources.reload(); targets.reload(); mappings.reload(); importRuns.reload();
    rules.reload(); runs.reload(); readiness.reload(); setNonce((n) => n + 1);
  };
  const onInspect = useCallback((next: SampleLike | null) => setSample(next), []);

  const listsLoading = (!sources.data && sources.loading) || (!targets.data && targets.loading);
  // Not `loading` alone: in the render where a path first becomes known the
  // hook still holds its settled null-path state, and reading that as
  // "loaded, nothing there" flashes a checklist of empty evidence.
  const waiting = (r: { data: unknown; error: string | null }, active: boolean) => active && !r.data && !r.error;
  const evidenceLoading = [mappings, importRuns].some((r) => waiting(r, !!source))
    || [rules, runs, readiness].some((r) => waiting(r, !!target))
    || profile === undefined;

  const steps = useMemo(() => {
    if (listsLoading || evidenceLoading || sources.error || targets.error) return null;
    const evidence: SetupEvidence = {
      source,
      mappings: known(mappings, (data) => data.rules, []),
      importRuns: known(importRuns, (data) => data.runs, []),
      sample,
      target,
      readiness: known(readiness, (data) => data, { current: false, status: 'untested' }),
      profile: profile ?? null,
      rules: known(rules, (data) => data.rules, []),
      runs: known(runs, (data) => data.runs, []),
    };
    return deriveSetupSteps(evidence);
  }, [listsLoading, evidenceLoading, sources.error, targets.error, source, sample, target, mappings, importRuns, readiness, rules, runs, profile]);

  const verified = steps?.filter((step) => step.state === 'healthy').length ?? 0;
  const overall = steps ? overallState(steps) : null;
  const warnings = readiness.data?.adapterWarnings ?? [];

  return <>
    <PageHeader
      title="Provisioning setup"
      status={overall && <StateBadge state={overall.state}>{overall.label}</StateBadge>}
      actions={<RefreshStatus updatedAt={runs.updatedAt ?? targets.updatedAt} onRefresh={refresh} refreshing={evidenceLoading} />}
    />

    {(sources.error || targets.error) && <div className="mb-4"><Alert tone="danger">{sources.error ?? targets.error}</Alert></div>}

    <FilterBar
      trailing={steps && <div className="w-56" aria-label="Setup progress">
        <p className="mb-1.5 text-sm text-muted"><span className="text-xl font-semibold text-ink tabular-nums">{verified}</span> of {steps.length} verified</p>
        <Meter percent={(verified / steps.length) * 100} label="of setup steps verified" tone={verified === steps.length ? 'success' : 'primary'} />
      </div>}
    >
      {(sources.data?.sources.length ?? 0) > 1 && source && <Select className="w-56" label="HR source" value={source.id} onChange={(value) => select('source', value)} options={sources.data!.sources.map((item) => ({ value: item.id, label: item.name }))} />}
      {(targets.data?.targets.length ?? 0) > 1 && target && <Select className="w-56" label="Target system" value={target.id} onChange={(value) => select('target', value)} options={targets.data!.targets.map((item) => ({ value: item.id, label: item.name }))} />}
    </FilterBar>

    {warnings.length > 0 && <div className="mb-4"><Alert tone="warning" title="Adapter readiness warning"><ul className="list-disc pl-5">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert></div>}

    <div className="space-y-5">
      <Panel title={[source?.name, target?.name].filter(Boolean).join(' → ') || 'Checklist'}>
        {steps ? <ol aria-label="Setup checklist">{steps.map((step) => <Step key={step.key} step={step} />)}</ol> : <div className="p-4"><SkeletonRows rows={8} cols={1} /></div>}
      </Panel>

      <ProvisioningSetupSample onInspect={onInspect} />

      {(targets.data?.targets.length ?? 0) > 0 && (
        <Panel title="Connector readiness">
          <Table>
            <caption className="sr-only">Connector readiness per target</caption>
            <thead><tr><th scope="col">Target</th><th scope="col">Enabled</th><th scope="col">Connection</th><th scope="col">Tested</th><th scope="col">Schedule</th><th scope="col"><span className="sr-only">Checklist</span></th></tr></thead>
            <tbody>{targets.data!.targets.map((item) => <TargetReadinessRow key={`${item.id}-${nonce}`} target={item} selected={item.id === target?.id} onSelect={() => select('target', item.id)} />)}</tbody>
          </Table>
        </Panel>
      )}
    </div>
  </>;
}
