import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConditionGroupEditor } from './ConditionGroupEditor.js';
import type { ConditionDraft, GroupDraft } from './BusinessRulesPage.js';

const leaf = (value: string): ConditionDraft => ({
  kind: 'leaf',
  field: 'contract.department',
  op: 'equals',
  value,
});

describe('ConditionGroupEditor', () => {
  it('edits a single leaf directly', () => {
    const onChange = vi.fn();
    render(<ConditionGroupEditor node={leaf('Finance')} onChange={onChange} depth={0} />);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Ops' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'leaf', value: 'Ops' }),
    );
  });

  it('turns a leaf into an AND group, keeping the leaf as the first child', () => {
    const onChange = vi.fn();
    render(<ConditionGroupEditor node={leaf('Finance')} onChange={onChange} depth={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Group with AND' }));
    const next = onChange.mock.calls[0]![0] as GroupDraft;
    expect(next.kind).toBe('group');
    expect(next.combinator).toBe('all');
    expect(next.children).toEqual([leaf('Finance')]);
  });

  it('adds and removes a child within an existing group', () => {
    const onChange = vi.fn();
    const group: GroupDraft = { kind: 'group', combinator: 'all', children: [leaf('Finance')] };
    render(<ConditionGroupEditor node={group} onChange={onChange} depth={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect((onChange.mock.calls[0]![0] as GroupDraft).children).toHaveLength(2);

    onChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Remove this condition' }));
    expect((onChange.mock.calls[0]![0] as GroupDraft).children).toHaveLength(0);
  });

  it('wraps a node in NOT and can unwrap it again', () => {
    const onChange = vi.fn();
    render(<ConditionGroupEditor node={leaf('Finance')} onChange={onChange} depth={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Negate' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'not', child: leaf('Finance') });

    onChange.mockClear();
    const notNode: ConditionDraft = { kind: 'not', child: leaf('Finance') };
    render(<ConditionGroupEditor node={notNode} onChange={onChange} depth={0} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove NOT, keep the condition inside it' }),
    );
    expect(onChange).toHaveBeenCalledWith(leaf('Finance'));
  });

  it('renders nested groups recursively, with a group label per level', () => {
    const nested: ConditionDraft = {
      kind: 'group',
      combinator: 'any',
      children: [
        leaf('Finance'),
        { kind: 'group', combinator: 'all', children: [leaf('Ops')] },
      ],
    };
    render(<ConditionGroupEditor node={nested} onChange={vi.fn()} depth={0} />);
    expect(screen.getByText('ANY of')).toBeVisible();
    expect(screen.getByText('ALL of')).toBeVisible();
  });
});
