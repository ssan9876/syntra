import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
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
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import {
  MappingEditor,
  type AssignableFields,
  type MappingRule,
} from './MappingEditor.js';
import { TestReport, type TestResult } from './SourceTestReport.js';
import { StaleBadge, draftKey, draftStatus, summaryOf } from './DraftState.js';
import {
  BLANK,
  FLAVOURS,
  OWNED_CONFIG_KEYS,
  configFromForm,
  formFrom,
  type Flavour,
  type Form,
  type OwnedCounts,
  type SourceDetail,
  type TlsMode,
} from './source-form.js';

/** On-screen names for the fields the API reports problems against. */
const LABELS: Record<string, string> = {
  name: 'Name',
  url: 'Server URL',
  tlsMode: 'Transport',
  bindDn: 'Bind DN',
  bindPassword: 'Bind password',
  userSearchBase: 'User search base',
  userFilter: 'User filter',
  groupSearchBase: 'Group search base',
  groupFilter: 'Group filter',
  orgUnitSearchBase: 'Org unit search base',
  orgUnitFilter: 'Org unit filter',
  anchorAttribute: 'Anchor attribute',
  schedule: 'Schedule',
  deactivationThresholdPercent: 'Deactivation threshold',
};

const CONNECTION_FIELDS = ['name', 'url', 'tlsMode', 'bindDn', 'bindPassword'];
const SCOPE_FIELDS = [
  'userSearchBase', 'userFilter', 'groupSearchBase', 'groupFilter',
  'orgUnitSearchBase', 'orgUnitFilter', 'anchorAttribute',
];
const SCHEDULE_FIELDS = ['schedule', 'deactivationThresholdPercent'];

/** What a connection test sends, and so what its report describes. */
const testedDraft = (form: Form, extraConfig: Record<string, unknown>) =>
  draftKey({ config: configFromForm(form, extraConfig), secret: form.bindPassword });

export function SourceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = id === undefined;

  const { data, error, loading, reload } = useApiResource<SourceDetail>(
    isNew ? null : `/api/admin/sources/${id}`,
  );
  // Its own resource, and therefore its own reload: the source's `reload()`
  // re-fetches the source and nothing else.
  const { data: mappingData, reload: reloadMappings } = useApiResource<{
    rules: MappingRule[];
  }>(isNew ? null : `/api/admin/sources/${id}/mappings`);
  const { data: defaults } = useApiResource<{
    flavours: Record<Flavour, MappingRule[]>;
    assignableFields: AssignableFields;
  }>('/api/admin/sources/mapping-defaults');

  const toast = useToast();
  const [form, setForm] = useState<Form>(BLANK);
  // The form as it last matched the server; "Unsaved changes" compares to it.
  const [baseline, setBaseline] = useState<Form>(BLANK);
  const [extraConfig, setExtraConfig] = useState<Record<string, unknown>>({});
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [rulesTouched, setRulesTouched] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'run' | 'delete'>(
    null,
  );
  const [result, setResult] = useState<TestResult | null>(null);
  // The draft the report was produced from. The counts and the schema are
  // what one URL, bind and set of search bases returned; once any of those
  // differ on screen the report describes somewhere else, and says so.
  const [resultFor, setResultFor] = useState<string | null>(null);
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

  /**
   * The message a create left behind on its way here.
   *
   * Read in an effect rather than as initial state: creating a source
   * navigates from /sources/new to /sources/:id, and React keeps the same
   * component mounted across that move because it is the same element type.
   * A `useState` initializer therefore never runs again, and the message —
   * including the one that says the mappings were refused — was silently
   * dropped exactly when it mattered.
   */
  const routedNotice = (location.state as { notice?: string } | null)?.notice;
  useEffect(() => {
    setNotice(routedNotice ?? null);
  }, [routedNotice]);

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

  /**
   * Seeds the table from a *fetch*, once per fetch.
   *
   * Keyed on the identity of the fetched value rather than on a "has the user
   * touched this" flag. The flag version reverted a saved edit on screen: the
   * save set the flag back to false, which re-ran this effect against the
   * mappings loaded when the page opened, and the table redrew the old
   * attribute names under a "Saved." message. The data was right and the
   * screen was wrong, which is the one failure this product cannot afford.
   */
  const seededFrom = useRef<{ rules: MappingRule[] } | null>(null);
  useEffect(() => {
    if (mappingData && seededFrom.current !== mappingData) {
      seededFrom.current = mappingData;
      setRules(mappingData.rules);
      setRulesTouched(false);
    }
  }, [mappingData]);

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
    const sentFor = testedDraft(form, extraConfig);
    try {
      const answer = await api<TestResult>('/api/admin/sources/test', {
        method: 'POST',
        body: JSON.stringify({
          config: configFromForm(form, extraConfig),
          // Sent only when it was typed. Otherwise the saved source is
          // named and the server reads its own vault entry: the browser is
          // never handed the stored password to send back.
          ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          ...(isNew ? {} : { sourceId: id }),
        }),
      });
      // Bound to what was sent: an edit made while the test was in flight
      // leaves the answer arriving already out of date, and labelled so.
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
            config: configFromForm(form, extraConfig),
            bindPassword: form.bindPassword,
            ...(form.schedule.trim() ? { schedule: form.schedule.trim() } : {}),
            autoApply: form.autoApply,
            writebackEnabled: form.writebackEnabled,
            // Sent as false whenever the master switch is off, so the stored
            // row can never say "may change passwords" while write-back is
            // disabled. A pair that disagrees is one somebody eventually
            // trusts the wrong half of.
            writebackPassword: form.writebackEnabled && form.writebackPassword,
            writebackDisable: form.writebackEnabled && form.writebackDisable,
            writebackDelete: form.writebackEnabled && form.writebackDelete,
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
          config: configFromForm(form, extraConfig),
          // Absent means unchanged. This is the only way to edit a source
          // without the stored credential making a round trip to a browser.
          ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
          schedule: form.schedule.trim() ? form.schedule.trim() : null,
          autoApply: form.autoApply,
          writebackEnabled: form.writebackEnabled,
          // Sent as false whenever the master switch is off, so a stored row
          // can never say "may change passwords" while write-back is
          // disabled. A pair that disagrees is one somebody eventually trusts
          // the wrong half of.
          writebackPassword: form.writebackEnabled && form.writebackPassword,
          writebackDisable: form.writebackEnabled && form.writebackDisable,
          writebackDelete: form.writebackEnabled && form.writebackDelete,
          enabled: form.enabled,
          deactivationThresholdPercent: threshold,
        }),
      });
      // The response is `mappingsFor` read back after the write, so it is
      // what was stored rather than what was sent. Shown directly, and the
      // resource behind it reloaded, so nothing on screen is left describing
      // the state before the save.
      const stored = await api<{ rules: MappingRule[] }>(
        `/api/admin/sources/${id}/mappings`,
        { method: 'PUT', body: JSON.stringify({ rules }) },
      );

      const saved = { ...form, bindPassword: '' };
      setForm(saved);
      setBaseline(saved);
      setRules(stored.rules);
      setRulesTouched(false);
      toast({ tone: 'success', title: 'Source saved' });
      reload();
      reloadMappings();
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

  async function onDelete(owned: OwnedCounts) {
    setBusy('delete');
    setProblem(null);
    try {
      // The numbers that were on screen when the box was ticked go with the
      // request, and the server refuses if they have moved since. Confirmation
      // is worth only as much as the figures it was given, and those are read
      // when the page opens — a run in between could multiply them.
      const acknowledged = new URLSearchParams({
        confirm: 'true',
        ackUsers: String(owned.users),
        ackGroups: String(owned.groups),
        ackOrgUnits: String(owned.orgUnits),
      });
      await api(`/api/admin/sources/${id}?${acknowledged}`, {
        method: 'DELETE',
      });
      navigate('/admin/sources');
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'source-counts-changed') {
        // Put the question again with the truth in it, rather than reporting a
        // failure the administrator cannot act on.
        setConfirmDelete(false);
        setProblem(cause.problem.detail ?? 'The numbers changed.');
        reload();
      } else {
        fail(cause, 'The source could not be deleted.');
      }
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

  const owned = data?.owned ?? { users: 0, groups: 0, orgUnits: 0 };
  const ownsSomething =
    owned.users > 0 || owned.groups > 0 || owned.orgUnits > 0;

  const testStale = result !== null && resultFor !== testedDraft(form, extraConfig);
  const dirty = draftKey(form) !== draftKey(baseline) || rulesTouched;

  /** How many of a stage's fields were refused, as that stage's state. */
  const refusedIn = (fields: string[]) => {
    const count = fields.filter((field) => invalid[field]).length;
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
      <PageHeader
        title={isNew ? 'New directory source' : form.name || 'Directory source'}
        actions={
          // Running is not part of editing, so it stays at the top of the
          // record rather than in the form's own bar.
          !isNew && (
            <Button onClick={onRun} loading={busy === 'run'} disabled={!!busy}>
              Run now
            </Button>
          )
        }
      />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}

        {/*
          One form in the order a source is set up: reach the directory, say
          what to read from it, say what each attribute becomes, and only then
          when to run it unattended. Write-back is last because it is the part
          most sources never turn on, and the part that changes the directory
          rather than reading it. Not a Panel, whose `overflow-hidden` would
          stop the completion bar from sticking.
        */}
        <form
          onSubmit={(event) => void onSave(event)}
          noValidate
          aria-label={isNew ? 'New directory source' : 'Directory source settings'}
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
            <Field
              label="Server URL"
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
              warning={
                form.tlsMode === 'plain'
                  ? 'The bind password crosses the network unencrypted.'
                  : undefined
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
              // In the box rather than under it. On a saved source an empty
              // password field is genuinely ambiguous — it could mean "clear
              // it" — and the answer is only wanted by somebody looking at the
              // box, which is exactly when a placeholder is read.
              placeholder={isNew ? undefined : 'Leave blank to keep the stored password'}
              {...mark('bindPassword')}
            />
          </FormSection>

          <FormSection title="What to read" status={refusedIn(SCOPE_FIELDS)}>
            <Field
              label="User search base"
              name="userSearchBase"
              value={form.userSearchBase}
              onChange={(v) => set('userSearchBase', v)}
              {...mark('userSearchBase')}
            />
            <Field
              label="User filter"
              name="userFilter"
              value={form.userFilter}
              onChange={(v) => set('userFilter', v)}
              {...mark('userFilter')}
            />
            <Field
              label="Group search base"
              name="groupSearchBase"
              value={form.groupSearchBase}
              onChange={(v) => set('groupSearchBase', v)}
              {...mark('groupSearchBase')}
            />
            <Field
              label="Group filter"
              name="groupFilter"
              value={form.groupFilter}
              onChange={(v) => set('groupFilter', v)}
              {...mark('groupFilter')}
            />
            <Field
              label="Org unit search base"
              name="orgUnitSearchBase"
              value={form.orgUnitSearchBase}
              onChange={(v) => set('orgUnitSearchBase', v)}
              {...mark('orgUnitSearchBase')}
            />
            <Field
              label="Org unit filter"
              name="orgUnitFilter"
              value={form.orgUnitFilter}
              onChange={(v) => set('orgUnitFilter', v)}
              {...mark('orgUnitFilter')}
            />
            <Field
              label="Anchor attribute"
              name="anchorAttribute"
              value={form.anchorAttribute}
              onChange={(v) => set('anchorAttribute', v)}
              {...mark('anchorAttribute')}
              className="sm:col-span-2"
            />
            {/* After the search bases, because the counts it reports are what
                those bases found — and the object classes and attributes are
                what the mapping table below needs in front of it. */}
            {result && <TestReport result={result} stale={testStale} />}
          </FormSection>

          <FormSection
            title="Attribute mappings"
            status={rulesTouched ? <StateBadge state="attention">Changed</StateBadge> : null}
          >
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
          </FormSection>

          <FormSection title="Schedule and safety" status={refusedIn(SCHEDULE_FIELDS)}>
            <Field
              label="Schedule"
              name="schedule"
              value={form.schedule}
              onChange={(v) => set('schedule', v)}
              placeholder="0 3 * * *"
              {...mark('schedule')}
            />
            <Field
              label="Deactivation threshold"
              name="deactivationThresholdPercent"
              value={form.deactivationThresholdPercent}
              onChange={(v) => set('deactivationThresholdPercent', v)}
              inputMode="numeric"
              {...mark('deactivationThresholdPercent')}
            />
            <Check
              className="sm:col-span-2"
              checked={form.enabled}
              onChange={(v) => set('enabled', v)}
              label="Enabled"
              // Precisely what it does. A disabled source is skipped by the
              // scheduler; Run now still works, because running one by hand is
              // how you check a source before letting it run unattended, and
              // saying otherwise would be copy that the product contradicts.
            />
            <Check
              className="sm:col-span-2"
              checked={form.autoApply}
              onChange={(v) => set('autoApply', v)}
              label="Apply scheduled runs automatically"
            />
          </FormSection>

          <FormSection
            title="Write-back"
            status={
              form.writebackEnabled ? (
                <StateBadge state="attention">Writes to this directory</StateBadge>
              ) : (
                <StateBadge state="inactive">Read only</StateBadge>
              )
            }
          >
            <Check
              className="sm:col-span-2"
              checked={form.writebackEnabled}
              onChange={(v) => set('writebackEnabled', v)}
              label="Allow Syntra to write to this directory"
              // Says what the bind needs, because that is the part that
              // actually stops working. An administrator who turns this on
              // without delegating the rights gets a refusal at the moment
              // somebody leaves, which is the worst possible time to find out.
            />
            <Check
              className="sm:col-span-2"
              checked={form.writebackEnabled && form.writebackDisable}
              disabled={!form.writebackEnabled}
              onChange={(v) => set('writebackDisable', v)}
              label="Deactivating a user disables their account here"
            />
            <Check
              className="sm:col-span-2"
              checked={form.writebackEnabled && form.writebackPassword}
              disabled={!form.writebackEnabled}
              onChange={(v) => set('writebackPassword', v)}
              label="Self-service password change writes through to this directory"
              // The consequence people do not expect: the directory's policy
              // starts applying, including the minimum age, and it will refuse
              // things Syntra's own policy would have accepted. Shown while it
              // is ticked, which is exactly while it applies.
              warning={
                form.writebackEnabled && form.writebackPassword
                  ? 'The directory’s own password policy then applies, and can refuse a change Syntra would accept.'
                  : undefined
              }
            />
            <Check
              className="sm:col-span-2"
              checked={form.writebackEnabled && form.writebackDelete}
              disabled={!form.writebackEnabled}
              onChange={(v) => set('writebackDelete', v)}
              label="Deleting a user or org unit removes it from this directory"
              // The one in this stage that writing the opposite value back
              // does not undo. Everything else here is a state: a disabled
              // account is enabled again, a changed password is changed again.
              // This is not, so the warning says so while it is ticked.
              warning={
                form.writebackEnabled && form.writebackDelete
                  ? 'A deletion here cannot be undone from Syntra.'
                  : undefined
              }
            />
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
              Save
            </Button>
          </FormActions>
        </form>

        {!isNew && (
          <Panel title="Delete this source">
            <div className="space-y-3 p-4">
              {/* The counts before the button, in words. Deleting a source
                  revokes real access, and an administrator should read the
                  size of that before deciding, not discover it from a 409. */}
              {ownsSomething ? (
                <Alert
                  tone="warning"
                  title={
                    `This source owns ${owned.users} ${owned.users === 1 ? 'user' : 'users'}, ` +
                    `${owned.groups} ${owned.groups === 1 ? 'group' : 'groups'} and ` +
                    `${owned.orgUnits} ${owned.orgUnits === 1 ? 'organizational unit' : 'organizational units'}`
                  }
                >
                  <ul className="list-disc space-y-0.5 pl-5">
                    <li>Deactivates every one of those users and groups</li>
                    <li>Detaches all of them from any source</li>
                    <li>Deletes nothing from the directory</li>
                  </ul>
                </Alert>
              ) : (
                <p className="text-ink">
                  Owns no users, groups or organizational units.
                </p>
              )}

              {ownsSomething && (
                <Check
                  checked={confirmDelete}
                  onChange={setConfirmDelete}
                  // Every number the paragraph above states, so the tick
                  // acknowledges all of what happens rather than the two
                  // thirds of it that deactivates.
                  label={
                    `I understand that ${owned.users} ` +
                    `${owned.users === 1 ? 'user' : 'users'} and ` +
                    `${owned.groups} ${owned.groups === 1 ? 'group' : 'groups'} ` +
                    `will be deactivated, and ${owned.orgUnits} ` +
                    `${owned.orgUnits === 1 ? 'unit' : 'units'} detached.`
                  }
                />
              )}

              <Button
                variant="danger"
                onClick={() => onDelete(owned)}
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
