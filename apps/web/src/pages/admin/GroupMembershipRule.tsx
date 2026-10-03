import { useState } from 'react';
import { Alert, Button, Panel, useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { ConditionGroupEditor } from './ConditionGroupEditor.js';
import { conditionOf, describeCondition, draftConditionFrom, type ConditionDraft } from './BusinessRulesPage.js';

interface PreviewSide {
  count: number;
  users?: { id: string; login: string; displayName: string }[];
}

interface Preview {
  add: PreviewSide;
  remove: PreviewSide;
  keep: { count: number };
}

const STARTER: ConditionDraft = {
  kind: 'group',
  combinator: 'all',
  children: [{ kind: 'leaf', field: 'contract.department', op: 'equals', value: '' }],
};

function names(side: PreviewSide): string {
  const shown = (side.users ?? []).map((u) => u.displayName).join(', ');
  return side.count > (side.users?.length ?? 0) ? `${shown} and ${side.count - (side.users?.length ?? 0)} more` : shown;
}

function problemOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;
}

/**
 * A group's membership rule: who is added and removed automatically by
 * department, job title, status and the other contract fields.
 */
export function GroupMembershipRule({
  groupId,
  groupName,
  rule,
  evaluatedAt,
  heldRemoveCount,
  active,
  onChanged,
}: {
  groupId: string;
  groupName: string;
  rule: unknown;
  evaluatedAt: string | null;
  /** Set while the last automatic pass was held. */
  heldRemoveCount: number | null;
  active: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ConditionDraft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<string | null>(null);

  const hasRule = rule !== null && rule !== undefined;

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (cause) {
      setProblem(problemOf(cause, fallback));
    } finally {
      setBusy(false);
    }
  };

  const previewDraft = (next: unknown) =>
    run(async () => {
      setPreview(
        await api<Preview>(`/api/admin/groups/${groupId}/rule/preview`, {
          method: 'POST',
          body: JSON.stringify({ rule: next }),
        }),
      );
    }, 'Preview failed.');

  const save = (next: unknown) =>
    run(async () => {
      const result = await api<{ added: number; removed: number }>(`/api/admin/groups/${groupId}/rule`, {
        method: 'PUT',
        body: JSON.stringify({ rule: next }),
      });
      toast({
        title: next === null ? 'Rule removed' : 'Rule saved',
        body: `${result.added} added, ${result.removed} removed from ${groupName}.`,
      });
      setDraft(null);
      setPreview(null);
      onChanged();
    }, 'Rule not saved.');

  const applyNow = (confirm = false) =>
    run(async () => {
      setHeld(null);
      try {
        const result = await api<{ added: number; removed: number }>(`/api/admin/groups/${groupId}/rule/apply`, {
          method: 'POST',
          body: JSON.stringify(confirm ? { confirm: true } : {}),
        });
        toast({ title: 'Rule applied', body: `${result.added} added, ${result.removed} removed.` });
        onChanged();
      } catch (cause) {
        if (cause instanceof ApiError && cause.kind === 'rule-held') {
          setHeld(cause.problem.detail ?? cause.problem.title);
          return;
        }
        throw cause;
      }
    }, 'Rule not applied.');

  return (
    <Panel title="Membership rule">
      <div className="space-y-4 p-4">
        {problem && <Alert tone="warning">{problem}</Alert>}
        {!held && heldRemoveCount !== null && (
          <Alert tone="warning">
            <span className="flex flex-wrap items-center gap-3">
              Rule held: it would remove {heldRemoveCount} members. Review it and apply.
              <Button size="sm" variant="secondary" disabled={busy || !active} onClick={() => void applyNow()}>
                Apply now
              </Button>
            </span>
          </Alert>
        )}
        {held && (
          <Alert tone="warning">
            <span className="flex flex-wrap items-center gap-3">
              {held}
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void applyNow(true)}>
                Apply anyway
              </Button>
            </span>
          </Alert>
        )}

        {draft === null ? (
          <>
            {hasRule ? (
              <div className="space-y-1">
                <p className="text-ink">{describeCondition(rule)}</p>
                <p className="text-sm text-muted">
                  {evaluatedAt ? `Last applied ${new Date(evaluatedAt).toLocaleString()}` : 'Not applied yet'}
                  {!active && ' · Paused while the group is inactive'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">No rule. Members are added by hand.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant={hasRule ? 'secondary' : 'primary'}
                onClick={() => setDraft(hasRule ? draftConditionFrom(rule) : STARTER)}
              >
                {hasRule ? 'Edit rule' : 'Add rule'}
              </Button>
              {hasRule && (
                <>
                  <Button variant="secondary" disabled={busy || !active} onClick={() => void applyNow()}>
                    Apply now
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => void previewDraft(null)}>
                    Remove rule
                  </Button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <ConditionGroupEditor
              node={draft}
              onChange={(next) => {
                setDraft(next);
                setPreview(null);
              }}
              depth={0}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => void previewDraft(conditionOf(draft))}>
                Preview
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setPreview(null);
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        )}

        {preview && (
          <div className="space-y-2 rounded-control border border-border-subtle p-3 text-sm">
            <p>
              <span className="font-medium text-ink">Adds {preview.add.count}</span>
              {preview.add.count > 0 && <span className="text-muted">: {names(preview.add)}</span>}
            </p>
            <p>
              <span className="font-medium text-ink">Removes {preview.remove.count}</span>
              {preview.remove.count > 0 && <span className="text-muted">: {names(preview.remove)}</span>}
            </p>
            <p className="text-muted">Keeps {preview.keep.count}. Members added by hand are not changed.</p>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void save(draft === null ? null : conditionOf(draft))}
            >
              {draft === null ? 'Remove rule' : 'Save rule'}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
