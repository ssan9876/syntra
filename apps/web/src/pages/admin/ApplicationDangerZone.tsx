import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Dialog, Field, Panel, StateBadge, useToast } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { ApiError, api } from '../../session/api.js';

export interface DangerZoneApplication {
  id: string;
  name: string;
  status: string;
  type: string;
}

/**
 * The two ways to take an application away, in the order they should be
 * reached for.
 *
 * RETIRE first, because it is reversible: the application stops resolving --
 * no tile, no sign-in -- and keeps its SAML/OIDC configuration, claims and
 * assignments for the day it comes back. DELETE second, because it is not:
 * everything the application owns goes, and what it had issued is revoked.
 * Delete exists for what retiring cannot do -- free an entity ID or client_id
 * so the application can be registered again.
 *
 * Delete goes through a dialog that says what will happen and asks for the
 * application's name typed back. The server checks the name too, so this is
 * the reader's chance to notice they are on the wrong application, not the
 * control. A delete needs a freshly elevated session; a refusal for that
 * reason offers the way to elevate and come straight back, as the tenant-wide
 * session revoke does.
 *
 * Shown only to holders of `access.manage`. Everybody else who can open this
 * page can see who holds the application and cannot change it, and a panel of
 * buttons that all answer 403 tells them nothing.
 */
export function ApplicationDangerZone({
  application,
  assignmentCount,
  onRetired,
}: {
  application: DangerZoneApplication;
  /** Null while the assignments are loading, or when they could not be read. */
  assignmentCount: number | null;
  onRetired(): void;
}) {
  const can = useCan();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'delete' | 'status' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);

  if (!can('access.manage')) return null;

  const active = application.status === 'active';
  // The same comparison the server makes: exact, give or take surrounding
  // whitespace, and case-sensitive.
  const matches = typed.trim() === application.name.trim();

  const describe = (cause: unknown, fallback: string) =>
    cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;

  function close() {
    setOpen(false);
    setTyped('');
    setProblem(null);
  }

  async function setStatus(status: 'active' | 'inactive') {
    setBusy('status');
    setProblem(null);
    try {
      await api(`/api/admin/applications/${application.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      toast({
        tone: 'success',
        title: status === 'inactive' ? `${application.name} retired` : `${application.name} is active again`,
      });
      onRetired();
    } catch (cause) {
      setProblem(describe(cause, 'That could not be saved.'));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!matches) return;
    setBusy('delete');
    setProblem(null);
    setStepUp(null);
    try {
      await api(`/api/admin/applications/${application.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: typed }),
      });
      toast({ tone: 'success', title: `${application.name} deleted` });
      // `replace`: Back must not return to the page of an application that
      // no longer exists.
      navigate('/admin/applications', { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'step-up-required') {
        setOpen(false);
        setStepUp(describe(cause, 'Confirm it is you first.'));
      } else {
        setProblem(describe(cause, 'The application was not deleted.'));
      }
    } finally {
      setBusy(null);
    }
  }

  const holders =
    assignmentCount === null
      ? 'everyone assigned'
      : `${assignmentCount} assignment${assignmentCount === 1 ? '' : 's'}`;

  return (
    <Panel title="Danger zone">
      <div className="divide-y divide-border-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="max-w-prose">
            <p className="font-medium text-ink">{active ? 'Retire application' : 'Reactivate application'}</p>
            {active ? (
              <p className="text-sm text-muted">Reversible</p>
            ) : (
              <StateBadge state="inactive">Retired</StateBadge>
            )}
          </div>
          <Button
            variant="secondary"
            loading={busy === 'status'}
            onClick={() => void setStatus(active ? 'inactive' : 'active')}
          >
            {active ? 'Retire' : 'Reactivate'}
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="max-w-prose">
            <p className="font-medium text-ink">Delete application</p>
            <p className="text-sm text-muted">Permanent</p>
          </div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete application
          </Button>
        </div>
      </div>

      {problem && !open && (
        <div className="p-4 pt-0">
          <Alert tone="danger">{problem}</Alert>
        </div>
      )}
      {stepUp && (
        <div className="p-4 pt-0">
          <Alert tone="warning" title="Confirm it is you first">
            <p>{stepUp}</p>
            <Button
              type="button"
              onClick={() => navigate('/elevate', { state: { from: location } })}
              className="mt-3"
            >
              Confirm it is you
            </Button>
          </Alert>
        </div>
      )}

      <Dialog
        open={open}
        onClose={close}
        title={`Delete ${application.name}?`}
        actions={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === 'delete'}
              disabled={!matches}
              onClick={() => void remove()}
            >
              Delete application
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink">
          <Alert tone="warning">
            Sign-in and issued tokens stop immediately for {holders}. Cannot be undone.
          </Alert>
          <p>Removes:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>SAML and OpenID Connect configuration, including the client secret</li>
            <li>claim mappings and logo</li>
            <li>every assignment</li>
            <li>tokens, sign-in sessions and sign-ins in progress</li>
          </ul>
          <Field
            name="confirm-delete"
            label={`Type ${application.name} to confirm`}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            spellCheck={false}
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
        </div>
      </Dialog>
    </Panel>
  );
}
