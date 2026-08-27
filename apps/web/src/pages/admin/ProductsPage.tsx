import { Link } from 'react-router-dom';
import { Alert, Empty, Panel, SkeletonRows, Status, Table } from '@syntra/ui';
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
            <Table>
              <thead>
                <tr>
                  <th scope="col">
                    Name
                  </th>
                  <th scope="col">
                    Kind
                  </th>
                  <th scope="col">
                    Visible to
                  </th>
                  <th scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data!.products.map((product) => (
                  <tr key={product.id}>
                    <td className="py-3">
                      <Link
                        to={`/admin/automate/products/${product.id}`}
                        className="text-ink hover:text-primary"
                      >
                        {product.name}
                      </Link>
                    </td>
                    <td className="py-3">{product.kind}</td>
                    <td className="py-3">
                      {/* A product with no audience is visible to nobody, and
                          the list says so rather than leaving a blank cell. */}
                      {product.audienceCondition === null ? (
                        <Status tone="warning">Nobody</Status>
                      ) : (
                        <Status tone="neutral">An audience rule</Status>
                      )}
                    </td>
                    <td className="py-3">
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
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
