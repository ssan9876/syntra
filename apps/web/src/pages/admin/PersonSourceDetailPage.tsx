import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { PageHeader } from './PageHeader.js';

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

/** The person fields worth offering a column for, in the order they read. */
const PERSON_TARGETS = [
  { field: 'externalId', label: 'Employee id', correlation: true },
  { field: 'givenName', label: 'Given name', correlation: false },
  { field: 'familyName', label: 'Family name', correlation: false },
  { field: 'businessEmail', label: 'Business email', correlation: false },
  { field: 'personalEmail', label: 'Personal email', correlation: false },
] as const;

const CONTRACT_TARGETS = [
  { field: 'externalId', label: 'Contract id' },
  { field: 'startDate', label: 'Start date' },
  { field: 'endDate', label: 'End date' },
  { field: 'jobTitle', label: 'Job title' },
  { field: 'department', label: 'Department' },
  { field: 'costCentre', label: 'Cost centre' },
  { field: 'employer', label: 'Employer' },
  { field: 'location', label: 'Location' },
  { field: 'managerExternalId', label: 'Manager employee id' },
  { field: 'fte', label: 'FTE' },
] as const;

export function PersonSourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === undefined || id === 'new';

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [credential, setCredential] = useState('');
  const [schedule, setSchedule] = useState('');
  /**
   * Null until chosen, and the save is disabled while it is.
   *
   * NOT preselected. Reading a delta file as a snapshot departs everyone who
   * did not change yesterday, and a default is how that happens without
   * anybody choosing it.
   */
  const [feedMode, setFeedMode] = useState<'snapshot' | 'delta' | null>(null);

  /**
   * The stored config, kept whole so a save cannot drop the parts this form
   * does not show. See `save`.
   */
  const [loadedConfig, setLoadedConfig] = useState<Record<string, unknown>>({});
  const [sourceId, setSourceId] = useState<string | null>(isNew ? null : (id ?? null));
  const [columns, setColumns] = useState<string[]>([]);
  const [hostKey, setHostKey] = useState<HostKey | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew || !id) return;
    void (async () => {
      try {
        const source = await api<PersonSource>(`/api/admin/person-sources/${id}`);
        setName(source.name);
        setFeedMode(source.feedMode);
        setSchedule(source.schedule ?? '');
        const config = source.config as Record<string, string | number>;
        // Kept whole, not just the parts this form edits. See `save`.
        setLoadedConfig(source.config);
        setHost(String(config.host ?? ''));
        setPort(String(config.port ?? 22));
        setUsername(String(config.username ?? ''));
        setRemotePath(String(config.remotePath ?? ''));
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
    if (feedMode === null) return;
    setBusy(true);
    setError(null);
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
        host,
        port: Number(port),
        username,
        remotePath,
        ...(hostKey?.fingerprint ? { hostKeyFingerprint: hostKey.fingerprint } : {}),
      };
      if (sourceId === null) {
        const created = await api<PersonSource>('/api/admin/person-sources', {
          method: 'POST',
          body: JSON.stringify({
            name,
            type: 'sftpDelimited',
            feedMode,
            config,
            credential,
            ...(schedule ? { schedule } : {}),
          }),
        });
        setSourceId(created.id);
        navigate(`/admin/person-sources/${created.id}`);
      } else {
        await api(`/api/admin/person-sources/${sourceId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name,
            feedMode,
            config,
            schedule: schedule === '' ? null : schedule,
            ...(credential ? { credential } : {}),
          }),
        });
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail ?? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (sourceId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<TestResult>(
        `/api/admin/person-sources/${sourceId}/test`,
        { method: 'POST' },
      );
      setTestMessage(result.message);
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
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail ?? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const columnOptions = [
    { value: '', label: '—' },
    ...columns.map((column) => ({ value: column, label: column })),
  ];
  const mappedContractId = mappings['contract.externalId'];

  return (
    <>
      <PageHeader title={isNew ? 'New person source' : name || 'Person source'} />

      {error && <Alert tone="danger">{error}</Alert>}

      <Panel title="The file">
        <form onSubmit={save} className="grid gap-4">
          <Field label="Name" value={name} onChange={setName} required />
          <Field label="Host" value={host} onChange={setHost} required />
          <Field label="Port" value={port} onChange={setPort} />
          <Field label="Username" value={username} onChange={setUsername} required />
          <Field label="Remote path" value={remotePath} onChange={setRemotePath} required />
          <Field
            label={sourceId === null ? 'Password or private key' : 'Replace credential'}
            type="password"
            value={credential}
            onChange={setCredential}
            {...(sourceId === null ? { required: true } : {})}
          />
          <Field
            label="Schedule"
            value={schedule}
            onChange={setSchedule}
            placeholder="0 2 * * *"
          />

          {/*
            * Snapshot or delta, with no preselection.
            *
            * The labels say what the FILE is, because that is what the
            * administrator knows; the line beneath says what Syntra will do
            * about it, which is what they need to decide. A control that needs
            * a paragraph above it to be usable is a control that needs
            * redesigning.
            */}
          <fieldset className="grid gap-2">
            <legend className="font-semibold text-ink">What this file contains</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="feedMode"
                value="snapshot"
                checked={feedMode === 'snapshot'}
                onChange={() => setFeedMode('snapshot')}
              />
              Everyone currently employed
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="feedMode"
                value="delta"
                checked={feedMode === 'delta'}
                onChange={() => setFeedMode('delta')}
              />
              Only what changed since the last file
            </label>
            {feedMode === 'snapshot' && (
              <p className="text-muted">People missing from the file are treated as leavers.</p>
            )}
            {feedMode === 'delta' && (
              <p className="text-muted">People missing from the file are left alone.</p>
            )}
          </fieldset>

          <div>
            <Button type="submit" disabled={busy || feedMode === null}>
              {sourceId === null ? 'Create source' : 'Save source'}
            </Button>
          </div>
        </form>
      </Panel>

      {sourceId !== null && (
        <Panel
          title="Connection"
          actions={
            <div className="flex gap-2">
              <Button onClick={test} disabled={busy} variant="secondary">
                Test connection
              </Button>
              <Button onClick={runNow} disabled={busy}>
                Run now
              </Button>
            </div>
          }
        >
          {testMessage && <p className="text-muted">{testMessage}</p>}

          {/*
            * There is no field to type a fingerprint into. Nobody has one to
            * hand, and a field that can be typed into is a field the wrong
            * thing can be pasted into: testing is how a key is obtained.
            */}
          {hostKey?.status === 'unknown' && (
            <Alert tone="warning">
              <p>This server presented a host key Syntra has not seen before.</p>
              <code>{hostKey.fingerprint}</code>
              <div className="mt-2">
                <Button onClick={acceptHostKey} disabled={busy}>
                  Accept this key
                </Button>
              </div>
            </Alert>
          )}

          {/*
            * A changed key gets no accept action at all. It is a rebuilt
            * server or an interception, and only one of those is safe to click
            * through.
            */}
          {hostKey?.status === 'mismatch' && (
            <Alert tone="danger">
              <p>
                This server presented a different host key from the one this source is
                pinned to. Either the server was rebuilt, or the connection is being
                intercepted.
              </p>
              <code>{hostKey.fingerprint}</code>
            </Alert>
          )}

          {hostKey?.status === 'matched' && (
            <p className="text-muted">
              Host key accepted: <code>{hostKey.fingerprint}</code>
            </p>
          )}
        </Panel>
      )}

      {sourceId !== null && columns.length > 0 && (
        <Panel
          title="Columns"
          actions={
            <Button onClick={saveMappings} disabled={busy}>
              Save mappings
            </Button>
          }
        >
          {/*
            * Mapping is choosing from the columns the test actually read, not
            * typing names that might exist.
            */}
          <div className="grid gap-3">
            {PERSON_TARGETS.map((target) => (
              <Select
                key={`person.${target.field}`}
                label={`Column for ${target.label.toLowerCase()}`}
                value={mappings[`person.${target.field}`] ?? ''}
                onChange={(value) =>
                  setMappings({ ...mappings, [`person.${target.field}`]: value })
                }
                options={columnOptions}
              />
            ))}
            {CONTRACT_TARGETS.map((target) => (
              <Select
                key={`contract.${target.field}`}
                label={`Column for ${target.label.toLowerCase()}`}
                value={mappings[`contract.${target.field}`] ?? ''}
                onChange={(value) =>
                  setMappings({ ...mappings, [`contract.${target.field}`]: value })
                }
                options={columnOptions}
              />
            ))}
          </div>

          {(mappedContractId === undefined || mappedContractId === '') && (
            <Alert tone="warning">
              Without a contract id, contracts are matched by position — so two contracts
              arriving in a different order are rewritten into each other. Map one if the
              file carries it.
            </Alert>
          )}
        </Panel>
      )}
    </>
  );
}
