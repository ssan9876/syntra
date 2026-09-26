import { useId, useRef, useState, type ChangeEvent } from 'react';
import {
  APP_ICON_IMAGE_TYPES,
  BUILTIN_APP_ICONS,
  BUILTIN_APP_ICON_LABELS,
  MAX_APP_ICON_BYTES,
  builtinAppIconPath,
  type ApplicationIconView,
  type BuiltinAppIcon,
} from '@syntra/contracts/src/app-icon-keys.js';
import { Alert, Button, FormActions, Panel, useToast } from '@syntra/ui';
import { AppLogo, monogram } from '../../components/AppLogo.js';
import { ApiError, api } from '../../session/api.js';

/** What the reader has chosen and not yet saved. */
type Draft =
  | { kind: 'builtin'; key: BuiltinAppIcon }
  | { kind: 'image'; dataUri: string; fileName: string; bytes: number }
  | { kind: 'none' };

function draftFrom(icon: ApplicationIconView): Draft {
  if (!icon) return { kind: 'none' };
  if (icon.kind === 'builtin') return { kind: 'builtin', key: icon.key };
  return { kind: 'image', dataUri: icon.url, fileName: 'Uploaded image', bytes: icon.bytes };
}

function srcOf(draft: Draft): string | null {
  if (draft.kind === 'builtin') return builtinAppIconPath(draft.key);
  if (draft.kind === 'image') return draft.dataUri;
  return null;
}

function same(a: Draft, b: Draft): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.key === b.key;
  if (a.kind === 'image' && b.kind === 'image') return a.dataUri === b.dataUri;
  return true;
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Choosing an application's logo: one of the marks Syntra ships, an image the
 * organisation uploads, or the monogram.
 *
 * Every option is hosted here. The portal's security policy loads images from
 * this origin only, so a vendor URL pasted into a field would have been a
 * logo that never appeared — the reason this is a picker and not a text box.
 *
 * The preview at the top is the real tile component at the real size, so
 * what is approved here is what an employee sees. Nothing is saved until
 * Save: a reader comparing three marks should not publish two of them to the
 * portal on the way.
 */
export function AppLogoPicker({
  applicationId,
  name,
  icon,
  onSaved,
}: {
  applicationId: string;
  name: string;
  icon: ApplicationIconView;
  onSaved(icon: ApplicationIconView): void;
}) {
  const toast = useToast();
  const groupId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const saved = draftFrom(icon);
  const [draft, setDraft] = useState<Draft>(saved);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = !same(draft, saved);

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadError(null);
    // Checked here for a quick answer, and again by the server, which also
    // reads the file's first bytes: a renamed SVG is still refused there.
    if (!(APP_ICON_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setUploadError('Choose a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > MAX_APP_ICON_BYTES) {
      setUploadError(`That image is ${kb(file.size)}. The limit is ${kb(MAX_APP_ICON_BYTES)}.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDraft({ kind: 'image', dataUri: reader.result, fileName: file.name, bytes: file.size });
      }
    };
    reader.onerror = () => setUploadError('That file could not be read.');
    reader.readAsDataURL(file);
  }

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      const body =
        draft.kind === 'none'
          ? { icon: null }
          : draft.kind === 'builtin'
            ? { icon: { kind: 'builtin', key: draft.key } }
            : { icon: { kind: 'image', dataUri: draft.dataUri } };
      const result = await api<{ icon: ApplicationIconView }>(
        `/api/admin/applications/${applicationId}/icon`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      onSaved(result.icon);
      setDraft(draftFrom(result.icon));
      toast({ title: draft.kind === 'none' ? 'Logo removed' : 'Logo saved' });
    } catch (cause) {
      setSaveError(
        cause instanceof ApiError
          ? cause.problem.errors?.[0]?.message ?? cause.problem.detail ?? cause.problem.title
          : 'The logo could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  const selectedKey = draft.kind === 'builtin' ? draft.key : null;

  return (
    <Panel title="Logo">
      <div className="space-y-5 p-4">
        {/* The tile, as the portal draws it. */}
        <div className="flex flex-wrap items-center gap-6">
          <div
            aria-label="Portal preview"
            role="img"
            className="flex w-72 max-w-full items-center gap-3 rounded-panel border border-border-control bg-bg p-4"
          >
            <AppLogo name={name} src={srcOf(draft)} />
            <span className="min-w-0 truncate font-semibold text-ink">{name}</span>
          </div>
          <dl className="text-sm">
            <dt className="font-medium text-muted">{dirty ? 'Not saved' : 'In use'}</dt>
            <dd className="mt-0.5 font-medium text-ink">
              {draft.kind === 'builtin'
                ? BUILTIN_APP_ICON_LABELS[draft.key]
                : draft.kind === 'image'
                  ? `${draft.fileName} · ${kb(draft.bytes)}`
                  : 'Monogram'}
            </dd>
          </dl>
        </div>

        <fieldset>
          <legend id={groupId} className="mb-2 font-medium text-ink">
            Built-in logos
          </legend>
          {/* Native radios, visually replaced: arrow keys, one tab stop and
              "3 of 21" all come from the browser rather than from a script
              that has to reimplement them. */}
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(6.5rem,1fr))]">
            {BUILTIN_APP_ICONS.map((key) => (
              <label
                key={key}
                className={[
                  'group relative flex cursor-pointer flex-col items-center gap-1.5 rounded-control border px-2 py-2.5 text-center text-sm',
                  'transition-colors duration-150 ease-out-quart has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary',
                  selectedKey === key
                    ? 'border-primary bg-primary-soft text-ink ring-1 ring-primary'
                    : 'border-border-subtle bg-bg text-muted hover:border-border-control hover:text-ink',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name={`${groupId}-logo`}
                  value={key}
                  checked={selectedKey === key}
                  onChange={() => setDraft({ kind: 'builtin', key })}
                  className="sr-only"
                />
                <img src={builtinAppIconPath(key)} alt="" width={32} height={32} className="size-8" />
                <span className="leading-tight">{BUILTIN_APP_ICON_LABELS[key]}</span>
              </label>
            ))}
            <label
              className={[
                'relative flex cursor-pointer flex-col items-center gap-1.5 rounded-control border px-2 py-2.5 text-center text-sm',
                'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary',
                draft.kind === 'none'
                  ? 'border-primary bg-primary-soft text-ink ring-1 ring-primary'
                  : 'border-border-subtle bg-bg text-muted hover:border-border-control hover:text-ink',
              ].join(' ')}
            >
              <input
                type="radio"
                name={`${groupId}-logo`}
                value="none"
                checked={draft.kind === 'none'}
                onChange={() => setDraft({ kind: 'none' })}
                className="sr-only"
              />
              {/* 32px, like the marks beside it: a larger box pushed its
                  label below theirs and put the row out of line. */}
              <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-[0.4rem] bg-primary-soft text-xs font-semibold text-primary"
              >
                {monogram(name)}
              </span>
              <span className="leading-tight">Monogram</span>
            </label>
          </div>
        </fieldset>

        <div>
          <p className="mb-2 font-medium text-ink">Your own image</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept={APP_ICON_IMAGE_TYPES.join(',')}
              onChange={onFile}
              className="sr-only"
              aria-label="Upload a logo image"
              tabIndex={-1}
            />
            <Button variant="secondary" type="button" onClick={() => fileInput.current?.click()}>
              {draft.kind === 'image' ? 'Choose a different image' : 'Upload an image'}
            </Button>
            <span className="text-sm text-muted">PNG, JPEG or WebP, up to {kb(MAX_APP_ICON_BYTES)}</span>
          </div>
          {uploadError && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {uploadError}
            </p>
          )}
        </div>

        {saveError && (
          <Alert tone="danger" title="Logo not saved">
            {saveError}
          </Alert>
        )}

        <FormActions status={dirty ? <span className="text-warning">Unsaved changes</span> : null}>
          <Button variant="ghost" type="button" disabled={!dirty || busy} onClick={() => { setDraft(saved); setUploadError(null); }}>
            Discard
          </Button>
          <Button variant="primary" type="button" disabled={!dirty} loading={busy} onClick={() => void save()}>
            Save logo
          </Button>
        </FormActions>
      </div>
    </Panel>
  );
}
