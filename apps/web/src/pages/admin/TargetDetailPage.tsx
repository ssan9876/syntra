import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  Field,
  Panel,
  Select,
  SkeletonRows,
  Status,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { HttpConnectorFields } from './TargetConnectorFields.js';
import { TestReport, type TestResult } from './TargetTestReport.js';
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

export function TargetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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
  const [extraConfig, setExtraConfig] = useState<Record<string, unknown>>({});
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'test'>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!data) return;
    setForm(formFrom(data));
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
    try {
      setResult(
        await api<TestResult>('/api/admin/targets/test', {
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
        }),
      );
    } catch (cause) {
      fail(cause, 'The connection could not be tested.');
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
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
      setForm((current) => ({ ...current, bindPassword: '' }));
      setNotice('Saved.');
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
  if (!isNew && loading) {
    return (
      <Panel>
        <SkeletonRows rows={8} cols={2} />
      </Panel>
    );
  }

  return (
    <>
      <PageHeader
        title={isNew ? 'New target' : form.name || 'Target system'}
        actions={
          <>
            <Button onClick={onTest} loading={busy === 'test'} disabled={!!busy}>
              Test connection
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              loading={busy === 'save'}
              disabled={!!busy}
            >
              {isNew ? 'Create target' : 'Save'}
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {Object.keys(invalid).length > 0 && (
          <Alert tone="danger" title="Some of this was refused">
            The fields concerned are marked below.
          </Alert>
        )}

        {result && <TestReport result={result} />}

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
                <Link
                  to={`/admin/targets/${targetId}/runs`}
                  className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                >
                  Go to the runs for this target
                </Link>
              </p>
            )}
          </Alert>
        )}

        <Panel title="Connection" bodyClassName="grid gap-4 p-4 sm:grid-cols-2">
          <Field
            label="Name"
            value={form.name}
            onChange={(v) => set('name', v)}
            {...mark('name')}
            className="sm:col-span-2"
          />
          <Select
            label="Type"
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
            />
          ) : form.type === 'activeDirectory' ? (
            <>
              <Field
                label="URL"
                value={form.url}
                onChange={(v) => set('url', v)}
                {...mark('url')}
              />
              <Select
                label="Transport"
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
              />
              <Field
                label="Bind DN"
                value={form.bindDn}
                onChange={(v) => set('bindDn', v)}
                {...mark('bindDn')}
              />
              <Field
                label="Bind password"
                type="password"
                autoComplete="new-password"
                value={form.bindPassword}
                onChange={(v) => set('bindPassword', v)}
                {...mark('bindPassword')}
              />
              <Field
                label="Base DN"
                value={form.baseDn}
                onChange={(v) => set('baseDn', v)}
                {...mark('baseDn')}
              />
              <Field
                label="Entitlement search base"
                value={form.entitlementSearchBase}
                onChange={(v) => set('entitlementSearchBase', v)}
                {...mark('entitlementSearchBase')}
              />
              <Field
                label="Archive container"
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
                value={form.baseUrl}
                onChange={(v) => set('baseUrl', v)}
                {...mark('baseUrl')}
                className="sm:col-span-2"
              />
              <Field
                label="Bearer token"
                type="password"
                autoComplete="new-password"
                value={form.bindPassword}
                onChange={(v) => set('bindPassword', v)}
                {...mark('bindPassword')}
                className="sm:col-span-2"
              />
            </>
          )}
        </Panel>

        {/*
          These three links are the only route into the rest of the target's
          configuration. Without them the sub-pages exist and are reachable
          only by typing a URL, which is the same as not existing.
        */}
        {!isNew && (
          <Panel title="Configuration">
            <ul className="space-y-3 p-4">
              <li>
                <Link
                  className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                  to={`/admin/targets/${targetId}/profile`}
                >
                  Account profile
                </Link>
              </li>
              <li>
                <Link
                  className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                  to={`/admin/targets/${targetId}/rules`}
                >
                  Business rules
                </Link>
                <span className="ml-2 text-muted">
                  Who gets an account here, and which entitlements come with it.
                </span>
              </li>
              <li>
                <Link
                  className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                  to={`/admin/targets/${targetId}/runs`}
                >
                  Runs
                </Link>
                <span className="ml-2 text-muted">
                  What each run proposed, what was applied, and what drifted.
                </span>
              </li>
            </ul>
          </Panel>
        )}

        <Panel
          title="Schedule and enforcement"
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="Schedule"
            value={form.schedule}
            onChange={(v) => set('schedule', v)}
            placeholder="0 3 * * *"
            {...mark('schedule')}
          />
          <Select
            label="Enforcement mode"
            value={form.enforcementMode}
            onChange={(v) => set('enforcementMode', v as EnforcementMode)}
            {...mark('enforcementMode')}
            // Ruling P2, on the target's own screen. Drift is reported under
            // both modes; what changes is whether Provision acts on it.
            options={[
              { value: 'additive', label: 'Additive' },
              { value: 'authoritative', label: 'Authoritative' },
            ]}
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
        </Panel>

        <Panel
          title="Deprovisioning ladder"
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="Pre-hire days"
            value={form.preHireDays}
            onChange={(v) => set('preHireDays', v)}
            inputMode="numeric"
            {...mark('preHireDays')}
          />
          <Field
            label="Entitlement revocation delay (days)"
            value={form.entitlementRevocationDelayDays}
            onChange={(v) => set('entitlementRevocationDelayDays', v)}
            inputMode="numeric"
            {...mark('entitlementRevocationDelayDays')}
          />
          <Field
            label="Disable grace (days)"
            value={form.disableGraceDays}
            onChange={(v) => set('disableGraceDays', v)}
            inputMode="numeric"
            {...mark('disableGraceDays')}
          />
          <Field
            label="Archive after (days)"
            value={form.archiveAfterDays}
            onChange={(v) => set('archiveAfterDays', v)}
            inputMode="numeric"
            {...mark('archiveAfterDays')}
          />
          <Field
            label="Re-enable without confirmation (days)"
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
        </Panel>

        <Panel
          title="Safety thresholds"
          // A percent to confirm past, not the guard's other refusal.
          // `guard.ts` also withholds confirmation when it cannot compute a
          // number at all — no persons on an active contract, a collapsed
          // population, a target with no accounts, a missing denominator —
          // and that kind is never a number typed here, so it is never a
          // field on this panel. The badge names which kind these seven are;
          // the run's own screen is where the other kind, and why, is shown.
          actions={<Status tone="neutral">Confirmable by number</Status>}
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          {THRESHOLDS.map(([key, label]) => (
            <Field
              key={key}
              label={label}
              value={form[key]}
              onChange={(v) => set(key, v)}
              inputMode="numeric"
              {...mark(key)}
            />
          ))}
        </Panel>
      </div>
    </>
  );
}
