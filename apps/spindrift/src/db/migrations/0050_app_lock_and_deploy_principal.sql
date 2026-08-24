-- A deploy lock on the App, and who asked for each Deploy (§6).
--
-- The lock is three nullable columns rather than a noun: §1's concept count is
-- untouched, and the only reader is `checkDeployable`, which refuses a locked
-- App with the reason in the sentence. `rollbackDeploy` bypasses it and sets
-- it — after a rollback the next adopted push would otherwise re-dispatch the
-- same thing through `dispatchAutoDeploys` with no step where the operator
-- says the cause is fixed. `locked_by` is the principal's id, exactly as
-- `deploys.requested_by` below is, and stays out of the check because the
-- reason and the instant are the invariant: the same shape as
-- `repositories_frozen_has_reason`.
--
-- `requested_by` is nullable and unbackfilled: every Deploy that exists today
-- was asked for by nobody this column can name, and a screen that says so is
-- more honest than one attributing history to the operator.
ALTER TABLE "apps" ADD COLUMN "lock_reason" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "locked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "locked_by" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_lock_has_reason" CHECK (("lock_reason" is null) = ("locked_at" is null));
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "requested_by" text;
