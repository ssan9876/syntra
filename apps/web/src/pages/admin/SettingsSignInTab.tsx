import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Panel,
  SkeletonRows,
  Textarea,
  useToast,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { formFieldErrors, summaryErrors } from './RecordPanel.js';

interface TenantView {
  name: string;
  slug: string;
  primaryDomain: string | null;
  additionalDomains: string[];
  adminMfaRequired: boolean;
  selfEnrolmentEnabled: boolean;
  passwordMinLength: number;
  lockoutThreshold: number;
  lockoutWindowMinutes: number;
  lockoutDurationMinutes: number;
  passwordMaxAgeDays: number;
  passwordHistoryDepth: number;
  emailOtpEnabled: boolean;
  portalSessionIdleMinutes: number;
  portalSessionAbsoluteMinutes: number;
  adminSessionIdleMinutes: number;
  adminSessionAbsoluteMinutes: number;
  adminWebauthnRequired: boolean;
  webauthnAvailable: boolean;
}

/**
 * The platform bounds the four lifetime fields are held to, in minutes.
 *
 * Repeated from `SESSION_POLICY_BOUNDS` in the contracts package rather than
 * imported: the web bundle does not depend on it, and these only set the
 * inputs' `min`/`max`. The server is the authority and answers a number
 * outside them with a 400 naming the field.
 */
const LIFETIME_BOUNDS = {
  portalIdle: { min: 5, max: 1440 },
  portalAbsolute: { min: 60, max: 43200 },
  adminIdle: { min: 5, max: 60 },
  adminAbsolute: { min: 15, max: 720 },
} as const;

/**
 * What the toggle turns lockout on to.
 *
 * Five, not the contract's floor of three: three is the lowest a tenant may
 * choose deliberately, and starting somebody there means their first typo
 * costs two more. The floor and the default are different questions.
 */
const DEFAULT_THRESHOLD = 5;

/** The form's own shape: numbers as the strings being typed, lists as text. */
interface SignInForm {
  adminMfaRequired: boolean;
  selfEnrolmentEnabled: boolean;
  minLength: string;
  lockoutOn: boolean;
  threshold: string;
  windowMinutes: string;
  duration: string;
  expiryOn: boolean;
  maxAge: string;
  historyDepth: string;
  emailOtp: boolean;
  adminWebauthn: boolean;
  portalIdle: string;
  portalAbsolute: string;
  adminIdle: string;
  adminAbsolute: string;
  domain: string;
  /**
   * One per line, because that is how somebody pastes a list of hostnames.
   * Split on save rather than kept as an array in state: an array would need
   * add and remove controls for something people edit as text.
   */
  extraDomains: string;
}

const BLANK: SignInForm = {
  adminMfaRequired: false,
  selfEnrolmentEnabled: true,
  minLength: '12',
  lockoutOn: false,
  threshold: String(DEFAULT_THRESHOLD),
  windowMinutes: '15',
  duration: '15',
  expiryOn: false,
  maxAge: '90',
  historyDepth: '0',
  emailOtp: false,
  adminWebauthn: false,
  portalIdle: '60',
  portalAbsolute: '720',
  adminIdle: '15',
  adminAbsolute: '120',
  domain: '',
  extraDomains: '',
};

/**
 * What the form says about a stored tenant.
 *
 * One function rather than eighteen setters in an effect, because it is asked
 * twice: once to fill the form, and again on every render to decide whether
 * the form still says the same thing — which is what "Unsaved changes" means.
 */
function fromView(data: TenantView): SignInForm {
  return {
    adminMfaRequired: data.adminMfaRequired,
    selfEnrolmentEnabled: data.selfEnrolmentEnabled,
    minLength: String(data.passwordMinLength),
    lockoutOn: data.lockoutThreshold > 0,
    // Zero is "off", not a threshold anybody typed. Showing the default in the
    // field instead means switching lockout on does not start from a number
    // the contract rejects.
    threshold: String(data.lockoutThreshold > 0 ? data.lockoutThreshold : DEFAULT_THRESHOLD),
    windowMinutes: String(data.lockoutWindowMinutes),
    duration: String(data.lockoutDurationMinutes),
    expiryOn: data.passwordMaxAgeDays > 0,
    maxAge: String(data.passwordMaxAgeDays > 0 ? data.passwordMaxAgeDays : 90),
    historyDepth: String(data.passwordHistoryDepth),
    emailOtp: data.emailOtpEnabled,
    adminWebauthn: data.adminWebauthnRequired,
    portalIdle: String(data.portalSessionIdleMinutes),
    portalAbsolute: String(data.portalSessionAbsoluteMinutes),
    adminIdle: String(data.adminSessionIdleMinutes),
    adminAbsolute: String(data.adminSessionAbsoluteMinutes),
    domain: data.primaryDomain ?? '',
    extraDomains: data.additionalDomains.join('\n'),
  };
}

const hostnames = (text: string) =>
  text
    .split('\n')
    .map((h) => h.trim())
    .filter((h) => h !== '');

/**
 * The API's field names, as the form labels them. The controls carry the API
 * name as their `name`, so a server refusal naming `lockoutWindowMinutes`
 * lands on — and the summary links to — the box that holds it.
 */
const LABELS: Record<string, string> = {
  adminMfaRequired: 'Require a second factor for the console',
  selfEnrolmentEnabled: 'Let people enrol a factor themselves',
  emailOtpEnabled: 'Allow a code sent by email',
  adminWebauthnRequired: 'Require a security key for the console',
  portalSessionIdleMinutes: 'Portal idle timeout',
  portalSessionAbsoluteMinutes: 'Portal session lasts',
  adminSessionIdleMinutes: 'Console idle timeout',
  adminSessionAbsoluteMinutes: 'Console session lasts',
  passwordMinLength: 'Minimum password length',
  passwordHistoryDepth: 'Previous passwords that may not be reused',
  passwordMaxAgeDays: 'Password lasts',
  lockoutThreshold: 'Failures before locking',
  lockoutWindowMinutes: 'Counted over',
  lockoutDurationMinutes: 'Lock lasts',
  primaryDomain: 'Primary domain',
  additionalDomains: 'Also answers on',
};

/**
 * The tenant's own settings, and the only place the slice's headline admin
 * hardening can be switched on.
 *
 * `adminMfaRequired` and `selfEnrolmentEnabled` were read by the chokepoint and
 * written nowhere; the README told an operator to turn the first on once the
 * owner had enrolled, which was possible only with direct SQL.
 *
 * One form in five stages, ordered by how often somebody comes here for each:
 * who has to prove it is them, how long a session lasts, what a password must
 * be, what happens after failures, and — last, because it is set once at
 * installation and wrong answers lock people out — the address.
 */
export function SettingsSignInTab() {
  const toast = useToast();
  const { data, error, loading, reload } =
    useApiResource<TenantView>('/api/admin/tenant');

  const [form, setForm] = useState<SignInForm>(BLANK);
  const set = <K extends keyof SignInForm>(key: K, value: SignInForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  /**
   * The passkey count the server refused with, held until the operator answers.
   *
   * Sent back verbatim on the next attempt rather than recomputed: it is what
   * they were shown, and the server compares it against the live figure so a
   * key enrolled in between reopens the question instead of being swept in.
   */
  const [atRisk, setAtRisk] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    setForm(fromView(data));
  }, [data]);

  const {
    adminMfaRequired,
    selfEnrolmentEnabled,
    minLength,
    lockoutOn,
    threshold,
    windowMinutes,
    duration,
    expiryOn,
    maxAge,
    historyDepth,
    emailOtp,
    adminWebauthn,
    portalIdle,
    portalAbsolute,
    adminIdle,
    adminAbsolute,
    domain,
    extraDomains,
  } = form;

  async function submit(event: FormEvent, acknowledge = false) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setErrors({});
    try {
      await api('/api/admin/tenant', {
        method: 'PUT',
        body: JSON.stringify({
          adminMfaRequired,
          selfEnrolmentEnabled,
          passwordMinLength: Number(minLength),
          lockoutThreshold: lockoutOn ? Number(threshold) : 0,
          lockoutWindowMinutes: Number(windowMinutes),
          lockoutDurationMinutes: Number(duration),
          passwordMaxAgeDays: expiryOn ? Number(maxAge) : 0,
          passwordHistoryDepth: Number(historyDepth),
          emailOtpEnabled: emailOtp,
          adminWebauthnRequired: adminWebauthn,
          portalSessionIdleMinutes: Number(portalIdle),
          portalSessionAbsoluteMinutes: Number(portalAbsolute),
          adminSessionIdleMinutes: Number(adminIdle),
          adminSessionAbsoluteMinutes: Number(adminAbsolute),
          // Empty clears it, which turns WebAuthn off rather than leaving the
          // old value behind.
          primaryDomain: domain.trim() === '' ? null : domain.trim(),
          additionalDomains: hostnames(extraDomains),
          ...(acknowledge && atRisk !== null ? { ackPasskeys: atRisk } : {}),
        }),
      });
      setAtRisk(null);
      // A toast rather than the inline "Settings saved." this used to leave at
      // the foot of a five-section form — below the fold for anybody who had
      // just changed something in the first section.
      toast({ tone: 'success', title: 'Settings saved' });
      reload();
    } catch (cause) {
      // The count, held for the confirmation. This is not a failure to save —
      // it is the save waiting on a decision, and the decision needs the
      // number behind it. It gets the warning below, not the error summary.
      if (cause instanceof ApiError && cause.kind === 'passkeys-would-break') {
        const count = cause.problem.passkeys;
        setAtRisk(typeof count === 'number' ? count : 0);
        setSaving(false);
        return;
      }
      const marked = formFieldErrors(cause);
      setErrors(marked);
      // The server's own message where it has one. The lock-yourself-out
      // refusal names the fix, and paraphrasing it here would lose that.
      setSaveError(
        Object.keys(marked).length > 0
          ? null
          : cause instanceof ApiError
            ? (cause.problem.detail ?? cause.problem.title)
            : 'That did not save. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <SkeletonRows rows={4} />;
  if (error || !data) {
    return <Alert tone="danger">{error ?? 'Something went wrong.'}</Alert>;
  }

  const saved = fromView(data);
  const dirty = (Object.keys(saved) as (keyof SignInForm)[]).some((key) =>
    key === 'extraDomains'
      ? hostnames(form.extraDomains).join('\n') !== hostnames(saved.extraDomains).join('\n')
      : form[key] !== saved[key],
  );
  const domainChanged = domain.trim() !== (data.primaryDomain ?? '');

  return (
    // The form wraps the panel rather than sitting inside it, so the save bar
    // can be sticky: `Panel` clips its overflow, and a sticky element inside a
    // clipping box sticks to the box rather than to the screen.
    <form onSubmit={submit} noValidate>
      <Panel bodyClassName="space-y-8 p-4">
        <ErrorSummary
          errors={summaryErrors(errors, LABELS, saveError)}
          {...(Object.keys(errors).length === 0 ? { title: 'Not saved' } : {})}
        />

        <FormSection title="Second factor">
          <Check
            className="sm:col-span-2"
            checked={adminMfaRequired}
            onChange={(v) => set('adminMfaRequired', v)}
            label="Require a second factor for the console"
            warning={
              // Only the conditional half of the sentence this replaced
              // survives. The rest explained what the setting is — a floor on
              // top of the authentication policy — which the label now has to
              // carry on its own. This part is different in kind: it is a
              // constraint the tenant is currently under, it changes when the
              // domain is set, and nobody could deduce it from the checkbox.
              data.webauthnAvailable
                ? undefined
                : 'No primary domain is set, so only an authenticator app can satisfy this. A security key needs a domain to pin its relying party to.'
            }
          />

          <Check
            className="sm:col-span-2"
            checked={selfEnrolmentEnabled}
            onChange={(v) => set('selfEnrolmentEnabled', v)}
            label="Let people enrol a factor themselves when one is required"
          />

          <Check
            className="sm:col-span-2"
            checked={emailOtp}
            onChange={(v) => set('emailOtp', v)}
            label="Allow a code sent by email as a second factor"
          />

          <Check
            className="sm:col-span-2"
            checked={adminWebauthn}
            onChange={(v) => set('adminWebauthn', v)}
            label="Require a security key for the console"
            // Never disabled while on: an administrator must always be able
            // to turn a requirement off, even one the server would now refuse
            // to turn on.
            disabled={!data.webauthnAvailable && !adminWebauthn}
            warning={
              // Conditional, like the one above: a state the tenant is in,
              // not a description of the checkbox.
              data.webauthnAvailable
                ? undefined
                : 'No primary domain is set, so no security key can be registered and this cannot be turned on.'
            }
          />

          {adminWebauthn && !data.adminWebauthnRequired && (
            // Shown only on the transition, which is the moment it applies.
            // The server refuses the save unless this console session was
            // itself started with a key, so the one person certain to be
            // affected is also the one proven able to get back in.
            <div className="sm:col-span-2">
              <Alert tone="warning" title="Console sessions started without a key end">
                Every administrator who elevated with an authenticator code,
                an emailed code or a recovery code is signed out of the console
                at their next click, and nobody can register a key while
                elevating. Save from a session you started with your own key.
              </Alert>
            </div>
          )}

          {adminMfaRequired && !selfEnrolmentEnabled && (
            <div className="sm:col-span-2">
              <Alert tone="warning" title="Nobody can enrol their way in">
                Together, these two refuse every administrator who does not
                already hold a factor. Make sure yours is set up, and everyone
                else&apos;s.
              </Alert>
            </div>
          )}
        </FormSection>

        <FormSection title="Sessions">
          <Field
            name="portalSessionIdleMinutes"
            label="Portal idle timeout (minutes)"
            type="number"
            inputMode="numeric"
            min={LIFETIME_BOUNDS.portalIdle.min}
            max={LIFETIME_BOUNDS.portalIdle.max}
            value={portalIdle}
            onChange={(v) => set('portalIdle', v)}
            error={errors.portalSessionIdleMinutes}
          />
          <Field
            name="portalSessionAbsoluteMinutes"
            label="Portal session lasts (minutes)"
            type="number"
            inputMode="numeric"
            min={LIFETIME_BOUNDS.portalAbsolute.min}
            max={LIFETIME_BOUNDS.portalAbsolute.max}
            value={portalAbsolute}
            onChange={(v) => set('portalAbsolute', v)}
            error={errors.portalSessionAbsoluteMinutes}
          />
          <Field
            name="adminSessionIdleMinutes"
            label="Console idle timeout (minutes)"
            type="number"
            inputMode="numeric"
            min={LIFETIME_BOUNDS.adminIdle.min}
            max={LIFETIME_BOUNDS.adminIdle.max}
            value={adminIdle}
            onChange={(v) => set('adminIdle', v)}
            error={errors.adminSessionIdleMinutes}
          />
          <Field
            name="adminSessionAbsoluteMinutes"
            label="Console session lasts (minutes)"
            type="number"
            inputMode="numeric"
            min={LIFETIME_BOUNDS.adminAbsolute.min}
            max={LIFETIME_BOUNDS.adminAbsolute.max}
            value={adminAbsolute}
            onChange={(v) => set('adminAbsolute', v)}
            error={errors.adminSessionAbsoluteMinutes}
          />

          {(Number(portalAbsolute) < data.portalSessionAbsoluteMinutes ||
            Number(portalIdle) < data.portalSessionIdleMinutes ||
            Number(adminAbsolute) < data.adminSessionAbsoluteMinutes ||
            Number(adminIdle) < data.adminSessionIdleMinutes) && (
            // Only while a value is being LOWERED — the one direction with a
            // consequence nobody would guess: it reaches back into sessions
            // already issued. Raising a value does not extend them.
            <div className="sm:col-span-2">
              <Alert tone="warning" title="Shorter limits apply to everyone signed in now">
                Sessions already older or idler than the new limit end at their
                next request.
              </Alert>
            </div>
          )}
        </FormSection>

        <FormSection title="Passwords">
          <Field
            name="passwordMinLength"
            label="Minimum password length"
            type="number"
            inputMode="numeric"
            min={12}
            max={128}
            value={minLength}
            onChange={(v) => set('minLength', v)}
            error={errors.passwordMinLength}
          />

          <Field
            name="passwordHistoryDepth"
            label="Previous passwords that may not be reused"
            type="number"
            inputMode="numeric"
            min={0}
            max={24}
            value={historyDepth}
            onChange={(v) => set('historyDepth', v)}
            error={errors.passwordHistoryDepth}
          />

          <Check
            className="sm:col-span-2"
            checked={expiryOn}
            onChange={(v) => set('expiryOn', v)}
            label="Expire passwords on a schedule"
          />

          {expiryOn && (
            <>
              <Field
                name="passwordMaxAgeDays"
                label="Password lasts (days)"
                type="number"
                inputMode="numeric"
                min={30}
                max={3650}
                value={maxAge}
                onChange={(v) => set('maxAge', v)}
                error={errors.passwordMaxAgeDays}
              />
              <div className="sm:col-span-2">
                <Alert tone="warning" title="Everyone with a local password is affected">
                  Accounts whose password lives in an upstream provider are left
                  alone — Syntra does not own those and a change form here would
                  do nothing. Everyone else is asked to choose a new password the
                  first time they sign in after their current one lapses.
                </Alert>
              </div>
            </>
          )}
        </FormSection>

        <FormSection title="Failed sign-ins">
          <Check
            className="sm:col-span-2"
            checked={lockoutOn}
            onChange={(v) => set('lockoutOn', v)}
            label="Lock an account after repeated failures"
          />

          {lockoutOn && (
            <>
              <Field
                name="lockoutThreshold"
                label="Failures before locking"
                type="number"
                inputMode="numeric"
                min={3}
                max={100}
                value={threshold}
                onChange={(v) => set('threshold', v)}
                error={errors.lockoutThreshold}
              />
              <Field
                name="lockoutWindowMinutes"
                label="Counted over (minutes)"
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                value={windowMinutes}
                onChange={(v) => set('windowMinutes', v)}
                error={errors.lockoutWindowMinutes}
              />
              <Field
                name="lockoutDurationMinutes"
                label="Lock lasts (minutes)"
                type="number"
                inputMode="numeric"
                min={0}
                max={10080}
                value={duration}
                onChange={(v) => set('duration', v)}
                error={errors.lockoutDurationMinutes}
              />

              {Number(duration) === 0 && (
                <div className="sm:col-span-2">
                  <Alert tone="warning" title="These locks do not lift themselves">
                    Every locked account waits for an administrator. Someone has
                    to be reachable to unlock them, including out of hours and
                    including the last administrator who can.
                  </Alert>
                </div>
              )}
            </>
          )}
        </FormSection>

        <FormSection title="Address">
          <Field
            name="primaryDomain"
            label="Primary domain"
            value={domain}
            onChange={(v) => {
              set('domain', v);
              // Any edit reopens the question: the count they acknowledged was
              // for the value they had typed at the time.
              setAtRisk(null);
            }}
            placeholder="syntra.example.com"
            // What used to be a permanent paragraph under this panel, reduced
            // to the moment it applies: the domain is the WebAuthn relying
            // party, so the keys bound to it matter only while it is being
            // moved.
            warning={
              data.webauthnAvailable && domainChanged
                ? 'Security keys are bound to the current domain. Moving it makes every registered key unusable until its holder enrols again.'
                : undefined
            }
            error={errors.primaryDomain}
          />
          <Textarea
            name="additionalDomains"
            label="Also answers on, one hostname per line"
            value={extraDomains}
            onChange={(v) => set('extraDomains', v)}
            rows={3}
            mono
            spellCheck={false}
            placeholder={'192.168.1.10\nsyntra.example.com'}
            warning={
              data.webauthnAvailable && hostnames(extraDomains).length > 0
                ? 'Security keys work on the primary domain only. A browser arriving by one of these names will not offer them.'
                : undefined
            }
            error={errors.additionalDomains}
          />
          {/* A value, labelled as one. This was a sentence beside the save
              button; what it carried was the one address that always works,
              which is the thing to know if the domain above is set wrong. */}
          <dl className="sm:col-span-2">
            <dt className="text-sm font-medium text-muted">Always reachable as</dt>
            <dd className="mt-0.5 text-ink">
              <code className="rounded bg-surface-2 px-1 py-px text-sm">{data.slug}</code>
              <span className="text-muted"> as the leftmost part of any hostname</span>
            </dd>
          </dl>
        </FormSection>

        {atRisk !== null && atRisk > 0 && (
          // The count, and a button that says what it costs. Not a second
          // "Save" — the whole point is that this press is different from the
          // one that was refused.
          <Alert tone="warning" title="This will invalidate registered security keys">
            <p>
              {atRisk} {atRisk === 1 ? 'key is' : 'keys are'} registered against{' '}
              <code>{data.primaryDomain ?? 'no domain'}</code>. Moving the domain
              does not migrate them — whoever holds them will have to enrol
              again, and will not be told until their key stops working.
            </p>
            <Button
              type="button"
              variant="danger"
              loading={saving}
              onClick={(event) => void submit(event as unknown as FormEvent, true)}
              className="mt-3"
            >
              Change the domain and invalidate {atRisk}{' '}
              {atRisk === 1 ? 'key' : 'keys'}
            </Button>
          </Alert>
        )}
      </Panel>

      {/* Sticky: five sections is several screens, and the save used to be
          at the foot of all of them. */}
      <FormActions
        sticky
        status={dirty ? <span className="text-muted">Unsaved changes</span> : null}
      >
        <Button type="submit" variant="primary" loading={saving}>
          Save settings
        </Button>
      </FormActions>
    </form>
  );
}
