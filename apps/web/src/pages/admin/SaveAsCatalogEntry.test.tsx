import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SaveAsCatalogEntry, variablesIn } from './SaveAsCatalogEntry.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as never;

const DRAFT = {
  name: 'Helpdesk',
  category: 'other',
  description: 'Ticketing',
  launchUrl: 'https://emea.helpdesk.example.test',
  variables: [],
  saml: {
    spEntityId: 'https://emea.helpdesk.example.test/saml',
    acsUrls: ['https://emea.helpdesk.example.test/saml/acs'],
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    claims: [{ claimName: 'email', sourceKind: 'user', sourceField: 'email' }],
  },
};

afterEach(() => vi.restoreAllMocks());

describe('variablesIn', () => {
  it('finds each placeholder once, in order', () => {
    expect(variablesIn(['https://{{a}}.x/{{b}}', '{{ a }}'])).toEqual(['a', 'b']);
  });
});

describe('SaveAsCatalogEntry', () => {
  it('turns a typed {{name}} into a field to fill in, and saves the entry', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/catalog-draft')) return Promise.resolve(json(DRAFT));
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json({ key: 'custom-1' }, 201));
    });
    const onDone = vi.fn();
    render(<SaveAsCatalogEntry applicationId="a1" onDone={onDone} />);

    const entityId = await screen.findByLabelText(/^entity id$/i);
    await user.clear(entityId);
    await user.type(entityId, 'https://{{{{instance}}.helpdesk.example.test/saml');
    await user.clear(screen.getByLabelText(/acs urls/i));
    await user.type(screen.getByLabelText(/acs urls/i), 'https://{{{{instance}}.helpdesk.example.test/saml/acs');
    await user.clear(screen.getByLabelText(/launch url/i));

    expect(screen.getByText('{{instance}}')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^label$/i), 'Instance name');
    await user.type(screen.getByLabelText(/^example$/i), 'acme');
    await user.click(screen.getByRole('button', { name: /save to catalog/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent[0]).toMatchObject({
      name: 'Helpdesk',
      variables: [{ key: 'instance', label: 'Instance name', example: 'acme' }],
      saml: {
        spEntityId: 'https://{{instance}}.helpdesk.example.test/saml',
        acsUrls: ['https://{{instance}}.helpdesk.example.test/saml/acs'],
        claims: [{ claimName: 'email', sourceKind: 'user', sourceField: 'email' }],
      },
    });
    expect(sent[0]).not.toHaveProperty('launchUrl');
  });
});
