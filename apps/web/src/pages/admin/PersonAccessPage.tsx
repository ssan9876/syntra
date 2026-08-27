import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Empty, Field, Panel, Select, SkeletonRows, Status, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

/**
 * One rule that asks for a holding **today**, with the contract of this person
 * that satisfies it. `explainPersonAccess` only lists a rule here when a
 * contract does satisfy it, so the pairing is total.
 */
interface CurrentRule {
  ruleId: string;
  ruleName: string;
  contractId: string | null;
  contractDescription: string | null;
}

interface Holding {
  entitlementId: string;
  displayName: string;
  origin: string;
  ruleId: string | null;
  ruleName: string | null;
  contractId: string | null;
  contractDescription: string | null;
  /**
   * The stamp `apply.ts` wrote at the moment of the grant, and never updated
   * since: history, not an answer to "why does this person have this now".
   * `grantedByRuleName` is null while `grantedByRuleId` is not when the rule
   * it names has been deleted — the column carries no foreign key.
   */
  grantedByRuleId: string | null;
  grantedByRuleName: string | null;
  /** The stamp no longer accounts for the holding. Never true off `origin: 'rule'`. */
  attributionStale: boolean;
  /** Every rule that asks for it now — possibly none, possibly several. */
  currentRules: CurrentRule[];
  /**
   * The other half of "why does this person hold this": an approved request.
   *
   * Independent of the rule attribution and ending independently of it, which
   * is why the two are separate fields rather than one tagged union. Null for
   * everything a rule, an administrator or the target itself put there.
   */
  grantId: string | null;
  requestId: string | null;
  grantEndsAt: string | null;
}

interface Access {
  personId: string;
  accounts: {
    targetSystemId: string;
    targetName: string;
    correlationKey: string;
    status: string;
    anchor: string | null;
    entitlements: Holding[];
  }[];
}

const ORIGINS: Record<string, string> = {
  rule: 'A business rule',
  request: 'An approved request',
  discovered: 'Found at the target, not granted here',
  manual: 'Granted by hand',
};

/**
 * The six `TargetAccount.status` values, read as three different kinds of
 * thing rather than as "active" and "not active".
 *
 * `active`, `disabled` and `archived` are states somebody decided on: the
 * deprovisioning ladder walks an account down them on purpose, and `inactive`
 * is the right tone — deliberately legible rather than faded, because hiding a
 * deactivation makes the directory unauditable.
 *
 * The other three are not decisions:
 *
 * - `pending` is a reservation. `run-service.ts` writes the row to hold the
 *   correlation key under the unique index before anything is written to the
 *   target, with a null anchor; nothing exists at the target yet.
 * - `missing_at_target` is `reconcile.ts` finding that the target no longer
 *   returns an anchor Syntra records. `plan.ts` proposes recreating it and
 *   marks that action `requiresConfirmation: true`, because it usually
 *   vanished because somebody deleted it deliberately.
 * - `conflict` is a write the target refused; `apply.ts` writes it with a
 *   `statusReason`, and reconciliation then proposes nothing for that person.
 *
 * Rendering all three in the same quiet badge as a deliberately disabled
 * leaver is three faults dressed as an intended state.
 */
const ACCOUNT_STATUS: Record<
  string,
  { tone: 'active' | 'inactive' | 'warning' | 'danger'; label: string; title: string }
> = {
  active: {
    tone: 'active',
    label: 'active',
    title: 'The account exists at the target and is enabled.',
  },
  disabled: {
    tone: 'inactive',
    label: 'disabled',
    title:
      'Disabled on purpose — a step on this target’s deprovisioning ladder.',
  },
  archived: {
    tone: 'inactive',
    label: 'archived',
    title:
      'Moved to the archive container with its managed entitlements stripped. Provision never deletes.',
  },
  pending: {
    tone: 'warning',
    label: 'pending — nothing at the target yet',
    title:
      'A reserved login. The row holds the correlation key so two runs cannot generate the same one; no account has been created at the target.',
  },
  missing_at_target: {
    tone: 'danger',
    label: 'missing at the target',
    title:
      'Syntra records this account and the target no longer returns its anchor. Recreating it is never automatic: it usually vanished because somebody deleted it deliberately.',
  },
  conflict: {
    tone: 'danger',
    label: 'conflict',
    title:
      'The target refused the last write to this account. Nothing further is proposed for this person here until it is resolved.',
  },
};

const accountStatus = (status: string) =>
  ACCOUNT_STATUS[status] ?? {
    tone: 'neutral' as const,
    label: status,
    title: 'A status this screen does not have a reading for.',
  };

/**
 * The live answer: every rule that asks for this holding **now**, each with
 * the contract of this person that satisfies it.
 *
 * A list and not a name. Two rules can ask for the same entitlement, and
 * `apply.ts` records only `attributedRuleIds[0]` — so a screen that shows one
 * of them invites exactly the mistake the recorded stamp invited: revoke the
 * named rule, and the access stays, because the other one still holds it in
 * place.
 *
 * Empty is two different statements and they are not rendered alike:
 *
 * - Empty while something is nonetheless attributed — the stamp is stale, or
 *   the stamped rule still names the entitlement but no active contract of
 *   this person satisfies it any more — means nobody is asking for access this
 *   person has. That is the finding an auditor came for, and reconciliation
 *   will propose revoking it.
 * - Empty with nothing attributed at all is a `manual` or `discovered`
 *   holding, already named as such one column to the left. An em dash is the
 *   whole truth there.
 */
function HeldByNow({ holding }: { holding: Holding }) {
  if (holding.currentRules.length > 0) {
    return (
      <ul className="space-y-1.5">
        {holding.currentRules.map((rule) => (
          <li key={rule.ruleId}>
            <span className="text-ink">{rule.ruleName}</span>
            {rule.contractDescription && (
              <span className="block text-sm text-muted">
                {rule.contractDescription}
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  // An approved request holds it in place, and says until when. Checked
  // BEFORE the rule branches: a request-origin holding has no rule attribution
  // to be stale about, and falling through would render "nothing asks for this
  // now" over access somebody signed for.
  if (holding.origin === 'request') {
    return (
      <span className="block text-sm text-muted">
        {holding.requestId === null ? (
          'An approved request.'
        ) : (
          <>
            Requested{' '}
            <Link
              to={`/admin/automate/requests/${holding.requestId}`}
              className="text-primary underline-offset-2 hover:underline"
            >
              on request {holding.requestId.slice(0, 8)}
            </Link>
          </>
        )}
        {holding.grantEndsAt === null
          ? ', with no end date.'
          : `, until ${new Date(holding.grantEndsAt).toLocaleDateString()}.`}
      </span>
    );
  }

  if (holding.attributionStale || holding.ruleName !== null) {
    return (
      <div className="space-y-1.5">
        <span title="No rule on this target asks for this entitlement for this person today. Reconciliation proposes revoking a rule-granted holding nothing desires.">
          <Status tone="warning">nothing asks for this now</Status>
        </span>
        <span className="block text-sm text-muted">
          {/* `ruleName` survives an empty live set in one case: the stamped
              rule still names the entitlement and is still enabled, but no
              active contract of this person satisfies its condition today — a
              leaver, or a transfer. Worth naming, and still not a rule asking
              for this person to hold this. */}
          {holding.ruleName === null
            ? 'A rule granted this and no rule keeps it in place.'
            : `${holding.ruleName} still names it, but no active contract of this person matches it.`}
        </span>
      </div>
    );
  }

  return <span className="text-muted">—</span>;
}

/**
 * What was stamped on the holding when it was granted, presented as what it
 * is: history.
 *
 * Kept beside the live answer rather than instead of it, because "R1 granted
 * this in January, R2 asks for it now" is the sentence an auditor needs, and
 * dropping the first half loses the trail into the audit log. A stale stamp is
 * said to be stale here — not silently replaced, and not rendered as an em
 * dash, which would say nothing ever granted this.
 */
function RecordedAtGrant({ holding }: { holding: Holding }) {
  if (holding.grantedByRuleId === null) {
    return <span className="text-muted">—</span>;
  }

  return (
    <div className="space-y-1.5">
      {holding.grantedByRuleName === null ? (
        <span className="text-ink">a rule that has since been deleted</span>
      ) : (
        <span className="text-ink">{holding.grantedByRuleName}</span>
      )}
      {holding.attributionStale && (
        <span
          className="block text-sm text-warning"
          title="Deleted, disabled, or edited to stop naming this entitlement. The recorded rule is not why this person holds this now."
        >
          no longer asks for this
        </span>
      )}
    </div>
  );
}

interface Placement {
  container: string;
  reason: string;
  updatedAt: string;
}

/**
 * Where this account sits, and the control that changes it.
 *
 * Two states rather than one form. Following the rule is the ordinary case and
 * shows nothing but a Move button; being pinned is a standing disagreement
 * with the placement rule, and shows what it is and who said why — because
 * that is the only question anybody asks about an account that is not where
 * the rule puts it.
 *
 * The container list is read from the TARGET, on demand, and only when the
 * move form is open. Provision creates no containers, so this is the closed
 * set an account may go to; reading it up front would be a live call to every
 * target on every page load, for a control most visits never touch.
 */
function Placement({
  personId,
  targetSystemId,
  targetName,
}: {
  personId: string;
  targetSystemId: string;
  targetName: string;
}) {
  const base = `/api/admin/targets/${targetSystemId}/placements/${personId}`;
  const { data, reload } = useApiResource<{ placement: Placement | null }>(base);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const containers = useApiResource<{ containers: string[] }>(
    open ? `/api/admin/targets/${targetSystemId}/containers` : null,
  );
  const placement = data?.placement ?? null;

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api<{ moved: boolean; message: string }>(base, {
        method: 'PUT',
        body: JSON.stringify({ container, reason }),
      });
      setOpen(false);
      setReason('');
      // A directory write that did not land is not a failed request: the
      // decision is recorded and the next run retries it. Saying so is more
      // useful than an error the administrator reads as "nothing happened".
      setNote(result.moved ? null : result.message);
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    setBusy(true);
    setProblem(null);
    try {
      await api(base, { method: 'DELETE' });
      // Nothing moves now. The next run computes the rule's answer and
      // proposes the move, in a plan somebody reviews.
      setNote(`${targetName} will move this account back to where the rule puts it on its next run.`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border-subtle p-4">
      {placement === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted">Placed by the rule.</span>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            Move
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Status tone="warning">Moved by hand</Status>
          <span className="font-mono text-sm text-ink">{placement.container}</span>
          <span className="text-sm text-muted">{placement.reason}</span>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            Move again
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={follow}>
            Follow the rule
          </Button>
        </div>
      )}

      {note && (
        <div className="mt-3">
          <Alert tone="warning">{note}</Alert>
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {containers.error && <Alert tone="danger">{containers.error}</Alert>}
          <Select
            label="Container"
            value={container}
            onChange={setContainer}
            disabled={containers.loading}
            options={[
              { value: '', label: containers.loading ? 'Reading the target…' : 'Choose one' },
              ...(containers.data?.containers ?? []).map((dn) => ({ value: dn, label: dn })),
            ]}
          />
          <Field label="Why" value={reason} onChange={setReason} required />
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={container === '' || reason.trim() === ''}
              onClick={submit}
            >
              Move
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PersonAccessPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useApiResource<Access>(
    `/api/admin/persons/${id}/access`,
  );

  return (
    <>
      <PageHeader
        title="Why does this person hold this?"
      />

      <div className="space-y-6">
        {error && <Alert tone="danger">{error}</Alert>}

        {!error && loading && (
          <Panel>
            <SkeletonRows rows={6} cols={4} />
          </Panel>
        )}

        {!error && !loading && data && data.accounts.length === 0 && (
          <Panel>
            <div className="p-6">
              {/* Not the same statement as "no such person", which the API
                  answers with a 404 for exactly this reason. */}
              <Empty title="This person holds no target-system accounts">
                Either no rule matches them, or no target has been run since one
                started to.
              </Empty>
            </div>
          </Panel>
        )}

        {!error &&
          !loading &&
          data?.accounts.map((account) => (
            <Panel
              key={account.targetSystemId}
              title={account.targetName}
              actions={(() => {
                const state = accountStatus(account.status);
                return (
                  <span title={state.title}>
                    <Status tone={state.tone}>{state.label}</Status>
                  </span>
                );
              })()}
            >
              {/*
                Where the account SITS, above what it holds. They are different
                questions and the placement is the one somebody arriving from
                a reorg came here for.
              */}
              <Placement
                personId={id!}
                targetSystemId={account.targetSystemId}
                targetName={account.targetName}
              />
              {account.entitlements.length === 0 ? (
                <div className="p-4 text-muted">
                  This account holds nothing Syntra can see.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th scope="col">
                        Entitlement
                      </th>
                      <th scope="col">
                        Where it came from
                      </th>
                      {/* Two columns and not one, because they answer two
                          different questions and the whole defect was
                          answering the first with the second. The contract
                          lives with the rule it satisfies: one holding can
                          have several current rules, each satisfied by a
                          different contract of this person, and a single
                          contract column could only ever show one of them. */}
                      <th scope="col">
                        Why it is held now
                      </th>
                      <th scope="col">
                        Recorded at the grant
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.entitlements.map((holding) => (
                      <tr key={holding.entitlementId}>
                        <td className="text-ink">
                          {holding.displayName}
                        </td>
                        <td>
                          {ORIGINS[holding.origin] ?? holding.origin}
                        </td>
                        <td className="text-ink">
                          <HeldByNow holding={holding} />
                        </td>
                        <td className="text-ink">
                          <RecordedAtGrant holding={holding} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          ))}

        <Link
          to={`/admin/people/${id}`}
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to this person
        </Link>
      </div>
    </>
  );
}
