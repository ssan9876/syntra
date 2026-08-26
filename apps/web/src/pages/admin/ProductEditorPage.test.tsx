import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductEditorPage } from './ProductEditorPage.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const product = {
  id: 'p1',
  name: 'AP approve',
  slug: 'ap-approve',
  description: 'Approving supplier invoices in the ledger.',
  category: 'Finance',
  iconUrl: null,
  requestInstructions: 'Say which company code you need.',
  kind: 'targetEntitlement',
  audienceCondition: { all: [] },
  workflowId: '11111111-1111-4111-8111-111111111111',
  formSchema: [{ key: 'code', type: 'text', label: 'Company code', required: true }],
  durationMode: 'fixed',
  defaultDurationDays: 90,
  maxDurationDays: 365,
  ownerPersonId: null,
  ownerGroupId: null,
  status: 'active',
  grants: [
    {
      id: 'g1',
      resourceType: 'entitlement',
      resourceId: '22222222-2222-4222-8222-222222222222',
      targetSystemId: null,
      optional: false,
    },
  ],
};

function mockApi() {
  const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PUT' || method === 'POST') {
      sent.push({ url, method, body: JSON.parse(String(init!.body)) });
      return Promise.resolve(json({}, 204));
    }
    if (url.includes('/automate/products/p1')) return Promise.resolve(json(product));
    if (url.includes('/automate/products')) return Promise.resolve(json({ products: [] }));
    if (url.includes('/automate/workflows')) return Promise.resolve(json({ workflows: [] }));
    return Promise.resolve(json({}));
  });
  return sent;
}

const renderEditor = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/automate/products/:id" element={<ProductEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the product editor loads what it edits', () => {
  it('fills the form from the product', async () => {
    mockApi();
    renderEditor('/admin/automate/products/p1');
    expect(await screen.findByDisplayValue('AP approve')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ap-approve')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('Approving supplier invoices in the ledger.'),
    ).toBeInTheDocument();
  });

  /**
   * THE ONE THAT MATTERS. `PUT` replaces the whole object, and the editor sent
   * defaults for every field it never loaded -- so fixing a typo in the name
   * wiped the description, the category, the grants, the form schema and the
   * duration mode. A catalog entry could be destroyed by editing it.
   */
  it('sends every field back, not the editor defaults', async () => {
    const sent = mockApi();
    renderEditor('/admin/automate/products/p1');
    await screen.findByDisplayValue('AP approve');

    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'AP approver');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.body).toMatchObject({
      name: 'AP approver',
      description: 'Approving supplier invoices in the ledger.',
      category: 'Finance',
      requestInstructions: 'Say which company code you need.',
      durationMode: 'fixed',
      defaultDurationDays: 90,
      maxDurationDays: 365,
      status: 'active',
      formSchema: product.formSchema,
      grants: [
        {
          resourceType: 'entitlement',
          resourceId: '22222222-2222-4222-8222-222222222222',
          targetSystemId: null,
          optional: false,
        },
      ],
    });
  });

  it('starts empty on the new route and POSTs', async () => {
    const sent = mockApi();
    renderEditor('/admin/automate/products/new');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''));

    await userEvent.type(screen.getByLabelText('Name'), 'Fresh');
    await userEvent.type(screen.getByLabelText('Slug'), 'fresh');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('POST');
  });
});
