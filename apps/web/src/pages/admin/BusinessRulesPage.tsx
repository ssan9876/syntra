import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  Empty,
  Field,
  Panel,
  Select,
  SkeletonRows,
  Status,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Entitlement {
  id: string;
  displayName: string;
  status: 'present' | 'missing' | 'unreadable' | string;
  holderCount: number;
}

interface StoredRule {
  id: string;
  name: string;
  description: string | null;
  condition: unknown;
  grantsAccount: boolean;
  enabled: boolean;
  entitlements: { entitlementId: string }[];
}

interface Impact {
  matchedPersons: number;
  totalPersons: number;
  wouldGrant: number;
  wouldRevoke: number;
  sample: { personId: string; displayName: string }[];
}

/** The one field of the target this screen's copy depends on. */
interface Target {
  enforcementMode: 'additive' | 'authoritative';
}

/**
 * A rule about to be deleted, and what deleting it would cost.
 *
 * Deleting is modelled as "this rule grants nothing": `previewRuleImpact` reads
 * `mine` — every live holding carrying `grantedByRuleId` — and counts a holding
 * as revoked when the rule no longer names its entitlement, so an empty
 * `entitlementIds` makes `wouldRevoke` exactly the set the delete gives up.
 * That is the same endpoint the edit path already uses, pointed at the more
 * destructive action rather than the less.
 */
interface Pending {
  rule: StoredRule;
  impact: Impact | null;
  impactProblem: string | null;
}

const deletionOf = (rule: StoredRule) => ({
  id: rule.id,
  name: rule.name,
  condition: rule.condition,
  grantsAccount: false,
  enabled: false,
  entitlementIds: [],
});

/** The closed field set from `condition.ts`. Anything else is refused. */
const FIELDS = [
  'contract.department',
  'contract.jobTitle',
  'contract.costCentre',
  'contract.employer',
  'contract.location',
  'contract.fte',
  'person.status',
] as const;

/**
 * The closed operator set, and which of them take what.
 *
 * `in`/`notIn` take a list, `greaterThan`/`lessThan` take a number and are
 * only legal against `contract.fte`, and `isEmpty`/`isNotEmpty` take nothing.
 * Sending the wrong shape is a 400 the form could have prevented, and sending
 * an empty value is Ruling P20's defect: a blank `contains` matches every
 * person in the tenant, including those with nothing recorded in that field.
 */
const OPERATORS = [
  { value: 'equals', label: 'is', kind: 'text' },
  { value: 'notEquals', label: 'is not', kind: 'text' },
  { value: 'in', label: 'is one of', kind: 'list' },
  { value: 'notIn', label: 'is none of', kind: 'list' },
  { value: 'startsWith', label: 'starts with', kind: 'text' },
  { value: 'contains', label: 'contains', kind: 'text' },
  { value: 'isEmpty', label: 'is empty', kind: 'none' },
  { value: 'isNotEmpty', label: 'is not empty', kind: 'none' },
  { value: 'greaterThan', label: 'is greater than', kind: 'number' },
  { value: 'lessThan', label: 'is less than', kind: 'number' },
] as const;

type Operator = (typeof OPERATORS)[number]['value'];
const kindOf = (op: Operator) =>
  OPERATORS.find((o) => o.value === op)?.kind ?? 'text';

interface Draft {
  id?: string;
  name: string;
  field: (typeof FIELDS)[number];
  op: Operator;
  value: string;
  grantsAccount: boolean;
  enabled: boolean;
  entitlementIds: string[];
}

const BLANK: Draft = {
  name: '',
  field: 'contract.department',
  op: 'equals',
  value: '',
  grantsAccount: true,
  enabled: true,
  entitlementIds: [],
};

/** A stored condition, back into the one-leaf form this editor writes. */
function draftFrom(rule: StoredRule): Draft {
  const leaf = (rule.condition ?? {}) as {
    field?: string;
    op?: string;
    value?: unknown;
  };
  const field = (FIELDS as readonly string[]).includes(leaf.field ?? '')
    ? (leaf.field as Draft['field'])
    : 'contract.department';
  const op = OPERATORS.some((o) => o.value === leaf.op)
    ? (leaf.op as Operator)
    : 'equals';
  return {
    id: rule.id,
    name: rule.name,
    field,
    op,
    value: Array.isArray(leaf.value)
      ? leaf.value.join(', ')
      : leaf.value === undefined || leaf.value === null
        ? ''
        : String(leaf.value),
    grantsAccount: rule.grantsAccount,
    enabled: rule.enabled,
    entitlementIds: rule.entitlements.map((e) => e.entitlementId),
  };
}

function conditionOf(draft: Draft): unknown {
  const kind = kindOf(draft.op);
  if (kind === 'none') return { field: draft.field, op: draft.op };
  if (kind === 'list') {
    return {
      field: draft.field,
      op: draft.op,
      value: draft.value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    };
  }
  if (kind === 'number') {
    return { field: draft.field, op: draft.op, value: Number(draft.value) };
  }
  return { field: draft.field, op: draft.op, value: draft.value };
}

function bodyOf(draft: Draft) {
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name.trim(),
    condition: conditionOf(draft),
    grantsAccount: draft.grantsAccount,
    enabled: draft.enabled,
    entitlementIds: draft.entitlementIds,
  };
}

const describe = (rule: StoredRule) => {
  const leaf = (rule.condition ?? {}) as {
    field?: string;
    op?: string;
    value?: unknown;
  };
  if (leaf.field === undefined) return 'a compound condition';
  const label = OPERATORS.find((o) => o.value === leaf.op)?.label ?? leaf.op;
  const value = Array.isArray(leaf.value) ? leaf.value.join(', ') : leaf.value;
  return `${leaf.field} ${label}${value === undefined ? '' : ` ${String(value)}`}`;
};

export function BusinessRulesPage() {
  const { id } = useParams<{ id: string }>();
  const [rules, setRules] = useState<StoredRule[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<
    null | 'save' | 'impact' | 'delete' | 'refresh'
  >(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);

  // Ruling P2's mode decides whether the standing reassurance below is true, so
  // this screen has to know it rather than assume the gentler of the two.
  const { data: target } = useApiResource<Target>(`/api/admin/targets/${id}`);
  const authoritative = target?.enforcementMode === 'authoritative';

  /**
   * Both reads, and a loading gate over them.
   *
   * Without the gate the first paint claimed this target had no rules at all
   * and an empty entitlement catalog, and invited an LDAP refresh the
   * administrator did not need — three assertions about the server made before
   * the server had said anything.
   */
  const reload = () => {
    setLoading(true);
    void Promise.allSettled([
      api<{ rules: StoredRule[] }>(`/api/admin/targets/${id}/rules`)
        .then((body) => setRules(body.rules))
        .catch(() =>
          setProblem('The rules for this target could not be loaded.'),
        ),
      api<{ entitlements: Entitlement[] }>(
        `/api/admin/targets/${id}/entitlements`,
      )
        .then((body) => setEntitlements(body.entitlements))
        .catch(() =>
          setProblem(
            'The entitlement catalog for this target could not be read.',
          ),
        ),
    ]).then(() => setLoading(false));
  };
  useEffect(reload, [id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const mark = (field: string): { error?: string } =>
    invalid[field] ? { error: invalid[field] } : {};

  function fail(cause: unknown, fallback: string) {
    const marked = fieldErrors(cause);
    setInvalid(marked);
    if (Object.keys(marked).length > 0) {
      setProblem(null);
    } else if (cause instanceof ApiError) {
      setProblem(cause.problem.detail ?? cause.problem.title ?? fallback);
    } else {
      setProblem(fallback);
    }
  }

  async function onSave() {
    setBusy('save');
    setInvalid({});
    setProblem(null);
    setNotice(null);
    try {
      await api(`/api/admin/targets/${id}/rules`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(draft)),
      });
      setNotice('Saved.');
      setDraft(BLANK);
      setImpact(null);
      reload();
    } catch (cause) {
      fail(cause, 'The rule could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function onImpact() {
    setBusy('impact');
    setInvalid({});
    setProblem(null);
    setImpact(null);
    try {
      setImpact(
        await api<Impact>(`/api/admin/targets/${id}/rules/impact`, {
          method: 'POST',
          body: JSON.stringify(bodyOf(draft)),
        }),
      );
    } catch (cause) {
      fail(cause, 'The impact of that rule could not be previewed.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Reads the target's grantable groups into the catalog.
   *
   * Without a control for this the catalog can only ever be filled by a
   * scheduled run, so a target created this minute offers no entitlements at
   * all and no rule can name one — the page would say "refresh it from the
   * target" and give nobody a way to.
   */
  async function onRefresh() {
    setBusy('refresh');
    setProblem(null);
    setNotice(null);
    try {
      const result = await api<{ present: number; missing: number }>(
        `/api/admin/targets/${id}/entitlements/refresh`,
        { method: 'POST' },
      );
      setNotice(
        `${result.present} entitlement${result.present === 1 ? '' : 's'} read ` +
          `from the target; ${result.missing} previously known ` +
          `${result.missing === 1 ? 'is' : 'are'} no longer there.`,
      );
      reload();
    } catch (cause) {
      fail(cause, 'The entitlement catalog could not be refreshed.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Asks what deleting this rule costs, then asks the administrator.
   *
   * The delete used to be one unconfirmed click, while the next run revokes
   * every entitlement the rule ever granted — `reconcile.ts` keeps a holding
   * Provision granted inside `heldWithinRemit` even after the rule that asked
   * for it is gone, precisely so that deleting a rule does not strand its
   * grants, and the planner then differences it away. The *edit* path on this
   * same screen already warned about exactly this. The warning was on the less
   * destructive action.
   */
  async function onAskDelete(rule: StoredRule) {
    setBusy('delete');
    setProblem(null);
    setPending({ rule, impact: null, impactProblem: null });
    try {
      const impact = await api<Impact>(
        `/api/admin/targets/${id}/rules/impact`,
        { method: 'POST', body: JSON.stringify(deletionOf(rule)) },
      );
      setPending({ rule, impact, impactProblem: null });
    } catch (cause) {
      // Still a confirmation, and a louder one: not knowing the number is a
      // reason to be more careful, not a reason to skip the question.
      setPending({
        rule,
        impact: null,
        impactProblem:
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'The impact of deleting this rule could not be previewed.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(ruleId: string) {
    setBusy('delete');
    setProblem(null);
    try {
      await api(`/api/admin/rules/${ruleId}`, { method: 'DELETE' });
      if (draft.id === ruleId) setDraft(BLANK);
      setPending(null);
      reload();
    } catch (cause) {
      fail(cause, 'The rule could not be deleted.');
    } finally {
      setBusy(null);
    }
  }

  const kind = kindOf(draft.op);

  return (
    <>
      <PageHeader
        title="Business rules"
        description="Who gets an account in this target, and which entitlements come with it."
        actions={
          <Button
            onClick={onRefresh}
            loading={busy === 'refresh'}
            disabled={!!busy}
          >
            Refresh entitlement catalog
          </Button>
        }
      />

      <div className="space-y-6">
        {notice && <Alert tone="info">{notice}</Alert>}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {Object.keys(invalid).length > 0 && (
          <Alert tone="danger" title="Some of this was refused">
            The fields concerned are marked below.
          </Alert>
        )}

        {/*
          The union half is true under both modes. The reassurance is not.
          `remitFor` is every entitlement named by an ENABLED rule for this
          target, and under `authoritative` `reconcile.ts` proposes revoking an
          in-remit entitlement from every holder Provision did not grant it to.
          So on an authoritative target, naming a group in a new rule is what
          takes it away from everybody who holds it for some other reason —
          which is the opposite of what a permanent banner saying "adding a rule
          never removes access" prepares somebody for.
        */}
        <Alert tone={authoritative ? 'warning' : 'info'}>
          A rule is evaluated against each of a person&apos;s active contracts
          independently and the results are unioned, so a person holding two jobs
          gets what either job grants.{' '}
          {authoritative
            ? 'This target is authoritative, so adding a rule can also remove access: naming an entitlement brings it into Provision’s remit, and the next run proposes revoking it from everybody holding it that Provision did not grant it to. Preview the impact before saving.'
            : 'This target is additive, so adding a rule never removes access: Provision revokes only what it granted, and anything else it finds is reported as drift and left alone.'}
        </Alert>

        {pending && (
          <Alert
            tone="danger"
            title={`Delete “${pending.rule.name}”?`}
          >
            <p>
              Deleting a rule does not only stop it granting. The next run
              revokes every entitlement this rule granted, from everybody it
              granted it to — a grant Provision made stays Provision&apos;s to
              take back even once the rule that asked for it is gone.
            </p>
            {pending.impact && (
              // One string rather than numbers wrapped in `<strong>`: this is
              // the sentence somebody has to read before pressing a red button,
              // and it must be findable as one sentence.
              <p className="mt-2 font-semibold">
                {`${pending.impact.wouldRevoke} holding${
                  pending.impact.wouldRevoke === 1 ? '' : 's'
                } would be taken away, from the ${
                  pending.impact.matchedPersons
                } of ${pending.impact.totalPersons} persons this rule matches.`}
              </p>
            )}
            {pending.impactProblem && (
              <p className="mt-2">
                What that would cost could not be worked out —{' '}
                {pending.impactProblem} — so this is being asked without a
                number behind it.
              </p>
            )}
            {pending.rule.grantsAccount && (
              <p className="mt-2">
                This rule also grants an account. Anybody it matches who is
                matched by no other account-granting rule walks the
                deprovisioning ladder on the next run.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="danger"
                onClick={() => onDelete(pending.rule.id)}
                loading={busy === 'delete'}
                disabled={!!busy}
              >
                Delete this rule
              </Button>
              <Button onClick={() => setPending(null)} disabled={!!busy}>
                Keep it
              </Button>
            </div>
          </Alert>
        )}

        <Panel title="Rules">
          {loading && <SkeletonRows rows={3} cols={2} />}
          {!loading && rules.length === 0 ? (
            <div className="p-6">
              <Empty title="No rules yet">
                Until a rule matches somebody, this target proposes nothing at
                all.
              </Empty>
            </div>
          ) : loading ? null : (
            <ul>
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {rule.name}{' '}
                      {!rule.enabled && <Status tone="inactive">disabled</Status>}
                    </p>
                    <p className="text-muted">
                      {describe(rule)} —{' '}
                      {rule.grantsAccount
                        ? 'grants an account'
                        : 'grants no account'}
                      , {rule.entitlements.length} entitlement
                      {rule.entitlements.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => setDraft(draftFrom(rule))}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => onAskDelete(rule)}
                      disabled={!!busy}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={draft.id === undefined ? 'New rule' : `Editing ${draft.name}`}
          actions={
            draft.id === undefined ? undefined : (
              <Button size="sm" onClick={() => setDraft(BLANK)}>
                Start a new rule instead
              </Button>
            )
          }
        >
          <div className="space-y-4 p-4">
            <Field
              label="Name"
              value={draft.name}
              onChange={(v) => set('name', v)}
              placeholder="Finance staff"
              {...mark('name')}
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <Select
                label="Field"
                value={draft.field}
                onChange={(v) => set('field', v as Draft['field'])}
                options={FIELDS.map((field) => ({ value: field, label: field }))}
                {...mark('field')}
              />
              <Select
                label="Test"
                value={draft.op}
                onChange={(v) => set('op', v as Operator)}
                options={OPERATORS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
                {...mark('op')}
              />
              {kind !== 'none' && (
                <Field
                  label="Value"
                  value={draft.value}
                  onChange={(v) => set('value', v)}
                  inputMode={kind === 'number' ? 'decimal' : undefined}
                  // Ruling P20, said on the screen rather than discovered from
                  // a 400: a blank pattern is the universal pattern.
                  hint={
                    kind === 'list'
                      ? 'Separated by commas. A blank list matches nobody and is refused.'
                      : 'A blank value is refused: it would match every person in the tenant.'
                  }
                  {...mark('value')}
                />
              )}
            </div>

            <Check
              checked={draft.grantsAccount}
              onChange={(v) => set('grantsAccount', v)}
              label="A match requires an account in this target"
              hint="Off, the rule grants entitlements to people who already have an account here and creates none."
            />
            <Check
              checked={draft.enabled}
              onChange={(v) => set('enabled', v)}
              label="Enabled"
              hint="A disabled rule grants nothing, and its entitlements fall outside what Provision considers its remit — so under authoritative enforcement they are reported as drift rather than revoked."
            />

            <fieldset className="rounded-panel border border-border-subtle p-4">
              <legend className="px-1 font-medium text-ink">
                Entitlements granted
              </legend>
              {loading ? (
                // Never "the catalog is empty" before the catalog has been
                // read: that sentence sends somebody to press a button that
                // talks to a domain controller for no reason.
                <p className="text-muted">Reading the entitlement catalog…</p>
              ) : entitlements.length === 0 ? (
                <p className="text-muted">
                  This target&apos;s entitlement catalog is empty. Refresh it
                  from the target, with the button at the top of this page,
                  before a rule can name anything.
                </p>
              ) : (
                <div className="space-y-2">
                  {entitlements.map((entitlement) => (
                    <Check
                      key={entitlement.id}
                      checked={draft.entitlementIds.includes(entitlement.id)}
                      onChange={(checked) =>
                        set(
                          'entitlementIds',
                          checked
                            ? [...draft.entitlementIds, entitlement.id]
                            : draft.entitlementIds.filter(
                                (x) => x !== entitlement.id,
                              ),
                        )
                      }
                      label={
                        <>
                          {entitlement.displayName}
                          {entitlement.status !== 'present' && (
                            <span className="ml-2 text-danger">
                              ({entitlement.status} — a rule naming it makes
                              every person it is evaluated against
                              unprocessable)
                            </span>
                          )}
                        </>
                      }
                    />
                  ))}
                </div>
              )}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={onImpact}
                loading={busy === 'impact'}
                disabled={!!busy}
              >
                Preview impact
              </Button>
              <Button
                variant="primary"
                onClick={onSave}
                loading={busy === 'save'}
                disabled={!!busy}
              >
                Save rule
              </Button>
            </div>

            {impact && (
              <div className="rounded-panel border border-border-subtle p-4">
                {/* A rule whose blast radius is only visible after it is saved
                    is a rule that gets saved and then discovered. The
                    revocation count leads when there is one: an edit that
                    empties a rule's entitlement list revokes everything that
                    rule ever granted, and that is the change most likely to be
                    made without meaning it. */}
                <p className="text-ink">
                  This rule matches{' '}
                  <strong className="font-semibold tabular-nums">
                    {impact.matchedPersons}
                  </strong>{' '}
                  of {impact.totalPersons} persons.
                </p>
                <p className="mt-2 text-ink">
                  Saving it would grant{' '}
                  <strong className="font-semibold tabular-nums">
                    {impact.wouldGrant}
                  </strong>{' '}
                  entitlement{impact.wouldGrant === 1 ? '' : 's'} and revoke{' '}
                  <strong className="font-semibold tabular-nums">
                    {impact.wouldRevoke}
                  </strong>
                  .
                </p>
                {impact.wouldRevoke > 0 && (
                  <div className="mt-3">
                    <Alert
                      tone="warning"
                      title={`${impact.wouldRevoke} holding${
                        impact.wouldRevoke === 1 ? '' : 's'
                      } would be taken away`}
                    >
                      Revocations are what an edit to an existing rule usually
                      does without meaning to. Removing an entitlement from a
                      rule revokes it from everybody the rule granted it to.
                    </Alert>
                  </div>
                )}
                {impact.sample.length > 0 && (
                  <ul className="mt-3 text-muted">
                    {impact.sample.map((person) => (
                      <li key={person.personId}>{person.displayName}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Panel>

        <Link
          to={`/admin/targets/${id}`}
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to the target
        </Link>
      </div>
    </>
  );
}
