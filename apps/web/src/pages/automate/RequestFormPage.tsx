import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Field, Panel, SkeletonRows } from "@syntra/ui";
import { AppShell } from "../../components/AppShell.js";
import { ApiError, api } from "../../session/api.js";
import { useApiResource } from "../../session/use-api-resource.js";

interface FormField {
  key: string;
  type: string;
  label: string;
  help?: string;
  required: boolean;
  options?: { value: string; label: string }[];
}

interface ProductForm {
  name: string;
  requestInstructions: string | null;
  formSchema: FormField[];
  durationMode: string;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
  resources: {
    id: string;
    resourceType: string;
    resourceId: string;
    optional: boolean;
  }[];
}

export function RequestFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, error, loading } = useApiResource<ProductForm>(
    id === undefined ? null : `/api/portal/automate/catalog/${id}/form`,
  );

  const [values, setValues] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState("");
  const [days, setDays] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const created = await api<{ requestId: string }>(
        "/api/portal/automate/requests",
        {
          method: "POST",
          body: JSON.stringify({
            productId: id,
            subjectPersonId: undefined,
            justification: justification.trim() === "" ? null : justification,
            formValues: values,
            requestedDurationDays: days.trim() === "" ? null : Number(days),
          }),
        },
      );
      navigate(`/requests/${created.requestId}`);
    } catch (cause) {
      // The refusal reasons are the useful half: "already held", "no longer
      // eligible", "beyond the cap". Showing "something went wrong" instead
      // would send somebody to support with a question the answer to was
      // already on the wire.
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : "Something went wrong sending this request.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        {error && <Alert tone="danger">{error}</Alert>}
        {loading && (
          <Panel>
            <SkeletonRows rows={4} cols={2} />
          </Panel>
        )}
        {!loading && data && (
          <Panel
            title={data.name}
            // Spread, not `?? undefined`. Under `exactOptionalPropertyTypes`
            // an explicit `undefined` is not assignable to
            // `description?: string` -- Global Constraint 18, and the repo's
            // convention everywhere else.
            {...(data.requestInstructions === null
              ? {}
              : { description: data.requestInstructions })}
          >
            <div className="space-y-4 p-4">
              {problem && <Alert tone="warning">{problem}</Alert>}

              {data.formSchema.map((field) => (
                <div key={field.key}>
                  {field.type === "select" ||
                  field.type === "resourcePicker" ? (
                    <label className="block">
                      <span className="mb-1 block font-medium text-ink">
                        {field.label}
                      </span>
                      <select
                        className="w-full rounded-control border border-border-subtle bg-surface px-3 py-2"
                        value={values[field.key] ?? ""}
                        onChange={(event) =>
                          setValues({
                            ...values,
                            [field.key]: event.target.value,
                          })
                        }
                      >
                        <option value="">Choose one</option>
                        {(field.type === "resourcePicker"
                          ? data.resources.map((r) => ({
                              value: r.id,
                              label: r.resourceId,
                            }))
                          : (field.options ?? [])
                        ).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {field.help && (
                        <span className="mt-1 block text-muted">
                          {field.help}
                        </span>
                      )}
                    </label>
                  ) : (
                    <Field
                      label={field.label}
                      value={values[field.key] ?? ""}
                      onChange={(value) =>
                        setValues({ ...values, [field.key]: value })
                      }
                      {...(field.help === undefined
                        ? {}
                        : { hint: field.help })}
                    />
                  )}
                </div>
              ))}

              <Field
                label="Why do you need this?"
                value={justification}
                onChange={setJustification}
                hint="Whoever decides this will read exactly what you write here."
              />

              {data.durationMode === "requesterChoice" && (
                <Field
                  label="For how many days?"
                  value={days}
                  onChange={setDays}
                  type="number"
                  hint={`Up to ${data.maxDurationDays ?? 0} days.`}
                />
              )}

              <Button variant="primary" loading={busy} onClick={submit}>
                Send the request
              </Button>
            </div>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
