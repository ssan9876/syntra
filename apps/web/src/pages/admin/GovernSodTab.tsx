import { useState } from 'react';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface BusinessFunction {
  id: string;
  name: string;
  description: string | null;
  resources: { systemId: string; resourceKind: string; resourceId: string }[];
}

interface SodRule {
  id: string;
  name: string;
  severity: string;
  rationale: string;
  enabled: boolean;
  functionA: { id: string; name: string };
  functionB: { id: string; name: string };
}

interface Violation {
  id: string;
  personId: string;
  severity: string;
  status: string;
  firstSeenAt: string;
  holdingsA: { resourceName?: string }[];
  holdingsB: { resourceName?: string }[];
  rule: { id: string; name: string; rationale: string };
}

interface RulePreview {
  violatingPersons: number;
  sample: { personId: string; displayName: string }[];
  unevaluableSubjects: number;
}

type Tone = 'neutral' | 'active' | 'inactive' | 'warning' | 'danger' | 'primary';
const SEVERITY_TONE: Record<string, Tone> = {
  low: 'neutral',
  medium: 'primary',
  high: 'warning',
  critical: 'danger',
};

export function GovernSodTab() {
  const functions = useApiResource<{ functions: BusinessFunction[] }>(
    '/api/admin/govern/sod/functions',
  );
  const rules = useApiResource<{ rules: SodRule[] }>('/api/admin/govern/sod/rules');
  const violations = useApiResource<{ violations: Violation[] }>(
    '/api/admin/govern/sod/violations',
  );

  const [functionAId, setFunctionAId] = useState('');
  const [functionBId, setFunctionBId] = useState('');
  const [severity, setSeverity] = useState('critical');
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canPreview = functionAId !== '' && functionBId !== '' && functionAId !== functionBId;

  return (
    <>

      {actionError !== null && <Alert tone="danger">{actionError}</Alert>}

      <div className="mt-6 space-y-6">
        <Panel
          title="Business functions"
        >
          {functions.loading && <SkeletonRows rows={3} cols={2} />}
          {functions.error !== null && <Alert tone="danger">{functions.error}</Alert>}
          {functions.data !== null && functions.data.functions.length === 0 && (
            <Empty title="No business functions yet">
              A function is a name and a set of resources: &ldquo;raise a payment&rdquo; is the
              entitlement in the finance system, the group in Active Directory and the role in the
              SaaS tool that each let somebody do it.
            </Empty>
          )}
          {(functions.data?.functions ?? []).length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {(functions.data?.functions ?? []).map((fn) => (
                <li key={fn.id} className="p-4">
                  <p className="font-medium text-ink">{fn.name}</p>
                  <p className="text-muted">
                    {fn.resources.length} resource(s) across{' '}
                    {new Set(fn.resources.map((r) => r.systemId)).size} system(s)
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Rules"
        >
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-2">
              {/* "Business function", not "Side". The panel used to carry a
                  sentence — "a rule relates two business FUNCTIONS, never two
                  entitlements" — explaining a constraint these two controls
                  already enforce absolutely: both are populated from business
                  functions and an entitlement cannot be chosen here at all.
                  The sentence was describing the control instead of the
                  control describing itself. Naming the type in the label
                  makes it unmissable and deletes the paragraph. */}
              <label className="text-muted">
                Business function A
                <select
                  aria-label="Business function A"
                  className="ml-2 rounded border border-border-subtle px-2 py-1 text-ink"
                  value={functionAId}
                  onChange={(e) => {
                    setFunctionAId(e.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">choose</option>
                  {(functions.data?.functions ?? []).map((fn) => (
                    <option key={fn.id} value={fn.id}>
                      {fn.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-muted">
                Business function B
                <select
                  aria-label="Business function B"
                  className="ml-2 rounded border border-border-subtle px-2 py-1 text-ink"
                  value={functionBId}
                  onChange={(e) => {
                    setFunctionBId(e.target.value);
                    setPreview(null);
                  }}
                >
                  <option value="">choose</option>
                  {(functions.data?.functions ?? []).map((fn) => (
                    <option key={fn.id} value={fn.id}>
                      {fn.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-muted">
                Severity
                <select
                  aria-label="Severity"
                  className="ml-2 rounded border border-border-subtle px-2 py-1 text-ink"
                  value={severity}
                  onChange={(e) => {
                    setSeverity(e.target.value);
                    setPreview(null);
                  }}
                >
                  {['low', 'medium', 'high', 'critical'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              {/* BEFORE the save. A rule that would fire against 400 people is a
                  configuration error, and the person with the console open is
                  who should see it — at that moment, not the 400 people six
                  hours later. */}
              <Button
                variant="secondary"
                disabled={!canPreview}
                onClick={() => {
                  void api<RulePreview>('/api/admin/govern/sod/rules/preview', {
                    method: 'POST',
                    body: JSON.stringify({ functionAId, functionBId, severity }),
                  })
                    .then((result) => {
                      setActionError(null);
                      setPreview(result);
                    })
                    .catch((cause: unknown) =>
                      setActionError(
                        cause instanceof ApiError
                          ? (cause.problem.detail ?? cause.problem.title)
                          : 'Could not preview that rule.',
                      ),
                    );
                }}
              >
                Show me who this would flag, before I save it
              </Button>
            </div>

            {preview !== null && (
              <Alert tone={preview.violatingPersons > 0 ? 'warning' : 'info'}>
                This rule is violated by {preview.violatingPersons} person(s) today
                {preview.sample.length > 0 &&
                  `: ${preview.sample.map((s) => s.displayName).join(', ')}`}
                .
                {preview.unevaluableSubjects > 0 &&
                  ` ${preview.unevaluableSubjects} more could not be evaluated, because a resource one of these functions names could not be read.`}
              </Alert>
            )}
          </div>

          {rules.error !== null && <Alert tone="danger">{rules.error}</Alert>}
          {(rules.data?.rules ?? []).length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {(rules.data?.rules ?? []).map((rule) => (
                <li key={rule.id} className="p-4">
                  <p className="font-medium text-ink">
                    {rule.name}{' '}
                    <Status tone={SEVERITY_TONE[rule.severity] ?? 'neutral'}>
                      {rule.severity}
                    </Status>
                    {!rule.enabled && <Status tone="inactive">disabled</Status>}
                  </p>
                  <p className="text-muted">
                    {rule.functionA.name} against {rule.functionB.name}
                  </p>
                  {/* The reason, on the rule. A violation nobody can argue with
                      is a violation nobody acts on. */}
                  <p className="text-muted">{rule.rationale}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Violations"
        >
          {violations.loading && <SkeletonRows rows={3} cols={3} />}
          {violations.error !== null && <Alert tone="danger">{violations.error}</Alert>}
          {violations.data !== null && violations.data.violations.length === 0 && (
            <Empty title="No open violations">
              Nothing currently holds both sides of any rule you have written.
            </Empty>
          )}
          {(violations.data?.violations ?? []).length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {(violations.data?.violations ?? []).map((v) => (
                <li key={v.id} className="p-4">
                  <p className="font-medium text-ink">
                    {v.rule.name}{' '}
                    <Status tone={SEVERITY_TONE[v.severity] ?? 'neutral'}>{v.severity}</Status>
                    <Status tone={v.status === 'excepted' ? 'inactive' : 'danger'}>
                      {v.status}
                    </Status>
                  </p>
                  {/* BOTH SIDES, named. A violation that says "Anna violates
                      rule 3" and nothing else is a violation nobody can act on:
                      what has to change is one of these two lists. */}
                  <p className="text-muted">
                    Side A: {v.holdingsA.map((h) => h.resourceName ?? '?').join(', ') || 'none'}
                  </p>
                  <p className="text-muted">
                    Side B: {v.holdingsB.map((h) => h.resourceName ?? '?').join(', ') || 'none'}
                  </p>
                  <p className="text-muted">
                    First seen {new Date(v.firstSeenAt).toLocaleDateString()}. {v.rule.rationale}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
