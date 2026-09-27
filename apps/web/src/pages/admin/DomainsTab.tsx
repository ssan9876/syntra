import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, RowActions, SkeletonRows, Status, Table, useToast } from '@syntra/ui';
import { DeleteButton } from './DeleteButton.js';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';

export interface EmailDomain {
  id: string;
  domain: string;
  record: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  createdAt: string;
}

const problemText = (cause: unknown, fallback: string) =>
  cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;

/**
 * The domains this organisation may put in an address.
 *
 * Only a verified domain, or a subdomain of one, can appear in a business
 * email typed here, an account name or `mail` a profile generates, or an
 * Entra userPrincipalName. The table is the whole workflow: add a domain, copy
 * its TXT record into DNS, press Verify.
 */
export function DomainsTab() {
  const { data, error, loading, reload } = useApiResource<EmailDomain[]>('/api/admin/email-domains');
  const [domain, setDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const toast = useToast();

  const domains = data ?? [];

  async function add() {
    setAdding(true);
    setAddError(undefined);
    try {
      const created = await api<EmailDomain>('/api/admin/email-domains', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
      setDomain('');
      toast({ tone: 'success', title: `${created.domain} added` });
      reload();
    } catch (cause) {
      setAddError(problemText(cause, 'The domain was not added.'));
    } finally {
      setAdding(false);
    }
  }

  async function verify(row: EmailDomain) {
    setBusy(row.id);
    setFailure(null);
    try {
      const checked = await api<EmailDomain>(`/api/admin/email-domains/${row.id}/verify`, { method: 'POST' });
      if (checked.verifiedAt) toast({ tone: 'success', title: `${checked.domain} verified` });
      else setFailure(checked.lastCheckError ?? `${checked.domain} is not verified yet.`);
      reload();
    } catch (cause) {
      setFailure(problemText(cause, 'The domain could not be checked.'));
    } finally {
      setBusy(null);
    }
  }

  async function copy(record: string) {
    try {
      await navigator.clipboard.writeText(record);
      toast({ tone: 'success', title: 'Record copied' });
    } catch {
      setFailure('Copy the record by hand; the browser refused the clipboard.');
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div aria-live="polite">{failure && <Alert tone="warning">{failure}</Alert>}</div>
      {!error && !loading && !domains.some((d) => d.verifiedAt) && (
        <Alert tone="warning">
          No domain is verified, so no address can be entered or provisioned until one is.
        </Alert>
      )}

      <Panel title="Add a domain">
        <form
          className="flex flex-wrap items-end gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (domain.trim() !== '') void add();
          }}
        >
          <div className="min-w-64 flex-1">
            <Field label="Domain" value={domain} onChange={setDomain} placeholder="contoso.com" error={addError} />
          </div>
          <Button type="submit" variant="primary" loading={adding} disabled={domain.trim() === ''}>
            Add domain
          </Button>
        </form>
      </Panel>

      {!error && (
        <Panel title="Domains">
          {loading && <SkeletonRows rows={2} cols={3} />}
          {!loading && domains.length === 0 && (
            <div className="p-6">
              <Empty title="No domains yet" />
            </div>
          )}
          {!loading && domains.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Domain</th>
                  <th scope="col">State</th>
                  <th scope="col">TXT record at the domain</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {domains.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium text-ink">{row.domain}</td>
                    <td>
                      {row.verifiedAt ? (
                        <Status tone="active" glyph="check">
                          Verified
                        </Status>
                      ) : (
                        <Status tone="warning" glyph="clock">
                          Not verified
                        </Status>
                      )}
                    </td>
                    <td>
                      <code className="break-all font-mono text-sm text-muted">{row.record}</code>
                    </td>
                    <td>
                      <RowActions
                        destructive={
                          <DeleteButton
                            path={`/api/admin/email-domains/${row.id}`}
                            label="domain"
                            confirmWord={row.domain}
                            warning="Addresses in this domain are refused from then on, and provisioning stops writing them."
                            onDeleted={reload}
                          />
                        }
                      >
                        {!row.verifiedAt && (
                          <>
                            <Button variant="ghost" onClick={() => void copy(row.record)}>
                              Copy record
                            </Button>
                            <Button variant="ghost" loading={busy === row.id} onClick={() => void verify(row)}>
                              Verify
                            </Button>
                          </>
                        )}
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}
    </div>
  );
}
