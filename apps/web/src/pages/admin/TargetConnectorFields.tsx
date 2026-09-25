import { useState } from 'react';
import { Alert, Button, Field, Select, Textarea } from '@syntra/ui';
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
  userPrincipalDomain,
  onTenantIdChange,
  onClientIdChange,
  onCredentialChange,
  onCorrelationFieldChange,
  onUserPrincipalDomainChange,
  mark,
}: {
  isNew: boolean;
  tenantId: string;
  clientId: string;
  credential: string;
  correlationField: string;
  userPrincipalDomain: string;
  onTenantIdChange(value: string): void;
  onClientIdChange(value: string): void;
  onCredentialChange(value: string): void;
  onCorrelationFieldChange(value: string): void;
  onUserPrincipalDomainChange(value: string): void;
  mark(field: string): { error?: string };
}) {
  return (
    <>
      <Field
        label="Directory (tenant) ID"
        name="tenantId"
        value={tenantId}
        onChange={onTenantIdChange}
        autoComplete="off"
        // What it accepts, in the box: the id or a verified domain. A domain
        // is what lets a correlation key without one be completed.
        placeholder="Directory ID or contoso.onmicrosoft.com"
        {...mark('tenantId')}
      />
      <Field
        label="Application (client) ID"
        name="clientId"
        value={clientId}
        onChange={onClientIdChange}
        autoComplete="off"
        {...mark('clientId')}
      />
      <Field
        label="User principal name domain"
        value={userPrincipalDomain}
        onChange={onUserPrincipalDomainChange}
        autoComplete="off"
        {...mark('userPrincipalDomain')}
      />
      <p className="sm:col-span-2 -mt-2 text-sm text-ink-muted">
        The domain new users sign in with, e.g. contoso.com — must be a
        verified domain in the tenant; leave empty only if Tenant ID is itself
        a domain. A new account is named{' '}
        <code>&lt;account name&gt;@&lt;this domain&gt;</code>. Entra ID has no
        containers, so the account profile&apos;s container settings are
        ignored for this target.
      </p>
      <Field
        label="Application client secret"
        name="bindPassword"
        type="password"
        autoComplete="new-password"
        value={credential}
        onChange={onCredentialChange}
        // Blank on an edit keeps the vaulted secret; typing one rotates it.
        // Said in the box, where somebody about to type is looking.
        placeholder={isNew ? undefined : 'Leave blank to keep the stored secret'}
        {...mark('bindPassword')}
      />
      <Select
        label="Correlation field"
        name="correlationField"
        value={correlationField}
        onChange={onCorrelationFieldChange}
        options={ENTRA_CORRELATION_FIELDS.map((value) => ({ value, label: value }))}
        {...mark('correlationField')}
      />
      {/* Facts about the connector, labelled as facts rather than written
          as a paragraph: the permissions are what somebody copies into the
          app registration, and the group scope is a limit no setting on
          this form changes. */}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:col-span-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted">Graph application permissions (admin consent)</dt>
          <dd className="mt-0.5 text-ink">
            <code>User.ReadWrite.All</code>, <code>GroupMember.ReadWrite.All</code>,{' '}
            <code>Group.Read.All</code>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Group memberships managed</dt>
          <dd className="mt-0.5 text-ink">
            Direct memberships of assigned security groups. Nested and dynamic groups are not.
          </dd>
        </div>
      </dl>
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
  isNew,
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
  const isSnipeIt = documentKey === 'snipe-it' || parsed?.name === 'Snipe-IT';
  // The shipped Snipe-IT document cannot know the instance's host, and a
  // placeholder left in place fails only at the first connection test.
  const hostPlaceholder =
    typeof parsed?.baseUrl === 'string' && parsed.baseUrl.includes('{instance}');

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
            name="entraTenantId"
            value={entraTenantId}
            onChange={onEntraTenantIdChange}
            autoComplete="off"
          />
          <Field
            label="Application (client) ID"
            name="entraClientId"
            value={entraClientId}
            onChange={onEntraClientIdChange}
            autoComplete="off"
          />
        </div>
      )}

      <Field
        label={
          isEntra ? 'Application client secret' : isSnipeIt ? 'Personal API key' : 'Client secret'
        }
        name="bindPassword"
        type="password"
        autoComplete="new-password"
        value={credential}
        onChange={onCredentialChange}
        placeholder={isNew ? undefined : 'Leave blank to keep the stored secret'}
      />

      {hostPlaceholder && (
        <Alert tone="warning">
          Replace <code>{'{instance}'}</code> in the connector document&apos;s{' '}
          <code>baseUrl</code> with your Snipe-IT host, e.g.{' '}
          <code>https://assets.example.com/api/v1</code>.
        </Alert>
      )}

      <div className="space-y-2">
        <Button
          type="button"
          variant="ghost"
          aria-expanded={showJson}
          onClick={() => setShowJson(!showJson)}
        >
          {showJson ? 'Hide the connector document' : 'Edit the connector document'}
        </Button>
        {showJson && (
          <Textarea
            label="Connector document"
            name="document"
            mono
            value={documentJson}
            onChange={onDocumentChange}
            spellCheck={false}
            rows={20}
            error={unreadable ? 'That is not valid JSON.' : undefined}
          />
        )}
        {/* Still said while the box is closed. A document broken and then
            hidden would otherwise save as `{}` with nothing on screen to
            say why. */}
        {!showJson && unreadable && (
          <Alert tone="danger">The connector document is not valid JSON.</Alert>
        )}
      </div>
    </div>
  );
}
