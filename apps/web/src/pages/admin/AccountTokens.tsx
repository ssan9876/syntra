import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** "4 minutes ago", in the unit somebody thinks in reading a list. */
function since(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The machine credentials an account holds.
 *
 * Two things on this screen are load-bearing rather than decorative.
 *
 * The token is shown ONCE, in the treatment `ApplicationSso` already uses for
 * a client secret, because it is the same event and a second visual language
 * for it would teach people that one of them is less final than it is.
 *
 * And **when it was last used** is a column rather than a detail. A credential
 * nobody can tell is unused is a credential nobody ever revokes, and the
 * dormant integration nobody remembers is the one worth finding.
 */
export function AccountTokens({ userId }: { userId: string }) {
  const { data, error, loading, reload } = useApiResource<{ tokens: TokenRow[] }>(
    `/api/admin/users/${userId}/tokens`,
  );
  const can = useCan();
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tokens = data?.tokens ?? [];
  const mayManage = can('token.manage');

  async function issue() {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Ninety days. The API invents no default -- a lifetime is a policy
        // somebody states -- so the suggestion lives here, where somebody is
        // looking at it and can change it.
        body: JSON.stringify({
          name: name.trim(),
          scopes: [],
          expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        }),
      });
      if (!res.ok) {
        setFailure('That token could not be issued.');
        return;
      }
      const body = (await res.json()) as { token: string };
      setIssued(body.token);
      setName('');
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setFailure(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/tokens/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setFailure('That token could not be revoked.');
        return;
      }
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="API tokens" bodyClassName="p-4">
      {error && <Alert tone="danger">Could not load tokens.</Alert>}
      {failure && <Alert tone="danger">{failure}</Alert>}

      {issued && (
        <Alert tone="warning" title="New API token">
          <code className="mt-1 block break-all font-mono text-sm">{issued}</code>
          Copy it into the integration now. It is not shown again.
        </Alert>
      )}

      {loading && <SkeletonRows rows={2} />}

      {!loading && tokens.length === 0 && (
        <Empty title="No API tokens">
          A token lets a program act as this account, with this account&rsquo;s
          permissions and no more.
        </Empty>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">{token.name}</div>
                <div className="text-xs text-muted">
                  {token.lastUsedAt === null
                    ? 'never used'
                    : `last used ${since(token.lastUsedAt)}`}
                  {' · '}
                  {token.expiresAt === null
                    ? 'never expires'
                    : `expires ${new Date(token.expiresAt).toLocaleDateString()}`}
                  {token.scopes.length > 0 && ` · ${token.scopes.length} scope(s)`}
                </div>
              </div>
              {mayManage && (
                <Button
                  variant="danger-quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() => void revoke(token.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {mayManage && (
        <div className="mt-4 flex items-end gap-2 border-t border-border-subtle pt-4">
          <div className="flex-1">
            <Field
              label="New token"
              value={name}
              onChange={setName}
              placeholder="SCIM from Workday"
            />
          </div>
          <Button disabled={busy || name.trim() === ''} onClick={() => void issue()}>
            Issue
          </Button>
        </div>
      )}
    </Panel>
  );
}
