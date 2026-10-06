/**
 * Audit events as a SIEM wants them.
 *
 * One JSON shape for every transport, so a search written against the HTTPS
 * stream works on the syslog one. The hash chain travels with each event
 * (`hash`, `prevHash`, `sequence`): a SIEM that keeps them can show the log
 * it received is the log Syntra wrote, with nothing missing in between.
 */
export interface StreamableEvent {
  id: string;
  sequence: number;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  sourceIp: string | null;
  correlationId: string | null;
  payload: unknown;
  hash: string;
  prevHash: string;
}

export interface StreamContext {
  /** The tenant's slug: which organisation the event belongs to. */
  tenant: string;
  /** This installation's host name, from PUBLIC_URL. */
  host: string;
  version: string;
}

export function eventJson(event: StreamableEvent, ctx: StreamContext) {
  return {
    id: event.id,
    tenant: ctx.tenant,
    sequence: event.sequence,
    occurredAt: event.occurredAt.toISOString(),
    action: event.action,
    outcome: event.outcome,
    actorUserId: event.actorUserId,
    targetType: event.targetType,
    targetId: event.targetId,
    sourceIp: event.sourceIp,
    correlationId: event.correlationId,
    payload: event.payload,
    hash: event.hash,
    prevHash: event.prevHash,
  };
}

/** A batch for a generic HTTPS receiver: one JSON array. */
export function httpsJsonBody(events: StreamableEvent[], ctx: StreamContext): string {
  return JSON.stringify(events.map((event) => eventJson(event, ctx)));
}

/**
 * A batch for Splunk's HTTP Event Collector (`/services/collector/event`):
 * one JSON object per event, concatenated, which is the batch form HEC reads.
 */
export function splunkHecBody(events: StreamableEvent[], ctx: StreamContext): string {
  return events
    .map((event) =>
      JSON.stringify({
        time: event.occurredAt.getTime() / 1000,
        host: ctx.host,
        source: 'syntra',
        sourcetype: 'syntra:audit',
        event: eventJson(event, ctx),
      }),
    )
    .join('\n');
}

/** RFC 5424 facility 13, "log audit". */
const FACILITY = 13;
/** Failures as warning (4), everything else as notice (5). */
const severityOf = (outcome: string) => (outcome === 'success' ? 5 : 4);

/** An SD-PARAM value, escaped as RFC 5424 section 6.3.3 says. */
const sdValue = (value: string) => value.replace(/[\\"\]]/g, (c) => `\\${c}`);

/**
 * One RFC 5424 message: the event's JSON as MSG, or a CEF line (QRadar,
 * ArcSight, and Sentinel's CEF connector read it from syslog).
 *
 * The APP-NAME is `syntra`, MSGID the action, and structured data carries the
 * tenant and sequence so a receiver can route without parsing the message.
 */
export function syslogMessage(event: StreamableEvent, ctx: StreamContext, format: 'json' | 'cef'): string {
  const pri = FACILITY * 8 + severityOf(event.outcome);
  const msgid = event.action.replace(/[^\x21-\x7e]/g, '_').slice(0, 32) || '-';
  const sd = `[syntra@32473 tenant="${sdValue(ctx.tenant)}" sequence="${event.sequence}" outcome="${sdValue(event.outcome)}"]`;
  const msg = format === 'cef' ? cefLine(event, ctx) : JSON.stringify(eventJson(event, ctx));
  return `<${pri}>1 ${event.occurredAt.toISOString()} ${ctx.host || '-'} syntra - ${msgid} ${sd} ${msg}`;
}

/** RFC 6587 octet counting: a TCP stream of syslog messages needs a frame. */
export function octetFrame(message: string): string {
  return `${Buffer.byteLength(message, 'utf8')} ${message}`;
}

/** CEF header fields escape `\` and `|`. */
const cefHeader = (value: string) => value.replace(/[\\|]/g, (c) => `\\${c}`);
/** CEF extension values escape `\`, `=` and line breaks. */
const cefExt = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r?\n/g, '\\n');

/**
 * ArcSight Common Event Format. Severity 3 for a success, 7 for anything
 * else: a refused sign-in or a failed write is what a SOC filters for.
 */
export function cefLine(event: StreamableEvent, ctx: StreamContext): string {
  const severity = event.outcome === 'success' ? 3 : 7;
  const ext: [string, string | number | null][] = [
    ['rt', event.occurredAt.getTime()],
    ['externalId', event.id],
    ['act', event.action],
    ['outcome', event.outcome],
    ['suid', event.actorUserId],
    ['src', event.sourceIp],
    ['cs1Label', 'tenant'],
    ['cs1', ctx.tenant],
    ['cs2Label', 'target'],
    ['cs2', event.targetId ? `${event.targetType}:${event.targetId}` : event.targetType],
    ['cs3Label', 'correlationId'],
    ['cs3', event.correlationId],
    ['cs4Label', 'hash'],
    ['cs4', event.hash],
    ['cn1Label', 'sequence'],
    ['cn1', event.sequence],
  ];
  const extension = ext
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}=${cefExt(String(value))}`)
    .join(' ');
  return [
    'CEF:0',
    'Syntra',
    'Syntra',
    cefHeader(ctx.version),
    cefHeader(event.action),
    cefHeader(event.action),
    String(severity),
    extension,
  ].join('|');
}
