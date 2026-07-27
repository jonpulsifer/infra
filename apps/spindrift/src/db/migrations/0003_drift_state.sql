ALTER TABLE "deploys" ADD COLUMN "drifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "observed_digest" text;