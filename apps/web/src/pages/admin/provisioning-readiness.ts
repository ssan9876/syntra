import type { State } from '@syntra/ui';

/**
 * Where provisioning setup stands, derived from saved and TESTED evidence.
 *
 * The setup page used to colour a step green when its configuration existed.
 * That is the claim the usability review found most dangerous: a saved target
 * is not a connected one, a saved profile has not placed anybody, and a run
 * from last week does not describe the rules somebody edited this morning.
 * So every step here separates three things the old page ran together:
 *
 * - nothing saved (`setup`),
 * - saved but not yet proven by anything that exercised it (`pending`),
 * - proven by evidence the server recorded (`healthy`).
 *
 * The evidence that proves each step is deliberately the most direct one
 * available, never a proxy one step removed. An import that read records
 * proves the HR connection; a preview computed AFTER the profile and rules
 * were last changed proves the profile and rules; a fingerprinted connection
 * test that still matches the saved configuration proves the target. Nothing
 * proves a schedule except every step before it, which is why the last step
 * is only green once the other seven are.
 *
 * Pure, so the rules are tested on their own and the page cannot drift from
 * them.
 */

/** Evidence that could not be read. Never treated as absent. */
export interface Unknown {
  unknown: true;
  error: string;
}

export const unknown = (error: string): Unknown => ({ unknown: true, error });

function isUnknown(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null && (value as Unknown).unknown === true;
}

export interface SourceLike {
  id: string;
  enabled: boolean;
  schedule: string | null;
}

export interface MappingLike {
  recordType: string;
  targetField: string;
  sourceColumn: string;
  isCorrelation: boolean;
}

export interface ImportRunLike {
  id: string;
  status: string;
  startedAt: string;
  recordsRead?: number | undefined;
  mappingFailures?: number | undefined;
  error?: string | null | undefined;
  blockedReason?: string | null | undefined;
}

export interface TargetLike {
  id: string;
  enabled: boolean;
  schedule: string | null;
  autoApply: boolean;
}

export interface ReadinessLike {
  current: boolean;
  status: string;
  checkedAt?: string | undefined;
  message?: string | null | undefined;
  adapterWarnings?: string[] | undefined;
}

export interface ProfileLike {
  updatedAt?: string | undefined;
}

export interface RuleLike {
  enabled: boolean;
  grantsAccount: boolean;
  entitlements: unknown[];
  updatedAt?: string | undefined;
}

export interface RunLike {
  id: string;
  status: string;
  startedAt: string;
  error?: string | null | undefined;
  blockedReason?: string | null | undefined;
  personsUnprocessable?: number | undefined;
}

export interface SampleLike {
  personId: string;
  name: string;
  contracts: number;
}

export interface SetupEvidence {
  source: SourceLike | null;
  mappings: MappingLike[] | Unknown;
  importRuns: ImportRunLike[] | Unknown;
  sample: SampleLike | null;
  target: TargetLike | null;
  readiness: ReadinessLike | Unknown;
  /** `null` when the target has no account profile saved. */
  profile: ProfileLike | null | Unknown;
  rules: RuleLike[] | Unknown;
  runs: RunLike[] | Unknown;
}

export interface StepFact {
  label: string;
  value: string;
}

export interface SetupStep {
  key: string;
  number: number;
  title: string;
  state: State;
  /** The badge's word, where the state's default would be less exact. */
  label: string;
  facts: StepFact[];
  /** The editor that fixes this step. */
  href: string;
  action: string;
}

const when = (iso: string | undefined | null) => (iso ? new Date(iso).toLocaleString() : '—');
const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

/** A readiness record, read as a state. Shared with the per-target table. */
export function readinessState(readiness: ReadinessLike): { state: State; label: string } {
  if (readiness.status === 'untested') return { state: 'pending', label: 'Not tested' };
  if (!readiness.current) return { state: 'attention', label: 'Changed since test' };
  if (readiness.status !== 'passed') return { state: 'blocked', label: 'Test failed' };
  if ((readiness.adapterWarnings?.length ?? 0) > 0) return { state: 'attention', label: 'Adapter warning' };
  return { state: 'healthy', label: 'Verified' };
}

const UNAVAILABLE = { state: 'attention' as const, label: 'Evidence unavailable' };

/** Run statuses that are a finished plan somebody can read. */
const PLANNED = new Set(['previewed', 'applied', 'partially_applied']);
const MOVING = new Set(['running', 'planning', 'applying', 'queued']);
const REFUSED = new Set(['failed', 'blocked', 'cancelled']);

/**
 * Whether a run was computed after every configuration change it depends on.
 * A timestamp the API does not return is not a change that happened.
 */
function reflects(run: RunLike, changes: (string | undefined)[]): boolean {
  const started = Date.parse(run.startedAt);
  return changes.every((change) => !change || Date.parse(change) <= started);
}

function latestChange(rules: RuleLike[]): string | undefined {
  let latest: string | undefined;
  for (const rule of rules) {
    if (rule.updatedAt && (!latest || Date.parse(rule.updatedAt) > Date.parse(latest))) latest = rule.updatedAt;
  }
  return latest;
}

export function deriveSetupSteps(evidence: SetupEvidence): SetupStep[] {
  const { source, target } = evidence;
  const sourceHref = source ? `/admin/person-sources/${source.id}` : '/admin/person-sources/new';
  const targetHref = target ? `/admin/targets/${target.id}` : '/admin/targets/new';

  const importRuns = isUnknown(evidence.importRuns) ? null : evidence.importRuns;
  const latestImport = importRuns?.[0] ?? null;
  // The newest run that actually read something. A later failure does not
  // un-prove that the connection once worked — but the newest run is what
  // decides the state, so a current failure still shows as one.
  const readAny = (latestImport?.recordsRead ?? 0) > 0;

  // 1. Connect HR
  const hr = ((): SetupStep => {
    const base = { key: 'hr', number: 1, title: 'Connect HR', href: sourceHref };
    if (!source) {
      return { ...base, state: 'setup', label: 'Not started', action: 'Connect HR source', facts: [{ label: 'HR source', value: 'None saved' }] };
    }
    if (isUnknown(evidence.importRuns)) {
      return { ...base, ...UNAVAILABLE, action: 'Open HR source', facts: [{ label: 'Import history', value: evidence.importRuns.error }] };
    }
    const facts: StepFact[] = [
      { label: 'Enabled', value: yesNo(source.enabled) },
      { label: 'Latest import', value: latestImport ? `${latestImport.status}, ${when(latestImport.startedAt)}` : 'None' },
    ];
    if (latestImport) facts.push({ label: 'Records read', value: String(latestImport.recordsRead ?? 0) });
    if (latestImport?.error) facts.push({ label: 'Error', value: latestImport.error });
    if (latestImport && latestImport.status === 'failed' && !readAny) {
      return { ...base, state: 'blocked', label: 'Import failed', action: 'Test HR connection', facts };
    }
    if (!readAny) {
      return { ...base, state: 'pending', label: 'Saved, not tested', action: 'Test HR connection', facts };
    }
    if (!source.enabled) return { ...base, state: 'attention', label: 'Source disabled', action: 'Review HR source', facts };
    return { ...base, state: 'healthy', label: 'Verified', action: 'Review HR source', facts };
  })();

  // 2. Map fields
  const map = ((): SetupStep => {
    const base = { key: 'map', number: 2, title: 'Map fields', href: sourceHref };
    if (!source) return { ...base, state: 'setup', label: 'Not started', action: 'Connect HR source', facts: [] };
    if (isUnknown(evidence.mappings)) {
      return { ...base, ...UNAVAILABLE, action: 'Review field mappings', facts: [{ label: 'Mappings', value: evidence.mappings.error }] };
    }
    const person = evidence.mappings.filter((rule) => rule.recordType === 'person');
    const correlation = person.find((rule) => rule.targetField === 'externalId' && rule.isCorrelation && rule.sourceColumn.trim());
    const facts: StepFact[] = [
      { label: 'Correlation column', value: correlation ? correlation.sourceColumn : 'None' },
      { label: 'Mapped fields', value: String(evidence.mappings.length) },
    ];
    if (!correlation) return { ...base, state: 'setup', label: 'Not started', action: 'Map fields', facts };
    if (!readAny || !latestImport) return { ...base, state: 'pending', label: 'Saved, not imported', action: 'Review field mappings', facts };
    const failures = latestImport.mappingFailures ?? 0;
    facts.push({ label: 'Mapping failures', value: String(failures) });
    if (failures > 0) return { ...base, state: 'attention', label: 'Rows not mapped', action: 'Review field mappings', facts };
    return { ...base, state: 'healthy', label: 'Verified', action: 'Review field mappings', facts };
  })();

  // 3. Inspect a sample employee. The one step whose evidence is a person
  // LOOKING, which the server does not record — so it is proven for this
  // visit only, and says whose record was looked at.
  const imported = importRuns?.some((run) => run.status === 'applied') ?? false;
  const sample = ((): SetupStep => {
    const base = { key: 'sample', number: 3, title: 'Inspect a sample employee', href: '#sample-employee', action: 'Inspect sample employee' };
    if (evidence.sample) {
      const facts = [
        { label: 'Employee', value: evidence.sample.name },
        { label: 'Contracts', value: String(evidence.sample.contracts) },
      ];
      if (evidence.sample.contracts === 0) return { ...base, state: 'attention', label: 'No contract', facts };
      return { ...base, state: 'healthy', label: 'Inspected', facts };
    }
    const facts = [{ label: 'Applied import', value: yesNo(imported) }];
    return imported
      ? { ...base, state: 'pending', label: 'Not inspected', facts }
      : { ...base, state: 'setup', label: 'Not started', facts };
  })();

  // 4. Connect target
  const connect = ((): SetupStep => {
    const base = { key: 'target', number: 4, title: 'Connect target', href: targetHref };
    if (!target) return { ...base, state: 'setup', label: 'Not started', action: 'Connect target', facts: [{ label: 'Target', value: 'None saved' }] };
    if (isUnknown(evidence.readiness)) {
      return { ...base, ...UNAVAILABLE, action: 'Test target connection', facts: [{ label: 'Readiness', value: evidence.readiness.error }] };
    }
    const readiness = evidence.readiness;
    const facts: StepFact[] = [
      { label: 'Enabled', value: yesNo(target.enabled) },
      { label: 'Connection test', value: readiness.status },
    ];
    if (readiness.status !== 'untested') {
      facts.push({ label: 'Tested', value: when(readiness.checkedAt) });
      facts.push({ label: 'Matches saved configuration', value: yesNo(readiness.current) });
    }
    if (readiness.message && readiness.status !== 'passed') facts.push({ label: 'Error', value: readiness.message });
    if (readiness.adapterWarnings?.length) facts.push({ label: 'Adapter warnings', value: String(readiness.adapterWarnings.length) });
    return { ...base, ...readinessState(readiness), action: 'Test target connection', facts };
  })();

  const runs = isUnknown(evidence.runs) ? null : evidence.runs;
  const rules = isUnknown(evidence.rules) ? null : evidence.rules;
  const profile = isUnknown(evidence.profile) ? undefined : evidence.profile;
  // The newest run that produced a plan, which is what "previewed" means.
  const lastPlan = runs?.find((run) => PLANNED.has(run.status)) ?? null;

  // 5. Naming and placement
  const naming = ((): SetupStep => {
    const base = { key: 'naming', number: 5, title: 'Configure naming and placement', href: target ? `${targetHref}/profile` : targetHref, action: 'Configure naming and placement' };
    if (!target) return { ...base, state: 'setup', label: 'Not started', action: 'Connect target', facts: [] };
    if (isUnknown(evidence.profile)) {
      return { ...base, ...UNAVAILABLE, facts: [{ label: 'Account profile', value: evidence.profile.error }] };
    }
    if (profile === null || profile === undefined) {
      return { ...base, state: 'setup', label: 'Not started', facts: [{ label: 'Account profile', value: 'None saved' }] };
    }
    const previewed = lastPlan !== null && reflects(lastPlan, [profile.updatedAt]);
    const facts = [
      { label: 'Profile saved', value: when(profile.updatedAt) },
      { label: 'Previewed since', value: yesNo(previewed) },
    ];
    if (!previewed) return { ...base, state: 'pending', label: 'Saved, not previewed', facts };
    if ((lastPlan.personsUnprocessable ?? 0) > 0) {
      return { ...base, state: 'attention', label: 'Unprocessable people', facts: [...facts, { label: 'Unprocessable', value: String(lastPlan.personsUnprocessable) }] };
    }
    return { ...base, state: 'healthy', label: 'Verified', facts };
  })();

  // 6. Access rules
  const access = ((): SetupStep => {
    const base = { key: 'rules', number: 6, title: 'Assign access rules', href: target ? `${targetHref}/rules` : targetHref, action: 'Configure access rules' };
    if (!target) return { ...base, state: 'setup', label: 'Not started', action: 'Connect target', facts: [] };
    if (isUnknown(evidence.rules)) {
      return { ...base, ...UNAVAILABLE, facts: [{ label: 'Rules', value: evidence.rules.error }] };
    }
    const granting = evidence.rules.filter((rule) => rule.enabled && (rule.grantsAccount || rule.entitlements.length > 0));
    const changed = latestChange(evidence.rules);
    const facts = [{ label: 'Enabled rules granting access', value: String(granting.length) }];
    if (granting.length === 0) return { ...base, state: 'setup', label: 'Not started', facts };
    const previewed = lastPlan !== null && reflects(lastPlan, [changed]);
    facts.push({ label: 'Last rule change', value: when(changed) }, { label: 'Previewed since', value: yesNo(previewed) });
    if (!previewed) return { ...base, state: 'pending', label: 'Saved, not previewed', facts };
    return { ...base, state: 'healthy', label: 'Verified', facts };
  })();

  // 7. Preview lifecycle. History alone proves nothing: a run is only
  // evidence for the configuration it was computed from.
  const preview = ((): SetupStep => {
    const runsHref = target ? `${targetHref}/runs` : targetHref;
    const base = { key: 'preview', number: 7, title: 'Preview lifecycle', href: runsHref, action: 'Preview lifecycle' };
    if (!target) return { ...base, state: 'setup', label: 'Not started', action: 'Connect target', facts: [] };
    if (isUnknown(evidence.runs)) {
      return { ...base, ...UNAVAILABLE, facts: [{ label: 'Run history', value: evidence.runs.error }] };
    }
    const latest = evidence.runs[0];
    if (!latest) return { ...base, state: 'setup', label: 'Not started', facts: [{ label: 'Latest run', value: 'None' }] };
    const current = reflects(latest, [profile?.updatedAt, rules ? latestChange(rules) : undefined]);
    const facts: StepFact[] = [
      { label: 'Latest run', value: latest.status },
      { label: 'Started', value: when(latest.startedAt) },
      { label: 'Reflects current configuration', value: yesNo(current) },
    ];
    const reason = latest.error ?? latest.blockedReason;
    if (reason) facts.push({ label: 'Reason', value: reason });
    if (latest.personsUnprocessable) facts.push({ label: 'Unprocessable', value: String(latest.personsUnprocessable) });
    const review = { href: `${runsHref}/${latest.id}`, action: 'Review lifecycle run' };
    if (REFUSED.has(latest.status)) return { ...base, ...review, state: 'blocked', label: latest.status === 'blocked' ? 'Run blocked' : 'Run failed', facts };
    if (MOVING.has(latest.status)) return { ...base, ...review, state: 'running', label: 'Running', facts };
    if (!current) return { ...base, state: 'attention', label: 'Older than configuration', facts };
    if (latest.personsUnprocessable) return { ...base, ...review, state: 'attention', label: 'Unprocessable people', facts };
    if (!PLANNED.has(latest.status)) return { ...base, ...review, state: 'pending', label: latest.status, facts };
    return { ...base, ...review, state: 'healthy', label: 'Verified', facts };
  })();

  // 8. Enable schedule. A schedule is a setting, never evidence: it is only
  // green once everything it would act on has been proven.
  const earlier = [hr, map, sample, connect, naming, access, preview];
  const schedule = ((): SetupStep => {
    const base = { key: 'schedule', number: 8, title: 'Enable schedule', href: targetHref, action: 'Configure schedule' };
    const facts: StepFact[] = [
      { label: 'HR schedule', value: source?.schedule ?? 'None' },
      { label: 'Target schedule', value: target?.schedule ?? 'None' },
      { label: 'Automatic apply', value: target ? (target.autoApply ? 'On' : 'Off') : '—' },
    ];
    if (!target) return { ...base, state: 'setup', label: 'Not started', action: 'Connect target', facts };
    if (!target.schedule) return { ...base, state: 'setup', label: 'Not scheduled', facts };
    if (!target.enabled) return { ...base, state: 'inactive', label: 'Target disabled', facts };
    const unproven = earlier.filter((step) => step.state !== 'healthy').length;
    if (unproven > 0) {
      return {
        ...base,
        state: 'attention',
        label: target.autoApply ? 'Applying before verification' : 'Scheduled before verification',
        facts: [...facts, { label: 'Unverified steps', value: String(unproven) }],
      };
    }
    return { ...base, state: 'healthy', label: 'Scheduled', facts };
  })();

  return [...earlier, schedule];
}

/** The page's one-word answer, from the steps. */
export function overallState(steps: SetupStep[]): { state: State; label: string } {
  const verified = steps.filter((step) => step.state === 'healthy').length;
  if (verified === steps.length) return { state: 'healthy', label: 'Ready' };
  if (steps.some((step) => step.state === 'blocked')) return { state: 'blocked', label: 'Blocked' };
  if (steps.some((step) => step.state === 'attention')) return { state: 'attention', label: 'Needs attention' };
  if (verified === 0 && steps.every((step) => step.state === 'setup')) return { state: 'setup', label: 'Not started' };
  return { state: 'pending', label: 'In progress' };
}
