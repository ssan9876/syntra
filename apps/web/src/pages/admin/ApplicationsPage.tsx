import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { isLaunchableUrl } from '@syntra/contracts';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Row {
  id: string;
  name: string;
  slug: string;
  type: string;
  visibility: 'assigned' | 'hidden';
  status: string;
}

export function ApplicationsPage() {
  const { data, error, loading, reload } = useApiResource<{ applications: Row[] }>(
    '/api/admin/applications',
  );
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [launchUrl, setLaunchUrl] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [launchUrlError, setLaunchUrlError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function create() {
    setSlugError(null);
    setFormError(null);

    // Checked here too, not only by the API: `z.string().url()` accepts
    // `javascript:`, and this is the URL the portal navigates a signed-in
    // user's browser to when they click the tile. The server still refuses a
    // bad scheme on its own — this just means the administrator learns before
    // submitting rather than after.
    if (!isLaunchableUrl(launchUrl)) {
      setLaunchUrlError('Must be an http or https URL');
      return;
    }
    setLaunchUrlError(null);

    setBusy(true);
    try {
      await api('/api/admin/applications', {
        method: 'POST',
        body: JSON.stringify({
          name,
          slug,
          launchUrl,
          ...(description ? { description } : {}),
        }),
      });
      setAdding(false);
      setName('');
      setSlug('');
      setDescription('');
      setLaunchUrl('');
      reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.problem.status === 409) {
        setSlugError('That slug is already used.');
      } else {
        setFormError(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'That application could not be saved.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Applications"
        description="What your people can reach from the portal, and who each one is assigned to."
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding((v) => !v)}>
            Add an application
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {adding && (
        <Panel title="New application">
          <div className="space-y-4 p-4">
            <Field label="Name" value={name} onChange={setName} required />
            <Field
              label="Slug"
              value={slug}
              onChange={setSlug}
              required
              hint="Lower-case letters, digits and hyphens. It appears in URLs and cannot be changed later."
              {...(slugError ? { error: slugError } : {})}
            />
            <Field label="Description" value={description} onChange={setDescription} />
            <Field
              label="Launch URL"
              value={launchUrl}
              onChange={(v) => {
                setLaunchUrl(v);
                if (launchUrlError) setLaunchUrlError(null);
              }}
              required
              hint="Where the tile opens. https:// only."
              {...(launchUrlError ? { error: launchUrlError } : {})}
            />
            {formError && (
              <Alert tone="danger">
                <span>{formError}</span>
              </Alert>
            )}
            <Button variant="primary" loading={busy} onClick={create}>
              Save application
            </Button>
          </div>
        </Panel>
      )}

      <div className="mt-6">
        {loading && <SkeletonRows rows={4} cols={4} />}

        {!loading && data && data.applications.length === 0 && (
          <Empty
            title="No applications yet"
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add an application
              </Button>
            }
          >
            Add one to give people a tile in their portal.
          </Empty>
        )}

        {!loading && data && data.applications.length > 0 && (
          <Panel>
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium max-sm:hidden">Type</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Visibility</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.applications.map((row) => (
                  <tr key={row.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/admin/applications/${row.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="ml-2 text-sm text-muted">{row.slug}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">{row.type}</td>
                    <td className="px-4 py-2.5">
                      {row.visibility === 'hidden' ? (
                        <Status tone="neutral">Hidden</Status>
                      ) : (
                        <Status tone="primary">Assigned</Status>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {/*
                        A retired application stays in the list and stays
                        labelled. Hiding it to keep the table tidy would make
                        the catalog unauditable — the same rule as an inactive
                        user in the directory.
                      */}
                      <Status tone={row.status === 'active' ? 'active' : 'inactive'}>
                        {row.status === 'active' ? 'Active' : 'Retired'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </>
  );
}
