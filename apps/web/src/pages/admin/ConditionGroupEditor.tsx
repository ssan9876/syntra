import { Button, Field, Select } from '@syntra/ui';
import {
  FIELDS,
  OPERATORS,
  kindOf,
  type ConditionDraft,
  type GroupDraft,
  type LeafDraft,
  type Operator,
} from './BusinessRulesPage.js';

const BLANK_LEAF: LeafDraft = {
  kind: 'leaf',
  field: 'contract.department',
  op: 'equals',
  value: '',
};

export interface ConditionGroupEditorProps {
  node: ConditionDraft;
  onChange: (next: ConditionDraft) => void;
  depth: number;
}

/**
 * A recursive editor over `condition.ts`'s `Condition` shape: a leaf renders
 * as the field/operator/value row this page always had; `all`/`any` render as
 * a labelled group of children with add/remove controls; `not` renders as a
 * single wrapped child with an unwrap control. Depth is passed through only
 * for indentation — there is no recursion-depth limit here because
 * `conditionSchema` in `condition.ts` has none either.
 */
export function ConditionGroupEditor({ node, onChange, depth }: ConditionGroupEditorProps) {
  const indent = { marginLeft: `${depth * 1.25}rem` };

  if (node.kind === 'leaf') {
    const kind = kindOf(node.op);
    return (
      <div style={indent} className="space-y-2 border-l border-border-subtle pl-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Field"
            value={node.field}
            onChange={(v) => onChange({ ...node, field: v as LeafDraft['field'] })}
            options={FIELDS.map((field) => ({ value: field, label: field }))}
          />
          <Select
            label="Test"
            value={node.op}
            onChange={(v) => onChange({ ...node, op: v as Operator })}
            options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
          />
          {kind !== 'none' && (
            <Field
              label="Value"
              value={node.value}
              onChange={(v) => onChange({ ...node, value: v })}
              inputMode={kind === 'number' ? 'decimal' : undefined}
              // Ruling P20, said on the screen rather than discovered from a
              // 400: a blank pattern is the universal pattern.
            />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => onChange({ kind: 'group', combinator: 'all', children: [node] })}
          >
            Group with AND
          </Button>
          <Button
            size="sm"
            onClick={() => onChange({ kind: 'group', combinator: 'any', children: [node] })}
          >
            Group with OR
          </Button>
          <Button size="sm" onClick={() => onChange({ kind: 'not', child: node })}>
            Negate
          </Button>
        </div>
      </div>
    );
  }

  if (node.kind === 'not') {
    return (
      <div style={indent} className="space-y-2 border-l border-border-subtle pl-3">
        <p className="font-medium text-ink">NOT</p>
        <ConditionGroupEditor
          node={node.child}
          onChange={(child) => onChange({ kind: 'not', child })}
          depth={depth + 1}
        />
        <Button size="sm" onClick={() => onChange(node.child)}>
          Remove NOT, keep the condition inside it
        </Button>
      </div>
    );
  }

  const group = node as GroupDraft;
  return (
    <div style={indent} className="space-y-2 border-l border-border-subtle pl-3">
      <p className="font-medium text-ink">{group.combinator === 'all' ? 'ALL of' : 'ANY of'}</p>
      {group.children.map((child, index) => (
        <div key={index} className="space-y-1">
          <ConditionGroupEditor
            node={child}
            onChange={(next) => {
              const children = [...group.children];
              children[index] = next;
              onChange({ ...group, children });
            }}
            depth={depth + 1}
          />
          <Button
            size="sm"
            onClick={() => {
              const children = group.children.filter((_, i) => i !== index);
              onChange({ ...group, children });
            }}
          >
            Remove this condition
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        onClick={() => onChange({ ...group, children: [...group.children, BLANK_LEAF] })}
      >
        Add condition
      </Button>
    </div>
  );
}
