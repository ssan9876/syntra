import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

interface Preview {
  matched: number;
  total: number;
  sample: { personId: string; displayName: string }[];
}

export function ProductEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined || id === 'new';
  const { data } = useApiResource<{ products: { id: string; name: string }[] }>(
    '/api/admin/automate/products',
  );

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [kind, setKind] = useState('application');
  const [workflowId, setWorkflowId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [audience, setAudience] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const parsedAudience = (): unknown | null => {
    if (audience.trim() === '') return null;
    return JSON.parse(audience) as unknown;
  };

  const runPreview = async () => {
    setProblem(null);
    try {
      setPreview(
        await api<Preview>('/api/admin/automate/products/audience-preview', {
          method: 'POST',
          body: JSON.stringify({
            audienceCondition: parsedAudience(),
            limit: 10,
          }),
        }),
      );
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That audience expression could not be read.',
      );
    }
  };

  const save = async () => {
    setBusy(true);
    setProblem(null);
    setErrors({});
    try {
      const body = {
        name,
        slug,
        kind,
        grants: [
          {
            resourceType:
              kind === 'localGroup'
                ? 'group'
                : kind === 'application'
                  ? 'application'
                  : 'entitlement',
            resourceId,
          },
        ],
        audienceCondition: parsedAudience(),
        workflowId,
        formSchema: [],
        durationMode: 'permanent',
        status: 'active',
      };
      await api(
        isNew
          ? '/api/admin/automate/products'
          : `/api/admin/automate/products/${id}`,
        { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) },
      );
      setProblem('Saved.');
    } catch (cause) {
      setErrors(fieldErrors(cause));
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong saving this.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={isNew ? 'New product' : 'Product'} />
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel title="What it is">
        <div className="space-y-4 p-4">
          <Field
            label="Name"
            value={name}
            onChange={setName}
            error={errors.name}
          />
          <Field
            label="Slug"
            value={slug}
            onChange={setSlug}
            error={errors.slug}
          />
          <Field
            label="Kind"
            value={kind}
            onChange={setKind}
            hint="application, localGroup or targetEntitlement"
          />
          <Field
            label="Resource id it grants"
            value={resourceId}
            onChange={setResourceId}
          />
          <Field
            label="Approval workflow id"
            value={workflowId}
            onChange={setWorkflowId}
          />
        </div>
      </Panel>

      <div className="mt-6">
        <Panel
          title="Who can see it"
          description='Leave this empty and NOBODY sees it. To offer it to everybody with an active contract, write { "all": [] }.'
        >
          <div className="space-y-3 p-4">
            <Field
              label="Audience condition (JSON)"
              value={audience}
              onChange={setAudience}
              error={errors.audienceCondition}
            />
            <Button onClick={runPreview}>Show me who</Button>
            {preview && (
              // The direct analogue of Provision's business-rule impact
              // preview: an audience whose blast radius is only visible after
              // saving is an audience that gets saved and then discovered.
              <Alert tone={preview.matched === 0 ? 'warning' : 'info'}>
                Visible to {preview.matched} of {preview.total} people.
                {preview.sample.length > 0 && (
                  <>
                    {' '}
                    For example:{' '}
                    {preview.sample.map((s) => s.displayName).join(', ')}.
                  </>
                )}
                {preview.matched === 0 && ' Nobody will see this product.'}
              </Alert>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Button variant="primary" loading={busy} onClick={save}>
          Save
        </Button>
      </div>
    </>
  );
}
