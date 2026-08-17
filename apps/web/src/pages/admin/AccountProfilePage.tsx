import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Preview {
  correlationKey: string | null;
  taken: boolean;
  container: string | null;
  attributes: Record<string, string>;
  problems: string[];
}

type Delivery = 'manager' | 'personalEmail' | 'vaultOnly';

/**
 * Exactly the fields `accountProfileRequestSchema` accepts, and nothing else.
 *
 * The schema is `.strict()`, and `GET /profile` returns the stored row — `id`,
 * `tenantId`, `targetSystemId`, `createdAt`, `updatedAt` and all. Sending back
 * what was read is therefore a 400 on every save of an existing profile, which
 * is the one path this page is for.
 */
interface Profile {
  correlationKeyTemplate: string;
  uniquenessStrategy: 'numericSuffix';
  maxUniquenessAttempts: number;
  containerTemplate: string;
  fallbackContainer: string;
  attributeTemplates: Record<string, string>;
  initialPasswordPolicy: { length?: number };
  initialPasswordDelivery: Delivery;
}

const EMPTY: Profile = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  uniquenessStrategy: 'numericSuffix',
  maxUniquenessAttempts: 20,
  containerTemplate: 'OU=%contract.department%,OU=Users,%baseDn%',
  fallbackContainer: '',
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  initialPasswordPolicy: { length: 24 },
  initialPasswordDelivery: 'vaultOnly',
};

const record = (value: unknown): Record<string, string> =>
  value !== null && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          String(v),
        ]),
      )
    : {};

/** The stored row, narrowed to what may be sent back. */
function profileFrom(stored: Record<string, unknown>): Profile {
  const policy = (stored.initialPasswordPolicy ?? {}) as { length?: unknown };
  return {
    correlationKeyTemplate: String(
      stored.correlationKeyTemplate ?? EMPTY.correlationKeyTemplate,
    ),
    uniquenessStrategy: 'numericSuffix',
    maxUniquenessAttempts: Number(stored.maxUniquenessAttempts ?? 20),
    containerTemplate: String(stored.containerTemplate ?? EMPTY.containerTemplate),
    fallbackContainer: String(stored.fallbackContainer ?? ''),
    attributeTemplates: record(stored.attributeTemplates),
    initialPasswordPolicy:
      typeof policy.length === 'number' ? { length: policy.length } : {},
    initialPasswordDelivery: (stored.initialPasswordDelivery ??
      'vaultOnly') as Delivery,
  };
}

interface PersonRow {
  id: string;
  givenName: string | null;
  familyName: string | null;
}

const nameOf = (person: PersonRow) =>
  `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim() || person.id;

export function AccountProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [personId, setPersonId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'save' | 'preview'>(null);

  const { data: persons } = useApiResource<{ persons: PersonRow[] }>(
    '/api/admin/persons',
  );

  useEffect(() => {
    void api<Record<string, unknown>>(`/api/admin/targets/${id}/profile`)
      .then((stored) => setProfile(profileFrom(stored)))
      // A 404 here is "no profile saved yet", which is the ordinary state of a
      // target somebody has just created, not an error to apologise for.
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.problem.status === 404) {
          setProfile(EMPTY);
        } else {
          setProblem('That account profile could not be loaded.');
        }
      });
  }, [id]);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setProfile((current) => ({ ...current, [key]: value }));

  const mark = (field: string): { error?: string } =>
    invalid[field] ? { error: invalid[field] } : {};

  function fail(cause: unknown, fallback: string) {
    const marked = fieldErrors(cause);
    setInvalid(marked);
    if (Object.keys(marked).length > 0) {
      setProblem(null);
    } else if (cause instanceof ApiError) {
      setProblem(cause.problem.detail ?? cause.problem.title ?? fallback);
    } else {
      setProblem(fallback);
    }
  }

  /**
   * Attribute names and their templates, as an ordered list.
   *
   * A `Record` cannot be edited in place — renaming a key while somebody is
   * halfway through typing it reorders the form under them and loses focus —
   * so the rows are the state and the record is built at the boundary.
   */
  const rows = Object.entries(profile.attributeTemplates);
  const setRows = (next: [string, string][]) =>
    set('attributeTemplates', Object.fromEntries(next));

  async function onSave() {
    setBusy('save');
    setInvalid({});
    setProblem(null);
    setNotice(null);
    try {
      await api(`/api/admin/targets/${id}/profile`, {
        method: 'PUT',
        body: JSON.stringify(body()),
      });
      setNotice('Saved.');
    } catch (cause) {
      fail(cause, 'The account profile could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  /** Blank attribute names dropped: an empty key is not an LDAP attribute. */
  function body() {
    return {
      ...profile,
      attributeTemplates: Object.fromEntries(
        Object.entries(profile.attributeTemplates).filter(
          ([name]) => name.trim() !== '',
        ),
      ),
    };
  }

  async function onPreview() {
    setBusy('preview');
    setInvalid({});
    setProblem(null);
    setPreview(null);
    try {
      setPreview(
        await api<Preview>(`/api/admin/targets/${id}/profile/preview`, {
          method: 'POST',
          body: JSON.stringify({ profile: body(), personId }),
        }),
      );
    } catch (cause) {
      fail(cause, 'That could not be previewed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Account profile"
        description="Rules answer whether somebody gets an account. This answers what that account looks like."
        actions={
          <Button
            variant="primary"
            onClick={onSave}
            loading={busy === 'save'}
            disabled={!!busy}
          >
            Save profile
          </Button>
        }
      />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {Object.keys(invalid).length > 0 && (
          <Alert tone="danger" title="Some of this was refused">
            The fields concerned are marked below.
          </Alert>
        )}

        <Panel title="Naming and placement" bodyClassName="grid gap-4 p-4">
          <Field
            label="Account name template"
            value={profile.correlationKeyTemplate}
            onChange={(v) => set('correlationKeyTemplate', v)}
            hint="The sAMAccountName. %person.givenName.first%.%person.familyName% gives anna.novak."
            {...mark('correlationKeyTemplate')}
          />
          <Field
            label="Maximum uniqueness attempts"
            value={String(profile.maxUniquenessAttempts)}
            onChange={(v) => set('maxUniquenessAttempts', Number(v))}
            inputMode="numeric"
            hint="When the name is taken, how many numbered variants to try before giving up and reporting the person as unprocessable."
            {...mark('maxUniquenessAttempts')}
          />
          <Field
            label="Container template"
            value={profile.containerTemplate}
            onChange={(v) => set('containerTemplate', v)}
            hint="Where the account is created. Every value substituted into it is escaped, so a department containing a comma cannot name a different container."
            {...mark('containerTemplate')}
          />
          <Field
            label="Fallback container"
            value={profile.fallbackContainer}
            onChange={(v) => set('fallbackContainer', v)}
            hint="Required. Used when the container template resolves to nothing: Provision does not create organizational units in somebody else's domain."
            {...mark('fallbackContainer')}
          />
        </Panel>

        <Panel
          title="Attributes"
          description="Written on create and rewritten whenever the person's record changes."
          actions={
            <Button size="sm" onClick={() => setRows([...rows, ['', '']])}>
              Add attribute
            </Button>
          }
        >
          <div className="space-y-3 p-4">
            {rows.length === 0 && (
              <p className="text-muted">
                No attributes are written beyond the name and the container.
              </p>
            )}
            {rows.map(([name, template], index) => (
              <div key={index} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
                <Field
                  label={`Attribute ${index + 1}`}
                  value={name}
                  onChange={(v) =>
                    setRows(
                      rows.map((row, i) =>
                        i === index ? [v, row[1]] : row,
                      ) as [string, string][],
                    )
                  }
                />
                <Field
                  label={`Template ${index + 1}`}
                  value={template}
                  onChange={(v) =>
                    setRows(
                      rows.map((row, i) =>
                        i === index ? [row[0], v] : row,
                      ) as [string, string][],
                    )
                  }
                />
                <div className="flex items-end">
                  <Button
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <p className="text-muted">
              <code>userAccountControl</code>, <code>member</code> and{' '}
              <code>distinguishedName</code> are refused here: they are what the
              enable, membership and move operations write, and the guard counts
              those. An attribute template that set them would be a way past it.
            </p>
          </div>
        </Panel>

        <Panel
          title="Initial password"
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="Length"
            value={String(profile.initialPasswordPolicy.length ?? '')}
            onChange={(v) =>
              set(
                'initialPasswordPolicy',
                v.trim() === '' ? {} : { length: Number(v) },
              )
            }
            inputMode="numeric"
            hint="At least 12. Provision generates it, seals it into the vault and never shows it again."
            {...mark('length')}
          />
          <Select
            label="Delivery"
            value={profile.initialPasswordDelivery}
            onChange={(v) => set('initialPasswordDelivery', v as Delivery)}
            {...mark('initialPasswordDelivery')}
            options={[
              { value: 'vaultOnly', label: 'Vault only — nobody is sent it' },
              { value: 'manager', label: "The person's manager" },
              { value: 'personalEmail', label: "The person's personal email" },
            ]}
          />
        </Panel>

        <Panel
          title="Live preview"
          description="A template language nobody can try is a template language everybody gets wrong."
        >
          <div className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Select
                label="Person"
                value={personId}
                onChange={setPersonId}
                options={[
                  { value: '', label: 'Pick a person…' },
                  ...(persons?.persons ?? []).map((person) => ({
                    value: person.id,
                    label: nameOf(person),
                  })),
                ]}
              />
              <Button
                onClick={onPreview}
                loading={busy === 'preview'}
                disabled={personId === '' || !!busy}
              >
                Preview
              </Button>
            </div>

            {preview && (
              <dl className="rounded-panel border border-border-subtle p-4">
                <dt className="font-medium text-ink">Account name</dt>
                <dd className="font-mono text-ink">
                  {preview.correlationKey ?? '—'}{' '}
                  {preview.taken && (
                    <span className="font-sans text-warning">
                      (the base name is already taken; this is the next free
                      one)
                    </span>
                  )}
                </dd>
                <dt className="mt-3 font-medium text-ink">Container</dt>
                <dd className="font-mono text-ink">{preview.container ?? '—'}</dd>
                {Object.entries(preview.attributes).map(([name, value]) => (
                  <div key={name}>
                    <dt className="mt-3 font-medium text-ink">{name}</dt>
                    <dd className="font-mono text-ink">{value}</dd>
                  </div>
                ))}
                {/*
                  The empty case is the one that matters here: a template that
                  resolves to nothing for this person produces no attributes at
                  all, and a preview that renders an empty list silently is a
                  preview that says the templates are fine.
                */}
                {Object.keys(preview.attributes).length === 0 && (
                  <div className="mt-3 text-muted">
                    No attributes resolved for this person.
                  </div>
                )}
                {preview.problems.length > 0 && (
                  <div className="mt-4">
                    <Alert tone="danger" title="This person could not be placed">
                      <ul className="list-disc pl-5">
                        {preview.problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </Alert>
                  </div>
                )}
              </dl>
            )}
          </div>
        </Panel>

        <Link
          to={`/admin/targets/${id}`}
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to the target
        </Link>
      </div>
    </>
  );
}
