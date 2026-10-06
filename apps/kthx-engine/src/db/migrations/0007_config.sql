CREATE TYPE "public"."config_action" AS ENUM('set', 'removed');--> statement-breakpoint
CREATE TABLE "config_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"component_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"key" text NOT NULL,
	"action" "config_action" NOT NULL,
	"user_id" uuid,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_items" ADD COLUMN "store_version" text;--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "config_document" jsonb;--> statement-breakpoint
ALTER TABLE "config_audit_events" ADD CONSTRAINT "config_audit_events_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_audit_events" ADD CONSTRAINT "config_audit_events_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_audit_events" ADD CONSTRAINT "config_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;