-- Backlog #64: the operational support bundle is generated through the
-- asynchronous export service, so it inherits the service's controls
-- (permission re-checked at generation and download, watermark, sealed at
-- rest, requester-only download, bounded lifetime, audited at every step).
-- The only schema change is the kind vocabulary.
--
-- Additive: every existing row satisfies the new constraint, and an older
-- release reading a `support_bundle` row only lists it.

ALTER TABLE "DataExport" DROP CONSTRAINT "DataExport_kind_known";
ALTER TABLE "DataExport" ADD CONSTRAINT "DataExport_kind_known"
  CHECK ("kind" IN ('audit_log', 'govern_access', 'support_bundle'));
