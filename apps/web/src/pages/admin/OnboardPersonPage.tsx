import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { provisionForPerson } from './provision-on-create.js';
import { useContainerHints } from './use-container-hint.js';
import { PageHeader } from './PageHeader.js';

/**
 * Onboarding somebody, in one pass.
 *
 * Before this the console could create a person and could create a login, and
 * had no way to record a contract or to connect the two. What that produced
 * was an orphan account and a person the provisioning planner had no reason to
 * act on: `desiredState` derives from the contracts in force, so somebody
 * holding none has no desired account anywhere and a run proposes nothing for
 * them. The missing form was the whole of the problem.
 *
 * One page rather than a stepped wizard. The point is to show what a joiner
 * actually needs all at once, and a wizard puts half the answer behind a Next
 * button — which is how the contract came to be forgotten in the first place.
 *
 * `RecordPanel` is not reused here because it posts to exactly one path, and
 * this is a sequence: the contract is addressed by an id that does not exist
 * until the person has been written.
 */

/** What has actually been written, so a failure halfway can say so precisely. */
interface Progress {
  personId: string | null;
  personName: string;
  contract: boolean;
  user: boolean;
}

export function OnboardPersonPage() {
  const navigate = useNavigate();
  const [v, setV] = useState<Record<string, string>>({
    // Today, because the overwhelmingly common case is somebody starting now,
    // and an empty required date is a form that refuses on first submit.
    startDate: new Date().toISOString().slice(0, 10),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [wantsLogin, setWantsLogin] = useState(false);
  // Tolerated failure: a caller who may write people but not read the
  // directory gets an empty picker and a form that still works.
  const { data: unitsData } = useApiResource<{
    orgUnits: { id: string; name: string }[];
  }>('/api/admin/org-units');
  const { data: targetsData } = useApiResource<{
    targets: { id: string; name: string; enabled: boolean }[];
  }>('/api/admin/targets');

  // Where this would actually land, per enabled target. See
  // `useContainerHints`: this deployment applies provisioning without a
  // confirmation step, so this is the only point at which a mistyped
  // department is visible while correcting it is still free.
  const hints = useContainerHints(targetsData?.targets ?? [], {
    givenName: v.givenName ?? '',
    familyName: v.familyName ?? '',
    department: v.department ?? '',
    jobTitle: v.jobTitle ?? '',
    costCentre: v.costCentre ?? '',
    employer: v.employer ?? '',
    location: v.location ?? '',
    orgUnitId: v.orgUnitId ?? '',
  });

  /**
   * The targets that would put this person in the fallback container.
   *
   * A placement rule that needs a department and does not get one does not
   * fail — it falls back, deliberately, so that a bulk import with patchy HR
   * data does not make people unprocessable. That is the right behaviour for
   * an import and the wrong one HERE: somebody is typing, the field is one
   * keystroke away, and an account that lands in Unsorted is an account
   * somebody has to find and move later.
   *
   * So the FORM refuses, and the API does not. The same endpoint serves the
   * CSV importer and Directory Sync, where the fallback is correct.
   */
  const unplaced = hints.filter((hint) => hint.fallbackUsed);

  const set = (key: string, value: string) =>
    setV((current) => ({ ...current, [key]: value }));

  const describe = (cause: unknown) =>
    cause instanceof ApiError
      ? (cause.problem.detail ?? cause.problem.title)
      : 'That could not be saved.';

  async function submit() {
    setBusy(true);
    setProblem(null);
    setErrors({});
    setProgress(null);

    const personName = `${v.givenName ?? ''} ${v.familyName ?? ''}`.trim();
    const done: Progress = {
      personId: null,
      personName,
      contract: false,
      user: false,
    };

    try {
      const person = await api<{ id: string }>('/api/admin/persons', {
        method: 'POST',
        body: JSON.stringify({
          givenName: v.givenName ?? '',
          familyName: v.familyName ?? '',
          // Each omitted when blank: the schema validates these as e-mail
          // addresses and as a bounded string, and '' satisfies neither.
          ...(v.businessEmail ? { businessEmail: v.businessEmail } : {}),
          ...(v.personalEmail ? { personalEmail: v.personalEmail } : {}),
          ...(v.externalId ? { externalId: v.externalId } : {}),
          // The same unit the login gets, and for a different reason: on the
          // PERSON it decides where the provisioned account lands, through
          // the placement ladder. One selection, because being in Sales and
          // having an account in Sales are not two decisions anybody wants to
          // make separately.
          ...(v.orgUnitId ? { orgUnitId: v.orgUnitId } : {}),
        }),
      });
      done.personId = person.id;
    } catch (cause) {
      setErrors(fieldErrors(cause));
      setProblem(describe(cause));
      setBusy(false);
      return;
    }

    try {
      await api(`/api/admin/persons/${done.personId}/contracts`, {
        method: 'POST',
        body: JSON.stringify({
          // A person's first contract is their primary one by definition, and
          // offering the choice invites a first contract primary for nobody.
          sequence: 1,
          isPrimary: true,
          startDate: v.startDate ?? '',
          ...(v.endDate ? { endDate: v.endDate } : {}),
          ...(v.jobTitle ? { jobTitle: v.jobTitle } : {}),
          ...(v.department ? { department: v.department } : {}),
          ...(v.costCentre ? { costCentre: v.costCentre } : {}),
          ...(v.employer ? { employer: v.employer } : {}),
          ...(v.location ? { location: v.location } : {}),
          ...(v.fte ? { fte: Number(v.fte) } : {}),
        }),
      });
      done.contract = true;
    } catch (cause) {
      setProgress({ ...done });
      setErrors(fieldErrors(cause));
      setProblem(describe(cause));
      setBusy(false);
      return;
    }

    if (wantsLogin) {
      try {
        const created = await api<{ id: string }>('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            login: v.login ?? '',
            email: v.loginEmail ?? '',
            // Falls back to the person's name rather than being sent empty:
            // the schema requires a display name, and "what shall I call this
            // account" has an obvious answer when nobody typed one.
            displayName:
              `${v.givenName ?? ''} ${v.familyName ?? ''}`.trim() || (v.login ?? ''),
            ...(v.orgUnitId ? { orgUnitId: v.orgUnitId } : {}),
          }),
        });
        // Linked immediately. An account created and not linked is the orphan
        // this page exists to stop producing.
        await api(`/api/admin/persons/${done.personId}/link-user`, {
          method: 'POST',
          body: JSON.stringify({ userId: created.id }),
        });
        done.user = true;
      } catch (cause) {
        setProgress({ ...done });
        setErrors(fieldErrors(cause));
        setProblem(describe(cause));
        setBusy(false);
        return;
      }
    }

    // A disabled target is skipped deliberately: a new person should not be
    // the thing that quietly reactivates a target somebody switched off.
    for (const target of (targetsData?.targets ?? []).filter((t) => t.enabled)) {
      try {
        await provisionForPerson(target.id, done.personId!);
      } catch (cause) {
        // The person, their contract and their login are already written. A
        // provisioning failure is reported and undoes none of them — the run
        // page is where it gets diagnosed.
        setProgress({ ...done });
        setProblem(describe(cause));
        setBusy(false);
        return;
      }
    }

    setBusy(false);
    navigate(`/admin/people/${done.personId}`);
  }

  return (
    <>
      <PageHeader
        title="Add someone"
      />

      {/* Named rather than counted, and only for what was actually written.
          An administrator whose contract was refused needs to know the person
          is already there — otherwise they retype it and collide on the
          external id instead. */}
      {progress?.personId && (
        <div className="mb-4">
          <Alert tone="warning" title="Partly done">
            {progress.personName} was created
            {progress.contract
              ? ', with their contract, but the login was not'
              : ', but their contract was not. Nothing will be provisioned for them until one exists'}
            . Finish the rest on their page.
          </Alert>
        </div>
      )}

      {problem && (
        <div className="mb-4">
          <Alert tone="danger">{problem}</Alert>
        </div>
      )}

      <div className="space-y-4">
        <Panel title="Who they are">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field
              label="Given name"
              value={v.givenName ?? ''}
              onChange={(x) => set('givenName', x)}
              error={errors.givenName}
              placeholder="Maya"
            />
            <Field
              label="Family name"
              value={v.familyName ?? ''}
              onChange={(x) => set('familyName', x)}
              error={errors.familyName}
              placeholder="Okafor"
            />
            <Field
              label="Business email"
              type="email"
              value={v.businessEmail ?? ''}
              onChange={(x) => set('businessEmail', x)}
              error={errors.businessEmail}
              placeholder="maya.okafor@acme.localhost"
            />
            <Field
              label="Personal email"
              type="email"
              value={v.personalEmail ?? ''}
              onChange={(x) => set('personalEmail', x)}
              error={errors.personalEmail}
            />
            <Field
              label="External id"
              value={v.externalId ?? ''}
              onChange={(x) => set('externalId', x)}
              error={errors.externalId}
              placeholder="E1042"
            />
          </div>
        </Panel>

        <Panel
          title="What they do"
        >
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field
              label="Job title"
              value={v.jobTitle ?? ''}
              onChange={(x) => set('jobTitle', x)}
              error={errors.jobTitle}
              placeholder="Staff Nurse"
            />
            <Field
              label="Department"
              value={v.department ?? ''}
              onChange={(x) => set('department', x)}
              error={errors.department}
              placeholder="Nursing"
            />
            <Field
              label="Start date"
              type="date"
              value={v.startDate ?? ''}
              onChange={(x) => set('startDate', x)}
              error={errors.startDate}
            />
            <Field
              label="End date"
              type="date"
              value={v.endDate ?? ''}
              onChange={(x) => set('endDate', x)}
              error={errors.endDate}
            />
            <Field
              label="Cost centre"
              value={v.costCentre ?? ''}
              onChange={(x) => set('costCentre', x)}
              error={errors.costCentre}
            />
            <Field
              label="Employer"
              value={v.employer ?? ''}
              onChange={(x) => set('employer', x)}
              error={errors.employer}
            />
            <Field
              label="Location"
              value={v.location ?? ''}
              onChange={(x) => set('location', x)}
              error={errors.location}
            />
            <Field
              label="FTE"
              value={v.fte ?? ''}
              onChange={(x) => set('fte', x)}
              error={errors.fte}
              placeholder="1.0"
            />
          </div>

          {hints.length > 0 && (
            // Rendered as the distinguished name in full, monospaced, rather
            // than as a summary of it. The whole value of this is that
            // somebody reads the actual string and notices the wrong word in
            // it; a paraphrase would defeat the purpose.
            <div className="border-t border-border-subtle p-4">
              <p className="mb-2 font-medium text-ink">
                Where the account will be created
              </p>
              <ul className="space-y-2">
                {hints.map((hint) => (
                  <li key={hint.targetId} className="text-sm">
                    <span className="text-muted">{hint.targetName}</span>
                    <code className="mt-0.5 block break-all font-mono text-ink">
                      {hint.container}
                    </code>
                    {hint.fallbackUsed && (
                      // Names the placeholder, not just the outcome. "It will
                      // go to Unsorted" leaves the reader guessing which field
                      // to fill in, which is the only question they have.
                      <span className="mt-0.5 block text-muted">
                        the fallback container, because{' '}
                        {hint.missing.join(', ')} resolves to nothing
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Syntra sign-in">
          <div className="space-y-4 p-4">
            {/* Off by default, and the hint says why rather than leaving it to
                be discovered. In a deployment where Syntra is the front door,
                provisioning creates the directory account and the sync brings
                the login back on its own — so ticking this for an ordinary
                joiner produces a second account nobody needed and which the
                sync did not create. */}
            <Check
              label="Also create a Syntra login"
              checked={wantsLogin}
              onChange={setWantsLogin}
            />
            {wantsLogin && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Login"
                  value={v.login ?? ''}
                  onChange={(x) => set('login', x)}
                  error={errors.login}
                  placeholder="mokafor"
                />
                <Field
                  label="Email"
                  type="email"
                  value={v.loginEmail ?? ''}
                  onChange={(x) => set('loginEmail', x)}
                  error={errors.email}
                />
                <Select
                  label="Org unit"
                  value={v.orgUnitId ?? ''}
                  onChange={(x) => set('orgUnitId', x)}
                  error={errors.orgUnitId}
                  options={[
                    { value: '', label: 'None' },
                    ...(unitsData?.orgUnits ?? []).map((u) => ({
                      value: u.id,
                      label: u.name,
                    })),
                  ]}
                />
              </div>
            )}
          </div>
        </Panel>

        {unplaced.length > 0 && (
          <Alert tone="warning" title="This account would not be placed">
            {/*
              Names the field, not the outcome. "It will go to Unsorted" leaves
              the reader guessing which box to fill in, which is their only
              question.
            */}
            {unplaced[0]!.missing.join(', ')} decides which container this
            account is created in, and there is nothing in it yet.
          </Alert>
        )}

        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || unplaced.length > 0}
          >
            Add someone
          </Button>
          <Button
            variant="secondary"
            onClick={() => navigate('/admin/users?tab=people')}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}
