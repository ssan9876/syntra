import { useEffect, useState } from 'react';
import { Alert, Button, ErrorSummary, Field, FormActions, Panel, Select, SkeletonRows, Textarea, useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';

interface Draft {
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  launchUrl?: string;
  variables: { key: string; label: string; example: string }[];
  saml?: { spEntityId: string; acsUrls: string[]; sloUrl?: string; [key: string]: unknown };
  oidc?: { redirectUris: string[]; postLogoutRedirectUris?: string[]; [key: string]: unknown };
}

const CATEGORIES = ['collaboration', 'productivity', 'engineering', 'itsm', 'security', 'other'].map((value) => ({
  value,
  label: value === 'itsm' ? 'IT service management' : value[0]!.toUpperCase() + value.slice(1),
}));

const VARIABLE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

const LABELS: Record<string, string> = {
  name: 'Name',
  docsUrl: 'Documentation URL',
  launchUrl: 'Launch URL',
  'saml.spEntityId': 'Entity ID',
  'saml.acsUrls': 'ACS URLs',
  'oidc.redirectUris': 'Redirect URIs',
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The `{{name}}` placeholders used across the editable values, in order. */
export function variablesIn(values: string[]): string[] {
  const found: string[] = [];
  for (const value of values) {
    for (const match of value.matchAll(VARIABLE)) {
      if (!found.includes(match[1]!)) found.push(match[1]!);
    }
  }
  return found;
}

/**
 * "Save as catalog entry": this application's settings as a template for
 * the next one. `{{name}}` in a value becomes a field to fill in.
 */
export function SaveAsCatalogEntry({ applicationId, onDone }: { applicationId: string; onDone(): void }) {
  const toast = useToast();
  const { data, error } = useApiResource<Draft>(`/api/admin/applications/${applicationId}/catalog-draft`);

  const [name, setName] = useState('');
  const [category, setCategory] = useState('other');
  const [description, setDescription] = useState('');
  const [docsUrl, setDocsUrl] = useState('');
  const [launchUrl, setLaunchUrl] = useState('');
  const [entityId, setEntityId] = useState('');
  const [acsUrls, setAcsUrls] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [variables, setVariables] = useState<Record<string, { label: string; example: string }>>({});

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setDescription(data.description);
    setLaunchUrl(data.launchUrl ?? '');
    setEntityId(data.saml?.spEntityId ?? '');
    setAcsUrls((data.saml?.acsUrls ?? []).join('\n'));
    setRedirectUris((data.oidc?.redirectUris ?? []).join('\n'));
  }, [data]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) {
    return (
      <Panel title="Save as catalog entry">
        <SkeletonRows rows={3} cols={2} />
      </Panel>
    );
  }

  const used = variablesIn([launchUrl, entityId, acsUrls, redirectUris]);

  async function save() {
    if (!data) return;
    setErrors({});
    setProblem(null);
    setBusy(true);
    try {
      await api('/api/admin/catalog/templates', {
        method: 'POST',
        body: JSON.stringify({
          name,
          category,
          description,
          ...(docsUrl.trim() ? { docsUrl: docsUrl.trim() } : {}),
          ...(launchUrl.trim() ? { launchUrl: launchUrl.trim() } : {}),
          variables: used.map((key) => ({
            key,
            label: variables[key]?.label ?? '',
            example: variables[key]?.example ?? '',
          })),
          ...(data.saml ? { saml: { ...data.saml, spEntityId: entityId.trim(), acsUrls: lines(acsUrls) } } : {}),
          ...(data.oidc ? { oidc: { ...data.oidc, redirectUris: lines(redirectUris) } } : {}),
        }),
      });
      toast({ tone: 'success', title: `${name} added to the catalog` });
      onDone();
    } catch (cause) {
      const marked = formFieldErrors(cause);
      if (Object.keys(marked).length > 0) setErrors(marked);
      else setProblem(cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : `${name} was not saved.`);
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (prefix: string) =>
    Object.entries(errors).find(([path]) => path === prefix || path.startsWith(`${prefix}.`))?.[1];

  return (
    <Panel title="Save as catalog entry">
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
        <p className="text-sm text-muted">Use {'{{name}}'} for a value that differs per instance.</p>
        <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
          <Field name="name" label="Name" value={name} onChange={setName} required error={errors.name} />
          <Select name="category" label="Category" value={category} onChange={setCategory} options={CATEGORIES} />
          <Field name="description" label="Description" value={description} onChange={setDescription} />
          <Field name="docsUrl" label="Documentation URL" value={docsUrl} onChange={setDocsUrl} error={errors.docsUrl} />
          <Field
            name="launchUrl"
            label="Launch URL"
            value={launchUrl}
            onChange={setLaunchUrl}
            placeholder="https://{{subdomain}}.example.com"
            error={errors.launchUrl}
          />
          {data.saml && (
            <>
              <Field
                name="saml.spEntityId"
                label="Entity ID"
                value={entityId}
                onChange={setEntityId}
                error={fieldError('saml.spEntityId')}
              />
              <Textarea
                name="saml.acsUrls"
                label="ACS URLs, one per line"
                mono
                rows={3}
                value={acsUrls}
                onChange={setAcsUrls}
                error={fieldError('saml.acsUrls')}
              />
            </>
          )}
          {data.oidc && (
            <Textarea
              name="oidc.redirectUris"
              label="Redirect URIs, one per line"
              mono
              rows={3}
              value={redirectUris}
              onChange={setRedirectUris}
              error={fieldError('oidc.redirectUris')}
            />
          )}
        </div>

        {used.length > 0 && (
          <fieldset className="max-w-4xl space-y-3">
            <legend className="mb-2 font-medium text-ink">Fields to fill in</legend>
            {used.map((key, index) => (
              <div key={key} className="grid items-end gap-3 sm:grid-cols-[8rem_1fr_1fr]">
                <code className="pb-2 text-sm">{`{{${key}}}`}</code>
                <Field
                  name={`variables.${index}.label`}
                  label="Label"
                  value={variables[key]?.label ?? ''}
                  onChange={(label) => setVariables((v) => ({ ...v, [key]: { example: v[key]?.example ?? '', label } }))}
                  error={errors[`variables.${index}.label`]}
                />
                <Field
                  name={`variables.${index}.example`}
                  label="Example"
                  value={variables[key]?.example ?? ''}
                  onChange={(example) => setVariables((v) => ({ ...v, [key]: { label: v[key]?.label ?? '', example } }))}
                  error={errors[`variables.${index}.example`]}
                />
              </div>
            ))}
          </fieldset>
        )}

        <FormActions>
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Save to catalog
          </Button>
        </FormActions>
      </form>
    </Panel>
  );
}
