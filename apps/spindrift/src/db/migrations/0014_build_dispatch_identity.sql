ALTER TABLE "builds" ADD COLUMN "dispatch_id" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "leased_at" timestamp with time zone;
