import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectorBuilder } from './ConnectorBuilder.js';
import { blankDocument, type Doc } from './doc-path.js';

let latest: Doc = {};

function Harness({ initial, errors = {} }: { initial: Doc; errors?: Record<string, string> }) {
  const [doc, setDoc] = useState(initial);
  latest = doc;
  return (
    <ConnectorBuilder
      document={doc}
      errors={errors}
      onChange={(next) => {
        latest = next;
        setDoc(next);
      }}
    />
  );
}

describe('ConnectorBuilder', () => {
  it('builds a document for a hand-made application', async () => {
    render(<Harness initial={blankDocument()} />);

    await userEvent.type(screen.getByLabelText('Application name'), 'Acme HR');
    await userEvent.clear(screen.getByLabelText('API base URL'));
    await userEvent.type(screen.getByLabelText('API base URL'), 'https://hr.acme.test/api');

    await userEvent.selectOptions(screen.getByLabelText('How Syntra signs in'), 'header');
    await userEvent.clear(screen.getByLabelText('Header name'));
    await userEvent.type(screen.getByLabelText('Header name'), 'X-Token');

    await userEvent.selectOptions(screen.getByLabelText('Paging'), 'page');
    await userEvent.selectOptions(screen.getByLabelText('First page'), '0');

    expect(latest).toMatchObject({
      name: 'Acme HR',
      baseUrl: 'https://hr.acme.test/api',
      auth: { type: 'header', header: 'X-Token' },
      account: { list: { path: '/users', paging: { style: 'page', firstPage: 0 } } },
    });
  });

  it('fills the create body from the field mapping', async () => {
    render(
      <Harness
        initial={{
          ...blankDocument(),
          account: { list: { path: '/users' }, anchorAt: 'id', fields: { login: 'userName', first: 'givenName' } },
        }}
      />,
    );

    await userEvent.click(screen.getByLabelText('Create accounts'));
    await userEvent.click(screen.getByRole('button', { name: 'Fill from field mapping' }));

    expect(latest).toMatchObject({
      account: {
        create: { method: 'POST', path: '/users', body: { login: '{{correlationKey}}', first: '{{attr.givenName}}' } },
      },
    });
  });

  it('keeps keys it has no control for', async () => {
    render(<Harness initial={{ ...blankDocument(), container: { list: { path: '/ous' }, dnAt: 'dn' } }} />);
    await userEvent.type(screen.getByLabelText('Application name'), 'X');
    expect(latest.container).toEqual({ list: { path: '/ous' }, dnAt: 'dn' });
  });

  it('shows a schema problem beside its field and in its section', () => {
    render(<Harness initial={blankDocument()} errors={{ 'account.anchorAt': 'Required' }} />);
    expect(screen.getByLabelText('Account id at')).toHaveAccessibleDescription(/Required/);
    expect(screen.getByText('1 problem')).toBeInTheDocument();
  });

  it('turns an optional part off by taking it out of the document', async () => {
    render(<Harness initial={{ ...blankDocument(), entitlement: { list: { path: '/g' }, anchorAt: 'id', displayNameAt: 'n' } }} />);
    await userEvent.click(screen.getByLabelText('This application has groups, roles or licences'));
    expect(latest.entitlement).toBeUndefined();
  });
});
