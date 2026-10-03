import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  Identifier,
  Panel,
  Select,
  Textarea,
  useToast,
} from '@syntra/ui';
// The file, not the package index: the index carries every zod schema.
import { isLaunchableUrl } from '@syntra/contracts/src/launchable-url.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';

type Protocol = 'bookmark' | 'saml' | 'oidc';
type SamlSource = 'metadataUrl' | 'metadataXml' | 'manual';

const NAME_ID_FORMATS = [
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', label: 'Email address' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', label: 'Persistent' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'Unspecified' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', label: 'Transient' },
];

const LABELS: Record<string, string> = {
  name: 'Name',
  slug: 'Slug',
  description: 'Description',
  category: 'Category',
  launchUrl: 'Launch URL',
  'saml.metadataUrl': 'Metadata URL',
  'saml.metadataXml': 'Metadata',
  'saml.spEntityId': 'Entity ID',
  'saml.acsUrls': 'ACS URLs',
  'saml.spCertificates': 'Signing certificate',
  'saml.wantAuthnRequestsSigned': 'Require signed requests',
  'oidc.redirectUris': 'Redirect URIs',
  claims: 'Claims',
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** PEM blocks in a pasted blob. */
function certificatesOf(blob: string): string[] {
  return blob.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * "Add by hand": the tile, how people sign in, and the claims it receives,
 * saved in one step.
 */
export function AddApplicationByHand({ onCancel, onCreated }: { onCancel(): void; onCreated(): void }) {
  const toast = useToast();
  const { data: claimSets } = useApiResource<{ sets: { id: string; name: string; protocol: string }[] }>(
    '/api/admin/claim-sets',
  );

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [launchUrl, setLaunchUrl] = useState('');
  const [category, setCategory] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('bookmark');

  const [samlSource, setSamlSource] = useState<SamlSource>('metadataUrl');
  const [metadataUrl, setMetadataUrl] = useState('');
  const [metadataXml, setMetadataXml] = useState('');
  const [entityId, setEntityId] = useState('');
  const [acsUrls, setAcsUrls] = useState('');
  const [nameIdFormat, setNameIdFormat] = useState(NAME_ID_FORMATS[0]!.value);
  const [certificate, setCertificate] = useState('');
  const [signedRequests, setSignedRequests] = useState(true);

  const [redirectUris, setRedirectUris] = useState('');
  const [scopes, setScopes] = useState('openid profile email');

  const [claims, setClaims] = useState('standard');

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; clientId: string; clientSecret: string } | null>(null);

  const dirty = [name, slug, description, launchUrl, category, metadataUrl, metadataXml, entityId, acsUrls, redirectUris].some(
    (v) => v !== '',
  );
  const setsForProtocol = (claimSets?.sets ?? []).filter((set) => set.protocol === protocol);

  function body() {
    const claimChoice =
      claims === 'standard' || claims === 'none' ? { kind: claims } : { kind: 'set', setId: claims };
    return {
      name,
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      ...(description ? { description } : {}),
      // Omitted when blank rather than sent as ''. The column is nullable and
      // an empty string would be a category whose heading is nothing.
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(launchUrl.trim() ? { launchUrl: launchUrl.trim() } : {}),
      protocol,
      ...(protocol === 'saml'
        ? {
            saml: {
              ...(samlSource === 'metadataUrl' ? { metadataUrl: metadataUrl.trim() } : {}),
              ...(samlSource === 'metadataXml' ? { metadataXml } : {}),
              ...(samlSource === 'manual'
                ? {
                    ...(entityId.trim() ? { spEntityId: entityId.trim() } : {}),
                    acsUrls: lines(acsUrls),
                    nameIdFormat,
                    spCertificates: certificatesOf(certificate),
                  }
                : {}),
              wantAuthnRequestsSigned: signedRequests,
            },
          }
        : {}),
      ...(protocol === 'oidc'
        ? { oidc: { redirectUris: lines(redirectUris), scopes: scopes.split(/\s+/).filter(Boolean) } }
        : {}),
      ...(protocol === 'bookmark' ? {} : { claims: claimChoice }),
    };
  }

  async function save() {
    setErrors({});
    setProblem(null);
    if (launchUrl.trim() && !isLaunchableUrl(launchUrl.trim())) {
      setErrors({ launchUrl: 'Must be an http or https URL' });
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ applicationId: string; clientId?: string; clientSecret?: string }>(
        '/api/admin/applications/setup',
        { method: 'POST', body: JSON.stringify(body()) },
      );
      if (created.clientId && created.clientSecret) {
        setSecret({ id: created.applicationId, clientId: created.clientId, clientSecret: created.clientSecret });
        return;
      }
      toast({ tone: 'success', title: `${name} added` });
      onCreated();
    } catch (cause) {
      const marked = formFieldErrors(cause);
      if (Object.keys(marked).length > 0) setErrors(marked);
      else setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : `${name || 'Application'} was not saved.`);
    } finally {
      setBusy(false);
    }
  }

  if (secret) {
    return (
      <Panel title={`${name} is registered`}>
        <div className="space-y-4 p-4">
          <Alert tone="warning">Shown once — copy it now.</Alert>
          <dl>
            <dt className="mb-1.5 font-medium text-ink">Client ID</dt>
            <dd>
              <Identifier value={secret.clientId} />
            </dd>
          </dl>
          <Field label="Client secret" value={secret.clientSecret} onChange={() => undefined} readOnly className="max-w-xl" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                toast({ tone: 'success', title: `${name} added` });
                onCreated();
              }}
            >
              Done
            </Button>
            <Link to={`/admin/applications/${secret.id}`} className="self-center text-sm underline-offset-2 hover:underline">
              Open {name}
            </Link>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="New application">
      <form
        noValidate
        className="space-y-6 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ErrorSummary
          errors={summaryErrors(errors, LABELS, problem)}
          {...(Object.keys(errors).length === 0 ? { title: 'Not saved' } : {})}
        />

        <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
          <Field name="name" label="Name" value={name} onChange={setName} required error={errors.name} />
          <Field
            name="slug"
            label="Slug"
            value={slug}
            onChange={setSlug}
            placeholder="From the name"
            warning={slug ? 'Used in URLs; cannot be changed later' : undefined}
            error={errors.slug}
          />
          <Select
            name="protocol"
            label="Sign-in"
            value={protocol}
            onChange={(v) => setProtocol(v as Protocol)}
            options={[
              { value: 'bookmark', label: 'Link only' },
              { value: 'saml', label: 'SAML' },
              { value: 'oidc', label: 'OpenID Connect' },
            ]}
          />
          <Field
            name="launchUrl"
            label="Launch URL"
            value={launchUrl}
            onChange={setLaunchUrl}
            required={protocol !== 'saml'}
            placeholder={protocol === 'saml' ? 'The SSO start page, if it has one' : 'https://'}
            error={errors.launchUrl}
          />
          <Field name="category" label="Category" value={category} onChange={setCategory} error={errors.category} />
          <Field
            name="description"
            label="Description"
            value={description}
            onChange={setDescription}
            error={errors.description}
          />
        </div>

        {protocol === 'saml' && (
          <fieldset className="max-w-4xl space-y-4">
            <legend className="mb-2 font-medium text-ink">Service provider</legend>
            <Select
              name="samlSource"
              label="Settings from"
              value={samlSource}
              onChange={(v) => setSamlSource(v as SamlSource)}
              options={[
                { value: 'metadataUrl', label: 'Metadata URL' },
                { value: 'metadataXml', label: 'Pasted metadata' },
                { value: 'manual', label: 'Typed in' },
              ]}
            />
            {samlSource === 'metadataUrl' && (
              <Field
                name="saml.metadataUrl"
                label="Metadata URL"
                value={metadataUrl}
                onChange={setMetadataUrl}
                placeholder="https://app.example.com/saml/metadata"
                error={errors['saml.metadataUrl']}
              />
            )}
            {samlSource === 'metadataXml' && (
              <Textarea
                name="saml.metadataXml"
                label="Metadata"
                mono
                rows={8}
                value={metadataXml}
                onChange={setMetadataXml}
                error={errors['saml.metadataXml']}
              />
            )}
            {samlSource === 'manual' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="saml.spEntityId"
                  label="Entity ID"
                  value={entityId}
                  onChange={setEntityId}
                  error={errors['saml.spEntityId']}
                />
                <Select
                  name="saml.nameIdFormat"
                  label="Name ID format"
                  value={nameIdFormat}
                  onChange={setNameIdFormat}
                  options={NAME_ID_FORMATS}
                />
                <Textarea
                  name="saml.acsUrls"
                  label="ACS URLs, one per line"
                  mono
                  rows={3}
                  value={acsUrls}
                  onChange={setAcsUrls}
                  error={errors['saml.acsUrls']}
                />
                <Textarea
                  name="saml.spCertificates"
                  label="Signing certificate"
                  mono
                  rows={3}
                  value={certificate}
                  onChange={setCertificate}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  error={errors['saml.spCertificates']}
                />
              </div>
            )}
            <Check
              name="saml.wantAuthnRequestsSigned"
              label="Require signed requests"
              checked={signedRequests}
              onChange={setSignedRequests}
              warning={
                signedRequests ? undefined : 'Anyone can start a sign-in to this application.'
              }
            />
            {errors['saml.wantAuthnRequestsSigned'] && (
              <Alert tone="warning">{errors['saml.wantAuthnRequestsSigned']}</Alert>
            )}
          </fieldset>
        )}

        {protocol === 'oidc' && (
          <fieldset className="grid max-w-4xl gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-medium text-ink">Client</legend>
            <Textarea
              name="oidc.redirectUris"
              label="Redirect URIs, one per line"
              mono
              rows={3}
              value={redirectUris}
              onChange={setRedirectUris}
              error={errors['oidc.redirectUris']}
            />
            <Field name="oidc.scopes" label="Scopes" value={scopes} onChange={setScopes} />
          </fieldset>
        )}

        {protocol !== 'bookmark' && (
          <div className="max-w-md">
            <Select
              name="claims"
              label="Claims"
              value={claims}
              onChange={setClaims}
              options={[
                {
                  value: 'standard',
                  label: protocol === 'saml' ? 'Email, names and groups' : 'Groups (email and name come from scopes)',
                },
                ...setsForProtocol.map((set) => ({ value: set.id, label: `Claim set: ${set.name}` })),
                { value: 'none', label: 'None' },
              ]}
              error={errors.claims}
            />
          </div>
        )}

        <FormActions status={dirty ? <span className="text-muted">Unsaved changes</span> : null}>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save application
          </Button>
        </FormActions>
      </form>
    </Panel>
  );
}
