import { Fragment, useState } from 'react';
import {
  Alert,
  Button,
  Check,
  Empty,
  Field,
  Panel,
  RowActions,
  SkeletonRows,
  Status,
  Table,
} from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { DeleteButton } from './DeleteButton.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

/**
 * The six things an endpoint can subscribe to.
 *
 * Named for what happened, not for the template that says it. There are
 * thirty-odd templates behind these; a screen offering all thirty, or a text
 * box taking `automate-*`, would be a control that needs a paragraph beside it
 * to be usable — which means it is the wrong control.
 *
 * The hints are the one place text belongs: they say what arrives, which is
 * the consequence of ticking the box and is not visible from the label.
 */
const GROUPS = [
  {
    key: 'access-requests',
    label: 'Access requests',
    hint: 'Somebody asked for access, or their request was decided.',
  },
  {
    key: 'approvals',
    label: 'Approvals waiting',
    hint: 'A request needs somebody to decide, or has been waiting too long.',
  },
  {
    key: 'fulfilment',
    label: 'Fulfilment',
    hint: 'Approved access being granted in the target system, or failing to be.',
  },
  {
    key: 'grant-lifecycle',
    label: 'Access ending',
    hint: 'Access about to expire, expired, or swept away.',
  },
  {
    key: 'access-reviews',
    label: 'Access reviews',
    hint: 'Certification campaigns and the reviewers assigned to them.',
  },
  {
    key: 'findings',
    label: 'Governance findings',
    hint: 'Separation-of-duties breaches and expiring exceptions.',
  },
] as const;

const LABELS = new Map(GROUPS.map((g) => [g.key as string, g.label]));

interface Endpoint {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  events: string[];
  pending: number;
  failing: number;
  lastFailureAt: string | null;
}

interface Delivery {
  id: string;
  event: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  state: 'delivered' | 'queued' | 'failed';
}

const when = (iso: string) => new Date(iso).toLocaleString();

export function WebhooksPage() {
  const { data, error, loading, reload } = useApiResource<{ endpoints: Endpoint[] }>(
    '/api/admin/webhooks',
  );
  const [adding, setAdding] = useState(false);
  /** Shown once, after a create or a rotate. There is no way to read it back. */
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const endpoints = data?.endpoints ?? [];

  async function act(id: string, run: () => Promise<void>) {
    setBusy(id);
    setFailure(null);
    try {
      await run();
      reload();
    } catch (cause) {
      setFailure(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Send what happens here to another system, signed so it can tell the message is genuine."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            New endpoint
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {failure && <Alert tone="danger">{failure}</Alert>}

      {issued && (
        <SecretPanel
          name={issued.name}
          secret={issued.secret}
          onDone={() => setIssued(null)}
        />
      )}

      {adding && (
        <EndpointForm
          onCancel={() => setAdding(false)}
          onCreated={(endpoint, secret) => {
            setAdding(false);
            setIssued({ name: endpoint.name, secret });
            reload();
          }}
        />
      )}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={3} cols={4} />}
          {!loading && endpoints.length === 0 && !adding && (
            <div className="p-6">
              <Empty title="Nothing is subscribed">
                An endpoint receives a signed message each time Syntra notifies
                somebody — so a ticketing system, a chat channel or a data
                warehouse can act on it too.
              </Empty>
            </div>
          )}

          {!loading && endpoints.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Sends</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {endpoints.map((endpoint) => (
                  // A keyed Fragment, not `<>`: a row and its activity panel
                  // are two siblings for one endpoint, and a bare fragment
                  // carries no key for React to reconcile them by.
                  <Fragment key={endpoint.id}>
                    <tr>
                      <td>
                        <div className="font-medium text-ink">{endpoint.name}</div>
                        <div className="font-mono text-sm text-muted">{endpoint.url}</div>
                      </td>
                      <td>
                        {endpoint.events.length === 0 ? (
                          <Status tone="neutral">Everything</Status>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {endpoint.events.map((event) => (
                              <Status key={event} tone="neutral">
                                {LABELS.get(event) ?? event}
                              </Status>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <Health endpoint={endpoint} />
                      </td>
                      <td>
                        <RowActions
                          destructive={
                            // The console's standard destruction control, and
                            // this is genuinely one: deleting an endpoint
                            // destroys its signing secret and every delivery
                            // still queued for it, and neither comes back.
                            <DeleteButton
                              path={`/api/admin/webhooks/${endpoint.id}`}
                              label="endpoint"
                              confirmWord={endpoint.name}
                              warning="The signing secret and anything still queued for this endpoint go with it. The receiving system will stop being told."
                              onDeleted={reload}
                            />
                          }
                        >
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setOpenDeliveries(
                                openDeliveries === endpoint.id ? null : endpoint.id,
                              )
                            }
                          >
                            {openDeliveries === endpoint.id ? 'Hide activity' : 'Activity'}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy === endpoint.id}
                            onClick={() =>
                              act(endpoint.id, async () => {
                                await api(`/api/admin/webhooks/${endpoint.id}`, {
                                  method: 'PUT',
                                  body: JSON.stringify({ enabled: !endpoint.enabled }),
                                });
                              })
                            }
                          >
                            {endpoint.enabled ? 'Pause' : 'Resume'}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy === endpoint.id}
                            onClick={() =>
                              act(endpoint.id, async () => {
                                const result = await api<{ secret: string }>(
                                  `/api/admin/webhooks/${endpoint.id}/secret`,
                                  { method: 'POST' },
                                );
                                setIssued({ name: endpoint.name, secret: result.secret });
                              })
                            }
                          >
                            New secret
                          </Button>
                        </RowActions>
                      </td>
                    </tr>
                    {openDeliveries === endpoint.id && (
                      <tr>
                        <td colSpan={4} className="bg-surface-2">
                          <Deliveries endpointId={endpoint.id} onChanged={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}

/**
 * One chip that says whether this integration is working.
 *
 * Three states, and the failing one wins: an endpoint with four delivered and
 * one abandoned needs the abandoned one read, and an average would hide it.
 */
function Health({ endpoint }: { endpoint: Endpoint }) {
  if (!endpoint.enabled) return <Status tone="neutral">Paused</Status>;
  if (endpoint.failing > 0) {
    return (
      <Status tone="danger">
        {endpoint.failing} not delivered
      </Status>
    );
  }
  if (endpoint.pending > 0) return <Status tone="warning">{endpoint.pending} queued</Status>;
  return <Status tone="active">Delivering</Status>;
}

/**
 * The secret, at the one moment it can still be copied somewhere useful.
 *
 * It is not stored anywhere this screen can read, so there is no second
 * chance and no "show again" — which is why the panel is a step to dismiss
 * rather than a line in a table. `New secret` issues another.
 */
function SecretPanel({
  name,
  secret,
  onDone,
}: {
  name: string;
  secret: string;
  onDone(): void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-4">
      <Panel>
      <div className="p-5">
        <h2 className="font-semibold text-ink">Signing secret for {name}</h2>
        <p className="mt-1 text-muted">
          Paste this into the receiving system now. It is not shown again.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-panel bg-surface-2 px-3 py-2 font-mono text-sm text-ink">
            {secret}
          </code>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(secret);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
      </Panel>
    </div>
  );
}

function EndpointForm({
  onCancel,
  onCreated,
}: {
  onCancel(): void;
  onCreated(endpoint: Endpoint, secret: string): void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      const created = await api<{ endpoint: Endpoint; secret: string }>(
        '/api/admin/webhooks',
        {
          method: 'POST',
          body: JSON.stringify({ name, url, enabled: true, events }),
        },
      );
      onCreated(created.endpoint, created.secret);
    } catch (cause) {
      setFields(fieldErrors(cause));
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string, on: boolean) =>
    setEvents((current) =>
      on ? [...current, key] : current.filter((entry) => entry !== key),
    );

  return (
    <div className="mb-4">
      <Panel>
      <form onSubmit={submit} noValidate className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            value={name}
            onChange={setName}
            required
            autoFocus
            {...(fields.name ? { error: fields.name } : {})}
          />
          <Field
            label="Address"
            value={url}
            onChange={setUrl}
            required
            placeholder="https://"
            {...(fields.url ? { error: fields.url } : {})}
          />
        </div>

        <fieldset>
          <legend className="font-medium text-ink">Send</legend>
          {/* Nothing ticked means everything, which is what the server does
              with an empty list. Said here as an option rather than left as a
              rule somebody has to know. */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {GROUPS.map((group) => (
              <Check
                key={group.key}
                checked={events.includes(group.key)}
                onChange={(on) => toggle(group.key, on)}
                label={group.label}
                hint={group.hint}
              />
            ))}
          </div>
          {events.length === 0 && (
            <p className="mt-3 text-sm text-muted">
              Nothing ticked sends everything.
            </p>
          )}
        </fieldset>

        {problem && <Alert tone="danger">{problem}</Alert>}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            Create and show secret
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
      </Panel>
    </div>
  );
}

/**
 * What this endpoint has been sent lately.
 *
 * The answer to "the integration stopped working", which is the only question
 * anybody opens this for. A delivery that has spent its attempts offers the
 * one action that helps.
 */
function Deliveries({
  endpointId,
  onChanged,
}: {
  endpointId: string;
  onChanged(): void;
}) {
  const { data, error, loading, reload } = useApiResource<{ deliveries: Delivery[] }>(
    `/api/admin/webhooks/${endpointId}/deliveries`,
  );
  const [busy, setBusy] = useState<string | null>(null);

  if (loading) return <SkeletonRows rows={3} cols={3} />;
  if (error) return <Alert tone="danger">{error}</Alert>;

  const deliveries = data?.deliveries ?? [];
  if (deliveries.length === 0) {
    return (
      <div className="p-5 text-muted">Nothing has been sent to this endpoint yet.</div>
    );
  }

  return (
    <div className="p-3">
      <Table tight>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">When</th>
            <th scope="col">Result</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td className="font-mono text-sm">{delivery.event}</td>
              <td className="whitespace-nowrap">{when(delivery.createdAt)}</td>
              <td>
                {delivery.state === 'delivered' && (
                  <Status tone="active">Delivered</Status>
                )}
                {delivery.state === 'queued' && (
                  <Status tone="warning">
                    Retrying at {when(delivery.nextAttemptAt)}
                  </Status>
                )}
                {delivery.state === 'failed' && (
                  <Status tone="danger">
                    {/* The receiver's status where there was one, and the
                        transport's own words where there was not. Never a
                        response body — see `httpPoster`. */}
                    {delivery.lastStatus !== null
                      ? `Refused with ${delivery.lastStatus}`
                      : (delivery.lastError ?? 'Not delivered')}
                  </Status>
                )}
              </td>
              <td>
                {delivery.state === 'failed' && (
                  <Button
                    variant="ghost"
                    disabled={busy === delivery.id}
                    onClick={async () => {
                      setBusy(delivery.id);
                      try {
                        await api(
                          `/api/admin/webhooks/${endpointId}/deliveries/${delivery.id}/retry`,
                          { method: 'POST' },
                        );
                        reload();
                        onChanged();
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Send again
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
