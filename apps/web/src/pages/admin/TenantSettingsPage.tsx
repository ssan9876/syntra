import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Field, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface TenantView {
  name: string;
  slug: string;
  primaryDomain: string | null;
  additionalDomains: string[];
  adminMfaRequired: boolean;
  selfEnrolmentEnabled: boolean;
  passwordMinLength: number;
  webauthnAvailable: boolean;
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  hint: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 shrink-0 accent-primary"
      />
      <span>
        <span className="font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-sm text-muted">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The tenant's own settings, and the only place the slice's headline admin
 * hardening can be switched on.
 *
 * `adminMfaRequired` and `selfEnrolmentEnabled` were read by the chokepoint and
 * written nowhere; the README told an operator to turn the first on once the
 * owner had enrolled, which was possible only with direct SQL.
 */
export function TenantSettingsPage() {
  const { data, error, loading, reload } =
    useApiResource<TenantView>('/api/admin/tenant');

  const [adminMfaRequired, setAdminMfaRequired] = useState(false);
  const [selfEnrolmentEnabled, setSelfEnrolmentEnabled] = useState(true);
  const [minLength, setMinLength] = useState('12');
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
      <PageHeader
        title="Tenant settings"
        description="How this organization signs in, and what it asks for on the way to the console."
      />

      <form onSubmit={submit} noValidate className="space-y-6">
        <Panel title="Sign-in" bodyClassName="space-y-5 p-4">
          <Toggle
            checked={adminMfaRequired}
            onChange={setAdminMfaRequired}
            label="Require a second factor for the console"
            hint={
              <>
                A floor on top of the authentication policy: elevating to an
                administrative session asks for a factor even where no rule
                does. It can only strengthen the outcome — a rule that denies
                is still a denial. Turn it on once you hold a factor yourself.
                {!data.webauthnAvailable &&
                  ' This tenant has no primary domain, so only an authenticator app can satisfy it; a security key needs a domain to pin its relying party to.'}
              </>
            }
          />

          <Toggle
            checked={selfEnrolmentEnabled}
            onChange={setSelfEnrolmentEnabled}
            label="Let people enrol a factor themselves when one is required"
            hint="On, a user the policy asks a factor from is offered enrolment after their password is accepted, and is signed in straight afterwards. Off, they are refused outright — right for an organization that issues security keys by hand, and a lockout for one that does not."
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
            hint="The hostname this tenant answers on — no scheme, port or path. An IP address is fine. Leave it empty to turn security keys off."
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
              className="w-full max-w-md rounded-control border border-border-subtle bg-bg px-3 py-2 font-mono text-ink placeholder:text-muted hover:border-border-strong"
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
            hint="Twelve is the floor this product enforces; a tenant can ask for more."
            className="max-w-xs"
          />
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
