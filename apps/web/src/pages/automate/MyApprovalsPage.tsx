import { useState } from "react";
import { Alert, Button, Empty, Field, Panel, SkeletonRows } from "@syntra/ui";
import { AppShell } from "../../components/AppShell.js";
import { ApiError, api } from "../../session/api.js";
import { useApiResource } from "../../session/use-api-resource.js";
import { when } from "./status.js";

interface Approval {
  id: string;
  requestId: string;
  sequence: number;
  openedAt: string | null;
  request: {
    id: string;
    subjectPersonId: string;
    justification: string | null;
    requestedDurationDays: number | null;
    product: { name: string } | null;
    items: { resourceType: string; resourceId: string }[];
  };
}

export function MyApprovalsPage() {
  const { data, error, loading, reload } = useApiResource<{
    approvals: Approval[];
  }>("/api/portal/automate/approvals");
  const [comments, setComments] = useState<Record<string, string>>({});
  const [shorten, setShorten] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (approval: Approval, decision: "approve" | "reject") => {
    const comment = comments[approval.id] ?? "";
    if (decision === "reject" && comment.trim() === "") {
      // The server refuses this too. Saying so here saves a round trip and a
      // second press of the button.
      setProblem(
        "Say why you are refusing it. The requester will read exactly this.",
      );
      return;
    }
    setBusy(approval.id);
    setProblem(null);
    try {
      await api(`/api/portal/automate/approvals/${approval.requestId}/decide`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          comment: comment.trim() === "" ? null : comment,
          shortenedToDays:
            (shorten[approval.id] ?? "").trim() === ""
              ? null
              : Number(shorten[approval.id]),
        }),
      });
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : "Something went wrong recording that decision.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <h1 className="text-lg font-semibold text-ink">Waiting for me</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        {problem && <Alert tone="warning">{problem}</Alert>}

        <div className="mt-6 space-y-6">
          {loading && (
            <Panel>
              <SkeletonRows rows={3} cols={3} />
            </Panel>
          )}
          {!loading && (data?.approvals ?? []).length === 0 && (
            <Empty title="Nothing is waiting for you">
              Requests routed to you appear here.
            </Empty>
          )}
          {!loading &&
            (data?.approvals ?? []).map((approval) => (
              <Panel
                key={approval.id}
                title={approval.request.product?.name ?? "Requested access"}
                description={`For ${approval.request.subjectPersonId}, waiting since ${when(approval.openedAt)}`}
              >
                <div className="space-y-3 p-4">
                  <p className="text-ink">{approval.request.justification}</p>
                  <p className="text-sm text-muted">
                    Grants:{" "}
                    {approval.request.items.map((i) => i.resourceId).join(", ")}
                  </p>
                  {approval.request.requestedDurationDays !== null && (
                    <Field
                      label={`Shorten to (days, asked for ${approval.request.requestedDurationDays})`}
                      type="number"
                      value={shorten[approval.id] ?? ""}
                      onChange={(value) =>
                        setShorten({ ...shorten, [approval.id]: value })
                      }
                      hint="You can shorten this. You cannot lengthen it."
                    />
                  )}
                  <Field
                    label="Comment"
                    value={comments[approval.id] ?? ""}
                    onChange={(value) =>
                      setComments({ ...comments, [approval.id]: value })
                    }
                    hint="Required if you refuse."
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      loading={busy === approval.id}
                      onClick={() => decide(approval, "approve")}
                    >
                      Approve
                    </Button>
                    <Button
                      loading={busy === approval.id}
                      onClick={() => decide(approval, "reject")}
                    >
                      Refuse
                    </Button>
                  </div>
                </div>
              </Panel>
            ))}
        </div>
      </div>
    </AppShell>
  );
}
