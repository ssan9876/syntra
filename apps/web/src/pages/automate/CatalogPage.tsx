import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Empty, Field, Panel, SkeletonRows, Status } from "@syntra/ui";
import { AppShell } from "../../components/AppShell.js";
import { useApiResource } from "../../session/use-api-resource.js";

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
}

function durationLine(entry: CatalogEntry): string {
  if (entry.durationMode === "permanent")
    return "Held until somebody takes it away";
  if (entry.durationMode === "fixed") return "Held for a fixed period";
  return `You choose how long, up to ${entry.maxDurationDays ?? 0} days`;
}

export function CatalogPage() {
  const [query, setQuery] = useState("");
  const { data, error, loading } = useApiResource<{ products: CatalogEntry[] }>(
    "/api/portal/automate/catalog",
  );

  const products = (data?.products ?? []).filter((p) =>
    query.trim() === ""
      ? true
      : `${p.name} ${p.description ?? ""} ${p.category ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
  );
  const categories = [
    ...new Set(products.map((p) => p.category ?? "Everything else")),
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
            <div className="mt-6 max-w-md">
              <Field label="Search" value={query} onChange={setQuery} />
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
                          (p) => (p.category ?? "Everything else") === category,
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
                                  product.needsApproval ? "primary" : "active"
                                }
                              >
                                {product.needsApproval
                                  ? "Needs approval"
                                  : "Granted immediately"}
                              </Status>
                              <span>{durationLine(product)}</span>
                            </p>
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
