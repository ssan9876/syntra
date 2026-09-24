import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { ProvisioningSetupSample } from './ProvisioningSetupSample.js';
import { PageHeader } from './PageHeader.js';

interface Source { id: string; name: string; enabled: boolean; schedule: string | null }
interface Target extends Source { autoApply: boolean }
interface Run { id: string; status: string; startedAt: string; error?: string | null; blockedReason?: string | null; personsUnprocessable?: number }
interface Mapping { recordType: string; targetField: string; sourceColumn: string; isCorrelation: boolean }
interface StepProps { title: string; evidence: boolean; href: string; action: string; children: ReactNode }
function Step({ title, evidence, href, action, children }: StepProps) {
  return <li className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle py-4 last:border-0">
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-ink">{title}</h3><Status tone={evidence ? 'active' : 'warning'}>{evidence ? 'Recorded' : 'Needs review'}</Status></div><div className="mt-1 text-sm text-muted">{children}</div></div>
    <Link className="text-sm font-medium text-primary underline" to={href}>{action}</Link>
  </li>;
}
function SourceChecklist({ source }: { source: Source }) {
  const mappings = useApiResource<{ rules: Mapping[] }>(`/api/admin/person-sources/${source.id}/mappings`);
  const runs = useApiResource<{ runs: Run[] }>(`/api/admin/person-import-runs?sourceId=${encodeURIComponent(source.id)}`);
  if (mappings.loading || runs.loading) return <SkeletonRows rows={3} cols={1} />;
  const error = mappings.error || runs.error;
  if (error) return <Alert tone="danger">Source evidence could not be loaded: {error} <Link to={`/admin/person-sources/${source.id}`}>Open HR source</Link></Alert>;
  const mapped = mappings.data?.rules.some((rule) => rule.recordType === 'person' && rule.targetField === 'externalId' && rule.isCorrelation && rule.sourceColumn.trim());
  const latest = runs.data?.runs[0];
  const imported = latest?.status === 'applied';
  const href = `/admin/person-sources/${source.id}`;
  return <ol>
    <Step title="1. Connect HR" evidence={false} href={href} action="Test HR connection">{source.enabled ? 'Source saved. Test the connection in the source editor.' : 'Source is disabled. Review its connection before enabling.'}</Step>
    <Step title="2. Map fields" evidence={!!mapped} href={href} action="Review field mappings">{mapped ? 'Person correlation mapping saved. Check names, contract identifiers and employment dates before import.' : 'Save a person correlation mapping before importing.'}</Step>
    <Step title="3. Inspect an imported employee" evidence={imported} href={latest ? `/admin/person-import-runs/${latest.id}` : href} action={latest ? 'Review import run' : 'Preview HR import'}>{latest ? `Latest import: ${latest.status}. ${latest.error ?? latest.blockedReason ?? ''}` : 'No import run recorded.'} {imported && 'Inspect the employee and contract dates before provisioning.'}<div className="mt-1"><Link className="text-primary underline" to="/admin/users?tab=people">Find a sample employee and inspect contracts</Link></div></Step>
    <Step title="HR import schedule" evidence={source.enabled && !!source.schedule} href={href} action="Configure HR schedule">{source.schedule ? `Saved cron: ${source.schedule}. ${source.enabled ? 'Source enabled.' : 'Source disabled; schedule will not run.'}` : 'No automatic import schedule saved.'}</Step>
  </ol>;
}
function TargetChecklist({ target }: { target: Target }) {
  const [profile, setProfile] = useState<'loading' | 'saved' | 'missing' | 'error'>('loading');
  const [profileError, setProfileError] = useState('');
  const rules = useApiResource<{ rules: { enabled: boolean; grantsAccount: boolean; entitlements: unknown[] }[] }>(`/api/admin/targets/${target.id}/rules`);
  const runs = useApiResource<{ runs: Run[] }>(`/api/admin/targets/${target.id}/runs`);
  const readiness = useApiResource<{ current: boolean; status: string; checkedAt?: string; capabilities?: string[]; adapterWarnings?: string[] }>(`/api/admin/targets/${target.id}/readiness`);
  useEffect(() => {
    let cancelled = false;
    void api(`/api/admin/targets/${target.id}/profile`).then(() => {
      if (!cancelled) setProfile('saved');
    }).catch((cause: unknown) => {
      if (cancelled) return;
      if (cause instanceof ApiError && cause.problem.status === 404) setProfile('missing');
      else { setProfile('error'); setProfileError(cause instanceof Error ? cause.message : 'Could not read account profile.'); }
    });
    return () => { cancelled = true; };
  }, [target.id]);
  if (profile === 'loading' || rules.loading || runs.loading || readiness.loading) return <SkeletonRows rows={5} cols={1} />;
  const latest = runs.data?.runs[0];
  const hasGrants = rules.data?.rules.some((rule) => rule.enabled && (rule.grantsAccount || rule.entitlements.length > 0));
  const href = `/admin/targets/${target.id}`;
  return <>
    {(rules.error || runs.error || profile === 'error') && <Alert tone="danger">Some target evidence is unavailable. {rules.error} {runs.error} {profileError} Refresh or open the relevant editor.</Alert>}
    {/* A connection test proves the connection, not the adapter behind it. */}
    {(readiness.data?.adapterWarnings?.length ?? 0) > 0 && <Alert tone="warning" title="Adapter readiness warning"><ul className="list-disc pl-5">{readiness.data!.adapterWarnings!.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert>}
    <ol>
      <Step title="4. Connect target" evidence={readiness.data?.current === true && readiness.data.status === 'passed'} href={href} action="Test target connection">{readiness.data?.current && readiness.data.status === 'passed' ? `Current readiness recorded${readiness.data.checkedAt ? ` ${new Date(readiness.data.checkedAt).toLocaleString()}` : ''}.` : target.enabled ? 'Target saved. Test its current connection and permissions.' : 'Target is disabled. Review its connection before enabling.'}</Step>
      <Step title="5. Configure naming and placement" evidence={profile === 'saved'} href={`${href}/profile`} action="Configure naming and placement">{profile === 'saved' ? 'Account profile saved. Preview a sample employee to check names, uniqueness and placement.' : profile === 'missing' ? 'No account profile saved.' : 'Profile could not be verified.'}</Step>
      <Step title="6. Assign access rules" evidence={!rules.error && !!hasGrants} href={`${href}/rules`} action="Configure access rules">{rules.error ? 'Rules could not be verified.' : hasGrants ? 'Enabled access rules saved. Preview who matches and what access they receive.' : 'No enabled rule grants an account or entitlement.'}</Step>
      <Step title="7. Preview lifecycle" evidence={false} href={latest ? `${href}/runs/${latest.id}` : `${href}/runs`} action={latest ? 'Review lifecycle run' : 'Preview lifecycle'}>{runs.error ? 'Run history could not be verified.' : latest ? <>Latest run: {latest.status} ({new Date(latest.startedAt).toLocaleString()}). {latest.error ?? latest.blockedReason ?? ''} {!!latest.personsUnprocessable && `${latest.personsUnprocessable} employees could not be processed.`}<div>History does not prove the current configuration was reviewed. Generate a fresh preview after changing mappings, profiles, rules or employment dates.</div></> : 'No lifecycle run recorded.'}</Step>
      <Step title="8. Enable schedule" evidence={target.enabled && !!target.schedule} href={href} action="Configure target schedule">{target.schedule ? `Saved cron: ${target.schedule}. ${target.enabled ? 'Target enabled.' : 'Target disabled; schedule will not run.'}` : 'No automatic target schedule saved.'}<div>{target.autoApply ? 'Automatic apply is enabled. Review the fresh preview and safety thresholds before leaving writes enabled.' : 'Automatic apply is off. Keep it off while validating the preview.'}</div></Step>
    </ol>
  </>;
}
export function ProvisioningSetupPage() {
  const [params, setParams] = useSearchParams();
  const sources = useApiResource<{ sources: Source[] }>('/api/admin/person-sources');
  const targets = useApiResource<{ targets: Target[] }>('/api/admin/targets');
  const [version, setVersion] = useState(0);
  const source = sources.data?.sources.find((item) => item.id === params.get('source')) ?? sources.data?.sources[0];
  const target = targets.data?.targets.find((item) => item.id === params.get('target')) ?? targets.data?.targets[0];
  const select = (key: string, value: string) => { const next = new URLSearchParams(params); next.set(key, value); setParams(next); };
  const refresh = () => { sources.reload(); targets.reload(); setVersion((value) => value + 1); };
  return <>
    <PageHeader title="Provisioning setup" actions={<Button onClick={refresh}>Refresh evidence</Button>} />
    <p className="mb-4 max-w-3xl text-sm text-muted">Follow saved HR and target configuration through to a reviewed lifecycle preview. This checklist reloads saved evidence when you return; it does not enable writes.</p>
    <Alert tone="warning">Saved-target connection tests create fingerprinted readiness evidence. It proves the tested connection and permissions, not that employees currently have the correct access.</Alert>
    <div className="mt-5 grid items-start gap-5 xl:grid-cols-2">
      <section aria-label="HR setup"><Panel><div className="p-5"><h2 className="mb-3 font-semibold text-ink">HR source</h2>
        {sources.loading ? <SkeletonRows rows={3} cols={1} /> : sources.error ? <Alert tone="danger">{sources.error}</Alert> : source ? <><Select label="HR source" value={source.id} onChange={(value) => select('source', value)} options={(sources.data?.sources ?? []).map((item) => ({ value: item.id, label: item.name }))} /><SourceChecklist key={`${source.id}-${version}`} source={source} /></> : <p>No HR source saved. <Link className="text-primary underline" to="/admin/person-sources/new">Connect HR source</Link></p>}
      </div></Panel></section>
      <section aria-label="Target setup"><Panel><div className="p-5"><h2 className="mb-3 font-semibold text-ink">Target system</h2>
        {targets.loading ? <SkeletonRows rows={3} cols={1} /> : targets.error ? <Alert tone="danger">{targets.error}</Alert> : target ? <><Select label="Target system" value={target.id} onChange={(value) => select('target', value)} options={(targets.data?.targets ?? []).map((item) => ({ value: item.id, label: item.name }))} /><TargetChecklist key={`${target.id}-${version}`} target={target} /></> : <p>No target saved. <Link className="text-primary underline" to="/admin/targets/new">Connect target</Link></p>}
      </div></Panel></section>
    </div>
    <div className="mt-5"><ProvisioningSetupSample /></div>
    <div className="mt-5"><Panel><div className="p-5 text-sm"><h2 className="font-semibold text-ink">Choose schedules after reviewing the preview</h2><p className="mt-2 text-muted">Start with manual runs and automatic apply off. If daily processing is sufficient, a daily cron such as <code>0 3 * * *</code> runs at 03:00 in the scheduler’s configured timezone. Confirm that timezone and allow the HR import to finish before scheduling target provisioning. Use the linked editors for advanced cron and safety thresholds.</p><div className="mt-3 flex flex-wrap gap-4"><Link className="text-primary underline" to="/admin/sources?tab=people">All HR feeds</Link><Link className="text-primary underline" to="/admin/targets">All target editors</Link></div></div></Panel></div>
  </>;
}




