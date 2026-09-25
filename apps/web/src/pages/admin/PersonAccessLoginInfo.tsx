import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Select, Table, useToast } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

type Recipient = 'profile' | 'personalEmail' | 'manager' | 'admin';

interface PickupRow {
  id: string;
  recipientKind: string;
  createdAt: string;
  expiresAt: string;
  viewedAt: string | null;
  revokedAt: string | null;
  state: 'ready' | 'used' | 'expired' | 'revoked';
}

interface History {
  hasInitialSecret: boolean;
  pickups: PickupRow[];
}

const RECIPIENT_LABELS: Record<string, string> = {
  personalEmail: 'Personal email',
  manager: 'Manager',
  admin: 'Administrator',
};

const when = (iso: string) => new Date(iso).toLocaleString();

/** What happened to a link, as one cell. */
function outcome(row: PickupRow): string {
  if (row.state === 'used' && row.viewedAt) return `Viewed ${when(row.viewedAt)}`;
  if (row.state === 'revoked' && row.revokedAt) return `Revoked ${when(row.revokedAt)}`;
  if (row.state === 'expired') return `Expired ${when(row.expiresAt)}`;
  return `Unopened, expires ${when(row.expiresAt)}`;
}

/**
 * "Send login info" for one target account, and the links already sent.
 *
 * What goes out is a one-time link to the sealed initial password, never the
 * password. Sending revokes every link nobody has opened, so there is only
 * ever one that works. The server demands a freshly elevated session; when it
 * refuses for that reason, the answer here is a way to elevate and come
 * straight back, as the tenant-wide session revoke does.
 */
export function LoginInfo({
  personId,
  targetSystemId,
}: {
  personId: string;
  targetSystemId: string;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const base = `/api/admin/targets/${targetSystemId}/accounts/${personId}`;
  // Read only by somebody who may see it. Most of this page's readers hold
  // provision.read; the ones who do not are spared a panel of refusals.
  const history = useApiResource<History>(
    can('provision.read') ? `${base}/credential-pickups` : null,
  );
  const [recipient, setRecipient] = useState<Recipient>('profile');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);

  const data = history.data && Array.isArray(history.data.pickups) ? history.data : null;
  if (data === null) return null;

  async function send() {
    setBusy(true);
    setProblem(null);
    setStepUp(null);
    try {
      const result = await api<{ delivered: boolean; revoked: number }>(`${base}/send-login-info`, {
        method: 'POST',
        body: JSON.stringify({ recipient }),
      });
      toast(
        result.delivered
          ? { tone: 'success', title: 'Login info sent' }
          : { tone: 'warning', title: 'The link was created but the mail was not accepted' },
      );
      history.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'step-up-required') {
        setStepUp(cause.problem.detail ?? cause.problem.title);
      } else {
        setProblem(
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'The login info was not sent.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border-subtle p-4">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-sm font-medium text-muted">Login info</span>
        {can('provision.manage') && data.hasInitialSecret && (
          <>
            <Select
              name="recipient"
              label="Send to"
              value={recipient}
              onChange={(v) => setRecipient(v as Recipient)}
              options={[
                { value: 'profile', label: 'As the account profile says' },
                { value: 'personalEmail', label: "The person's personal email" },
                { value: 'manager', label: 'Their manager' },
                { value: 'admin', label: 'Me' },
              ]}
            />
            <Button variant="secondary" loading={busy} onClick={() => void send()}>
              Send login info
            </Button>
          </>
        )}
        {!data.hasInitialSecret && (
          <span className="text-sm text-muted">No initial password held</span>
        )}
      </div>

      {problem && <Alert tone="danger">{problem}</Alert>}
      {stepUp && (
        <Alert tone="warning" title="Confirm it is you first">
          <p>{stepUp}</p>
          <Button
            type="button"
            onClick={() => navigate('/elevate', { state: { from: location } })}
            className="mt-3"
          >
            Elevate again
          </Button>
        </Alert>
      )}

      {data.pickups.length > 0 && (
        <Table tight label="Login info sent">
          <thead>
            <tr>
              <th scope="col">Sent</th>
              <th scope="col">To</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data.pickups.map((row) => (
              <tr key={row.id}>
                <td className="tabular-nums">{when(row.createdAt)}</td>
                <td>{RECIPIENT_LABELS[row.recipientKind] ?? row.recipientKind}</td>
                <td className="tabular-nums">{outcome(row)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
