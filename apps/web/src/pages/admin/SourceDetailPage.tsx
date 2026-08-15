import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import {
  MappingEditor,
  type AssignableFields,
  type MappingRule,
} from './MappingEditor.js';

type TlsMode = 'plain' | 'starttls' | 'ldaps';

interface OwnedCounts {
  users: number;
  groups: number;
  orgUnits: number;
}

interface SourceDetail {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  schedule: string | null;
  autoApply: boolean;
  enabled: boolean;
  deactivationThresholdPercent: number;
  lastRunAt: string | null;
  owned: OwnedCounts;
}

interface TestResult {
  ok: boolean;
  message: string;
  sampleCounts?: Record<'user' | 'group' | 'orgUnit', number>;
  schema: { objectClasses: string[]; attributes: string[] } | null;
}

interface Form {
  name: string;
  url: string;
  tlsMode: TlsMode;
  rejectUnauthorized: boolean;
  bindDn: string;
  bindPassword: string;
  userSearchBase: string;
  groupSearchBase: string;
  orgUnitSearchBase: string;
  userFilter: string;
  groupFilter: string;
  orgUnitFilter: string;
  anchorAttribute: string;
  schedule: string;
  enabled: boolean;
  autoApply: boolean;
  deactivationThresholdPercent: string;
}

const BLANK: Form = {
  name: '',
  url: 'ldap://',
  tlsMode: 'starttls',
  rejectUnauthorized: true,
  bindDn: '',
  bindPassword: '',
  userSearchBase: '',
  groupSearchBase: '',
  orgUnitSearchBase: '',
  userFilter: '(objectClass=person)',
  groupFilter: '(objectClass=group)',
  orgUnitFilter: '(objectClass=organizationalUnit)',
  anchorAttribute: 'objectGUID',
  schedule: '',
  enabled: true,
  autoApply: false,
  deactivationThresholdPercent: '10',
};

/**
 * What each directory flavour usually wants, so the common case needs no
 * typing. The mappings come from the server (one definition, shared with the
 * validator); the connection settings are here because they are the console's
 * own suggestion and nothing on the server defaults per flavour.
 *
 * The user filter is the reason this exists. The stored default,
 * `(objectClass=person)`, is right for OpenLDAP and wrong for Active
 * Directory, where `computer` derives from `person` and that filter matches
 * every machine account in the domain — one Syntra user per workstation. The
 * conventional Active Directory filter is offered instead, without changing
 * the server-side default that OpenLDAP relies on.
 */
const FLAVOURS = {
  activeDirectory: {
    label: 'Active Directory',
    anchorAttribute: 'objectGUID',
    userFilter: '(&(objectCategory=person)(objectClass=user))',
    groupFilter: '(objectClass=group)',
  },
  openLdap: {
    label: 'OpenLDAP',
    anchorAttribute: 'entryUUID',
    userFilter: '(objectClass=inetOrgPerson)',
    groupFilter: '(objectClass=groupOfNames)',
  },
} as const;

type Flavour = keyof typeof FLAVOURS;

/** Config keys the form owns. Anything else on a saved source is carried through. */
const OWNED_CONFIG_KEYS = [
  'url',
  'tlsMode',
  'rejectUnauthorized',
  'bindDn',
  'userSearchBase',
  'groupSearchBase',
  'orgUnitSearchBase',
  'userFilter',
  'groupFilter',
  'orgUnitFilter',
  'anchorAttribute',
];

const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

function formFrom(source: SourceDetail): Form {
  const config = source.config ?? {};
  const url = text(config.url, BLANK.url);
  return {
    name: source.name,
    url,
    // The same fallback the connector applies to a source saved before the
    // mode existed, so the form shows the transport actually in use rather
    // than a default that would change it on the next save.
    tlsMode:
      (config.tlsMode as TlsMode | undefined) ??
      (url.trim().toLowerCase().startsWith('ldaps:') ? 'ldaps' : 'plain'),
    rejectUnauthorized: config.rejectUnauthorized !== false,
    bindDn: text(config.bindDn),
    // Never populated. The vault holds it, the API never returns it, and an
    // empty box on an edit form means "leave it alone".
    bindPassword: '',
    userSearchBase: text(config.userSearchBase),
    groupSearchBase: text(config.groupSearchBase),
    orgUnitSearchBase: text(config.orgUnitSearchBase),
    userFilter: text(config.userFilter, BLANK.userFilter),
    groupFilter: text(config.groupFilter, BLANK.groupFilter),
    orgUnitFilter: text(config.orgUnitFilter, BLANK.orgUnitFilter),
    anchorAttribute: text(config.anchorAttribute, BLANK.anchorAttribute),
    schedule: source.schedule ?? '',
    enabled: source.enabled,
    autoApply: source.autoApply,
    deactivationThresholdPercent: String(source.deactivationThresholdPercent),
  };
}

export function SourceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = id === undefined;

  const { data, error, loading, reload } = useApiResource<SourceDetail>(
    isNew ? null : `/api/admin/sources/${id}`,
  );
  const { data: mappingData } = useApiResource<{ rules: MappingRule[] }>(
    isNew ? null : `/api/admin/sources/${id}/mappings`,
  );
  const { data: defaults } = useApiResource<{
    flavours: Record<Flavour, MappingRule[]>;
    assignableFields: AssignableFields;
  }>('/api/admin/sources/mapping-defaults');

  const [form, setForm] = useState<Form>(BLANK);
  const [extraConfig, setExtraConfig] = useState<Record<string, unknown>>({});
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [rulesTouched, setRulesTouched] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  );
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'run' | 'delete'>(
    null,
  );
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /**
   * The message for a field, spread in rather than passed as a possibly
   * undefined prop: the workspace compiles with `exactOptionalPropertyTypes`,
   * where an absent optional prop and one explicitly set to `undefined` are
   * different things.
   */
  const mark = (field: string): { error?: string } =>
    invalid[field] ? { error: invalid[field] } : {};

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

  useEffect(() => {
    if (mappingData && !rulesTouched) setRules(mappingData.rules);
  }, [mappingData, rulesTouched]);

  // A new source starts from the OpenLDAP defaults rather than from nothing,
  // which is what "the common case needs no typing" means in practice. The
  // flavour buttons swap it.
  useEffect(() => {
    if (isNew && defaults && !rulesTouched) setRules(defaults.flavours.openLdap);
  }, [isNew, defaults, rulesTouched]);

  function seed(flavour: Flavour) {
    setRulesTouched(true);
    if (defaults) setRules(defaults.flavours[flavour]);
    setForm((current) => ({
      ...current,
      anchorAttribute: FLAVOURS[flavour].anchorAttribute,
      userFilter: FLAVOURS[flavour].userFilter,
      groupFilter: FLAVOURS[flavour].groupFilter,
    }));
  }

  function configFromForm(): Record<string, unknown> {
    return {
      ...extraConfig,
      url: form.url.trim(),
      tlsMode: form.tlsMode,
      rejectUnauthorized: form.rejectUnauthorized,
      bindDn: form.bindDn.trim(),
      userSearchBase: form.userSearchBase.trim(),
      groupSearchBase: form.groupSearchBase.trim(),
      ...(form.orgUnitSearchBase.trim()
        ? { orgUnitSearchBase: form.orgUnitSearchBase.trim() }
        : {}),
      userFilter: form.userFilter.trim(),
      groupFilter: form.groupFilter.trim(),
      orgUnitFilter: form.orgUnitFilter.trim(),
      anchorAttribute: form.anchorAttribute.trim(),
    };
  }

  function fail(cause: unknown, fallback: string) {
    const marked = fieldErrors(cause);
    setInvalid(marked);
    if (cause instanceof ApiError && Object.keys(marked).length === 0) {
      setProblem(cause.problem.detail ?? cause.problem.title ?? fallback);
    } else if (Object.keys(marked).length === 0) {
      setProblem(fallback);
    } else {
      setProblem(null);
    }
  }

  async function onTest() {
    setBusy('test');
    setInvalid({});
    setProblem(null);
    setResult(null);
    try {
      setResult(
        await api<TestResult>('/api/admin/sources/test', {
          method: 'POST',
          body: JSON.stringify({
            config: configFromForm(),
            // Sent only when it was typed. Otherwise the saved source is
            // named and the server reads its own vault entry: the browser is
            // never handed the stored password to send back.
            ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
            ...(isNew ? {} : { sourceId: id }),
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

    const threshold = Number(form.deactivationThresholdPercent);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
      setInvalid({
        deactivationThresholdPercent: 'a whole number between 0 and 100',
      });
      setBusy(null);
      return;
    }

    try {
      if (isNew) {
        const created = await api<{ id: string }>('/api/admin/sources', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            config: configFromForm(),
            bindPassword: form.bindPassword,
            ...(form.schedule.trim() ? { schedule: form.schedule.trim() } : {}),
            autoApply: form.autoApply,
            enabled: form.enabled,
            deactivationThresholdPercent: threshold,
          }),
        });

        // The mappings belong to the source and cannot be written before it
        // exists. If they are refused the source is already saved, so the
        // editor moves to it and says what is still missing rather than
        // pretending nothing happened.
        try {
          await api(`/api/admin/sources/${created.id}/mappings`, {
            method: 'PUT',
            body: JSON.stringify({ rules }),
          });
          navigate(`/admin/sources/${created.id}`, {
            state: { notice: 'The source and its attribute mappings were saved.' },
          });
        } catch (cause) {
          navigate(`/admin/sources/${created.id}`, {
            state: {
              notice:
                'The source was saved but its attribute mappings were refused: ' +
                (cause instanceof ApiError
                  ? (cause.problem.detail ?? cause.problem.title)
                  : 'unknown reason') +
                '. Nothing will sync until they are set.',
            },
          });
        }
        return;
      }

      await api(`/api/admin/sources/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name.trim(),
          config: configFromForm(),
          // Absent means unchanged. This is the only way to edit a source
          // without the stored credential making a round trip to a browser.
          ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          schedule: form.schedule.trim() ? form.schedule.trim() : null,
          autoApply: form.autoApply,
          enabled: form.enabled,
          deactivationThresholdPercent: threshold,
        }),
      });
      await api(`/api/admin/sources/${id}/mappings`, {
        method: 'PUT',
        body: JSON.stringify({ rules }),
      });

      setForm((current) => ({ ...current, bindPassword: '' }));
      setRulesTouched(false);
      setNotice('Saved.');
      reload();
    } catch (cause) {
      fail(cause, 'The source could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function onRun() {
    setBusy('run');
    setProblem(null);
    try {
      const run = await api<{ id: string }>(`/api/admin/sources/${id}/run`, {
        method: 'POST',
      });
      navigate(`/admin/sync-runs/${run.id}`);
    } catch (cause) {
      fail(cause, 'The run could not be started.');
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    setBusy('delete');
    setProblem(null);
    try {
      await api(`/api/admin/sources/${id}?confirm=true`, { method: 'DELETE' });
      navigate('/admin/sources');
    } catch (cause) {
      fail(cause, 'The source could not be deleted.');
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

  const owned = data?.owned ?? { users: 0, groups: 0, orgUnits: 0 };
  const ownsSomething =
    owned.users > 0 || owned.groups > 0 || owned.orgUnits > 0;

  return (
    <>
      <PageHeader
        title={isNew ? 'New directory source' : form.name || 'Directory source'}
        description={
          isNew
            ? 'Where users, groups and org units are read from. Nothing is written to the directory, ever.'
            : 'Every mapped field below is owned by this source and rewritten on each run.'
        }
        actions={
          <>
            <Button onClick={onTest} loading={busy === 'test'} disabled={!!busy}>
              Test connection
            </Button>
            {!isNew && (
              <Button onClick={onRun} loading={busy === 'run'} disabled={!!busy}>
                Run now
              </Button>
            )}
            <Button
              variant="primary"
              onClick={onSave}
              loading={busy === 'save'}
              disabled={!!busy}
            >
              Save
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

        <Panel title="Connection" bodyClassName="grid gap-4 p-4 sm:grid-cols-2">
          <Field
            label="Name"
            value={form.name}
            onChange={(v) => set('name', v)}
            hint="What this directory is called here."
            {...mark('name')}
            className="sm:col-span-2"
          />
          <Field
            label="Server URL"
            value={form.url}
            onChange={(v) => set('url', v)}
            hint="ldap://host:389, or ldaps://host:636 for implicit TLS."
            {...mark('url')}
          />
          <Select
            label="Transport"
            value={form.tlsMode}
            onChange={(v) => set('tlsMode', v as TlsMode)}
            {...mark('tlsMode')}
            hint={
              form.tlsMode === 'plain'
                ? 'The bind password crosses the network in the clear.'
                : form.tlsMode === 'starttls'
                  ? 'The connection is upgraded to TLS before the bind, so the password never crosses in the clear.'
                  : 'TLS from the first byte. Needs an ldaps:// URL.'
            }
            options={[
              { value: 'plain', label: 'Not encrypted' },
              { value: 'starttls', label: 'StartTLS' },
              { value: 'ldaps', label: 'LDAPS' },
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
            hint="The account Syntra reads the directory as. Read access is enough."
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
                ? 'Stored in the secrets vault, never on the source record.'
                : 'Leave blank to keep the stored password. It is never sent to this page.'
            }
            {...mark('bindPassword')}
          />
        </Panel>

        <Panel
          title="What to read"
          description="Each search base is read in pages. Anything outside them is invisible to Syntra."
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="User search base"
            value={form.userSearchBase}
            onChange={(v) => set('userSearchBase', v)}
            {...mark('userSearchBase')}
          />
          <Field
            label="User filter"
            value={form.userFilter}
            onChange={(v) => set('userFilter', v)}
            {...mark('userFilter')}
          />
          <Field
            label="Group search base"
            value={form.groupSearchBase}
            onChange={(v) => set('groupSearchBase', v)}
            {...mark('groupSearchBase')}
          />
          <Field
            label="Group filter"
            value={form.groupFilter}
            onChange={(v) => set('groupFilter', v)}
            {...mark('groupFilter')}
          />
          <Field
            label="Org unit search base"
            value={form.orgUnitSearchBase}
            onChange={(v) => set('orgUnitSearchBase', v)}
            hint="Optional. Left empty, organizational units are not read."
            {...mark('orgUnitSearchBase')}
          />
          <Field
            label="Org unit filter"
            value={form.orgUnitFilter}
            onChange={(v) => set('orgUnitFilter', v)}
            {...mark('orgUnitFilter')}
          />
          <Field
            label="Anchor attribute"
            value={form.anchorAttribute}
            onChange={(v) => set('anchorAttribute', v)}
            hint="The immutable id: objectGUID on Active Directory, entryUUID on OpenLDAP. Never the DN — a person who moves department changes theirs."
            {...mark('anchorAttribute')}
            className="sm:col-span-2"
          />
        </Panel>

        <MappingEditor
          rules={rules}
          onChange={(next) => {
            setRulesTouched(true);
            setRules(next);
          }}
          assignableFields={defaults?.assignableFields ?? null}
          onSeed={seed}
          disabled={busy === 'save'}
        />

        <Panel
          title="Schedule and safety"
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="Schedule"
            value={form.schedule}
            onChange={(v) => set('schedule', v)}
            placeholder="0 3 * * *"
            hint="A cron expression, in UTC. Leave empty to run this source by hand only."
            {...mark('schedule')}
          />
          <Field
            label="Deactivation threshold"
            value={form.deactivationThresholdPercent}
            onChange={(v) => set('deactivationThresholdPercent', v)}
            inputMode="numeric"
            hint="A run proposing to deactivate more than this share of this source's active users is held for confirmation."
            {...mark('deactivationThresholdPercent')}
          />
          <Check
            className="sm:col-span-2"
            checked={form.enabled}
            onChange={(v) => set('enabled', v)}
            label="Enabled"
            hint="A disabled source is never read, on a schedule or otherwise. Save a new source disabled if you want to check the mappings before it runs."
          />
          <Check
            className="sm:col-span-2"
            checked={form.autoApply}
            onChange={(v) => set('autoApply', v)}
            label="Apply scheduled runs automatically"
            hint="A scheduled run applies its own diff without review. A run the guard held back is never applied this way — nobody is watching an unattended schedule."
          />
        </Panel>

        {!isNew && (
          <Panel title="Delete this source">
            <div className="space-y-3 p-4">
              {/* The counts before the button, in words. Deleting a source
                  revokes real access, and an administrator should read the
                  size of that before deciding, not discover it from a 409. */}
              <p className="text-ink">
                {ownsSomething ? (
                  <>
                    This source owns{' '}
                    <strong className="font-semibold">
                      {owned.users} {owned.users === 1 ? 'user' : 'users'}
                    </strong>
                    ,{' '}
                    <strong className="font-semibold">
                      {owned.groups} {owned.groups === 1 ? 'group' : 'groups'}
                    </strong>{' '}
                    and{' '}
                    <strong className="font-semibold">
                      {owned.orgUnits}{' '}
                      {owned.orgUnits === 1
                        ? 'organizational unit'
                        : 'organizational units'}
                    </strong>
                    . Deleting it deactivates every one of those users and
                    groups — they lose access — and detaches all of them from
                    any source. Nothing is deleted from the directory and
                    nothing is deleted here: the accounts stay listed, labelled
                    inactive, and can be reactivated by hand.
                  </>
                ) : (
                  <>
                    This source owns no users, groups or organizational units,
                    so deleting it deactivates nothing. Its runs and attribute
                    mappings go with it.
                  </>
                )}
              </p>

              {ownsSomething && (
                <Check
                  checked={confirmDelete}
                  onChange={setConfirmDelete}
                  label={`I understand ${owned.users + owned.groups} accounts and groups will be deactivated.`}
                />
              )}

              <Button
                variant="danger"
                onClick={onDelete}
                loading={busy === 'delete'}
                disabled={!!busy || (ownsSomething && !confirmDelete)}
              >
                Delete source
              </Button>
            </div>
          </Panel>
        )}

        <Link
          to="/admin/sources"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to directory sources
        </Link>
      </div>
    </>
  );
}

/**
 * What the directory answered, before anything is saved.
 *
 * The counts say the connection works and the search bases are pointed
 * somewhere real; the object classes and attributes are what the spec's first
 * success criterion asks for, and are what an administrator needs in front of
 * them while filling in the mapping table below.
 */
function TestReport({ result }: { result: TestResult }) {
  if (!result.ok) {
    return (
      <Alert tone="danger" title="Could not connect">
        {result.message}
      </Alert>
    );
  }

  const counts = result.sampleCounts;
  return (
    <Panel title="Connection test">
      <div className="space-y-4 p-4">
        <p className="flex flex-wrap items-center gap-2">
          <Status tone="active">Connected</Status>
          <span className="text-muted">{result.message}</span>
        </p>

        {counts && (
          <p className="text-ink">
            Found{' '}
            <strong className="font-semibold tabular-nums">{counts.user}</strong>{' '}
            users,{' '}
            <strong className="font-semibold tabular-nums">
              {counts.group}
            </strong>{' '}
            groups and{' '}
            <strong className="font-semibold tabular-nums">
              {counts.orgUnit}
            </strong>{' '}
            organizational units in the configured search bases.
          </p>
        )}

        {result.schema && (
          <>
            <Discovered
              title="Object classes it returned"
              values={result.schema.objectClasses}
            />
            <Discovered
              title="Attributes it returned"
              values={result.schema.attributes}
            />
          </>
        )}
      </div>
    </Panel>
  );
}

function Discovered({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div>
      <h3 className="font-medium text-ink">{title}</h3>
      <p className="mt-1 text-muted">{values.join(', ')}</p>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  className = '',
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: { value: string; label: string }[];
  hint?: string;
  error?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={[
          'h-9 w-full rounded-control border bg-bg px-3 text-ink',
          'transition-colors duration-150',
          error
            ? 'border-danger'
            : 'border-border-subtle hover:border-border-strong',
        ].join(' ')}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
  className = '',
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span>
          <span className="font-medium text-ink">{label}</span>
          {hint && <span className="mt-0.5 block text-sm text-muted">{hint}</span>}
        </span>
      </label>
    </div>
  );
}
