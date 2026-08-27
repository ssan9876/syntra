import { useState } from 'react';
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from '@syntra/ui';
import { AppShell } from '../../components/AppShell.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from '../../session/use-api-resource.js';

interface Managed {
  delegationId: string;
  resourceType: string;
  resourceId: string;
  capabilities: string[];
  endsAt: string | null;
}

interface Member {
  id: string;
  subjectPersonId: string;
  status: string;
  endsAt: string | null;
}

function ResourcePanel({ resource }: { resource: Managed }) {
  const path = `/api/portal/automate/managed-resources/${resource.resourceType}/${resource.resourceId}/members`;
  const { data, error, loading, reload } = useApiResource<{
    members: Member[];
  }>(path);
  const [personId, setPersonId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (
    action: 'grant' | 'revoke',
    subjectPersonIds: string[],
  ) => {
    setBusy(true);
    setProblem(null);
    try {
      await api(
        `/api/portal/automate/managed-resources/${resource.resourceType}/${resource.resourceId}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({
            subjectPersonIds,
            justification: 'managed from the portal',
            durationDays: null,
          }),
        },
      );
      setPersonId('');
      reload();
    } catch (cause) {
      // "That person is outside the audience for this resource" and "ask an
      // administrator for more than 25" are both messages the delegate can act
      // on, so they are shown rather than flattened.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={resource.resourceId}
    >
      <div className="space-y-3 p-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="warning">{problem}</Alert>}
        {loading && <SkeletonRows rows={3} cols={2} />}
        {!loading && (
          <ul className="divide-y divide-border-subtle">
            {(data?.members ?? []).map((member) => (
              <li
                key={member.id}
                className="flex items-center justify-between py-2"
              >
                <span className="text-ink">{member.subjectPersonId}</span>
                {resource.capabilities.includes('revoke') && (
                  <Button
                    size="sm"
                    loading={busy}
                    onClick={() => act('revoke', [member.subjectPersonId])}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {resource.capabilities.includes('grant') && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Add somebody (person id)"
                value={personId}
                onChange={setPersonId}
              />
            </div>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => act('grant', [personId])}
            >
              Add
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function ManagedResourcesPage() {
  const { data, error, loading } = useApiResource<{ resources: Managed[] }>(
    '/api/portal/automate/managed-resources',
  );

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">Resources you manage</h1>
        <p className="mt-1 text-muted">
          Adding and removing people here records a request in your name,
          exactly as if it had gone through the catalog.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="mt-6 space-y-6">
          {loading && (
            <Panel>
              <SkeletonRows rows={2} cols={2} />
            </Panel>
          )}
          {!loading && (data?.resources ?? []).length === 0 && (
            <Empty title="You do not manage anything yet">
              An administrator delegates a specific group or application to you,
              and it appears here.
            </Empty>
          )}
          {!loading &&
            (data?.resources ?? []).map((resource) => (
              <ResourcePanel key={resource.delegationId} resource={resource} />
            ))}
        </div>
      </div>
    </AppShell>
  );
}
