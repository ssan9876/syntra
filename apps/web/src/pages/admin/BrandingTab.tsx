import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { supportLinkProps } from '../../branding/SupportLink.js';
import { useApiResource } from './hooks.js';

/**
 * What this organization calls itself on the screens their staff see.
 *
 * The whole page is a PREVIEW with controls attached, rather than four fields
 * and a Save. A colour picker beside a paragraph explaining where the colour
 * will appear is a page that has to be read; a sign-in card that changes as
 * you pick is a page that answers the question by showing it.
 *
 * The preview is deliberately the real thing — the same card, the same button,
 * the same type — and not a swatch. A swatch tells you the colour; the card
 * tells you whether the colour works, which is the only question anybody has.
 */

interface Brand {
  name: string | null;
  logo: string | null;
  primary: string | null;
  accent: string | null;
  supportUrl: string | null;
  supportLabel: string | null;
}

/** 256 KB, matching `MAX_LOGO_BYTES`. Checked here so the refusal is instant. */
const MAX_LOGO_BYTES = 256 * 1024;

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function BrandingTab() {
  const { data, error, loading, reload } = useApiResource<Brand>('/api/admin/tenant/brand');
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [primary, setPrimary] = useState('');
  const [accent, setAccent] = useState('');
  const [supportUrl, setSupportUrl] = useState('');
  const [supportLabel, setSupportLabel] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Seeded ONCE, from the first load.
   *
   * Not on every change of `data`: the save below reloads, and a reload that
   * landed while somebody was typing would replace what they had typed with
   * what the server last stored. That is not hypothetical — it is how the
   * cleared-name case failed, quietly sending the old value back and reporting
   * success.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (!data || seeded.current) return;
    seeded.current = true;
    setName(data.name ?? '');
    setLogo(data.logo);
    setPrimary(data.primary ?? '');
    setAccent(data.accent ?? '');
    setSupportUrl(data.supportUrl ?? '');
    setSupportLabel(data.supportLabel ?? '');
  }, [data]);

  function chooseLogo(file: File) {
    setSaveError(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setSaveError(
        'Use a PNG, JPEG, WebP or GIF. SVG is not accepted.',
      );
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setSaveError(
        `That file is ${Math.round(file.size / 1024)} KB. The limit is ${MAX_LOGO_BYTES / 1024} KB.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api('/api/admin/tenant/brand', {
        method: 'PUT',
        body: JSON.stringify({
          name: name.trim() === '' ? null : name.trim(),
          logo,
          primary: primary === '' ? null : primary,
          accent: accent === '' ? null : accent,
          supportUrl: supportUrl.trim() === '' ? null : supportUrl.trim(),
          supportLabel: supportLabel.trim() === '' ? null : supportLabel.trim(),
        }),
      });
      setSaved(true);
      reload();
    } catch (cause) {
      // The server's message, verbatim. It names the contrast ratio it
      // measured and which way to move — "that colour is not allowed" would
      // send somebody back to guessing.
      setSaveError(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That branding could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <SkeletonRows rows={5} cols={2} />;
  if (error) return <Alert tone="danger">{error}</Alert>;

  return (
    <>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Your identity" bodyClassName="space-y-5 p-4">
          <Field
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Syntra"
            maxLength={64}
          />

          <div>
            <span className="mb-1.5 block font-medium text-ink">Logo</span>
            <div className="flex items-center gap-3">
              <input
                ref={fileInput}
                type="file"
                accept={LOGO_TYPES.join(',')}
                className="sr-only"
                aria-label="Logo file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) chooseLogo(file);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => fileInput.current?.click()}
              >
                {logo ? 'Choose a different file' : 'Choose a file'}
              </Button>
              {logo && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setLogo(null)}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>

          <ColourField
            id="brand-primary"
            label="Primary colour"
            value={primary}
            onChange={setPrimary}
          />
          <ColourField
            id="brand-accent"
            label="Accent colour"
            value={accent}
            onChange={setAccent}
          />

          {/* The same check the server and the sign-in page run, so a
              `javascript:` or plain-http address is flagged as it is typed
              rather than after a round trip. */}
          <Field
            label="Support link"
            type="url"
            value={supportUrl}
            onChange={setSupportUrl}
            placeholder="https://help.example.com or mailto:it@example.com"
            spellCheck={false}
            maxLength={2048}
            error={
              supportUrl.trim() !== '' && !supportLinkProps(supportUrl)
                ? 'Use an https:// address or a mailto: address.'
                : undefined
            }
          />
          <Field
            label="Support link text"
            value={supportLabel}
            onChange={setSupportLabel}
            placeholder="Get help"
            maxLength={40}
            disabled={supportUrl.trim() === ''}
          />

          {saveError && <Alert tone="danger">{saveError}</Alert>}
          {saved && !saveError && <Alert>Branding saved.</Alert>}

          <Button variant="primary" loading={saving} onClick={save}>
            Save branding
          </Button>
        </Panel>

        <Panel title="What people will see" bodyClassName="p-4">
          <BrandPreview
            name={name}
            logo={logo}
            primary={primary}
            accent={accent}
            supportUrl={supportUrl}
            supportLabel={supportLabel}
          />
        </Panel>
      </div>
    </>
  );
}

/**
 * A native colour input beside the hex.
 *
 * Both, because they answer different questions: the swatch is how somebody
 * finds a colour, and the hex box is how somebody pastes the one their brand
 * guidelines already specify. Offering only the swatch makes the second person
 * eyeball a value they already know exactly.
 */
function ColourField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange(next: string): void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-medium text-ink">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={valid ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-control border border-border-control bg-bg"
        />
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Syntra's own"
          spellCheck={false}
          className="h-9 w-full rounded-control border border-border-control bg-bg px-3 font-mono text-ink"
        />
        {value !== '' && (
          <Button type="button" variant="secondary" size="sm" onClick={() => onChange('')}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The sign-in card and the top of the portal, drawn with the values in the
 * form rather than the ones that are saved.
 *
 * Inline styles, not theme classes: these colours are not in the theme yet,
 * and the point of a preview is to show what they will look like BEFORE they
 * are. Both surfaces, because they are the two a tenant's staff actually see —
 * a colour that works on a button can still be wrong as the portal's current
 * tab, and a help link is only reassuring once you can see where it sits.
 */
function BrandPreview({
  name,
  logo,
  primary,
  accent,
  supportUrl,
  supportLabel,
}: {
  name: string;
  logo: string | null;
  primary: string;
  accent: string;
  supportUrl: string;
  supportLabel: string;
}) {
  const hex = (value: string) => (/^#[0-9a-fA-F]{6}$/.test(value) ? value : null);
  const brandPrimary = hex(primary);
  const brandAccent = hex(accent);
  const linkStyle = brandAccent ? { color: brandAccent } : undefined;
  const linkClass = brandAccent ? 'underline' : 'text-accent underline';
  // Drawn only when it would be drawn for real: an address the sign-in page
  // would refuse to link does not appear here either.
  const help = supportLinkProps(supportUrl) ? supportLabel.trim() || 'Get help' : null;
  const displayName = name.trim() === '' ? 'Syntra' : name;

  const mark = logo ? (
    <img src={logo} alt="" className="h-7 w-auto max-w-40 object-contain" />
  ) : (
    <span className="text-md font-semibold tracking-tight text-ink">{displayName}</span>
  );

  return (
    <div className="space-y-5">
      <figure>
        <figcaption className="mb-1.5 text-sm font-medium text-muted">Sign-in page</figcaption>
        <div className="rounded-control border border-border bg-surface-2 p-8">
          <div className="mx-auto max-w-sm rounded-control border border-border bg-bg p-6 shadow-sm">
            <div className="mb-6 flex items-center gap-2.5">{mark}</div>

            <p className="mb-1.5 font-medium text-ink">Username</p>
            <div className="mb-4 h-9 rounded-control border border-border-control bg-surface-2" />
            <p className="mb-1.5 font-medium text-ink">Password</p>
            <div className="mb-5 h-9 rounded-control border border-border-control bg-surface-2" />

            <div
              className={`flex h-9 items-center justify-center rounded-control font-medium ${
                brandPrimary ? '' : 'bg-primary text-bg'
              }`}
              style={
                brandPrimary
                  ? { backgroundColor: brandPrimary, color: 'var(--color-bg)' }
                  : undefined
              }
            >
              Sign in
            </div>

            <p className="mt-4 text-sm">
              <span className={linkClass} style={linkStyle}>
                Forgotten your password?
              </span>
            </p>
          </div>
          <p className="mt-3 text-center text-sm text-muted">
            {help ? (
              <>
                Trouble signing in?{' '}
                <span className={linkClass} style={linkStyle}>
                  {help}
                </span>
              </>
            ) : (
              'Trouble signing in? Contact your IT administrator.'
            )}
          </p>
        </div>
      </figure>

      <figure>
        <figcaption className="mb-1.5 text-sm font-medium text-muted">Portal</figcaption>
        <div className="overflow-hidden rounded-control border border-border bg-bg">
          <div className="flex h-12 items-center border-b border-border-subtle px-4">{mark}</div>
          <div className="flex gap-4 border-b border-border-subtle bg-surface-2 px-4 text-sm font-medium">
            <span
              className={`-mb-px border-b-2 py-2 ${brandPrimary ? '' : 'border-primary text-primary'}`}
              style={
                brandPrimary ? { borderColor: brandPrimary, color: brandPrimary } : undefined
              }
            >
              Applications
            </span>
            <span className="py-2 text-muted">Request access</span>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-4">
            <span className="text-lg font-semibold tracking-tight text-ink">Good day, Ada</span>
            {help && (
              <span className={`text-sm ${linkClass}`} style={linkStyle}>
                {help}
              </span>
            )}
          </div>
        </div>
      </figure>
    </div>
  );
}
