import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Check, Field, Select, Textarea } from '@syntra/ui';
import {
  bodyFromFields,
  getAt,
  isFlatBody,
  numbersOf,
  setAt,
  setNumber,
  setText,
  textAt,
  type Doc,
} from './doc-path.js';

/**
 * A form over an HTTP connector document, section by section, for adding an
 * application by hand. It edits the document itself, so the JSON tab and this
 * form are always the same thing.
 */

interface BuilderState {
  doc: Doc;
  update(next: Doc): void;
  errors: Record<string, string>;
}

const BuilderContext = createContext<BuilderState | null>(null);

function useBuilder(): BuilderState {
  const state = useContext(BuilderContext);
  if (!state) throw new Error('ConnectorBuilder controls must sit inside ConnectorBuilder');
  return state;
}

/** Attribute names the account profile commonly renders. */
const ATTRIBUTE_SUGGESTIONS = [
  'userName',
  'givenName',
  'familyName',
  'displayName',
  'mail',
  'title',
  'department',
  'employeeId',
  'enabled',
];

export const PLACEHOLDERS: { token: string; meaning: string }[] = [
  { token: '{{attr.<name>}}', meaning: 'An attribute from the account profile' },
  { token: '{{correlationKey}}', meaning: 'The account name' },
  { token: '{{anchor}}', meaning: "The application's id for the account" },
  { token: '{{enabled}}', meaning: 'true or false' },
  { token: '{{initialPassword}}', meaning: 'The first password (body only)' },
  { token: '{{actionId}}', meaning: 'This change, for finding a retried create' },
  { token: '{{entitlementId}}', meaning: "The group's id (group requests only)" },
];

// ---------------------------------------------------------------------------
// Bound controls

function TextAt({
  path,
  label,
  placeholder,
  mono,
  number,
  list,
}: {
  path: string;
  label: string;
  placeholder?: string;
  mono?: boolean;
  number?: boolean;
  list?: string;
}) {
  const { doc, update, errors } = useBuilder();
  return (
    <Field
      label={label}
      name={path}
      value={textAt(doc, path)}
      onChange={(v) => update(number ? setNumber(doc, path, v) : setText(doc, path, v))}
      placeholder={placeholder}
      error={errors[path]}
      inputMode={number ? 'numeric' : undefined}
      className={mono ? 'font-mono' : undefined}
      list={list}
      spellCheck={false}
      autoComplete="off"
    />
  );
}

function SelectAt({
  path,
  label,
  options,
  fallback,
  numeric,
}: {
  path: string;
  label: string;
  options: { value: string; label: string }[];
  fallback: string;
  /** Stores the choice as a number. */
  numeric?: boolean;
}) {
  const { doc, update, errors } = useBuilder();
  return (
    <Select
      label={label}
      name={path}
      value={textAt(doc, path) || fallback}
      onChange={(v) => update(setAt(doc, path, numeric ? Number(v) : v))}
      options={options}
      error={errors[path]}
    />
  );
}

function CheckAt({ path, label, fallback = false }: { path: string; label: string; fallback?: boolean }) {
  const { doc, update } = useBuilder();
  const value = getAt(doc, path);
  return (
    <Check
      name={path}
      label={label}
      checked={typeof value === 'boolean' ? value : fallback}
      onChange={(v) => update(setAt(doc, path, v))}
    />
  );
}

/** A comma-separated list of status codes or text fragments. */
function ListAt({ path, label, numeric, placeholder }: { path: string; label: string; numeric?: boolean; placeholder?: string }) {
  const { doc, update, errors } = useBuilder();
  const value = getAt(doc, path);
  const [text, setTextState] = useState(Array.isArray(value) ? value.join(', ') : '');
  useEffect(() => {
    setTextState(Array.isArray(value) ? value.join(', ') : '');
    // Only when the stored list changes from outside this box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  return (
    <Field
      label={label}
      name={path}
      value={text}
      placeholder={placeholder}
      error={errors[path]}
      onChange={setTextState}
      onBlur={() => {
        if (text.trim() === '') return update(setAt(doc, path, undefined));
        const next = numeric
          ? numbersOf(text)
          : text
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== '');
        update(setAt(doc, path, next));
      }}
    />
  );
}

/**
 * Rows of key and value for an object of text: headers, query parameters,
 * field mappings, simple request bodies. A value that was a boolean or a
 * number stays one while it still reads as one.
 */
function RowsAt({
  path,
  keyLabel,
  valueLabel,
  addLabel,
  valueList,
  keyPlaceholder,
  valuePlaceholder,
}: {
  path: string;
  keyLabel: string;
  valueLabel: string;
  addLabel: string;
  valueList?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { doc, update, errors } = useBuilder();
  const raw = getAt(doc, path);
  const record = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const entries = Object.entries(record);

  const write = (next: [string, unknown][]) => {
    update(setAt(doc, path, Object.fromEntries(next)));
  };
  const typed = (previous: unknown, text: string): unknown => {
    if (typeof previous === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
    if (typeof previous === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
    return text;
  };

  return (
    <div className="space-y-2">
      {entries.map(([key, value], index) => (
        <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Field
            label={keyLabel}
            value={key}
            placeholder={keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            error={errors[`${path}.${key}`]}
            onChange={(nextKey) => {
              const next = [...entries];
              next[index] = [nextKey, value];
              write(next);
            }}
          />
          <Field
            label={valueLabel}
            value={typeof value === 'string' ? value : String(value)}
            placeholder={valuePlaceholder}
            list={valueList}
            spellCheck={false}
            autoComplete="off"
            onChange={(text) => {
              const next = [...entries];
              next[index] = [key, typed(value, text)];
              write(next);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove ${key || 'row'}`}
            onClick={() => write(entries.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={'' in record}
        onClick={() => write([...entries, ['', '']])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

/** A JSON value for something rows cannot hold, such as a nested request body. */
function JsonAt({ path, label }: { path: string; label: string }) {
  const { doc, update, errors } = useBuilder();
  const value = getAt(doc, path);
  const [text, setTextState] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [problem, setProblem] = useState<string | undefined>();
  return (
    <Textarea
      label={label}
      name={path}
      mono
      rows={8}
      spellCheck={false}
      value={text}
      error={problem ?? errors[path]}
      onChange={setTextState}
      onBlur={() => {
        if (text.trim() === '') {
          setProblem(undefined);
          return update(setAt(doc, path, undefined));
        }
        try {
          update(setAt(doc, path, JSON.parse(text)));
          setProblem(undefined);
        } catch {
          setProblem('Not valid JSON.');
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Layout

function Section({
  title,
  prefixes,
  children,
  open = true,
}: {
  title: string;
  prefixes: string[];
  children: ReactNode;
  open?: boolean;
}) {
  const { errors } = useBuilder();
  const count = Object.keys(errors).filter((p) => prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}.`))).length;
  return (
    <details open={open || count > 0} className="rounded-control border border-border-subtle">
      <summary className="cursor-pointer select-none px-4 py-3 font-medium text-ink">
        {title}
        {count > 0 && <span className="ml-2 text-sm text-danger">{count === 1 ? '1 problem' : `${count} problems`}</span>}
      </summary>
      <div className="space-y-4 border-t border-border-subtle p-4">{children}</div>
    </details>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Optional({ path, label, initial, children }: { path: string; label: string; initial: unknown; children: ReactNode }) {
  const { doc, update } = useBuilder();
  const on = getAt(doc, path) !== undefined;
  return (
    <div className="space-y-4">
      <Check name={`${path}.enabled`} label={label} checked={on} onChange={(v) => update(setAt(doc, path, v ? initial : undefined))} />
      {on && <div className="space-y-4 border-l border-border-subtle pl-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request parts

const PAGING_STYLES = [
  { value: 'none', label: 'Everything in one response' },
  { value: 'offset', label: 'Offset and limit' },
  { value: 'page', label: 'Page numbers' },
  { value: 'cursor', label: 'Next-page link or token in the body' },
  { value: 'link', label: 'Link header (rel="next")' },
];

function PagingEditor({ path }: { path: string }) {
  const { doc, update } = useBuilder();
  const style = textAt(doc, `${path}.style`) || 'none';
  return (
    <div className="space-y-4">
      <Select
        label="Paging"
        name={`${path}.style`}
        value={style}
        options={PAGING_STYLES}
        onChange={(v) => update(setAt(doc, path, { style: v }))}
      />
      {style === 'offset' && (
        <Grid>
          <TextAt path={`${path}.limitParam`} label="Limit parameter" placeholder="limit" mono />
          <TextAt path={`${path}.offsetParam`} label="Offset parameter" placeholder="offset" mono />
          <TextAt path={`${path}.pageSize`} label="Page size" placeholder="200" number />
          <TextAt path={`${path}.totalAt`} label="Total count at" placeholder="total" mono />
        </Grid>
      )}
      {style === 'page' && (
        <Grid>
          <TextAt path={`${path}.pageParam`} label="Page parameter" placeholder="page" mono />
          <TextAt path={`${path}.sizeParam`} label="Page size parameter" placeholder="per_page" mono />
          <TextAt path={`${path}.pageSize`} label="Page size" placeholder="100" number />
          <SelectAt
            path={`${path}.firstPage`}
            label="First page"
            fallback="1"
            numeric
            options={[
              { value: '1', label: '1' },
              { value: '0', label: '0' },
            ]}
          />
          <TextAt path={`${path}.totalAt`} label="Total count at" placeholder="total" mono />
        </Grid>
      )}
      {style === 'cursor' && (
        <Grid>
          <TextAt path={`${path}.nextAt`} label="Next page at" placeholder="@odata.nextLink" mono />
          <SelectAt
            path={`${path}.kind`}
            label="It holds"
            fallback="url"
            options={[
              { value: 'url', label: 'The whole next URL' },
              { value: 'token', label: 'A token to send back' },
            ]}
          />
          {textAt(doc, `${path}.kind`) === 'token' && (
            <TextAt path={`${path}.tokenParam`} label="Token parameter" placeholder="pageToken" mono />
          )}
        </Grid>
      )}
    </div>
  );
}

function ListEditor({ path, itemsLabel = 'Items at', pathPlaceholder }: { path: string; itemsLabel?: string; pathPlaceholder: string }) {
  return (
    <div className="space-y-4">
      <Grid>
        <TextAt path={`${path}.path`} label="Path" placeholder={pathPlaceholder} mono />
        <TextAt path={`${path}.itemsAt`} label={itemsLabel} placeholder="Leave empty when the body is the list" mono />
      </Grid>
      <PagingEditor path={`${path}.paging`} />
      <details>
        <summary className="cursor-pointer text-sm text-muted">Query parameters</summary>
        <div className="pt-3">
          <RowsAt path={`${path}.query`} keyLabel="Parameter" valueLabel="Value" addLabel="Add parameter" />
        </div>
      </details>
    </div>
  );
}

const ACCOUNT_METHODS = ['POST', 'PUT', 'PATCH'].map((m) => ({ value: m, label: m }));
const MEMBERSHIP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }));

function BodyEditor({ path, fillFrom }: { path: string; fillFrom?: string }) {
  const { doc, update } = useBuilder();
  const body = getAt(doc, path);
  const [asJson, setAsJson] = useState(body !== undefined && !isFlatBody(body));
  const fields = fillFrom ? (getAt(doc, fillFrom) as Record<string, string> | undefined) : undefined;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">Body</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAsJson(!asJson)} disabled={!asJson && body !== undefined && !isFlatBody(body)}>
          {asJson ? 'Edit as rows' : 'Edit as JSON'}
        </Button>
        {fields && Object.keys(fields).length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => update(setAt(doc, path, { ...(isFlatBody(body) ? body : {}), ...bodyFromFields(fields) }))}>
            Fill from field mapping
          </Button>
        )}
      </div>
      {asJson || (body !== undefined && !isFlatBody(body)) ? (
        <JsonAt path={path} label="Body (JSON)" />
      ) : (
        <RowsAt
          path={path}
          keyLabel="Field"
          valueLabel="Value"
          addLabel="Add field"
          valuePlaceholder="{{attr.givenName}}"
        />
      )}
    </div>
  );
}

function WriteEditor({
  path,
  label,
  methods,
  initial,
  anchorAt,
  fillFrom,
  noBody,
}: {
  path: string;
  label: string;
  methods: { value: string; label: string }[];
  initial: Doc;
  anchorAt?: boolean;
  fillFrom?: string;
  noBody?: boolean;
}) {
  return (
    <Optional path={path} label={label} initial={initial}>
      <Grid>
        <SelectAt path={`${path}.method`} label="Method" options={methods} fallback={String(initial.method)} />
        <TextAt path={`${path}.path`} label="Path" placeholder={String(initial.path)} mono />
        {anchorAt && <TextAt path={`${path}.anchorAt`} label="New account's id at" placeholder="id" mono />}
      </Grid>
      {!noBody && <BodyEditor path={`${path}.body`} {...(fillFrom ? { fillFrom } : {})} />}
      <details>
        <summary className="cursor-pointer text-sm text-muted">Query, headers and body format</summary>
        <div className="space-y-4 pt-3">
          <SelectAt
            path={`${path}.bodyFormat`}
            label="Body format"
            fallback="json"
            options={[
              { value: 'json', label: 'JSON' },
              { value: 'form', label: 'Form (x-www-form-urlencoded)' },
            ]}
          />
          <RowsAt path={`${path}.query`} keyLabel="Parameter" valueLabel="Value" addLabel="Add parameter" />
          <RowsAt path={`${path}.headers`} keyLabel="Header" valueLabel="Value" addLabel="Add header" />
        </div>
      </details>
    </Optional>
  );
}

// ---------------------------------------------------------------------------
// Sections

const AUTH_TYPES = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'API key in a header' },
  { value: 'basic', label: 'Username and password' },
  { value: 'oauth2', label: 'OAuth 2.0 client credentials' },
  { value: 'query', label: 'API key in the URL' },
];

const AUTH_DEFAULTS: Record<string, Doc> = {
  bearer: { type: 'bearer' },
  header: { type: 'header', header: 'X-Api-Key' },
  basic: { type: 'basic', username: '' },
  oauth2: { type: 'oauth2', tokenUrl: 'https://', clientId: '' },
  query: { type: 'query', param: 'api_key' },
};

function ConnectionSection() {
  return (
    <Section title="Connection" prefixes={['name', 'baseUrl', 'headers', 'timeoutMs', 'allowPrivateAddresses', 'naming']}>
      <Grid>
        <TextAt path="name" label="Application name" placeholder="Acme HR" />
        <TextAt path="baseUrl" label="API base URL" placeholder="https://api.example.com/v1" mono />
        <TextAt path="timeoutMs" label="Timeout (ms)" placeholder="60000" number />
        <SelectAt
          path="naming.allow"
          label="Account names"
          fallback="sam"
          options={[
            { value: 'sam', label: 'Short names (a-z, 0-9, . and -)' },
            { value: 'email', label: 'Email addresses' },
          ]}
        />
        <TextAt path="naming.maxLength" label="Longest account name" placeholder="No limit" number />
      </Grid>
      <CheckAt path="allowPrivateAddresses" label="Allow private network addresses" />
      <div className="space-y-2">
        <span className="font-medium text-ink">Headers on every request</span>
        <RowsAt path="headers" keyLabel="Header" valueLabel="Value" addLabel="Add header" keyPlaceholder="User-Agent" />
      </div>
    </Section>
  );
}

function AuthSection() {
  const { doc, update } = useBuilder();
  const type = textAt(doc, 'auth.type') || 'bearer';
  return (
    <Section title="Sign-in" prefixes={['auth']}>
      <Select
        label="How Syntra signs in"
        name="auth.type"
        value={type}
        options={AUTH_TYPES}
        onChange={(v) => update(setAt(doc, 'auth', AUTH_DEFAULTS[v]))}
      />
      <Grid>
        {type === 'header' && (
          <>
            <TextAt path="auth.header" label="Header name" placeholder="X-Api-Key" mono />
            <TextAt path="auth.prefix" label="Before the key" placeholder="Token " mono />
          </>
        )}
        {type === 'basic' && <TextAt path="auth.username" label="Username" />}
        {type === 'query' && <TextAt path="auth.param" label="Parameter name" placeholder="api_key" mono />}
        {type === 'oauth2' && (
          <>
            <TextAt path="auth.tokenUrl" label="Token URL" placeholder="https://login.example.com/oauth/token" mono />
            <TextAt path="auth.clientId" label="Client ID" mono />
            <TextAt path="auth.scope" label="Scope" mono />
            <SelectAt
              path="auth.clientAuth"
              label="Send client secret"
              fallback="body"
              options={[
                { value: 'body', label: 'In the request body' },
                { value: 'basic', label: 'As HTTP Basic' },
              ]}
            />
          </>
        )}
      </Grid>
      {type === 'oauth2' && (
        <RowsAt path="auth.tokenParams" keyLabel="Token parameter" valueLabel="Value" addLabel="Add token parameter" keyPlaceholder="audience" />
      )}
    </Section>
  );
}

function AccountsReadSection() {
  return (
    <Section
      title="Reading accounts"
      prefixes={['account.list', 'account.anchorAt', 'account.correlationAt', 'account.enabledWhen', 'account.exclude', 'account.find', 'account.read', 'account.provenance', 'account.createsEnabled']}
    >
      <ListEditor path="account.list" pathPlaceholder="/users" />
      <Grid>
        <TextAt path="account.anchorAt" label="Account id at" placeholder="id" mono />
        <TextAt path="account.correlationAt" label="Account name at" placeholder="username" mono />
        <TextAt path="account.enabledWhen.at" label="Enabled when field" placeholder="status" mono />
        <TextAt path="account.enabledWhen.equals" label="Equals" placeholder="active" mono />
      </Grid>
      <Optional path="account.read" label="Read one account by id" initial={{ path: '/users/{{anchor}}' }}>
        <Grid>
          <TextAt path="account.read.path" label="Path" placeholder="/users/{{anchor}}" mono />
          <TextAt path="account.read.itemAt" label="Account at" placeholder="Leave empty when the body is the account" mono />
        </Grid>
      </Optional>
      <Optional path="account.find" label="Look up an account by name before creating" initial={{ path: '/users', query: { username: '{{correlationKey}}' } }}>
        <ListEditor path="account.find" pathPlaceholder="/users" />
      </Optional>
      <Optional path="account.provenance" label="Mark accounts Syntra creates" initial={{ kind: 'scalar', path: 'externalId' }}>
        <Grid>
          <TextAt path="account.provenance.path" label="Field holding the mark" placeholder="externalId" mono />
        </Grid>
      </Optional>
    </Section>
  );
}

function FieldMappingSection() {
  return (
    <Section title="Field mapping" prefixes={['account.fields']}>
      <datalist id="syntra-attributes">
        {ATTRIBUTE_SUGGESTIONS.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <RowsAt
        path="account.fields"
        keyLabel="Field in the application"
        valueLabel="Syntra attribute"
        addLabel="Add field"
        valueList="syntra-attributes"
        keyPlaceholder="first_name"
        valuePlaceholder="givenName"
      />
    </Section>
  );
}

function AccountChangesSection() {
  return (
    <Section title="Account changes" prefixes={['account.create', 'account.update', 'account.enable', 'account.disable', 'account.archive', 'account.rename']}>
      <table className="w-full text-sm">
        <caption className="sr-only">Placeholders</caption>
        <tbody>
          {PLACEHOLDERS.map((p) => (
            <tr key={p.token}>
              <td className="py-0.5 pr-4 font-mono">{p.token}</td>
              <td className="py-0.5 text-muted">{p.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <CheckAt path="account.createsEnabled" label="New accounts are always enabled" />
      <WriteEditor path="account.create" label="Create accounts" methods={ACCOUNT_METHODS} initial={{ method: 'POST', path: '/users' }} anchorAt fillFrom="account.fields" />
      <WriteEditor path="account.update" label="Update accounts" methods={ACCOUNT_METHODS} initial={{ method: 'PATCH', path: '/users/{{anchor}}' }} fillFrom="account.fields" />
      <WriteEditor path="account.enable" label="Enable accounts" methods={ACCOUNT_METHODS} initial={{ method: 'PATCH', path: '/users/{{anchor}}', body: { active: true } }} />
      <WriteEditor path="account.disable" label="Disable accounts" methods={ACCOUNT_METHODS} initial={{ method: 'PATCH', path: '/users/{{anchor}}', body: { active: false } }} />
      <WriteEditor path="account.rename" label="Rename accounts" methods={ACCOUNT_METHODS} initial={{ method: 'PATCH', path: '/users/{{anchor}}', body: { username: '{{correlationKey}}' } }} />
      <WriteEditor path="account.archive" label="Archive accounts" methods={ACCOUNT_METHODS} initial={{ method: 'PATCH', path: '/users/{{anchor}}' }} />
    </Section>
  );
}

function GroupsSection() {
  return (
    <Section title="Groups and roles" prefixes={['entitlement']} open={false}>
      <Optional
        path="entitlement"
        label="This application has groups, roles or licences"
        initial={{ list: { path: '/groups', paging: { style: 'none' } }, anchorAt: 'id', displayNameAt: 'name', type: 'group' }}
      >
        <SelectAt
          path="entitlement.type"
          label="They are"
          fallback="group"
          options={[
            { value: 'group', label: 'Groups' },
            { value: 'role', label: 'Roles' },
            { value: 'licence', label: 'Licences' },
          ]}
        />
        <ListEditor path="entitlement.list" pathPlaceholder="/groups" />
        <Grid>
          <TextAt path="entitlement.anchorAt" label="Id at" placeholder="id" mono />
          <TextAt path="entitlement.displayNameAt" label="Name at" placeholder="name" mono />
          <TextAt path="entitlement.descriptionAt" label="Description at" placeholder="description" mono />
        </Grid>
        <Optional
          path="entitlement.members"
          label="Read members"
          initial={{ path: '/groups/{{entitlementId}}/members', memberAnchorAt: 'id', paging: { style: 'none' } }}
        >
          <ListEditor path="entitlement.members" pathPlaceholder="/groups/{{entitlementId}}/members" />
          <TextAt path="entitlement.members.memberAnchorAt" label="Member's account id at" placeholder="id" mono />
        </Optional>
        <WriteEditor
          path="entitlement.grant"
          label="Add members"
          methods={MEMBERSHIP_METHODS}
          initial={{ method: 'POST', path: '/groups/{{entitlementId}}/members', body: { id: '{{anchor}}' } }}
        />
        <WriteEditor
          path="entitlement.revoke"
          label="Remove members"
          methods={MEMBERSHIP_METHODS}
          initial={{ method: 'DELETE', path: '/groups/{{entitlementId}}/members/{{anchor}}' }}
          noBody
        />
      </Optional>
    </Section>
  );
}

function ErrorsSection() {
  return (
    <Section title="Errors" prefixes={['failures']} open={false}>
      <Grid>
        <ListAt path="failures.unauthorized" label="Not allowed" placeholder="401, 403" numeric />
        <ListAt path="failures.notFound" label="Not found" placeholder="404" numeric />
        <ListAt path="failures.conflict" label="Already exists" placeholder="409" numeric />
        <ListAt path="failures.throttled" label="Too many requests" placeholder="429" numeric />
      </Grid>
      <Optional path="failures.body" label="Errors arrive with 200 OK" initial={{ at: 'status', equals: 'error' }}>
        <Grid>
          <TextAt path="failures.body.at" label="Error flag at" placeholder="status" mono />
          <TextAt path="failures.body.equals" label="Equals" placeholder="error" mono />
          <TextAt path="failures.body.messageAt" label="Message at" placeholder="messages" mono />
          <ListAt path="failures.body.conflictWhen" label="Already exists when the message contains" placeholder="already been taken" />
          <ListAt path="failures.body.notFoundWhen" label="Not found when the message contains" placeholder="not found" />
        </Grid>
      </Optional>
      <Optional path="failures.error" label="Read the message of a 4xx error" initial={{ messageAt: 'message' }}>
        <Grid>
          <TextAt path="failures.error.messageAt" label="Message at" placeholder="message" mono />
          <ListAt path="failures.error.conflictWhen" label="Already exists when the message contains" placeholder="already exists" />
          <ListAt path="failures.error.notFoundWhen" label="Not found when the message contains" placeholder="not found" />
        </Grid>
      </Optional>
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function ConnectorBuilder({
  document,
  onChange,
  errors,
}: {
  document: Doc;
  onChange(next: Doc): void;
  /** Schema problems by document path, e.g. `account.list.path`. */
  errors: Record<string, string>;
}) {
  const problems = Object.entries(errors);
  return (
    <BuilderContext.Provider value={{ doc: document, update: onChange, errors }}>
      <div className="space-y-3">
        {problems.length > 0 && (
          <Alert tone="danger" title={problems.length === 1 ? '1 problem in the connector' : `${problems.length} problems in the connector`}>
            <ul className="space-y-0.5">
              {problems.map(([path, message]) => (
                <li key={path}>
                  <code>{path || 'document'}</code>: {message}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        <ConnectionSection />
        <AuthSection />
        <AccountsReadSection />
        <FieldMappingSection />
        <AccountChangesSection />
        <GroupsSection />
        <ErrorsSection />
      </div>
    </BuilderContext.Provider>
  );
}
