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

type TlsMode = 'ldaps' | 'starttls';
type EnforcementMode = 'additive' | 'authoritative';

interface ConnectorRight {
  right: 'createUser' | 'modifyUser' | 'moveUser' | 'modifyMembership';
  status: 'granted' | 'denied' | 'unverified';
  detail: string;
}

interface TestResult {
  ok: boolean;
  message: string;
  rights?: ConnectorRight[];
}

interface Target {
  id: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  autoApply: boolean;
  schedule: string | null;
  enforcementMode: EnforcementMode;
  preHireDays: number;
  entitlementRevocationDelayDays: number;
  disableGraceDays: number;
  archiveAfterDays: number | null;
  reenableWithoutConfirmationDays: number;
  renameEnabled: boolean;
  createAccountThresholdPercent: number;
  disableAccountThresholdPercent: number;
  archiveAccountThresholdPercent: number;
  revokeEntitlementThresholdPercent: number;
  deactivateSyntraUserThresholdPercent: number;
  perEntitlementThresholdPercent: number;
  personPopulationDropPercent: number;
  consecutiveSkippedRuns: number;
  lastSkipReason: string | null;
}

const RIGHT_LABELS: Record<ConnectorRight['right'], string> = {
  createUser: 'Create accounts',
  modifyUser: 'Modify accounts',
  moveUser: 'Move accounts between containers',
  modifyMembership: 'Change group membership',
};

/**
 * `unverified` renders as its own tone, never as a quiet `granted`.
 *
 * A directory that does not publish effective rights cannot be read as having
 * granted them. Collapsing the two turns "we could not tell" into "yes", which
 * is the one reading an administrator must not be given by a screen whose
 * whole job is to answer whether this bind account can do the work — a bind
 * that can read the directory but cannot create users passes an `ok: true`
 * connection test, and this list is the only thing that says so before a run
 * fails against a live directory.
 *
 * `warning` rather than a neutral grey, which is where the plan's `muted`
 * would have landed: a quiet badge beside two green ones reads as agreement.
 * Amber is the only tone in the system that says "look at this" without
 * claiming a refusal happened.
 */
function rightTone(
  status: ConnectorRight['status'],
): 'active' | 'danger' | 'warning' {
  if (status === 'granted') return 'active';
  if (status === 'denied') return 'danger';
  return 'warning';
}

function RightsReport({ rights }: { rights: ConnectorRight[] }) {
  return (
    <ul className="space-y-2">
      {rights.map((r) => (
        <li key={r.right} className="flex flex-wrap items-center gap-2">
          <Status tone={rightTone(r.status)}>
            {r.status === 'unverified' ? 'Could not check' : r.status}
          </Status>
          <span className="text-ink">{RIGHT_LABELS[r.right]}</span>
          <span className="text-muted">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function TestReport({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Could not connect">
        {result.message}
      </Alert>
    );
  }

  return (
    <Panel title="Connection test">
      <div className="space-y-4 p-4">
        <p className="flex flex-wrap items-center gap-2">
          <Status tone="active">Connected</Status>
          <span className="text-muted">{result.message}</span>
        </p>
        {result.rights && result.rights.length > 0 && (
          <>
            <p className="text-muted">
              What this bind account is allowed to do. A right it could not
              confirm is not a right it has.
            </p>
            <RightsReport rights={result.rights} />
          </>
        )}
      </div>
    </Panel>
  );
}

interface Form {
  name: string;
  url: string;
  tlsMode: TlsMode;
  rejectUnauthorized: boolean;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  entitlementSearchBase: string;
  archiveContainer: string;
  schedule: string;
  enabled: boolean;
  autoApply: boolean;
  enforcementMode: EnforcementMode;
  preHireDays: string;
  entitlementRevocationDelayDays: string;
  disableGraceDays: string;
  archiveAfterDays: string;
  reenableWithoutConfirmationDays: string;
  renameEnabled: boolean;
  createAccountThresholdPercent: string;
  disableAccountThresholdPercent: string;
  archiveAccountThresholdPercent: string;
  revokeEntitlementThresholdPercent: string;
  deactivateSyntraUserThresholdPercent: string;
  perEntitlementThresholdPercent: string;
  personPopulationDropPercent: string;
}

const BLANK: Form = {
  name: '',
  url: 'ldaps://',
  // No `plain`. `targetConfigSchema` does not offer it, and a target that
  // could be configured to write in the clear is a target that eventually
  // does.
  tlsMode: 'ldaps',
  rejectUnauthorized: true,
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  entitlementSearchBase: '',
  archiveContainer: '',
  schedule: '',
  enabled: true,
  autoApply: false,
  enforcementMode: 'additive',
  preHireDays: '0',
  entitlementRevocationDelayDays: '0',
  disableGraceDays: '0',
  archiveAfterDays: '',
  reenableWithoutConfirmationDays: '7',
  renameEnabled: false,
  createAccountThresholdPercent: '20',
  disableAccountThresholdPercent: '10',
  archiveAccountThresholdPercent: '2',
  revokeEntitlementThresholdPercent: '10',
  deactivateSyntraUserThresholdPercent: '10',
  perEntitlementThresholdPercent: '50',
  personPopulationDropPercent: '20',
};

/** Config keys this form owns. Anything else on a saved target is carried through. */
const OWNED_CONFIG_KEYS = [
  'url',
  'tlsMode',
  'rejectUnauthorized',
  'bindDn',
  'baseDn',
  'entitlementSearchBase',
  'archiveContainer',
];

const THRESHOLDS = [
  ['createAccountThresholdPercent', 'Accounts created'],
  ['disableAccountThresholdPercent', 'Accounts disabled'],
  ['archiveAccountThresholdPercent', 'Accounts archived'],
  ['revokeEntitlementThresholdPercent', 'Entitlements revoked'],
  ['deactivateSyntraUserThresholdPercent', 'Syntra logins deactivated'],
  ['perEntitlementThresholdPercent', 'Holders of any one entitlement'],
  ['personPopulationDropPercent', 'Drop in the person population'],
] as const;

const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

/**
 * What to do about a skipped schedule, per the reason that was actually
 * recorded.
 *
 * `jobs.ts` writes three distinct reasons and they call for three different
 * things, so one sentence covering all of them is wrong for at least two:
 *
 * - `…is awaiting review (previewed|blocked)…` — there is a plan somebody has
 *   been asked to decide about. Reviewing it is what clears this.
 * - `…is still in progress (running|applying)…` — there is nothing to review.
 *   It clears when the run finishes, or after `STALE_RUN_MS`, at which point
 *   `previewProvisionRun` treats the row as the wreckage of a dead process and
 *   adopts it.
 * - `another run for target … is already in progress; this one did not start`
 *   — `recordSkip` on `ProvisionRunInFlightError`: two runs raced between the
 *   skip check and the create, and the partial unique index refused the second.
 *
 * Matched on the phrases `jobs.ts` and `run-service.ts` compose, not on the
 * status in the brackets, because the reason string is what the API returns and
 * the status is embedded in it.
 */
function skipAdvice(reason: string | null): string {
  if (reason !== null && reason.includes('is awaiting review')) {
    return (
      'A scheduled run does not start while a run is awaiting review, so that ' +
      'the plan somebody was asked to approve is not superseded every night. ' +
      'Review the outstanding run and this clears on the next schedule.'
    );
  }
  if (reason !== null && reason.includes('already in progress')) {
    return (
      'Two runs raced for this target and the second did not start. There is ' +
      'nothing to review and nothing to do: the next schedule runs normally.'
    );
  }
  if (reason !== null && reason.includes('is still in progress')) {
    return (
      'There is nothing to review here: a run was still going when this ' +
      'schedule fired. It clears when that run finishes — or six hours after ' +
      'that run last showed any sign of progress, when a later run treats it ' +
      'as the wreckage of a process that died and adopts it.'
    );
  }
  return (
    'A scheduled run did not start. The reason was not recorded, so the runs ' +
    'for this target are the place to look.'
  );
}

function formFrom(target: Target): Form {
  const config = target.config ?? {};
  const url = text(config.url, BLANK.url);
  return {
    name: target.name,
    url,
    tlsMode:
      config.tlsMode === 'starttls' || config.tlsMode === 'ldaps'
        ? config.tlsMode
        : url.trim().toLowerCase().startsWith('ldaps:')
          ? 'ldaps'
          : 'starttls',
    rejectUnauthorized: config.rejectUnauthorized !== false,
    bindDn: text(config.bindDn),
    // Never populated. The vault holds it, the API never returns it, and an
    // empty box on an edit form means "leave it alone".
    bindPassword: '',
    baseDn: text(config.baseDn),
    entitlementSearchBase: text(config.entitlementSearchBase),
    archiveContainer: text(config.archiveContainer),
    schedule: target.schedule ?? '',
    enabled: target.enabled,
    autoApply: target.autoApply,
    enforcementMode: target.enforcementMode,
    preHireDays: String(target.preHireDays),
    entitlementRevocationDelayDays: String(target.entitlementRevocationDelayDays),
    disableGraceDays: String(target.disableGraceDays),
    // Null means never, and an empty box is how "never" is typed.
    archiveAfterDays:
      target.archiveAfterDays === null ? '' : String(target.archiveAfterDays),
    reenableWithoutConfirmationDays: String(
      target.reenableWithoutConfirmationDays,
    ),
    renameEnabled: target.renameEnabled,
    createAccountThresholdPercent: String(target.createAccountThresholdPercent),
    disableAccountThresholdPercent: String(target.disableAccountThresholdPercent),
    archiveAccountThresholdPercent: String(target.archiveAccountThresholdPercent),
    revokeEntitlementThresholdPercent: String(
      target.revokeEntitlementThresholdPercent,
    ),
    deactivateSyntraUserThresholdPercent: String(
      target.deactivateSyntraUserThresholdPercent,
    ),
    perEntitlementThresholdPercent: String(target.perEntitlementThresholdPercent),
    personPopulationDropPercent: String(target.personPopulationDropPercent),
  };
}

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

  function configFromForm(): Record<string, unknown> {
    return {
      ...extraConfig,
      url: form.url.trim(),
      tlsMode: form.tlsMode,
      rejectUnauthorized: form.rejectUnauthorized,
      bindDn: form.bindDn.trim(),
      baseDn: form.baseDn.trim(),
      entitlementSearchBase: form.entitlementSearchBase.trim(),
      archiveContainer: form.archiveContainer.trim(),
    };
  }

  /**
   * The numbers, or the field that is not one.
   *
   * Checked here rather than left to the server because a `PATCH` carrying
   * `NaN` serialises to `null` and comes back as a type error against a field
   * nobody typed in. Every one of these is a percentage or a day count that
   * the guard or the ladder reads.
   */
  function numbers(): { values: Record<string, number | null> } | { bad: string } {
    const values: Record<string, number | null> = {};
    const whole = (key: keyof Form, max: number) => {
      const raw = String(form[key]).trim();
      const value = Number(raw);
      if (raw === '' || !Number.isInteger(value) || value < 0 || value > max) {
        return `a whole number between 0 and ${max}`;
      }
      values[key] = value;
      return null;
    };

    for (const [key] of THRESHOLDS) {
      const bad = whole(key, 100);
      if (bad) {
        setInvalid({ [key]: bad });
        return { bad: key };
      }
    }
    for (const key of [
      'preHireDays',
      'entitlementRevocationDelayDays',
      'disableGraceDays',
      'reenableWithoutConfirmationDays',
    ] as const) {
      const bad = whole(key, key === 'preHireDays' ? 365 : 3650);
      if (bad) {
        setInvalid({ [key]: bad });
        return { bad: key };
      }
    }
    // Blank is `null`, which is what "never archive" is stored as.
    const archive = form.archiveAfterDays.trim();
    if (archive === '') {
      values.archiveAfterDays = null;
    } else {
      const value = Number(archive);
      if (!Number.isInteger(value) || value < 0 || value > 3650) {
        setInvalid({ archiveAfterDays: 'a whole number of days, or blank for never' });
        return { bad: 'archiveAfterDays' };
      }
      values.archiveAfterDays = value;
    }
    return { values };
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
            config: configFromForm(),
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

    const parsed = numbers();
    if ('bad' in parsed) {
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
            config: configFromForm(),
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
          config: configFromForm(),
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
        description={
          isNew
            ? 'Where Syntra creates and maintains accounts. Nothing is written until a run is reviewed.'
            : 'Provisioning settings for this target.'
        }
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
            hint="What this target system is called here."
            {...mark('name')}
            className="sm:col-span-2"
          />
          <Field
            label="URL"
            value={form.url}
            onChange={(v) => set('url', v)}
            hint="Writes require LDAPS or StartTLS. A Samba AD domain controller refuses even a bind in the clear."
            {...mark('url')}
          />
          <Select
            label="Transport"
            value={form.tlsMode}
            onChange={(v) => set('tlsMode', v as TlsMode)}
            {...mark('tlsMode')}
            hint={
              form.tlsMode === 'ldaps'
                ? 'TLS from the first byte. Needs an ldaps:// URL.'
                : 'The connection is upgraded to TLS before the bind, so the password never crosses in the clear.'
            }
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
            hint={
              form.rejectUnauthorized
                ? 'Leave this on unless the server presents a self-signed certificate you cannot install.'
                : 'Off: any certificate is accepted, including one presented by an impostor. The connection is encrypted but not authenticated.'
            }
          />
          <Field
            label="Bind DN"
            value={form.bindDn}
            onChange={(v) => set('bindDn', v)}
            hint="The account Provision writes as. It needs create, modify, move and membership rights — the test below reports which of them it could confirm."
            {...mark('bindDn')}
          />
          <Field
            label="Bind password"
            type="password"
            autoComplete="new-password"
            value={form.bindPassword}
            onChange={(v) => set('bindPassword', v)}
            hint={
              isNew
                ? 'Stored in the secrets vault, never on the target record.'
                : 'Leave blank to keep the stored password. It is never sent to this page.'
            }
            {...mark('bindPassword')}
          />
          <Field
            label="Base DN"
            value={form.baseDn}
            onChange={(v) => set('baseDn', v)}
            hint="The subtree accounts are read from and created under."
            {...mark('baseDn')}
          />
          <Field
            label="Entitlement search base"
            value={form.entitlementSearchBase}
            onChange={(v) => set('entitlementSearchBase', v)}
            hint="Where the grantable groups live. Anything outside it is invisible to Provision."
            {...mark('entitlementSearchBase')}
          />
          <Field
            label="Archive container"
            value={form.archiveContainer}
            onChange={(v) => set('archiveContainer', v)}
            hint="Where an archived account is moved to. Provision never deletes; archiving moves the object and strips its managed entitlements."
            {...mark('archiveContainer')}
            className="sm:col-span-2"
          />
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
                <span className="ml-2 text-muted">
                  How an account is named, where it is placed, and what it is
                  given.
                </span>
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
            hint="A cron expression, in UTC. Leave empty to run this target by hand only."
            {...mark('schedule')}
          />
          <Select
            label="Enforcement mode"
            value={form.enforcementMode}
            onChange={(v) => set('enforcementMode', v as EnforcementMode)}
            {...mark('enforcementMode')}
            // Ruling P2, on the target's own screen. Drift is reported under
            // both modes; what changes is whether Provision acts on it.
            hint={
              form.enforcementMode === 'additive'
                ? 'Provision revokes only what it granted. Anything else it finds is reported as drift and left alone.'
                : 'Provision also removes holdings it did not grant, within its remit. Everything it removes is still reported.'
            }
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
            hint="A disabled target is never run on its schedule. Run now still works, so a new target can be saved disabled and checked before it runs unattended."
          />
          <Check
            className="sm:col-span-2"
            checked={form.autoApply}
            onChange={(v) => set('autoApply', v)}
            label="Apply scheduled runs automatically"
            hint="The guard is not advisory: a blocked run never applies on a schedule, whatever this says."
          />
        </Panel>

        <Panel
          title="Deprovisioning ladder"
          description="Provision never deletes. A departure walks down these steps, in this order."
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="Pre-hire days"
            value={form.preHireDays}
            onChange={(v) => set('preHireDays', v)}
            inputMode="numeric"
            hint="How far ahead of a start date an account is created. Zero means on the day."
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
            hint="Blank means never. Archiving moves the object and strips its remaining managed entitlements, so it is opted into."
            {...mark('archiveAfterDays')}
          />
          <Field
            label="Re-enable without confirmation (days)"
            value={form.reenableWithoutConfirmationDays}
            onChange={(v) => set('reenableWithoutConfirmationDays', v)}
            inputMode="numeric"
            hint="Re-enabling an account disabled for longer than this asks for a tick."
            {...mark('reenableWithoutConfirmationDays')}
          />
          <Check
            className="sm:col-span-2"
            checked={form.renameEnabled}
            onChange={(v) => set('renameEnabled', v)}
            label="Rename an account when the person's name changes"
            hint="A rename breaks certificate subjects, profile paths, file ownership and mailbox aliases. Off by default, and always confirmable when on."
          />
        </Panel>

        <Panel
          title="Safety thresholds"
          description="A run proposing to change more than this share of a population is held for confirmation rather than applied."
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
          {/*
            No count and no list. `guard.ts` returns
            `requiresConfirmation: false` from three places covering five
            distinct classes — a threshold or a count that is not a number, no
            persons on an active contract at all, a collapsed person
            population, a target that returned no accounts, and any axis whose
            denominator is missing — so "two of the guard's refusals" was wrong
            about three of them, and any list written here goes on being wrong
            as the guard grows. The distinction is what is stable.
          */}
          <p className="text-muted sm:col-span-2">
            A run held only for being over one of these thresholds can be
            applied by somebody who has read the numbers. A run the guard
            refused because it could not compute the number at all cannot be
            confirmed away by anybody: there is no number for a tick to mean
            &ldquo;I have read&rdquo; about. Which of the two a run is, and
            why, is on the run&apos;s own screen.
          </p>
        </Panel>
      </div>
    </>
  );
}
