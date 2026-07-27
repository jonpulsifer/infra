CREATE TYPE "public"."target_health" AS ENUM('healthy', 'unhealthy');--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "orphaned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "connection" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "health" "target_health" NOT NULL;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "prerequisites" jsonb;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "discovery" jsonb;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "inspected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_name_unique" UNIQUE("name");