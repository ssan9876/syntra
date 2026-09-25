import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PickerNote } from './PickerNote.js';
import { PageHeader } from './PageHeader.js';

interface Preview {
  correlationKey: string | null;
  taken: boolean;
  container: string | null;
  /**
   * False for a flat target (Entra ID, SCIM): it places accounts in no
   * container, so `container` is null and the container fields are ignored.
   * Optional so an older API that does not send it reads as "places".
   */
  placesAccountsInContainers?: boolean;
  /** The full UPN an Entra ID account would get; null for other targets. */
  userPrincipalName?: string | null;
  attributes: Record<string, string>;
  problems: string[];
}

type Delivery = 'manager' | 'personalEmail' | 'vaultOnly';

/**
 * The form's own state. Every number is held as **the text somebody typed**.
 *
 * `Number(v)` on each keystroke is how `3o` became the literal string `NaN` in
 * the box and then a `null` in the body that the schema 400s on, naming a field
 * the administrator never typed a null into. The conversion belongs at the one
 * boundary where it can be refused with a message, which is `bodyOf` below.
 *
 * What leaves this page is exactly the eight fields
 * `accountProfileRequestSchema` accepts, and nothing else: the schema is
 * `.strict()`, and `GET /profile` returns the stored row — `id`, `tenantId`,
 * `targetSystemId`, `createdAt`, `updatedAt` and all — so echoing back what was
 * read is a 400 on every save of an existing profile.
 */
interface Draft {
  correlationKeyTemplate: string;
  maxUniquenessAttempts: string;
  containerTemplate: string;
  fallbackContainer: string;
  attributeTemplates: Record<string, string>;
  passwordLength: string;
  initialPasswordDelivery: Delivery;
  sensitiveApprovalReason: string;
  sensitiveApprovedByUserId: string;
  sensitiveApprovedAt: string;
}

const EMPTY: Draft = {
  correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
  maxUniquenessAttempts: '20',
  containerTemplate: 'OU=%contract.department%,OU=Users,%baseDn%',
  fallbackContainer: '',
  attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
  passwordLength: '24',
  initialPasswordDelivery: 'vaultOnly',
  sensitiveApprovalReason: '',
  sensitiveApprovedByUserId: '',
  sensitiveApprovedAt: '',
};

/**
 * What this page reads while it does not yet know whether a profile exists.
 *
 * The distinction that was missing is between "this target has no profile yet"
 * — a 404, where the defaults are correct — and "we could not read the
 * profile", where they are a catastrophe: `profile` initialised to full
 * defaults with no gate in front of Save, so one click PUT the defaults over
 * the stored profile and took the naming convention and every attribute
 * template with them.
 */
type Load =
  | { state: 'loading' }
  | { state: 'ready'; stored: boolean }
  | { state: 'unreadable'; message: string };

const record = (value: unknown): Record<string, string> =>
  value !== null && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          String(v),
        ]),
      )
    : {};

const policyOf = (stored: Record<string, unknown>): Record<string, unknown> =>
  stored.initialPasswordPolicy !== null &&
  typeof stored.initialPasswordPolicy === 'object'
    ? (stored.initialPasswordPolicy as Record<string, unknown>)
    : {};

/** The stored row, narrowed to what may be sent back. */
function draftFrom(stored: Record<string, unknown>): Draft {
  const policy = policyOf(stored);
  return {
    correlationKeyTemplate: String(
      stored.correlationKeyTemplate ?? EMPTY.correlationKeyTemplate,
    ),
    maxUniquenessAttempts: String(stored.maxUniquenessAttempts ?? 20),
    containerTemplate: String(stored.containerTemplate ?? EMPTY.containerTemplate),
    fallbackContainer: String(stored.fallbackContainer ?? ''),
    attributeTemplates: record(stored.attributeTemplates),
    passwordLength: typeof policy.length === 'number' ? String(policy.length) : '',
    initialPasswordDelivery: (stored.initialPasswordDelivery ??
      'vaultOnly') as Delivery,
    sensitiveApprovalReason: String(stored.sensitiveApprovalReason ?? ''),
    sensitiveApprovedByUserId: String(stored.sensitiveApprovedByUserId ?? ''),
    sensitiveApprovedAt: String(stored.sensitiveApprovedAt ?? ''),
  };
}

/**
 * The password-policy keys this form has no control for, carried through.
 *
 * `initialPasswordPolicySchema` is `.strict()` and accepts `requireUpper`,
 * `requireLower`, `requireDigit` and `requireSymbol` as well as `length`. This
 * page renders only `length`, so rebuilding the policy from the form alone
 * would silently drop the other four on every save — the same shape of loss
 * this whole finding is about, one field deeper.
 */
function policyExtrasFrom(stored: Record<string, unknown>): Record<string, unknown> {
  const { length: _length, ...rest } = policyOf(stored);
  return rest;
}

/**
 * The draft as a request body, or the fields that are not numbers.
 *
 * Refused here rather than at the server because a `NaN` serialises to `null`
 * and comes back as a type error against a field nobody typed a null into.
 * The bounds are `accountProfileSchema`'s own: `maxUniquenessAttempts` is
 * `.int().positive().max(200)`, and `initialPasswordPolicy.length` is
 * `.int().min(12).max(256)` and optional.
 */
function bodyOf(
  draft: Draft,
  policyExtras: Record<string, unknown>,
): { body: Record<string, unknown> } | { invalid: Record<string, string> } {
  const invalid: Record<string, string> = {};

  if (
    sensitiveAttributeMappings(draft.attributeTemplates).length > 0 &&
    draft.sensitiveApprovalReason.trim().length < 20
  ) {
    invalid.sensitiveApprovalReason = 'record at least 20 characters explaining why this target needs personal email';
  }

  const attemptsRaw = draft.maxUniquenessAttempts.trim();
  const attempts = Number(attemptsRaw);
  if (
    attemptsRaw === '' ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 200
  ) {
    invalid.maxUniquenessAttempts = 'a whole number between 1 and 200';
  }

  const lengthRaw = draft.passwordLength.trim();
  const length = Number(lengthRaw);
  if (lengthRaw !== '' && (!Number.isInteger(length) || length < 12 || length > 256)) {
    invalid.length = 'a whole number between 12 and 256, or blank for the default';
  }

  if (Object.keys(invalid).length > 0) return { invalid };

  return {
    body: {
      correlationKeyTemplate: draft.correlationKeyTemplate,
      uniquenessStrategy: 'numericSuffix',
      maxUniquenessAttempts: attempts,
      containerTemplate: draft.containerTemplate,
      fallbackContainer: draft.fallbackContainer,
      // Blank attribute names dropped: an empty key is not an LDAP attribute.
      attributeTemplates: Object.fromEntries(
        Object.entries(draft.attributeTemplates).filter(
          ([name]) => name.trim() !== '',
        ),
      ),
      initialPasswordPolicy: {
        ...policyExtras,
        ...(lengthRaw === '' ? {} : { length }),
      },
      initialPasswordDelivery: draft.initialPasswordDelivery,
      ...(sensitiveAttributeMappings(draft.attributeTemplates).length === 0
        ? {}
        : { sensitiveApprovalReason: draft.sensitiveApprovalReason }),
    },
  };
}

const sensitiveAttributeMappings = (templates: Record<string, string>) =>
  Object.entries(templates)
    .filter(([, template]) => /%person\.personalEmail(?:\.[^%]+)?%/i.test(template))
    .map(([targetAttribute]) => targetAttribute);

interface PersonRow {
  id: string;
  givenName: string | null;
  familyName: string | null;
}

const nameOf = (person: PersonRow) =>
  `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim() || person.id;

export function AccountProfilePage() {
  const { id } = useParams<{ id: string }>();
  return <AccountProfileEditor key={id} />;
}

function AccountProfileEditor() {
  const { id } = useParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [profile, setProfile] = useState<Draft>(EMPTY);
  const [policyExtras, setPolicyExtras] = useState<Record<string, unknown>>({});
  const [personId, setPersonId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'save' | 'preview'>(null);
  const previewSeq = useRef(0);
  useEffect(() => () => { previewSeq.current += 1; }, []);

  function invalidatePreview() {
    previewSeq.current += 1;
    setPreview(null);
    setBusy((current) => current === 'preview' ? null : current);
  }

  const { data: persons } = useApiResource<{ persons: PersonRow[]; total: number }>(
    '/api/admin/persons?pageSize=200',
  );

  useEffect(() => {
    let active = true;
    setLoad({ state: 'loading' });
    void api<Record<string, unknown>>(`/api/admin/targets/${id}/profile`)
      .then((stored) => {
        if (!active) return;
        setProfile(draftFrom(stored));
        setPolicyExtras(policyExtrasFrom(stored));
        setLoad({ state: 'ready', stored: true });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        // A 404 here is "no profile saved yet", which is the ordinary state of
        // a target somebody has just created, not an error to apologise for —
        // and it is the ONLY status for which the defaults are the right thing
        // to put in the boxes. Anything else and the form is never shown,
        // because a Save from it would PUT the defaults over a stored profile
        // this page failed to read.
        if (cause instanceof ApiError && cause.problem.status === 404) {
          setProfile(EMPTY);
          setPolicyExtras({});
          setLoad({ state: 'ready', stored: false });
          return;
        }
        setLoad({
          state: 'unreadable',
          message:
            cause instanceof ApiError
              ? (cause.problem.detail ?? cause.problem.title)
              : 'The account profile could not be read.',
        });
      });
    return () => { active = false; };
  }, [id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    invalidatePreview();
    setProfile((current) => ({ ...current, [key]: value }));
  };

  const mark = (field: string): { error?: string } =>
    invalid[field] ? { error: invalid[field] } : {};

  /**
   * Marks the fields the server named **and keeps what it said about them**.
   *
   * The banner used to promise "the fields concerned are marked below" and then
   * throw the server's explanation away, which left the reader with a red box
   * round a control and no sentence anywhere saying what was wrong with it.
   * Both now: the mark on the control, the message in the banner.
   */
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
  const sensitiveAttributes = sensitiveAttributeMappings(profile.attributeTemplates);
  const setRows = (next: [string, string][]) =>
    set('attributeTemplates', Object.fromEntries(next));

  /** The body, or `null` having marked the fields that are not numbers. */
  function body(): Record<string, unknown> | null {
    const built = bodyOf(profile, policyExtras);
    if ('invalid' in built) {
      setInvalid(built.invalid);
      return null;
    }
    return built.body;
  }

  async function onSave() {
    setBusy('save');
    setInvalid({});
    setProblem(null);
    setNotice(null);
    const payload = body();
    if (payload === null) {
      setBusy(null);
      return;
    }
    try {
      await api(`/api/admin/targets/${id}/profile`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setNotice('Saved.');
    } catch (cause) {
      fail(cause, 'The account profile could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function onPreview() {
    const seq = ++previewSeq.current;
    setBusy('preview');
    setInvalid({});
    setProblem(null);
    setPreview(null);
    const payload = body();
    if (payload === null) {
      setBusy(null);
      return;
    }
    try {
      const result = await api<Preview>(`/api/admin/targets/${id}/profile/preview`, {
          method: 'POST',
          body: JSON.stringify({ profile: payload, personId }),
        });
      if (seq === previewSeq.current) setPreview(result);
    } catch (cause) {
      if (seq === previewSeq.current) fail(cause, 'That could not be previewed.');
    } finally {
      if (seq === previewSeq.current) setBusy(null);
    }
  }

  const header = (
    <PageHeader
      title="Account profile"
      {...(load.state === 'ready'
        ? {
            actions: (
              <Button
                variant="primary"
                onClick={onSave}
                loading={busy === 'save'}
                disabled={!!busy}
              >
                Save profile
              </Button>
            ),
          }
        : {})}
    />
  );

  const back = (
    <Link
      to={`/admin/targets/${id}`}
      className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
    >
      Back to the target
    </Link>
  );

  if (load.state === 'loading') {
    return (
      <>
        {header}
        <Panel>
          <SkeletonRows rows={8} cols={2} />
        </Panel>
      </>
    );
  }

  if (load.state === 'unreadable') {
    // No form at all. Every box on it would be a default, and the only button
    // on it would write those defaults over whatever is stored.
    return (
      <>
        {header}
        <div className="space-y-6">
          <Alert tone="danger" title="This profile could not be read">
            <p>{load.message}</p>
            <p className="mt-2">
              The form is not shown, because it would be showing defaults rather
              than what is stored — and saving it would put those defaults over
              the naming convention and every attribute template this target
              actually has.
            </p>
          </Alert>
          {back}
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {Object.keys(invalid).length > 0 && (
          <Alert tone="danger" title="Some of this was refused">
            {/* The marks below, and what was said about each of them. A red
                border round a control with the explanation discarded leaves
                the reader knowing only that something is wrong with it. */}
            <ul className="list-disc pl-5">
              {Object.entries(invalid).map(([field, message]) => (
                <li key={field}>
                  <code className="font-mono">{field}</code> — {message}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {!load.stored && (
          <Alert tone="info">
            This target has no account profile yet, so these are defaults. They
            are not stored until you save them.
          </Alert>
        )}

        <Panel title="Naming and placement" bodyClassName="grid gap-4 p-4">
          <Field
            label="Account name template"
            value={profile.correlationKeyTemplate}
            onChange={(v) => set('correlationKeyTemplate', v)}
            {...mark('correlationKeyTemplate')}
          />
          <Field
            label="Maximum uniqueness attempts"
            value={profile.maxUniquenessAttempts}
            onChange={(v) => set('maxUniquenessAttempts', v)}
            inputMode="numeric"
            {...mark('maxUniquenessAttempts')}
          />
          <Field
            label="Container template"
            value={profile.containerTemplate}
            onChange={(v) => set('containerTemplate', v)}
            {...mark('containerTemplate')}
          />
          <Field
            label="Fallback container"
            value={profile.fallbackContainer}
            onChange={(v) => set('fallbackContainer', v)}
            {...mark('fallbackContainer')}
          />
          <p className="-mt-2 text-sm text-ink-muted">
            Containers are where Active Directory places an account (and an HTTP
            target whose document describes containers). Entra ID and SCIM keep
            accounts in one flat directory, so both container settings are
            ignored for them; they are still required, and <code>/</code> is the
            conventional value.
          </p>
        </Panel>

        <Panel
          title="Attributes"
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
                {/* Marked, which is what the banner above has always
                    promised and these two rows never delivered.
                    `attributeTemplatesSchema` reports both the name it refuses
                    (`userAccountControl`, `member`, `distinguishedName`, or
                    anything that is not an RFC 4512 `descr`) and the template
                    it refuses under the path `attributeTemplates.<name>`, and
                    `fieldErrors` keeps the last segment. */}
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
                  {...mark(name)}
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
                  invalid={Boolean(invalid[name])}
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
            {sensitiveAttributes.length > 0 && (
              <div className="space-y-3" aria-live="polite">
                <Alert tone="warning" title="Sensitive data needs approval">
                  Personal email will be sent to {sensitiveAttributes.length} target attribute{sensitiveAttributes.length === 1 ? '' : 's'}.
                </Alert>
                <Table tight>
                  <thead><tr><th scope="col">Target attribute</th><th scope="col">Source field</th><th scope="col">Classification</th></tr></thead>
                  <tbody>
                    {sensitiveAttributes.map((attribute) => (
                      <tr key={attribute}>
                        <th scope="row" className="font-mono">{attribute}</th>
                        <td className="font-mono">person.personalEmail</td>
                        <td><Status tone="warning">Sensitive</Status></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Field
                  label="Purpose for sharing personal email"
                  value={profile.sensitiveApprovalReason}
                  onChange={(value) => set('sensitiveApprovalReason', value)}
                  maxLength={1000}
                  {...mark('sensitiveApprovalReason')}
                />
                {profile.sensitiveApprovedAt && (
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted">Approval</dt>
                      <dd><Status tone="active">Recorded</Status></dd>
                    </div>
                    <div>
                      <dt className="text-muted">Recorded at</dt>
                      <dd className="tabular-nums text-ink">{new Date(profile.sensitiveApprovedAt).toLocaleString()}</dd>
                    </div>
                  </dl>
                )}
              </div>
            )}
          </div>
        </Panel>

        <Panel
          title="Initial password"
          bodyClassName="grid gap-4 p-4 sm:grid-cols-2"
        >
          <Field
            label="Length"
            value={profile.passwordLength}
            onChange={(v) => set('passwordLength', v)}
            inputMode="numeric"
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
        >
          <div className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Select
                label="Person"
                value={personId}
                onChange={(value) => { invalidatePreview(); setPersonId(value); }}
                options={[
                  { value: '', label: 'Pick a person…' },
                  ...(persons?.persons ?? []).map((person) => ({
                    value: person.id,
                    label: nameOf(person),
                  })),
                ]}
              />
              <PickerNote
                shown={persons?.persons?.length ?? 0}
                total={persons?.total ?? 0}
                to="/admin/users?tab=people"
                label="People"
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
                {preview.userPrincipalName && (
                  <>
                    <dt className="mt-3 font-medium text-ink">User principal name</dt>
                    <dd className="font-mono text-ink">{preview.userPrincipalName}</dd>
                  </>
                )}
                <dt className="mt-3 font-medium text-ink">Container</dt>
                {preview.placesAccountsInContainers === false ? (
                  <dd className="text-muted">Not used: this target has no containers.</dd>
                ) : (
                  <dd className="font-mono text-ink">{preview.container ?? '—'}</dd>
                )}
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

        {back}
      </div>
    </>
  );
}
