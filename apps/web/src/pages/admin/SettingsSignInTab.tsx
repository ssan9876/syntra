import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Check, Field, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

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
  webauthnAvailable: boolean;
}

/**
 * What the toggle turns lockout on to.
 *
 * Five, not the contract's floor of three: three is the lowest a tenant may
 * choose deliberately, and starting somebody there means their first typo
 * costs two more. The floor and the default are different questions.
 */
const DEFAULT_THRESHOLD = 5;


/**
 * The tenant's own settings, and the only place the slice's headline admin
 * hardening can be switched on.
 *
 * `adminMfaRequired` and `selfEnrolmentEnabled` were read by the chokepoint and
 * written nowhere; the README told an operator to turn the first on once the
 * owner had enrolled, which was possible only with direct SQL.
 */
export function SettingsSignInTab() {
  const { data, error, loading, reload } =
    useApiResource<TenantView>('/api/admin/tenant');

  const [adminMfaRequired, setAdminMfaRequired] = useState(false);
  const [selfEnrolmentEnabled, setSelfEnrolmentEnabled] = useState(true);
  const [minLength, setMinLength] = useState('12');
  const [lockoutOn, setLockoutOn] = useState(false);
  const [threshold, setThreshold] = useState(String(DEFAULT_THRESHOLD));
  const [windowMinutes, setWindowMinutes] = useState('15');
  const [duration, setDuration] = useState('15');
  const [expiryOn, setExpiryOn] = useState(false);
  const [maxAge, setMaxAge] = useState('90');
  const [historyDepth, setHistoryDepth] = useState('0');
  const [emailOtp, setEmailOtp] = useState(false);
  const [domain, setDomain] = useState('');
  /**
   * One per line, because that is how somebody pastes a list of hostnames.
   * Split on save rather than kept as an array in state: an array would need
   * add and remove controls for something people edit as text.
   */
  const [extraDomains, setExtraDomains] = useState('');
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
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setAdminMfaRequired(data.adminMfaRequired);
    setSelfEnrolmentEnabled(data.selfEnrolmentEnabled);
    setMinLength(String(data.passwordMinLength));
    setLockoutOn(data.lockoutThreshold > 0);
    // Zero is "off", not a threshold anybody typed. Showing the default in the
    // field instead means switching lockout on does not start from a number
    // the contract rejects.
    setThreshold(
      String(data.lockoutThreshold > 0 ? data.lockoutThreshold : DEFAULT_THRESHOLD),
    );
    setWindowMinutes(String(data.lockoutWindowMinutes));
    setDuration(String(data.lockoutDurationMinutes));
    setExpiryOn(data.passwordMaxAgeDays > 0);
    setMaxAge(String(data.passwordMaxAgeDays > 0 ? data.passwordMaxAgeDays : 90));
    setHistoryDepth(String(data.passwordHistoryDepth));
    setEmailOtp(data.emailOtpEnabled);
    setDomain(data.primaryDomain ?? '');
    setExtraDomains(data.additionalDomains.join('\n'));
  }, [data]);

  async function submit(event: FormEvent, acknowledge = false) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
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
          // Empty clears it, which turns WebAuthn off rather than leaving the
          // old value behind.
          primaryDomain: domain.trim() === '' ? null : domain.trim(),
          additionalDomains: extraDomains
            .split('\n')
            .map((h) => h.trim())
            .filter((h) => h !== ''),
          ...(acknowledge && atRisk !== null ? { ackPasskeys: atRisk } : {}),
        }),
      });
      setSaved(true);
      setAtRisk(null);
      reload();
    } catch (cause) {
      // The count, held for the confirmation. This is not a failure to save —
      // it is the save waiting on a decision, and the decision needs the
      // number behind it.
      if (cause instanceof ApiError && cause.kind === 'passkeys-would-break') {
        const count = cause.problem.passkeys;
        setAtRisk(typeof count === 'number' ? count : 0);
        setSaveError(cause.problem.detail ?? cause.problem.title);
        setSaving(false);
        return;
      }
      // The server's own message where it has one. The lock-yourself-out
      // refusal names the fix, and paraphrasing it here would lose that.
      setSaveError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That did not save. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <SkeletonRows rows={4} />;
  if (error || !data) {
    return <Alert tone="danger">{error ?? 'Something went wrong.'}</Alert>;
  }

  return (
    <>

      <form onSubmit={submit} noValidate className="space-y-6">
        <Panel title="Sign-in" bodyClassName="space-y-5 p-4">
          <Check
            checked={adminMfaRequired}
            onChange={setAdminMfaRequired}
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
            checked={selfEnrolmentEnabled}
            onChange={setSelfEnrolmentEnabled}
            label="Let people enrol a factor themselves when one is required"
          />

          <Check
            checked={emailOtp}
            onChange={setEmailOtp}
            label="Allow a code sent by email as a second factor"
            // The hint states the trade rather than selling the feature. An
            // administrator turning this on should know what it is worth.
          />

          {adminMfaRequired && !selfEnrolmentEnabled && (
            <Alert tone="warning" title="Nobody can enrol their way in">
              Together, these two refuse every administrator who does not
              already hold a factor. Make sure yours is set up, and everyone
              else&apos;s.
            </Alert>
          )}
        </Panel>

        <Panel title="Address" bodyClassName="p-4 space-y-3">
          <Field
            label="Primary domain"
            value={domain}
            onChange={(v) => {
              setDomain(v);
              // Any edit reopens the question: the count they acknowledged was
              // for the value they had typed at the time.
              setAtRisk(null);
            }}
            placeholder="syntra.example.com"
            className="max-w-md"
          />
          <label className="block">
            <span className="mb-1.5 block font-medium text-ink">
              Also answers on
            </span>
            <textarea
              value={extraDomains}
              onChange={(e) => setExtraDomains(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'192.168.1.10\nsyntra.example.com'}
              className="w-full max-w-md rounded-control border border-border-control bg-bg px-3 py-2 font-mono text-ink placeholder:text-muted hover:border-border-strong"
            />
            <span className="mt-1.5 block text-sm text-muted">
              One hostname per line. An instance is reached by address while it
              is being set up and by a DNS name once somebody points one at it —
              listing both means pointing the record is not a cutover.
            </span>
          </label>

          {data.webauthnAvailable && (
            <p className="text-sm text-muted">
              The primary domain is also the WebAuthn relying party. Security
              keys are bound to it and cannot be moved: changing it makes every
              registered key unusable, and their holders will have to enrol
              again. Keys do not work on the additional hostnames either — a
              browser arriving by another name will not offer them.
            </p>
          )}
        </Panel>

        <Panel title="Passwords" bodyClassName="p-4">
          <Field
            label="Minimum password length"
            type="number"
            inputMode="numeric"
            min={12}
            max={128}
            value={minLength}
            onChange={setMinLength}
            className="max-w-xs"
          />

          <Field
            label="Previous passwords that may not be reused"
            type="number"
            inputMode="numeric"
            min={0}
            max={24}
            value={historyDepth}
            onChange={setHistoryDepth}
            className="max-w-xs"
          />

          <Check
            checked={expiryOn}
            onChange={setExpiryOn}
            label="Expire passwords on a schedule"
          />

          {expiryOn && (
            <>
              <Field
                label="Password lasts (days)"
                type="number"
                inputMode="numeric"
                min={30}
                max={3650}
                value={maxAge}
                onChange={setMaxAge}
                className="max-w-xs"
              />
              <Alert tone="warning" title="Everyone with a local password is affected">
                Accounts whose password lives in an upstream provider are left
                alone — Syntra does not own those and a change form here would
                do nothing. Everyone else is asked to choose a new password the
                first time they sign in after their current one lapses.
              </Alert>
            </>
          )}
        </Panel>

        <Panel title="Failed sign-ins" bodyClassName="space-y-5 p-4">
          <Check
            checked={lockoutOn}
            onChange={setLockoutOn}
            label="Lock an account after repeated failures"
          />

          {lockoutOn && (
            <>
              <div className="flex flex-wrap gap-4">
                <Field
                  label="Failures before locking"
                  type="number"
                  inputMode="numeric"
                  min={3}
                  max={100}
                  value={threshold}
                  onChange={setThreshold}
                  className="max-w-[13rem]"
                />
                <Field
                  label="Counted over (minutes)"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  value={windowMinutes}
                  onChange={setWindowMinutes}
                  className="max-w-[13rem]"
                />
                <Field
                  label="Lock lasts (minutes)"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={10080}
                  value={duration}
                  onChange={setDuration}
                  className="max-w-[13rem]"
                />
              </div>

              {Number(duration) === 0 && (
                <Alert tone="warning" title="These locks do not lift themselves">
                  Every locked account waits for an administrator. Someone has
                  to be reachable to unlock them, including out of hours and
                  including the last administrator who can.
                </Alert>
              )}
            </>
          )}
        </Panel>

        {saveError && <Alert tone="danger">{saveError}</Alert>}
        {saved && !saveError && <Alert>Settings saved.</Alert>}

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

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={saving}>
            Save settings
          </Button>
          <p className="text-sm text-muted">
            Signing in also reaches this tenant at <code>{data.slug}</code>, as
            the leftmost part of any hostname. That fallback is not editable,
            and it is the way back in if the domain above is set wrong.
          </p>
        </div>
      </form>
    </>
  );
}
