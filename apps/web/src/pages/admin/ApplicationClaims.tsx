import { useState } from 'react';
import { Alert, Button, Check, Empty, Field, Panel, Select, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

/**
 * What an application is told about whoever signs in.
 *
 * The other half of the SSO configuration that had no console surface at all.
 * `GET`, `POST` and `DELETE /applications/:id/claims` were in the API and
 * nothing called them — so a catalog entry's claim mappings could be created
 * and never inspected, and an application asking for an attribute the entry
 * did not know about could not be given one without going to the API by hand.
 *
 * Mappings are added and removed, never edited. That is the API's shape, and
 * it is the right one for something matched by name at sign-in: an edit that
 * renamed a claim would silently stop sending the old one, and the two-step
 * makes that a thing somebody did rather than a thing that happened.
 */

interface ClaimSet {
  id: string;
  name: string;
  description: string | null;
  protocol: 'saml' | 'oidc';
  mappings: unknown[];
}

interface ClaimMapping {
  id: string;
  protocol: 'saml' | 'oidc';
  claimName: string;
  sourceKind: string;
  sourceField: string | null;
  literalValue: string | null;
  multiValued: boolean;
}

/** Where a value comes from, in the words of somebody reading the row. */
const SOURCES = [
  { value: 'user', label: 'The account', field: 'Field on the account' },
  { value: 'person', label: 'The person', field: 'Field on the person' },
  { value: 'contract', label: 'Their contract', field: 'Field on the contract' },
  { value: 'attribute', label: 'A stored attribute', field: 'Attribute key' },
  { value: 'groups', label: 'Their groups', field: null },
  { value: 'literal', label: 'The same value for everybody', field: null },
] as const;

const sourceLabel = (kind: string) =>
  SOURCES.find((s) => s.value === kind)?.label ?? kind;

export function ApplicationClaims({
  applicationId,
  protocols,
}: {
  applicationId: string;
  /** Which protocols this application actually uses. */
  protocols: readonly ('saml' | 'oidc')[];
}) {
  const { data, error, reload } = useApiResource<{
    saml: ClaimMapping[];
    oidc: ClaimMapping[];
  }>(protocols.length > 0 ? `/api/admin/applications/${applicationId}/claims` : null);

  const { data: setData } = useApiResource<{ sets: ClaimSet[] }>(
    protocols.length > 0 ? '/api/admin/claim-sets' : null,
  );
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [applyProblem, setApplyProblem] = useState<string | null>(null);

  if (protocols.length === 0) return null;

  const rows = [...(data?.saml ?? []), ...(data?.oidc ?? [])];
  // Only sets for a protocol this application actually uses.
  const usableSets = (setData?.sets ?? []).filter((set) =>
    (protocols as readonly string[]).includes(set.protocol),
  );

  async function remove(id: string) {
    setBusy(id);
    try {
      await api(`/api/admin/applications/${applicationId}/claims/${id}`, {
        method: 'DELETE',
      });
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="What the application is told"
      description="The attributes sent with each sign-in."
      actions={
        <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
          Add a mapping
        </Button>
      }
    >
      <div className="p-4">
        {error && <Alert tone="danger">{error}</Alert>}

        {/*
          The sets this application could be given, offered only when one of
          them matches a protocol it uses. A set for the other protocol writes
          rows that protocol's builder never reads, and the API refuses it —
          there is no reason to make somebody discover that by pressing a
          button.
        */}
        {usableSets.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-muted">Apply a set:</span>
            {usableSets.map((set) => (
              <Button
                key={set.id}
                variant="secondary"
                size="sm"
                disabled={busy === set.id}
                onClick={async () => {
                  setBusy(set.id);
                  setApplied(null);
                  setApplyProblem(null);
                  try {
                    const result = await api<{ added: number; alreadyPresent: number }>(
                      `/api/admin/applications/${applicationId}/claims/apply-set`,
                      { method: 'POST', body: JSON.stringify({ setId: set.id }) },
                    );
                    // The numbers, because "applied" on its own is
                    // indistinguishable from "did nothing" — and doing nothing
                    // is the ordinary result of applying a set twice.
                    setApplied(
                      result.added === 0
                        ? `${set.name}: everything in it was already here.`
                        : `${set.name}: added ${result.added}, ${result.alreadyPresent} already here.`,
                    );
                    reload();
                  } catch (cause) {
                    setApplyProblem(
                      cause instanceof ApiError
                        ? (cause.problem.detail ?? cause.problem.title)
                        : 'That could not be applied.',
                    );
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {set.name}
              </Button>
            ))}
          </div>
        )}

        {applied && (
          <div className="mb-4">
            <Alert tone="success">{applied}</Alert>
          </div>
        )}
        {applyProblem && (
          <div className="mb-4">
            <Alert tone="danger">{applyProblem}</Alert>
          </div>
        )}

        {adding && (
          <div className="mb-4">
            <ClaimForm
              applicationId={applicationId}
              protocols={protocols}
              onCancel={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                reload();
              }}
            />
          </div>
        )}

        {rows.length === 0 && !adding && (
          <Empty title="Nothing beyond the name identifier">
            The application receives whoever signed in and nothing else. Add a
            mapping if it needs an email address, a department or a group list.
          </Empty>
        )}

        {rows.length > 0 && (
          <Table tight>
            <thead>
              <tr>
                <th scope="col">Sent as</th>
                <th scope="col">From</th>
                <th scope="col">Protocol</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="font-mono text-sm">{row.claimName}</td>
                  <td>
                    {sourceLabel(row.sourceKind)}
                    {row.sourceField && (
                      <span className="text-muted"> · {row.sourceField}</span>
                    )}
                    {row.literalValue && (
                      <span className="text-muted"> · {row.literalValue}</span>
                    )}
                  </td>
                  <td>{row.protocol === 'saml' ? 'SAML' : 'OpenID Connect'}</td>
                  <td>
                    <div className="row-actions">
                      <Button
                        variant="ghost"
                        disabled={busy === row.id}
                        onClick={() => remove(row.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Panel>
  );
}

function ClaimForm({
  applicationId,
  protocols,
  onCancel,
  onSaved,
}: {
  applicationId: string;
  protocols: readonly ('saml' | 'oidc')[];
  onCancel(): void;
  onSaved(): void;
}) {
  const [protocol, setProtocol] = useState<string>(protocols[0]!);
  const [claimName, setClaimName] = useState('');
  const [sourceKind, setSourceKind] = useState<string>('user');
  const [sourceField, setSourceField] = useState('');
  const [literalValue, setLiteralValue] = useState('');
  const [multiValued, setMultiValued] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const source = SOURCES.find((s) => s.value === sourceKind)!;
  const needsField = source.field !== null;
  const isLiteral = sourceKind === 'literal';

  const ready =
    claimName.trim() !== '' &&
    (!needsField || sourceField.trim() !== '') &&
    (!isLiteral || literalValue.trim() !== '');

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/applications/${applicationId}/claims`, {
        method: 'POST',
        body: JSON.stringify({
          protocol,
          claimName: claimName.trim(),
          sourceKind,
          // Null rather than an empty string for the sources that have no
          // field: the contract refuses a blank one, and sending '' would be
          // an error message about a box the reader cannot see.
          sourceField: needsField ? sourceField.trim() : null,
          literalValue: isLiteral ? literalValue.trim() : null,
          multiValued,
        }),
      });
      onSaved();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-panel border border-border-control p-3">
      <div className="space-y-3">
        {protocols.length > 1 && (
          <Select
            label="Protocol"
            value={protocol}
            onChange={setProtocol}
            options={protocols.map((p) => ({
              value: p,
              label: p === 'saml' ? 'SAML' : 'OpenID Connect',
            }))}
          />
        )}

        <Field
          label="Sent as"
          value={claimName}
          onChange={setClaimName}
          required
          hint={
            protocol === 'saml'
              ? 'The SAML attribute name the application expects.'
              : 'The claim name the application expects.'
          }
        />

        <Select
          label="From"
          value={sourceKind}
          onChange={setSourceKind}
          options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
        />

        {needsField && (
          <Field label={source.field!} value={sourceField} onChange={setSourceField} required />
        )}

        {isLiteral && (
          <Field label="Value" value={literalValue} onChange={setLiteralValue} required />
        )}

        {sourceKind === 'groups' && (
          <Check
            checked={multiValued}
            onChange={setMultiValued}
            label="Send every group, not just the first"
            hint="Most applications expecting a group list want this."
          />
        )}

        {problem && <Alert tone="danger">{problem}</Alert>}

        <div className="flex gap-2">
          <Button variant="primary" size="sm" loading={busy} disabled={!ready} onClick={save}>
            Add mapping
          </Button>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
