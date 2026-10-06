CREATE TYPE "public"."repository_access" AS ENUM('active', 'frozen');--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"installation_id" text NOT NULL,
	"default_branch" text NOT NULL,
	"authoritative_commit" text,
	"config_pull_request" integer,
	"access" "repository_access" DEFAULT 'active' NOT NULL,
	"frozen_reason" text,
	"frozen_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_full_name_unique" UNIQUE("full_name"),
	CONSTRAINT "repositories_frozen_has_reason" CHECK (("repositories"."access" = 'frozen') = ("repositories"."frozen_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;