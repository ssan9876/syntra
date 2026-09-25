import { Panel, Status } from '@syntra/ui';

interface StructureAction {
  id: string;
  actionType: string;
  status: string;
  before?: unknown;
  after?: unknown;
  person: { id: string; givenName: string | null; familyName: string | null } | null;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nameOf = (person: StructureAction['person']) =>
  person === null
    ? 'an account'
    : `${person.givenName ?? ''} ${person.familyName ?? ''}`.trim() || person.id;

/**
 * What a run does to the SHAPE of the directory, said before anybody applies
 * it: which OUs it creates, which it moves -- with every account riding along
 * named -- and which accounts move to a different OU on their own.
 *
 * A first run on a target that has just started mirroring its org units can
 * create a dozen OUs and move a hundred accounts, and the per-person list
 * spreads that across a hundred panels. This puts it in one place, above the
 * plan, because "which OUs will appear in my domain and who moves" is the
 * question somebody is confirming.
 *
 * Renders nothing for a run that changes no structure.
 */
export function StructureChanges({ actions }: { actions: readonly StructureAction[] }) {
  const creates = actions.filter((a) => a.actionType === 'create_container');
  const moves = actions.filter((a) => a.actionType === 'move_container');
  const accountMoves = new Map<string, StructureAction[]>();
  for (const action of actions) {
    if (action.actionType !== 'update_account') continue;
    const to = text(record(action.after).container);
    const from = text(record(action.before).container);
    if (to === '' || to.toLowerCase() === from.toLowerCase()) continue;
    accountMoves.set(to, [...(accountMoves.get(to) ?? []), action]);
  }
  if (creates.length === 0 && moves.length === 0 && accountMoves.size === 0) return null;

  return (
    <Panel title="Directory structure">
      <div className="space-y-4 px-4 pb-4" data-testid="structure-changes">
        {creates.length > 0 && (
          <section>
            <h3 className="font-medium text-ink">
              {creates.length} OU{creates.length === 1 ? '' : 's'} to create, parent first
            </h3>
            <ul className="mt-1 space-y-1">
              {creates.map((action) => (
                <li key={action.id} className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-sm break-all">{text(record(action.after).dn)}</code>
                  {record(action.after).intermediate === true && (
                    <Status tone="neutral">Missing parent</Status>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {moves.length > 0 && (
          <section>
            <h3 className="font-medium text-ink">
              {moves.length} OU{moves.length === 1 ? '' : 's'} to move, with everything in{' '}
              {moves.length === 1 ? 'it' : 'them'}
            </h3>
            <ul className="mt-1 space-y-2">
              {moves.map((action) => {
                const after = record(action.after);
                const accounts = Array.isArray(after.accounts)
                  ? after.accounts.filter((a): a is string => typeof a === 'string')
                  : [];
                return (
                  <li key={action.id}>
                    <p className="text-sm">
                      <code className="font-mono break-all">{text(after.fromDn)}</code> →{' '}
                      <code className="font-mono break-all">{text(after.dn)}</code>
                    </p>
                    <p className="text-sm text-muted">
                      {accounts.length === 0
                        ? 'No accounts inside it.'
                        : `${accounts.length} account${accounts.length === 1 ? '' : 's'} move with it: ${accounts.join(', ')}.`}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {accountMoves.size > 0 && (
          <section>
            <h3 className="font-medium text-ink">Accounts moving to a different OU</h3>
            <ul className="mt-1 space-y-2">
              {[...accountMoves].map(([to, list]) => (
                <li key={to}>
                  <p className="text-sm">
                    To <code className="font-mono break-all">{to}</code>
                  </p>
                  <p className="text-sm text-muted">{list.map((a) => nameOf(a.person)).join(', ')}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Panel>
  );
}
