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

## Audit search at 100,000 events

The audit log's rehearsal runs inside the test suite rather than by hand:
`packages/core/src/audit/audit-search.test.ts` inserts 100,000 events into one
tenant (50 actors, 2,000 targets, 20 actions plus 50 rare old ones, 5 %
failures, one event a minute), runs `ANALYZE`, and asserts for the exact
statement the service runs, at page size 51, that no plan contains a
sequential scan, that each filter uses its index, and that no page touches 500
or more blocks. `SYNTRA_PRINT_PLANS=1` prints the plans. Recorded on 23
September 2026 (PostgreSQL in Docker on a development workstation, warm cache,
after migration `20261030120000_data_exports_audit_search`):

| Page | Plan | Blocks | Time |
| --- | --- | --- | --- |
| Newest, no filter | Index scan `AuditEvent_tenantId_sequence_key` | 6 | 0.03 ms |
| Keyset page at sequence 50,000 | same | 9 | 0.05 ms |
| Common actor (2 %) | `AuditEvent_tenantId_actorUserId_sequence_idx` | 54 | 0.09 ms |
| Rare actor (10 events) | same | 13 | 0.03 ms |
| One target (50 events) | `AuditEvent_tenantId_targetId_sequence_idx` | 53 | 0.08 ms |
| Failures (5 %) | `AuditEvent_tenantId_outcome_sequence_idx` | 43 | 0.07 ms |
| Action prefix `auth.` (20 %) | sequence index, filtered | 16 | 0.05 ms |
| Action prefix `export.download` (5 %) | sequence index, filtered | 53 | 0.14 ms |
| Rare, oldest action (50 events) | `AuditEvent_tenantId_action_prefix_idx` + sort | 6 | 0.06 ms |
| One day in the middle of the log | two one-row lookups on `AuditEvent_tenantId_occurredAt_idx`, then the sequence range | 14 | 0.08 ms |
| Two subjects, either direction | bitmap OR of the actor and target indexes | 67 | 0.15 ms |

The time window is the one the rehearsal changed: filtered on `occurredAt`
alone, the planner walked the sequence index back from the head and read
1,986 blocks (19.6 ms) to reach a day in the middle of the log. The query now
resolves the window to its first and last sequence first.

## Limits

This rehearsal validates database paging and backup/restore mechanics. It does
not simulate external connector throughput, real network latency, an object
store restore, or production-sized audit history: the audit search figures
above are 100,000 events, not the millions a long-lived tenant accumulates,
and they time the search only — not the full chain verification each page
still carries (see [Operate, Audit search](../operate.md#audit-search)).
