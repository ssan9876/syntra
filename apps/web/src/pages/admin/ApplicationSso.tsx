import { useState } from 'react';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Identifier,
  Panel,
  Select,
  Status,
  Textarea,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { ApplicationClaims } from './ApplicationClaims.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';

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
  backchannelLogoutUri: string | null;
  backchannelLogoutSessionRequired: boolean;
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

export function ApplicationSso({
  applicationId,
  launchUrl,
  onApplicationSaved,
}: {
  applicationId: string;
  /**
   * The application's stored launch address. For a SAML application with
   * IdP-initiated sign-in off this is where the portal tile goes, so the SAML
   * panel shows and edits it beside that switch. Undefined while the
   * application itself has not been read.
   */
  launchUrl?: string | null | undefined;
  /** Re-read the application after its launch address is saved. */
  onApplicationSaved?: (() => void) | undefined;
}) {
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

  // Only the FIRST read hides the panels. `useApiResource` keeps the previous
  // data through a reload, and this used to answer every reload with `null` —
  // which unmounted the OpenID Connect panel between a save and its re-read,
  // and with it the rotated client secret the save had just put on screen
  // under "it is not shown again".
  const firstRead = (r: { loading: boolean; data: unknown; error: string | null }) =>
    r.loading && r.data === null && r.error === null;
  if (firstRead(saml) || firstRead(oidc)) return null;

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
          // Remounted from each read, so an import or a save shows what the
          // server now holds rather than what was typed before it.
          //
          // The launch address is in the key too: it arrives from a separate
          // read, and a form initialised before it landed would show an empty
          // address — and the warning that goes with one — for an application
          // that has one.
          key={`${saml.updatedAt?.getTime() ?? 0}|${launchUrl ?? ''}`}
          applicationId={applicationId}
          config={saml.data!}
          launchUrl={launchUrl ?? null}
          onSaved={() => {
            saml.reload();
            onApplicationSaved?.();
          }}
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

/** What each SAML control is called on screen, for the error summary. */
const SAML_LABELS: Record<string, string> = {
  spEntityId: 'Service provider entity ID',
  acsUrls: 'Assertion consumer URLs',
  defaultAcsUrl: 'Assertion consumer URLs',
  nameIdFormat: 'Name ID format',
  spCertificates: 'Signing certificates',
  sloUrl: 'Single logout URL',
  launchUrl: 'Launch address',
  url: 'Service provider metadata',
  xml: 'Service provider metadata',
};

const OIDC_LABELS: Record<string, string> = {
  redirectUris: 'Redirect URIs',
  postLogoutRedirectUris: 'Redirect URIs',
  scopes: 'Scopes',
  backchannelLogoutUri: 'Back-channel logout endpoint',
};

/** A list box's contents, compared as the list the server would store. */
const sameLines = (a: string, b: string) =>
  JSON.stringify(toLines(a)) === JSON.stringify(toLines(b));

/**
 * The warning a list of exact-match URLs earns, and only while it applies.
 *
 * This used to be a permanent caption — "One per line. Matched exactly; there
 * is no wildcard." — under both URL boxes. The first half is now the label.
 * The second half is only news to somebody who has just typed a `*`, which is
 * exactly when it is shown.
 */
const wildcardWarning = (value: string) =>
  value.includes('*')
    ? 'Matched exactly: a * is taken literally, not as a wildcard.'
    : undefined;

function SamlPanel({
  applicationId,
  config,
  launchUrl,
  onSaved,
}: {
  applicationId: string;
  config: SamlConfig;
  launchUrl: string | null;
  onSaved(): void;
}) {
  const toast = useToast();
  const initial = {
    spEntityId: config.spEntityId,
    acsUrls: linesOf(config.acsUrls),
    nameIdFormat: config.nameIdFormat,
    spCertificates: linesOf(config.spCertificates),
    wantAuthnRequestsSigned: config.wantAuthnRequestsSigned,
    allowIdpInitiated: config.allowIdpInitiated,
    wsFedEnabled: config.wsFedEnabled,
    sloUrl: config.sloUrl ?? '',
    launchUrl: launchUrl ?? '',
  };
  const [form, setForm] = useState(initial);
  const [metadata, setMetadata] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  // Compared as what would be SAVED, so a trailing newline or a re-pasted
  // identical certificate does not claim the form has changed.
  const dirty =
    form.spEntityId.trim() !== initial.spEntityId ||
    !sameLines(form.acsUrls, initial.acsUrls) ||
    form.nameIdFormat !== initial.nameIdFormat ||
    JSON.stringify(certificatesOf(form.spCertificates)) !==
      JSON.stringify(certificatesOf(initial.spCertificates)) ||
    form.wantAuthnRequestsSigned !== initial.wantAuthnRequestsSigned ||
    form.allowIdpInitiated !== initial.allowIdpInitiated ||
    form.wsFedEnabled !== initial.wsFedEnabled ||
    form.sloUrl.trim() !== initial.sloUrl ||
    form.launchUrl.trim() !== initial.launchUrl;

  /** A refusal, split into what belongs against a field and what does not. */
  const refuse = (cause: unknown) => {
    const marked = formFieldErrors(cause);
    setErrors(marked);
    setProblem(
      Object.keys(marked).length > 0
        ? null
        : cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
    );
  };

  async function save() {
    setBusy(true);
    setProblem(null);
    setErrors({});
    try {
      // Checked before anything is written, so a refused address does not
      // leave the SAML half saved and this half not. The API has no way to
      // REMOVE a launch address (it takes a URL or nothing), so emptying the
      // box is refused here by name rather than saved as "no change" — which
      // would read as having cleared it.
      const nextLaunchUrl = form.launchUrl.trim();
      if (nextLaunchUrl !== initial.launchUrl && nextLaunchUrl === '') {
        setErrors({
          launchUrl:
            "A launch address can be changed but not removed. Enter the application's SSO start page.",
        });
        return;
      }
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
      // The launch address lives on the APPLICATION, not its SAML record, so
      // it is its own write — and only when it changed, so saving a
      // certificate does not also rewrite an address nobody touched.
      if (nextLaunchUrl !== initial.launchUrl) {
        await api(`/api/admin/applications/${applicationId}`, {
          method: 'PUT',
          body: JSON.stringify({ launchUrl: nextLaunchUrl }),
        });
      }
      // A toast rather than the inline "Saved." this used to set: the panel
      // is re-read after a save and remounted from what the server stored,
      // which took the inline note with it.
      toast({ tone: 'success', title: 'SAML settings saved' });
      onSaved();
    } catch (cause) {
      refuse(cause);
    } finally {
      setBusy(false);
    }
  }

  async function importMetadata() {
    setBusy(true);
    setProblem(null);
    setErrors({});
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
      toast({
        tone: 'success',
        title: 'Metadata imported',
        body: 'The fields now show what the metadata said.',
      });
      onSaved();
    } catch (cause) {
      refuse(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
      A form, so Enter saves and the error summary can reach every control by
      name. Four stages, essentials first: where the settings can come from
      wholesale, then who the service provider is, then how its requests are
      trusted, then the optional ways in and out.

      The form wraps the panel rather than sitting inside it so the save bar
      can be sticky: `Panel` clips its overflow, and a sticky element inside a
      clipping box sticks to the box, not to the screen.
    */
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Panel title="SAML">
        <div className="space-y-6 p-4">
          <ErrorSummary
            errors={summaryErrors(errors, SAML_LABELS, problem)}
            {...(Object.keys(errors).length === 0 ? { title: 'Not saved' } : {})}
          />

          {/*
            Import first. Where a service provider publishes metadata this is
            exact, carries the certificates, and cannot go stale — the fields
            below are for the majority that publish none.
          */}
          <FormSection title="Import from metadata" number={1}>
            <div className="space-y-2 sm:col-span-2">
              <Textarea
                name="metadata"
                label="Service provider metadata"
                value={metadata}
                onChange={setMetadata}
                rows={3}
                mono
                spellCheck={false}
                placeholder="https://sp.example.com/saml/metadata, or paste the XML"
                error={errors.url ?? errors.xml}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={busy}
                disabled={metadata.trim() === ''}
                onClick={importMetadata}
              >
                Import
              </Button>
            </div>
          </FormSection>

          <FormSection title="Service provider" number={2}>
            <Field
              name="spEntityId"
              label="Service provider entity ID"
              value={form.spEntityId}
              onChange={(v) => set('spEntityId', v)}
              required
              error={errors.spEntityId}
            />
            <Select
              name="nameIdFormat"
              label="Name ID format"
              value={form.nameIdFormat}
              onChange={(v) => set('nameIdFormat', v)}
              options={NAME_ID_FORMATS}
              error={errors.nameIdFormat}
            />
            <Textarea
              name="acsUrls"
              label="Assertion consumer URLs, one per line"
              value={form.acsUrls}
              onChange={(v) => set('acsUrls', v)}
              rows={3}
              mono
              spellCheck={false}
              className="sm:col-span-2"
              warning={wildcardWarning(form.acsUrls)}
              error={errors.acsUrls ?? errors.defaultAcsUrl}
            />
          </FormSection>

          <FormSection title="Request signing" number={3}>
            <Textarea
              name="spCertificates"
              label="Signing certificates"
              value={form.spCertificates}
              onChange={(v) => set('spCertificates', v)}
              rows={6}
              mono
              spellCheck={false}
              placeholder="-----BEGIN CERTIFICATE-----"
              className="sm:col-span-2"
              error={errors.spCertificates}
            />
            <Check
              className="sm:col-span-2"
              checked={form.wantAuthnRequestsSigned}
              onChange={(v) => set('wantAuthnRequestsSigned', v)}
              label="Require the service provider to sign its requests"
            />
          </FormSection>

          <FormSection title="Sign-in and logout" number={4}>
            <Check
              checked={form.allowIdpInitiated}
              onChange={(v) => set('allowIdpInitiated', v)}
              label="Allow sign-in started from Syntra"
            />
            <Check
              checked={form.wsFedEnabled}
              onChange={(v) => set('wsFedEnabled', v)}
              label="Also accept WS-Federation"
            />
            {form.wsFedEnabled && (
              <div className="sm:col-span-2">
                <Alert>
                  <p>
                    Point the application at{' '}
                    <code>{`${window.location.origin}/saml/wsfed`}</code> with{' '}
                    <code>wtrealm={form.spEntityId || 'your entity ID'}</code>.
                  </p>
                </Alert>
              </div>
            )}
            <Field
              name="sloUrl"
              label="Single logout URL"
              value={form.sloUrl}
              onChange={(v) => set('sloUrl', v)}
              error={errors.sloUrl}
            />
            {/*
              Next to the IdP-initiated switch because that switch decides
              what this address is for. With it ON, the portal tile starts the
              sign-in at Syntra and this address is not used for SAML. With it
              OFF — the default, and what the catalog creates — the tile opens
              THIS address and relies on the application to send an
              AuthnRequest back, so it has to be the application's SSO start
              page, not a home page with a password form on it. Left empty,
              the tile cannot open the application at all and the user is told
              to ask an administrator; the warning says so before they do.
            */}
            <Field
              name="launchUrl"
              label="Launch address (the application's SSO start page)"
              value={form.launchUrl}
              onChange={(v) => set('launchUrl', v)}
              className="sm:col-span-2"
              error={errors.launchUrl}
              warning={
                form.allowIdpInitiated
                  ? undefined
                  : form.launchUrl.trim() === ''
                    ? 'Sign-in started from Syntra is off, so the portal tile opens this address — and it is empty, so the tile cannot open this application. Enter the page that starts single sign-on at the application, or allow sign-in started from Syntra.'
                    : "Sign-in started from Syntra is off, so the portal tile opens this address. It should be the application's SSO start page, which sends the user back here to sign in."
              }
            />
          </FormSection>

        </div>
      </Panel>

      {/* Sticky: this form runs past a screen, and the certificate box is
          usually the last thing changed and the furthest from the top. */}
      <FormActions
        sticky
        status={dirty ? <span className="text-muted">Unsaved changes</span> : null}
      >
        <Button type="submit" variant="primary" loading={busy}>
          Save SAML settings
        </Button>
      </FormActions>
    </form>
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
  const toast = useToast();
  const [form, setForm] = useState({
    redirectUris: linesOf(client.redirectUris),
    postLogoutRedirectUris: linesOf(client.postLogoutRedirectUris),
    backchannelLogoutUri: client.backchannelLogoutUri ?? '',
    scopes: client.scopes.join(' '),
    clientCredentialsEnabled: client.clientCredentialsEnabled,
    rotateSecret: false,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  // Against the client as last READ, which is re-read after every save — so
  // this clears itself once the server has what is on screen. Ticking
  // "Issue a new client secret" is a change too: it is the one that breaks
  // the application if it is saved by accident.
  const dirty =
    !sameLines(form.redirectUris, linesOf(client.redirectUris)) ||
    form.backchannelLogoutUri.trim() !== (client.backchannelLogoutUri ?? '') ||
    form.scopes.split(/\s+/).filter(Boolean).join(' ') !== client.scopes.join(' ') ||
    form.clientCredentialsEnabled !== client.clientCredentialsEnabled ||
    form.rotateSecret;

  async function save() {
    setBusy(true);
    setProblem(null);
    setErrors({});
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
            // Sent even when empty, for the reason named above: the contract
            // defaults an absent field, so omitting this would clear a
            // configured logout endpoint every time somebody saved a redirect
            // URI. Empty string means "not configured", which is null.
            backchannelLogoutUri:
              form.backchannelLogoutUri.trim() === ''
                ? null
                : form.backchannelLogoutUri.trim(),
            backchannelLogoutSessionRequired:
              client.backchannelLogoutSessionRequired ?? false,
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
      toast({ tone: 'success', title: 'OpenID Connect settings saved' });
      onSaved();
    } catch (cause) {
      const marked = formFieldErrors(cause);
      setErrors(marked);
      setProblem(
        Object.keys(marked).length > 0
          ? null
          : cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'That could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="OpenID Connect"
      actions={
        client.clientCredentialsEnabled ? <Status tone="neutral">Machine client</Status> : null
      }
    >
      <form
        noValidate
        className="space-y-6 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* The client ID rode in on the panel's `description`, which made a
            value the application needs look like a sentence about the panel.
            It is data: labelled, monospaced and copyable like every other
            identifier in this console. */}
        <dl>
          <dt className="text-sm font-medium text-muted">Client ID</dt>
          <dd className="mt-0.5">
            <Identifier value={client.clientId} />
          </dd>
        </dl>

        {/* Inline and persistent, never a toast: the secret exists in this
            response and nowhere else, and a toast that timed out would take
            it with it. */}
        {secret && (
          <Alert tone="warning" title="New client secret">
            <code className="mt-1 block break-all font-mono text-sm">{secret}</code>
            Paste it into the application now. It is not shown again.
          </Alert>
        )}

        <ErrorSummary
          errors={summaryErrors(errors, OIDC_LABELS, problem)}
          {...(Object.keys(errors).length === 0 ? { title: 'Not saved' } : {})}
        />

        <FormSection title="Client">
          <Check
            className="sm:col-span-2"
            checked={form.clientCredentialsEnabled}
            onChange={(v) => set('clientCredentialsEnabled', v)}
            label="This is a machine, not a person"
            // The reason this control exists at all: the grant was implemented,
            // enforced at the token endpoint and advertised by the provider, and
            // could be turned on only with SQL.
          />

          {!form.clientCredentialsEnabled && (
            <Textarea
              name="redirectUris"
              label="Redirect URIs, one per line"
              value={form.redirectUris}
              onChange={(v) => set('redirectUris', v)}
              rows={3}
              mono
              spellCheck={false}
              className="sm:col-span-2"
              warning={wildcardWarning(form.redirectUris)}
              error={errors.redirectUris}
            />
          )}

          <Field
            name="scopes"
            label="Scopes"
            value={form.scopes}
            onChange={(v) => set('scopes', v)}
            error={errors.scopes}
          />

          {!form.clientCredentialsEnabled && (
            <Field
              name="backchannelLogoutUri"
              label="Back-channel logout endpoint"
              value={form.backchannelLogoutUri}
              onChange={(v) => set('backchannelLogoutUri', v)}
              // No hint. `Field` dropped the prop on purpose -- eighty-nine of
              // them turned these forms into prose about themselves -- so what
              // the field IS lives in its label, and the placeholder shows the
              // shape. An empty box is a client that is not told, which is what
              // an empty box already looks like.
              placeholder="https://app.example/backchannel-logout"
              error={errors.backchannelLogoutUri}
            />
          )}
        </FormSection>

        <FormSection title="Client secret">
          <Check
            className="sm:col-span-2"
            checked={form.rotateSecret}
            onChange={(v) => set('rotateSecret', v)}
            label="Issue a new client secret"
            warning={
              // Only while the box is ticked. Off, nothing is about to break.
              form.rotateSecret
                ? 'The current secret stops working the moment this is saved.'
                : undefined
            }
          />
        </FormSection>

        <FormActions
          status={dirty ? <span className="text-muted">Unsaved changes</span> : null}
        >
          <Button type="submit" variant="primary" loading={busy}>
            Save OpenID Connect settings
          </Button>
        </FormActions>
      </form>
    </Panel>
  );
}
