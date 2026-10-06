-- Story 101: dispatch retries mint a signed URL per attempt, forever.
--
-- A Build the loop cannot currently dispatch was retried at loop cadence —
-- 500-1500ms, around the clock — and each attempt spent an STS exchange and a
-- SignBlob before failing on a condition knowable for free. These two columns
-- are the per-row backoff clock: `dispatch_attempts` counts the consecutive
-- refusals, `next_dispatch_at` is the earliest the loop may try again, pushed
-- out exponentially (capped) by each refusal and cleared by a successful claim
-- or a fresh press.
--
-- Backfilled zero and null: every PENDING row becomes tryable immediately,
-- which is what it already was.
ALTER TABLE "builds" ADD COLUMN "dispatch_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "next_dispatch_at" timestamp with time zone;
