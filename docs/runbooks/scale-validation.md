# Scale validation

Run this only against an isolated non-production PostgreSQL database. It is
the repeatable checklist for the 10k people / 10k operation rehearsal; it
must never use the database behind a running production Syntra deployment.

1. Restore a current schema into a disposable database.
2. Insert a dedicated fixture tenant, 10,000 synthetic people and 10,000
   lifecycle operations. Fixture data must carry an obvious `scale-` marker.
3. Run `ANALYZE` after bulk insertion; plans before statistics are collected
   are not useful evidence.
4. Capture `EXPLAIN (ANALYZE, BUFFERS)` for people paging and open-operation
   paging at page size 50. Record database version, hardware, row counts,
   cold/warm cache state and query text with the plan.
5. Restore the backup to a second disposable database and reconcile person,
   lifecycle-operation and migration counts before teardown.

## Required acceptance observations

- Person paging uses `Person_tenantId_familyName_givenName_idx`.
- Open-operation paging uses
  `LifecycleOperation_open_queue_updatedAt_id_idx` after migration
  `20261011000000_lifecycle_open_queue_index`.
- The restored copy has identical fixture counts and migration count.
- The production database has not been named in any write command.

## Limits

This rehearsal validates database paging and backup/restore mechanics. It does
not simulate external connector throughput, real network latency, an object
store restore, or production-sized audit history.
