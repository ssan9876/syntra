import { withTenant } from '@syntra/db';

export interface ConnectorHealthBucket {
  date: string;
  readinessChecks: number;
  readinessFailures: number;
  authenticationFailures: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  provisionActions: number;
  failedActions: number;
  ambiguousActions: number;
  throttledActions: number;
  retries: number;
  readBackChecks: number;
  incompleteReadBacks: number;
}

const authenticationFailure = /\b(?:401|403|unauthori[sz]ed|forbidden|credential|client secret|token endpoint|authentication|invalid_client)\b/i;
const throttled = /\b(?:throttl|rate.?limit|too many requests|429)\b/i;

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null;
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Derive connector health from immutable operational evidence. This avoids a
 * second counter store that can say "healthy" while the run and observation
 * records say otherwise. Empty UTC days are returned too, so a gap cannot be
 * mistaken for a successful day.
 */
export async function targetConnectorHealth(
  tenantId: string,
  targetSystemId: string,
  options: { days?: number; now?: Date } = {},
) {
  const days = Math.min(90, Math.max(1, options.days ?? 30));
  const now = options.now ?? new Date();
  const through = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const since = new Date(through.getTime() - days * 86_400_000);
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId }, select: { id: true } });
    if (!target) return null;
    const [readiness, runs, observations] = await Promise.all([
      tx.connectionReadinessCheck.findMany({
        where: { systemKind: 'target', systemId: targetSystemId, checkedAt: { gte: since, lt: through } },
        select: { status: true, latencyMs: true, message: true, checkedAt: true },
        orderBy: { checkedAt: 'asc' },
      }),
      tx.provisionRun.findMany({
        where: { targetSystemId, startedAt: { gte: since, lt: through } },
        select: { actions: { select: { status: true, attempts: true, message: true, createdAt: true } } },
      }),
      tx.lifecycleObservation.findMany({
        where: { targetSystemId, observedAt: { gte: since, lt: through } },
        select: { completeness: true, observedAt: true },
        orderBy: { observedAt: 'asc' },
      }),
    ]);
    const latencies = new Map<string, number[]>();
    const buckets = new Map<string, ConnectorHealthBucket>();
    for (let offset = 0; offset < days; offset += 1) {
      const date = day(new Date(since.getTime() + offset * 86_400_000));
      buckets.set(date, {
        date, readinessChecks: 0, readinessFailures: 0, authenticationFailures: 0,
        averageLatencyMs: null, p95LatencyMs: null, provisionActions: 0, failedActions: 0, ambiguousActions: 0,
        throttledActions: 0, retries: 0, readBackChecks: 0, incompleteReadBacks: 0,
      });
    }
    for (const check of readiness) {
      const key = day(check.checkedAt); const bucket = buckets.get(key); if (!bucket) continue;
      bucket.readinessChecks += 1;
      if (check.status !== 'passed') bucket.readinessFailures += 1;
      if (check.status !== 'passed' && authenticationFailure.test(check.message ?? '')) bucket.authenticationFailures += 1;
      if (check.latencyMs !== null) latencies.set(key, [...(latencies.get(key) ?? []), check.latencyMs]);
    }
    for (const run of runs) for (const action of run.actions) {
      const bucket = buckets.get(day(action.createdAt)); if (!bucket) continue;
      bucket.provisionActions += 1;
      if (['failed', 'conflict'].includes(action.status)) bucket.failedActions += 1;
      if (action.status === 'in_flight') bucket.ambiguousActions += 1;
      if (throttled.test(action.message ?? '')) bucket.throttledActions += 1;
      bucket.retries += Math.max(0, action.attempts - 1);
    }
    for (const observation of observations) {
      const bucket = buckets.get(day(observation.observedAt)); if (!bucket) continue;
      bucket.readBackChecks += 1;
      if (observation.completeness !== 'complete') bucket.incompleteReadBacks += 1;
    }
    for (const [key, values] of latencies) {
      const bucket = buckets.get(key); if (!bucket) continue;
      bucket.averageLatencyMs = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
      bucket.p95LatencyMs = percentile95(values);
    }
    const series = [...buckets.values()];
    return {
      targetSystemId,
      since: since.toISOString(),
      through: through.toISOString(),
      days,
      totals: series.reduce((total, bucket) => ({
        readinessChecks: total.readinessChecks + bucket.readinessChecks,
        readinessFailures: total.readinessFailures + bucket.readinessFailures,
        authenticationFailures: total.authenticationFailures + bucket.authenticationFailures,
        provisionActions: total.provisionActions + bucket.provisionActions,
        failedActions: total.failedActions + bucket.failedActions,
        ambiguousActions: total.ambiguousActions + bucket.ambiguousActions,
        throttledActions: total.throttledActions + bucket.throttledActions,
        retries: total.retries + bucket.retries,
        readBackChecks: total.readBackChecks + bucket.readBackChecks,
        incompleteReadBacks: total.incompleteReadBacks + bucket.incompleteReadBacks,
      }), { readinessChecks: 0, readinessFailures: 0, authenticationFailures: 0, provisionActions: 0, failedActions: 0, ambiguousActions: 0, throttledActions: 0, retries: 0, readBackChecks: 0, incompleteReadBacks: 0 }),
      series,
    };
  });
}
