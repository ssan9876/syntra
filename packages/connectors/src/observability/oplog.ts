import { currentCorrelationId } from './tracing.js';

/**
 * Operational log lines from code with no request logger: background jobs,
 * provisioning and sync runs. The server points this at its pino logger at
 * startup, so these lines land in the same journal, with the same redaction,
 * as request logs. Unset (tests, scripts), nothing is written.
 *
 * Every line names what it is about in `fields` -- tenant, target, run, job --
 * so a failure can be found with a grep for its id.
 */
export type OpLogLevel = 'info' | 'warn' | 'error';
export type OpLogSink = (level: OpLogLevel, fields: Record<string, unknown>, message: string) => void;

let sink: OpLogSink | null = null;

export function setOperationalLog(next: OpLogSink | null): void {
  sink = next;
}

export function oplog(level: OpLogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (sink === null) return;
  const correlationId = currentCorrelationId();
  try {
    sink(level, correlationId === null ? fields : { correlationId, ...fields }, message);
  } catch {
    // A log line must never be the reason work fails.
  }
}
