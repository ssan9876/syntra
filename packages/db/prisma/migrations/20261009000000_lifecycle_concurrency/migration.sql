-- A per-tenant cap on how many target operations may be in flight at once.
-- The worker defers the rest with a visible "at capacity" receipt state and a
-- delayed requeue, rather than letting them queue silently behind each other.
ALTER TABLE "LifecyclePolicy"
  ADD COLUMN "maxConcurrentTargetOperations" INTEGER NOT NULL DEFAULT 8;
