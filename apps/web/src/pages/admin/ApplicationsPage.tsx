import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  Field,
  Panel,
  SkeletonRows,
  Status,
  Table,
} from '@syntra/ui';
import { isLaunchableUrl } from '@syntra/contracts';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';

interface CatalogEntry {
  key: string;
  name: string;
  category: string;
  description: string;
  docsUrl: string;
  variables: { key: string; label: string; example: string }[];
  saml?: unknown;
  oidc?: unknown;
}

interface Row {
  id: string;
  name: string;
  slug: string;
  type: string;
  visibility: 'assigned' | 'hidden';
  status: string;
}

/**
 * Pick an application, then fill in the one or two values that are yours.
 *
 * Two steps rather than one long form, because they are two different
 * questions: "which application" is a recognition task and belongs in a grid
 * of names, and "what is your Slack workspace called" is a typing task that
 * makes no sense until the first has been answered.
 *
 * The variables come from the entry, so the form asks for exactly what that
 * application needs and nothing else — no page of SAML fields greyed out
 * because this vendor does not use them.
 */
function CatalogPicker({
  onCancel,
  onCreated,
}: {
  onCancel(): void;
  onCreated(): void;
}) {
  const { data, error } = useApiResource<{ entries: CatalogEntry[] }>(
    '/api/admin/catalog',
  );
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(
    null,
  );

  const entries = data?.entries ?? [];

  async function create() {
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    try {
      const created = await api<{ clientId?: string; clientSecret?: string }>(
        '/api/admin/applications/from-catalog',
        {
          method: 'POST',
          body: JSON.stringify({ key: chosen.key, variables: values }),
        },
      );
      // An OIDC application's secret exists in this response and nowhere else.
      // Finishing the flow before it has been copied would throw it away.
      if (created.clientId && created.clientSecret) {
        setSecret({ clientId: created.clientId, clientSecret: created.clientSecret });
        return;
      }
      onCreated();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (secret) {
    return (
      <Panel title={`${chosen?.name ?? 'Application'} is registered`}>
        <div className="space-y-3 p-4">
          <p className="text-muted">
            Paste these into the application now. The secret is not shown again.
          </p>
          <Field label="Client ID" value={secret.clientId} onChange={() => undefined} readOnly />
          <Field
            label="Client secret"
            value={secret.clientSecret}
            onChange={() => undefined}
            readOnly
          />
          <Button variant="primary" onClick={onCreated}>
            Done
          </Button>
        </div>
      </Panel>
    );
  }

  if (chosen) {
    return (
      <Panel title={`Add ${chosen.name}`}>
        <div className="space-y-4 p-4">
          {chosen.variables.map((variable) => (
            <Field
              key={variable.key}
              label={variable.label}
              value={values[variable.key] ?? ''}
              onChange={(v) => setValues((current) => ({ ...current, [variable.key]: v }))}
              placeholder={variable.example}
              required
            />
          ))}
          {chosen.variables.length === 0 && (
            <p className="text-muted">Nothing else is needed.</p>
          )}

          {problem && <Alert tone="danger">{problem}</Alert>}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} onClick={create}>
              Add {chosen.name}
            </Button>
            <Button variant="secondary" onClick={() => setChosen(null)}>
              Back
            </Button>
            {/*
              The vendor's own page. An entry is a convenience and that page is
              the authority, so it is one click away at the moment somebody
              might doubt a value.
            */}
            <a
              className="link text-sm"
              href={chosen.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {chosen.name} SSO documentation
            </a>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Add from the catalog"
      actions={
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <div className="p-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => {
                setChosen(entry);
                setValues({});
                setProblem(null);
              }}
              className="rounded-panel border border-border-control p-3 text-left transition-colors duration-150 ease-out hover:border-primary hover:bg-surface-2"
            >
              <span className="block font-medium text-ink">{entry.name}</span>
              <span className="mt-0.5 block text-sm text-muted">{entry.description}</span>
              <span className="mt-2 inline-block">
                <Status tone="neutral">{entry.saml ? 'SAML' : 'OpenID Connect'}</Status>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function ApplicationsPage() {
  const { data, error, loading, reload } = useApiResource<{ applications: Row[] }>(
    '/api/admin/applications',
  );
  // Narrowed once, and reused by both the summary cards and the table.
  // The optional chain used to guard `data` and then walk straight into
  // the collection, so a 200 arriving without it threw inside render.
  const applications = data?.applications ?? [];

  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [launchUrl, setLaunchUrl] = useState('');
  const [category, setCategory] = useState('');
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
          // Omitted when blank rather than sent as ''. The column is nullable
          // and an empty string would be a category whose heading is nothing.
          ...(category.trim() ? { category: category.trim() } : {}),
        }),
      });
      setAdding(false);
      setName('');
      setSlug('');
      setDescription('');
      setLaunchUrl('');
      setCategory('');
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
        actions={
          <>
            {/*
              The catalog first, and the blank form second. Registering a known
              application by hand means transcribing four values out of a
              vendor page — an entity ID, an ACS URL, a NameID format and a set
              of attribute names — every one of which fails at the first
              sign-in with a blank screen if it is wrong.
            */}
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setPicking((v) => !v);
                setAdding(false);
              }}
            >
              Add from the catalog
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setAdding((v) => !v);
                setPicking(false);
              }}
            >
              Add by hand
            </Button>
          </>
        }
      />

      <StatGrid>
        <StatCard label="Applications" value={applications.length} />
        <StatCard
          label="Hidden from the portal"
          value={applications.filter((a) => a.visibility === 'hidden').length}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      {error && <Alert tone="danger">{error}</Alert>}

      {picking && (
        <CatalogPicker
          onCancel={() => setPicking(false)}
          onCreated={() => {
            setPicking(false);
            reload();
          }}
        />
      )}

      {adding && (
        <Panel title="New application">
          <div className="space-y-4 p-4">
            <Field label="Name" value={name} onChange={setName} required />
            <Field
              label="Slug"
              value={slug}
              onChange={setSlug}
              warning={
                // Only once they have typed one. An empty field has nothing
                // to warn about, and a permanent caption under an empty box
                // is the hint this replaced.
                slug ? 'This appears in URLs and cannot be changed after the application is created.' : undefined
              }
              required
              {...(slugError ? { error: slugError } : {})}
            />
            <Field label="Description" value={description} onChange={setDescription} />
            <Field
              label="Category"
              value={category}
              onChange={setCategory}
            />
            <Field
              label="Launch URL"
              value={launchUrl}
              onChange={(v) => {
                setLaunchUrl(v);
                if (launchUrlError) setLaunchUrlError(null);
              }}
              required
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
            <Table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="max-sm:hidden">Type</th>
                  <th scope="col">Visibility</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.applications.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        to={`/admin/applications/${row.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="ml-2 text-sm text-muted">{row.slug}</span>
                    </td>
                    <td className="max-sm:hidden">{row.type}</td>
                    <td>
                      {row.visibility === 'hidden' ? (
                        <Status tone="neutral">Hidden</Status>
                      ) : (
                        <Status tone="primary">Assigned</Status>
                      )}
                    </td>
                    <td>
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
            </Table>
          </Panel>
        )}
      </div>
    </>
  );
}
