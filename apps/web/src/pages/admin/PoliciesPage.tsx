import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';
// The CONTRACT, not a local restatement. The API builds this response by hand
// and this file described it independently, so the two could drift with
// nothing anywhere to notice -- which is the whole reason the schema exists.
// Type-only: a runtime parse in the browser would strip a field the server had
// legitimately started sending.
import type { RuleImpactResponse } from '@syntra/contracts';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: 'allow' | 'require_mfa' | 'require_factor' | 'deny';
  factorType: 'totp' | 'webauthn' | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: string | null;
  contractValues: string[];
  ipRanges: string[];
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  timezone: string | null;
}

interface Policy {
  fallback: { outcome: Rule['outcome']; factorType: Rule['factorType'] };
  rules: Rule[];
}


const OUTCOME_LABEL: Record<Rule['outcome'], string> = {
  allow: 'Allow',
  require_mfa: 'Require a second factor',
  require_factor: 'Require a specific factor',
  deny: 'Refuse',
};

const OUTCOME_TONE: Record<Rule['outcome'], 'active' | 'warning' | 'danger'> = {
  allow: 'active',
  require_mfa: 'warning',
  require_factor: 'warning',
  deny: 'danger',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * The conditions in words. A rule is only auditable if an administrator can
 * read what it does without reconstructing it from form fields.
 */
function conditions(rule: Rule): string[] {
  const parts: string[] = [];
  if (rule.applicationIds.length > 0) {
    parts.push(`${rule.applicationIds.length} named application(s)`);
  }
  if (rule.groupIds.length > 0) parts.push(`${rule.groupIds.length} named group(s)`);
  if (rule.contractField && rule.contractValues.length > 0) {
    parts.push(`${rule.contractField} is ${rule.contractValues.join(' or ')}`);
  }
  if (rule.ipRanges.length > 0) parts.push(`from ${rule.ipRanges.join(', ')}`);
  if (rule.daysOfWeek.length > 0) {
    parts.push(`on ${rule.daysOfWeek.map((d) => DAYS[d]).join(', ')}`);
  }
  if (rule.startMinute !== null && rule.endMinute !== null) {
    parts.push(
      `between ${clock(rule.startMinute)} and ${clock(rule.endMinute)} ${rule.timezone ?? 'UTC'}`,
    );
  }
  return parts.length > 0 ? parts : ['every sign-in'];
}

export function PoliciesPage() {
  const { data: policy, error, loading, reload } = useApiResource<Policy>('/api/admin/policy');
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Refusals from the LIST controls, rendered at page level.
   *
   * Deliberately not `formError`: that one lives inside the "add a rule"
   * panel, which is collapsed unless somebody is adding a rule -- so a refused
   * Remove would have set a message nobody could see, which is the same
   * silence this task exists to end, one layer in.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [outcome, setOutcome] = useState<Rule['outcome']>('require_mfa');
  const [factorType, setFactorType] = useState<'totp' | 'webauthn'>('webauthn');
  const [ipRanges, setIpRanges] = useState('');
  const [contractField, setContractField] = useState('');
  const [contractValues, setContractValues] = useState('');
  const [impact, setImpact] = useState<RuleImpactResponse | null>(null);

  const list = (value: string) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  const draft = () => ({
    name,
    outcome,
    factorType: outcome === 'require_factor' ? factorType : null,
    ipRanges: list(ipRanges),
    contractField: contractField || null,
    contractValues: list(contractValues),
  });

  /**
   * Who this rule would touch, asked before it is stored.
   *
   * Directory Sync's deactivation threshold exists because a change that
   * silently affected everyone looked exactly like one that affected nobody
   * until it had already happened. A rule requiring a second factor is the
   * same shape: everyone it matches who holds no factor is sent through
   * enrolment on their next sign-in, and an administrator is entitled to know
   * how many people that is first.
   */
  async function checkImpact() {
    setBusy(true);
    setFormError(null);
    try {
      setImpact(
        await api<RuleImpactResponse>('/api/admin/policy/rules/impact', {
          method: 'POST',
          body: JSON.stringify(draft()),
        }),
      );
    } catch (cause) {
      setFormError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be checked.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    setBusy(true);
    setFormError(null);
    try {
      await api('/api/admin/policy/rules', {
        method: 'POST',
        body: JSON.stringify(draft()),
      });
      setAdding(false);
      setName('');
      setIpRanges('');
      setContractField('');
      setContractValues('');
      setImpact(null);
      reload();
    } catch (cause) {
      // The failing detail is attached rather than replaced with a generic
      // apology: "that rule cannot be stored" without saying which part is
      // wrong sends the administrator back to guessing. This is also where a
      // require_factor: webauthn rule is refused for a tenant with no primary
      // domain — the message names exactly that, and it renders right here,
      // inside the same panel as the outcome and factor controls that caused
      // it, not as a page-wide banner divorced from the field in question.
      setFormError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, delta: number) {
    if (!policy) return;
    const ids = policy.rules.map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setActionError(null);
    try {
      await api('/api/admin/policy/rules/order', {
        method: 'PUT',
        body: JSON.stringify({ ruleIds: ids }),
      });
      reload();
    } catch (cause) {
      // Rule ORDER decides which rule wins, so a reorder that silently did not
      // happen leaves the administrator believing a different rule is in force
      // than the one that is.
      setActionError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be moved.',
      );
    }
  }

  async function remove(id: string) {
    setActionError(null);
    try {
      await api(`/api/admin/policy/rules/${id}`, { method: 'DELETE' });
      reload();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That rule could not be removed.',
      );
    }
  }

  return (
    <>
      <PageHeader
        title="Authentication policy"
        description="The first rule that matches decides. Rules are evaluated top to bottom on every sign-in and every application launch."
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding((v) => !v)}>
            Add a rule
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {adding && (
        <Panel title="New rule">
          <div className="space-y-4 p-4">
            <Field label="Name" value={name} onChange={setName} required />

            <div>
              <label htmlFor="policy-outcome" className="mb-1.5 block font-medium text-ink">
                Outcome
              </label>
              <select
                id="policy-outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as Rule['outcome'])}
                className="h-9 w-full rounded-control border border-border-subtle bg-bg px-3 text-ink"
              >
                {(Object.keys(OUTCOME_LABEL) as Rule['outcome'][]).map((value) => (
                  <option key={value} value={value}>
                    {OUTCOME_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>

            {outcome === 'require_factor' && (
              <div>
                <label htmlFor="policy-factor" className="mb-1.5 block font-medium text-ink">
                  Which factor
                </label>
                <select
                  id="policy-factor"
                  value={factorType}
                  onChange={(e) => setFactorType(e.target.value as 'totp' | 'webauthn')}
                  className="h-9 w-full rounded-control border border-border-subtle bg-bg px-3 text-ink"
                >
                  <option value="webauthn">Security key or passkey</option>
                  <option value="totp">Authenticator app</option>
                </select>
                {factorType === 'webauthn' && (
                  <p className="mt-1.5 text-sm text-muted">
                    Needs a primary domain set for this tenant — a security key is
                    registered against it, and a rule requiring one is refused
                    until it exists.
                  </p>
                )}
              </div>
            )}

            <Field
              label="Source addresses"
              value={ipRanges}
              onChange={setIpRanges}
              hint="CIDR ranges or single addresses, comma separated. Leave empty to match any address."
            />
            <Field
              label="Contract field"
              value={contractField}
              onChange={setContractField}
              hint="department, jobTitle, employer or location. Leave empty to ignore contracts."
            />
            <Field
              label="Contract values"
              value={contractValues}
              onChange={setContractValues}
              hint="Comma separated. A person with several concurrent contracts matches if any one of them does."
            />

            {impact && (
              <Alert
                tone={impact.usersNeedingEnrolment > 0 ? 'warning' : 'info'}
                title={`Matches ${impact.matchedUsers} of ${impact.totalActiveUsers} active users`}
              >
                <p>
                  {impact.usersNeedingEnrolment === 0
                    ? 'Everyone it matches already holds a factor that satisfies it.'
                    : `${impact.usersNeedingEnrolment} of them hold no factor that satisfies this rule, and will be asked to set one up the next time they sign in.`}
                </p>
                {impact.unevaluatedConditions.length > 0 && (
                  <p className="mt-1 text-sm text-muted">
                    Counted without {impact.unevaluatedConditions.join(' or ')}, which
                    only a real sign-in can supply. The true number is at most this.
                  </p>
                )}
              </Alert>
            )}

            {formError && (
              <Alert tone="danger">
                <span>{formError}</span>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={checkImpact}>
                Check who this affects
              </Button>
              <Button variant="primary" loading={busy} onClick={addRule}>
                Save rule
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <div className="mt-6 space-y-4">
        {loading && <SkeletonRows rows={3} cols={3} />}

        {!loading && policy && policy.rules.length === 0 && (
          <Empty title="No rules yet">
            Every sign-in falls through to the default below. Add a rule to require
            a second factor of a group, a department or an address range.
          </Empty>
        )}

        {!loading && policy && policy.rules.length > 0 && (
          <ol className="space-y-2">
            {policy.rules.map((rule, index) => (
              <li
                key={rule.id}
                className="flex items-start gap-3 rounded-panel border border-border-subtle bg-bg p-4"
              >
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-medium tabular-nums text-muted">
                  {rule.position}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{rule.name}</span>
                    <Status tone={OUTCOME_TONE[rule.outcome]}>
                      {OUTCOME_LABEL[rule.outcome]}
                      {rule.outcome === 'require_factor' && rule.factorType
                        ? `: ${rule.factorType === 'webauthn' ? 'security key' : 'authenticator app'}`
                        : ''}
                    </Status>
                    {!rule.enabled && <Status tone="neutral">Disabled</Status>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{conditions(rule).join(' · ')}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {/*
                    Rendered only when the move is possible. Every row
                    otherwise carried both buttons regardless of position, so
                    the first row's "Move up" was a no-op that looked
                    identical to a working one — rule order is meaning here,
                    not decoration, and a control that quietly does nothing is
                    the opposite of legible.
                  */}
                  {index > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => move(index, -1)}>
                      Move up
                    </Button>
                  )}
                  {index < policy.rules.length - 1 && (
                    <Button size="sm" variant="ghost" onClick={() => move(index, 1)}>
                      Move down
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => remove(rule.id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}

        {!loading && policy && (
          <Panel title="Default">
            <p className="p-4 text-muted">
              When no rule matches:{' '}
              <span className="font-medium text-ink">
                {OUTCOME_LABEL[policy.fallback.outcome]}
              </span>
              .
            </p>
          </Panel>
        )}
      </div>
    </>
  );
}
