import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StructureChanges } from './StructureChanges.js';

const ROOT = 'OU=Syntra,DC=contoso,DC=local';
const person = { id: 'p-1', givenName: 'Anna', familyName: 'Novak' };

describe('StructureChanges', () => {
  it('says which OUs a run creates and moves, and which accounts move', () => {
    render(
      <StructureChanges
        actions={[
          { id: 'a1', actionType: 'create_container', status: 'proposed', after: { dn: ROOT, intermediate: true }, person: null },
          { id: 'a2', actionType: 'create_container', status: 'proposed', after: { dn: `OU=contoso.local,${ROOT}` }, person: null },
          {
            id: 'a3',
            actionType: 'move_container',
            status: 'proposed',
            after: { fromDn: `OU=IT,${ROOT}`, dn: `OU=IT,OU=contoso.local,${ROOT}`, accounts: ['anna.novak', 'bo.lind'] },
            person: null,
          },
          {
            id: 'a4',
            actionType: 'update_account',
            status: 'proposed',
            before: { container: 'CN=Users,DC=contoso,DC=local' },
            after: { container: `OU=HR,${ROOT}` },
            person,
          },
          // An attribute-only update is not a move and is not listed.
          { id: 'a5', actionType: 'update_account', status: 'proposed', before: { container: 'X' }, after: { container: 'X' }, person },
        ]}
      />,
    );
    const panel = screen.getByTestId('structure-changes');
    expect(panel).toHaveTextContent('2 OUs to create, parent first');
    expect(panel).toHaveTextContent('Missing parent');
    expect(panel).toHaveTextContent('1 OU to move');
    expect(panel).toHaveTextContent('2 accounts move with it: anna.novak, bo.lind.');
    expect(panel).toHaveTextContent(`To OU=HR,${ROOT}`);
    expect(panel).toHaveTextContent('Anna Novak');
  });

  it('renders nothing for a run that changes no structure', () => {
    const { container } = render(
      <StructureChanges actions={[{ id: 'a', actionType: 'grant_entitlement', status: 'proposed', person }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
