import { Link } from 'react-router-dom';
import {
  Alert,
  buttonClasses,
  Empty,
  Panel,
  SkeletonRows,
  StateBadge,
  Status,
  Table,
  type State,
} from '@syntra/ui';
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

/** A draft is not yet a product anyone can ask for; a retired one is off on purpose. */
const PRODUCT_STATE: Record<string, State> = {
  active: 'healthy',
  draft: 'setup',
  retired: 'inactive',
  archived: 'inactive',
};

export function CatalogTab() {
  const { data, error, loading } = useApiResource<{ products: ProductRow[] }>(
    '/api/admin/automate/products',
  );

  return (
    <>
      {/* The action sits with the table it acts on. One header above
          several tabs would need a word saying which tab its button
          applied to. */}
      {/* On an empty catalog the empty state carries this instead. */}
      {(data?.products ?? []).length > 0 && (
        <div className="mb-4 flex justify-end">
          <Link to="/admin/automate/products/new" className={buttonClasses('primary')}>
            New product
          </Link>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel>
          {!data && loading && <SkeletonRows rows={5} cols={4} />}
          {data && (data.products ?? []).length === 0 && (
            <div className="p-6">
              <Empty
                title="No products yet"
                action={
                  <Link to="/admin/automate/products/new" className={buttonClasses('primary')}>
                    New product
                  </Link>
                }
              >
                A product is one thing somebody may ask for. Until one is
                published and given an audience, the catalog is empty for
                everybody.
              </Empty>
            </div>
          )}
          {data && (data.products ?? []).length > 0 && (
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
              <tbody>
                {data.products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <Link
                        to={`/admin/automate/products/${product.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {product.name}
                      </Link>
                    </td>
                    <td>{product.kind}</td>
                    <td>
                      {/* A product with no audience is visible to nobody, and
                          the list says so rather than leaving a blank cell. */}
                      {product.audienceCondition === null ? (
                        <StateBadge state="attention">Nobody</StateBadge>
                      ) : (
                        <Status tone="neutral">An audience rule</Status>
                      )}
                    </td>
                    <td>
                      <StateBadge state={PRODUCT_STATE[product.status] ?? 'setup'}>
                        {product.status.charAt(0).toUpperCase() + product.status.slice(1)}
                      </StateBadge>
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
