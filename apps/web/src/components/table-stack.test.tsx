import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table } from '@syntra/ui';

function People({ stack, rows }: { stack: boolean; rows: string[] }) {
  return (
    <Table label="People" stackOnPhone={stack}>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Email</th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((name) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{name.toLowerCase().replace(' ', '.')}@acme.test</td>
            <td>
              <button type="button">Edit</button>
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={3}>No more</td>
        </tr>
      </tbody>
    </Table>
  );
}

describe('Table stackOnPhone', () => {
  it("labels each cell with its column's visible heading, and states the table roles", () => {
    render(<People stack rows={['Jo Doe']} />);
    const email = screen.getByText('jo.doe@acme.test');
    expect(email).toHaveAttribute('data-label', 'Email');
    // The row's name is the card title; an sr-only heading labels nothing on
    // screen; a cell spanning columns has no single heading.
    expect(screen.getByRole('rowheader', { name: 'Jo Doe' })).not.toHaveAttribute('data-label');
    expect(screen.getByRole('button', { name: 'Edit' }).closest('td')).not.toHaveAttribute('data-label');
    expect(screen.getByText('No more')).not.toHaveAttribute('data-label');
    expect(screen.getByRole('table', { name: 'People' })).toHaveClass('data-table--stack');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('labels rows that arrive later', () => {
    const { rerender } = render(<People stack rows={['Jo Doe']} />);
    rerender(<People stack rows={['Jo Doe', 'Sam Roe']} />);
    expect(screen.getByText('sam.roe@acme.test')).toHaveAttribute('data-label', 'Email');
  });

  it('leaves a table that does not opt in alone', () => {
    render(<People stack={false} rows={['Jo Doe']} />);
    expect(screen.getByText('jo.doe@acme.test')).not.toHaveAttribute('data-label');
    expect(screen.getByRole('table', { name: 'People' })).not.toHaveClass('data-table--stack');
  });
});
