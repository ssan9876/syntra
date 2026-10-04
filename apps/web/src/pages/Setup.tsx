import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Field } from '@syntra/ui';
import type { SetupResponse, SetupStatus } from '@syntra/contracts';
import { Wordmark } from '../components/Wordmark.js';
import { ApiError, api, isRateLimited, type Problem } from '../session/api.js';
import { goToSignIn } from './setup-redirect.js';

type FieldName =
  | 'organizationName'
  | 'slug'
  | 'primaryDomain'
  | 'adminEmail'
  | 'adminDisplayName'
  | 'password'
  | 'confirmPassword';

type Values = Record<FieldName, string>;

const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A slug suggested from the organization name, until somebody types one. */
export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** What is wrong with each field, by name. Empty when the form can be sent. */
export function validate(values: Values, passwordMinLength: number): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  if (values.organizationName.trim() === '') errors.organizationName = 'Required';
  const slug = values.slug.trim();
  if (slug === '') errors.slug = 'Required';
  else if (slug.length > 63 || !SLUG.test(slug)) errors.slug = 'Lowercase letters, digits and hyphens only';
  const domain = values.primaryDomain.trim().toLowerCase();
  if (domain === '') errors.primaryDomain = 'Required';
  else if (domain.length > 253 || !HOSTNAME.test(domain)) errors.primaryDomain = 'A hostname only — no scheme, port or path';
  if (values.adminEmail.trim() === '') errors.adminEmail = 'Required';
  else if (!EMAIL.test(values.adminEmail.trim())) errors.adminEmail = 'Not an email address';
  if (values.adminDisplayName.trim() === '') errors.adminDisplayName = 'Required';
  if ([...values.password].length < passwordMinLength) errors.password = `At least ${passwordMinLength} characters`;
  if (values.confirmPassword !== values.password) errors.confirmPassword = 'Passwords do not match';
  return errors;
}

/** The field errors a refusal names, by the field they belong to. */
function fieldErrors(problem: Problem): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  for (const error of problem.errors ?? []) {
    if (error.path && error.path !== 'token') errors[error.path as FieldName] = error.message;
  }
  return errors;
}

/**
 * First-run setup: creates the organization and its first administrator on
 * an install that has none, from the one-time link the API printed to its
 * log at startup.
 *
 * Reached without a session and without a tenant -- there is no tenant yet,
 * so there is nobody to sign in as. The link's token goes with every call.
 * English only, like the console the administrator lands in next.
 */
export function Setup() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [linkProblem, setLinkProblem] = useState<Problem | null>(null);
  const [values, setValues] = useState<Values>({
    organizationName: '',
    slug: '',
    primaryDomain: '',
    adminEmail: '',
    adminDisplayName: '',
    password: '',
    confirmPassword: '',
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SetupResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<SetupStatus>(`/api/setup?token=${encodeURIComponent(token)}`)
      .then((value) => {
        if (cancelled) return;
        setStatus(value);
        setValues((current) => ({ ...current, primaryDomain: current.primaryDomain || value.primaryDomain }));
      })
      .catch((cause) => {
        if (cancelled) return;
        setLinkProblem(
          cause instanceof ApiError
            ? cause.problem
            : { type: 'about:blank', title: 'Setup could not be loaded', status: 0, detail: 'Reload the page.' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const set = (name: FieldName) => (value: string) => {
    setValues((current) => {
      const next = { ...current, [name]: value };
      if (name === 'organizationName' && !slugEdited) next.slug = slugFrom(value);
      return next;
    });
    if (name === 'slug') setSlugEdited(true);
    setServerErrors((current) => ({ ...current, [name]: undefined }));
  };

  const clientErrors = status ? validate(values, status.passwordMinLength) : {};
  const errorFor = (name: FieldName): string | undefined =>
    serverErrors[name] ?? (attempted ? clientErrors[name] : undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    setProblem(null);
    if (Object.keys(clientErrors).length > 0) return;
    setBusy(true);
    try {
      const result = await api<SetupResponse>('/api/setup', {
        method: 'POST',
        body: JSON.stringify({
          token,
          organizationName: values.organizationName.trim(),
          slug: values.slug.trim(),
          primaryDomain: values.primaryDomain.trim().toLowerCase(),
          adminEmail: values.adminEmail.trim(),
          adminDisplayName: values.adminDisplayName.trim(),
          password: values.password,
        }),
      });
      setDone(result);
      goToSignIn(result.signInUrl);
    } catch (cause) {
      if (isRateLimited(cause)) {
        setProblem('Too many attempts. Wait a minute and try again.');
      } else if (cause instanceof ApiError) {
        const named = fieldErrors(cause.problem);
        setServerErrors(named);
        if (Object.keys(named).length === 0) setProblem(cause.problem.detail ?? cause.problem.title);
      } else {
        setProblem('Setup failed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface px-6 py-12">
      <div className="w-full max-w-md">
        <Wordmark className="mb-8" />
        <div className="rounded-panel border border-border-subtle bg-bg p-6">
          <h1 className="text-lg font-semibold text-ink">Set up Syntra</h1>
          {linkProblem ? (
            <div className="mt-6">
              {linkProblem.status === 404 ? (
                <Alert>Setup is not available.</Alert>
              ) : (
                <Alert tone="danger" title={linkProblem.title}>
                  {linkProblem.detail}
                </Alert>
              )}
            </div>
          ) : done ? (
            <div className="mt-6" role="status">
              <Alert tone="success" title="Organization created">
                Sign in as {done.login}.
              </Alert>
            </div>
          ) : !status ? (
            <div className="mt-6" role="status">
              <span className="sr-only">Checking the setup link</span>
              <div className="skeleton h-2 w-32 rounded-full" />
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="mt-6 space-y-4">
              <div role="status" aria-live="polite">
                {problem ? <Alert tone="danger">{problem}</Alert> : null}
              </div>
              <Field
                label="Organization name"
                value={values.organizationName}
                onChange={set('organizationName')}
                error={errorFor('organizationName')}
                autoComplete="organization"
                autoFocus
                required
              />
              <Field label="Slug" value={values.slug} onChange={set('slug')} error={errorFor('slug')} required />
              <Field
                label="Primary domain"
                value={values.primaryDomain}
                onChange={set('primaryDomain')}
                error={errorFor('primaryDomain')}
                required
              />
              <Field
                label="Admin email"
                type="email"
                value={values.adminEmail}
                onChange={set('adminEmail')}
                error={errorFor('adminEmail')}
                autoComplete="email"
                required
              />
              <Field
                label="Display name"
                value={values.adminDisplayName}
                onChange={set('adminDisplayName')}
                error={errorFor('adminDisplayName')}
                autoComplete="name"
                required
              />
              <Field
                label="Password"
                type="password"
                value={values.password}
                onChange={set('password')}
                error={errorFor('password')}
                autoComplete="new-password"
                required
              />
              <Field
                label="Confirm password"
                type="password"
                value={values.confirmPassword}
                onChange={set('confirmPassword')}
                error={errorFor('confirmPassword')}
                autoComplete="new-password"
                required
              />
              <Button type="submit" variant="primary" loading={busy} className="w-full">
                Create organization
              </Button>
            </form>
          )}
        </div>
        {linkProblem?.status === 404 ? (
          <p className="mt-6 text-center text-sm text-muted">
            <Link to="/login" className="link">Sign in</Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
