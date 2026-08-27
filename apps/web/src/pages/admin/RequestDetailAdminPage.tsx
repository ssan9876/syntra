import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
import { ApiError, api } from '../../session/api.js';
import { REQUEST_LABEL, REQUEST_TONE, when } from '../automate/status.js';

interface Detail {
  id: string;
  status: string;
  statusReason: string | null;
  subjectPersonId: string;
  requestedByPersonId: string | null;
  justification: string | null;
  product: { name: string } | null;
  items: {
    id: string;
    resourceId: string;
    status: string;
    message: string | null;
  }[];
  steps: {
    id: string;
    sequence: number;
    status: string;
    approvers: {
      personId: string;
      via: string;
      onBehalfOfPersonId: string | null;
    }[];
    decisions: {
      personId: string;
      decision: string;
      comment: string | null;
      via: string;
      decidedAt: string;
    }[];
  }[];
  notifications: {
    template: string;
    to: string;
    sentAt: string | null;
    attempts: number;
    lastError: string | null;
  }[];
}

export function RequestDetailAdminPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<Detail>(
    id === undefined ? null : `/api/admin/automate/requests/${id}`,
  );
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/admin/automate/requests/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment }),
      });
      reload();
    } catch (cause) {
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
    <>
      <PageHeader title="Request" />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      {loading && (
        <Panel>
          <SkeletonRows rows={5} cols={3} />
        </Panel>
      )}
      {!loading && data && (
        <>
          <Panel title={data.product?.name ?? 'Requested access'}>
            <div className="space-y-2 p-4">
              <Status tone={REQUEST_TONE[data.status] ?? 'neutral'}>
                {REQUEST_LABEL[data.status] ?? data.status}
              </Status>
              <p className="text-muted">For {data.subjectPersonId}</p>
              {data.requestedByPersonId !== null &&
                data.requestedByPersonId !== data.subjectPersonId && (
                  <p className="text-muted">
                    Raised by {data.requestedByPersonId}
                  </p>
                )}
              {data.justification && (
                <p className="text-ink">{data.justification}</p>
              )}
            </div>
          </Panel>

          <div className="mt-6">
            <Panel title="Who it was with, and what they decided">
              <ul className="divide-y divide-border-subtle">
                {data.steps.map((step) => (
                  <li key={step.id} className="px-4 py-3">
                    <p className="font-medium text-ink">
                      Stage {step.sequence} — {step.status}
                    </p>
                    {step.approvers.map((approver, index) => (
                      <p key={index} className="text-sm text-muted">
                        {approver.personId} ({approver.via}
                        {approver.onBehalfOfPersonId === null
                          ? ''
                          : ` for ${approver.onBehalfOfPersonId}`}
                        )
                      </p>
                    ))}
                    {step.decisions.map((decision, index) => (
                      <p key={index} className="mt-1 text-sm text-ink">
                        {decision.decision} by {decision.personId} (
                        {decision.via}) on {when(decision.decidedAt)}
                        {decision.comment ? ` — ${decision.comment}` : ''}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          {data.status === 'blocked_no_approver' && (
            <div className="mt-6">
              <Panel
                title="Decide this by hand"
              >
                <div className="space-y-3 p-4">
                  <Field
                    label="Comment"
                    value={comment}
                    onChange={setComment}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() => decide('approve')}
                    >
                      Approve
                    </Button>
                    <Button loading={busy} onClick={() => decide('reject')}>
                      Refuse
                    </Button>
                  </div>
                </div>
              </Panel>
            </div>
          )}

          <div className="mt-6">
            <Panel title="Notifications">
              <ul className="divide-y divide-border-subtle">
                {data.notifications.map((notification, index) => (
                  <li key={index} className="px-4 py-2 text-sm text-muted">
                    {notification.template} to {notification.to} —{' '}
                    {notification.sentAt === null
                      ? `not sent after ${notification.attempts} attempts${notification.lastError ? `: ${notification.lastError}` : ''}`
                      : `sent ${when(notification.sentAt)}`}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
