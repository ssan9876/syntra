import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Check,
  ErrorSummary,
  Field,
  FormActions,
  FormSection,
  Select,
  StateBadge,
  useToast,
  type State,
  type SummaryError,
} from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { fieldErrors, useApiResource } from './hooks.js';
import { provisionForPerson, type PersonProvisionReceipt } from './provision-on-create.js';
import { useContainerHints } from './use-container-hint.js';
import { PageHeader } from './PageHeader.js';
import { usePersonReceipts } from './use-person-receipts.js';
import {
  OnboardingReceipt,
  REQUIRED,
  receiptEvidence,
  receiptState,
  type ReceiptRow,
} from './onboarding-receipt.js';

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
 * What made one page hard to use was not its length but that nothing on it
 * said which of sixteen fields were needed, and the button was below the
 * fold: so the sections are named, the three required fields are marked, and
 * the actions stay in reach while the form scrolls.
 *
 * It ends on a receipt rather than on the person's page. "Saved" was the
 * whole answer the old flow gave, and the review's low point was exactly
 * that — a hire saved without knowing whether they can work. The receipt
 * keeps polling the target receipts until each is observed or needs a person.
 *
 * `RecordPanel` is not reused here because it posts to exactly one path, and
 * this is a sequence: the contract is addressed by an id that does not exist
 * until the person has been written.
 */

/** Somebody the server thinks this person might already be. */
interface DuplicateCandidate {
  id: string;
  givenName: string;
  familyName: string;
  businessEmail: string | null;
}

/** What has actually been written, so a failure halfway can say so precisely. */
interface Progress {
  personId: string | null;
  personName: string;
  contract: boolean;
  userId: string | null;
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
  /** Everything written, once the whole sequence has run. */
  const [created, setCreated] = useState<Created | null>(null);
  const toast = useToast();
  /** People who look like the one being created. Null until asked about. */
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
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

  /**
   * @param allowDuplicate confirms a person who looks like somebody already
   * here. Threaded through rather than held in state so the retry is the same
   * call with one more field, and the sequence that follows -- contract, then
   * login, then provisioning -- is not duplicated for the confirmed path.
   */
  /**
   * The fields the server would refuse, caught before anything is written.
   * Checked here rather than left to the API because the API refuses them one
   * request at a time — person first, then contract — and a refusal on the
   * contract arrives after the person already exists.
   */
  function missing(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!v.givenName?.trim()) found.givenName = 'Enter a given name';
    if (!v.familyName?.trim()) found.familyName = 'Enter a family name';
    if (!v.startDate) found.startDate = 'Enter a start date';
    if (wantsLogin && !v.login?.trim()) found.login = 'Enter a login';
    if (wantsLogin && !v.loginEmail?.trim()) found.email = 'Enter the login email';
    return found;
  }

  async function submit(allowDuplicate = false) {
    const invalid = missing();
    if (Object.keys(invalid).length > 0) {
      setProblem(null);
      setErrors(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    setErrors({});
    setProgress(null);
    setDuplicates(null);

    const personName = `${v.givenName ?? ''} ${v.familyName ?? ''}`.trim();
    const done: Progress = {
      personId: null,
      personName,
      contract: false,
      userId: null,
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
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
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
      // A possible duplicate is a QUESTION, not a verdict: two real people do
      // share a name, and two people cannot be merged afterwards -- which is
      // exactly why it is asked before rather than after. Nothing else has
      // been written yet, so answering it costs only this request.
      if (cause instanceof ApiError && cause.kind === 'possible-duplicate') {
        setDuplicates(
          (cause.problem.candidates as DuplicateCandidate[] | undefined) ?? [],
        );
        setProblem(cause.problem.detail ?? cause.problem.title);
        setBusy(false);
        return;
      }
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
        done.userId = created.id;
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
    const receipts: PersonProvisionReceipt[] = [];
    for (const target of (targetsData?.targets ?? []).filter((t) => t.enabled)) {
      try {
        const written = await provisionForPerson(target.id, done.personId!);
        receipts.push(...written.map((receipt) => ({ ...receipt, targetName: receipt.targetName ?? target.name })));
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
    setCreated({ ...done, personId: done.personId!, receipts });
    toast({ tone: 'success', title: `${personName} added` });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  const summary: SummaryError[] = [
    ...Object.entries(errors).map(([field, message]) => ({
      // The login's address comes back from the API as `email`, which is
      // also the name its control carries here.
      field,
      message,
    })),
    ...(problem && !duplicates ? [{ message: problem }] : []),
  ];

  if (created) {
    return <CreatedReceipt created={created} wantsLogin={wantsLogin} startDate={v.startDate ?? ''} />;
  }


  return (
    <>
      <PageHeader title="Add someone" />

      {/* Named rather than counted, and only for what was actually written.
          An administrator whose contract was refused needs to know the person
          is already there — otherwise they retype it and collide on the
          external id instead. */}
      {progress?.personId && (
        <div className="mb-4">
          <Alert tone="warning" title="Partly done">
            <ul className="mb-2 list-disc pl-5">
              <li>{`${progress.personName}: created`}</li>
              <li>{progress.contract ? 'Contract: saved' : 'Contract: not saved — nothing will be provisioned'}</li>
              {progress.user ? (
                <li>Syntra login: created and linked</li>
              ) : progress.userId ? (
                <li>Syntra login: created, not linked</li>
              ) : wantsLogin && progress.contract ? (
                <li>Syntra login: not created</li>
              ) : null}
            </ul>
            <Link to={`/admin/people/${progress.personId}`} className="underline">
              Open saved person
            </Link>
            {progress.userId && (
              <Link to={`/admin/users/${progress.userId}`} className="ml-4 underline">
                Open saved login
              </Link>
            )}
          </Alert>
        </div>
      )}

      {duplicates && (
        <div className="mb-4">
          <Alert tone="warning" title="Somebody here already looks like this">
            <div className="space-y-3">
              <p>{problem}</p>
              {/* Named and LINKED. A warning that says somebody similar exists
                  and will not let you go and look at them leaves the reader to
                  search for a name they have already typed once. */}
              <ul className="space-y-1">
                {duplicates.map((candidate) => (
                  <li key={candidate.id}>
                    <Link to={`/admin/people/${candidate.id}`} className="link">
                      {candidate.givenName} {candidate.familyName}
                    </Link>
                    {candidate.businessEmail && (
                      <span className="text-muted"> — {candidate.businessEmail}</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button size="sm" loading={busy} onClick={() => void submit(true)}>
                  Create anyway
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDuplicates(null);
                    setProblem(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Alert>
        </div>
      )}

      <form noValidate onSubmit={onSubmit} className="space-y-6">
        <ErrorSummary
          errors={summary}
          title={progress?.personId ? 'Onboarding stopped' : 'Fix these before adding'}
        />

        <FormSection title="Identity">
          <Field
            className={REQUIRED}
            required
            name="givenName"
            label="Given name"
            value={v.givenName ?? ''}
            onChange={(x) => set('givenName', x)}
            error={errors.givenName}
            placeholder="Maya"
          />
          <Field
            className={REQUIRED}
            required
            name="familyName"
            label="Family name"
            value={v.familyName ?? ''}
            onChange={(x) => set('familyName', x)}
            error={errors.familyName}
            placeholder="Okafor"
          />
          <Field
            name="businessEmail"
            label="Business email"
            type="email"
            value={v.businessEmail ?? ''}
            onChange={(x) => set('businessEmail', x)}
            error={errors.businessEmail}
            placeholder="maya.okafor@acme.localhost"
          />
          <Field
            name="personalEmail"
            label="Personal email"
            type="email"
            value={v.personalEmail ?? ''}
            onChange={(x) => set('personalEmail', x)}
            error={errors.personalEmail}
          />
          <Field
            name="externalId"
            label="External id"
            value={v.externalId ?? ''}
            onChange={(x) => set('externalId', x)}
            error={errors.externalId}
            placeholder="E1042"
          />
          {/* On the person as well as the login: through the placement
              ladder it decides where the provisioned account lands, so it
              belongs with who they are rather than behind the login box. */}
          <Select
            name="orgUnitId"
            label="Org unit"
            value={v.orgUnitId ?? ''}
            onChange={(x) => set('orgUnitId', x)}
            error={errors.orgUnitId}
            options={[
              { value: '', label: 'None' },
              ...(unitsData?.orgUnits ?? []).map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </FormSection>

        <FormSection title="Contract">
          <Field
            className={REQUIRED}
            required
            name="startDate"
            label="Start date"
            type="date"
            value={v.startDate ?? ''}
            onChange={(x) => set('startDate', x)}
            error={errors.startDate}
          />
          <Field
            name="endDate"
            label="End date"
            type="date"
            value={v.endDate ?? ''}
            onChange={(x) => set('endDate', x)}
            error={errors.endDate}
          />
          <Field
            name="jobTitle"
            label="Job title"
            value={v.jobTitle ?? ''}
            onChange={(x) => set('jobTitle', x)}
            error={errors.jobTitle}
            placeholder="Staff Nurse"
          />
          <Field
            name="department"
            label="Department"
            value={v.department ?? ''}
            onChange={(x) => set('department', x)}
            error={errors.department}
            placeholder="Nursing"
          />
          <Field
            name="costCentre"
            label="Cost centre"
            value={v.costCentre ?? ''}
            onChange={(x) => set('costCentre', x)}
            error={errors.costCentre}
          />
          <Field
            name="employer"
            label="Employer"
            value={v.employer ?? ''}
            onChange={(x) => set('employer', x)}
            error={errors.employer}
          />
          <Field
            name="location"
            label="Location"
            value={v.location ?? ''}
            onChange={(x) => set('location', x)}
            error={errors.location}
          />
          <Field
            name="fte"
            label="FTE"
            inputMode="decimal"
            value={v.fte ?? ''}
            onChange={(x) => set('fte', x)}
            error={errors.fte}
            placeholder="1.0"
          />

          {hints.length > 0 && (
            // Rendered as the distinguished name in full, monospaced, rather
            // than as a summary of it. The whole value of this is that
            // somebody reads the actual string and notices the wrong word in
            // it; a paraphrase would defeat the purpose.
            <div className="sm:col-span-2">
              <p className="mb-2 font-medium text-ink">Where the account will be created</p>
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
                        Fallback container: {hint.missing.join(', ')} is empty
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </FormSection>

        <FormSection
          title="Sign-in account"
          status={<StateBadge state={wantsLogin ? 'pending' : 'inactive'}>{wantsLogin ? 'Will be created' : 'None'}</StateBadge>}
        >
          {/* Off by default. In a deployment where Syntra is the front door,
              provisioning creates the directory account and the sync brings
              the login back on its own — so ticking this for an ordinary
              joiner produces a second account nobody needed and which the
              sync did not create. */}
          <Check
            className="sm:col-span-2"
            label="Also create a Syntra login"
            checked={wantsLogin}
            onChange={setWantsLogin}
          />
          {wantsLogin && (
            <>
              <Field
                className={REQUIRED}
                required
                name="login"
                label="Login"
                value={v.login ?? ''}
                onChange={(x) => set('login', x)}
                error={errors.login}
                placeholder="mokafor"
              />
              <Field
                className={REQUIRED}
                required
                name="email"
                label="Email"
                type="email"
                value={v.loginEmail ?? ''}
                onChange={(x) => set('loginEmail', x)}
                error={errors.email}
              />
            </>
          )}
        </FormSection>

        {unplaced.length > 0 && (
          <Alert tone="warning" title="This account would not be placed">
            {/*
              Names the field, not the outcome. "It will go to Unsorted" leaves
              the reader guessing which box to fill in, which is their only
              question.
            */}
            Fill in {unplaced[0]!.missing.join(', ')}.
          </Alert>
        )}

        <FormActions sticky>
          <Button
            variant="secondary"
            onClick={() => navigate('/admin/users?tab=people')}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={busy || unplaced.length > 0 || progress?.personId != null}
          >
            Add someone
          </Button>
        </FormActions>
      </form>
    </>
  );
}

interface Created extends Progress {
  personId: string;
  /** What each enabled target answered when asked to provision. */
  receipts: PersonProvisionReceipt[];
}

const STATE_ORDER: State[] = ['blocked', 'attention', 'running', 'pending', 'setup', 'inactive', 'healthy'];

/** The worst row decides the headline: one blocked target is a blocked hire. */
function worstState(rows: { state: State }[]): State {
  return STATE_ORDER.find((state) => rows.some((row) => row.state === state)) ?? 'healthy';
}

function CreatedReceipt({ created, wantsLogin, startDate }: { created: Created; wantsLogin: boolean; startDate: string }) {
  const rows: ReceiptRow[] = [
    {
      key: 'person',
      title: 'Person',
      state: 'healthy',
      label: 'Saved',
      evidence: <Link className="link" to={`/admin/people/${created.personId}`}>{created.personName}</Link>,
    },
    { key: 'contract', title: 'Contract', state: 'healthy', label: 'Saved', evidence: startDate ? `Starts ${startDate}` : undefined },
  ];
  if (wantsLogin && created.userId) {
    rows.push({
      key: 'login',
      title: 'Sign-in account',
      state: 'healthy',
      label: 'Created and linked',
      evidence: <Link className="link" to={`/admin/users/${created.userId}`}>Open login</Link>,
    });
  }
  return <>
    {created.receipts.length > 0
      ? <LiveTargets title={created.personName} personId={created.personId} initial={created.receipts} base={rows} />
      : <>
        <PageHeader title={created.personName} status={<StateBadge state="healthy">Saved</StateBadge>} />
        <OnboardingReceipt rows={[...rows, { key: 'targets', title: 'Target systems', state: 'inactive', label: 'None enabled' }]} />
      </>}
    <div className="mt-4 flex flex-wrap gap-4">
      <Link className="link font-medium" to={`/admin/people/${created.personId}`}>Open person</Link>
      <Link className="link" to="/admin/users?tab=people">Back to people</Link>
    </div>
  </>;
}

/**
 * The target rows, kept current. The first answer is the one the provision
 * request returned; after that the shared receipts hook polls while anything
 * is still moving, so "Planned" becomes "Observed" on this screen rather than
 * on one the administrator has to go and find.
 */
function LiveTargets({ title, personId, initial, base }: { title: string; personId: string; initial: PersonProvisionReceipt[]; base: ReceiptRow[] }) {
  const live = usePersonReceipts(personId);
  const receipts = live.receipts && live.receipts.length > 0 ? live.receipts : initial;
  const names = new Map(initial.map((receipt) => [receipt.targetSystemId, receipt.targetName]));
  const rows: ReceiptRow[] = [
    ...base,
    ...receipts.map((receipt) => ({
      key: receipt.id,
      title: receipt.targetName ?? names.get(receipt.targetSystemId) ?? 'Target',
      ...receiptState(receipt),
      evidence: receiptEvidence(receipt),
    })),
  ];
  return <>
    <PageHeader title={title} status={<StateBadge state={worstState(rows)} />} />
    {live.problem && <div className="mb-4"><Alert tone="warning">{live.problem}</Alert></div>}
    <OnboardingReceipt rows={rows} />
  </>;
}
