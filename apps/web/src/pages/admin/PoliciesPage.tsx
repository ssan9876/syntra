import { useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Panel,
  Select,
  SkeletonRows,
  StateBadge,
  Status,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';
import { PageHeader } from './PageHeader.js';
import { CountryPicker, DEVICE_OPTIONS, DevicePicker, countryName } from './policy-conditions.js';
// The CONTRACT, not a local restatement. The API builds this response by hand
// and this file described it independently, so the two could drift with
// nothing anywhere to notice -- which is the whole reason the schema exists.
// Type-only: a runtime parse in the browser would strip a field the server had
// legitimately started sending.
import type { RuleImpactResponse } from '@syntra/contracts';
import { StatCard, StatGrid } from '../../components/StatCards.js';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  outcome: 'allow' | 'require_mfa' | 'require_factor' | 'deny';
  factorType: 'totp' | 'webauthn' | 'email_otp' | null;
  applicationIds: string[];
  groupIds: string[];
  contractField: string | null;
  contractValues: string[];
  ipRanges: string[];
  devicePlatforms: string[];
  countries: string[];
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

/** What each draft key is called on screen, for the error summary. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  outcome: 'Outcome',
  factorType: 'Which factor',
  ipRanges: 'Source addresses',
  devicePlatforms: 'Devices',
  countries: 'Countries',
  contractField: 'Contract field',
  contractValues: 'Contract values',
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
  if (rule.devicePlatforms.length > 0) {
    parts.push(
      `on ${rule.devicePlatforms
        .map((p) => DEVICE_OPTIONS.find((o) => o.value === p)?.label ?? p)
        .join(' or ')}`,
    );
  }
  if (rule.countries.length > 0) {
    parts.push(`in ${rule.countries.map(countryName).join(' or ')}`);
  }
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

/** How many "applies when" conditions a draft sets, for its section's status. */
function conditionCount(
  ipRanges: string,
  devices: string[],
  countries: string[],
  contractField: string,
): number {
  return (
    (ipRanges.trim() ? 1 : 0) +
    (devices.length > 0 ? 1 : 0) +
    (countries.length > 0 ? 1 : 0) +
    (contractField.trim() ? 1 : 0)
  );
}

export function PoliciesPage() {
  const { data: policy, error, loading, reload } = useApiResource<Policy>('/api/admin/policy');
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  /** The server's per-field refusals, against the controls that caused them. */
  const [formFields, setFormFields] = useState<Record<string, string>>({});
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
  const [factorType, setFactorType] = useState<'totp' | 'webauthn' | 'email_otp'>(
    'webauthn',
  );
  const [ipRanges, setIpRanges] = useState('');
  const [devicePlatforms, setDevicePlatforms] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [contractField, setContractField] = useState('');
  const [contractValues, setContractValues] = useState('');
  const [impact, setImpact] = useState<RuleImpactResponse | null>(null);
  /**
   * The draft the impact figure was computed FOR.
   *
   * The count sits beside the fields it depends on, so an edit made after
   * checking leaves a number on screen describing a rule that no longer
   * exists — and "matches 12 of 40" read after widening the address range is
   * a figure somebody will act on. It is labelled out of date the moment the
   * draft moves away from it, not cleared: the old number is still a useful
   * bound while they decide whether to check again.
   */
  const [impactFor, setImpactFor] = useState<string | null>(null);

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
    devicePlatforms,
    countries,
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
  const draftKey = JSON.stringify(draft());
  const impactStale = impact !== null && impactFor !== draftKey;
  // Against an empty rule, because this form only ever creates one.
  const dirty =
    name !== '' ||
    outcome !== 'require_mfa' ||
    ipRanges !== '' ||
    devicePlatforms.length > 0 ||
    countries.length > 0 ||
    contractField !== '' ||
    contractValues !== '';
  const conditionTotal = conditionCount(ipRanges, devicePlatforms, countries, contractField);

  /** One refusal, split into what belongs against a field and what does not. */
  function refuse(cause: unknown, fallback: string) {
    const marked = formFieldErrors(cause);
    setFormFields(marked);
    setFormError(
      Object.keys(marked).length > 0
        ? null
        : cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : fallback,
    );
  }

  async function checkImpact() {
    setBusy(true);
    setFormError(null);
    setFormFields({});
    const basis = draftKey;
    try {
      setImpact(
        await api<RuleImpactResponse>('/api/admin/policy/rules/impact', {
          method: 'POST',
          body: basis,
        }),
      );
      setImpactFor(basis);
    } catch (cause) {
      refuse(cause, 'That rule could not be checked.');
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    setBusy(true);
    setFormError(null);
    setFormFields({});
    try {
      await api('/api/admin/policy/rules', {
        method: 'POST',
        body: JSON.stringify(draft()),
      });
      setAdding(false);
      setName('');
      setIpRanges('');
      setDevicePlatforms([]);
      setCountries([]);
      setContractField('');
      setContractValues('');
      setOutcome('require_mfa');
      setImpact(null);
      setImpactFor(null);
      toast({ tone: 'success', title: 'Rule saved' });
      reload();
    } catch (cause) {
      // The failing detail is attached rather than replaced with a generic
      // apology: "that rule cannot be stored" without saying which part is
      // wrong sends the administrator back to guessing. This is also where a
      // require_factor: webauthn rule is refused for a tenant with no primary
      // domain — the message names exactly that, and it renders right here,
      // inside the same panel as the outcome and factor controls that caused
      // it, not as a page-wide banner divorced from the field in question.
      refuse(cause, 'That rule could not be saved.');
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
        actions={
          <Button variant="primary" size="sm" onClick={() => setAdding((v) => !v)}>
            Add a rule
          </Button>
        }
      />

      {/* A disabled rule is the failure mode here: it sits in the numbered
          list looking like policy and decides nothing.

          No card for the fallback, though it was the obvious third one. The
          ordered list already ends in a row reading "When no rule matches",
          and that row's POSITION — last, after every rule — is what says it
          is the last resort. A card repeating the words at the top of the
          page would state it twice and mean it less. */}
      <StatGrid>
        <StatCard label="Rules" value={policy?.rules.length ?? 0} />
        <StatCard
          label="Disabled"
          value={(policy?.rules ?? []).filter((r) => !r.enabled).length}
          tone="warning"
          quietWhenZero
        />
      </StatGrid>

      {error && <Alert tone="danger">{error}</Alert>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}

      {adding && (
        <Panel title="New rule">
          {/* A real form, so Enter in any box saves and the error summary can
              find the controls it links to. Three stages, in the order a rule
              is thought about: what it does, when it applies, and who that
              turns out to be. */}
          <form
            noValidate
            className="space-y-6 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void addRule();
            }}
          >
            <ErrorSummary
              errors={summaryErrors(formFields, FIELD_LABELS, formError)}
              {...(Object.keys(formFields).length === 0 ? { title: 'Not saved' } : {})}
            />

            <FormSection title="Rule">
              <Field
                name="name"
                label="Name"
                value={name}
                onChange={setName}
                required
                error={formFields.name}
              />
              <Select
                name="outcome"
                label="Outcome"
                value={outcome}
                onChange={(value) => setOutcome(value as Rule['outcome'])}
                options={(Object.keys(OUTCOME_LABEL) as Rule['outcome'][]).map((value) => ({
                  value,
                  label: OUTCOME_LABEL[value],
                }))}
                error={formFields.outcome}
              />
              {outcome === 'require_factor' && (
                <Select
                  name="factorType"
                  label="Which factor"
                  value={factorType}
                  onChange={(value) =>
                    setFactorType(value as 'totp' | 'webauthn' | 'email_otp')
                  }
                  options={[
                    { value: 'webauthn', label: 'Security key or passkey' },
                    { value: 'totp', label: 'Authenticator app' },
                    { value: 'email_otp', label: 'Emailed code' },
                  ]}
                  // A consequence of THIS choice, shown only while it is the
                  // choice: a key is registered against the primary domain,
                  // and a rule requiring one is refused until it exists.
                  warning={
                    factorType === 'webauthn'
                      ? 'Needs a primary domain set for this tenant. A rule requiring a security key is refused until one exists.'
                      : undefined
                  }
                  error={formFields.factorType}
                />
              )}
            </FormSection>

            <FormSection
              title="Applies when"
              status={
                <span className="text-muted">
                  {conditionTotal === 0
                    ? 'Every sign-in'
                    : `${conditionTotal} condition${conditionTotal === 1 ? '' : 's'}`}
                </span>
              }
            >
              <Field
                name="ipRanges"
                label="Source addresses"
                value={ipRanges}
                onChange={setIpRanges}
                placeholder="203.0.113.0/24, 198.51.100.7"
                error={formFields.ipRanges}
              />
              <CountryPicker value={countries} onChange={setCountries} />
              <Field
                name="contractField"
                label="Contract field"
                value={contractField}
                onChange={setContractField}
                error={formFields.contractField}
              />
              <Field
                name="contractValues"
                label="Contract values"
                value={contractValues}
                onChange={setContractValues}
                error={formFields.contractValues}
              />
              <div className="sm:col-span-2">
                <DevicePicker value={devicePlatforms} onChange={setDevicePlatforms} />
              </div>
              {outcome === 'deny' && devicePlatforms.length > 0 && (
                <div className="sm:col-span-2">
                  <Alert tone="warning" title="A device is what the browser claims to be">
                    <p>
                      Anyone can change it. This will stop an ordinary user on that
                      device and will not stop someone who wants through.
                    </p>
                  </Alert>
                </div>
              )}
            </FormSection>

            <FormSection
              title="Who this affects"
              status={
                impact === null ? (
                  <StateBadge state="setup">Not checked</StateBadge>
                ) : impactStale ? (
                  <StateBadge state="attention">Out of date</StateBadge>
                ) : null
              }
            >
              <div className="space-y-3 sm:col-span-2">
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
                <Button type="button" loading={busy} onClick={checkImpact}>
                  {impactStale ? 'Check again' : 'Check who this affects'}
                </Button>
              </div>
            </FormSection>

            <FormActions
              status={dirty ? <span className="text-muted">Unsaved changes</span> : null}
            >
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Save rule
              </Button>
            </FormActions>
          </form>
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
                  {/* `danger-quiet`: removing a rule changes who is let in, and
                      in a row of move controls it should not look like one
                      more of them. */}
                  <Button size="sm" variant="danger-quiet" onClick={() => remove(rule.id)}>
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
