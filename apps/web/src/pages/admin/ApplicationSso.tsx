import { useState } from 'react';
import { Alert, Button, Check, Field, Panel, Select, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { ApplicationClaims } from './ApplicationClaims.js';

/**
 * The single-sign-on configuration for one application.
 *
 * **This screen did not exist, and its absence made a whole feature
 * unreachable.** `PUT /applications/:id/saml`, `PUT /applications/:id/oidc`
 * and `POST /applications/:id/saml/import` have been in the API all along and
 * nothing in the console ever called them — so a SAML application could be
 * registered only by hand against the API, and one created from the catalog
 * could never be finished: the catalog deliberately leaves `spCertificates`
 * empty, because it knows a vendor's URLs and cannot know one installation's
 * signing certificate, and there was nowhere to paste it.
 *
 * Metadata import is offered FIRST, above the fields. Where a service provider
 * publishes its own metadata that import is exact, carries the certificates,
 * and cannot go stale — the fields below are for the majority that publish
 * none.
 */

interface SamlConfig {
  spEntityId: string;
  acsUrls: string[];
  defaultAcsUrl: string | null;
  nameIdFormat: string;
  nameIdClaim: string | null;
  spCertificates: string[];
  wantAuthnRequestsSigned: boolean;
  encryptAssertions: boolean;
  encryptionCertificate: string | null;
  sloUrl: string | null;
  sloBinding: string;
  allowIdpInitiated: boolean;
  wsFedEnabled: boolean;
  assertionLifetimeMs: number;
}

interface OidcClient {
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  clientCredentialsEnabled: boolean;
  scopes: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

const NAME_ID_FORMATS = [
  {
    value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    label: 'Email address',
  },
  {
    value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    label: 'Persistent identifier',
  },
  {
    value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
    label: 'Transient identifier',
  },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'Unspecified' },
];

/** One value per line, which is how somebody pastes a list of URLs. */
const linesOf = (values: string[]) => values.join('\n');
const toLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function ApplicationSso({ applicationId }: { applicationId: string }) {
  const saml = useApiResource<SamlConfig>(
    `/api/admin/applications/${applicationId}/saml`,
  );
  const oidc = useApiResource<OidcClient>(
    `/api/admin/applications/${applicationId}/oidc`,
  );

  // A 404 from either is the ordinary "this application does not use that
  // protocol", not a fault. `useApiResource` turns it into a sentence about a
  // record that no longer exists, which is the wrong sentence here.
  //
  // Checked on a REQUIRED FIELD rather than on `data !== null`. A response
  // that is not the shape this panel expects — anything at all other than a
  // config — would otherwise be read as one and render a form over undefined
  // arrays, taking the whole page down with it. The panel is mounted on a page
  // whose main job is something else; it must not be able to break it.
  const hasSaml = typeof saml.data?.spEntityId === 'string';
  const hasOidc = typeof oidc.data?.clientId === 'string';

  if (saml.loading || oidc.loading) return null;

  if (!hasSaml && !hasOidc) {
    return (
      <Panel title="Single sign-on">
        <div className="p-4 text-muted">
          This application has no SAML or OpenID Connect configuration. Add one
          from the catalog, or register it against the API.
        </div>
      </Panel>
    );
  }

  return (
    <>
      {hasSaml && (
        <SamlPanel
          applicationId={applicationId}
          config={saml.data!}
          onSaved={() => saml.reload()}
        />
      )}
      {hasOidc && (
        <OidcPanel
          applicationId={applicationId}
          client={oidc.data!}
          onSaved={() => oidc.reload()}
        />
      )}
      {/*
        Rendered here rather than by the page, because this component already
        knows which protocols the application actually uses — and the claims
        form has to offer only those. A second fetch to answer a question
        already answered is how two panels come to disagree.
      */}
      <ApplicationClaims
        applicationId={applicationId}
        protocols={[
          ...(hasSaml ? (['saml'] as const) : []),
          ...(hasOidc ? (['oidc'] as const) : []),
        ]}
      />
    </>
  );
}

function SamlPanel({
  applicationId,
  config,
  onSaved,
}: {
  applicationId: string;
  config: SamlConfig;
  onSaved(): void;
}) {
  const [form, setForm] = useState({
    spEntityId: config.spEntityId,
    acsUrls: linesOf(config.acsUrls),
    nameIdFormat: config.nameIdFormat,
    spCertificates: linesOf(config.spCertificates),
    wantAuthnRequestsSigned: config.wantAuthnRequestsSigned,
    allowIdpInitiated: config.allowIdpInitiated,
    wsFedEnabled: config.wsFedEnabled,
    sloUrl: config.sloUrl ?? '',
  });
  const [metadata, setMetadata] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const describe = (cause: unknown) =>
    cause instanceof ApiError
      ? (cause.problem.detail ?? cause.problem.title)
      : 'That could not be saved.';

  async function save() {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const acsUrls = toLines(form.acsUrls);
      await api(`/api/admin/applications/${applicationId}/saml`, {
        method: 'PUT',
        // THE WHOLE RECORD, not the fields this form shows.
        //
        // `upsertSamlConfig` writes every column explicitly and the request
        // schema fills in a default for anything absent — so a body carrying
        // only the six fields below would silently switch off assertion
        // encryption, drop the encryption certificate, reset the NameID claim,
        // reset the SLO binding and reset the assertion lifetime, on every
        // save, for an application configured through the API. The service's
        // own docstring says so: "omitting the field on an update also resets
        // it to the default."
        //
        // So the loaded config is the base and this form overrides its part
        // of it. A field this panel does not offer is carried through
        // untouched rather than quietly reverted.
        body: JSON.stringify({
          // The carried-through fields, NAMED rather than spread from the
          // loaded record. The GET returns the whole row — `id`,
          // `applicationId`, timestamps — and spreading it would send those
          // too. They are stripped today only because the request schema is
          // not `.strict()`, which is a property of the contract this form
          // should not be relying on.
          nameIdClaim: config.nameIdClaim,
          encryptAssertions: config.encryptAssertions,
          encryptionCertificate: config.encryptionCertificate,
          sloBinding: config.sloBinding,
          assertionLifetimeMs: config.assertionLifetimeMs,
          spEntityId: form.spEntityId.trim(),
          acsUrls,
          // The administrator's chosen default is kept while it is still one
          // of the registered URLs; otherwise the first, which is what
          // somebody who registered one URL means. Sending `acsUrls[0]`
          // unconditionally would overwrite a deliberate choice with a
          // position.
          defaultAcsUrl:
            config.defaultAcsUrl !== null && acsUrls.includes(config.defaultAcsUrl)
              ? config.defaultAcsUrl
              : (acsUrls[0] ?? null),
          nameIdFormat: form.nameIdFormat,
          spCertificates: certificatesOf(form.spCertificates),
          wantAuthnRequestsSigned: form.wantAuthnRequestsSigned,
          allowIdpInitiated: form.allowIdpInitiated,
          wsFedEnabled: form.wsFedEnabled,
          sloUrl: form.sloUrl.trim() === '' ? null : form.sloUrl.trim(),
        }),
      });
      setNote('Saved.');
      onSaved();
    } catch (cause) {
      setProblem(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importMetadata() {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const trimmed = metadata.trim();
      await api(`/api/admin/applications/${applicationId}/saml/import`, {
        method: 'POST',
        // A URL or the document itself. Both are ordinary — some vendors
        // publish a metadata URL and some hand you a file.
        body: JSON.stringify(
          trimmed.startsWith('http') ? { url: trimmed } : { xml: trimmed },
        ),
      });
      setMetadata('');
      setNote('Imported. The fields below now describe what the metadata said.');
      onSaved();
    } catch (cause) {
      setProblem(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="SAML"
      description="Where assertions go, and what the service provider is trusted to send."
    >
      <div className="space-y-5 p-4">
        {/*
          Import first. Where a service provider publishes metadata this is
          exact, carries the certificates, and cannot go stale — the fields
          below are for the majority that publish none.
        */}
        <div className="rounded-panel border border-border-control p-3">
          <span className="font-medium text-ink">Import the service provider’s metadata</span>
          <p className="mt-0.5 text-sm text-muted">
            A metadata URL, or paste the XML. This fills in everything below,
            certificates included.
          </p>
          <textarea
            aria-label="Service provider metadata"
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
            rows={3}
            spellCheck={false}
            className="mt-2 w-full rounded-control border border-border-control bg-bg p-2 font-mono text-sm text-ink"
          />
          <div className="mt-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={metadata.trim() === ''}
              onClick={importMetadata}
            >
              Import
            </Button>
          </div>
        </div>

        <Field
          label="Service provider entity ID"
          value={form.spEntityId}
          onChange={(v) => set('spEntityId', v)}
          required
        />

        <div>
          <label className="mb-1.5 block font-medium text-ink" htmlFor="acs-urls">
            Assertion consumer URLs
          </label>
          <textarea
            id="acs-urls"
            value={form.acsUrls}
            onChange={(event) => set('acsUrls', event.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full rounded-control border border-border-control bg-bg p-2 font-mono text-sm text-ink"
          />
          {/* Matched byte for byte at sign-in — this is an allowlist, not a
              pattern, and saying so is the difference between a working
              integration and an hour of guessing. */}
          <p className="mt-1 text-sm text-muted">
            One per line. Matched exactly; there is no wildcard.
          </p>
        </div>

        <Select
          label="Name ID format"
          value={form.nameIdFormat}
          onChange={(v) => set('nameIdFormat', v)}
          options={NAME_ID_FORMATS}
        />

        <div>
          <label className="mb-1.5 block font-medium text-ink" htmlFor="sp-certs">
            Signing certificates
          </label>
          <textarea
            id="sp-certs"
            value={form.spCertificates}
            onChange={(event) => set('spCertificates', event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder="-----BEGIN CERTIFICATE-----"
            className="w-full rounded-control border border-border-control bg-bg p-2 font-mono text-sm text-ink"
          />
        </div>

        <Check
          checked={form.wantAuthnRequestsSigned}
          onChange={(v) => set('wantAuthnRequestsSigned', v)}
          label="Require the service provider to sign its requests"
          hint="Off, anybody who can send a link can make Syntra issue an assertion for whoever clicks it."
        />

        <Check
          checked={form.allowIdpInitiated}
          onChange={(v) => set('allowIdpInitiated', v)}
          label="Allow sign-in started from Syntra"
          hint="Off, a sign-in must begin at the application. On, a tile in the portal can start one."
        />

        <Check
          checked={form.wsFedEnabled}
          onChange={(v) => set('wsFedEnabled', v)}
          label="Also accept WS-Federation"
          hint="For applications built on .NET that cannot speak SAML directly. They use the same entity ID as the realm and the same reply URLs."
        />
        {form.wsFedEnabled && (
          <Alert>
            <p>
              Point the application at{' '}
              <code>{`${window.location.origin}/saml/wsfed`}</code> with{' '}
              <code>wtrealm={form.spEntityId || 'your entity ID'}</code>.
            </p>
          </Alert>
        )}

        <Field
          label="Single logout URL"
          value={form.sloUrl}
          onChange={(v) => set('sloUrl', v)}
          hint="Optional. Where Syntra tells the application somebody signed out."
        />

        {problem && <Alert tone="danger">{problem}</Alert>}
        {note && <Alert tone="success">{note}</Alert>}

        <Button variant="primary" loading={busy} onClick={save}>
          Save SAML settings
        </Button>
      </div>
    </Panel>
  );
}

/**
 * Splits a pasted blob into whole PEM certificates.
 *
 * Somebody pastes one certificate, or several one after another. Splitting on
 * newlines — which is right for a list of URLs — would send sixteen lines of
 * base64 as sixteen certificates, every one of which fails the contract's PEM
 * check with a message about the wrong thing.
 */
function certificatesOf(blob: string): string[] {
  const trimmed = blob.trim();
  if (trimmed === '') return [];
  return trimmed
    .split(/(?=-----BEGIN CERTIFICATE-----)/g)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function OidcPanel({
  applicationId,
  client,
  onSaved,
}: {
  applicationId: string;
  client: OidcClient;
  onSaved(): void;
}) {
  const [form, setForm] = useState({
    redirectUris: linesOf(client.redirectUris),
    postLogoutRedirectUris: linesOf(client.postLogoutRedirectUris),
    scopes: client.scopes.join(' '),
    clientCredentialsEnabled: client.clientCredentialsEnabled,
    rotateSecret: false,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    setBusy(true);
    setProblem(null);
    setSecret(null);
    try {
      const result = await api<{ clientSecret?: string }>(
        `/api/admin/applications/${applicationId}/oidc`,
        {
          method: 'PUT',
          // The whole record, for the reason the SAML save spells out:
          // `upsertOidcClient` spreads every field onto the update and the
          // request schema defaults anything absent. A body carrying only what
          // this form shows would reset `accessTokenTtlSeconds` to an hour and
          // `refreshTokenTtlSeconds` to fourteen days — including on a client
          // deliberately set to `0`, which the contract documents as "issued no
          // refresh tokens at all". Saving a redirect URI must not hand a
          // client refresh tokens somebody had taken away.
          body: JSON.stringify({
            // Named, not spread, for the reason the SAML save gives.
            accessTokenTtlSeconds: client.accessTokenTtlSeconds,
            refreshTokenTtlSeconds: client.refreshTokenTtlSeconds,
            clientId: client.clientId,
            redirectUris: toLines(form.redirectUris),
            postLogoutRedirectUris: toLines(form.postLogoutRedirectUris),
            // Machine clients take no grants and no redirect URIs; the
            // contract refuses `authorization_code` without one, so a client
            // switched to machine-only sends an empty list.
            grantTypes: form.clientCredentialsEnabled
              ? []
              : ['authorization_code', 'refresh_token'],
            clientCredentialsEnabled: form.clientCredentialsEnabled,
            scopes: form.scopes.split(/\s+/).filter((s) => s !== ''),
            rotateSecret: form.rotateSecret,
          }),
        },
      );
      if (result.clientSecret) setSecret(result.clientSecret);
      set('rotateSecret', false);
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
    <Panel title="OpenID Connect" description={`Client ID: ${client.clientId}`}>
      <div className="space-y-5 p-4">
        {secret && (
          <Alert tone="warning" title="New client secret">
            <code className="mt-1 block break-all font-mono text-sm">{secret}</code>
            Paste it into the application now. It is not shown again.
          </Alert>
        )}

        <Check
          checked={form.clientCredentialsEnabled}
          onChange={(v) => set('clientCredentialsEnabled', v)}
          label="This is a machine, not a person"
          // The reason this control exists at all: the grant was implemented,
          // enforced at the token endpoint and advertised by the provider, and
          // could be turned on only with SQL.
          hint="Issues tokens to the application itself with no user behind them. Such a token may not carry openid, profile, email or offline_access."
        />

        {!form.clientCredentialsEnabled && (
          <div>
            <label className="mb-1.5 block font-medium text-ink" htmlFor="redirect-uris">
              Redirect URIs
            </label>
            <textarea
              id="redirect-uris"
              value={form.redirectUris}
              onChange={(event) => set('redirectUris', event.target.value)}
              rows={3}
              spellCheck={false}
              className="w-full rounded-control border border-border-control bg-bg p-2 font-mono text-sm text-ink"
            />
            <p className="mt-1 text-sm text-muted">
              One per line. Matched exactly; there is no wildcard.
            </p>
          </div>
        )}

        <Field
          label="Scopes"
          value={form.scopes}
          onChange={(v) => set('scopes', v)}
          hint="Separated by spaces."
        />

        <Check
          checked={form.rotateSecret}
          onChange={(v) => set('rotateSecret', v)}
          label="Issue a new client secret"
          hint="The old one stops working as soon as this is saved."
        />

        {problem && <Alert tone="danger">{problem}</Alert>}

        <div className="flex items-center gap-3">
          <Button variant="primary" loading={busy} onClick={save}>
            Save OpenID Connect settings
          </Button>
          {client.clientCredentialsEnabled && (
            <Status tone="neutral">Machine client</Status>
          )}
        </div>
      </div>
    </Panel>
  );
}
