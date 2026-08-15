import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Field, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface TenantView {
  name: string;
  slug: string;
  primaryDomain: string | null;
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setAdminMfaRequired(data.adminMfaRequired);
    setSelfEnrolmentEnabled(data.selfEnrolmentEnabled);
    setMinLength(String(data.passwordMinLength));
  }, [data]);

  async function submit(event: FormEvent) {
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
        }),
      });
      setSaved(true);
      reload();
    } catch (cause) {
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

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={saving}>
            Save settings
          </Button>
          <p className="text-sm text-muted">
            Signing in reaches this tenant at <code>{data.slug}</code>
            {data.primaryDomain ? ` and ${data.primaryDomain}` : ''}. Neither is
            editable here: changing the domain invalidates every security key
            registered against it.
          </p>
        </div>
      </form>
    </>
  );
}
