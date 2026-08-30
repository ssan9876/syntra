import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Field,
  Panel,
  Select,
  SkeletonRows,
  Status,
} from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { RecordPanel } from './RecordPanel.js';
import { DeleteButton } from './DeleteButton.js';
import { AccountSessions } from './AccountSessions.js';
import { AccountTokens } from './AccountTokens.js';
import { StatusToggle } from './StatusToggle.js';
import { SubjectLog } from './SubjectLog.js';
import { PageFacts, PageHeader } from './PageHeader.js';

interface AccountDetail {
  id: string;
  login: string;
  displayName: string;
  email: string;
  status: string;
  statusReason: string | null;
  /** Set when a directory source owns this account. Null means locally managed. */
  sourceId: string | null;
  /**
   * Where the password lives. Optional for the same reason it is optional on
   * the list: the guard below reads it as "not upstream" rather than "is
   * local", so an unrecognised value leaves the control offered and lets the
   * server give the real answer.
   */
  passwordSource?: string;
  /** Too many failed sign-ins. Orthogonal to `status`. */
  locked: boolean;
  /**
   * The unit this ACCOUNT sits in, which feeds access resolution.
   *
   * Not the same column as `Person.orgUnitId`, which is what drives where a
   * provisioned account is placed on each target. An account can be in a unit
   * for access while the person behind it is placed from another, and the two
   * are edited on their own screens.
   */
  orgUnitId: string | null;
  person: { id: string; givenName: string; familyName: string } | null;
}

interface SourceRow {
  id: string;
  name: string;
  writebackEnabled: boolean;
  writebackDisable: boolean;
}

/** Somebody this account might belong to, and why the matcher thinks so. */
interface Candidate {
  personId: string;
  givenName: string;
  familyName: string;
  rule: 'businessEmail' | 'personalEmail' | 'displayName';
  hasActiveAccount: boolean;
}

/**
 * WHY it is being suggested, in the reader's words rather than the matcher's.
 *
 * A suggestion with no reason is a claim an administrator has to verify from
 * scratch, which is the work the suggestion exists to save.
 */
const REASON: Record<Candidate['rule'], string> = {
  businessEmail: 'same work email',
  personalEmail: 'same personal email',
  displayName: 'same name',
};

/**
 * One sign-in account: what it is, what can be done to it, and its history.
 *
 * Accounts had no screen. Every control lived on a row of the list, which
 * meant the list carried six pieces of state that were only ever about ONE
 * account at a time — which row is being edited, whose setup link is on
 * screen, whose factors are open, which unlock is in flight — and a table wide
 * enough to hold all of them. Clicking an account did nothing, so the answer
 * to "what happened to this account" was to read the whole audit log.
 *
 * The controls are here rather than in both places. Two implementations of
 * "generate a setup link" is how one of them ends up not saying that the
 * previous link stopped working.
 *
 * The person is named at the top and linked. That link is the entire
 * explanation of the person/account split, and it is why no paragraph
 * describing the split is needed: an account with a person shows one, a
 * service account shows none, and the reader draws the distinction from the
 * screen rather than from a sentence about the navigation.
 */
export function AccountDetailPage() {
  const { id } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApiResource<AccountDetail>(
    `/api/admin/users/${id}`,
  );
  // Its error state is deliberately ignored, as on the list: a caller who may
  // read the directory but not its sources gets an account that still renders
  // and simply cannot name the directory that owns it.
  const { data: sourcesData } = useApiResource<{ sources: SourceRow[] }>(
    '/api/admin/sources',
  );
  // For the org-unit picker on the edit form. Its error state is tolerated the
  // same way: a caller who may write the directory but not read its units gets
  // an empty picker and a form that still saves the other two fields.
  const { data: unitsData } = useApiResource<{
    orgUnits: { id: string; name: string }[];
  }>('/api/admin/org-units');
  // Asked unconditionally and answered with an empty list for an account that
  // already has a person, rather than called only when one is missing: a hook
  // that runs on some renders and not others breaks the moment somebody adds
  // a branch above it.
  const { data: candidatesData } = useApiResource<{ candidates: Candidate[] }>(
    `/api/admin/users/${id}/person-candidates`,
  );

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * One at a time and cleared on leaving: a setup link is a credential.
   *
   * This is the state the list was carrying for every row at once. Here it can
   * only ever be about the account on screen, which is what makes "generating
   * another one stops the previous link working" a sentence about something
   * the reader is looking at.
   */
  const [setupLink, setSetupLink] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);
  const [factorNotice, setFactorNotice] = useState<string | null>(null);
  /**
   * The set-password form, and what it did.
   *
   * Held here for the same reason `setupLink` is: it can only ever be about
   * the account on screen, which is what lets the result sentence name what
   * happened to THIS account's sessions rather than say something general.
   *
   * The typed password is cleared the moment it is spent, and on cancel. It is
   * a credential and has no business sitting in a React tree.
   */
  const [settingPassword, setSettingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [passwordDone, setPasswordDone] = useState<string | null>(null);

  const failed = (cause: unknown, fallback: string) =>
    setProblem(
      cause instanceof ApiError
        ? (cause.problem.detail ?? cause.problem.title)
        : fallback,
    );

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading || !data) {
    return (
      <Panel>
        <SkeletonRows rows={4} cols={4} />
      </Panel>
    );
  }

  const source = data.sourceId
    ? (sourcesData?.sources ?? []).find((s) => s.id === data.sourceId)
    : null;
  const local = data.sourceId === null;
  // Whether Syntra may disable the account where it actually lives. A status
  // changed locally on a source-owned account is undone by the next run, so
  // the control is not offered where the write cannot follow.
  const writesDisable =
    local || Boolean(source?.writebackEnabled && source?.writebackDisable);

  const unlock = () =>
    run(async () => {
      try {
        await api(`/api/admin/users/${data.id}/unlock`, { method: 'POST' });
        reload();
      } catch (cause) {
        // Surfaced rather than swallowed: an unlock that quietly did nothing
        // sends the administrator back to the support call with the same
        // problem.
        failed(cause, 'That account could not be unlocked. Try again.');
      }
    });

  const linkTo = (candidate: Candidate) =>
    run(async () => {
      try {
        await api(`/api/admin/persons/${candidate.personId}/link-user`, {
          method: 'POST',
          body: JSON.stringify({ userId: data!.id }),
        });
        reload();
      } catch (cause) {
        failed(cause, 'That account could not be linked.');
      }
    });

  const issueSetupLink = () =>
    run(async () => {
      try {
        const body = await api<{ url: string; expiresAt: string }>(
          `/api/admin/users/${data.id}/password-setup`,
          { method: 'POST' },
        );
        setSetupLink(body);
      } catch (cause) {
        failed(cause, 'Could not create a setup link.');
      }
    });

  const removeFactor = (type: string) =>
    run(async () => {
      setFactorNotice(null);
      try {
        const result = await api<{ recoveryCodesRevoked: number }>(
          `/api/admin/users/${data.id}/factors/${type}`,
          { method: 'DELETE' },
        );
        // The count is SAID. Taking the last real factor away takes the
        // printed recovery codes with it, and nothing else tells the account's
        // owner that the page in their drawer has stopped working.
        setFactorNotice(
          result.recoveryCodesRevoked > 0
            ? `Removed, and ${result.recoveryCodesRevoked} unused recovery code${
                result.recoveryCodesRevoked === 1 ? '' : 's'
              } stopped working with it.`
            : 'Removed.',
        );
      } catch (cause) {
        failed(cause, 'That factor could not be removed.');
      }
    });

  return (
    <>
      <PageHeader
        title={data.displayName}
        actions={
          // Only for a locally managed account. A directory owns the login,
          // name and email of an account it syncs and rewrites them on every
          // run, so this form would offer a change that silently reverts.
          local && !editing ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />

      <PageFacts
        facts={[
          { label: 'Login', value: data.login },
          { label: 'Email', value: data.email },
          {
            label: 'Status',
            value:
              data.status === 'active' ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Status tone="active">Active</Status>
                  {data.locked && <Status tone="warning">Locked out</Status>}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Status tone="inactive">Inactive</Status>
                  {data.statusReason && (
                    <span className="font-normal text-muted">
                      {data.statusReason}
                    </span>
                  )}
                </span>
              ),
          },
          {
            label: 'Managed by',
            value: local ? (
              <span className="text-muted">Syntra</span>
            ) : (
              // Named, not merely flagged: "synced" tells an administrator
              // nothing about where to go and change it.
              <span className="flex flex-wrap items-center gap-2">
                <Status tone="primary">{source?.name ?? 'Directory source'}</Status>
                <span className="font-normal text-muted">read-only</span>
              </span>
            ),
          },
          {
            label: 'Person',
            value: data.person ? (
              <Link
                to={`/admin/people/${data.person.id}`}
                className="text-ink underline-offset-2 hover:text-primary hover:underline"
              >
                {data.person.givenName} {data.person.familyName}
              </Link>
            ) : (candidatesData?.candidates ?? []).length === 0 ? (
              // A service account is the ordinary case here, not a fault. It
              // is stated flatly and given no call to action for that reason,
              // and that stays true whenever nothing matched.
              <span className="font-normal text-muted">Not linked</span>
            ) : (
              <span className="flex flex-col gap-2">
                <span className="font-normal text-muted">Not linked</span>
                {(candidatesData?.candidates ?? []).map((candidate) => (
                  <span
                    key={candidate.personId}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy}
                      onClick={() => void linkTo(candidate)}
                    >
                      {/* Names the person, so a column of suggestions is not
                          a column of identical "Link" buttons. */}
                      Link {candidate.givenName} {candidate.familyName}
                    </Button>
                    <span className="text-sm font-normal text-muted">
                      {REASON[candidate.rule]}
                      {/* The contractor-with-two-accounts case is legitimate,
                          so it is offered and labelled rather than hidden. */}
                      {candidate.hasActiveAccount && ' — already has an account'}
                    </span>
                  </span>
                ))}
              </span>
            ),
          },
        ]}
      />

      {problem && <Alert tone="danger">{problem}</Alert>}

      <div className="space-y-6">
        {editing && (
          <RecordPanel
            title={`Edit ${data.login}`}
            submitLabel="Save"
            method="PATCH"
            path={`/api/admin/users/${data.id}/details`}
            initial={{
              displayName: data.displayName,
              email: data.email,
              orgUnitId: data.orgUnitId ?? '',
            }}
            onCancel={() => setEditing(false)}
            onCreated={() => {
              setEditing(false);
              reload();
            }}
            build={(v) => ({
              displayName: v.displayName ?? '',
              email: v.email ?? '',
              // Null, not ''. The schema takes a uuid or null — null takes the
              // account out of the hierarchy — and '' satisfies neither.
              orgUnitId: v.orgUnitId ? v.orgUnitId : null,
            })}
            fields={(v, set, errs) => (
              <>
                <Field
                  label="Display name"
                  value={v.displayName ?? ''}
                  onChange={(x) => set('displayName', x)}
                  error={errs.displayName}
                />
                <Field
                  label="Email"
                  type="email"
                  value={v.email ?? ''}
                  onChange={(x) => set('email', x)}
                  error={errs.email}
                />
                <Select
                  label="Org unit"
                  value={v.orgUnitId ?? ''}
                  onChange={(x) => set('orgUnitId', x)}
                  error={errs.orgUnitId}
                  options={[
                    { value: '', label: 'None' },
                    ...(unitsData?.orgUnits ?? []).map((u) => ({
                      value: u.id,
                      label: u.name,
                    })),
                  ]}
                />
              </>
            )}
          />
        )}

        <Panel title="Sign-in">
          <div className="space-y-4 p-4">
            {factorNotice && <Alert tone="warning">{factorNotice}</Alert>}

            <div className="flex flex-wrap gap-2">
              {/* First, and only while it applies. Somebody is on this screen
                  because of a support call about exactly this. */}
              {data.locked && (
                <Button variant="secondary" loading={busy} onClick={() => void unlock()}>
                  Unlock
                </Button>
              )}
              {/*
                Offered for a synced account as well as a local one: a
                directory-owned user still authenticates against Syntra's own
                hash. It is the federated user, whose password lives somewhere
                else entirely, who cannot use this.
              */}
              {data.passwordSource !== 'upstream' && (
                <Button
                  variant="secondary"
                  loading={busy}
                  onClick={() => void issueSetupLink()}
                >
                  Password link
                </Button>
              )}
              {/*
                Beside the link and under the same condition, because they
                answer the same question by different routes: the link is for
                a joiner who can reach their mail, and this is for the support
                call where they cannot.
              */}
              {data.passwordSource !== 'upstream' && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPasswordDone(null);
                    setSettingPassword(true);
                  }}
                >
                  Set password
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => void removeFactor('totp')}
              >
                Remove authenticator app
              </Button>
              <Button
                variant="secondary"
                onClick={() => void removeFactor('webauthn')}
              >
                Remove security keys
              </Button>
              <Button
                variant="secondary"
                onClick={() => void removeFactor('recovery_code')}
              >
                Remove recovery codes
              </Button>
            </div>

            {setupLink && (
              <div className="rounded border border-border-subtle p-4">
                <h3 className="font-medium text-ink">Password setup link</h3>
                <p className="mt-1 text-sm text-muted">
                  Send this to them. It can be used once, expires{' '}
                  {new Date(setupLink.expiresAt).toLocaleString()}, and
                  generating another one stops the previous link working.
                </p>
                {/*
                  A read-only input, not an anchor. An administrator who clicks
                  a link to check it has spent the token, and the joiner they
                  send it to gets a dead page.
                */}
                <input
                  readOnly
                  aria-label="Password setup link"
                  value={setupLink.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-3 w-full rounded border border-border-control bg-surface px-3 py-2 font-mono text-sm"
                />
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => navigator.clipboard?.writeText(setupLink.url)}
                  >
                    Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSetupLink(null)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}

            {settingPassword && (
              <div className="rounded border border-border-subtle p-4">
                <h3 className="font-medium text-ink">Set a password</h3>
                <p className="mt-1 text-sm text-muted">
                  {/*
                    The CONSEQUENCE up front, and not the length rule. The
                    consequence is irreversible and this page knows it for
                    certain; the tenant's minimum length is not carried in any
                    response this screen reads, and a number stated here would
                    be wrong for the first tenant that changes theirs. The
                    server owns the rule and says so on refusal — the same
                    decision the portal's own change form made.
                  */}
                  Every session is revoked immediately, and they must choose
                  their own password the next time they sign in.
                </p>
                <div className="mt-3">
                  <Field
                    label="New password"
                    type="password"
                    value={newPassword}
                    onChange={setNewPassword}
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    loading={busy}
                    disabled={newPassword.length === 0}
                    onClick={() =>
                      void run(async () => {
                        try {
                          const result = await api<{ sessionsRevoked: number }>(
                            `/api/admin/users/${data.id}/password`,
                            {
                              method: 'POST',
                              body: JSON.stringify({ password: newPassword }),
                            },
                          );
                          setPasswordDone(
                            `Password set. ${result.sessionsRevoked} session${
                              result.sessionsRevoked === 1 ? ' was' : 's were'
                            } revoked, and they must choose their own the next time they sign in.`,
                          );
                          setSettingPassword(false);
                          setNewPassword('');
                        } catch (cause) {
                          // Kept on screen with what was typed still there: a
                          // refusal names what was wrong with the password,
                          // and clearing the box would make them retype a
                          // password they are about to adjust.
                          failed(cause, 'That password could not be set.');
                        }
                      })
                    }
                  >
                    Set it
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSettingPassword(false);
                      setNewPassword('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {passwordDone && <Alert tone="warning">{passwordDone}</Alert>}
          </div>
        </Panel>

        <Panel title="Status">
          <div className="flex flex-wrap items-start justify-between gap-4 p-4">
            <div className="min-w-[16rem] max-w-md">
              {writesDisable ? (
                <StatusToggle
                  active={data.status === 'active'}
                  basePath={`/api/admin/users/${data.id}`}
                  label="user"
                  consequences={
                    local
                      ? 'Every session and refresh token is revoked immediately.'
                      : // Says what actually happens, in order. A confirmation
                        // that asks "are you sure?" without saying what follows
                        // is one people click through without reading.
                        `The account is disabled in ${
                          source?.name ?? 'the directory'
                        } immediately, every session is revoked, and the leaver steps configured on the target follow from today.`
                  }
                  onChanged={reload}
                />
              ) : (
                // Write-back is off for this source, so a status changed here
                // would be undone by the next run. Naming the source and the
                // setting is the difference between a dead end and something an
                // administrator can act on.
                <span className="text-sm text-muted">
                  {source?.name ?? 'A directory source'} owns this account, and
                  write-back is off
                </span>
              )}
            </div>

            {can('directory.delete') && (
              <div className="min-w-[16rem] max-w-md">
                <DeleteButton
                  path={`/api/admin/users/${data.id}`}
                  label="user"
                  confirmWord={data.login}
                  warning="The account is removed from the directory and from Syntra, and every session with it. The person and the audit trail are kept. This cannot be undone."
                  // Back to the list, not back to this screen. Staying here
                  // would leave the reader looking at a record that no longer
                  // exists and a page whose every control now answers 404.
                  onDeleted={() => navigate('/admin/users?tab=accounts')}
                />
              </div>
            )}
          </div>
        </Panel>

        <AccountSessions userId={data.id} />

        <AccountTokens userId={data.id} />

        <SubjectLog subjects={[data.id]} />

        <Link
          to="/admin/users?tab=accounts"
          className="inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to accounts
        </Link>
      </div>
    </>
  );
}
