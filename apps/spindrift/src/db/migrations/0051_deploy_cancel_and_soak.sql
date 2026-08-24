-- Two things a Deploy row could not say: that somebody asked it to stop, and
-- what the platform thought of it a little while after it went LIVE.
--
-- The cancel is a *request* on the row rather than a phase flip, because the
-- attempt streaming into a Deploy lives in one reconciler process and only that
-- process can end the generator. The command stamps who asked; the attempt's
-- heartbeat reads it and settles FAILED with that sentence. A PENDING intent
-- has nothing streaming into it, so the command fails that one itself.
--
-- The soak is one `observe` at least DEPLOY_SOAK_MS after the LIVE verdict
-- (§6 forbids core re-implementing readiness, not judging what follows it).
-- `soaked_at` is what makes it happen once; `faulty_at` is the verdict when the
-- platform reports the release failed inside that window, with reason, blame,
-- detail and debug filled the way a red attempt fills them.
--
-- Releases that were LIVE before the soak existed are backfilled as soaked:
-- their window closed long ago, and judging them now would turn a release the
-- operator has lived with for weeks red on the next reconciler start.
ALTER TABLE "deploys" ADD COLUMN "cancel_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "cancel_requested_by" text;
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "soaked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "faulty_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "deploys" SET "soaked_at" = "updated_at" WHERE "phase" = 'LIVE';
