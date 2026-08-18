import { useState } from 'react';
import { Alert, Button, Field, Panel } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { ApiError, api } from '../../session/api.js';

interface StagePreview {
  sequence: number;
  name: string;
  selector: string;
  quorum: string;
  usedFallback: boolean;
  approvers: { personId: string; displayName: string; via: string }[];
  dropped: { personId: string; displayName: string; reason: string }[];
  blocked: boolean;
}

const DROP_REASON: Record<string, string> = {
  subject: 'they are the subject',
  submitter: 'they raised the request',
  no_user: 'no Syntra account',
  inactive_user: 'inactive account',
  no_active_contract: 'no contract in force',
};

export function WorkflowEditorPage() {
  const [workflowId, setWorkflowId] = useState('');
  const [subjectPersonId, setSubjectPersonId] = useState('');
  const [stages, setStages] = useState<StagePreview[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const runPreview = async () => {
    setProblem(null);
    try {
      const result = await api<{ stages: StagePreview[] }>(
        '/api/admin/automate/workflows/resolution-preview',
        {
          method: 'POST',
          body: JSON.stringify({
            workflowId,
            subjectPersonId,
            productId: null,
          }),
        },
      );
      setStages(result.stages);
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That preview could not be run.',
      );
    }
  };

  return (
    <>
      <PageHeader
        title="Approval workflows"
        description="A workflow with no stages grants immediately. That is the mechanism, not a flag."
      />
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel
        title="Resolution preview"
        description="Pick a real person and see the chain this workflow produces for them."
      >
        <div className="space-y-3 p-4">
          <Field
            label="Workflow id"
            value={workflowId}
            onChange={setWorkflowId}
          />
          <Field
            label="Subject person id"
            value={subjectPersonId}
            onChange={setSubjectPersonId}
          />
          <Button onClick={runPreview}>Resolve it</Button>

          {stages !== null && stages.length === 0 && (
            <Alert tone="warning">
              This workflow has no stages, so anything using it is granted
              immediately, with no approval at all.
            </Alert>
          )}

          {(stages ?? []).map((stage) => (
            <div
              key={stage.sequence}
              className="rounded-control border border-border-subtle p-3"
            >
              <p className="font-medium text-ink">
                Stage {stage.sequence}: {stage.name} ({stage.selector}
                {stage.usedFallback ? ', via the fallback' : ''})
              </p>
              <p className="text-muted">
                {stage.approvers.length} valid:{' '}
                {stage.approvers.map((a) => a.displayName).join(', ') ||
                  'nobody'}
              </p>
              {stage.dropped.length > 0 && (
                <p className="text-muted">
                  {stage.dropped.length} dropped:{' '}
                  {stage.dropped
                    .map(
                      (d) =>
                        `${d.displayName} (${DROP_REASON[d.reason] ?? d.reason})`,
                    )
                    .join(', ')}
                </p>
              )}
              {stage.blocked && (
                // The screen that catches this before it is saved, rather than
                // at 3am on somebody's request.
                <Alert tone="danger">
                  Nobody can decide this stage for this person. Any request
                  reaching it will stop and wait for an administrator.
                </Alert>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
