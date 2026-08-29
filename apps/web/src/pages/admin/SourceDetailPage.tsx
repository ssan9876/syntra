import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  Field,
  Panel,
  Select,
  SkeletonRows,
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

  const [form, setForm] = useState<Form>(BLANK);
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
    setForm(formFrom(data));
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
    try {
      setResult(
        await api<TestResult>('/api/admin/sources/test', {
          method: 'POST',
          body: JSON.stringify({
            config: configFromForm(form, extraConfig),
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

      setForm((current) => ({ ...current, bindPassword: '' }));
      setRules(stored.rules);
      setRulesTouched(false);
      setNotice('Saved.');
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
        setProblem(
          `${cause.problem.detail ?? 'The numbers changed.'} Read them again below before deleting.`,
        );
        reload();
      } else {
        fail(cause, 'The source could not be deleted.');
      }
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
            {...mark('name')}
            className="sm:col-span-2"
          />
          <Field
            label="Server URL"
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
            // In the box rather than under it. On a saved source an empty
            // password field is genuinely ambiguous — it could mean "clear
            // it" — and the answer is only wanted by somebody looking at the
            // box, which is exactly when a placeholder is read.
            placeholder={isNew ? undefined : 'Leave blank to keep the stored password'}
            {...mark('bindPassword')}
          />
        </Panel>

        <Panel
          title="What to read"
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
            {...mark('schedule')}
          />
          <Field
            label="Deactivation threshold"
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
        </Panel>

        <Panel
          title="Write-back"
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2">
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
              // things Syntra's own policy would have accepted.
            />
            <Check
              className="sm:col-span-2"
              checked={form.writebackEnabled && form.writebackDelete}
              disabled={!form.writebackEnabled}
              onChange={(v) => set('writebackDelete', v)}
              label="Deleting a user or org unit removes it from this directory"
              // The one on this panel that writing the opposite value back
              // does not undo. Everything else here is a state: a disabled
              // account is enabled again, a changed password is changed again.
              // This is not, so the hint leads with that rather than with what
              // the feature does.
            />
          </div>
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
