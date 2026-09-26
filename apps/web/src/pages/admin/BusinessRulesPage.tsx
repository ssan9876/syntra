import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  Empty,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Metric,
  MetricRow,
  Panel,
  SkeletonRows,
  StateBadge,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
import { ConditionGroupEditor } from './ConditionGroupEditor.js';
import { StaleBadge, draftKey, draftStatus, summaryOf } from './DraftState.js';

interface Entitlement {
  id: string;
  displayName: string;
  status: 'present' | 'missing' | 'unreadable' | string;
  holderCount: number;
  manageable?: boolean;
  unmanageableReason?: string | null;
  membershipKind?: string | null;
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
export const FIELDS = [
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
export const OPERATORS = [
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

export type Operator = (typeof OPERATORS)[number]['value'];
export const kindOf = (op: Operator) =>
  OPERATORS.find((o) => o.value === op)?.kind ?? 'text';

export interface LeafDraft {
  kind: 'leaf';
  field: (typeof FIELDS)[number];
  op: Operator;
  value: string;
}
export interface GroupDraft {
  kind: 'group';
  combinator: 'all' | 'any';
  children: ConditionDraft[];
}
export interface NotDraft {
  kind: 'not';
  child: ConditionDraft;
}
export type ConditionDraft = LeafDraft | GroupDraft | NotDraft;

const BLANK_LEAF: LeafDraft = {
  kind: 'leaf',
  field: 'contract.department',
  op: 'equals',
  value: '',
};

interface Draft {
  id?: string;
  name: string;
  condition: ConditionDraft;
  grantsAccount: boolean;
  enabled: boolean;
  entitlementIds: string[];
}

const BLANK: Draft = {
  name: '',
  condition: BLANK_LEAF,
  grantsAccount: true,
  enabled: true,
  entitlementIds: [],
};

/**
 * A stored condition (any shape `conditionSchema` in `condition.ts` accepts),
 * into the tree this editor writes. Recognises nothing outside
 * `all`/`any`/`not`/leaf and falls back to a blank leaf rather than throwing —
 * a rule column written by an older version of this page, or by hand, must
 * still open.
 */
export function draftConditionFrom(raw: unknown): ConditionDraft {
  const node = (raw ?? {}) as {
    all?: unknown[];
    any?: unknown[];
    not?: unknown;
    field?: string;
    op?: string;
    value?: unknown;
  };
  if (Array.isArray(node.all)) {
    return { kind: 'group', combinator: 'all', children: node.all.map(draftConditionFrom) };
  }
  if (Array.isArray(node.any)) {
    return { kind: 'group', combinator: 'any', children: node.any.map(draftConditionFrom) };
  }
  if (node.not !== undefined) {
    return { kind: 'not', child: draftConditionFrom(node.not) };
  }
  const field = (FIELDS as readonly string[]).includes(node.field ?? '')
    ? (node.field as LeafDraft['field'])
    : 'contract.department';
  const op = OPERATORS.some((o) => o.value === node.op) ? (node.op as Operator) : 'equals';
  return {
    kind: 'leaf',
    field,
    op,
    value: Array.isArray(node.value)
      ? node.value.join(', ')
      : node.value === undefined || node.value === null
        ? ''
        : String(node.value),
  };
}

/** A stored condition, back into the draft tree this editor writes. */
function draftFrom(rule: StoredRule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    condition: draftConditionFrom(rule.condition),
    grantsAccount: rule.grantsAccount,
    enabled: rule.enabled,
    entitlementIds: rule.entitlements.map((e) => e.entitlementId),
  };
}

/** The tree back into the JSON shape `conditionSchema` accepts. */
export function conditionOf(node: ConditionDraft): unknown {
  if (node.kind === 'group') {
    return { [node.combinator]: node.children.map(conditionOf) };
  }
  if (node.kind === 'not') {
    return { not: conditionOf(node.child) };
  }
  const kind = kindOf(node.op);
  if (kind === 'none') return { field: node.field, op: node.op };
  if (kind === 'list') {
    return {
      field: node.field,
      op: node.op,
      value: node.value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    };
  }
  if (kind === 'number') return { field: node.field, op: node.op, value: Number(node.value) };
  return { field: node.field, op: node.op, value: node.value };
}

function bodyOf(draft: Draft) {
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    name: draft.name.trim(),
    condition: conditionOf(draft.condition),
    grantsAccount: draft.grantsAccount,
    enabled: draft.enabled,
    entitlementIds: draft.entitlementIds,
  };
}

/**
 * A human-readable rendering of any stored condition, replacing the old
 * `'a compound condition'` placeholder. Matches `evaluate()`'s own reading in
 * `condition.ts`: an empty `all` is `always` (true of everybody), an empty
 * `any` is `never`.
 */
export function describeCondition(raw: unknown): string {
  const node = (raw ?? {}) as {
    all?: unknown[];
    any?: unknown[];
    not?: unknown;
    field?: string;
    op?: string;
    value?: unknown;
  };
  if (Array.isArray(node.all)) {
    if (node.all.length === 0) return 'always';
    return node.all.map(describeCondition).map((s) => `(${s})`).join(' AND ');
  }
  if (Array.isArray(node.any)) {
    if (node.any.length === 0) return 'never';
    return node.any.map(describeCondition).map((s) => `(${s})`).join(' OR ');
  }
  if (node.not !== undefined) return `NOT (${describeCondition(node.not)})`;
  const label = OPERATORS.find((o) => o.value === node.op)?.label ?? node.op;
  const value = Array.isArray(node.value) ? node.value.join(', ') : node.value;
  return `${node.field} ${label}${value === undefined ? '' : ` ${String(value)}`}`;
}

const describe = (rule: StoredRule) => describeCondition(rule.condition);

/** On-screen names for the fields the API refuses by name. */
const LABELS: Record<string, string> = {
  name: 'Name',
};

export function BusinessRulesPage() {
  const { id } = useParams<{ id: string }>();
  return <BusinessRulesEditor key={id} />;
}

function BusinessRulesEditor() {
  const { id } = useParams<{ id: string }>();
  const [rules, setRules] = useState<StoredRule[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [entitlementQuery, setEntitlementQuery] = useState('');
  const [entitlementResults, setEntitlementResults] = useState<Entitlement[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const toast = useToast();
  const [draft, updateDraft] = useState<Draft>(BLANK);
  // The rule as it was when editing began, so "Unsaved changes" is a
  // comparison with it rather than a flag.
  const [editingFrom, setEditingFrom] = useState<Draft>(BLANK);
  const [impact, setImpact] = useState<Impact | null>(null);
  /**
   * An impact was on screen, or on its way, when the draft changed.
   *
   * The figures are withdrawn at once — they are the blast radius of a rule
   * that no longer exists — but the withdrawal is said, in their place and
   * beside Save, so an empty space is never read as "this rule affects
   * nobody".
   */
  const [impactStale, setImpactStale] = useState(false);
  const impactShown = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<
    null | 'save' | 'impact' | 'delete' | 'delete-preview' | 'refresh'
  >(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  const previewSeq = useRef(0);
  const deletePreviewSeq = useRef(0);
  useEffect(() => () => {
    previewSeq.current += 1;
    deletePreviewSeq.current += 1;
  }, []);

  // Invalidate synchronously in the edit handler, including edits that restore
  // an earlier value. A response belongs to one draft revision, not just JSON.
  /** Takes the impact off screen, saying so if one was there. */
  const withdrawImpact = () => {
    previewSeq.current += 1;
    if (impactShown.current) setImpactStale(true);
    impactShown.current = false;
    setImpact(null);
  };

  const setDraft = (next: Draft) => {
    previewSeq.current += 1;
    deletePreviewSeq.current += 1;
    if (impactShown.current) setImpactStale(true);
    impactShown.current = false;
    setImpact(null);
    setPending(null);
    setBusy((current) => current === 'impact' || current === 'delete-preview' ? null : current);
    updateDraft(next);
  };

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
  // Bumped on every `reload()`, so a response for an id this screen has since
  // moved away from cannot land after the rules for the new one already have -
  // a rapid id change otherwise reads as "these rules belong to this target"
  // when they belong to the last one.
  const requestSeq = useRef(0);

  const reload = () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    void Promise.allSettled([
      api<{ rules: StoredRule[] }>(`/api/admin/targets/${id}/rules`)
        .then((body) => {
          if (seq !== requestSeq.current) return;
          setRules(body.rules);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setProblem('The rules for this target could not be loaded.');
        }),
      api<{ entitlements: Entitlement[] }>(
        `/api/admin/targets/${id}/entitlements`,
      )
        .then((body) => {
          if (seq !== requestSeq.current) return;
          setEntitlements(body.entitlements);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setProblem(
            'The entitlement catalog for this target could not be read.',
          );
        }),
    ]).then(() => {
      if (seq !== requestSeq.current) return;
      setLoading(false);
    });
  };
  useEffect(reload, [id]);

  // Server-backed, debounced: a large catalog is searched where it lives
  // rather than shipped to the browser, and a keystroke that is overtaken
  // by the next one never paints its answer.
  useEffect(() => {
    const q = entitlementQuery.trim();
    if (q === '') {
      setEntitlementResults(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ entitlements: Entitlement[] }>(
        `/api/admin/targets/${id}/entitlements/search?q=${encodeURIComponent(q)}&top=50`,
      )
        .then((body) => {
          if (seq !== searchSeq.current) return;
          setEntitlementResults(body.entitlements);
        })
        .catch(() => {
          if (seq !== searchSeq.current) return;
          setEntitlementResults(
            entitlements.filter((e) => e.displayName.toLowerCase().includes(q.toLowerCase())),
          );
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [entitlementQuery, id, entitlements]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft({ ...draft, [key]: value });

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
    if ((draft.id !== undefined || authoritative || !target) && !impact) return;
    // `previewRequired` below is the same condition, for the render.
    setBusy('save');
    setPending(null);
    setInvalid({});
    setProblem(null);
    setNotice(null);
    try {
      await api(`/api/admin/targets/${id}/rules`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(draft)),
      });
      toast({ tone: 'success', title: draft.id === undefined ? 'Rule created' : 'Rule saved' });
      setDraft(BLANK);
      setEditingFrom(BLANK);
      setImpact(null);
      setImpactStale(false);
      reload();
    } catch (cause) {
      fail(cause, 'The rule could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function onImpact() {
    const seq = ++previewSeq.current;
    setBusy('impact');
    setInvalid({});
    setProblem(null);
    setImpact(null);
    setImpactStale(false);
    impactShown.current = true;
    try {
      const result = await api<Impact>(`/api/admin/targets/${id}/rules/impact`, {
          method: 'POST',
          body: JSON.stringify(bodyOf(draft)),
        });
      if (seq === previewSeq.current) setImpact(result);
    } catch (cause) {
      if (seq === previewSeq.current) {
        impactShown.current = false;
        fail(cause, 'The impact of that rule could not be previewed.');
      }
    } finally {
      if (seq === previewSeq.current) setBusy(null);
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
    setPending(null);
    // The catalog is what the impact was counted against.
    withdrawImpact();
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
    const seq = ++deletePreviewSeq.current;
    setBusy('delete-preview');
    setProblem(null);
    setPending({ rule, impact: null, impactProblem: null });
    try {
      const impact = await api<Impact>(
        `/api/admin/targets/${id}/rules/impact`,
        { method: 'POST', body: JSON.stringify(deletionOf(rule)) },
      );
      if (seq === deletePreviewSeq.current) setPending({ rule, impact, impactProblem: null });
    } catch (cause) {
      if (seq !== deletePreviewSeq.current) return;
      setPending({
        rule,
        impact: null,
        impactProblem:
          cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'The impact of deleting this rule could not be previewed.',
      });
    } finally {
      if (seq === deletePreviewSeq.current) setBusy(null);
    }
  }

  async function onDelete(ruleId: string) {
    if (pending?.rule.id !== ruleId || !pending.impact) return;
    setBusy('delete');
    setProblem(null);
    try {
      await api(`/api/admin/rules/${ruleId}`, { method: 'DELETE' });
      // Another rule's grants are part of what this draft's impact was
      // counted against.
      withdrawImpact();
      if (draft.id === ruleId) {
        setDraft(BLANK);
        setEditingFrom(BLANK);
        setImpactStale(false);
      }
      toast({ tone: 'success', title: 'Rule deleted' });
      setPending(null);
      reload();
    } catch (cause) {
      fail(cause, 'The rule could not be deleted.');
    } finally {
      setBusy(null);
    }
  }

  // Ruling P2 again: an edit, or any rule on an authoritative target, can take
  // access away, so its impact is seen before it is saved.
  const previewRequired = draft.id !== undefined || authoritative || !target;
  const dirty = draftKey(draft) !== draftKey(editingFrom);

  return (
    <>
      <PageHeader
        title="Business rules"
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

        {/*
          Only while it applies. `remitFor` is every entitlement named by an
          ENABLED rule for this target, and under `authoritative`
          `reconcile.ts` proposes revoking an in-remit entitlement from every
          holder Provision did not grant it to — so naming a group in a new
          rule takes it away from everybody who holds it for another reason.
        */}
        {authoritative && (
          <Alert tone="warning">
            Authoritative target: adding a rule can also remove access.
          </Alert>
        )}

        {pending && (
          <Alert
            tone="danger"
            title={`Delete “${pending.rule.name}”?`}
          >
            <ul className="list-disc space-y-1 pl-5">
              {pending.impact && (
                // One string rather than numbers wrapped in `<strong>`: it
                // must be findable as one line.
                <li className="font-semibold">
                  {`${pending.impact.wouldRevoke} holding${
                    pending.impact.wouldRevoke === 1 ? '' : 's'
                  } would be taken away (${pending.impact.matchedPersons} of ${
                    pending.impact.totalPersons
                  } persons matched)`}
                </li>
              )}
              {pending.impactProblem && (
                <li>Impact could not be worked out — {pending.impactProblem}</li>
              )}
              {pending.rule.grantsAccount && (
                <li>Grants an account — people only it matches are deprovisioned</li>
              )}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="danger"
                onClick={() => onDelete(pending.rule.id)}
                loading={busy === 'delete' || busy === 'delete-preview'}
                disabled={!!busy || !pending.impact}
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
              <Empty title="No rules yet" />
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
                      {!rule.enabled && <StateBadge state="inactive">Disabled</StateBadge>}
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
                    <Button
                      size="sm"
                      onClick={() => {
                        const opened = draftFrom(rule);
                        setDraft(opened);
                        setEditingFrom(opened);
                      }}
                    >
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

        {/*
          The editor is a working area, not a Panel: the Panel's
          `overflow-hidden` would pin the completion bar to the panel's own
          box, and with a long entitlement list the Save somebody needs is
          otherwise a screen below the tick they just changed. The impact
          preview sits in it, directly above that bar, because it is the
          blast radius of exactly this draft and is withdrawn the moment the
          draft changes.
        */}
        <section
          className="space-y-6 rounded-panel border border-border-subtle bg-bg px-4 pt-4"
        >
          <header className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-md font-semibold text-ink">
              {draft.id === undefined ? 'New rule' : `Editing ${draft.name}`}
            </h2>
            {draft.id !== undefined && (
              <Button
                size="sm"
                onClick={() => {
                  setDraft(BLANK);
                  setEditingFrom(BLANK);
                }}
              >
                Start a new rule instead
              </Button>
            )}
          </header>

          <ErrorSummary errors={summaryOf(invalid, LABELS)} />

          <FormSection title="Who it matches">
            <Field
              label="Name"
              name="name"
              value={draft.name}
              onChange={(v) => set('name', v)}
              placeholder="Finance staff"
              {...mark('name')}
              className="sm:col-span-2"
            />
            <div className="sm:col-span-2">
              <ConditionGroupEditor
                node={draft.condition}
                onChange={(next) => set('condition', next)}
                depth={0}
              />
            </div>
          </FormSection>

          <FormSection
            title="What it grants"
            status={
              draft.enabled ? null : <StateBadge state="inactive">Disabled</StateBadge>
            }
          >
            <Check
              className="sm:col-span-2"
              checked={draft.grantsAccount}
              onChange={(v) => set('grantsAccount', v)}
              label="A match requires an account in this target"
            />
            <Check
              className="sm:col-span-2"
              checked={draft.enabled}
              onChange={(v) => set('enabled', v)}
              label="Enabled"
            />

            <fieldset className="space-y-2 sm:col-span-2">
              <legend className="mb-2 font-medium text-ink">Entitlements granted</legend>
              {loading ? (
                // Never "the catalog is empty" before the catalog has been
                // read: that sentence sends somebody to press a button that
                // talks to a domain controller for no reason.
                <p className="text-muted">Reading the entitlement catalog…</p>
              ) : entitlements.length === 0 ? (
                <p className="text-muted">The entitlement catalog is empty.</p>
              ) : (
                <div className="space-y-2">
                  <Field
                    label="Search entitlements"
                    name="entitlementQuery"
                    value={entitlementQuery}
                    onChange={setEntitlementQuery}
                    placeholder="Type part of a group name"
                    warning={searching ? 'Searching…' : undefined}
                  />
                  {(() => {
                    const shown = entitlementResults ?? entitlements;
                    // What is selected stays visible even when the search
                    // no longer returns it: a choice must be inspectable to
                    // be reversible.
                    const selectedHidden = entitlements.filter(
                      (e) => draft.entitlementIds.includes(e.id) && !shown.some((s) => s.id === e.id),
                    );
                    const rows = [...selectedHidden, ...shown];
                    if (rows.length === 0) {
                      return <p className="text-muted">No entitlement matches that search.</p>;
                    }
                    return rows.map((entitlement) => {
                      const unmanageable = entitlement.manageable === false;
                      return (
                        <Check
                          key={entitlement.id}
                          checked={draft.entitlementIds.includes(entitlement.id)}
                          disabled={unmanageable && !draft.entitlementIds.includes(entitlement.id)}
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
                              {entitlement.membershipKind === 'dynamic' || unmanageable ? (
                                <span className="ml-2 text-muted">
                                  ({entitlement.membershipKind === 'dynamic' ? 'dynamic membership — ' : ''}not manageable by Syntra{entitlement.unmanageableReason ? `: ${entitlement.unmanageableReason}` : ''})
                                </span>
                              ) : null}
                              {entitlement.status !== 'present' && (
                                <span className="ml-2 text-danger">
                                  ({entitlement.status} — matched persons become unprocessable)
                                </span>
                              )}
                            </>
                          }
                        />
                      );
                    });
                  })()}
                </div>
              )}
            </fieldset>
          </FormSection>

          <FormSection
            title="Impact"
            status={
              busy === 'impact' ? (
                <StateBadge state="running">Previewing</StateBadge>
              ) : impactStale ? (
                <StaleBadge />
              ) : impact ? (
                <StateBadge state="healthy">Matches this draft</StateBadge>
              ) : previewRequired ? (
                <StateBadge state="setup">Not previewed</StateBadge>
              ) : null
            }
          >
            <div className="sm:col-span-2">
              {impact && (
                <div className="rounded-panel border border-border-subtle p-4">
                  {/* A rule whose blast radius is only visible after it is saved
                      is a rule that gets saved and then discovered. The
                      revocation count leads when there is one: an edit that
                      empties a rule's entitlement list revokes everything that
                      rule ever granted, and that is the change most likely to be
                      made without meaning it. */}
                  <MetricRow>
                    <Metric
                      label="Persons matched"
                      value={`${impact.matchedPersons} of ${impact.totalPersons}`}
                    />
                    <Metric label="Would grant" value={impact.wouldGrant} />
                    <Metric
                      label="Would revoke"
                      value={impact.wouldRevoke}
                      tone="danger"
                      quietWhenZero
                    />
                  </MetricRow>
                  {impact.wouldRevoke > 0 && (
                    <div className="mt-3">
                      <Alert tone="warning">
                        {`${impact.wouldRevoke} holding${
                          impact.wouldRevoke === 1 ? '' : 's'
                        } would be taken away`}
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
          </FormSection>

          <FormActions
            sticky
            status={
              previewRequired && !impact && !impactStale ? (
                <span className="flex flex-wrap items-center gap-2">
                  {dirty && draftStatus({ dirty })}
                  {/* Why Save is disabled, said beside it rather than left for
                      somebody to discover by pressing it. */}
                  <StateBadge state="attention">Preview required before saving</StateBadge>
                </span>
              ) : (
                draftStatus({
                  dirty,
                  stale: impactStale ? 'Preview is out of date' : null,
                })
              )
            }
          >
            <Button onClick={onImpact} loading={busy === 'impact'} disabled={!!busy}>
              Preview impact
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              loading={busy === 'save'}
              disabled={!!busy || (previewRequired && !impact)}
            >
              Save rule
            </Button>
          </FormActions>
        </section>

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
