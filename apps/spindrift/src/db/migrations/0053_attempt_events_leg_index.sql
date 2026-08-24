-- Every read of an attempt's log walks one leg — `build_id` or `deploy_id` —
-- in `id` order, and the line ceiling now seeds a COUNT over the same leg once
-- per attempt. With 20k rows per verbose build and §12's keep-every-row rule,
-- both were full scans of a table that only grows. One partial index per leg,
-- narrowed to the rows that carry it, is the whole cost of making them not.
CREATE INDEX "attempt_events_build_id_id_idx" ON "attempt_events" USING btree ("build_id","id") WHERE "build_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "attempt_events_deploy_id_id_idx" ON "attempt_events" USING btree ("deploy_id","id") WHERE "deploy_id" IS NOT NULL;
