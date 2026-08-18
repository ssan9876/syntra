import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  audienceCondition: unknown | null;
  grants: { id: string }[];
}

export function ProductsPage() {
  const { data, error, loading } = useApiResource<{ products: ProductRow[] }>(
    '/api/admin/automate/products',
  );

  return (
    <>
      <PageHeader
        title="Catalog"
        description="What people may ask for, and who can see each one."
        actions={
          <Link to="/admin/automate/products/new" className="text-primary">
            New product
          </Link>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={5} cols={4} />}
          {!loading && (data?.products ?? []).length === 0 && (
            <div className="p-6">
              <Empty title="No products yet">
                A product is one thing somebody may ask for. Until one is
                published and given an audience, the catalog is empty for
                everybody.
              </Empty>
            </div>
          )}
          {!loading && (data?.products ?? []).length > 0 && (
            <table className="w-full text-left">
              <thead className="border-b border-border-subtle bg-surface-2">
                <tr className="text-sm text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Kind
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Visible to
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data!.products.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/automate/products/${product.id}`}
                        className="text-ink hover:text-primary"
                      >
                        {product.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{product.kind}</td>
                    <td className="px-4 py-3">
                      {/* A product with no audience is visible to nobody, and
                          the list says so rather than leaving a blank cell. */}
                      {product.audienceCondition === null ? (
                        <Status tone="warning">Nobody</Status>
                      ) : (
                        <Status tone="neutral">An audience rule</Status>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Status
                        tone={
                          product.status === 'active' ? 'active' : 'neutral'
                        }
                      >
                        {product.status}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
