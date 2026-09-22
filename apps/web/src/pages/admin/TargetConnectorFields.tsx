import { useState } from 'react';
import { Alert, Button, Field, Select } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { ENTRA_CORRELATION_FIELDS, parseDocument } from './target-form.js';

/**
 * Configuring the native Microsoft Entra ID connector.
 *
 * Three identifiers and one secret. The tenant and client ids are ordinary
 * configuration (they appear in exports); the client secret goes to the
 * vault and is never shown again. The correlation field is where the
 * connector records which ProvisionAction created a user -- it is written
 * once, on create, and is what makes a retried create find the object the
 * first attempt made instead of making a second one.
 */
export function EntraConnectorFields({
  isNew,
  tenantId,
  clientId,
  credential,
  correlationField,
  onTenantIdChange,
  onClientIdChange,
  onCredentialChange,
  onCorrelationFieldChange,
  mark,
}: {
  isNew: boolean;
  tenantId: string;
  clientId: string;
  credential: string;
  correlationField: string;
  onTenantIdChange(value: string): void;
  onClientIdChange(value: string): void;
  onCredentialChange(value: string): void;
  onCorrelationFieldChange(value: string): void;
  mark(field: string): { error?: string };
}) {
  return (
    <>
      <Field
        label="Directory (tenant) ID"
        value={tenantId}
        onChange={onTenantIdChange}
        autoComplete="off"
        {...mark('tenantId')}
      />
      <Field
        label="Application (client) ID"
        value={clientId}
        onChange={onClientIdChange}
        autoComplete="off"
        {...mark('clientId')}
      />
      <Field
        label="Application client secret"
        type="password"
        autoComplete="new-password"
        value={credential}
        onChange={onCredentialChange}
        {...mark('bindPassword')}
      />
      <p className="sm:col-span-2 -mt-2 text-sm text-ink-muted">
        The tenant is the directory id or a verified domain such as
        contoso.onmicrosoft.com; a domain lets a correlation key without one be
        completed. Neither id is a secret.{' '}
        {isNew
          ? 'The client secret is stored encrypted by Syntra and never shown again.'
          : 'Leave the secret blank to keep the stored one; typing a new one rotates it and records a readiness check.'}
      </p>
      <Select
        label="Correlation field"
        value={correlationField}
        onChange={onCorrelationFieldChange}
        options={ENTRA_CORRELATION_FIELDS.map((value) => ({ value, label: value }))}
        {...mark('correlationField')}
      />
      <p className="sm:col-span-2 -mt-2 text-sm text-ink-muted">
        The correlation field holds the id of the action that created a user. It is written once, on create, and never by an update.
      </p>
      <p className="sm:col-span-2 text-sm text-ink-muted">
        Grant the app registration these application permissions, with admin
        consent, and no more: <code>User.ReadWrite.All</code>,{' '}
        <code>GroupMember.ReadWrite.All</code> and <code>Group.Read.All</code>.
        Graph does not publish effective permissions, so the connection test
        reports every right as unchecked; the readiness check is where consent
        is recorded. Only direct memberships of assigned security groups are
        managed. Nested and dynamic groups are not, and there is no setting
        that makes them so.
      </p>
    </>
  );
}

/**
 * Configuring a REST API target.
 *
 * The shape of this form is the whole design decision. A connector document
 * is a hundred lines of JSON, and a screen that opened with an empty textarea
 * and a link to the documentation would be a screen that needs a manual to
 * use — which means it is the wrong screen. So the first control is a PICKER:
 * an administrator connecting Entra ID chooses Entra ID, and the document is
 * filled in for them, already correct.
 *
 * The textarea is still there, below, because a declarative connector whose
 * documents cannot be edited is a fixed integration wearing a general-purpose
 * name. It is just not the thing you meet first.
 */
export function HttpConnectorFields({
  documentKey,
  documentJson,
  credential,
  entraTenantId,
  entraClientId,
  onPick,
  onDocumentChange,
  onCredentialChange,
  onEntraTenantIdChange,
  onEntraClientIdChange,
}: {
  isNew: boolean;
  documentKey: string;
  documentJson: string;
  credential: string;
  entraTenantId: string;
  entraClientId: string;
  onPick(key: string, document: Record<string, unknown>): void;
  onDocumentChange(value: string): void;
  onCredentialChange(value: string): void;
  onEntraTenantIdChange(value: string): void;
  onEntraClientIdChange(value: string): void;
}) {
  const { data } = useApiResource<{
    documents: { key: string; name: string; document: Record<string, unknown> }[];
  }>('/api/admin/targets/connector-documents');
  const [showJson, setShowJson] = useState(false);

  const documents = data?.documents ?? [];
  const parsed = parseDocument(documentJson);
  const unreadable = documentJson.trim() !== '' && parsed === null;
  const isEntra = documentKey === 'entra-id' || parsed?.name === 'Microsoft Entra ID';

  return (
    <div className="sm:col-span-2 space-y-4">
      <div>
        <span className="font-medium text-ink">System</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {documents.map((entry) => (
            <Button
              key={entry.key}
              type="button"
              variant={documentKey === entry.key ? 'primary' : 'secondary'}
              onClick={() => onPick(entry.key, entry.document)}
            >
              {entry.name}
            </Button>
          ))}
        </div>
      </div>

      {isEntra && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Directory (tenant) ID"
            value={entraTenantId}
            onChange={onEntraTenantIdChange}
            autoComplete="off"
          />
          <Field
            label="Application (client) ID"
            value={entraClientId}
            onChange={onEntraClientIdChange}
            autoComplete="off"
          />
          <p className="sm:col-span-2 -mt-2 text-sm text-ink-muted">
            These identify the directory and app registration; neither is a secret.
          </p>
        </div>
      )}

      <Field
        label={isEntra ? 'Application client secret' : 'Client secret'}
        type="password"
        autoComplete="new-password"
        value={credential}
        onChange={onCredentialChange}
      />
      {isEntra && (
        <p className="-mt-2 text-sm text-ink-muted">
          Stored encrypted by Syntra and never shown again.
        </p>
      )}

      <div>
        <Button type="button" variant="ghost" onClick={() => setShowJson(!showJson)}>
          {showJson ? 'Hide the connector document' : 'Edit the connector document'}
        </Button>
        {showJson && (
          <>
            <textarea
              aria-label="Connector document"
              value={documentJson}
              onChange={(event) => onDocumentChange(event.target.value)}
              spellCheck={false}
              rows={20}
              className="mt-2 w-full rounded-control border border-border-control bg-bg p-3 font-mono text-sm text-ink"
            />
            {unreadable && <Alert tone="danger">That is not valid JSON.</Alert>}
          </>
        )}
      </div>
    </div>
  );
}
