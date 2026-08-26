import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, Select } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

interface Preview {
  matched: number;
  total: number;
  sample: { personId: string; displayName: string }[];
}

interface ProductGrant {
  resourceType: string;
  resourceId: string;
  targetSystemId: string | null;
  optional: boolean;
}

interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  iconUrl: string | null;
  requestInstructions: string | null;
  kind: string;
  audienceCondition: unknown;
  workflowId: string;
  formSchema: unknown;
  durationMode: string;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
  ownerPersonId: string | null;
  ownerGroupId: string | null;
  status: string;
  grants: ProductGrant[];
}

export function ProductEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined || id === 'new';

  /**
   * THE PRODUCT, not the list.
   *
   * This page fetched `/automate/products` and never read the result. Every
   * field therefore started empty, and `save()` issues a full PUT that
   * requires the whole object -- so renaming a product replaced its
   * description, category, grants, form schema and duration mode with the
   * editor's defaults. A catalog entry could be destroyed by fixing a typo in
   * its name, and nothing on the screen said so.
   */
  const { data: loaded, error } = useApiResource<Product>(
    isNew ? null : `/api/admin/automate/products/${id}`,
  );

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [requestInstructions, setRequestInstructions] = useState('');
  const [kind, setKind] = useState('application');
  const [workflowId, setWorkflowId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [audience, setAudience] = useState('');
  const [durationMode, setDurationMode] = useState('permanent');
  const [defaultDurationDays, setDefaultDurationDays] = useState('');
  const [maxDurationDays, setMaxDurationDays] = useState('');
  const [status, setStatus] = useState('draft');

  /**
   * The parts this form does not edit, carried through untouched.
   *
   * `formSchema` is a typed request form with its own editor elsewhere, and
   * the extra grants of a multi-grant product are not representable in the one
   * resource box below. Sending defaults for them is what destroyed them; the
   * honest answer while the form is this small is to send back exactly what
   * arrived.
   */
  const [carried, setCarried] = useState<Pick<
    Product,
    'formSchema' | 'iconUrl' | 'ownerPersonId' | 'ownerGroupId' | 'grants'
  > | null>(null);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    setName(loaded.name);
    setSlug(loaded.slug);
    setDescription(loaded.description ?? '');
    setCategory(loaded.category ?? '');
    setRequestInstructions(loaded.requestInstructions ?? '');
    setKind(loaded.kind);
    setWorkflowId(loaded.workflowId);
    setResourceId(loaded.grants[0]?.resourceId ?? '');
    setAudience(
      loaded.audienceCondition === null ? '' : JSON.stringify(loaded.audienceCondition),
    );
    setDurationMode(loaded.durationMode);
    setDefaultDurationDays(loaded.defaultDurationDays?.toString() ?? '');
    setMaxDurationDays(loaded.maxDurationDays?.toString() ?? '');
    setStatus(loaded.status);
    setCarried({
      formSchema: loaded.formSchema,
      iconUrl: loaded.iconUrl,
      ownerPersonId: loaded.ownerPersonId,
      ownerGroupId: loaded.ownerGroupId,
      grants: loaded.grants,
    });
  }, [loaded]);

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
      const grants =
        carried === null || carried.grants.length === 0
          ? [
              {
                resourceType:
                  kind === 'localGroup'
                    ? 'group'
                    : kind === 'application'
                      ? 'application'
                      : 'entitlement',
                resourceId,
                targetSystemId: null,
                optional: false,
              },
            ]
          : // The grant list as it arrived, with only the resource id this form
            // can edit replaced. A product with three grants had two of them
            // deleted every time somebody saved a name change.
            carried.grants.map((grant, index) =>
              index === 0 ? { ...grant, resourceId } : grant,
            );

      const body = {
        name,
        slug,
        description: description.trim() === '' ? null : description,
        category: category.trim() === '' ? null : category,
        iconUrl: carried?.iconUrl ?? null,
        requestInstructions:
          requestInstructions.trim() === '' ? null : requestInstructions,
        kind,
        grants,
        audienceCondition: parsedAudience(),
        workflowId,
        formSchema: carried?.formSchema ?? [],
        durationMode,
        defaultDurationDays:
          defaultDurationDays.trim() === '' ? null : Number(defaultDurationDays),
        maxDurationDays: maxDurationDays.trim() === '' ? null : Number(maxDurationDays),
        ownerPersonId: carried?.ownerPersonId ?? null,
        ownerGroupId: carried?.ownerGroupId ?? null,
        status,
      };
      await api(
        isNew ? '/api/admin/automate/products' : `/api/admin/automate/products/${id}`,
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
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel title="What it is">
        <div className="space-y-4 p-4">
          <Field label="Name" value={name} onChange={setName} error={errors.name} />
          <Field label="Slug" value={slug} onChange={setSlug} error={errors.slug} />
          <Field
            label="Description"
            value={description}
            onChange={setDescription}
            hint="What somebody gets, in the words they would use for it."
          />
          <Field label="Category" value={category} onChange={setCategory} />
          <Field
            label="Request instructions"
            value={requestInstructions}
            onChange={setRequestInstructions}
            hint="Shown on the request form. Say what the approver will need to know."
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
          title="How long it lasts"
          description="A permanent grant is reviewed by a campaign; a fixed one expires on its own."
        >
          <div className="space-y-4 p-4">
            <Select
              label="Duration mode"
              value={durationMode}
              onChange={setDurationMode}
              options={[
                { value: 'permanent', label: 'Permanent' },
                { value: 'fixed', label: 'Fixed' },
                { value: 'requested', label: 'Chosen by the requester' },
              ]}
            />
            <Field
              label="Default duration (days)"
              value={defaultDurationDays}
              onChange={setDefaultDurationDays}
            />
            <Field
              label="Maximum duration (days)"
              value={maxDurationDays}
              onChange={setMaxDurationDays}
            />
            <Select
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'draft', label: 'Draft' },
                { value: 'active', label: 'Active' },
                { value: 'retired', label: 'Retired' },
              ]}
            />
          </div>
        </Panel>
      </div>

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
                    For example: {preview.sample.map((s) => s.displayName).join(', ')}.
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
