import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from "@syntra/ui";
import { PageHeader } from "./PageHeader.js";
import { useApiResource } from "./hooks.js";
import { ApiError, api } from "../../session/api.js";
import { when } from "../automate/status.js";

interface SweepRow {
  id: string;
  status: string;
  startedAt: string;
  expireCount: number;
  lapseCount: number;
  requiresConfirmation: boolean;
  blockedReason: string | null;
}

const TONE: Record<
  string,
  "neutral" | "active" | "warning" | "danger" | "primary"
> = {
  running: "neutral",
  previewed: "primary",
  blocked: "danger",
  applying: "primary",
  applied: "active",
  partially_applied: "warning",
  failed: "danger",
};

export function SweepsPage() {
  const { data, error, loading, reload } = useApiResource<{
    sweeps: SweepRow[];
  }>("/api/admin/automate/sweeps");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const runNow = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api("/api/admin/automate/sweeps", { method: "POST" });
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
    <>
      <PageHeader
        title="Expiry sweeps"
        description="What would be removed tonight, and why each sweep did or did not apply itself."
        actions={
          <Button loading={busy} onClick={runNow}>
            Run a preview now
          </Button>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      <Panel>
        {loading && <SkeletonRows rows={4} cols={4} />}
        {!loading && (data?.sweeps ?? []).length === 0 && (
          <div className="p-6">
            <Empty title="No sweeps yet">
              The nightly sweep records one row here every time it runs, whether
              or not it applied anything.
            </Empty>
          </div>
        )}
        {!loading && (data?.sweeps ?? []).length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {data!.sweeps.map((sweep) => (
              <li
                key={sweep.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <Link
                    to={`/admin/automate/sweeps/${sweep.id}`}
                    className="text-ink hover:text-primary"
                  >
                    {when(sweep.startedAt)}
                  </Link>
                  <p className="text-sm text-muted">
                    {sweep.expireCount} expiring, {sweep.lapseCount} lapsing
                  </p>
                  {sweep.blockedReason && (
                    <p className="text-sm text-danger">{sweep.blockedReason}</p>
                  )}
                </div>
                <Status tone={TONE[sweep.status] ?? "neutral"}>
                  {sweep.status}
                </Status>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
