import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Panel,
  Select,
  SkeletonRows,
  StateBadge,
  Status,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { EntraConnectorFields, HttpConnectorFields } from './TargetConnectorFields.js';
import { CapabilitiesPanel } from './TargetCapabilitiesPanel.js';
import { TargetAdapterPanel } from './TargetAdapterPanel.js';
import { TargetMigrationPanel } from './TargetMigrationPanel.js';
import { TargetHealthPanel } from './TargetHealthPanel.js';
import { TargetWriteStopPanel } from './TargetWriteStopPanel.js';
import { TargetMaintenancePanel } from './TargetMaintenancePanel.js';
import { TestReport, type TestResult } from './TargetTestReport.js';
import { StaleBadge, draftKey, draftStatus, summaryOf } from './DraftState.js';
import {
  BLANK,
  OWNED_CONFIG_KEYS,
  THRESHOLDS,
  configFromForm,
  formFrom,
  skipAdvice,
  validateNumbers,
  type EnforcementMode,
  type Form,
  type Target,
  type TargetType,
  type TlsMode,
} from './target-form.js';

/**
 * What each field is called on screen, keyed by the name the API reports a
 * problem under (the last path segment — see `fieldErrors`). The error summary
 * says "Accounts created: must be between 0 and 100", not
 * "createAccountThresholdPercent", and links to the box that says it.
 */
const LABELS: Record<string, string> = {
  name: 'Name',
  type: 'Type',
  url: 'URL',
  tlsMode: 'Transport',
  bindDn: 'Bind DN',
  bindPassword: 'Credential',
  baseDn: 'Base DN',
  entitlementSearchBase: 'Entitlement search base',
  archiveContainer: 'Archive container',
  baseUrl: 'Base URL',
  tenantId: 'Directory (tenant) ID',
  clientId: 'Application (client) ID',
  correlationField: 'Correlation field',
  document: 'Connector document',
  schedule: 'Schedule',
  enforcementMode: 'Enforcement mode',
  maxAttempts: 'Maximum attempts per action',
  preHireDays: 'Pre-hire days',
  entitlementRevocationDelayDays: 'Entitlement revocation delay (days)',
  disableGraceDays: 'Disable grace (days)',
  archiveAfterDays: 'Archive after (days)',
  reenableWithoutConfirmationDays: 'Re-enable without confirmation (days)',
  ...Object.fromEntries(THRESHOLDS),
};

const CONNECTION_FIELDS = new Set([
  'name', 'type', 'url', 'tlsMode', 'bindDn', 'bindPassword', 'baseDn',
  'entitlementSearchBase', 'archiveContainer', 'baseUrl', 'tenantId', 'clientId',
  'correlationField', 'document',
]);
const ENFORCEMENT_FIELDS = new Set(['schedule', 'enforcementMode', 'maxAttempts']);
const LADDER_FIELDS = new Set([
  'preHireDays', 'entitlementRevocationDelayDays', 'disableGraceDays',
  'archiveAfterDays', 'reenableWithoutConfirmationDays',
]);
const THRESHOLD_FIELDS = new Set<string>(THRESHOLDS.map(([key]) => key));

/** What a connection test sends, and so what its result describes. */
const testedDraft = (form: Form, extraConfig: Record<string, unknown>) =>
  draftKey({ type: form.type, config: configFromForm(form, extraConfig), secret: form.bindPassword });

/**
 * What stops this target provisioning anybody, read from the endpoints the
 * configuration pages already use: a 404 for the account profile, and a rule
 * list with no enabled rule that grants an account.
 *
 * Only a definite answer raises a warning. A refused or failed read says
 * nothing about the target, so it warns about nothing.
 */
function useConfigurationGaps(targetId: string | null): {
  noProfile: boolean;
  noAccountRule: boolean;
} {
  const [gaps, setGaps] = useState({ noProfile: false, noAccountRule: false });
  useEffect(() => {
    setGaps({ noProfile: false, noAccountRule: false });
    if (targetId === null) return;
    let cancelled = false;
    const profile = api(`/api/admin/targets/${targetId}/profile`).then(
      () => false,
      (cause: unknown) => cause instanceof ApiError && cause.problem.status === 404,
    );
    const rules = api<{ rules?: { enabled: boolean; grantsAccount: boolean }[] }>(
      `/api/admin/targets/${targetId}/rules`,
    )
      .then(
        (body) =>
          Array.isArray(body.rules) &&
          !body.rules.some((rule) => rule.enabled && rule.grantsAccount),
      )
      .catch(() => false);
    void Promise.all([profile, rules]).then(([noProfile, noAccountRule]) => {
      if (!cancelled) setGaps({ noProfile, noAccountRule });
    });
    return () => {
      cancelled = true;
    };
  }, [targetId]);
  return gaps;
}

export function TargetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  /**
   * The target this form is editing when the URL does not yet name one.
   *
   * The create is two requests: a POST that the create schema accepts, then a
   * PATCH carrying the deprovisioning ladder and the safety thresholds, which
   * are not on that schema. When the PATCH is refused the target EXISTS and
   * those numbers do not — and the old code navigated to the new target's route
   * anyway, which refetched it and rebuilt the form from the stored defaults,
   * discarding the very numbers the administrator was being asked to correct.
   *
   * So the navigate happens on success only. On a refusal the page stays put,
   * remembers the id, and turns into the editor for it: same boxes, same
   * values, and a Save that PATCHes rather than a Create that would make a
   * second target.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const targetId = id ?? createdId;
  const isNew = targetId === null;

  // Keyed on the ROUTE id, never on `createdId`: a read here would overwrite
  // the form with what the refused PATCH failed to store.
  const { data, error, loading, reload } = useApiResource<Target>(
    id === undefined ? null : `/api/admin/targets/${id}`,
  );

  const [form, setForm] = useState<Form>(BLANK);
  // What the form held when it last matched the server, so "Unsaved changes"
  // is a comparison rather than a flag some handler forgot to set.
  const [baseline, setBaseline] = useState<Form>(BLANK);
  const [extraConfig, setExtraConfig] = useState<Record<string, unknown>>({});
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'test'>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const gaps = useConfigurationGaps(isNew ? null : targetId);
  // The draft the result above was produced from. See `testStale`.
  const [resultFor, setResultFor] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const loaded = formFrom(data);
    setForm(loaded);
    setBaseline(loaded);
    setExtraConfig(
      Object.fromEntries(
        Object.entries(data.config ?? {}).filter(
          ([key]) => !OWNED_CONFIG_KEYS.includes(key),
        ),
      ),
    );
  }, [data]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const mark = (field: string): { error?: string } =>
    invalid[field] ? { error: invalid[field] } : {};

  /**
   * The test report describes the connection that was TESTED. The moment the
   * URL, the bind account or the secret differ from that, it describes some
   * other target, and is labelled so rather than left looking current. A
   * threshold edit does not touch it: nothing it reports depends on one.
   */
  const testStale = result !== null && resultFor !== testedDraft(form, extraConfig);
  const dirty = draftKey(form) !== draftKey(baseline);

  function fail(cause: unknown, fallback: string) {
    const marked = fieldErrors(cause);
    setInvalid(marked);
    if (Object.keys(marked).length > 0) {
      setProblem(null);
    } else if (cause instanceof ApiError) {
      setProblem(cause.problem.detail ?? cause.problem.title ?? fallback);
    } else {
      setProblem(fallback);
    }
  }

  async function onTest() {
    setBusy('test');
    setInvalid({});
    setProblem(null);
    setResult(null);
    const sentFor = testedDraft(form, extraConfig);
    try {
      const answer = await api<TestResult>('/api/admin/targets/test', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          config: configFromForm(form, extraConfig),
          // Sent only when it was typed. Otherwise the saved target is
          // named and the server reads its own vault entry: the browser is
          // never handed the stored password to send back.
          ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          ...(targetId === null ? {} : { borrowFromTargetId: targetId }),
        }),
      });
      // Bound to what was SENT, not to what is on screen when the answer
      // lands: an edit made while the test was in flight leaves the result
      // arriving already out of date, and it says so.
      setResult(answer);
      setResultFor(sentFor);
    } catch (cause) {
      fail(cause, 'The connection could not be tested.');
    } finally {
      setBusy(null);
    }
  }

  async function onSave(event?: FormEvent) {
    event?.preventDefault();
    setBusy('save');
    setInvalid({});
    setProblem(null);
    setNotice(null);

    const parsed = validateNumbers(form);
    if ('bad' in parsed) {
      // Every bad field found in one pass, merged rather than replacing
      // `invalid` - a form with three malformed thresholds shows three
      // errors, not one at a time as each is fixed in turn.
      setInvalid((prev) => ({ ...prev, ...parsed.bad }));
      setBusy(null);
      return;
    }
    const n = parsed.values;

    try {
      if (isNew) {
        const created = await api<{ id: string }>('/api/admin/targets', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            type: form.type,
            config: configFromForm(form, extraConfig),
            bindPassword: form.bindPassword,
            schedule: form.schedule.trim() === '' ? null : form.schedule.trim(),
            autoApply: form.autoApply,
            enabled: form.enabled,
            enforcementMode: form.enforcementMode,
          }),
        });
        // The ladder and the thresholds are not on the create schema, so they
        // are saved by the same PATCH the editor uses. A failure here leaves
        // the target created, which the notice says rather than pretending.
        try {
          await api(`/api/admin/targets/${created.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              preHireDays: n.preHireDays,
              maxAttempts: n.maxAttempts,
              ladder: {
                entitlementRevocationDelayDays: n.entitlementRevocationDelayDays,
                disableGraceDays: n.disableGraceDays,
                archiveAfterDays: n.archiveAfterDays,
                reenableWithoutConfirmationDays:
                  n.reenableWithoutConfirmationDays,
                renameEnabled: form.renameEnabled,
              },
              thresholds: Object.fromEntries(
                THRESHOLDS.map(([key]) => [key, n[key]]),
              ),
            }),
          });
          toast({ tone: 'success', title: 'Target created' });
          navigate(`/admin/targets/${created.id}`, { replace: true });
        } catch (cause) {
          // No navigate. Said whether or not the refusal named fields: "the
          // target exists" is the fact that decides what to do next, and
          // `fail` puts the field-level messages on their own controls.
          setCreatedId(created.id);
          setNotice(
            'The target was created, but its deprovisioning ladder and safety ' +
              'thresholds were refused and are not saved. What you typed is ' +
              'still in the boxes below — correct it and press Save.',
          );
          fail(cause, 'The ladder and thresholds were refused.');
        }
        return;
      }

      await api(`/api/admin/targets/${targetId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name.trim(),
          config: configFromForm(form, extraConfig),
          // Absent means unchanged. This is the only way to edit a target
          // without the stored credential making a round trip to a browser.
          ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          schedule: form.schedule.trim() === '' ? null : form.schedule.trim(),
          autoApply: form.autoApply,
          enabled: form.enabled,
          enforcementMode: form.enforcementMode,
          preHireDays: n.preHireDays,
          maxAttempts: n.maxAttempts,
          ladder: {
            entitlementRevocationDelayDays: n.entitlementRevocationDelayDays,
            disableGraceDays: n.disableGraceDays,
            archiveAfterDays: n.archiveAfterDays,
            reenableWithoutConfirmationDays: n.reenableWithoutConfirmationDays,
            renameEnabled: form.renameEnabled,
          },
          thresholds: Object.fromEntries(THRESHOLDS.map(([key]) => [key, n[key]])),
        }),
      });
      const saved = { ...form, bindPassword: '' };
      setForm(saved);
      setBaseline(saved);
      toast({ tone: 'success', title: 'Target saved' });
      // The URL catches up once the target and the form agree. Until then the
      // page deliberately stayed on `/new` so a refetch could not overwrite
      // what had not been stored yet.
      if (id === undefined && createdId !== null) {
        navigate(`/admin/targets/${createdId}`, { replace: true });
        return;
      }
      reload();
    } catch (cause) {
      fail(cause, 'The target could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!isNew && loading && !data) {
    return (
      <Panel>
        <SkeletonRows rows={8} cols={2} />
      </Panel>
    );
  }

  /** How many of this stage's fields were refused, as the stage's state. */
  const refusedIn = (fields: Set<string>) => {
    const count = Object.keys(invalid).filter((key) => fields.has(key)).length;
    return count > 0 ? (
      <StateBadge state="blocked">{count === 1 ? '1 to fix' : `${count} to fix`}</StateBadge>
    ) : null;
  };

  const connectionState =
    refusedIn(CONNECTION_FIELDS) ??
    (busy === 'test' ? (
      <StateBadge state="running">Testing</StateBadge>
    ) : result === null ? (
      <StateBadge state="setup">Not tested</StateBadge>
    ) : testStale ? (
      <StaleBadge />
    ) : result.ok ? (
      <StateBadge state="healthy">Tested</StateBadge>
    ) : (
      <StateBadge state="blocked">Test failed</StateBadge>
    ));

  return (
    <>
      <PageHeader title={isNew ? 'New target' : form.name || 'Target system'} />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}

        {/*
          The skipped-run notice sits above everything somebody came here to
          change, because ruling P4 is explicit that a skipped run has to be
          surfaced where somebody looks rather than only recorded. A target
          that has skipped repeatedly must read differently from one running
          cleanly, and the count is what makes that visible at a glance.
        */}
        {data && data.consecutiveSkippedRuns > 0 && (
          <Alert
            tone="danger"
            title={`${data.consecutiveSkippedRuns} scheduled run${
              data.consecutiveSkippedRuns === 1 ? '' : 's'
            } did not start`}
          >
            <p>{data.lastSkipReason}</p>
            <p className="mt-2">{skipAdvice(data.lastSkipReason)}</p>
            {(data.lastSkipReason ?? '').includes('is awaiting review') && (
              <p className="mt-2">
                <Link to={`/admin/targets/${targetId}/runs`} className="link font-medium">
                  Go to the runs for this target
                </Link>
              </p>
            )}
          </Alert>
        )}

        {/*
          One form, in stages, essentials first. It used to be four panels
          with the save four screens above the last of them; the thresholds
          somebody opens this page to correct were below the bind password
          they did not come to touch. The stages are in the order a first
          target is set up — connect, decide how it is enforced, then the
          timings and guards most targets never change — and the completion
          controls travel with the form rather than sitting at the top of it.

          Not a Panel: `overflow-hidden` on a panel would pin the sticky bar
          to the panel's own box, so it would never stick.
        */}
        <form
          onSubmit={(event) => void onSave(event)}
          noValidate
          aria-label={isNew ? 'New target' : 'Target settings'}
          className="space-y-6 rounded-panel border border-border-subtle bg-bg px-4 pt-4"
        >
          <ErrorSummary errors={summaryOf(invalid, LABELS)} />

          <FormSection title="Connection" status={connectionState}>
            <Field
              label="Name"
              name="name"
              value={form.name}
              onChange={(v) => set('name', v)}
              {...mark('name')}
              className="sm:col-span-2"
            />
            <Select
              label="Type"
              name="type"
              value={form.type}
              onChange={(v) => set('type', v as TargetType)}
              // Changing a target's connector type after accounts exist has no
              // migration story, so the console does not offer it: fixed at
              // creation, same as the type column itself once a target holds
              // any accounts.
              disabled={!isNew}
              {...mark('type')}
              options={[
                { value: 'activeDirectory', label: 'Active Directory' },
                { value: 'entraId', label: 'Microsoft Entra ID (native)' },
                { value: 'scim2', label: 'SCIM 2.0' },
                { value: 'httpJson', label: 'REST API' },
              ]}
              className="sm:col-span-2"
            />
            {form.type === 'httpJson' ? (
              <HttpConnectorFields
                isNew={isNew}
                documentKey={form.documentKey}
                documentJson={form.documentJson}
                credential={form.bindPassword}
                entraTenantId={form.entraTenantId}
                entraClientId={form.entraClientId}
                onPick={(key, document) => {
                  setForm((current) => ({
                    ...current,
                    documentKey: key,
                    documentJson: JSON.stringify(document, null, 2),
                    // The document names the target. Taking the name from it
                    // saves the one keystroke everybody would spend typing what
                    // they just picked.
                    name: current.name === '' ? String(document.name ?? '') : current.name,
                  }));
                }}
                onDocumentChange={(v) => set('documentJson', v)}
                onCredentialChange={(v) => set('bindPassword', v)}
                onEntraTenantIdChange={(v) => set('entraTenantId', v)}
                onEntraClientIdChange={(v) => set('entraClientId', v)}
              />
            ) : form.type === 'entraId' ? (
              <EntraConnectorFields
                isNew={isNew}
                tenantId={form.entraTenantId}
                clientId={form.entraClientId}
                credential={form.bindPassword}
                correlationField={form.entraCorrelationField}
                userPrincipalDomain={form.entraUserPrincipalDomain}
                onUserPrincipalDomainChange={(v) => set('entraUserPrincipalDomain', v)}
                onTenantIdChange={(v) => set('entraTenantId', v)}
                onClientIdChange={(v) => set('entraClientId', v)}
                onCredentialChange={(v) => set('bindPassword', v)}
                onCorrelationFieldChange={(v) => set('entraCorrelationField', v)}
                mark={mark}
              />
            ) : form.type === 'activeDirectory' ? (
              <>
                <Field
                  label="URL"
                  name="url"
                  value={form.url}
                  onChange={(v) => set('url', v)}
                  {...mark('url')}
                />
                <Select
                  label="Transport"
                  name="tlsMode"
                  value={form.tlsMode}
                  onChange={(v) => set('tlsMode', v as TlsMode)}
                  {...mark('tlsMode')}
                  options={[
                    { value: 'ldaps', label: 'LDAPS' },
                    { value: 'starttls', label: 'StartTLS' },
                  ]}
                />
                <Check
                  className="sm:col-span-2"
                  checked={form.rejectUnauthorized}
                  onChange={(v) => set('rejectUnauthorized', v)}
                  label="Verify the directory server's TLS certificate"
                  warning={
                    form.rejectUnauthorized
                      ? undefined
                      : 'Any certificate is accepted, including an impostor’s.'
                  }
                />
                <Field
                  label="Bind DN"
                  name="bindDn"
                  value={form.bindDn}
                  onChange={(v) => set('bindDn', v)}
                  {...mark('bindDn')}
                />
                <Field
                  label="Bind password"
                  name="bindPassword"
                  type="password"
                  autoComplete="new-password"
                  value={form.bindPassword}
                  onChange={(v) => set('bindPassword', v)}
                  placeholder={isNew ? undefined : 'Leave blank to keep the stored password'}
                  {...mark('bindPassword')}
                />
                <Field
                  label="Base DN"
                  name="baseDn"
                  value={form.baseDn}
                  onChange={(v) => set('baseDn', v)}
                  {...mark('baseDn')}
                />
                <Field
                  label="Entitlement search base"
                  name="entitlementSearchBase"
                  value={form.entitlementSearchBase}
                  onChange={(v) => set('entitlementSearchBase', v)}
                  {...mark('entitlementSearchBase')}
                />
                <Field
                  label="Archive container"
                  name="archiveContainer"
                  value={form.archiveContainer}
                  onChange={(v) => set('archiveContainer', v)}
                  {...mark('archiveContainer')}
                  className="sm:col-span-2"
                />
              </>
            ) : (
              <>
                <Field
                  label="Base URL"
                  name="baseUrl"
                  value={form.baseUrl}
                  onChange={(v) => set('baseUrl', v)}
                  {...mark('baseUrl')}
                  className="sm:col-span-2"
                />
                <Field
                  label="Bearer token"
                  name="bindPassword"
                  type="password"
                  autoComplete="new-password"
                  value={form.bindPassword}
                  onChange={(v) => set('bindPassword', v)}
                  placeholder={isNew ? undefined : 'Leave blank to keep the stored token'}
                  {...mark('bindPassword')}
                  className="sm:col-span-2"
                />
              </>
            )}
            {/* The result sits in the stage it is about, directly under the
                fields it was run against, so an edit and the badge that says
                the result no longer applies are in one glance. */}
            {result && <TestReport result={result} stale={testStale} />}
          </FormSection>

          {/*
            These three links are the only route into the rest of the target's
            configuration. Without them the sub-pages exist and are reachable
            only by typing a URL, which is the same as not existing.

            Directly under Connection, as a section of its own: what stops a
            saved target provisioning anybody -- no account profile, no rule
            that grants an account -- is the next thing to know once it
            connects, and at the foot of a four-section form it went unseen.
          */}
          {!isNew && (
            <FormSection title="Configuration">
              <div className="space-y-3 sm:col-span-2">
                {gaps.noProfile && (
                  <Alert tone="warning">
                    This target has no account profile, so it cannot create accounts.
                  </Alert>
                )}
                {gaps.noAccountRule && (
                  <Alert tone="warning">
                    No business rule grants an account on this target, so no one will be provisioned.
                  </Alert>
                )}
                <ul className="flex flex-wrap gap-x-6 gap-y-2">
                  <li>
                    <Link className="link font-medium" to={`/admin/targets/${targetId}/profile`}>
                      Account profile
                    </Link>
                  </li>
                  <li>
                    <Link className="link font-medium" to={`/admin/targets/${targetId}/rules`}>
                      Business rules
                    </Link>
                  </li>
                  <li>
                    <Link className="link font-medium" to={`/admin/targets/${targetId}/runs`}>
                      Runs
                    </Link>
                  </li>
                </ul>
              </div>
            </FormSection>
          )}

          <FormSection title="Schedule and enforcement" status={refusedIn(ENFORCEMENT_FIELDS)}>
            <Select
              label="Enforcement mode"
              name="enforcementMode"
              value={form.enforcementMode}
              onChange={(v) => set('enforcementMode', v as EnforcementMode)}
              {...mark('enforcementMode')}
              // Ruling P2, on the target's own screen. Drift is reported under
              // both modes; what changes is whether Provision acts on it.
              options={[
                { value: 'additive', label: 'Additive — only grants and takes back its own' },
                { value: 'authoritative', label: 'Authoritative — removes what rules do not grant' },
              ]}
            />
            <Field
              label="Schedule"
              name="schedule"
              value={form.schedule}
              onChange={(v) => set('schedule', v)}
              placeholder="0 3 * * *"
              {...mark('schedule')}
            />
            <Check
              className="sm:col-span-2"
              checked={form.enabled}
              onChange={(v) => set('enabled', v)}
              label="Enabled"
            />
            <Check
              className="sm:col-span-2"
              checked={form.autoApply}
              onChange={(v) => set('autoApply', v)}
              label="Apply scheduled runs automatically"
            />
            <Field
              label="Maximum attempts per action"
              name="maxAttempts"
              value={form.maxAttempts}
              onChange={(v) => set('maxAttempts', v)}
              inputMode="numeric"
              {...mark('maxAttempts')}
            />
          </FormSection>

          <FormSection title="Lifecycle timings" status={refusedIn(LADDER_FIELDS)}>
            <Field
              label="Pre-hire days"
              name="preHireDays"
              value={form.preHireDays}
              onChange={(v) => set('preHireDays', v)}
              inputMode="numeric"
              {...mark('preHireDays')}
            />
            <Field
              label="Entitlement revocation delay (days)"
              name="entitlementRevocationDelayDays"
              value={form.entitlementRevocationDelayDays}
              onChange={(v) => set('entitlementRevocationDelayDays', v)}
              inputMode="numeric"
              {...mark('entitlementRevocationDelayDays')}
            />
            <Field
              label="Disable grace (days)"
              name="disableGraceDays"
              value={form.disableGraceDays}
              onChange={(v) => set('disableGraceDays', v)}
              inputMode="numeric"
              {...mark('disableGraceDays')}
            />
            <Field
              label="Archive after (days)"
              name="archiveAfterDays"
              value={form.archiveAfterDays}
              onChange={(v) => set('archiveAfterDays', v)}
              inputMode="numeric"
              placeholder="Never"
              {...mark('archiveAfterDays')}
            />
            <Field
              label="Re-enable without confirmation (days)"
              name="reenableWithoutConfirmationDays"
              value={form.reenableWithoutConfirmationDays}
              onChange={(v) => set('reenableWithoutConfirmationDays', v)}
              inputMode="numeric"
              {...mark('reenableWithoutConfirmationDays')}
            />
            <Check
              className="sm:col-span-2"
              checked={form.renameEnabled}
              onChange={(v) => set('renameEnabled', v)}
              label="Rename an account when the person's name changes"
            />
          </FormSection>

          <FormSection
            title="Safety thresholds"
            // A percent to confirm past, not the guard's other refusal.
            // `guard.ts` also withholds confirmation when it cannot compute a
            // number at all — no persons on an active contract, a collapsed
            // population, a target with no accounts, a missing denominator —
            // and that kind is never a number typed here, so it is never a
            // field in this stage. The badge names which kind these seven are;
            // the run's own screen is where the other kind, and why, is shown.
            status={
              refusedIn(THRESHOLD_FIELDS) ?? <Status tone="neutral">Confirmable by number</Status>
            }
          >
            {THRESHOLDS.map(([key, label]) => (
              <Field
                key={key}
                label={label}
                name={key}
                value={form[key]}
                onChange={(v) => set(key, v)}
                inputMode="numeric"
                {...mark(key)}
              />
            ))}
          </FormSection>

          <FormActions
            sticky
            status={draftStatus({
              dirty,
              stale: testStale ? 'Test result is out of date' : null,
            })}
          >
            <Button type="button" onClick={onTest} loading={busy === 'test'} disabled={!!busy}>
              Test connection
            </Button>
            <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!!busy}>
              {isNew ? 'Create target' : 'Save'}
            </Button>
          </FormActions>
        </form>

        {!isNew && targetId !== null && <CapabilitiesPanel targetId={targetId} />}
        {!isNew && targetId !== null && <TargetAdapterPanel targetId={targetId} />}
        {!isNew && data && <TargetWriteStopPanel target={data} onChanged={reload} />}
        {!isNew && data && <TargetMaintenancePanel target={data} onChanged={reload} />}
        {!isNew && targetId !== null && <TargetHealthPanel targetId={targetId} />}
        {!isNew && targetId !== null && data?.type === 'httpJson' && (
          <TargetMigrationPanel targetId={targetId} onApplied={reload} />
        )}
      </div>
    </>
  );
}
