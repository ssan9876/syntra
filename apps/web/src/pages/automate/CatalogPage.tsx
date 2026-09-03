import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Empty,
  ListControls,
  Panel,
  SkeletonRows,
  Status,
} from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface SodWarning {
  violations: {
    ruleId: string;
    ruleName: string;
    severity: string;
    otherSideHoldings: string[];
  }[];
  hasCritical: boolean;
  hasActiveException: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  kind: string;
  durationMode: string;
  maxDurationDays: number | null;
  needsApproval: boolean;
  /** Null when there is nothing to say, which is the common case. */
  sodWarning?: SodWarning | null;
}

/**
 * The segregation-of-duties warning, at the moment somebody could still choose
 * differently.
 *
 * It WARNS and never blocks: the link into the request form stays exactly
 * where it was, and the form's submit button stays enabled. A catalog that
 * greyed the entry out would tell somebody they may not have something without
 * telling them why, which is the failure spec section 14 names. The refusal,
 * when there is one, happens at eligibility with a reason the requester can
 * read.
 */
export function SodWarningNote({ warning }: { warning: SodWarning }) {
  const first = warning.violations[0];
  if (first === undefined) return null;
  const held = first.otherSideHoldings.filter((h) => h.trim() !== '');
  return (
    <Alert tone="warning">
      <span className="font-medium">Segregation of duties.</span> Requesting
      this would put you on both sides of “{first.ruleName}”.
      {held.length > 0 && (
        <> You already hold <span className="font-medium">{held.join(', ')}</span>.</>
      )}{' '}
      You can still request it; an approver sees the same warning
      {first.severity === 'critical'
        ? ', and a critical rule needs an approved exception before it can be fulfilled'
        : ''}
      .
    </Alert>
  );
}

function durationLine(entry: CatalogEntry): string {
  if (entry.durationMode === 'permanent')
    return 'Held until somebody takes it away';
  if (entry.durationMode === 'fixed') return 'Held for a fixed period';
  return `You choose how long, up to ${entry.maxDurationDays ?? 0} days`;
}

export function CatalogPage() {
  const [query, setQuery] = useState('');
  const { data, error, loading } = useApiResource<{ products: CatalogEntry[] }>(
    '/api/portal/automate/catalog',
  );

  const products = (data?.products ?? []).filter((p) =>
    query.trim() === ''
      ? true
      : `${p.name} ${p.description ?? ''} ${p.category ?? ''}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
  );
  const categories = [
    ...new Set(products.map((p) => p.category ?? 'Everything else')),
  ];

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">What can I ask for?</h1>
        <p className="mt-1 text-muted">
          Everything here is something you are allowed to request. Asking for it
          does not grant it — most things go to somebody who decides.
        </p>

        {error && (
          <div className="mt-6">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}

        {!error && (
          <>
            {/* The same control as every other list in the product, rather
                than a bare box: it debounces, it names the fields it looks at,
                and a search that behaves differently here would be a second
                convention on a screen an employee sees for four seconds. */}
            <div className="mt-6 max-w-md">
              <ListControls
                search={query}
                onSearch={setQuery}
                searchLabel="Search"
                searchPlaceholder="Name, description or category"
              />
            </div>

            {loading && (
              <div className="mt-6">
                <Panel>
                  <SkeletonRows rows={4} cols={3} />
                </Panel>
              </div>
            )}

            {!loading && products.length === 0 && (
              <div className="mt-6">
                <Empty title="Nothing to ask for yet">
                  Either nothing has been published to you, or your search
                  matched nothing. This is not an error.
                </Empty>
              </div>
            )}

            {!loading &&
              categories.map((category) => (
                <div key={category} className="mt-6">
                  <Panel title={category}>
                    <ul className="divide-y divide-border-subtle">
                      {products
                        .filter(
                          (p) => (p.category ?? 'Everything else') === category,
                        )
                        .map((product) => (
                          <li key={product.id} className="px-4 py-3">
                            <Link
                              to={`/catalog/${product.id}`}
                              className="font-medium text-ink hover:text-primary"
                            >
                              {product.name}
                            </Link>
                            {product.description && (
                              <p className="mt-0.5 text-muted">
                                {product.description}
                              </p>
                            )}
                            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                              <Status
                                tone={
                                  product.needsApproval ? 'primary' : 'active'
                                }
                              >
                                {product.needsApproval
                                  ? 'Needs approval'
                                  : 'Granted immediately'}
                              </Status>
                              <span>{durationLine(product)}</span>
                            </p>
                            {product.sodWarning != null && (
                              <div className="mt-2">
                                <SodWarningNote warning={product.sodWarning} />
                              </div>
                            )}
                          </li>
                        ))}
                    </ul>
                  </Panel>
                </div>
              ))}
          </>
        )}
      </div>
    </AppShell>
  );
}
