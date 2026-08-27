import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WorkflowsTab } from './WorkflowsTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const workflows = [
  {
    id: 'w-1',
    name: 'Manager then owner',
    description: null,
    enabled: true,
    productCount: 3,
    stages: [
      { id: 'st-1', sequence: 1, name: 'Line manager', selector: 'manager', quorum: 'any' },
      { id: 'st-2', sequence: 2, name: 'Owner', selector: 'productOwner', quorum: 'all' },
    ],
  },
  {
    id: 'w-2',
    name: 'Granted immediately',
    description: null,
    enabled: true,
    productCount: 0,
    stages: [],
  },
];

function mockApi() {
  const sent: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      sent.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/resolution-preview')) {
        return Promise.resolve(json({ stages: [] }));
      }
      return Promise.resolve(json({ id: 'w-3' }, 201));
    }
    if (url.includes('/automate/workflows')) return Promise.resolve(json({ workflows }));
    return Promise.resolve(json({}));
  });
  return sent;
}

/**
 * The LIST panel. Every workflow name appears twice on this page -- once as a
 * row and once as an option in the resolution picker -- so an unscoped query
 * matches both and proves neither.
 */
const listPanel = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { name: 'Workflows' });
  return heading.closest('section') as HTMLElement;
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <WorkflowsTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('the workflow list', () => {
  /**
   * There was no list route and therefore no list. `Product.workflowId` is
   * required and is a uuid, so this screen asked an administrator to type an
   * id the console gave them no way to learn.
   */
  it('names every workflow and its stages', async () => {
    mockApi();
    renderPage();

    const list = await listPanel();
    expect(within(list).getByText('Manager then owner')).toBeInTheDocument();
    expect(within(list).getByText(/Line manager/)).toBeInTheDocument();
    expect(within(list).getByText(/productOwner/)).toBeInTheDocument();
  });

  /**
   * The count is what makes "can I change this" answerable from the list: a
   * workflow bound to three products is not one to edit without knowing that.
   */
  it('says how many products use each one', async () => {
    mockApi();
    renderPage();
    const list = await listPanel();
    expect(within(list).getByText(/3 products/)).toBeInTheDocument();
  });

  /**
   * An empty stage list is the MECHANISM for immediate granting, not a missing
   * value, so the screen says so rather than rendering an empty list.
   */
  it('says in words that a workflow with no stages grants immediately', async () => {
    mockApi();
    renderPage();
    const list = await listPanel();
    expect(
      within(list).getByText(/grants immediately, with no approval/),
    ).toBeInTheDocument();
  });

  it('creates one with an empty stage list', async () => {
    const sent = mockApi();
    renderPage();
    await listPanel();

    await userEvent.type(screen.getByLabelText('New workflow name'), 'Two steps');
    await userEvent.click(screen.getByRole('button', { name: 'Create it' }));

    await waitFor(() => expect(sent.filter((s) => !s.url.includes('preview'))).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({
      name: 'Two steps',
      description: null,
      enabled: true,
      stages: [],
    });
  });

  /** The preview posts the id CHOSEN from the list, not one typed by hand. */
  it('previews the workflow picked from the list', async () => {
    const sent = mockApi();
    renderPage();
    await listPanel();

    await userEvent.selectOptions(screen.getByLabelText('Workflow'), 'w-1');
    await userEvent.type(
      screen.getByLabelText('Subject person id'),
      '44444444-4444-4444-8444-444444444444',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resolve it' }));

    await waitFor(() => {
      const call = sent.find((s) => s.url.endsWith('/resolution-preview'));
      expect(call?.body).toMatchObject({ workflowId: 'w-1' });
    });
  });
});
