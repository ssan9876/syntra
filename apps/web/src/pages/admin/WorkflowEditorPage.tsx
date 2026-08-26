import { useState } from 'react';
import { Alert, Button, Field, Panel, Select, SkeletonRows, Status } from '@syntra/ui';
import { PageHeader } from './PageHeader.js';
import { useApiResource } from './hooks.js';
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

interface WorkflowStage {
  id: string;
  sequence: number;
  name: string;
  selector: string;
  quorum: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  productCount: number;
  stages: WorkflowStage[];
}

const DROP_REASON: Record<string, string> = {
  subject: 'they are the subject',
  submitter: 'they raised the request',
  no_user: 'no Syntra account',
  inactive_user: 'inactive account',
  no_active_contract: 'no contract in force',
};

export function WorkflowEditorPage() {
  /**
   * THE LIST, which did not exist.
   *
   * There was no GET for workflows anywhere, so `Product.workflowId` -- which
   * is required and is a uuid -- could not be discovered from the console at
   * all. This screen asked for that id in a text box before it would preview
   * anything, and the product editor asked for it again.
   */
  const { data, error, loading, reload } = useApiResource<{ workflows: Workflow[] }>(
    '/api/admin/automate/workflows',
  );
  const workflows = data?.workflows ?? [];

  const [workflowId, setWorkflowId] = useState('');
  const [subjectPersonId, setSubjectPersonId] = useState('');
  const [stages, setStages] = useState<StagePreview[] | null>(null);
  const [newName, setNewName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const report = (cause: unknown, fallback: string) =>
    setProblem(
      cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback,
    );

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
      report(cause, 'That preview could not be run.');
    }
  };

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api('/api/admin/automate/workflows', {
        method: 'POST',
        // An EMPTY stage list, deliberately. `workflowBody` permits it and it
        // is the mechanism for granting immediately; stages are added after,
        // once the workflow exists to add them to.
        body: JSON.stringify({ name: newName, description: null, enabled: true, stages: [] }),
      });
      setNewName('');
      reload();
    } catch (cause) {
      report(cause, 'That workflow could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Approval workflows"
        description="A workflow with no stages grants immediately. That is the mechanism, not a flag."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}

      <Panel title="Workflows">
        {loading && <SkeletonRows rows={3} cols={3} />}
        {!loading && workflows.length === 0 && (
          <p className="p-4 text-muted">
            No workflows yet. A product cannot be created without one, so start below.
          </p>
        )}
        {workflows.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="p-4">
                <p>
                  <span className="font-medium text-ink">{workflow.name}</span>
                  <span className="ml-2">
                    <Status tone={workflow.enabled ? 'active' : 'neutral'}>
                      {workflow.enabled ? 'enabled' : 'disabled'}
                    </Status>
                  </span>
                  <span className="ml-2 text-muted">
                    {workflow.productCount} product{workflow.productCount === 1 ? '' : 's'}
                  </span>
                </p>
                {workflow.stages.length === 0 ? (
                  // Not an empty list on the screen: an empty stage list is
                  // what makes a product grant on submission, and a reader
                  // seeing nothing would think the workflow was unfinished.
                  <p className="mt-1 text-muted">
                    No stages, so anything using it grants immediately, with no approval at
                    all.
                  </p>
                ) : (
                  <ol className="mt-1 list-decimal pl-5 text-muted">
                    {workflow.stages.map((stage) => (
                      <li key={stage.id}>
                        {stage.name} — {stage.selector}, {stage.quorum} of them
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="mt-6">
        <Panel
          title="New workflow"
          description="Created with no stages, which means it grants immediately until stages are added."
        >
          <div className="space-y-3 p-4">
            <Field label="New workflow name" value={newName} onChange={setNewName} />
            <Button
              variant="primary"
              loading={busy}
              disabled={newName.trim() === ''}
              onClick={() => void create()}
            >
              Create it
            </Button>
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel
          title="Resolution preview"
          description="Pick a real person and see the chain this workflow produces for them."
        >
          <div className="space-y-3 p-4">
            <Select
              label="Workflow"
              value={workflowId}
              onChange={setWorkflowId}
              options={[
                { value: '', label: 'Choose one…' },
                ...workflows.map((workflow) => ({ value: workflow.id, label: workflow.name })),
              ]}
            />
            <Field
              label="Subject person id"
              value={subjectPersonId}
              onChange={setSubjectPersonId}
            />
            <Button onClick={() => void runPreview()} disabled={workflowId === ''}>
              Resolve it
            </Button>

            {stages !== null && stages.length === 0 && (
              <Alert tone="warning">
                This workflow has no stages, so anything using it is granted immediately, with
                no approval at all.
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
                  {stage.approvers.map((a) => a.displayName).join(', ') || 'nobody'}
                </p>
                {stage.dropped.length > 0 && (
                  <p className="text-muted">
                    {stage.dropped.length} dropped:{' '}
                    {stage.dropped
                      .map((d) => `${d.displayName} (${DROP_REASON[d.reason] ?? d.reason})`)
                      .join(', ')}
                  </p>
                )}
                {stage.blocked && (
                  // The screen that catches this before it is saved, rather than
                  // at 3am on somebody's request.
                  <Alert tone="danger">
                    Nobody can decide this stage for this person. Any request reaching it will
                    stop and wait for an administrator.
                  </Alert>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
