import { useState } from "react";
import { useParams } from "react-router-dom";
import { Alert, Button, Panel, SkeletonRows, Status } from "@syntra/ui";
import { AppShell } from "../../components/AppShell.js";
import { ApiError, api } from "../../session/api.js";
import { useApiResource } from "../../session/use-api-resource.js";
import { REQUEST_LABEL, REQUEST_TONE, when } from "./status.js";

interface Detail {
  id: string;
  status: string;
  statusReason: string | null;
  submittedAt: string;
  justification: string | null;
  product: { name: string } | null;
  items: {
    id: string;
    resourceType: string;
    resourceId: string;
    status: string;
    message: string | null;
  }[];
  steps: {
    id: string;
    sequence: number;
    status: string;
    openedAt: string | null;
    approvers: { personId: string; via: string }[];
    decisions: {
      personId: string;
      decision: string;
      comment: string | null;
      decidedAt: string;
    }[];
  }[];
  notifications: {
    template: string;
    to: string;
    sentAt: string | null;
    lastError: string | null;
  }[];
}

const CANCELLABLE = ["pending_approval", "blocked_no_approver"];

export function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApiResource<Detail>(
    id === undefined ? null : `/api/portal/automate/requests/${id}`,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/portal/automate/requests/${id}/cancel`, {
        method: "POST",
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading && (
          <Panel>
            <SkeletonRows rows={5} cols={2} />
          </Panel>
        )}
        {!loading && data && (
          <>
            <Panel
              title={data.product?.name ?? "Requested access"}
              actions={
                CANCELLABLE.includes(data.status) ? (
                  <Button loading={busy} onClick={cancel}>
                    Withdraw
                  </Button>
                ) : undefined
              }
            >
              <div className="space-y-2 p-4">
                {problem && <Alert tone="warning">{problem}</Alert>}
                <Status tone={REQUEST_TONE[data.status] ?? "neutral"}>
                  {REQUEST_LABEL[data.status] ?? data.status}
                </Status>
                {data.statusReason && (
                  <p className="text-muted">{data.statusReason}</p>
                )}
                {data.status === "awaiting_fulfilment" && (
                  <Alert tone="info">
                    This has been approved and is waiting to be applied to the
                    system it belongs to. Nothing more is needed from you.
                  </Alert>
                )}
                {data.justification && (
                  <p className="text-muted">You said: {data.justification}</p>
                )}
              </div>
            </Panel>

            <div className="mt-6">
              <Panel title="Approval">
                <ul className="divide-y divide-border-subtle">
                  {data.steps.map((step) => (
                    <li key={step.id} className="px-4 py-3">
                      <p className="font-medium text-ink">
                        Stage {step.sequence}
                      </p>
                      {/* Naming the approver is deliberate. Anonymous approval
                          makes chasing impossible and removes the social
                          accountability that makes an approver read it. */}
                      <p className="text-sm text-muted">
                        With:{" "}
                        {step.approvers.map((a) => a.personId).join(", ") ||
                          "nobody yet"}
                      </p>
                      {step.decisions.map((decision, index) => (
                        <p key={index} className="mt-1 text-sm text-muted">
                          {decision.decision === "approve"
                            ? "Approved"
                            : "Refused"}{" "}
                          by {decision.personId} on {when(decision.decidedAt)}
                          {decision.comment ? ` — ${decision.comment}` : ""}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>

            <div className="mt-6">
              <Panel title="Messages sent about this">
                <ul className="divide-y divide-border-subtle">
                  {data.notifications.map((notification, index) => (
                    <li key={index} className="px-4 py-2 text-sm text-muted">
                      {notification.template} to {notification.to} —{" "}
                      {notification.sentAt === null
                        ? (notification.lastError ?? "not sent yet")
                        : `sent ${when(notification.sentAt)}`}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
