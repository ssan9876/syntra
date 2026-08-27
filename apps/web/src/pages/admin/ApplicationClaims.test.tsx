import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApplicationClaims } from './ApplicationClaims.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const mapping = (over: Record<string, unknown> = {}) => ({
  id: 'cm-1',
  protocol: 'saml',
  claimName: 'User.Email',
  sourceKind: 'user',
  sourceField: 'email',
  literalValue: null,
  multiValued: false,
  ...over,
});

function mockApi(
  options: { saml?: unknown[]; oidc?: unknown[]; sets?: unknown[]; apply?: () => Response } = {},
) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        url: String(input),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(input).includes('/apply-set')) {
        return Promise.resolve(
          options.apply ? options.apply() : json({ added: 2, alreadyPresent: 1 }),
        );
      }
      return Promise.resolve(json({}, 201));
    }
    if (url.includes('/claim-sets')) {
      return Promise.resolve(json({ sets: options.sets ?? [] }));
    }
    return Promise.resolve(
      json({ saml: options.saml ?? [], oidc: options.oidc ?? [] }),
    );
  });
  return sent;
}

const renderPanel = (protocols: ('saml' | 'oidc')[] = ['saml']) =>
  render(
    <MemoryRouter>
      <ApplicationClaims applicationId="app-1" protocols={protocols} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ApplicationClaims', () => {
  it('renders nothing when the application uses no protocol', () => {
    mockApi();
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what an empty list means rather than showing an empty table', async () => {
    mockApi();
    renderPanel();
    expect(await screen.findByText(/nothing beyond the name identifier/i)).toBeInTheDocument();
  });

  it('names the source in words, not as a stored key', async () => {
    mockApi({ saml: [mapping()] });
    renderPanel();
    // `sourceKind: 'user'` is what is stored; "The account" is what it means.
    expect(await screen.findByText('User.Email')).toBeInTheDocument();
    expect(screen.getByText(/the account/i)).toBeInTheDocument();
  });

  it('asks for a field only where the source has one', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /add a mapping/i }));
    expect(screen.getByLabelText(/field on the account/i)).toBeInTheDocument();

    // Groups and literals have no field to name, and a box asking for one
    // would be a box whose only possible answer is wrong.
    await user.selectOptions(screen.getByLabelText(/^from$/i), 'groups');
    expect(screen.queryByLabelText(/field on/i)).toBeNull();
  });

  it('sends null rather than an empty string for a source with no field', async () => {
    const user = userEvent.setup();
    const sent = mockApi();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /add a mapping/i }));
    await user.type(screen.getByLabelText(/sent as/i), 'groups');
    await user.selectOptions(screen.getByLabelText(/^from$/i), 'groups');
    await user.click(screen.getByRole('button', { name: /^add mapping$/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The contract refuses a blank field name, so '' would be an error message
    // about a box the reader cannot see.
    expect(sent[0]!.body).toMatchObject({ sourceField: null, sourceKind: 'groups' });
  });

  it('does not offer a protocol the application does not use', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPanel(['saml']);

    await user.click(await screen.findByRole('button', { name: /add a mapping/i }));
    // One protocol, so there is no choice to make and none is offered.
    expect(screen.queryByLabelText(/^protocol$/i)).toBeNull();
  });

  it('offers the choice when the application uses both', async () => {
    const user = userEvent.setup();
    mockApi();
    renderPanel(['saml', 'oidc']);

    await user.click(await screen.findByRole('button', { name: /add a mapping/i }));
    expect(screen.getByLabelText(/^protocol$/i)).toBeInTheDocument();
  });

  it('removes a mapping', async () => {
    const user = userEvent.setup();
    const sent = mockApi({ saml: [mapping()] });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /remove/i }));
    await waitFor(() => expect(sent[0]).toMatchObject({ method: 'DELETE' }));
  });

  it('offers only sets for a protocol this application uses', async () => {
    // A set for the other protocol writes rows that protocol's builder never
    // reads. The API refuses it; there is no reason to make somebody discover
    // that by pressing a button.
    mockApi({
      sets: [
        { id: 's1', name: 'Standard profile', description: null, protocol: 'saml', mappings: [] },
        { id: 's2', name: 'OIDC profile', description: null, protocol: 'oidc', mappings: [] },
      ],
    });
    renderPanel(['saml']);

    expect(await screen.findByRole('button', { name: 'Standard profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OIDC profile' })).toBeNull();
  });

  it('says what applying a set actually did', async () => {
    const user = userEvent.setup();
    mockApi({
      sets: [
        { id: 's1', name: 'Standard profile', description: null, protocol: 'saml', mappings: [] },
      ],
    });
    renderPanel(['saml']);

    await user.click(await screen.findByRole('button', { name: 'Standard profile' }));
    // Numbers, because "applied" on its own is indistinguishable from
    // "did nothing".
    expect(await screen.findByText(/added 2, 1 already here/i)).toBeInTheDocument();
  });

  it('says so plainly when a set added nothing', async () => {
    // The ordinary result of applying a set twice.
    const user = userEvent.setup();
    mockApi({
      sets: [
        { id: 's1', name: 'Standard profile', description: null, protocol: 'saml', mappings: [] },
      ],
      apply: () => json({ added: 0, alreadyPresent: 3 }),
    });
    renderPanel(['saml']);

    await user.click(await screen.findByRole('button', { name: 'Standard profile' }));
    expect(await screen.findByText(/already here/i)).toBeInTheDocument();
  });
});
