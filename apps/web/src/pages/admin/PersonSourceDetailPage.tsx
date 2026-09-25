import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Select,
  StateBadge,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { StaleBadge, draftKey, draftStatus, summaryOf } from './DraftState.js';

interface HostKey {
  fingerprint: string;
  status: 'matched' | 'unknown' | 'mismatch';
}

interface TestResult {
  ok: boolean;
  message: string;
  columns?: string[];
  recordsSampled?: number;
  hostKey?: HostKey;
}

interface MappingRule {
  recordType: 'person' | 'contract';
  sourceColumn: string;
  targetField: string;
  transform: 'none' | 'trim' | 'lowercase';
  isCorrelation: boolean;
}

interface PersonSource {
  id: string;
  name: string;
  feedMode: 'snapshot' | 'delta';
  schedule: string | null;
  autoApply: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
}

/**
 * Readable names for the fields the server says a mapping may write.
 *
 * The LIST comes from `/person-sources/mapping-defaults`, never from here.
 * That endpoint exists so there is exactly one definition of what is
 * writable: a field this screen offered but `setPersonMappings` rejects is a
 * 400 an administrator cannot act on, and a field the server allows but this
 * screen omits is one they simply cannot map. Both had already happened --
 * `nameConvention`, `sequence` and `isPrimary` were missing here.
 *
 * A field with no entry falls back to its own name, so a new one added
 * server-side appears immediately rather than silently not appearing.
 */
const FIELD_LABELS: Record<string, string> = {
  givenName: 'given name',
  familyName: 'family name',
  nameConvention: 'name convention',
  businessEmail: 'business email',
  personalEmail: 'personal email',
  sequence: 'contract sequence',
  isPrimary: 'primary contract flag',
  startDate: 'start date',
  endDate: 'end date',
  jobTitle: 'job title',
  department: 'department',
  costCentre: 'cost centre',
  employer: 'employer',
  location: 'location',
  managerExternalId: 'manager employee id',
  fte: 'FTE',
};

/**
 * `externalId` means different things on the two record types, so it is
 * resolved per type rather than globally: on a person it is the employee id
 * that anchors the row, on a contract it is the employment id the diff
 * matches on. One label for both read as "employee id" twice, which is a
 * screen that cannot be filled in correctly.
 */
const PER_TYPE_LABELS: Record<'person' | 'contract', Record<string, string>> = {
  person: { externalId: 'employee id' },
  contract: { externalId: 'contract id' },
};

const labelFor = (recordType: 'person' | 'contract', field: string) =>
  PER_TYPE_LABELS[recordType][field] ?? FIELD_LABELS[field] ?? field;

interface AssignableFields {
  person: string[];
  contract: string[];
}

/**
 * What this form edits, as one value, so "has anything changed" and "is the
 * test result still about this connection" are comparisons rather than flags.
 */
interface Draft {
  name: string;
  host: string;
  port: string;
  username: string;
  remotePath: string;
  credential: string;
  schedule: string;
  /**
   * Null until chosen, and the save is disabled while it is.
   *
   * NOT preselected. Reading a delta file as a snapshot departs everyone who
   * did not change yesterday, and a default is how that happens without
   * anybody choosing it.
   */
  feedMode: 'snapshot' | 'delta' | null;
}

const BLANK: Draft = {
  name: '',
  host: '',
  port: '22',
  username: '',
  remotePath: '',
  credential: '',
  schedule: '',
  feedMode: null,
};

/** The part of the draft a connection test depends on. */
const connectionKey = (draft: Draft) =>
  draftKey([draft.host, draft.port, draft.username, draft.remotePath, draft.credential]);

/** On-screen names for the fields the API reports problems against. */
const LABELS: Record<string, string> = {
  name: 'Name',
  host: 'Host',
  port: 'Port',
  username: 'Username',
  remotePath: 'Remote path',
  credential: 'Credential',
  schedule: 'Schedule',
};

export function PersonSourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isNew = id === undefined || id === 'new';

  const [draft, setDraft] = useState<Draft>(BLANK);
  /**
   * The draft as it last matched the server. "Unsaved changes" is a
   * comparison with it, never a flag a handler might forget to set.
   */
  const [baseline, setBaseline] = useState<Draft>(BLANK);

  /**
   * The stored config, kept whole so a save cannot drop the parts this form
   * does not show. See `save`.
   */
  const [loadedConfig, setLoadedConfig] = useState<Record<string, unknown>>({});
  const [sourceId, setSourceId] = useState<string | null>(isNew ? null : (id ?? null));
  const [columns, setColumns] = useState<string[]>([]);
  const [hostKey, setHostKey] = useState<HostKey | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  // The connection the result above was read from. See `testStale`.
  const [testFor, setTestFor] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [mappingsTouched, setMappingsTouched] = useState(false);
  /** What the server says a mapping may write. Never hardcoded here. */
  const [assignable, setAssignable] = useState<AssignableFields>({
    person: [],
    contract: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    void (async () => {
      try {
        const defaults = await api<{ assignableFields: AssignableFields }>(
          '/api/admin/person-sources/mapping-defaults',
        );
        setAssignable(defaults.assignableFields);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, []);

  useEffect(() => {
    if (isNew || !id) return;
    void (async () => {
      try {
        const source = await api<PersonSource>(`/api/admin/person-sources/${id}`);
        const config = source.config as Record<string, string | number>;
        // Kept whole, not just the parts this form edits. See `save`.
        setLoadedConfig(source.config);
        const loaded: Draft = {
          name: source.name,
          host: String(config.host ?? ''),
          port: String(config.port ?? 22),
          username: String(config.username ?? ''),
          remotePath: String(config.remotePath ?? ''),
          credential: '',
          schedule: source.schedule ?? '',
          feedMode: source.feedMode,
        };
        setDraft(loaded);
        setBaseline(loaded);
        if (typeof config.hostKeyFingerprint === 'string' && config.hostKeyFingerprint) {
          setHostKey({ fingerprint: config.hostKeyFingerprint, status: 'matched' });
        }
        const saved = await api<{ rules: MappingRule[] }>(
          `/api/admin/person-sources/${id}/mappings`,
        );
        setMappings(
          Object.fromEntries(
            saved.rules.map((rule) => [`${rule.recordType}.${rule.targetField}`, rule.sourceColumn]),
          ),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [id, isNew]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft.feedMode === null) return;
    setBusy(true);
    setError(null);
    setInvalid({});
    try {
      /*
       * The config the source already had, with this form's fields over it.
       *
       * NOT just the fields shown. `sftpDelimitedConfigSchema` is a whole
       * object with defaults, so sending only what this form edits resets
       * everything it does not -- `delimiter`, `quoteChar`, `encoding`,
       * `hasHeaderRow`, `maxBytes`, `maxRows`. A source reading a
       * tab-separated export would silently become comma-separated on the
       * next save from this screen, and every row after that would fail to
       * map. Saving a form must not change settings the form never showed.
       */
      const config = {
        ...loadedConfig,
        host: draft.host,
        port: Number(draft.port),
        username: draft.username,
        remotePath: draft.remotePath,
        ...(hostKey?.fingerprint ? { hostKeyFingerprint: hostKey.fingerprint } : {}),
      };
      if (sourceId === null) {
        const created = await api<PersonSource>('/api/admin/person-sources', {
          method: 'POST',
          body: JSON.stringify({
            name: draft.name,
            type: 'sftpDelimited',
            feedMode: draft.feedMode,
            config,
            credential: draft.credential,
            ...(draft.schedule ? { schedule: draft.schedule } : {}),
          }),
        });
        setSourceId(created.id);
        toast({ tone: 'success', title: 'HR feed created' });
        navigate(`/admin/person-sources/${created.id}`);
      } else {
        await api(`/api/admin/person-sources/${sourceId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: draft.name,
            feedMode: draft.feedMode,
            config,
            schedule: draft.schedule === '' ? null : draft.schedule,
            ...(draft.credential ? { credential: draft.credential } : {}),
          }),
        });
        setBaseline(draft);
        toast({ tone: 'success', title: 'HR feed saved' });
      }
    } catch (cause) {
      // The fields the server named go on their controls and into the
      // summary at the top; anything else is one sentence in a banner.
      const marked = fieldErrors(cause);
      setInvalid(marked);
      if (Object.keys(marked).length === 0) {
        setError(cause instanceof ApiError ? cause.problem.detail ?? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (sourceId === null) return;
    setBusy(true);
    setError(null);
    const sentFor = connectionKey(draft);
    try {
      const result = await api<TestResult>(
        `/api/admin/person-sources/${sourceId}/test`,
        { method: 'POST' },
      );
      setTest(result);
      setTestFor(sentFor);
      setColumns(result.columns ?? []);
      setHostKey(result.hostKey ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function acceptHostKey() {
    if (sourceId === null || hostKey === null) return;
    setBusy(true);
    try {
      await api(`/api/admin/person-sources/${sourceId}/host-key`, {
        method: 'POST',
        body: JSON.stringify({ fingerprint: hostKey.fingerprint }),
      });
      setHostKey({ ...hostKey, status: 'matched' });
      toast({ tone: 'success', title: 'Host key trusted' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Runs the source now and lands on the run it started.
   *
   * The endpoint answers 202 with the queued row rather than the result: the
   * read is a background job, and holding the request open for an SFTP fetch
   * is the shape that outlasts a proxy timeout.
   */
  async function runNow() {
    if (sourceId === null) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api<{ id: string }>(
        `/api/admin/person-sources/${sourceId}/run`,
        { method: 'POST' },
      );
      navigate(`/admin/person-import-runs/${run.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveMappings() {
    if (sourceId === null) return;
    setBusy(true);
    setError(null);
    try {
      const rules: MappingRule[] = Object.entries(mappings)
        .filter(([, column]) => column !== '')
        .map(([key, column]) => {
          const [recordType, targetField] = key.split('.') as ['person' | 'contract', string];
          return {
            recordType,
            sourceColumn: column,
            targetField,
            transform: 'trim',
            isCorrelation: recordType === 'person' && targetField === 'externalId',
          };
        });
      await api(`/api/admin/person-sources/${sourceId}/mappings`, {
        method: 'PUT',
        body: JSON.stringify({ mappings: rules }),
      });
      setMappingsTouched(false);
      toast({ tone: 'success', title: 'Column mappings saved' });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail ?? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const map = (key: string, value: string) => {
    setMappingsTouched(true);
    setMappings((current) => ({ ...current, [key]: value }));
  };

  const columnOptions = [
    { value: '', label: '—' },
    ...columns.map((column) => ({ value: column, label: column })),
  ];
  const mappedContractId = mappings['contract.externalId'];

  const dirty = draftKey(draft) !== draftKey(baseline);
  /**
   * The test reads the server, the path and the columns of ONE connection.
   * The moment the host, port, account, path or credential on screen differ
   * from that one, the columns offered below may not exist in the file this
   * source will actually read — so the result is labelled out of date rather
   * than left looking like an answer about this draft.
   */
  const testStale = test !== null && testFor !== connectionKey(draft);

  const testState =
    sourceId === null ? (
      <StateBadge state="setup">Save first</StateBadge>
    ) : test === null ? (
      <StateBadge state="setup">Not tested</StateBadge>
    ) : testStale ? (
      <StaleBadge />
    ) : test.ok ? (
      <StateBadge state="healthy">Tested</StateBadge>
    ) : (
      <StateBadge state="attention">Needs attention</StateBadge>
    );

  const mark = (field: string): { error?: string } =>
    invalid[field] ? { error: invalid[field] } : {};

  return (
    <>
      <PageHeader title={isNew ? 'New HR feed' : draft.name || 'HR feed'} />

      <div className="space-y-6">
        {error && <Alert tone="danger">{error}</Alert>}

        {/*
          Numbered, because this one is a sequence: the file has to be
          reachable before it can be tested, and tested before its columns
          exist to be mapped. The review found creation "immediately exposes
          SFTP settings and raw cron without a visible setup sequence"; the
          schedule is last because running unattended is the step that comes
          after everything else has been seen to work.
        */}
        <form
          onSubmit={save}
          aria-label={isNew ? 'New HR feed' : 'HR feed settings'}
          className="space-y-6 rounded-panel border border-border-subtle bg-bg px-4 pt-4"
        >
          <ErrorSummary errors={summaryOf(invalid, LABELS)} />

          <FormSection title="Connection" number={1}>
            <Field label="Name" name="name" value={draft.name} onChange={(v) => set('name', v)} required {...mark('name')} className="sm:col-span-2" />
            <Field label="Host" name="host" value={draft.host} onChange={(v) => set('host', v)} required {...mark('host')} />
            <Field label="Port" name="port" value={draft.port} onChange={(v) => set('port', v)} inputMode="numeric" {...mark('port')} />
            <Field label="Username" name="username" value={draft.username} onChange={(v) => set('username', v)} required {...mark('username')} />
            <Field label="Remote path" name="remotePath" value={draft.remotePath} onChange={(v) => set('remotePath', v)} required {...mark('remotePath')} />
            <Field
              label={sourceId === null ? 'Password or private key' : 'Replace credential'}
              name="credential"
              type="password"
              autoComplete="new-password"
              value={draft.credential}
              onChange={(v) => set('credential', v)}
              {...(sourceId === null ? { required: true } : { placeholder: 'Leave blank to keep the stored credential' })}
              {...mark('credential')}
            />
          </FormSection>

          <FormSection
            title="What the file contains"
            number={2}
            status={draft.feedMode === null ? <StateBadge state="setup">Choose one</StateBadge> : null}
          >
            {/*
              * Snapshot or delta, with no preselection.
              *
              * The labels say what the FILE is, because that is what the
              * administrator knows; the line beneath says what Syntra will do
              * about it, which is what they need to decide. A control that needs
              * a paragraph above it to be usable is a control that needs
              * redesigning.
              */}
            <fieldset className="grid gap-2 sm:col-span-2">
              <legend className="sr-only">What this file contains</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="feedMode"
                  value="snapshot"
                  checked={draft.feedMode === 'snapshot'}
                  onChange={() => set('feedMode', 'snapshot')}
                  className="size-4 accent-primary"
                />
                Everyone currently employed
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="feedMode"
                  value="delta"
                  checked={draft.feedMode === 'delta'}
                  onChange={() => set('feedMode', 'delta')}
                  className="size-4 accent-primary"
                />
                Only what changed since the last file
              </label>
              {draft.feedMode === 'snapshot' && (
                <p className="text-sm text-warning">People missing from the file are treated as leavers.</p>
              )}
              {draft.feedMode === 'delta' && (
                <p className="text-sm text-muted">People missing from the file are left alone.</p>
              )}
            </fieldset>
          </FormSection>

          <FormSection title="Test the connection" number={3} status={testState}>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <Button type="button" onClick={runTest} disabled={busy || sourceId === null}>
                Test connection
              </Button>
              <Button type="button" onClick={runNow} disabled={busy || sourceId === null}>
                Run now
              </Button>
            </div>

            {test && (
              <p className="text-muted sm:col-span-2">{test.message}</p>
            )}

            {/*
              * There is no field to type a fingerprint into. Nobody has one to
              * hand, and a field that can be typed into is a field the wrong
              * thing can be pasted into: testing is how a key is obtained.
              */}
            {hostKey?.status === 'unknown' && (
              <div className="sm:col-span-2">
                <Alert tone="warning">
                  <p>This server presented a host key Syntra has not seen before.</p>
                  <code>{hostKey.fingerprint}</code>
                  <div className="mt-2">
                    <Button type="button" onClick={acceptHostKey} disabled={busy}>
                      Accept this key
                    </Button>
                  </div>
                </Alert>
              </div>
            )}

            {/*
              * A changed key gets no accept action at all. It is a rebuilt
              * server or an interception, and only one of those is safe to click
              * through.
              */}
            {hostKey?.status === 'mismatch' && (
              <div className="sm:col-span-2">
                <Alert tone="danger">
                  <p>
                    This server presented a different host key from the one this source is
                    pinned to. Either the server was rebuilt, or the connection is being
                    intercepted.
                  </p>
                  <code>{hostKey.fingerprint}</code>
                </Alert>
              </div>
            )}

            {hostKey?.status === 'matched' && (
              <p className="text-muted sm:col-span-2">
                Host key accepted: <code>{hostKey.fingerprint}</code>
              </p>
            )}
          </FormSection>

          <FormSection
            title="Map the columns"
            number={4}
            status={
              columns.length === 0 ? (
                <StateBadge state="setup">Test to read the columns</StateBadge>
              ) : testStale ? (
                <StaleBadge>Columns out of date — test again</StaleBadge>
              ) : mappingsTouched ? (
                <StateBadge state="attention">Unsaved mappings</StateBadge>
              ) : null
            }
          >
            {sourceId !== null && columns.length > 0 && (
              <>
                {/*
                  * Mapping is choosing from the columns the test actually read, not
                  * typing names that might exist.
                  *
                  * `externalId` first, and separately: it is not in the person
                  * allow-list because it is not an ordinary field. It is the
                  * anchor -- the correlation rule the server requires exactly one
                  * of, and the reason `setPersonMappings` exempts correlation
                  * rules from that list.
                  */}
                <Select
                  label={`Column for ${labelFor('person', 'externalId')}`}
                  name="person.externalId"
                  value={mappings['person.externalId'] ?? ''}
                  onChange={(value) => map('person.externalId', value)}
                  options={columnOptions}
                />
                {assignable.person.map((field) => (
                  <Select
                    key={`person.${field}`}
                    label={`Column for ${labelFor('person', field)}`}
                    name={`person.${field}`}
                    value={mappings[`person.${field}`] ?? ''}
                    onChange={(value) => map(`person.${field}`, value)}
                    options={columnOptions}
                  />
                ))}
                {assignable.contract.map((field) => (
                  <Select
                    key={`contract.${field}`}
                    label={`Column for ${labelFor('contract', field)}`}
                    name={`contract.${field}`}
                    value={mappings[`contract.${field}`] ?? ''}
                    onChange={(value) => map(`contract.${field}`, value)}
                    options={columnOptions}
                  />
                ))}

                {(mappedContractId === undefined || mappedContractId === '') && (
                  <div className="sm:col-span-2">
                    <Alert tone="warning">
                      Without a contract id, contracts are matched by position — so two contracts
                      arriving in a different order are rewritten into each other. Map one if the
                      file carries it.
                    </Alert>
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Button type="button" onClick={saveMappings} disabled={busy}>
                    Save mappings
                  </Button>
                </div>
              </>
            )}
          </FormSection>

          <FormSection title="Schedule" number={5}>
            <Field
              label="Schedule"
              name="schedule"
              value={draft.schedule}
              onChange={(v) => set('schedule', v)}
              placeholder="0 2 * * *"
              {...mark('schedule')}
            />
          </FormSection>

          <FormActions
            sticky
            status={draftStatus({
              dirty,
              stale: testStale ? 'Test result is out of date' : null,
            })}
          >
            <Button type="submit" variant="primary" disabled={busy || draft.feedMode === null}>
              {sourceId === null ? 'Create source' : 'Save source'}
            </Button>
          </FormActions>
        </form>
      </div>
    </>
  );
}
