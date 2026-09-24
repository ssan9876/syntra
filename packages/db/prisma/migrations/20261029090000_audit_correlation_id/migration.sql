-- Correlation id on audit events (backlog #55, end-to-end tracing).
--
-- The id of the HTTP request or background job an event was recorded in: the
-- OpenTelemetry trace id when tracing is enabled, otherwise a random id in the
-- same 32-hex format. It is carried through pg-boss job payloads, so an HR
-- import, the provisioning run it enqueued and the connector calls that run
-- made record the same id, and it is stamped on every log line.
--
-- Nullable: every event written before this migration has none, and an event
-- recorded outside a request or job (a boot-time task) has none either.
--
-- NOT part of the hash chain. It is a join key into operational telemetry, not
-- evidence, and leaving it out means every existing chain verifies unchanged
-- and an external verifier needs no knowledge of it. It is still immutable
-- after insert: the existing `audit_no_update` rule already turns every UPDATE
-- on this table into nothing.
--
-- The CHECK keeps it a correlation id and nothing else -- the value comes from
-- a request header when a caller sends `traceparent`, and a constraint is the
-- guarantee that no free text can ever be smuggled into the audit table here.
--
-- A metadata-only change: ADD COLUMN with no default rewrites nothing, and the
-- CHECK is added NOT VALID (no existing row can violate it -- they are all
-- NULL -- so validating would only scan the largest table in the database for
-- nothing) and then validated, which takes a lock that does not block writes.
-- No index: lookups by correlation id are an investigation, run rarely and
-- always within a tenant and a time window, which the existing
-- (tenantId, occurredAt) index already narrows.

ALTER TABLE "AuditEvent" ADD COLUMN "correlationId" TEXT;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_correlationId_format"
  CHECK ("correlationId" IS NULL OR "correlationId" ~ '^[0-9a-f]{32}$') NOT VALID;

ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_correlationId_format";
